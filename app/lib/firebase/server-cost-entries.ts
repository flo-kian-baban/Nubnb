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
 * cannot write over each other. None of it depends on the entry's status: an
 * approved entry is corrected or removed exactly as a pending one is (Kian's
 * ruling of 2026-09-30).
 *
 * ── Approved automatically (dispatch 24, Kian's decision of 2026-09-30) ──
 * A receipt entry whose lines plus tax, as sent, add up to strictly under
 * LIMITS.AUTO_APPROVE_UNDER_CENTS is created `approved`: the same
 * transaction writes two history events at the same instant, `submitted` by
 * the cleaner and `approved` by the system actor, and an `autoApproved`
 * record naming the threshold and the total the rule saw. Every new entry
 * carries `autoApproved` (the record or null) and `kind`. A work entry never
 * qualifies, whatever its amount; the test is on the kind. Such an entry
 * stays in the queue until an admin marks it `seen` (markEntrySeen) or acts
 * on it.
 *
 * ── Work entries (dispatch 24) ──
 * A handyman's work is an entry of `kind: 'work'`: one line whose name is
 * the description, `taxCents: null`, no receipt, always `pending`. It is
 * written by createWorkEntry through POST /api/cleaner/work, with the same
 * send-once guard and the same in-transaction re-read of the account.
 *
 * ── Reports handed out ──
 * A PDF goes to a property's co-owners, and an entry in it can still be
 * corrected or removed afterwards. So each PDF is recorded before the page
 * downloads it (recordReportExport): one `cost_report_exports` document
 * holding, for every entry in the PDF, its history length and the amounts
 * printed. The server works the report out again from what is stored and
 * records it only if that is what the page built the PDF from. A record is
 * written once and never changed; no entry is touched by it.
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
 * read, and only its `name` field.
 */

import { z } from 'zod';
import type { DocumentReference, DocumentSnapshot, Transaction } from 'firebase-admin/firestore';
import { getAdminDb } from './admin';
import { isDocumentId } from './server-leads';
import type { ReadingAttachment } from '@/app/lib/cleaners/readings';
import { inRange, sentDay } from '@/app/lib/costs/report';
import {
  ADMIN_ACTOR,
  AUTO_APPROVAL_REASON,
  SYSTEM_ACTOR,
  CLEANERS_COLLECTION,
  COST_ENTRIES_COLLECTION,
  COST_ENTRY_SCHEMA_VERSION,
  COST_ENTRY_SUBMISSIONS_COLLECTION,
  COST_ENTRY_SUBMISSION_SCHEMA_VERSION,
  COST_ENTRY_READINGS_COLLECTION,
  COST_ENTRY_READING_SCHEMA_VERSION,
  COST_REPORT_EXPORTS_COLLECTION,
  COST_REPORT_EXPORT_SCHEMA_VERSION,
  CURRENCY,
  ENTRY_TIME_ZONE,
  LIMITS,
  RECEIPTS_PREFIX,
  SUBMISSION_KEY_PATTERN,
  dayIn,
  fieldText,
  newestFirst,
  prefillFromReading,
  readCostEntryFields,
  readReportExport,
  taxFromReading,
  readLinesNow,
  awaitingLook,
  type AutoApproved,
  type CleanerEntry,
  type CostEntryFields,
  type CostEntryView,
  type CostsView,
  type HistoryEvent,
  type Line,
  type LookupState,
  type ReadingLineOutcome,
  type ReceiptRef,
  type Refusal,
  type ReportExport,
  type ReportExportEntry,
  type ReportExportView,
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

/** The tax: dollars and two decimals, never negative: "12.71", "0.00". Up to 999999.99. */
const TAX_AMOUNT = /^(0|[1-9][0-9]{0,5})\.[0-9]{2}$/;

/**
 * A tax as typed ("12.71") or absent, to cents or null (dispatch 21). Tax is
 * its own field on the entry, never a line: an item line is something that
 * was bought.
 */
export const TaxInputSchema = z
  .string()
  .regex(TAX_AMOUNT, 'A tax amount with two decimals, like 12.71')
  .transform(toCents)
  .nullable()
  .optional()
  .transform((value) => value ?? null);

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A line total as integer cents, taken from the string's digits and never
 * through a float: "7.98" → 798, "-1.00" → -100. At most eight digits, so
 * the result is exact. "-0.00" is 0, not -0.
 */
export function toCents(text: string): number {
  const negative = text.startsWith('-');
  const [whole, fraction] = (negative ? text.slice(1) : text).split('.');
  const cents = Number(whole + fraction);
  return negative && cents !== 0 ? -cents : cents;
}

/**
 * The same calendar day `months` months earlier, clamped to that month's
 * last day: 2026-09-30 → 2025-09-30, 2028-02-29 → 2027-02-28. Pure date
 * arithmetic on the `YYYY-MM-DD` text, in no time zone.
 */
export function monthsBefore(day: string, months: number): string {
  const [year, month, date] = day.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 - months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(date, lastDay));
  return target.toISOString().slice(0, 10);
}

/**
 * Why a purchase date is refused, or null. It must be a real day, no later
 * than today and no earlier than 12 months before today, on the Toronto
 * calendar (Kian's ruling of 2026-09-30; before it, anything from 2020 to
 * tomorrow UTC was taken). Wherever a purchase date is entered, it comes
 * through this schema, so the rule holds everywhere.
 */
export function purchasedOnProblem(value: string, now: Date = new Date()): string | null {
  const match = ISO_DATE.exec(value);
  if (!match) return 'Write the date as yyyy-mm-dd';

  // A real calendar date survives a round trip through UTC: 2026-02-30 does not.
  const [, year, month, day] = match;
  const time = Date.UTC(Number(year), Number(month) - 1, Number(day));
  if (new Date(time).toISOString().slice(0, 10) !== value) return 'Not a real calendar date';

  const today = dayIn(ENTRY_TIME_ZONE, now);
  if (value > today) return 'The date cannot be in the future';
  const earliest = monthsBefore(today, LIMITS.PURCHASED_ON_MONTHS_BACK);
  if (value < earliest) return `The date must be within the last ${LIMITS.PURCHASED_ON_MONTHS_BACK} months`;
  return null;
}

/**
 * One line as typed: the cleaner's, and an admin's correction or added line.
 * The amount is the line's total as printed on the receipt; the quantity is
 * informational. Stored as a `Line`. `nameMax` is 120 for an item; an
 * admin's correction allows a work entry's 200-character description and
 * changeEntryLine holds a receipt entry's line to 120 (dispatch 24).
 */
const lineSchema = (nameMax: number) => z
  .strictObject({
    name: z
      .string()
      .transform((s) => s.normalize('NFC').trim())
      .pipe(
        z
          .string()
          .min(1, 'Name the item')
          .max(nameMax, `At most ${nameMax} characters`)
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

export const LineInputSchema = lineSchema(LIMITS.LINE_NAME_MAX);

/** An admin's correction: long enough for a work description; a receipt line is held to 120 in changeEntryLine. */
export const ReviewLineInputSchema = lineSchema(Math.max(LIMITS.LINE_NAME_MAX, LIMITS.WORK_DESCRIPTION_MAX));

/**
 * The body of POST /api/cleaner/work (dispatch 24), validated: the
 * description NFC and trimmed, 1–200 characters, no control characters; the
 * price as "185.00", more than zero, to cents. Strict: any other key is
 * refused.
 */
export const WorkInputSchema = z.strictObject({
  submissionKey: z.string().regex(SUBMISSION_KEY_PATTERN, 'Not a submission key'),
  propertyId: z.string().refine((id) => isDocumentId(id), 'Not a property ID'),
  description: z
    .string()
    .transform((s) => s.normalize('NFC').replace(/\s+/g, ' ').trim())
    .pipe(
      z
        .string()
        .min(1, 'Say what was done')
        .max(LIMITS.WORK_DESCRIPTION_MAX, `At most ${LIMITS.WORK_DESCRIPTION_MAX} characters`)
        .refine((s) => !CONTROL_CHARACTER.test(s), 'No control characters'),
    ),
  price: z
    .string()
    .regex(TAX_AMOUNT, 'An amount with two decimals, like 185.00')
    .transform(toCents)
    .pipe(z.number().positive('The price must be more than $0.00')),
});

export type WorkInput = z.output<typeof WorkInputSchema>;

export type WorkParseResult =
  | { kind: 'ok'; work: WorkInput }
  | { kind: 'invalid'; issues: { path: string; message: string }[] };

/** Read a work body: the schema, and nothing else. Never throws, never logs the body. */
export function parseWorkBody(json: unknown): WorkParseResult {
  const result = WorkInputSchema.safeParse(json);
  if (!result.success) {
    return {
      kind: 'invalid',
      issues: result.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
    };
  }
  return { kind: 'ok', work: result.data };
}

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
  /** The receipt's tax, apart from the items; absent or null when the cleaner gave none. */
  tax: TaxInputSchema,
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

/**
 * A reading the phone carried back with the entry (dispatch 20), already
 * verified by the route: the signed record, and for each entry line, in
 * order, the index of the model line it was filled from, or null for a
 * line the cleaner added. It is written beside the entry, in its own
 * document, and never changes what the entry says.
 */
export type { ReadingAttachment };

/** The `cost_entry_readings/{entryId}` document: the model's reading and what became of each of its lines. */
function readingDocument(entryId: string, cleanerId: string, now: string, entry: CostEntryInput, reading: ReadingAttachment) {
  const { record, fromReading } = reading;
  const modelLines = record.output?.lines ?? [];
  const lines = modelLines.map((line, index) => {
    const entryLine = fromReading.indexOf(index);
    const shown = prefillFromReading(line);
    const base = { index, name: line.name, quantity: line.quantity, amount: line.amount, kind: line.kind };
    // A tax line fills the tax field, never an item line (dispatch 21).
    if (line.kind === 'tax') return { ...base, outcome: 'tax' as ReadingLineOutcome, entryLine: null, edited: [] as string[] };
    if (entryLine === -1 || !shown) return { ...base, outcome: 'left_out' as ReadingLineOutcome, entryLine: null, edited: [] as string[] };
    const sent = entry.lines[entryLine];
    const edited: string[] = [];
    if (sent.name !== shown.name) edited.push('name');
    if (sent.quantity !== Number(shown.quantity)) edited.push('quantity');
    if (sent.lineTotalCents !== toCents(shown.price)) edited.push('amount');
    return { ...base, outcome: (edited.length ? 'edited' : 'unchanged') as ReadingLineOutcome, entryLine, edited };
  });
  const added = fromReading.map((from, i) => (from === null ? i : -1)).filter((i) => i !== -1);
  const tally = (outcome: ReadingLineOutcome) => lines.filter((line) => line.outcome === outcome).length;
  const readTax = taxFromReading(record.output);
  const readTaxCents = readTax === null ? null : toCents(readTax);
  return {
    schemaVersion: COST_ENTRY_READING_SCHEMA_VERSION,
    entryId,
    cleanerId,
    createdAt: now,
    reading: {
      id: record.id,
      requestedAt: record.requestedAt,
      model: record.model,
      modelVersion: record.modelVersion,
      thinkingLevel: record.thinkingLevel,
      ms: record.ms,
      status: record.status,
      reason: record.reason,
      usage: record.usage,
      output: record.output,
      rawText: record.rawText,
    },
    lines,
    added,
    /** The tax the model read against the tax the cleaner sent (dispatch 21). */
    tax: { readCents: readTaxCents, sentCents: entry.tax, edited: readTaxCents !== entry.tax },
    summary: {
      modelLines: modelLines.length,
      unchanged: tally('unchanged'),
      edited: tally('edited'),
      leftOut: tally('left_out'),
      taxLines: tally('tax'),
      added: added.length,
      sentLines: entry.lines.length,
    },
  };
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
  /** The verified reading, or null when the phone sent none or it did not verify. */
  reading: ReadingAttachment | null;
}

export interface CostEntryCreated {
  id: string;
  /** `approved` when the entry was approved automatically (dispatch 24). */
  status: 'pending' | 'approved';
  createdAt: string;
  lineCount: number;
  /** True when the model's reading was written beside the entry. */
  readingStored: boolean;
  /** True when the entry was written approved under the automatic rule. */
  autoApproved: boolean;
}

/**
 * The account as the create transaction re-read it: still active, still on
 * the session's epoch. Its name and role are copied from that same read.
 */
interface AccountNow {
  name: string | null;
  role: string;
}

/**
 * Re-read the account inside a create transaction: it must exist, be
 * active, and be on the session epoch the token carries; and, when the
 * route demands a role, have that role.
 *
 * @throws SessionRevokedError otherwise. Nothing is written.
 */
function accountNow(cleaner: DocumentSnapshot, sessionEpoch: number, mustBe: CleanerRoleName): AccountNow {
  const stored = cleaner.data() ?? {};
  if (!cleaner.exists || stored.status !== 'active' || stored.sessionEpoch !== sessionEpoch) {
    throw new SessionRevokedError();
  }
  const role = stored.role === undefined || stored.role === null ? 'cleaner' : stored.role;
  if (role !== mustBe) throw new SessionRevokedError();
  const storedName: unknown = stored.name;
  return { name: typeof storedName === 'string' ? storedName : null, role };
}

type CleanerRoleName = 'cleaner' | 'handyman';

/**
 * The submission document this send would write, checked first: an
 * earlier send of the same key already wrote its entry.
 *
 * @throws DuplicateSubmissionError with that entry; or an error when the
 * record is not in the written shape.
 */
function refuseDuplicate(sent: DocumentSnapshot): void {
  if (!sent.exists) return;
  const first = readSubmission(sent.data());
  // A submission document that names no entry is not in the written
  // shape; nothing is written over it.
  if (!first) throw new Error('The submission record for this receipt is unreadable');
  throw new DuplicateSubmissionError(first);
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
  const { entryRef, cleanerId, sessionEpoch, entry, propertyNameAtEntry, receipt, reading } = input;
  let createdAt = '';
  let autoApprovedOut = false;

  try {
    const db = getAdminDb();
    const cleanerRef = db.collection(CLEANERS_COLLECTION).doc(cleanerId);
    const sentRef = submissionRef(cleanerId, entry.submissionKey);

    await db.runTransaction(async (tx) => {
      const [cleaner, sent] = await tx.getAll(cleanerRef, sentRef);
      // Only a cleaner writes a receipt entry (dispatch 24): a handyman's session is refused here too.
      const account = accountNow(cleaner, sessionEpoch, 'cleaner');
      refuseDuplicate(sent);

      const cleanerNameAtEntry = account.name;
      const now = new Date().toISOString();
      const submitted: HistoryEvent = {
        at: now,
        action: 'submitted',
        from: null,
        to: 'pending',
        actor: { role: 'cleaner', id: cleanerId, name: cleanerNameAtEntry },
        reason: null,
      };

      // The rule (dispatch 24): the entry as sent, lines plus tax, strictly under the threshold.
      const sentTotalCents = entry.lines.reduce((sum, line) => sum + line.lineTotalCents, 0) + (entry.tax ?? 0);
      const autoApprove = sentTotalCents < LIMITS.AUTO_APPROVE_UNDER_CENTS;
      const approved: HistoryEvent = {
        at: now,
        action: 'approved',
        from: 'pending',
        to: 'approved',
        actor: SYSTEM_ACTOR,
        reason: AUTO_APPROVAL_REASON,
      };
      const autoApproved: AutoApproved | null = autoApprove
        ? { thresholdCents: LIMITS.AUTO_APPROVE_UNDER_CENTS, totalCents: sentTotalCents, at: now }
        : null;
      autoApprovedOut = autoApprove;

      tx.create(entryRef, {
        schemaVersion: COST_ENTRY_SCHEMA_VERSION,
        kind: 'receipt',
        cleanerId,
        cleanerNameAtEntry,
        propertyId: entry.propertyId,
        propertyNameAtEntry,
        createdAt: now,
        purchasedOn: entry.purchasedOn,
        note: entry.note,
        currency: CURRENCY,
        lines: entry.lines.map(({ name, quantity, lineTotalCents }) => ({ name, quantity, lineTotalCents })),
        // Its own field, always present on a version 2 entry (dispatch 21): null when the cleaner gave none.
        taxCents: entry.tax,
        receipts: [
          {
            path: receipt.path,
            contentType: receipt.contentType,
            bytes: receipt.bytes,
            sha256: receipt.sha256,
            uploadedAt: receipt.uploadedAt,
          },
        ],
        status: autoApprove ? 'approved' : 'pending',
        statusChangedAt: now,
        statusReason: null,
        history: autoApprove ? [submitted, approved] : [submitted],
        autoApproved,
      });
      tx.create(sentRef, {
        schemaVersion: COST_ENTRY_SUBMISSION_SCHEMA_VERSION,
        cleanerId,
        submissionKey: entry.submissionKey,
        entryId: entryRef.id,
        createdAt: now,
      });
      // The model's reading, beside the entry and never inside it (dispatch 20).
      if (reading) {
        tx.create(
          db.collection(COST_ENTRY_READINGS_COLLECTION).doc(entryRef.id),
          readingDocument(entryRef.id, cleanerId, now, entry, reading),
        );
      }
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

  return {
    id: entryRef.id,
    status: autoApprovedOut ? 'approved' : 'pending',
    createdAt,
    lineCount: entry.lines.length,
    readingStored: reading !== null,
    autoApproved: autoApprovedOut,
  };
}

// ─── Create: work (dispatch 24) ────────────────────────────────

export interface NewWorkEntry {
  /** From the verified session, never from the body. */
  cleanerId: string;
  sessionEpoch: number;
  /** From parseWorkBody. */
  work: WorkInput;
  /** From lookupPropertyName. */
  propertyNameAtEntry: string | null;
}

export interface WorkEntryCreated {
  id: string;
  status: 'pending';
  createdAt: string;
}

/**
 * Write one work entry, in a transaction that re-reads the account: it must
 * exist, be active, be on the session epoch the token carries, and be a
 * handyman. The same transaction checks the one-time key and records it
 * beside the entry. Stored as one line whose name is the description, with
 * no tax, no receipt and no reading; always pending, whatever the amount
 * (Kian's ruling: every work entry needs approval).
 *
 * @throws SessionRevokedError if the session no longer holds, or the
 * account is not a handyman.
 * @throws DuplicateSubmissionError if this key was sent before.
 * @throws anything else the transaction throws.
 */
export async function createWorkEntry(input: NewWorkEntry): Promise<WorkEntryCreated> {
  const { cleanerId, sessionEpoch, work, propertyNameAtEntry } = input;
  const db = getAdminDb();
  const entryRef = db.collection(COST_ENTRIES_COLLECTION).doc();
  const cleanerRef = db.collection(CLEANERS_COLLECTION).doc(cleanerId);
  const sentRef = submissionRef(cleanerId, work.submissionKey);
  let createdAt = '';

  await db.runTransaction(async (tx) => {
    const [cleaner, sent] = await tx.getAll(cleanerRef, sentRef);
    const account = accountNow(cleaner, sessionEpoch, 'handyman');
    refuseDuplicate(sent);

    const now = new Date().toISOString();
    const submitted: HistoryEvent = {
      at: now,
      action: 'submitted',
      from: null,
      to: 'pending',
      actor: { role: 'handyman', id: cleanerId, name: account.name },
      reason: null,
    };
    tx.create(entryRef, {
      schemaVersion: COST_ENTRY_SCHEMA_VERSION,
      kind: 'work',
      cleanerId,
      cleanerNameAtEntry: account.name,
      propertyId: work.propertyId,
      propertyNameAtEntry,
      createdAt: now,
      purchasedOn: null,
      note: null,
      currency: CURRENCY,
      lines: [{ name: work.description, quantity: 1, lineTotalCents: work.price }],
      taxCents: null,
      receipts: [],
      status: 'pending',
      statusChangedAt: now,
      statusReason: null,
      history: [submitted],
      autoApproved: null,
    });
    tx.create(sentRef, {
      schemaVersion: COST_ENTRY_SUBMISSION_SCHEMA_VERSION,
      cleanerId,
      submissionKey: work.submissionKey,
      entryId: entryRef.id,
      createdAt: now,
    });
    createdAt = now;
  });

  return { id: entryRef.id, status: 'pending', createdAt };
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
    linesNow: readLinesNow(entry.lines, entry.history, { shape: entry.taxShape, cents: entry.taxCents }),
    receipts: entry.receipts,
    taxShape: entry.taxShape,
    kind: entry.kind,
    autoApproved: entry.autoApproved,
  };
}

/**
 * Every property that exists, by ID, with its name; null when the lookup
 * failed. One read per property, of `name` alone. A ledger can be opened for
 * a property that has no entries yet, and it still has to say whose it is.
 */
async function lookUpAllProperties(): Promise<Map<string, PropertyNow> | null> {
  try {
    const snapshot = await getAdminDb().collection('properties').select('name').get();
    return new Map(snapshot.docs.map((doc): [string, PropertyNow] => [doc.id, { name: fieldText(doc.get('name')) }]));
  } catch (err) {
    console.error(`[cost-entries] could not look up properties: grpc code ${grpcCode(err)}`);
    return null;
  }
}

/**
 * Everything the costs page works from, in one answer: every cost entry,
 * newest first, with the current name and status of its cleaner and the
 * current name of its property; every recorded PDF, newest first; and every
 * property's current name, A to Z.
 *
 * Deliberately no `orderBy` and no `limit`: Firestore leaves out every
 * document that lacks the ordered field, and a limit hides the rest, so an
 * entry could silently vanish. Both collections are read whole and sorted
 * here. No pagination: the costs page filters and adds up in the browser,
 * which needs every entry, and at a few entries a week the whole collection
 * is a small read. Worth revisiting near 1,000 entries.
 *
 * Reads: one per entry, one per recorded PDF, one per property (its name
 * alone) and one per distinct cleaner.
 *
 * @throws if the entries or the recorded PDFs cannot be read: a PDF record
 * that did not load must never read as "no PDF was exported". A failed name
 * lookup does not throw.
 */
export async function listCosts(): Promise<CostsView> {
  const db = getAdminDb();
  const [snapshot, exported, properties] = await Promise.all([
    db.collection(COST_ENTRIES_COLLECTION).get(),
    db.collection(COST_REPORT_EXPORTS_COLLECTION).get(),
    lookUpAllProperties(),
  ]);
  const entries = snapshot.docs.map((doc) => readCostEntryFields(doc.id, doc.data()));
  const cleaners = await lookUpCleaners(distinctIds(entries.map((entry) => entry.cleanerId)));

  return {
    entries: entries.map((entry) => toView(entry, cleaners, properties)).sort(newestFirst),
    exports: exported.docs.map((doc) => readReportExport(doc.id, doc.data())).sort(newestFirst),
    properties:
      properties === null
        ? null
        : [...properties.entries()]
            .map(([id, now]) => ({ id, name: now.name }))
            .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', 'en-CA') || a.id.localeCompare(b.id)),
  };
}

/**
 * Every entry of one property, newest first, with its lookups (dispatch
 * 23B: what a statement is built from). One read per entry, one per
 * distinct cleaner, one for the property's name.
 *
 * @throws if the entries cannot be read.
 */
export async function listPropertyEntries(propertyId: string): Promise<CostEntryView[]> {
  if (!isDocumentId(propertyId)) return [];
  const db = getAdminDb();
  const snapshot = await db.collection(COST_ENTRIES_COLLECTION).where('propertyId', '==', propertyId).get();
  const entries = snapshot.docs.map((doc) => readCostEntryFields(doc.id, doc.data()));
  const [cleaners, properties] = await Promise.all([
    lookUpCleaners(distinctIds(entries.map((entry) => entry.cleanerId))),
    lookUpProperties([propertyId]),
  ]);
  return entries.map((entry) => toView(entry, cleaners, properties)).sort(newestFirst);
}

/** The stored fields of one property's entries, read inside a transaction (dispatch 23B's finish step). */
export async function propertyEntriesInTransaction(tx: Transaction, propertyId: string): Promise<CostEntryView[]> {
  const db = getAdminDb();
  const snapshot = await tx.get(db.collection(COST_ENTRIES_COLLECTION).where('propertyId', '==', propertyId));
  const entries = snapshot.docs.map((doc) => readCostEntryFields(doc.id, doc.data()));
  // Names are display only: the claim compares IDs and history lengths, so the lookups can stay outside the transaction.
  return entries.map((entry) => toView(entry, new Map(), new Map())).sort(newestFirst);
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
  /** The entry keeps its tax among its lines (an older entry): correct the line instead. */
  | { kind: 'tax-in-lines' }
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
  /** A receipt line's name is longer than LIMITS.LINE_NAME_MAX (dispatch 24: only a work description may be longer). */
  | { kind: 'line-name-too-long' }
  /** A work entry is one description and one amount: no line is added to it (dispatch 24). */
  | { kind: 'work-one-line' }
  /** Seen was asked for an entry that was not approved automatically (dispatch 24). Nothing was written. */
  | { kind: 'not-auto-approved' }
  /** The transaction failed: it may or may not have landed. */
  | { kind: 'failed' };

/** What the review routes answer for every outcome but `done`. */
export const REVIEW_REFUSALS: Record<Exclude<ReviewResult['kind'], 'done'>, Refusal> = {
  'tax-in-lines': {
    status: 409,
    code: 'ENTRY_TAX_IN_LINES',
    message: 'This entry keeps its tax among its lines.',
    hint: 'It was sent before tax became its own field. Correct the tax line instead; nothing was changed.',
  },
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
  'line-name-too-long': {
    status: 422,
    code: 'ENTRY_LINE_NAME_TOO_LONG',
    message: `A receipt line's name can be at most ${LIMITS.LINE_NAME_MAX} characters.`,
    hint: 'Nothing was changed.',
  },
  'work-one-line': {
    status: 422,
    code: 'ENTRY_WORK_ONE_LINE',
    message: 'A work entry is one description and one amount.',
    hint: 'Correct the line instead of adding one. Nothing was changed.',
  },
  'not-auto-approved': {
    status: 409,
    code: 'ENTRY_NOT_AUTO_APPROVED',
    message: 'This entry was not approved automatically, so there is nothing to mark as seen.',
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
    const current = readLinesNow(entry.lines, entry.history, { shape: entry.taxShape, cents: entry.taxCents });
    if (current.kind !== 'ok') return { kind: 'refuse', result: { kind: 'unreadable' } };

    // A receipt line's name stays within its own limit; only a work description may run to 200 (dispatch 24).
    if (entry.kind !== 'work' && line.name.length > LIMITS.LINE_NAME_MAX) {
      return { kind: 'refuse', result: { kind: 'line-name-too-long' } };
    }

    if (index === null) {
      if (entry.kind === 'work') return { kind: 'refuse', result: { kind: 'work-one-line' } };
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

/**
 * Correct an entry's tax (dispatch 21), as a history event holding the tax
 * before and after; `taxCents` itself is never touched. Only an entry that
 * keeps its tax apart takes one: on an older entry the tax, if any, is a
 * line among the items, and it is that line that is corrected.
 */
export function changeEntryTax(id: string, taxCents: number | null, seen: number): Promise<ReviewResult> {
  return review(id, seen, (entry, now) => {
    if (entry.taxShape !== 'field') return { kind: 'refuse', result: { kind: 'tax-in-lines' } };
    const current = readLinesNow(entry.lines, entry.history, { shape: entry.taxShape, cents: entry.taxCents });
    if (current.kind !== 'ok') return { kind: 'refuse', result: { kind: 'unreadable' } };
    if (current.taxCents === taxCents) return { kind: 'nothing' };
    return {
      kind: 'write',
      event: {
        at: now,
        action: 'tax_corrected',
        from: null,
        to: null,
        actor: ADMIN_ACTOR,
        reason: null,
        tax: { before: current.taxCents, after: taxCents },
      },
    };
  });
}

/**
 * Mark an entry approved automatically as seen (dispatch 24): a `seen`
 * history event by the admin, no status change. An entry that was not
 * approved automatically is refused; one an admin has already looked at
 * (marked seen, corrected, removed or rejected since) writes nothing.
 */
export function markEntrySeen(id: string, seen: number): Promise<ReviewResult> {
  return review(id, seen, (entry, now) => {
    if (entry.autoApproved === null) return { kind: 'refuse', result: { kind: 'not-auto-approved' } };
    if (!awaitingLook(entry)) return { kind: 'nothing' };
    return {
      kind: 'write',
      event: { at: now, action: 'seen', from: null, to: null, actor: ADMIN_ACTOR, reason: null },
    };
  });
}

// ─── Reports handed out ────────────────────────────────────────

/**
 * A PDF as the costs page is about to make it: the property, the period it
 * prints, and each entry in it with the history length the page saw.
 */
export interface ReportClaim {
  propertyId: string;
  /** yyyy-mm-dd, both days included: the period as the PDF prints it, never an open end. */
  from: string;
  to: string;
  entries: { id: string; seen: number }[];
}

export type ReportRecordResult =
  | { kind: 'recorded'; export: ReportExportView }
  /**
   * What is stored is not what the page built the PDF from: since the page
   * loaded an entry in the period was corrected, approved, rejected or
   * removed. Nothing was written, and the page downloads nothing.
   */
  | { kind: 'changed-since' }
  /** An approved entry in the period cannot be added up, so no report can be made. Nothing was written. */
  | { kind: 'unreadable' }
  /** No property has this ID and no entry names it. Nothing was written. */
  | { kind: 'no-such-property' }
  /** The transaction failed: it may or may not have landed. */
  | { kind: 'failed' };

/** What the report route answers for every outcome but `recorded`. */
export const REPORT_REFUSALS: Record<Exclude<ReportRecordResult['kind'], 'recorded'>, Refusal> = {
  'changed-since': {
    status: 409,
    code: 'REPORT_CHANGED',
    message: 'An entry in this report changed since the page loaded.',
    hint: 'Nothing was recorded and nothing was downloaded. Refresh, check what changed, and export again.',
  },
  unreadable: {
    status: 409,
    code: 'REPORT_ENTRY_UNREADABLE',
    message: 'An approved entry in this period cannot be added up.',
    hint: 'Nothing was recorded and nothing was downloaded. Refresh and open the entry to see why.',
  },
  'no-such-property': {
    status: 404,
    code: 'PROPERTY_NOT_FOUND',
    message: 'Property not found',
  },
  // As with a review: a failure can come after the commit landed.
  failed: {
    status: 502,
    code: 'REPORT_RECORD_FAILED',
    message: 'Could not record the PDF.',
    hint: 'Nothing was downloaded. The record may or may not have been made: refresh to see what is on record.',
  },
};

/**
 * Record one PDF before the page downloads it, in one transaction: read the
 * property's entries, work the report out again — its approved entries in
 * the period, each as it now adds up — and write the record only if that is
 * exactly what the page says it built the PDF from (the same entries, each
 * with the history length the page saw). So a PDF is never recorded, or
 * downloaded, from a page that has fallen behind what is stored.
 *
 * The record holds each entry's history length and the amounts the PDF
 * prints for it. Nothing on any entry is written.
 *
 * Reads: the property's name and one per entry of that property.
 */
export async function recordReportExport(claim: ReportClaim): Promise<ReportRecordResult> {
  let outcome: Exclude<ReportRecordResult, { kind: 'recorded' }> | { id: string; stored: ReportExport };
  try {
    const db = getAdminDb();
    const exportRef = db.collection(COST_REPORT_EXPORTS_COLLECTION).doc();

    outcome = await db.runTransaction(async (tx) => {
      const [property] = await tx.getAll(db.collection('properties').doc(claim.propertyId), { fieldMask: ['name'] });
      const snapshot = await tx.get(
        db.collection(COST_ENTRIES_COLLECTION).where('propertyId', '==', claim.propertyId),
      );
      const all = snapshot.docs.map((doc) => readCostEntryFields(doc.id, doc.data())).sort(newestFirst);
      if (all.length === 0 && !property.exists) return { kind: 'no-such-property' } as const;

      // The report as buildReport (costs/report.ts) makes it: approved, sent in the period, oldest first.
      const approved = all
        .filter((entry) => entry.status === 'approved' && inRange(sentDay(entry.createdAt), claim.from, claim.to))
        .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id));

      const seen = new Map(claim.entries.map((entry) => [entry.id, entry.seen]));
      const asThePageSawIt =
        approved.length === seen.size &&
        approved.every((entry) => entry.history !== null && seen.get(entry.id) === entry.history.length);
      if (!asThePageSawIt) return { kind: 'changed-since' } as const;

      const entries: ReportExportEntry[] = [];
      for (const entry of approved) {
        const now = readLinesNow(entry.lines, entry.history, { shape: entry.taxShape, cents: entry.taxCents });
        if (now.kind !== 'ok' || entry.history === null) return { kind: 'unreadable' } as const;
        entries.push({
          entryId: entry.id,
          historyLength: entry.history.length,
          itemsCents: now.itemsCents,
          taxCents: now.taxCents,
          totalCents: now.totalCents,
        });
      }

      // The live name, or, for a property that no longer exists, the name its newest entry recorded.
      const liveName: unknown = property.exists ? property.get('name') : undefined;
      const recordedName = all.find((entry) => entry.propertyNameAtEntry !== null)?.propertyNameAtEntry ?? null;
      const stored: ReportExport = {
        schemaVersion: COST_REPORT_EXPORT_SCHEMA_VERSION,
        kind: 'pdf',
        propertyId: claim.propertyId,
        propertyNameAtExport: typeof liveName === 'string' && liveName.trim() !== '' ? liveName : recordedName,
        from: claim.from,
        to: claim.to,
        createdAt: new Date().toISOString(),
        actor: ADMIN_ACTOR,
        entries,
        itemsCents: entries.reduce((sum, entry) => sum + entry.itemsCents, 0),
        taxCents: entries.reduce((sum, entry) => sum + (entry.taxCents ?? 0), 0),
        totalCents: entries.reduce((sum, entry) => sum + entry.totalCents, 0),
      };
      tx.create(exportRef, stored);
      return { id: exportRef.id, stored };
    });
  } catch (err) {
    console.error(`[cost-entries] recording a PDF for property ${claim.propertyId} failed: grpc code ${grpcCode(err)}`);
    return { kind: 'failed' };
  }

  if ('kind' in outcome) return outcome;
  return { kind: 'recorded', export: readReportExport(outcome.id, { ...outcome.stored }) };
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
  const now = readLinesNow(entry.lines, entry.history, { shape: entry.taxShape, cents: entry.taxCents });
  return {
    kind: entry.kind,
    description: entry.kind === 'work' ? (now.kind === 'ok' ? (now.lines[0]?.name ?? null) : (entry.lines?.[0]?.name ?? null)) : null,
    id: entry.id,
    createdAt: entry.createdAt,
    propertyId: entry.propertyId,
    propertyNameAtEntry: entry.propertyNameAtEntry,
    lineCount: entry.lines?.length ?? null,
    totalCents: now.kind === 'ok' ? now.totalCents : null,
    sentTotalCents: now.kind === 'ok' ? now.sentTotalCents : null,
    taxCents: now.kind === 'ok' ? now.taxCents : null,
    taxShape: entry.taxShape,
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
    .select('cleanerId', 'createdAt', 'propertyId', 'propertyNameAtEntry', 'lines', 'taxCents', 'history', 'status', 'statusReason', 'kind')
    .get();

  return snapshot.docs
    .map((doc) => readCostEntryFields(doc.id, doc.data()))
    .filter((entry) => entry.cleanerId === cleanerId)
    .map(toCleanerEntry)
    .sort(newestFirst);
}
