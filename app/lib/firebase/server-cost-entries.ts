/**
 * Server-side reads, and the one write, of cost entries: what a cleaner
 * spent, one receipt at a time, for one property.
 *
 * `cost_entries` is reached only through the Admin SDK. POST
 * /api/cleaner/entries writes it once the cleaner's session has been
 * verified; GET /api/admin/cost-entries reads it behind the admin session.
 * firestore.rules denies every browser read and write.
 *
 * ── Attribution ──
 * No ID or attribution field ever comes from the client. The entry's ID is
 * allocated here before the receipt is uploaded, so the receipt's path can
 * carry it. The cleaner is the one the verified session names; their name is
 * copied from their document inside the create transaction, which also
 * re-checks that they are still active on the same session epoch, so no
 * entry lands after a deactivation commits. The property is referenced by
 * ID. Its name at the time is kept beside the ID as a display fallback only,
 * because a property can be renamed or deleted.
 *
 * ── Money ──
 * Each line stores `lineTotalCents`, the amount printed on that receipt line,
 * as a signed integer: negative is money back, and 0 is allowed. Quantity is
 * informational and never multiplied. The amounts arrive as strings and
 * become cents by splitting the string, never through a float. No total is
 * stored. The one sum taken — that an entry's lines add up to more than
 * zero — is a validation rule; nothing computes, adjusts or corrects an
 * amount.
 *
 * ── Written once, then reviewed ──
 * An entry is written with `create()`, and its `lines` are never rewritten.
 * Review (dispatch 19) changes only `status`, `statusChangedAt` and
 * `statusReason`, and appends to `history`: an admin approves, rejects with a
 * reason, or removes an entry, and corrects or adds a line as a history event
 * that carries the line before and after (readLinesNow in model.ts applies
 * them). Nothing is ever deleted, so every earlier state stays readable.
 * Each review is one transaction that first checks the entry is as the admin
 * last saw it — its history the same length — so two admins acting at once
 * cannot write over each other.
 *
 * ── Sent once ──
 * The cleaner's phone gives each receipt a one-time `submissionKey`. The
 * entry is written in the same transaction as a `cost_entry_submissions`
 * document keyed by the cleaner and that key, so a receipt sent again —
 * because a dropped connection hid the first answer — finds the first entry
 * instead of making a second. findSubmission answers that before anything is
 * uploaded; the transaction checks again, for two sends in flight at once.
 *
 * Failure contract, as in server-leads.ts: a failed read THROWS. It never
 * returns an empty list or a missing property. The name lookups that enrich
 * the list are the exception, as findProperty is for leads: a failed lookup
 * shows as 'unreadable' and never fails the list. `properties` is only ever
 * read, by ID, with a field mask of `name`.
 */

import { z } from 'zod';
import type { DocumentReference } from 'firebase-admin/firestore';
import { getAdminDb } from './admin';
import { isDocumentId } from './server-leads';
import {
  ADMIN_ACTOR,
  CLEANERS_COLLECTION,
  COST_ENTRIES_COLLECTION,
  COST_ENTRY_SCHEMA_VERSION,
  COST_ENTRY_SUBMISSIONS_COLLECTION,
  COST_ENTRY_SUBMISSION_SCHEMA_VERSION,
  CURRENCY,
  LIMITS,
  RECEIPTS_PREFIX,
  SUBMISSION_KEY_PATTERN,
  fieldText,
  newestFirst,
  readCostEntryFields,
  readLinesNow,
  type CleanerEntry,
  type CostEntryFields,
  type CostEntryView,
  type HistoryEvent,
  type Line,
  type LookupState,
  type ReceiptRef,
  type Refusal,
  type ReviewStatus,
} from '@/app/lib/cleaners/model';

/**
 * The cleaner was deactivated, or changed status, after their session was
 * checked and before the entry could be written. Nothing was written.
 */
export class SessionRevokedError extends Error {
  constructor() {
    super('The cleaner session no longer holds; the entry was not written');
    this.name = 'SessionRevokedError';
  }
}

