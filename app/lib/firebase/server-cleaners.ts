/**
 * Server-side reads and writes of cleaners and their codes.
 *
 * `cleaners` and `cleaner_codes` are reached only through the Admin SDK: from
 * the admin routes under /api/admin/cleaners, after the admin session check,
 * and from the cleaner routes under /api/cleaner. firestore.rules denies
 * every browser read and write of both.
 *
 * ── Codes, stored readably ──
 * By Kian's ruling of 2026-09-28, an admin can read a cleaner's code at any
 * time and change it. A code is stored as itself: it is the ID of its
 * `cleaner_codes` document, and the cleaner's `code` field points at it.
 * The transaction that writes that document is what keeps codes unique — of
 * two writes of the same code, exactly one lands. A code document is kept
 * when its code is replaced or its account deleted (`retiredAt`), and by
 * Kian's ruling of 2026-10-02 a code is free to reuse whenever no active
 * account holds it: a replaced code, a deleted account's, or a deactivated
 * account's (whose holder is then left with no code). Only a code an active
 * account holds now is refused (codeAvailability). Sign-in needs both: the
 * code's document, not retired, and a cleaner who still points at that code.
 *
 * Admin PINs are four digits too, and by Kian's rulings of 2026-10-13 (late
 * night) no code may be an admin PIN, nor any admin PIN a code ever issued:
 * every transaction that gives out a code reads the digits' `admin_pins`
 * document as well (server-admins.ts, adminPinHolds) and refuses, or draws
 * again, when an admin holds them. A code an ordinary admin types is a try on
 * their connection's sign-in lock, whatever the answer: a refusal because an
 * admin holds it would tell them that admin's PIN, so typing codes is kept no
 * faster than guessing at the admin door. A main admin's is not counted: main
 * admins see every admin's PIN already (CodeTyper).
 *
 * ── What never leaves ──
 * `sessionEpoch` never reaches a response, nor does a version 1 cleaner's
 * `codeDigest`: listCleaners selects only the summary fields, and the other
 * reads name the fields they need. Codes reach the admin routes only.
 * Firestore errors on these paths are logged as a gRPC code only, because
 * their messages can carry a document path, and a `cleaner_codes` path is a
 * code.
 *
 * ── Writes ──
 * New documents are written with `create()`, which fails if the document
 * already exists; a status or code change is a transactional `update()`.
 * Nothing here overwrites a document, and the one delete is deleteCleaner
 * (Kian's ruling of 2026-10-02): the account's document goes, its code
 * documents stay and are retired. History is appended by reading the array
 * and writing it back inside the transaction — never with arrayUnion, which
 * drops an event identical to one already there.
 *
 * ── Roles (dispatch 24) ──
 * A handyman is a document here with `role: 'handyman'`, issued and managed
 * exactly as a cleaner is, with a code from the same index: one door, so a
 * code is unique across both roles. The role is read from the document on
 * every request, beside `status` and `sessionEpoch`, never carried by the
 * token. Absent means `cleaner`, on every account written before this.
 *
 * Failure contract, as in server-leads.ts: listCleaners THROWS when the read
 * fails; it never returns an empty list. The other functions return a
 * result naming what happened, "not confirmed" included, and never throw.
 */

import type { DocumentReference, Transaction } from 'firebase-admin/firestore';
import { getAdminDb } from './admin';
import { adminPinHolds, countTry, lockStateOf, readConnectionLock } from './server-admins';
import { readUnmarkedJobs, takeOffJobs } from './server-cleaning-jobs';
import { memberPaySources } from './server-pay';
import { readRegularReplacements, type RegularReplaced } from './server-regular-cleaners';
import { memberPay } from '@/app/lib/pay/balance';
import { deleteRefusal, type DeleteRefusal } from '@/app/lib/pay/checks';
import type { RegularReplacements } from '@/app/lib/schedule/regular';
import type { UnmarkedJob } from '@/app/lib/schedule/model';
import { isDocumentId } from './server-leads';
import { DAILY_TRIES, MAX_WRONG_TRIES, afterTry, lockHolding, type LockState, type SignInLockView } from '@/app/lib/admins/model';
import { generateCandidate, isDrawable, reservedReason, type ReservedReason } from '@/app/lib/cleaners/codes';
import {
  CLEANERS_COLLECTION,
  CLEANER_CODES_COLLECTION,
  CLEANER_SIGNIN_LOCKS_COLLECTION,
  CLEANER_CODE_SCHEMA_VERSION,
  CLEANER_SCHEMA_VERSION,
  CODE_PATTERN,
  newestFirst,
  fieldText,
  readCleanerSummary,
  roleOf,
  type Actor,
  type CleanerRole,
  type CleanerStatus,
  type CleanerSummary,
  type HistoryEvent,
  type Refusal,
} from '@/app/lib/cleaners/model';

/** gRPC status code Firestore reports when `create()` targets a document that exists. */
const ALREADY_EXISTS = 6;

/** Candidates drawn per issuance, or per generated code, before giving up. */
const MAX_CANDIDATES = 5;

/** The largest epoch a session token can carry (nine digits). */
const MAX_TOKEN_EPOCH = 999_999_999;

/** The only fields that leave Firestore for the list. Never `sessionEpoch` or `codeDigest`. */
const SUMMARY_FIELDS = ['name', 'code', 'status', 'statusChangedAt', 'createdAt', 'history', 'role', 'defaultRateCents'] as const;

/** A cleaner ID as issued: a Firestore auto ID, which is what a session token can carry. */
const AUTO_ID = /^[A-Za-z0-9]{20}$/;

/** A version 1 code document's ID, and a version 1 cleaner's `codeDigest`: 64 lowercase hex characters. */
const LEGACY_DIGEST = /^[0-9a-f]{64}$/;

/** The one thing logged about a Firestore error on these paths. */
function grpcCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? String(code) : 'unknown';
}

function isAlreadyExists(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === ALREADY_EXISTS;
}

function isSessionEpoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/** A deactivated account whose code was given to someone else: it holds no code now. */
export interface Released {
  id: string;
  name: string | null;
}

