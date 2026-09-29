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
 * `create()` of that document is what keeps codes unique — of two writes of
 * the same code, exactly one lands — and code documents are never deleted,
 * so a code that has been replaced stays reserved and is never given to
 * anyone else. Sign-in needs both: the code's document, not retired, and a
 * cleaner who still points at that code.
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
 * Nothing here overwrites or removes a document. History is appended by
 * reading the array and writing it back inside the transaction — never with
 * arrayUnion, which drops an event identical to one already there.
 *
 * Failure contract, as in server-leads.ts: listCleaners THROWS when the read
 * fails; it never returns an empty list. The other functions return a
 * result naming what happened, "not confirmed" included, and never throw.
 */

import { getAdminDb } from './admin';
import { isDocumentId } from './server-leads';
import { generateCandidate, reservedReason, type ReservedReason } from '@/app/lib/cleaners/codes';
import {
  ADMIN_ACTOR,
  CLEANERS_COLLECTION,
  CLEANER_CODES_COLLECTION,
  CLEANER_CODE_SCHEMA_VERSION,
  CLEANER_SCHEMA_VERSION,
  CODE_PATTERN,
  newestFirst,
  readCleanerSummary,
  type CleanerStatus,
  type CleanerSummary,
  type HistoryEvent,
} from '@/app/lib/cleaners/model';

/** gRPC status code Firestore reports when `create()` targets a document that exists. */
const ALREADY_EXISTS = 6;

/** Candidates drawn per issuance, or per generated code, before giving up. */
const MAX_CANDIDATES = 5;

/** The largest epoch a session token can carry (nine digits). */
const MAX_TOKEN_EPOCH = 999_999_999;

/** The only fields that leave Firestore for the list. Never `sessionEpoch` or `codeDigest`. */
const SUMMARY_FIELDS = ['name', 'code', 'status', 'statusChangedAt', 'createdAt', 'history'] as const;

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

export type IssueCleanerResult =
  /** Written. The cleaner's code is on `cleaner.code`. */
  | { kind: 'created'; cleaner: CleanerSummary }
  /** No admin PIN to keep codes clear of. Nothing was read or written. */
  | { kind: 'admin-pin-missing' }
  /** The database could not be reached. Nothing was written. */
  | { kind: 'unavailable' }
  /** Every candidate was reserved or already issued. Nothing was written. */
  | { kind: 'exhausted' }
  /** The write failed in a way that does not say whether it landed. Never retried. */
  | { kind: 'unconfirmed' };

/**
 * Create a cleaner and issue their code.
 *
 * `name` must already be validated (NFC, trimmed, 1–80 characters, no control
 * characters). `adminPin` is the admin PIN, passed in by the admin route —
 * one of the few readers of it besides the admin session module. It is only
 * compared against candidates.
 *
 * The cleaner and their code document are written in one batch of two
 * `create()` calls: all or nothing, and refused outright if the code's
 * document already exists. Of two concurrent issuances of the same code,
 * exactly one wins. A refused candidate wrote nothing, so the next is tried,
 * up to five. Any other failure stops at once: the batch may have landed,
 * and retrying could create the cleaner twice.
 */