/** An earlier send of the same receipt already wrote its entry. Nothing more was written. */
export class DuplicateSubmissionError extends Error {
  constructor(readonly first: SubmissionFound) {
    super('This receipt was already submitted; no second entry was written');
    this.name = 'DuplicateSubmissionError';
  }
}

/** The one thing logged about a Firestore error. */
function grpcCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? String(code) : 'unknown';
}

// ─── The `entry` part ──────────────────────────────────────────
// The JSON string sent beside the receipt. Strict throughout: a key the
// schema does not name — `cleanerId`, `status`, `receipts` — is refused,
// not dropped.

const CONTROL_CHARACTER = /\p{Cc}/u;

/** 1 to 99999, up to three decimals: "2", "0.5", "1.125". */
const QUANTITY = /^(0|[1-9][0-9]{0,4})(\.[0-9]{1,3})?$/;

/** Dollars and exactly two decimals, either sign: "7.98", "-1.00", "0.00". Up to 999999.99. */
const LINE_TOTAL = /^-?(0|[1-9][0-9]{0,5})\.[0-9]{2}$/;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const DAY_MS = 86_400_000;

/**
 * A line total as integer cents, taken from the string's digits and never
 * through a float: "7.98" → 798, "-1.00" → -100. At most eight digits, so
 * the result is exact. "-0.00" is 0, not -0.
 */
function toCents(text: string): number {
  const negative = text.startsWith('-');
  const [whole, fraction] = (negative ? text.slice(1) : text).split('.');
  const cents = Number(whole + fraction);
  return negative && cents !== 0 ? -cents : cents;
}

/** Why a purchase date is refused, or null. It must be a real day from 2020-01-01 to tomorrow (UTC). */
function purchasedOnProblem(value: string): string | null {
  const match = ISO_DATE.exec(value);
  if (!match) return 'Write the date as yyyy-mm-dd';

  // A real calendar date survives a round trip through UTC: 2026-02-30 does not.
  const [, year, month, day] = match;
  const time = Date.UTC(Number(year), Number(month) - 1, Number(day));
  if (new Date(time).toISOString().slice(0, 10) !== value) return 'Not a real calendar date';

  if (value < LIMITS.PURCHASED_ON_MIN) return `The date must be ${LIMITS.PURCHASED_ON_MIN} or later`;
  const latest = new Date(Date.now() + DAY_MS).toISOString().slice(0, 10);
  if (value > latest) return 'The date cannot be in the future';
  return null;
}

/**
 * One line as typed: the cleaner's, and an admin's correction or added line.
 * The amount is the line's total as printed on the receipt; the quantity is
 * informational. Stored as a `Line`.
 */
export const LineInputSchema = z
  .strictObject({
    name: z
      .string()
      .transform((s) => s.normalize('NFC').trim())
      .pipe(
        z
          .string()
          .min(1, 'Name the item')
          .max(LIMITS.LINE_NAME_MAX, `At most ${LIMITS.LINE_NAME_MAX} characters`)
          .refine((s) => !CONTROL_CHARACTER.test(s), 'No control characters'),
      ),
    quantity: z
      .string()
      .regex(QUANTITY, 'A quantity like 2 or 1.5, with at most three decimals')
      .transform((s) => Number(s))
      .pipe(z.number().positive('The quantity must be more than 0')),
    lineTotal: z
      .string()
      .regex(LINE_TOTAL, 'An amount with two decimals, like 7.98 or -1.00')
      .transform(toCents),
  })
  .transform((line): Line => ({
    name: line.name,
    quantity: line.quantity,
    lineTotalCents: line.lineTotal,
  }));