/**
 * Whether `code` can be given to `forId` now (Kian's ruling of 2026-10-02:
 * a code is free whenever no active account holds it; of 2026-10-13: never an
 * admin's PIN), from reads inside the caller's transaction. `admin-pin` when
 * an admin holds the digits; `taken` names the active holder; `free` says
 * whether the document exists (then it is overwritten, not created) and
 * which deactivated account, if any, still points at it and must let go.
 */
async function codeAvailability(
  tx: FirebaseFirestore.Transaction,
  db: ReturnType<typeof getAdminDb>,
  code: string,
  forId: string,
): Promise<{ kind: 'admin-pin' } | { kind: 'taken'; holder: string | null } | { kind: 'free'; exists: boolean; holder: { ref: FirebaseFirestore.DocumentReference; fields: Record<string, unknown> } | null }> {
  // An admin's PIN is never a code (Kian's ruling of 2026-10-13, late night).
  if (await adminPinHolds(tx, code)) return { kind: 'admin-pin' };
  const issued = await tx.get(db.collection(CLEANER_CODES_COLLECTION).doc(code));
  if (!issued.exists) return { kind: 'free', exists: false, holder: null };
  if (issued.get('retiredAt') != null) return { kind: 'free', exists: true, holder: null };
  const holderId: unknown = issued.get('cleanerId');
  if (typeof holderId !== 'string' || !isDocumentId(holderId) || holderId === forId) return { kind: 'free', exists: true, holder: null };
  const holderRef = db.collection(CLEANERS_COLLECTION).doc(holderId);
  const holder = await tx.get(holderRef);
  // Gone, or moved on to another code: nobody holds this one.
  if (!holder.exists || holder.get('code') !== code) return { kind: 'free', exists: true, holder: null };
  const name: unknown = holder.get('name');
  if (holder.get('status') === 'active') return { kind: 'taken', holder: typeof name === 'string' ? name : null };
  return { kind: 'free', exists: true, holder: { ref: holderRef, fields: holder.data() ?? {} } };
}

/**
 * Give `code` to `toId` inside the caller's transaction, once codeAvailability
 * said it is free: the code's document written (created, or overwritten when
 * it exists), and a deactivated holder left with no code and a
 * `code_released` event in their history. Returns who let go, for the notice.
 */
function takeCode(
  tx: FirebaseFirestore.Transaction,
  db: ReturnType<typeof getAdminDb>,
  code: string,
  toId: string,
  now: string,
  free: { exists: boolean; holder: { ref: FirebaseFirestore.DocumentReference; fields: Record<string, unknown> } | null },
  actor: Actor,
): Released | null {
  const codeRef = db.collection(CLEANER_CODES_COLLECTION).doc(code);
  if (free.exists) tx.set(codeRef, codeRecord(toId, now));
  else tx.create(codeRef, codeRecord(toId, now));
  if (!free.holder) return null;
  const { ref, fields } = free.holder;
  const history = Array.isArray(fields.history) ? fields.history : [];
  const event: HistoryEvent = { at: now, action: 'code_released', from: code, to: null, actor, reason: 'Given to another team member' };
  tx.update(ref, { code: null, history: [...history, event] });
  const name: unknown = fields.name;
  return { id: ref.id, name: typeof name === 'string' ? name : null };
}

/** A new `cleaner_codes` document. Its ID is the code. */
function codeRecord(cleanerId: string, issuedAt: string) {
  return {
    schemaVersion: CLEANER_CODE_SCHEMA_VERSION,
    cleanerId,
    issuedAt,
    retiredAt: null,
  };
}

/** The cleaner a verified session or a recognised code names. */
export interface SignedInCleaner {
  id: string;
  /** As stored; null if the document's name is not a string. */
  name: string | null;
  sessionEpoch: number;
  /**
   * `cleaner` or `handyman` (dispatch 24), read from the document on this
   * request; `cleaner` when the document has no role. A stored value outside
   * the two is passed through, and opens neither door (requireRole).
   */
  role: string;
}

// ─── List ──────────────────────────────────────────────────────

/**
 * Every cleaner, as list rows with their current codes, newest first.
 *
 * No `orderBy`: Firestore leaves out every document that lacks the ordered
 * field. The collection is read whole and sorted here.
 *
 * @throws if the read fails.
 */
export async function listCleaners(): Promise<CleanerSummary[]> {
  const snapshot = await getAdminDb()
    .collection(CLEANERS_COLLECTION)
    .select(...SUMMARY_FIELDS)
    .get();
  return snapshot.docs.map((doc) => readCleanerSummary(doc.id, doc.data())).sort(newestFirst);
}

// ─── Issue ─────────────────────────────────────────────────────

/**
 * Who typed a code, for their connection's sign-in lock: an ordinary admin's
 * typed code is a try on `connection`; a main admin's is not counted, since
 * main admins see every admin's PIN already and a refusal tells them nothing.
 */
export type CodeTyper = { counted: true; connection: string } | { counted: false };

export type IssueCleanerResult =
  /** Written. The cleaner's code is on `cleaner.code`. `lockedUntil`: this typed code was the try that locked the connection (null: until lifted). */
  | { kind: 'created'; cleaner: CleanerSummary; released: Released | null; lockedUntil?: string | null }
  /** The typed code is an admin's PIN. Counted on the connection. Nothing else was written. */
  | { kind: 'admin-pin' }
  /** Sign-in from this connection is locked, so codes cannot be typed from it (`now`: this try locked it). */
  | { kind: 'locked'; lockedUntil: string | null; now: boolean }
  /** A typed code needs to know who typed it: an ordinary admin's needs their connection, and ADMIN_PIN_KEY to know it. Nothing was read or written. */
  | { kind: 'not-configured' }
  /** No admin PIN to keep codes clear of. Nothing was read or written. */
  | { kind: 'admin-pin-missing' }
  /** The database could not be reached. Nothing was written. */
  | { kind: 'unavailable' }
  /** The typed code is not four digits. Nothing was read or written. */
  | { kind: 'not-a-code' }
  /** The typed code is the admin PIN (ADMIN_PIN). Nothing was read or written. */
  | { kind: 'reserved'; reason: ReservedReason }
  /** The typed code is an active account's now (`holder` is their name). Nothing was written. */
  | { kind: 'taken'; holder: string | null }
  /** Every candidate was reserved, easy or already issued. Nothing was written. */
  | { kind: 'exhausted' }
  /** The write failed in a way that does not say whether it landed. Never retried. */
  | { kind: 'unconfirmed' };