export async function issueCleaner(
  name: string,
  adminPin: string | undefined,
): Promise<IssueCleanerResult> {
  if (!adminPin) return { kind: 'admin-pin-missing' };

  let db: ReturnType<typeof getAdminDb>;
  try {
    db = getAdminDb();
  } catch {
    console.error('[cleaners] create failed before any write: the database is not configured');
    return { kind: 'unavailable' };
  }

  for (let n = 1; n <= MAX_CANDIDATES; n++) {
    const code = generateCandidate();
    if (reservedReason(code, adminPin)) {
      console.warn(`[cleaners] reserved candidate skipped (candidate ${n}/${MAX_CANDIDATES})`);
      continue;
    }

    const cleanerRef = db.collection(CLEANERS_COLLECTION).doc();
    const now = new Date().toISOString();

    const created: HistoryEvent = {
      at: now,
      action: 'created',
      from: null,
      to: 'active',
      actor: ADMIN_ACTOR,
      reason: null,
    };
    const cleaner = {
      schemaVersion: CLEANER_SCHEMA_VERSION,
      name,
      code,
      status: 'active' satisfies CleanerStatus,
      statusChangedAt: now,
      createdAt: now,
      sessionEpoch: 1,
      codeIssuedAt: now,
      history: [created],
    };

    try {
      await db
        .batch()
        .create(db.collection(CLEANER_CODES_COLLECTION).doc(code), codeRecord(cleanerRef.id, now))
        .create(cleanerRef, cleaner)
        .commit();
    } catch (err) {
      if (isAlreadyExists(err)) {
        // Refused whole: nothing was written. Draw again.
        console.warn(`[cleaners] code collision (candidate ${n}/${MAX_CANDIDATES})`);
        continue;
      }
      console.error(`[cleaners] create not confirmed: grpc code ${grpcCode(err)}`);
      return { kind: 'unconfirmed' };
    }

    return { kind: 'created', cleaner: readCleanerSummary(cleanerRef.id, cleaner) };
  }

  console.error(`[cleaners] no code issued: all ${MAX_CANDIDATES} candidates were reserved or taken`);
  return { kind: 'exhausted' };
}

// ─── Status ────────────────────────────────────────────────────

export type SetCleanerStatusResult =
  /** `changed` is false when the cleaner already had that status: nothing was written. */
  | { kind: 'done'; cleaner: CleanerSummary; changed: boolean }
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
 */
export async function setCleanerStatus(
  id: string,
  target: CleanerStatus,
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
        return { kind: 'done', cleaner: readCleanerSummary(id, stored), changed: false };
      }

      const epoch: unknown = stored.sessionEpoch;
      const history: unknown = stored.history;
      if (!isSessionEpoch(epoch) || !Array.isArray(history)) return { kind: 'unreadable' };

      const now = new Date().toISOString();
      const event: HistoryEvent = {
        at: now,
        action: target === 'deactivated' ? 'deactivated' : 'reactivated',
        from: typeof stored.status === 'string' ? stored.status : null,
        to: target,
        actor: ADMIN_ACTOR,
        reason: null,
      };
      const changes = {
        status: target,
        statusChangedAt: now,
        sessionEpoch: epoch + 1,
        history: [...history, event],
      };

      tx.update(ref, changes);
      return { kind: 'done', cleaner: readCleanerSummary(id, { ...stored, ...changes }), changed: true };
    });
  } catch (err) {
    console.error(`[cleaners] status change failed: grpc code ${grpcCode(err)}`);
    return { kind: 'failed' };
  }
}

// ─── Code ──────────────────────────────────────────────────────

/** A cleaner's new code: four digits the admin typed, or one drawn here. */
export type NewCode = { kind: 'typed'; code: string } | { kind: 'generate' };

export type SetCleanerCodeResult =
  /** `changed` is false when the typed code already was theirs: nothing was written. */
  | { kind: 'done'; cleaner: CleanerSummary; changed: boolean }
  /** No cleaner has this ID. */
  | { kind: 'not-found' }
  /** The typed code is not four digits. Nothing was read or written. */
  | { kind: 'not-a-code' }
  /** No admin PIN to keep codes clear of. Nothing was read or written. */
  | { kind: 'admin-pin-missing' }
  /** The typed code is the admin PIN, or on the reserved list. Nothing was read or written. */
  | { kind: 'reserved'; reason: ReservedReason }
  /** The typed code is issued already: another cleaner's now, or anyone's before. Nothing was written. */
  | { kind: 'taken'; retired: boolean }
  /** Every candidate drawn was reserved or taken. Nothing was written. */
  | { kind: 'exhausted' }
  /** The stored session epoch or history is not in a shape that can be advanced. Nothing was written. */
  | { kind: 'unreadable' }
  /** The transaction failed: it may or may not have landed. */
  | { kind: 'failed' };