/** The `entry` part, validated, in the form it is stored: amounts in cents, absences as null. */
export const EntryInputSchema = z.strictObject({
  /** The one-time key the phone gave this receipt. Sending it again never makes a second entry. */
  submissionKey: z.string().regex(SUBMISSION_KEY_PATTERN, 'Not a submission key'),
  propertyId: z.string().refine((id) => isDocumentId(id), 'Not a property ID'),
  purchasedOn: z
    .string()
    .superRefine((value, ctx) => {
      const problem = purchasedOnProblem(value);
      if (problem) ctx.addIssue({ code: 'custom', message: problem });
    })
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  note: z
    .string()
    .transform((s) => s.trim())
    .pipe(
      z
        .string()
        .max(LIMITS.NOTE_MAX, `At most ${LIMITS.NOTE_MAX} characters`)
        .refine(
          (s) => !CONTROL_CHARACTER.test(s.replace(/\n/g, '')),
          'No control characters other than line breaks',
        ),
    )
    .nullable()
    .optional()
    // An empty note is no note.
    .transform((value) => (value ? value : null)),
  lines: z
    .array(LineInputSchema)
    .min(1, 'At least one line')
    .max(LIMITS.LINES_MAX, `At most ${LIMITS.LINES_MAX} lines`),
});

export type CostEntryInput = z.output<typeof EntryInputSchema>;

export type EntryParseResult =
  | { kind: 'ok'; entry: CostEntryInput }
  /** Longer than 32,768 characters, or not JSON. */
  | { kind: 'bad-request' }
  /** JSON, but not a valid entry. The issues are safe to return. */
  | { kind: 'invalid'; issues: { path: string; message: string }[] }
  /** Valid lines that do not add up to more than zero. */
  | { kind: 'total-not-positive' };

/**
 * Read the `entry` part of an entry submission: length, then JSON, then the
 * schema, then the rule that the lines add up to more than zero. Never
 * throws, and never logs the text.
 */
export function parseEntryPart(text: string): EntryParseResult {
  if (text.length > LIMITS.ENTRY_JSON_MAX_CHARS) return { kind: 'bad-request' };

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: 'bad-request' };
  }

  const result = EntryInputSchema.safeParse(json);
  if (!result.success) {
    return {
      kind: 'invalid',
      issues: result.error.issues.map((i) => ({
        path: i.path.map(String).join('.'),
        message: i.message,
      })),
    };
  }

  // Safe integers: at most 100 lines of at most 99,999,999 cents each.
  const sum = result.data.lines.reduce((total, line) => total + line.lineTotalCents, 0);
  if (sum <= 0) return { kind: 'total-not-positive' };

  return { kind: 'ok', entry: result.data };
}

// ─── Property ──────────────────────────────────────────────────

export type PropertyLookup = { kind: 'found'; name: string | null } | { kind: 'missing' };

/**
 * Whether a property exists now, and its name. Any property is accepted,
 * delisted ones included. Only `name` is read.
 *
 * @throws if the read fails — which says nothing about whether it exists.
 */
export async function lookupPropertyName(propertyId: string): Promise<PropertyLookup> {
  if (!isDocumentId(propertyId)) return { kind: 'missing' };

  const db = getAdminDb();
  const [doc] = await db.getAll(db.collection('properties').doc(propertyId), { fieldMask: ['name'] });
  if (!doc.exists) return { kind: 'missing' };

  const name: unknown = doc.get('name');
  return { kind: 'found', name: typeof name === 'string' ? name : null };
}

// ─── Sent once ─────────────────────────────────────────────────

/** The entry an earlier send of the same receipt wrote. */
export interface SubmissionFound {
  entryId: string;
  createdAt: string | null;
}

/** The submission document for one cleaner's one-time key: `<cleanerId>_<submissionKey>`. */
function submissionRef(cleanerId: string, submissionKey: string): DocumentReference {
  return getAdminDb()
    .collection(COST_ENTRY_SUBMISSIONS_COLLECTION)
    .doc(`${cleanerId}_${submissionKey}`);
}

/** What a submission document says, or null if it names no entry. */
function readSubmission(fields: Record<string, unknown> | undefined): SubmissionFound | null {
  const entryId = fields?.entryId;
  if (typeof entryId !== 'string' || !isDocumentId(entryId)) return null;
  return { entryId, createdAt: fieldText(fields?.createdAt) };
}

/**
 * The entry this cleaner already sent under this one-time key, or null if
 * they have not. One read.
 *
 * @throws if the read fails — which says nothing either way.
 */