/** A new account's document, holding `code`, as of `now`. */
function newCleaner(name: string, role: CleanerRole, code: string, now: string, actor: Actor) {
  const created: HistoryEvent = {
    at: now,
    action: 'created',
    from: null,
    to: 'active',
    actor,
    reason: null,
  };
  return {
    schemaVersion: CLEANER_SCHEMA_VERSION,
    name,
    role,
    code,
    status: 'active' satisfies CleanerStatus,
    statusChangedAt: now,
    createdAt: now,
    sessionEpoch: 1,
    codeIssuedAt: now,
    history: [created],
  };
}

/**
 * Create a cleaner and issue their code: the four digits the admin typed
 * (dispatch 23H: the code is set at creation), or, when `typed` is null, a
 * code drawn here.
 *
 * `name` must already be validated (NFC, trimmed, 1–80 characters, no control
 * characters). `adminPin` is the admin PIN, passed in by the admin route —
 * one of the few readers of it besides the admin session module. It is only
 * compared against codes.
 *
 * A typed code goes through one transaction that reads an ordinary admin's
 * connection lock first (refused while it holds), then decides: the admin PIN
 * (ADMIN_PIN), an admin's PIN, a code an active account holds — the
 * same refusals as a code change (setCleanerCode) — and counts the try on the
 * connection whatever the answer (Kian's rulings of 2026-10-13, late night). A
 * main admin's is neither held by the lock nor counted (CodeTyper).
 * It then `create()`s the code's document (or takes a retired one over) and
 * the cleaner: all or nothing.
 *
 * A drawn code is written in one transaction too, that reads the digits'
 * admin PIN entry and `create()`s the code's document and the cleaner: all or
 * nothing, and refused outright if the code's document already exists. Of two
 * concurrent issuances of the same code, exactly one wins. A refused candidate
 * wrote nothing, so the next is tried, up to five. Any other failure stops at
 * once: the write may have landed, and retrying could create the cleaner
 * twice.
 */
export async function issueCleaner(
  actor: Actor,
  name: string,
  role: CleanerRole,
  adminPin: string | undefined,
  typed: string | null = null,
  typer: CodeTyper | null = null,
): Promise<IssueCleanerResult> {
  if (!adminPin) return { kind: 'admin-pin-missing' };
  if (typed !== null) {
    if (!CODE_PATTERN.test(typed)) return { kind: 'not-a-code' };
    if (typer === null) return { kind: 'not-configured' };
  }

  let db: ReturnType<typeof getAdminDb>;
  try {
    db = getAdminDb();
  } catch {
    console.error('[cleaners] create failed before any write: the database is not configured');
    return { kind: 'unavailable' };
  }

  if (typed !== null && typer !== null) return issueTyped(db, name, role, typed, actor, adminPin, typer);

  for (let n = 1; n <= MAX_CANDIDATES; n++) {
    const code = generateCandidate();
    if (!isDrawable(code, adminPin)) {
      console.warn(`[cleaners] reserved or easy candidate skipped (candidate ${n}/${MAX_CANDIDATES})`);
      continue;
    }

    const cleanerRef = db.collection(CLEANERS_COLLECTION).doc();
    const now = new Date().toISOString();
    const cleaner = newCleaner(name, role, code, now, actor);

    let written: boolean;
    try {
      written = await db.runTransaction(async (tx) => {
        // An admin's PIN is never drawn (Kian's ruling of 2026-10-13, late night).
        if (await adminPinHolds(tx, code)) return false;
        tx.create(db.collection(CLEANER_CODES_COLLECTION).doc(code), codeRecord(cleanerRef.id, now));
        tx.create(cleanerRef, cleaner);
        return true;
      });
    } catch (err) {
      if (isAlreadyExists(err)) {
        // Refused whole: nothing was written. Draw again.
        console.warn(`[cleaners] code collision (candidate ${n}/${MAX_CANDIDATES})`);
        continue;
      }
      console.error(`[cleaners] create not confirmed: grpc code ${grpcCode(err)}`);
      return { kind: 'unconfirmed' };
    }
    if (!written) {
      console.warn(`[cleaners] admin PIN candidate skipped (candidate ${n}/${MAX_CANDIDATES})`);
      continue;
    }

    return { kind: 'created', cleaner: readCleanerSummary(cleanerRef.id, cleaner), released: null };
  }

  console.error(`[cleaners] no code issued: all ${MAX_CANDIDATES} candidates were reserved, easy or taken`);
  return { kind: 'exhausted' };
}

/**
 * Create a cleaner holding the code the admin typed, in one transaction: an
 * ordinary admin's connection lock first, then the refusals — the admin PIN
 * (ADMIN_PIN), an admin's PIN, a code an active account holds (Kian's
 * ruling of 2026-10-02: a replaced code, a deleted account's or a deactivated
 * account's is taken over) — and their try counted on the connection whatever
 * the answer. A main admin's is not counted (CodeTyper).
 */
async function issueTyped(
  db: ReturnType<typeof getAdminDb>,
  name: string,
  role: CleanerRole,
  code: string,
  actor: Actor,
  adminPin: string,
  typer: CodeTyper,
): Promise<IssueCleanerResult> {
  const cleanerRef = db.collection(CLEANERS_COLLECTION).doc();
  try {
    return await db.runTransaction(async (tx): Promise<IssueCleanerResult> => {
      const nowMs = Date.now();
      const lock = typer.counted ? await readConnectionLock(tx, typer.connection, nowMs) : null;
      if (lock?.holding) return { kind: 'locked', lockedUntil: lock.holding.until, now: false };
      const reason = reservedReason(code, adminPin);
      const available = reason ? null : await codeAvailability(tx, db, code, cleanerRef.id);
      // ── Writes ── An ordinary admin's try counts, whatever the answer.
      const counted = lock ? countTry(tx, lock.ref, lock.lock, nowMs) : null;
      const refusal: IssueCleanerResult | null = reason ? { kind: 'reserved', reason } : available?.kind === 'admin-pin' ? { kind: 'admin-pin' } : available?.kind === 'taken' ? available : null;
      if (refusal) return counted?.kind === 'locked' ? counted : refusal;
      if (!available || available.kind !== 'free') return { kind: 'unconfirmed' };
      const now = new Date(nowMs).toISOString();
      const cleaner = newCleaner(name, role, code, now, actor);
      const released = takeCode(tx, db, code, cleanerRef.id, now, available, actor);
      tx.create(cleanerRef, cleaner);
      return { kind: 'created', cleaner: readCleanerSummary(cleanerRef.id, cleaner), released, ...(counted?.kind === 'locked' ? { lockedUntil: counted.lockedUntil } : {}) };
    });
  } catch (err) {
    // The code's document appeared between the read and the commit: nothing was written.
    if (isAlreadyExists(err)) return { kind: 'taken', holder: null };
    console.error(`[cleaners] create not confirmed: grpc code ${grpcCode(err)}`);
    return { kind: 'unconfirmed' };
  }
}