/**
 * Give a cleaner a new code, typed by the admin or drawn here.
 *
 * Refused before anything is read: a code that is the admin PIN or on the
 * reserved list. Refused by the transaction: a code already issued, whether
 * it is another cleaner's now or was anyone's before — replaced codes are
 * never given out again.
 *
 * One transaction, all or nothing: it creates the new code's document,
 * marks the old one retired (never deleting it, so it stays reserved), and
 * points the cleaner at the new code. The cleaner keeps their ID, name,
 * status and history, and every entry keeps its attribution: entries name
 * the cleaner, never the code.
 *
 * The old code stops working at once: sign-in needs the cleaner to point at
 * the code. The change also bumps `sessionEpoch`, so a phone signed in with
 * the old code is signed out on its next request, as after a deactivation.
 *
 * A generated code is drawn like an issued one, up to five candidates; a
 * candidate that is reserved, taken, or the cleaner's own code is skipped.
 */
export async function setCleanerCode(
  id: string,
  request: NewCode,
  adminPin: string | undefined,
): Promise<SetCleanerCodeResult> {
  if (!isDocumentId(id)) return { kind: 'not-found' };
  if (!adminPin) return { kind: 'admin-pin-missing' };

  if (request.kind === 'typed') {
    if (!CODE_PATTERN.test(request.code)) return { kind: 'not-a-code' };
    const reason = reservedReason(request.code, adminPin);
    if (reason) return { kind: 'reserved', reason };
    return writeCode(id, request.code, 'typed');
  }

  for (let n = 1; n <= MAX_CANDIDATES; n++) {
    const code = generateCandidate();
    if (reservedReason(code, adminPin)) {
      console.warn(`[cleaners] reserved candidate skipped (candidate ${n}/${MAX_CANDIDATES})`);
      continue;
    }
    const result = await writeCode(id, code, 'drawn');
    if (result.kind !== 'taken') return result;
    console.warn(`[cleaners] code collision (candidate ${n}/${MAX_CANDIDATES})`);
  }

  console.error(`[cleaners] no code generated: all ${MAX_CANDIDATES} candidates were reserved or taken`);
  return { kind: 'exhausted' };
}

/** One attempt to point a cleaner at `code`, in a transaction. */
async function writeCode(
  id: string,
  code: string,
  source: 'typed' | 'drawn',
): Promise<SetCleanerCodeResult> {
  try {
    const db = getAdminDb();
    const codes = db.collection(CLEANER_CODES_COLLECTION);
    const cleanerRef = db.collection(CLEANERS_COLLECTION).doc(id);

    return await db.runTransaction(async (tx): Promise<SetCleanerCodeResult> => {
      // Every read comes before the first write, as a transaction requires.
      const snap = await tx.get(cleanerRef);
      if (!snap.exists) return { kind: 'not-found' };
      const stored = snap.data() ?? {};

      const current =
        typeof stored.code === 'string' && CODE_PATTERN.test(stored.code) ? stored.code : null;
      if (current === code) {
        // Typed: the admin asked for the code the cleaner already has.
        // Drawn: a new code was wanted, so this candidate counts as taken.
        return source === 'typed'
          ? { kind: 'done', cleaner: readCleanerSummary(id, stored), changed: false }
          : { kind: 'taken', retired: false };
      }

      const epoch: unknown = stored.sessionEpoch;
      const history: unknown = stored.history;
      if (!isSessionEpoch(epoch) || !Array.isArray(history)) return { kind: 'unreadable' };

      const newRef = codes.doc(code);
      const issued = await tx.get(newRef);
      if (issued.exists) return { kind: 'taken', retired: issued.get('retiredAt') != null };

      // The document of the code being replaced: the current code's, or on a
      // version 1 cleaner the digest document their code was stored as.
      const legacyDigest =
        typeof stored.codeDigest === 'string' && LEGACY_DIGEST.test(stored.codeDigest)
          ? stored.codeDigest
          : null;
      const oldRef =
        current !== null ? codes.doc(current) : legacyDigest !== null ? codes.doc(legacyDigest) : null;
      const old = oldRef ? await tx.get(oldRef) : null;

      const now = new Date().toISOString();
      const event: HistoryEvent = {
        at: now,
        action: 'code_changed',
        from: current,
        to: code,
        actor: ADMIN_ACTOR,
        reason: null,
      };
      const changes = {
        code,
        codeIssuedAt: now,
        sessionEpoch: epoch + 1,
        history: [...history, event],
      };

      tx.create(newRef, codeRecord(id, now));
      // Retired, never deleted: the old code stays reserved for ever.
      if (oldRef && old?.exists && old.get('cleanerId') === id && old.get('retiredAt') === null) {
        tx.update(oldRef, { retiredAt: now });
      }
      tx.update(cleanerRef, changes);
      return { kind: 'done', cleaner: readCleanerSummary(id, { ...stored, ...changes }), changed: true };
    });
  } catch (err) {
    // The new code's document appeared between the read and the commit.
    if (isAlreadyExists(err)) return { kind: 'taken', retired: false };
    console.error(`[cleaners] code change failed: grpc code ${grpcCode(err)}`);
    return { kind: 'failed' };
  }
}