export async function findSubmission(
  cleanerId: string,
  submissionKey: string,
): Promise<SubmissionFound | null> {
  const [doc] = await getAdminDb().getAll(submissionRef(cleanerId, submissionKey));
  return doc.exists ? readSubmission(doc.data()) : null;
}

// ─── Create ────────────────────────────────────────────────────

/** A new entry's reference. Allocates an auto ID; writes nothing. */
export function newEntryRef(): DocumentReference {
  return getAdminDb().collection(COST_ENTRIES_COLLECTION).doc();
}

export interface NewCostEntry {
  /** From newEntryRef(): the ID the receipt's path already carries. */
  entryRef: DocumentReference;
  /** From the verified session, never from the body. */
  cleanerId: string;
  /** The session epoch the verified token carries. */
  sessionEpoch: number;
  /** From parseEntryPart. */
  entry: CostEntryInput;
  /** From lookupPropertyName. */
  propertyNameAtEntry: string | null;
  /** From saveReceipt. */
  receipt: ReceiptRef;
}

export interface CostEntryCreated {
  id: string;
  status: 'pending';
  createdAt: string;
  lineCount: number;
}

/**
 * Write one entry, in a transaction that first re-reads the cleaner: they
 * must exist, be active, and be on the session epoch the token carries.
 * Their name is copied from that same read. The same transaction checks the
 * receipt's one-time key and records it beside the entry, so of two sends of
 * one receipt, exactly one writes an entry.
 *
 * On any failure the receipt is already stored with no entry to name it,
 * and that orphan's path is logged here, once. Callers need not log it again.
 *
 * @throws SessionRevokedError if the cleaner's session no longer holds.
 * @throws DuplicateSubmissionError if this receipt was already sent; it
 * carries the first send's entry.
 * @throws anything else the transaction throws; the entry may or may not
 * have been written.
 */
export async function createCostEntry(input: NewCostEntry): Promise<CostEntryCreated> {
  const { entryRef, cleanerId, sessionEpoch, entry, propertyNameAtEntry, receipt } = input;
  let createdAt = '';

  try {
    const db = getAdminDb();
    const cleanerRef = db.collection(CLEANERS_COLLECTION).doc(cleanerId);
    const sentRef = submissionRef(cleanerId, entry.submissionKey);

    await db.runTransaction(async (tx) => {
      const [cleaner, sent] = await tx.getAll(cleanerRef, sentRef);
      if (
        !cleaner.exists ||
        cleaner.get('status') !== 'active' ||
        cleaner.get('sessionEpoch') !== sessionEpoch
      ) {
        throw new SessionRevokedError();
      }
      if (sent.exists) {
        const first = readSubmission(sent.data());
        // A submission document that names no entry is not in the written
        // shape; nothing is written over it.
        if (!first) throw new Error('The submission record for this receipt is unreadable');
        throw new DuplicateSubmissionError(first);
      }

      const storedName: unknown = cleaner.get('name');
      const cleanerNameAtEntry = typeof storedName === 'string' ? storedName : null;
      const now = new Date().toISOString();
      const submitted: HistoryEvent = {
        at: now,
        action: 'submitted',
        from: null,
        to: 'pending',
        actor: { role: 'cleaner', id: cleanerId, name: cleanerNameAtEntry },
        reason: null,
      };

      tx.create(entryRef, {
        schemaVersion: COST_ENTRY_SCHEMA_VERSION,
        cleanerId,
        cleanerNameAtEntry,
        propertyId: entry.propertyId,
        propertyNameAtEntry,
        createdAt: now,
        purchasedOn: entry.purchasedOn,
        note: entry.note,
        currency: CURRENCY,
        lines: entry.lines.map(({ name, quantity, lineTotalCents }) => ({ name, quantity, lineTotalCents })),
        receipts: [
          {
            path: receipt.path,
            contentType: receipt.contentType,
            bytes: receipt.bytes,
            sha256: receipt.sha256,
            uploadedAt: receipt.uploadedAt,
          },
        ],
        status: 'pending',
        statusChangedAt: now,
        statusReason: null,
        history: [submitted],
      });
      tx.create(sentRef, {
        schemaVersion: COST_ENTRY_SUBMISSION_SCHEMA_VERSION,
        cleanerId,
        submissionKey: entry.submissionKey,
        entryId: entryRef.id,
        createdAt: now,
      });
      createdAt = now;
    });
  } catch (err) {
    const reason =
      err instanceof SessionRevokedError
        ? 'session revoked'
        : err instanceof DuplicateSubmissionError
          ? `already sent as entry ${err.first.entryId}`
          : `grpc code ${grpcCode(err)}`;
    console.error(`[cost-entries] orphaned receipt ${receipt.path} (entry ${entryRef.id} not written: ${reason})`);
    throw err;
  }

  return { id: entryRef.id, status: 'pending', createdAt, lineCount: entry.lines.length };
}