// ─── Status ────────────────────────────────────────────────────

export type SetCleanerStatusResult =
  /**
   * `changed` is false when the cleaner already had that status: nothing was written. `jobsTakenOff`: the jobs a
   * deactivation took them off, which they were on and had not marked (the cleaning schedule, 2026-10-14). `regular`:
   * the properties whose regular cleaner they were, with what the admin's replacements did (Kian's ruling K4 of
   * 2026-10-19).
   */
  | { kind: 'done'; cleaner: CleanerSummary; changed: boolean; jobsTakenOff: UnmarkedJob[]; regular: RegularReplaced[] }
  /** No cleaner has this ID. */
  | { kind: 'not-found' }
  /** The stored session epoch or history is not in a shape that can be advanced. Nothing was written. */
  | { kind: 'unreadable' }
  /** The transaction failed. */
  | { kind: 'failed' };

/**
 * Deactivate or reactivate a cleaner, in one transaction.
 *
 * A change bumps `sessionEpoch`, so every session token issued before it
 * stops working on the next request — and stays dead after a reactivation,
 * which covers a lost phone. The code itself is untouched: reactivation
 * makes the same code work again.
 *
 * `replacements` (Kian's ruling K4 of 2026-10-19), on a deactivation: for each
 * property they are the regular cleaner for, another active cleaner or null
 * for nobody, applied in the same transaction and recorded in each property's
 * regular-cleaner history. Existing jobs are not changed by it: they come off
 * the jobs they had not marked, as before, and nobody is put on in their place.
 */
export async function setCleanerStatus(
  actor: Actor,
  id: string,
  target: CleanerStatus,
  replacements: RegularReplacements = {},
): Promise<SetCleanerStatusResult> {
  if (!isDocumentId(id)) return { kind: 'not-found' };

  try {
    const db = getAdminDb();
    const ref = db.collection(CLEANERS_COLLECTION).doc(id);

    return await db.runTransaction(async (tx): Promise<SetCleanerStatusResult> => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { kind: 'not-found' };

      const stored = snap.data() ?? {};
      if (stored.status === target) {
        return { kind: 'done', cleaner: readCleanerSummary(id, stored), changed: false, jobsTakenOff: [], regular: [] };
      }

      const epoch: unknown = stored.sessionEpoch;
      const history: unknown = stored.history;
      if (!isSessionEpoch(epoch) || !Array.isArray(history)) return { kind: 'unreadable' };
      // Deactivated, they come off every job they are on and have not marked; a reactivation puts them back on none.
      // Every read before the first write: the jobs, then the regular-cleaner records and the replacements' accounts.
      const jobs = target === 'deactivated' ? await readUnmarkedJobs(tx, id) : [];
      const regular = target === 'deactivated' ? await readRegularReplacements(tx, id, replacements) : null;

      const now = new Date().toISOString();
      const event: HistoryEvent = {
        at: now,
        action: target === 'deactivated' ? 'deactivated' : 'reactivated',
        from: typeof stored.status === 'string' ? stored.status : null,
        to: target,
        actor,
        reason: null,
      };
      const changes = {
        status: target,
        statusChangedAt: now,
        sessionEpoch: epoch + 1,
        history: [...history, event],
      };

      tx.update(ref, changes);
      const jobsTakenOff = takeOffJobs(tx, jobs, id, actor, 'deactivated', now);
      const replaced = regular ? regular.apply(actor, 'deactivated', now) : [];
      return { kind: 'done', cleaner: readCleanerSummary(id, { ...stored, ...changes }), changed: true, jobsTakenOff, regular: replaced };
    });
  } catch (err) {
    console.error(`[cleaners] status change failed: grpc code ${grpcCode(err)}`);
    return { kind: 'failed' };
  }
}

// ─── Default rate (dispatch 37B) ───────────────────────────────

export type SetDefaultRateResult =
  /** `changed` is false when the cleaner already had this rate: nothing was written. */
  | { kind: 'done'; cleaner: CleanerSummary; changed: boolean }
  | { kind: 'not-found' }
  /** A handyman logs work, not cleanings: no rate. */
  | { kind: 'not-a-cleaner' }
  | { kind: 'unreadable' }
  | { kind: 'failed' };

export const RATE_REFUSALS: Record<Exclude<SetDefaultRateResult['kind'], 'done'>, Refusal> = {
  'not-found': { status: 404, code: 'CLEANER_NOT_FOUND', message: 'No such cleaner.', hint: 'Nothing was saved. Reload the page.' },
  'not-a-cleaner': { status: 422, code: 'NOT_A_CLEANER', message: 'A handyman logs work, not cleanings, and has no cleaning rate.', hint: 'Nothing was saved.' },
  unreadable: { status: 500, code: 'CLEANER_UNREADABLE', message: 'This cleaner’s stored record is not in the shape a change needs.', hint: 'Nothing was saved.' },
  failed: { status: 502, code: 'CLEANER_SAVE_FAILED', message: 'Could not save the rate.', hint: 'It may or may not have been saved. Reload to see the stored rate.' },
};

/** "$60.00", or "none". */
const rateWords = (cents: number | null) => (cents === null ? 'none' : `$${(cents / 100).toFixed(2)}`);