// ─── Sign-in ───────────────────────────────────────────────────

export type FindCleanerResult =
  | { kind: 'found'; cleaner: SignedInCleaner }
  /** No active cleaner holds this code. Deliberately says no more than that. */
  | { kind: 'not-recognised' }
  /** A read failed. Access is never granted on an error. */
  | { kind: 'unavailable' };

/**
 * The active cleaner a code belongs to.
 *
 * Two reads on a hit, one on a miss: the code's document, then the cleaner
 * it names. The code must not be retired; the cleaner must be active, must
 * still point at this code (`code`), and must have a session epoch a token
 * can carry. Every other outcome is the same `not-recognised`. A version 1
 * code, stored as a digest, is never found here.
 *
 * The caller has already checked that `code` is four digits, without a read;
 * anything else is refused here too, still without one.
 */
export async function findCleanerByCode(code: string): Promise<FindCleanerResult> {
  if (!CODE_PATTERN.test(code)) return { kind: 'not-recognised' };

  try {
    const db = getAdminDb();
    const [codeDoc] = await db.getAll(db.collection(CLEANER_CODES_COLLECTION).doc(code), {
      fieldMask: ['cleanerId', 'retiredAt'],
    });
    // `retiredAt` is written as null and set once, when the code is replaced.
    // A document without it is not in the written shape, and is refused too.
    if (!codeDoc.exists || codeDoc.get('retiredAt') !== null) return { kind: 'not-recognised' };

    const cleanerId: unknown = codeDoc.get('cleanerId');
    if (typeof cleanerId !== 'string' || !AUTO_ID.test(cleanerId)) return { kind: 'not-recognised' };

    const [cleaner] = await db.getAll(db.collection(CLEANERS_COLLECTION).doc(cleanerId), {
      fieldMask: ['name', 'status', 'code', 'sessionEpoch'],
    });
    const epoch: unknown = cleaner.get('sessionEpoch');
    if (
      !cleaner.exists ||
      cleaner.get('status') !== 'active' ||
      cleaner.get('code') !== code ||
      !isSessionEpoch(epoch) ||
      epoch > MAX_TOKEN_EPOCH
    ) {
      return { kind: 'not-recognised' };
    }

    const name: unknown = cleaner.get('name');
    return {
      kind: 'found',
      cleaner: { id: cleanerId, name: typeof name === 'string' ? name : null, sessionEpoch: epoch },
    };
  } catch (err) {
    console.error(`[cleaner-session] lookup failed: grpc code ${grpcCode(err)}`);
    return { kind: 'unavailable' };
  }
}

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
      fieldMask: ['name', 'status', 'sessionEpoch'],
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
      cleaner: { id: cleanerId, name: typeof name === 'string' ? name : null, sessionEpoch },
    };
  } catch (err) {
    console.error(`[cleaner-session] session check failed: grpc code ${grpcCode(err)}`);
    return { kind: 'unavailable' };
  }
}