// ─── List ──────────────────────────────────────────────────────

interface CleanerNow {
  name: string | null;
  status: string | null;
}

interface PropertyNow {
  name: string | null;
}

/** The IDs worth looking up: real document IDs, each once. */
function distinctIds(ids: (string | null)[]): string[] {
  return [...new Set(ids.filter((id): id is string => id !== null && isDocumentId(id)))];
}

/** The cleaners that exist, by ID; null when the lookup failed. */
async function lookUpCleaners(ids: string[]): Promise<Map<string, CleanerNow> | null> {
  if (ids.length === 0) return new Map();
  try {
    const db = getAdminDb();
    const docs = await db.getAll(...ids.map((id) => db.collection(CLEANERS_COLLECTION).doc(id)), {
      fieldMask: ['name', 'status'],
    });
    return new Map(
      docs
        .filter((doc) => doc.exists)
        .map((doc): [string, CleanerNow] => [
          doc.id,
          { name: fieldText(doc.get('name')), status: fieldText(doc.get('status')) },
        ]),
    );
  } catch (err) {
    console.error(`[cost-entries] could not look up cleaners: grpc code ${grpcCode(err)}`);
    return null;
  }
}

/** The properties that exist, by ID; null when the lookup failed. */
async function lookUpProperties(ids: string[]): Promise<Map<string, PropertyNow> | null> {
  if (ids.length === 0) return new Map();
  try {
    const db = getAdminDb();
    const docs = await db.getAll(...ids.map((id) => db.collection('properties').doc(id)), {
      fieldMask: ['name'],
    });
    return new Map(
      docs
        .filter((doc) => doc.exists)
        .map((doc): [string, PropertyNow] => [doc.id, { name: fieldText(doc.get('name')) }]),
    );
  } catch (err) {
    console.error(`[cost-entries] could not look up properties: grpc code ${grpcCode(err)}`);
    return null;
  }
}

/** Where one entry's reference landed in a lookup. */
function lookedUp<T>(id: string | null, found: Map<string, T> | null): { state: LookupState; now: T | null } {
  if (id === null || !isDocumentId(id)) return { state: 'missing', now: null };
  if (!found) return { state: 'unreadable', now: null };
  const now = found.get(id);
  return now ? { state: 'found', now } : { state: 'missing', now: null };
}

function toView(
  entry: CostEntryFields,
  cleaners: Map<string, CleanerNow> | null,
  properties: Map<string, PropertyNow> | null,
): CostEntryView {
  const cleaner = lookedUp(entry.cleanerId, cleaners);
  const property = lookedUp(entry.propertyId, properties);
  return {
    id: entry.id,
    createdAt: entry.createdAt,
    status: entry.status,
    statusChangedAt: entry.statusChangedAt,
    statusReason: entry.statusReason,
    history: entry.history,
    cleaner: {
      id: entry.cleanerId,
      nameAtEntry: entry.cleanerNameAtEntry,
      state: cleaner.state,
      name: cleaner.now?.name ?? null,
      status: cleaner.now?.status ?? null,
    },
    property: {
      id: entry.propertyId,
      nameAtEntry: entry.propertyNameAtEntry,
      state: property.state,
      name: property.now?.name ?? null,
    },
    purchasedOn: entry.purchasedOn,
    note: entry.note,
    currency: entry.currency,
    lines: entry.lines,
    linesNow: readLinesNow(entry.lines, entry.history),
    receipts: entry.receipts,
  };
}