/**
 * Set the account's default rate, or clear it (Kian's ruling of 2026-10-13: one default rate per cleaner). Retired by
 * Kian's ruling of 2026-10-19 (cleaning prices are presets per property): nothing reads the rate any more and no page
 * calls this; it stays for the unused route. One transaction: the rate and a history event saying what it was and what
 * it is. No cleaning already logged changes: each keeps the amount it was logged with.
 */
export async function setCleanerDefaultRate(actor: Actor, id: string, cents: number | null): Promise<SetDefaultRateResult> {
  if (!isDocumentId(id)) return { kind: 'not-found' };
  try {
    const db = getAdminDb();
    const ref = db.collection(CLEANERS_COLLECTION).doc(id);
    return await db.runTransaction(async (tx): Promise<SetDefaultRateResult> => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { kind: 'not-found' };
      const stored = snap.data() ?? {};
      if (roleOf(stored) !== 'cleaner') return { kind: 'not-a-cleaner' };
      const was = readCleanerSummary(id, stored).defaultRateCents;
      if (was === cents) return { kind: 'done', cleaner: readCleanerSummary(id, stored), changed: false };
      const history: unknown = stored.history;
      if (!Array.isArray(history)) return { kind: 'unreadable' };
      const event: HistoryEvent = { at: new Date().toISOString(), action: 'rate_set', from: null, to: null, actor, reason: `Default cleaning rate ${rateWords(cents)} (was ${rateWords(was)})` };
      const changes = { defaultRateCents: cents, history: [...history, event] };
      tx.update(ref, changes);
      return { kind: 'done', cleaner: readCleanerSummary(id, { ...stored, ...changes }), changed: true };
    });
  } catch (err) {
    console.error(`[cleaners] rate change failed: grpc code ${grpcCode(err)}`);
    return { kind: 'failed' };
  }
}

// ─── Code ──────────────────────────────────────────────────────

/** A cleaner's new code: four digits the admin typed, or one drawn here. */
export type NewCode = { kind: 'typed'; code: string } | { kind: 'generate' };

export type SetCleanerCodeResult =
  /** `changed` is false when the typed code already was theirs: nothing was written. `released`: a deactivated account that held the code and let it go. */
  | { kind: 'done'; cleaner: CleanerSummary; changed: boolean; released: Released | null; lockedUntil?: string | null }
  /** The typed code is an admin's PIN. Counted on the connection. Nothing else was written. */
  | { kind: 'admin-pin' }
  /** Sign-in from this connection is locked, so codes cannot be typed from it (`now`: this try locked it). */
  | { kind: 'locked'; lockedUntil: string | null; now: boolean }
  /** A typed code needs the connection, and ADMIN_PIN_KEY to know it. Nothing was read or written. */
  | { kind: 'not-configured' }
  /** No cleaner has this ID. */
  | { kind: 'not-found' }
  /** The typed code is not four digits. Nothing was read or written. */
  | { kind: 'not-a-code' }
  /** No admin PIN to keep codes clear of. Nothing was read or written. */
  | { kind: 'admin-pin-missing' }
  /** The typed code is the admin PIN (ADMIN_PIN). Nothing was read or written. */
  | { kind: 'reserved'; reason: ReservedReason }
  /** The typed code is an active account's now (`holder` is their name). Nothing was written. */
  | { kind: 'taken'; holder: string | null }
  /** Every candidate drawn was reserved, easy or taken. Nothing was written. */
  | { kind: 'exhausted' }
  /** The stored session epoch or history is not in a shape that can be advanced. Nothing was written. */
  | { kind: 'unreadable' }
  /** The transaction failed: it may or may not have landed. */
  | { kind: 'failed' };

/**
 * Give a cleaner a new code, typed by the admin or drawn here.
 *
 * Refused before anything is read: a code that is the admin PIN (ADMIN_PIN).
 * An easy code is not refused (Kian's ruling of 2026-10-17: cleaner and
 * handyman codes may be easy codes). Refused by the transaction: an admin's
 * PIN, and a code an active account holds now (Kian's ruling of 2026-10-02:
 * any other code is free — replaced, a deleted account's, or a deactivated
 * account's, who then has none).
 *
 * One transaction, all or nothing: it writes the new code's document,
 * marks the old one retired (kept, so the record says whose it was), and
 * points the cleaner at the new code. The cleaner keeps their ID, name,
 * status and history, and every entry keeps its attribution: entries name
 * the cleaner, never the code.
 *
 * The old code stops working at once: sign-in needs the cleaner to point at
 * the code. The change also bumps `sessionEpoch`, so a phone signed in with
 * the old code is signed out on its next request, as after a deactivation.
 *
 * A generated code is drawn like an issued one, up to five candidates; a
 * candidate that is reserved, easy, taken, or the cleaner's own code is
 * skipped.
 */
export async function setCleanerCode(
  actor: Actor,
  id: string,
  request: NewCode,
  adminPin: string | undefined,
  typer: CodeTyper | null = null,
): Promise<SetCleanerCodeResult> {
  if (!isDocumentId(id)) return { kind: 'not-found' };
  if (!adminPin) return { kind: 'admin-pin-missing' };

  if (request.kind === 'typed') {
    if (!CODE_PATTERN.test(request.code)) return { kind: 'not-a-code' };
    if (typer === null) return { kind: 'not-configured' };
    return writeCode(actor, id, request.code, { kind: 'typed', adminPin, typer });
  }

  for (let n = 1; n <= MAX_CANDIDATES; n++) {
    const code = generateCandidate();
    if (!isDrawable(code, adminPin)) {
      console.warn(`[cleaners] reserved or easy candidate skipped (candidate ${n}/${MAX_CANDIDATES})`);
      continue;
    }
    const result = await writeCode(actor, id, code, { kind: 'drawn' });
    if (result.kind !== 'taken' && result.kind !== 'admin-pin') return result;
    console.warn(`[cleaners] code collision (candidate ${n}/${MAX_CANDIDATES})`);
  }

  console.error(`[cleaners] no code generated: all ${MAX_CANDIDATES} candidates were reserved, easy or taken`);
  return { kind: 'exhausted' };
}