/**
 * Every cost entry, newest first, with the current name and status of its
 * cleaner and the current name of its property.
 *
 * Deliberately no `orderBy` and no `limit`: Firestore leaves out every
 * document that lacks the ordered field, and a limit hides the rest, so an
 * entry could silently vanish. The collection is read whole and sorted here.
 * No pagination: the costs page filters and adds up in the browser, which
 * needs every entry, and at a few entries a week the whole collection is a
 * small read. Worth revisiting near 1,000 entries.
 *
 * Reads: one per entry, plus one per distinct cleaner and one per distinct
 * property, in two batched lookups.
 *
 * @throws if the entries cannot be read. A failed lookup does not throw.
 */
export async function listCostEntries(): Promise<CostEntryView[]> {
  const snapshot = await getAdminDb().collection(COST_ENTRIES_COLLECTION).get();
  const entries = snapshot.docs.map((doc) => readCostEntryFields(doc.id, doc.data()));

  const [cleaners, properties] = await Promise.all([
    lookUpCleaners(distinctIds(entries.map((entry) => entry.cleanerId))),
    lookUpProperties(distinctIds(entries.map((entry) => entry.propertyId))),
  ]);

  return entries.map((entry) => toView(entry, cleaners, properties)).sort(newestFirst);
}

/** One entry with the current names of its cleaner and property: two small lookups. */
async function viewOne(id: string, stored: Record<string, unknown>): Promise<CostEntryView> {
  const entry = readCostEntryFields(id, stored);
  const [cleaners, properties] = await Promise.all([
    lookUpCleaners(distinctIds([entry.cleanerId])),
    lookUpProperties(distinctIds([entry.propertyId])),
  ]);
  return toView(entry, cleaners, properties);
}

// ─── Review ────────────────────────────────────────────────────

export type ReviewResult =
  /** `changed` is false when the entry already said this: nothing was written. */
  | { kind: 'done'; entry: CostEntryView; changed: boolean }
  /** No entry has this ID. */
  | { kind: 'not-found' }
  /** The entry's history is not the length the admin saw: someone changed it since. Nothing was written. */
  | { kind: 'changed-since' }
  /** The stored entry is not in a shape this change can be made to. Nothing was written. */
  | { kind: 'unreadable' }
  /** A correction names a line the entry does not have. Nothing was written. */
  | { kind: 'no-such-line' }
  /** Adding a line would take the entry past LIMITS.LINES_MAX_AFTER_REVIEW. Nothing was written. */
  | { kind: 'too-many-lines' }
  /** The transaction failed: it may or may not have landed. */
  | { kind: 'failed' };

/** What the review routes answer for every outcome but `done`. */
export const REVIEW_REFUSALS: Record<Exclude<ReviewResult['kind'], 'done'>, Refusal> = {
  'not-found': {
    status: 404,
    code: 'ENTRY_NOT_FOUND',
    message: 'Entry not found',
  },
  'changed-since': {
    status: 409,
    code: 'ENTRY_CHANGED',
    message: 'This entry changed since it was loaded.',
    hint: 'Nothing was saved. Reload it, check what changed, and try again.',
  },
  unreadable: {
    status: 500,
    code: 'ENTRY_RECORD_UNREADABLE',
    message: 'This entry’s stored record is not in the shape this change needs.',
    hint: 'Nothing was changed.',
  },
  'no-such-line': {
    status: 422,
    code: 'ENTRY_LINE_NOT_FOUND',
    message: 'This entry has no such line.',
    hint: 'Nothing was changed. Reload the entry.',
  },
  'too-many-lines': {
    status: 422,
    code: 'ENTRY_TOO_MANY_LINES',
    message: `An entry can have at most ${LIMITS.LINES_MAX_AFTER_REVIEW} lines.`,
    hint: 'Nothing was changed.',
  },
  // The transaction failed. A failure can come after the commit landed, so
  // this does not claim that nothing was saved.
  failed: {
    status: 502,
    code: 'ENTRY_REVIEW_FAILED',
    message: 'Could not save the change.',
    hint: 'It may or may not have been saved. Reload the entry to see what is stored.',
  },
};

type Decision =
  | { kind: 'write'; event: HistoryEvent; changes?: Record<string, unknown> }
  | { kind: 'nothing' }
  | { kind: 'refuse'; result: ReviewResult };

/**
 * One review, in one transaction: read the entry; refuse unless its history
 * is the length `seen` says the admin last saw; decide; then append the one
 * event to the history, with any status fields, in a single update.
 *
 * `seen` makes two admins acting at once safe: the second finds a longer
 * history than the one they saw and is refused rather than writing over the
 * first. The history is read and written back whole, never with arrayUnion,
 * which would drop an event identical to one already there.
 */
async function review(
  id: string,
  seen: number,
  decide: (entry: CostEntryFields, now: string) => Decision,
): Promise<ReviewResult> {
  if (!isDocumentId(id)) return { kind: 'not-found' };

  let outcome: ReviewResult | { stored: Record<string, unknown>; changed: boolean };
  try {
    const db = getAdminDb();
    const ref = db.collection(COST_ENTRIES_COLLECTION).doc(id);

    outcome = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { kind: 'not-found' } as const;

      const stored = snap.data() ?? {};
      const history: unknown = stored.history;
      if (!Array.isArray(history)) return { kind: 'unreadable' } as const;
      if (history.length !== seen) return { kind: 'changed-since' } as const;

      const decision = decide(readCostEntryFields(id, stored), new Date().toISOString());
      if (decision.kind === 'refuse') return decision.result;
      if (decision.kind === 'nothing') return { stored, changed: false };

      const changes = { ...decision.changes, history: [...history, decision.event] };
      tx.update(ref, changes);
      return { stored: { ...stored, ...changes }, changed: true };
    });
  } catch (err) {
    console.error(`[cost-entries] review of ${id} failed: grpc code ${grpcCode(err)}`);
    return { kind: 'failed' };
  }

  if ('kind' in outcome) return outcome;
  return { kind: 'done', entry: await viewOne(id, outcome.stored), changed: outcome.changed };
}

/**
 * Approve, reject or remove an entry. A rejection carries its reason, which
 * the cleaner sees; the other two carry none. The status before goes into
 * the event, so every earlier status stays readable; removing leaves the
 * entry where it is, marked, and out of totals and reports.
 */
export function setEntryStatus(
  id: string,
  target: ReviewStatus,
  reason: string | null,
  seen: number,
): Promise<ReviewResult> {
  return review(id, seen, (entry, now) => {
    if (entry.status === target) return { kind: 'nothing' };
    const why = target === 'rejected' ? reason : null;
    return {
      kind: 'write',
      event: { at: now, action: target, from: entry.status, to: target, actor: ADMIN_ACTOR, reason: why },
      changes: { status: target, statusChangedAt: now, statusReason: why },
    };
  });
}

/**
 * Correct a line (`index` is its place, from 0) or add one (`index` null),
 * as a history event holding the line before and after. `lines` is never
 * touched. The amount is what the receipt prints for the line, as the admin
 * typed it; nothing is multiplied or worked out here.
 */