/**
 * One attempt to point a cleaner at `code`, in a transaction. A typed code
 * reads the admin's connection lock first, is refused while it holds, and is
 * counted on it whatever the answer, its own current code aside (Kian's
 * rulings of 2026-10-13, late night).
 */
async function writeCode(
  actor: Actor,
  id: string,
  code: string,
  how: { kind: 'typed'; adminPin: string; typer: CodeTyper } | { kind: 'drawn' },
): Promise<SetCleanerCodeResult> {
  const source = how.kind;
  try {
    const db = getAdminDb();
    const codes = db.collection(CLEANER_CODES_COLLECTION);
    const cleanerRef = db.collection(CLEANERS_COLLECTION).doc(id);

    return await db.runTransaction(async (tx): Promise<SetCleanerCodeResult> => {
      // Every read comes before the first write, as a transaction requires.
      const nowMs = Date.now();
      const lock = how.kind === 'typed' && how.typer.counted ? await readConnectionLock(tx, how.typer.connection, nowMs) : null;
      if (lock?.holding) return { kind: 'locked', lockedUntil: lock.holding.until, now: false };
      const snap = await tx.get(cleanerRef);
      if (!snap.exists) return { kind: 'not-found' };
      const stored = snap.data() ?? {};

      const current =
        typeof stored.code === 'string' && CODE_PATTERN.test(stored.code) ? stored.code : null;
      if (current === code) {
        // Typed: the admin asked for the code the cleaner already has.
        // Drawn: a new code was wanted, so this candidate counts as taken.
        return source === 'typed'
          ? { kind: 'done', cleaner: readCleanerSummary(id, stored), changed: false, released: null }
          : { kind: 'taken', holder: null };
      }

      const epoch: unknown = stored.sessionEpoch;
      const history: unknown = stored.history;
      if (!isSessionEpoch(epoch) || !Array.isArray(history)) return { kind: 'unreadable' };

      const reason = how.kind === 'typed' ? reservedReason(code, how.adminPin) : null;
      const available = reason ? null : await codeAvailability(tx, db, code, id);

      // The document of the code being replaced: the current code's, or on a
      // version 1 cleaner the digest document their code was stored as.
      const legacyDigest =
        typeof stored.codeDigest === 'string' && LEGACY_DIGEST.test(stored.codeDigest)
          ? stored.codeDigest
          : null;
      const oldRef =
        current !== null ? codes.doc(current) : legacyDigest !== null ? codes.doc(legacyDigest) : null;
      const old = oldRef ? await tx.get(oldRef) : null;

      // ── Writes ── An ordinary admin's typed code is a try on their connection, whatever the answer.
      const counted = lock ? countTry(tx, lock.ref, lock.lock, nowMs) : null;
      const refusal: SetCleanerCodeResult | null = reason ? { kind: 'reserved', reason } : available?.kind === 'admin-pin' ? { kind: 'admin-pin' } : available?.kind === 'taken' ? available : null;
      if (refusal) return counted?.kind === 'locked' ? counted : refusal;
      if (!available || available.kind !== 'free') return { kind: 'failed' };

      const now = new Date(nowMs).toISOString();
      const event: HistoryEvent = {
        at: now,
        action: 'code_changed',
        from: current,
        to: code,
        actor,
        reason: null,
      };
      const changes = {
        code,
        codeIssuedAt: now,
        sessionEpoch: epoch + 1,
        history: [...history, event],
      };

      const released = takeCode(tx, db, code, id, now, available, actor);
      // Retired, kept: the record says whose it was; it is free to reuse from now on.
      if (oldRef && old?.exists && old.get('cleanerId') === id && old.get('retiredAt') === null) {
        tx.update(oldRef, { retiredAt: now });
      }
      tx.update(cleanerRef, changes);
      return { kind: 'done', cleaner: readCleanerSummary(id, { ...stored, ...changes }), changed: true, released, ...(counted?.kind === 'locked' ? { lockedUntil: counted.lockedUntil } : {}) };
    });
  } catch (err) {
    // The new code's document appeared between the read and the commit.
    if (isAlreadyExists(err)) return { kind: 'taken', holder: null };
    console.error(`[cleaners] code change failed: grpc code ${grpcCode(err)}`);
    return { kind: 'failed' };
  }
}

// ─── Delete ────────────────────────────────────────────────────

export type DeleteCleanerResult =
  /** The account is gone; `codes` is how many of its code documents were retired (current and replaced); `jobsTakenOff` the jobs it was on and had not marked; `regular` what the admin's replacements did (Kian's ruling K4). */
  | { kind: 'deleted'; cleaner: CleanerSummary; codes: number; jobsTakenOff: UnmarkedJob[]; regular: RegularReplaced[] }
  /** No cleaner has this ID. */
  | { kind: 'not-found' }
  /**
   * Their balance is not zero, or cannot be worked out (records of theirs not in shape, entries that cannot add up),
   * or something of theirs is not counted yet — a cleaning with no amount, a receipt or work waiting for review (Kian's
   * rulings of 2026-10-15 and K3 of 2026-10-19): they cannot be deleted; deactivate them instead. The refusal's words
   * are the page's (pay/checks.ts). Nothing was written.
   */
  | { kind: 'cannot-delete'; refusal: DeleteRefusal; balanceCents: number; noAmount: number; waitingReview: number; uncertain: number; name: string | null }
  /** The transaction failed: it may or may not have landed. */
  | { kind: 'failed' };

export const DELETE_CLEANER_REFUSALS: Record<Exclude<DeleteCleanerResult['kind'], 'deleted' | 'cannot-delete'>, Refusal> = {
  'not-found': {
    status: 404,
    code: 'CLEANER_NOT_FOUND',
    message: 'Team member not found',
    hint: 'They may already have been deleted. Reload the list.',
  },
  failed: {
    status: 502,
    code: 'CLEANER_DELETE_FAILED',
    message: 'Could not delete the team member.',
    hint: 'They may or may not have been deleted. Reload the list to see.',
  },
};