export function changeEntryLine(id: string, index: number | null, line: Line, seen: number): Promise<ReviewResult> {
  return review(id, seen, (entry, now) => {
    const current = readLinesNow(entry.lines, entry.history);
    if (current.kind !== 'ok') return { kind: 'refuse', result: { kind: 'unreadable' } };

    if (index === null) {
      if (current.lines.length >= LIMITS.LINES_MAX_AFTER_REVIEW) {
        return { kind: 'refuse', result: { kind: 'too-many-lines' } };
      }
      return {
        kind: 'write',
        event: {
          at: now,
          action: 'line_added',
          from: null,
          to: null,
          actor: ADMIN_ACTOR,
          reason: null,
          line: { index: current.lines.length, before: null, after: line },
        },
      };
    }

    const was = current.lines[index];
    if (!was) return { kind: 'refuse', result: { kind: 'no-such-line' } };
    if (was.name === line.name && was.quantity === line.quantity && was.lineTotalCents === line.lineTotalCents) {
      return { kind: 'nothing' };
    }
    return {
      kind: 'write',
      event: {
        at: now,
        action: 'line_corrected',
        from: null,
        to: null,
        actor: ADMIN_ACTOR,
        reason: null,
        line: {
          index,
          before: { name: was.name, quantity: was.quantity, lineTotalCents: was.lineTotalCents },
          after: line,
        },
      },
    };
  });
}

// ─── Receipt ───────────────────────────────────────────────────

export type ReceiptFound =
  | { kind: 'found'; path: string }
  /** No entry has this ID. */
  | { kind: 'no-entry' }
  /** The entry has no receipt at that place, or one whose path is not under receipts/. */
  | { kind: 'no-receipt' };

/**
 * The Storage path of an entry's receipt, from the entry itself: the path is
 * never rebuilt, never taken from a request, and never returned. Only a path
 * under receipts/ is accepted, so a link can never be made to anything else
 * in the bucket. One read, with a field mask of `receipts`.
 *
 * @throws if the read fails.
 */
export async function findReceipt(entryId: string, index: number): Promise<ReceiptFound> {
  if (!isDocumentId(entryId)) return { kind: 'no-entry' };

  const db = getAdminDb();
  const [doc] = await db.getAll(db.collection(COST_ENTRIES_COLLECTION).doc(entryId), { fieldMask: ['receipts'] });
  if (!doc.exists) return { kind: 'no-entry' };

  const receipts: unknown = doc.get('receipts');
  const receipt: unknown = Array.isArray(receipts) ? receipts[index] : undefined;
  const path = receipt && typeof receipt === 'object' ? (receipt as Record<string, unknown>).path : undefined;
  if (typeof path !== 'string' || !path.startsWith(`${RECEIPTS_PREFIX}/`) || path.includes('..')) {
    return { kind: 'no-receipt' };
  }
  return { kind: 'found', path };
}

// ─── A cleaner's own entries ───────────────────────────────────

/** An entry in the form the cleaner app lists it. */
function toCleanerEntry(entry: CostEntryFields): CleanerEntry {
  const now = readLinesNow(entry.lines, entry.history);
  return {
    id: entry.id,
    createdAt: entry.createdAt,
    propertyId: entry.propertyId,
    propertyNameAtEntry: entry.propertyNameAtEntry,
    lineCount: entry.lines?.length ?? null,
    totalCents: now.kind === 'ok' ? now.totalCents : null,
    sentTotalCents: now.kind === 'ok' ? now.sentTotalCents : null,
    corrected: now.kind === 'ok' && now.corrected,
    status: entry.status,
    statusReason: entry.status === 'rejected' ? entry.statusReason : null,
  };
}

/**
 * This cleaner's entries, newest first, and never anyone else's: the query
 * names the cleaner from the verified session, and each document is checked
 * again here. Only the fields the list needs are read. One read per entry.
 *
 * @throws if the read fails — which is not an empty list.
 */
export async function listCleanerEntries(cleanerId: string): Promise<CleanerEntry[]> {
  const snapshot = await getAdminDb()
    .collection(COST_ENTRIES_COLLECTION)
    .where('cleanerId', '==', cleanerId)
    .select('cleanerId', 'createdAt', 'propertyId', 'propertyNameAtEntry', 'lines', 'history', 'status', 'statusReason')
    .get();

  return snapshot.docs
    .map((doc) => readCostEntryFields(doc.id, doc.data()))
    .filter((entry) => entry.cleanerId === cleanerId)
    .map(toCleanerEntry)
    .sort(newestFirst);
}