/**
 * Delete a cleaner or a handyman for good (Kian's ruling of 2026-10-02): one
 * transaction deletes the account's document and retires every `cleaner_codes`
 * document pointing at it — the current code and any replaced before — so
 * the record says whose they were; each is free to give out again (Kian's
 * ruling of 2026-10-02: a code is free whenever no active account holds it).
 * A session the person still holds names a document that no longer exists,
 * so it ends on its next request (readSessionCleaner).
 *
 * Their cost entries are not touched: each keeps `cleanerId` and the name
 * it was logged under, and stays in its ledger, its statements and the
 * review queue. The readings and one-time-key records beside those entries
 * belong to the entries and stay with them.
 *
 * Returns the account as it was, for the page's notice. The code documents
 * are counted, never listed: a code never leaves this module but through the
 * list and the create.
 *
 * `replacements` (Kian's ruling K4 of 2026-10-19): for each property they are
 * the regular cleaner for, another active cleaner or null for nobody, applied
 * in the same transaction and recorded in each property's regular-cleaner
 * history. Existing jobs are not changed by it.
 */
export async function deleteCleaner(actor: Actor, id: string, replacements: RegularReplacements = {}): Promise<DeleteCleanerResult> {
  if (!isDocumentId(id)) return { kind: 'not-found' };

  try {
    const db = getAdminDb();
    const ref = db.collection(CLEANERS_COLLECTION).doc(id);
    const codes = db.collection(CLEANER_CODES_COLLECTION).where('cleanerId', '==', id);

    return await db.runTransaction(async (tx): Promise<DeleteCleanerResult> => {
      const [snap, theirs] = await Promise.all([tx.get(ref), tx.get(codes)]);
      if (!snap.exists) return { kind: 'not-found' };
      // A team member whose balance is not zero is never deleted (Kian's ruling of 2026-10-15), nor one with a cleaning
      // with no amount or a receipt or work not yet decided (Kian's ruling K3 of 2026-10-19): worked out by the one
      // function, from their cleanings, entries and payments read in this transaction, refused in the page's words.
      const { sources, unreadable } = await memberPaySources(id, tx);
      const pay = memberPay(id, sources);
      const name = fieldText(snap.get('name'));
      const refusal = deleteRefusal(pay, unreadable, name);
      if (refusal) return { kind: 'cannot-delete', refusal, balanceCents: pay.balanceCents, noAmount: pay.noAmount, waitingReview: pay.waitingReview, uncertain: pay.cannotAddUp + unreadable, name };
      // The jobs they are on and have not marked: they come off them, in this transaction (the cleaning schedule). Then
      // the regular-cleaner records and the replacements' accounts: every read before the first write.
      const jobs = await readUnmarkedJobs(tx, id);
      const regular = await readRegularReplacements(tx, id, replacements);
      const stored = snap.data() ?? {};
      const now = new Date().toISOString();
      // Only a code document that is theirs is touched, and only its retirement is written.
      const mine = theirs.docs.filter((doc) => doc.get('cleanerId') === id);
      for (const doc of mine) {
        if (doc.get('retiredAt') == null) tx.update(doc.ref, { retiredAt: now });
      }
      tx.delete(ref);
      const jobsTakenOff = takeOffJobs(tx, jobs, id, actor, 'deleted', now);
      const replaced = regular.apply(actor, 'deleted', now);
      return { kind: 'deleted', cleaner: readCleanerSummary(id, stored), codes: mine.length, jobsTakenOff, regular: replaced };
    });
  } catch (err) {
    console.error(`[cleaners] delete failed: grpc code ${grpcCode(err)}`);
    return { kind: 'failed' };
  }
}

// ─── The cleaner door's lock (2026-10-14, evening) ─────────────

/** A lock's ID: the keyed hash of a connection (lock.ts). */
const LOCK_ID = /^[0-9a-f]{64}$/;

export type CleanerSignInResult =
  | { kind: 'found'; cleaner: SignedInCleaner }
  /** No active cleaner holds this code; `triesLeft` before this connection's lock (`untilLifted`: the day's twentieth). */
  | { kind: 'not-recognised'; triesLeft: number; untilLifted: boolean }
  /** Sign-in from this connection is locked until `lockedUntil` (null: until an admin lifts it); `now` when this code locked it. */
  | { kind: 'locked'; lockedUntil: string | null; now: boolean }
  | { kind: 'unavailable' };

/** A wrong code counted against the connection, inside the transaction: the admin door's rule (admins/model.ts, afterTry). */
function countWrongCode(tx: Transaction, lockRef: DocumentReference, lock: LockState, nowMs: number): CleanerSignInResult {
  const outcome = afterTry(lock, false, nowMs);
  tx.set(lockRef, { ...outcome.next, lastFailedAt: new Date(nowMs).toISOString() });
  if (outcome.kind === 'capped-now') {
    console.log(`[cleaner-session] a connection reached ${DAILY_TRIES} wrong codes in a Toronto day: locked until an admin lifts it`);
    return { kind: 'locked', lockedUntil: null, now: true };
  }
  if (outcome.kind === 'locked-now') {
    console.log(`[cleaner-session] sign-in locked after ${MAX_WRONG_TRIES} wrong codes in a row from one connection, until ${outcome.lockedUntil}`);
    return { kind: 'locked', lockedUntil: outcome.lockedUntil, now: true };
  }
  return outcome.kind === 'wrong' ? { kind: 'not-recognised', triesLeft: outcome.triesLeft, untilLifted: outcome.untilLifted } : { kind: 'not-recognised', triesLeft: 0, untilLifted: false };
}

/**
 * Sign a cleaner in by their code, with the cleaner door's lock (Kian's ruling of 2026-10-14, evening: the admin
 * door's lock). A locked connection is refused before anything else is read. Otherwise the code's document, then the
 * cleaner it names: the code must not be retired, and the cleaner must be active, still hold this code and have a
 * session epoch a token can carry — a version 1 code, stored as a digest, is never found. A code that opens nothing,
 * whichever check it fails, gets the one answer and counts against the connection:
 * the fifth in a row locks it for fifteen minutes, the twentieth in a Toronto day until an admin lifts it from the
 * Team page. A right code clears the tries in a row, not the day's.
 *
 * Reads: one when locked; otherwise the lock twice (before and inside the transaction), the code, and on a hit the
 * cleaner. The caller has already refused, with no read, a code that is not four digits: it is no guess and is not
 * counted. Never throws: a failed read is `unavailable`, and access is never granted on an error.
 */
export async function signInCleaner(code: string, connection: string, nowMs: number = Date.now()): Promise<CleanerSignInResult> {
  if (!CODE_PATTERN.test(code) || !LOCK_ID.test(connection)) return { kind: 'unavailable' };
  try {
    const db = getAdminDb();
    const lockRef = db.collection(CLEANER_SIGNIN_LOCKS_COLLECTION).doc(connection);
    const before = await lockRef.get();
    const holding = before.exists ? lockHolding(lockStateOf(before.data()), nowMs) : null;
    if (holding) return { kind: 'locked', lockedUntil: holding.until, now: false };

    return await db.runTransaction(async (tx): Promise<CleanerSignInResult> => {
      const lockSnap = await tx.get(lockRef);
      const lock = lockStateOf(lockSnap.data());
      const locked = lockHolding(lock, nowMs);
      if (locked) return { kind: 'locked', lockedUntil: locked.until, now: false };

      let found: SignedInCleaner | null = null;
      const [codeDoc] = await tx.getAll(db.collection(CLEANER_CODES_COLLECTION).doc(code), { fieldMask: ['cleanerId', 'retiredAt'] });
      const cleanerId: unknown = codeDoc.exists && codeDoc.get('retiredAt') === null ? codeDoc.get('cleanerId') : null;
      if (typeof cleanerId === 'string' && AUTO_ID.test(cleanerId)) {
        const [cleaner] = await tx.getAll(db.collection(CLEANERS_COLLECTION).doc(cleanerId), { fieldMask: ['name', 'status', 'code', 'sessionEpoch', 'role'] });
        const epoch: unknown = cleaner.get('sessionEpoch');
        if (cleaner.exists && cleaner.get('status') === 'active' && cleaner.get('code') === code && isSessionEpoch(epoch) && epoch <= MAX_TOKEN_EPOCH) {
          const name: unknown = cleaner.get('name');
          found = { id: cleanerId, name: typeof name === 'string' ? name : null, sessionEpoch: epoch, role: roleOf(cleaner.data() ?? {}) };
        }
      }
      if (!found) return countWrongCode(tx, lockRef, lock, nowMs);
      // A right code: the tries in a row cleared, the Toronto day's kept (they count toward its twenty).
      if (lockSnap.exists) {
        const right = afterTry(lock, true, nowMs);
        if (right.next.dayTries > 0) tx.update(lockRef, { failedTries: 0, lockedUntil: null });
        else tx.delete(lockRef);
      }
      return { kind: 'found', cleaner: found };
    });
  } catch (err) {
    console.error(`[cleaner-session] sign-in failed: grpc code ${grpcCode(err)}`);
    return { kind: 'unavailable' };
  }
}

/** The cleaner door's locks holding now, for the Team page: until lifted first, then the latest-ending. THROWS when a read fails. */
export async function listCleanerSignInLocks(nowMs: number = Date.now()): Promise<SignInLockView[]> {
  const locks = getAdminDb().collection(CLEANER_SIGNIN_LOCKS_COLLECTION);
  const [timed, capped] = await Promise.all([locks.where('lockedUntil', '>', new Date(nowMs).toISOString()).get(), locks.where('capped', '==', true).get()]);
  const text = (value: unknown) => (typeof value === 'string' ? value : null);
  const views = new Map<string, SignInLockView>();
  for (const doc of capped.docs) views.set(doc.id, { id: doc.id, lockedUntil: null, capped: true, lastFailedAt: text(doc.get('lastFailedAt')) });
  for (const doc of timed.docs) if (!views.has(doc.id)) views.set(doc.id, { id: doc.id, lockedUntil: String(doc.get('lockedUntil')), capped: false, lastFailedAt: text(doc.get('lastFailedAt')) });
  return [...views.values()].sort((a, b) => Number(b.capped) - Number(a.capped) || (b.lockedUntil ?? '').localeCompare(a.lockedUntil ?? ''));
}

/** Lift a connection's cleaner lock, and its count, before its time (any admin, on the Team page). */
export async function liftCleanerSignInLock(lockId: string): Promise<{ kind: 'lifted' } | { kind: 'not-found' } | { kind: 'failed' }> {
  if (!LOCK_ID.test(lockId)) return { kind: 'not-found' };
  try {
    const db = getAdminDb();
    const ref = db.collection(CLEANER_SIGNIN_LOCKS_COLLECTION).doc(lockId);
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { kind: 'not-found' as const };
      tx.delete(ref);
      return { kind: 'lifted' as const };
    });
  } catch (err) {
    console.error(`[cleaners] lifting a sign-in lock failed: grpc code ${grpcCode(err)}`);
    return { kind: 'failed' };
  }
}

// ─── Sign-in ───────────────────────────────────────────────────


export type SessionCleanerRead =
  | { kind: 'valid'; cleaner: SignedInCleaner }
  /** No such cleaner, not active, or signed in before their last status or code change. */
  | { kind: 'invalid' }
  /** The read failed. Access is never granted on an error. */
  | { kind: 'unavailable' };

/**
 * The cleaner a session token names, if the token is still good for them:
 * one read, of the fields it needs, never cached. The token's MAC and age are
 * checked by the caller before this runs.
 */
export async function readSessionCleaner(
  cleanerId: string,
  sessionEpoch: number,
): Promise<SessionCleanerRead> {
  if (!isDocumentId(cleanerId)) return { kind: 'invalid' };

  try {
    const db = getAdminDb();
    const [cleaner] = await db.getAll(db.collection(CLEANERS_COLLECTION).doc(cleanerId), {
      fieldMask: ['name', 'status', 'sessionEpoch', 'role'],
    });
    if (
      !cleaner.exists ||
      cleaner.get('status') !== 'active' ||
      cleaner.get('sessionEpoch') !== sessionEpoch
    ) {
      return { kind: 'invalid' };
    }

    const name: unknown = cleaner.get('name');
    return {
      kind: 'valid',
      cleaner: { id: cleanerId, name: typeof name === 'string' ? name : null, sessionEpoch, role: roleOf(cleaner.data() ?? {}) },
    };
  } catch (err) {
    console.error(`[cleaner-session] session check failed: grpc code ${grpcCode(err)}`);
    return { kind: 'unavailable' };
  }
}
