/**
 * Server-side reads and writes of admin accounts (dispatch 38).
 *
 * `admins`, `admin_names` and `admin_actions` are reached only through the
 * Admin SDK, from the routes under /api/admin-auth and /api/admin/admins and
 * from the admin route wrapper (verify-admin.ts). firestore.rules' catch-all
 * denies every browser read and write of all three.
 *
 * ── An admin's document ──
 *   name, nameKey      the name as shown, and the key it is matched by
 *   level              'main' | 'admin'
 *   pin                { state: 'shared' } — the main admin on ADMIN_PIN, as
 *                      Kian's ruling has it until he changes it — or
 *                      { state: 'own' | 'temporary', scheme, salt, hash, N,
 *                      r, p } (pin.ts). Never leaves the server.
 *   sessionEpoch       carried by every session token; moved by a new PIN
 *                      and a PIN change, which ends every other session
 *   failedTries, lockedUntil   the lock (model.ts: afterTry)
 *   lastSignedInAt, createdAt, createdBy, history
 *
 * `admin_names/{nameKey}` holds `{ adminId }`. Its `create()` is what keeps
 * names unique, and sign-in finds an admin through it.
 *
 * ── The first main admin ──
 * When no admin exists — right after dispatch 38 is deployed — the first
 * sign-in attempt by the name Kian creates him as the main admin on the
 * shared PIN, before his PIN is checked, so the lock counts from his very
 * first try. Once any admin exists this never happens again: removing Kian
 * does not let the shared PIN make him anew.
 *
 * ── Writes ──
 * Every change is a transaction that reads the document and writes it back;
 * history is appended by reading the array, never with arrayUnion. A PIN's
 * scrypt runs outside the transaction, and the transaction checks the PIN it
 * was run against is still the one stored.
 *
 * Failure contract: signIn and readSessionAdmin never throw — a failed read
 * is `unavailable`, and access is never granted on an error. Everything else
 * throws when Firestore fails, and the route says the change may or may not
 * have been saved. Errors are logged as a gRPC code only.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { getAdminDb } from './admin';
import { isDocumentId } from './server-leads';
import {
  ADMINS_COLLECTION,
  ADMIN_ACTIONS_COLLECTION,
  ADMIN_ACTION_SCHEMA_VERSION,
  ADMIN_NAMES_COLLECTION,
  ADMIN_SCHEMA_VERSION,
  FIRST_MAIN_ADMIN_NAME,
  MAX_WRONG_TRIES,
  accountVerdict,
  afterTry,
  cleanAdminName,
  isAdminLevel,
  isPinState,
  lockHolding,
  nameKeyOf,
  type AdminActionView,
  type AdminHistoryEvent,
  type AdminLevel,
  type AdminSummary,
  type LockState,
  type PinState,
} from '@/app/lib/admins/model';
import { hashPin, pinMatches, sharedPinMatches, spendAPinCheck, type StoredPinHash } from '@/app/lib/admins/pin';
import { getAdminPinKey } from '@/app/lib/admins/secrets';
import type { Actor, ActorView } from '@/app/lib/cleaners/model';

/** The signed-in admin, as the session check reads them on every request. */
export interface SignedInAdmin {
  id: string;
  name: string;
  level: AdminLevel;
  pin: PinState;
  sessionEpoch: number;
}

/** The largest epoch a session token can carry (nine digits). */
const MAX_TOKEN_EPOCH = 999_999_999;

/** Who made the first main admin: no admin, the first sign-in after deploy. */
const FIRST_SIGN_IN: Actor = { role: 'system', id: null, name: 'first sign-in' };

function grpcCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? String(code) : 'unknown';
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function actorView(value: unknown): ActorView | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const a = value as Record<string, unknown>;
  return { role: text(a.role), id: text(a.id), name: text(a.name) };
}

/** The stored PIN's state, or null when it is not one of the three. */
function pinStateOf(pin: unknown): PinState | null {
  if (!pin || typeof pin !== 'object' || Array.isArray(pin)) return null;
  const state = (pin as Record<string, unknown>).state;
  return isPinState(state) ? state : null;
}

/** What identifies the PIN a check ran against: a new PIN, or a new salt, changes it. */
function pinFingerprint(pin: unknown): string {
  if (!pin || typeof pin !== 'object' || Array.isArray(pin)) return 'none';
  const p = pin as Record<string, unknown>;
  return [p.state, p.salt, p.hash].map((v) => (typeof v === 'string' ? v : '')).join('|');
}

function lockStateOf(data: Record<string, unknown>): LockState {
  const tries = data.failedTries;
  return {
    failedTries: typeof tries === 'number' && Number.isFinite(tries) ? tries : 0,
    lockedUntil: typeof data.lockedUntil === 'string' ? data.lockedUntil : null,
  };
}

function historyOf(data: Record<string, unknown>): AdminHistoryEvent[] {
  return Array.isArray(data.history) ? (data.history as AdminHistoryEvent[]) : [];
}

/** A row of the Admins page, from a stored document: never the PIN's hash or salt, nor the epoch. */
export function readAdminSummary(id: string, data: Record<string, unknown>, nowMs: number = Date.now()): AdminSummary {
  const lock = lockStateOf(data);
  const holding = lockHolding(lock, nowMs);
  return {
    id,
    name: text(data.name),
    level: text(data.level),
    pin: pinStateOf(data.pin) ?? (data.pin === undefined ? null : 'unreadable'),
    lockedUntil: holding,
    failedTries: holding ? 0 : lock.failedTries,
    lastSignedInAt: text(data.lastSignedInAt),
    createdAt: text(data.createdAt),
    createdBy: actorView(data.createdBy),
    history: historyOf(data).map((event) => {
      const e = (event ?? {}) as unknown as Record<string, unknown>;
      return { at: text(e.at), action: text(e.action), actor: actorView(e.actor), from: text(e.from), to: text(e.to) };
    }),
  };
}

// ─── The session check ─────────────────────────────────────────

export type SessionAdminRead = { kind: 'valid'; admin: SignedInAdmin } | { kind: 'invalid' } | { kind: 'unavailable' };

/**
 * The admin a session token names, if they still exist on the token's epoch.
 * One read, of four fields; never the PIN's hash.
 */
export async function readSessionAdmin(adminId: string, sessionEpoch: number): Promise<SessionAdminRead> {
  if (!isDocumentId(adminId)) return { kind: 'invalid' };
  try {
    const db = getAdminDb();
    const [doc] = await db.getAll(db.collection(ADMINS_COLLECTION).doc(adminId), {
      fieldMask: ['name', 'level', 'sessionEpoch', 'pin.state'],
    });
    if (!doc.exists || doc.get('sessionEpoch') !== sessionEpoch) return { kind: 'invalid' };
    const name: unknown = doc.get('name');
    const level: unknown = doc.get('level');
    const pin: unknown = doc.get('pin.state');
    if (typeof name !== 'string' || !isAdminLevel(level) || !isPinState(pin)) return { kind: 'invalid' };
    return { kind: 'valid', admin: { id: adminId, name, level, pin, sessionEpoch } };
  } catch (err) {
    console.error(`[admin-session] session check failed: grpc code ${grpcCode(err)}`);
    return { kind: 'unavailable' };
  }
}

// ─── Sign-in ───────────────────────────────────────────────────

export type SignInResult =
  | { kind: 'signed-in'; admin: SignedInAdmin }
  /** A wrong PIN for a name that exists (`triesLeft` before the lock), or a name nobody holds (`triesLeft` null). */
  | { kind: 'wrong'; triesLeft: number | null }
  /** Locked until `lockedUntil`; `now` when this try was the fifth. A try during a lock is not checked. */
  | { kind: 'locked'; lockedUntil: string; now: boolean }
  /** The PIN cannot be checked on this server: ADMIN_PIN_KEY, or for the shared PIN ADMIN_PIN, is not set. */
  | { kind: 'not-configured' }
  | { kind: 'unavailable' };

/**
 * When no admin exists, make the first main admin, Kian, on the shared PIN;
 * otherwise nothing. The ID of the admin now holding `nameKey`, or null.
 */
async function makeFirstMainAdmin(db: Firestore, nowIso: string): Promise<string | null> {
  const name = FIRST_MAIN_ADMIN_NAME;
  const key = nameKeyOf(name);
  return db.runTransaction(async (tx) => {
    const anyAdmin = await tx.get(db.collection(ADMINS_COLLECTION).limit(1));
    const nameRef = db.collection(ADMIN_NAMES_COLLECTION).doc(key);
    const nameDoc = await tx.get(nameRef);
    if (nameDoc.exists) return text(nameDoc.get('adminId'));
    if (!anyAdmin.empty) return null;
    const ref = db.collection(ADMINS_COLLECTION).doc();
    const created: AdminHistoryEvent = { at: nowIso, action: 'created', actor: FIRST_SIGN_IN, to: 'main' };
    tx.create(ref, {
      schemaVersion: ADMIN_SCHEMA_VERSION,
      name,
      nameKey: key,
      level: 'main',
      pin: { state: 'shared' },
      pinSetAt: null,
      sessionEpoch: 1,
      failedTries: 0,
      lockedUntil: null,
      lastSignedInAt: null,
      createdAt: nowIso,
      createdBy: FIRST_SIGN_IN,
      history: [created],
    });
    tx.create(nameRef, { adminId: ref.id, name, createdAt: nowIso });
    console.log(`[admins] first main admin created: ${ref.id}`);
    return ref.id;
  });
}

/** Whether `typed` is this admin's PIN, by its stored state; null when this server cannot check it. */
async function checkPin(pin: unknown, typed: string, pinKey: Buffer | null): Promise<boolean | null> {
  const state = pinStateOf(pin);
  if (state === 'shared') return sharedPinMatches(typed);
  if (state === 'own' || state === 'temporary') {
    if (!pinKey) return null;
    return pinMatches(pinKey, pin, typed);
  }
  await spendAPinCheck();
  return false;
}

/**
 * The lock's half of a try, in one transaction: refuse while locked, else
 * count the try as afterTry says. `checkedAgainst` is the PIN the check ran
 * against; if another PIN is stored now, the answer is `retry`.
 */
async function applyTry(
  db: Firestore,
  adminId: string,
  checkedAgainst: string,
  right: boolean,
  nowMs: number,
  options: {
    /** The epoch the session that is trying holds: another one stored means it has ended (`gone`). */
    expectEpoch?: number;
    /** What else a right try writes. */
    extra?: (data: Record<string, unknown>) => Record<string, unknown>;
  } = {},
): Promise<{ kind: 'gone' } | { kind: 'retry' } | { kind: 'locked'; lockedUntil: string; now: boolean } | { kind: 'wrong'; triesLeft: number } | { kind: 'right'; data: Record<string, unknown> }> {
  const ref = db.collection(ADMINS_COLLECTION).doc(adminId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { kind: 'gone' as const };
    const data = snap.data() ?? {};
    if (options.expectEpoch !== undefined && data.sessionEpoch !== options.expectEpoch) return { kind: 'gone' as const };
    if (pinFingerprint(data.pin) !== checkedAgainst) return { kind: 'retry' as const };
    const lock = lockStateOf(data);
    const holding = lockHolding(lock, nowMs);
    if (holding) return { kind: 'locked' as const, lockedUntil: holding, now: false };
    const outcome = afterTry(lock, right, nowMs);
    if (outcome.kind === 'right') {
      const more = options.extra ? options.extra(data) : {};
      tx.update(ref, { ...outcome.next, ...more });
      return { kind: 'right' as const, data: { ...data, ...outcome.next, ...more } };
    }
    tx.update(ref, { ...outcome.next });
    if (outcome.kind === 'locked-now') {
      console.log(`[admins] PIN locked after ${MAX_WRONG_TRIES} wrong tries: ${adminId}, until ${outcome.lockedUntil}`);
      return { kind: 'locked' as const, lockedUntil: outcome.lockedUntil, now: true };
    }
    return { kind: 'wrong' as const, triesLeft: outcome.triesLeft };
  });
}

/**
 * Sign an admin in by name and PIN. Five wrong tries in a row lock that
 * admin's PIN for fifteen minutes (Kian's ruling of 2026-10-13); a try during
 * the lock is refused unchecked and uncounted. A name nobody holds is
 * answered as a wrong PIN, after the same work, and locks nothing.
 */
export async function signIn(name: string, pin: string, nowMs: number = Date.now()): Promise<SignInResult> {
  const nowIso = new Date(nowMs).toISOString();
  const key = nameKeyOf(name);
  try {
    const db = getAdminDb();
    if (!isDocumentId(key)) {
      await spendAPinCheck();
      return { kind: 'wrong', triesLeft: null };
    }
    let adminId = text((await db.collection(ADMIN_NAMES_COLLECTION).doc(key).get()).get('adminId'));
    if (adminId === null && key === nameKeyOf(FIRST_MAIN_ADMIN_NAME)) adminId = await makeFirstMainAdmin(db, nowIso);
    if (adminId === null || !isDocumentId(adminId)) {
      await spendAPinCheck();
      return { kind: 'wrong', triesLeft: null };
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const snap = await db.collection(ADMINS_COLLECTION).doc(adminId).get();
      if (!snap.exists) {
        await spendAPinCheck();
        return { kind: 'wrong', triesLeft: null };
      }
      const data = snap.data() ?? {};
      const holding = lockHolding(lockStateOf(data), nowMs);
      if (holding) return { kind: 'locked', lockedUntil: holding, now: false };

      const state = pinStateOf(data.pin);
      const right = await checkPin(data.pin, pin, state === 'own' || state === 'temporary' ? getAdminPinKey() : null);
      if (right === null) return { kind: 'not-configured' };

      const applied = await applyTry(db, adminId, pinFingerprint(data.pin), right, nowMs, { extra: () => ({ lastSignedInAt: nowIso }) });
      if (applied.kind === 'retry') continue;
      if (applied.kind === 'gone') return { kind: 'wrong', triesLeft: null };
      if (applied.kind === 'locked') return applied;
      if (applied.kind === 'wrong') return applied;
      const signed = applied.data;
      const level = signed.level;
      const epoch = signed.sessionEpoch;
      const pinState = pinStateOf(signed.pin);
      if (typeof signed.name !== 'string' || !isAdminLevel(level) || typeof epoch !== 'number' || !pinState) return { kind: 'unavailable' };
      return { kind: 'signed-in', admin: { id: adminId, name: signed.name, level, pin: pinState, sessionEpoch: epoch } };
    }
    return { kind: 'unavailable' };
  } catch (err) {
    console.error(`[admins] sign-in failed: grpc code ${grpcCode(err)}`);
    return { kind: 'unavailable' };
  }
}

// ─── An admin's own PIN ────────────────────────────────────────

export type ChangePinResult =
  | { kind: 'changed'; admin: SignedInAdmin }
  /** The current PIN typed was wrong: it counts toward the lock like a sign-in try. */
  | { kind: 'wrong'; triesLeft: number }
  | { kind: 'locked'; lockedUntil: string; now: boolean }
  /** The session's admin is gone or on another epoch. */
  | { kind: 'session-ended' }
  | { kind: 'not-configured' }
  | { kind: 'unavailable' };

/**
 * An admin replaces their own PIN — a temporary one, the shared one, or one
 * they chose — after typing the current one. The current PIN is checked with
 * the lock, as at sign-in. The new PIN is their own; every other session they
 * hold ends, and the caller issues this browser a new token on the new epoch.
 */
export async function changeOwnPin(admin: SignedInAdmin, currentPin: string, newPin: string, nowMs: number = Date.now()): Promise<ChangePinResult> {
  const nowIso = new Date(nowMs).toISOString();
  const pinKey = getAdminPinKey();
  if (!pinKey) return { kind: 'not-configured' };
  try {
    const db = getAdminDb();
    const ref = db.collection(ADMINS_COLLECTION).doc(admin.id);
    const newHash: StoredPinHash = await hashPin(pinKey, newPin);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const snap = await ref.get();
      if (!snap.exists || snap.get('sessionEpoch') !== admin.sessionEpoch) return { kind: 'session-ended' };
      const data = snap.data() ?? {};
      const holding = lockHolding(lockStateOf(data), nowMs);
      if (holding) return { kind: 'locked', lockedUntil: holding, now: false };
      const right = await checkPin(data.pin, currentPin, pinKey);
      if (right === null) return { kind: 'not-configured' };
      const applied = await applyTry(db, admin.id, pinFingerprint(data.pin), right, nowMs, {
        expectEpoch: admin.sessionEpoch,
        extra: (fresh) => {
          const event: AdminHistoryEvent = { at: nowIso, action: 'pin_changed', actor: { role: 'admin', id: admin.id, name: admin.name } };
          return {
            pin: { state: 'own', ...newHash },
            pinSetAt: nowIso,
            sessionEpoch: Math.min(admin.sessionEpoch + 1, MAX_TOKEN_EPOCH),
            history: [...historyOf(fresh), event],
          };
        },
      });
      if (applied.kind === 'retry') continue;
      if (applied.kind === 'gone') return { kind: 'session-ended' };
      if (applied.kind === 'locked' || applied.kind === 'wrong') return applied;
      const epoch = applied.data.sessionEpoch;
      if (typeof epoch !== 'number') return { kind: 'unavailable' };
      return { kind: 'changed', admin: { ...admin, pin: 'own', sessionEpoch: epoch } };
    }
    return { kind: 'unavailable' };
  } catch (err) {
    console.error(`[admins] PIN change failed: grpc code ${grpcCode(err)}`);
    return { kind: 'unavailable' };
  }
}

// ─── The main admin's work ─────────────────────────────────────

/** Every admin, oldest first. THROWS when the read fails; never an empty list for a failure. */
export async function listAdmins(nowMs: number = Date.now()): Promise<AdminSummary[]> {
  const db = getAdminDb();
  const snap = await db
    .collection(ADMINS_COLLECTION)
    .select('name', 'level', 'pin.state', 'failedTries', 'lockedUntil', 'lastSignedInAt', 'createdAt', 'createdBy', 'history')
    .get();
  return snap.docs
    .map((doc) => readAdminSummary(doc.id, doc.data(), nowMs))
    .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id));
}

export type CreateAdminResult = { kind: 'created'; admin: AdminSummary } | { kind: 'name-taken' };

/**
 * Add an admin with a temporary PIN the main admin typed. They choose their
 * own when they first sign in. The name must be free, case and spacing aside.
 */
export async function createAdmin(actor: Actor, input: { name: string; level: AdminLevel; pin: string }, pinKey: Buffer): Promise<CreateAdminResult> {
  const name = cleanAdminName(input.name);
  const key = nameKeyOf(name);
  const nowIso = new Date().toISOString();
  const hash = await hashPin(pinKey, input.pin);
  const db = getAdminDb();
  const ref = db.collection(ADMINS_COLLECTION).doc();
  const nameRef = db.collection(ADMIN_NAMES_COLLECTION).doc(key);
  const event: AdminHistoryEvent = { at: nowIso, action: 'created', actor, to: input.level };
  const stored = {
    schemaVersion: ADMIN_SCHEMA_VERSION,
    name,
    nameKey: key,
    level: input.level,
    pin: { state: 'temporary', ...hash },
    pinSetAt: nowIso,
    sessionEpoch: 1,
    failedTries: 0,
    lockedUntil: null,
    lastSignedInAt: null,
    createdAt: nowIso,
    createdBy: actor,
    history: [event],
  };
  const taken = await db.runTransaction(async (tx) => {
    const existing = await tx.get(nameRef);
    if (existing.exists) return true;
    tx.create(ref, stored);
    tx.create(nameRef, { adminId: ref.id, name, createdAt: nowIso });
    return false;
  });
  if (taken) return { kind: 'name-taken' };
  return { kind: 'created', admin: readAdminSummary(ref.id, stored) };
}

export type AdminChangeResult =
  | { kind: 'done'; admin: AdminSummary; changed: boolean }
  | { kind: 'not-found' }
  /** A new PIN for oneself: that is Change PIN, from one's name in the header. */
  | { kind: 'yourself' }
  /** Another main admin's account: only they can be removed, demoted or given a new PIN, by themselves. */
  | { kind: 'main-admin' }
  /** The acting main admin would leave no main admin behind. */
  | { kind: 'last-main-admin' };

/** Main admins other than `actorId`, read inside the transaction so two who step down at once cannot both go. */
async function otherMainAdmins(db: Firestore, tx: FirebaseFirestore.Transaction, actorId: string | null): Promise<number> {
  const mains = await tx.get(db.collection(ADMINS_COLLECTION).where('level', '==', 'main'));
  return mains.docs.filter((doc) => doc.id !== actorId).length;
}

/**
 * Set an admin's level. Promoting is open to a main admin; demoting a main
 * admin is theirs alone (Kian's ruling of 2026-10-13), and only while another
 * main admin remains (accountVerdict). A level change holds on that admin's
 * next request.
 */
export async function setAdminLevel(actor: Actor, adminId: string, level: AdminLevel): Promise<AdminChangeResult> {
  if (!isDocumentId(adminId)) return { kind: 'not-found' };
  const db = getAdminDb();
  const ref = db.collection(ADMINS_COLLECTION).doc(adminId);
  const nowIso = new Date().toISOString();
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { kind: 'not-found' as const };
    const data = snap.data() ?? {};
    const others = await otherMainAdmins(db, tx, actor.id);
    if (data.level === level) return { kind: 'done' as const, admin: readAdminSummary(adminId, data), changed: false };
    const verdict = accountVerdict(level === 'main' ? 'promote' : 'demote', { self: adminId === actor.id, targetIsMain: data.level === 'main' }, others);
    if (verdict !== 'ok') return { kind: verdict };
    const event: AdminHistoryEvent = { at: nowIso, action: 'level_set', actor, from: text(data.level) ?? '', to: level };
    const update = { level, history: [...historyOf(data), event] };
    tx.update(ref, update);
    return { kind: 'done' as const, admin: readAdminSummary(adminId, { ...data, ...update }), changed: true };
  });
}

/**
 * Give an admin a new temporary PIN: their sessions end, any lock is cleared,
 * and they choose their own PIN when they next sign in. Never a main admin's
 * (Kian's ruling of 2026-10-13: theirs alone), and never one's own.
 */
export async function resetAdminPin(actor: Actor, adminId: string, pin: string, pinKey: Buffer): Promise<AdminChangeResult> {
  if (adminId === actor.id) return { kind: 'yourself' };
  if (!isDocumentId(adminId)) return { kind: 'not-found' };
  const hash = await hashPin(pinKey, pin);
  const db = getAdminDb();
  const ref = db.collection(ADMINS_COLLECTION).doc(adminId);
  const nowIso = new Date().toISOString();
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { kind: 'not-found' as const };
    const data = snap.data() ?? {};
    const verdict = accountVerdict('new-pin', { self: false, targetIsMain: data.level === 'main' }, 0);
    if (verdict !== 'ok') return { kind: verdict };
    const epoch = typeof data.sessionEpoch === 'number' ? data.sessionEpoch : 0;
    const event: AdminHistoryEvent = { at: nowIso, action: 'pin_reset', actor };
    const update = {
      pin: { state: 'temporary', ...hash },
      pinSetAt: nowIso,
      sessionEpoch: Math.min(epoch + 1, MAX_TOKEN_EPOCH),
      failedTries: 0,
      lockedUntil: null,
      history: [...historyOf(data), event],
    };
    tx.update(ref, update);
    return { kind: 'done' as const, admin: readAdminSummary(adminId, { ...data, ...update }), changed: true };
  });
}

/** End another admin's lock, or their count of wrong tries, before its time. */
export async function unlockAdmin(actor: Actor, adminId: string): Promise<AdminChangeResult> {
  if (!isDocumentId(adminId)) return { kind: 'not-found' };
  const db = getAdminDb();
  const ref = db.collection(ADMINS_COLLECTION).doc(adminId);
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { kind: 'not-found' as const };
    const data = snap.data() ?? {};
    const lock = lockStateOf(data);
    if (!lockHolding(lock, nowMs) && lock.failedTries === 0) return { kind: 'done' as const, admin: readAdminSummary(adminId, data, nowMs), changed: false };
    const event: AdminHistoryEvent = { at: nowIso, action: 'unlocked', actor };
    const update = { failedTries: 0, lockedUntil: null, history: [...historyOf(data), event] };
    tx.update(ref, update);
    return { kind: 'done' as const, admin: readAdminSummary(adminId, { ...data, ...update }, nowMs), changed: true };
  });
}

export type RemoveAdminResult = { kind: 'removed'; name: string | null } | { kind: 'not-found' } | { kind: 'main-admin' } | { kind: 'last-main-admin' };

/**
 * Remove an admin: their document and their name go, so the name is free
 * again, and every session they hold ends at its next request. What they did
 * keeps their ID and name in its own records. A main admin is removed by
 * themselves alone (Kian's ruling of 2026-10-13), and only while another main
 * admin remains.
 */
export async function removeAdmin(actor: Actor, adminId: string): Promise<RemoveAdminResult> {
  if (!isDocumentId(adminId)) return { kind: 'not-found' };
  const db = getAdminDb();
  const ref = db.collection(ADMINS_COLLECTION).doc(adminId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { kind: 'not-found' as const };
    const data = snap.data() ?? {};
    const others = await otherMainAdmins(db, tx, actor.id);
    const verdict = accountVerdict('remove', { self: adminId === actor.id, targetIsMain: data.level === 'main' }, others);
    // A removal is never 'yourself': that verdict is a new PIN's only.
    if (verdict !== 'ok') return { kind: verdict === 'last-main-admin' ? ('last-main-admin' as const) : ('main-admin' as const) };
    const key = text(data.nameKey);
    const nameRef = key && isDocumentId(key) ? db.collection(ADMIN_NAMES_COLLECTION).doc(key) : null;
    const nameDoc = nameRef ? await tx.get(nameRef) : null;
    tx.delete(ref);
    if (nameRef && nameDoc?.exists && nameDoc.get('adminId') === adminId) tx.delete(nameRef);
    return { kind: 'removed' as const, name: text(data.name) };
  });
}

// ─── The activity log ──────────────────────────────────────────

export interface AdminActionRecord {
  at: string;
  admin: { id: string; name: string; level: AdminLevel };
  method: string;
  /** The path, which names what was acted on by ID. Never a query string or a body: those can carry PINs, codes or names. */
  path: string;
  status: number;
}

/** One line in `admin_actions`. Called after the response; a failure is logged, never thrown. */
export async function recordAdminAction(record: AdminActionRecord): Promise<void> {
  try {
    await getAdminDb().collection(ADMIN_ACTIONS_COLLECTION).doc().create({ schemaVersion: ADMIN_ACTION_SCHEMA_VERSION, ...record });
  } catch (err) {
    console.error(`[admins] activity not recorded: ${record.method} ${record.path} by ${record.admin.id}: grpc code ${grpcCode(err)}`);
  }
}

/** The newest `limit` lines of the activity log. THROWS when the read fails. */
export async function listAdminActions(limit: number): Promise<AdminActionView[]> {
  const snap = await getAdminDb().collection(ADMIN_ACTIONS_COLLECTION).orderBy('at', 'desc').limit(limit).get();
  return snap.docs.map((doc) => {
    const d = doc.data();
    const admin = (d.admin && typeof d.admin === 'object' ? d.admin : {}) as Record<string, unknown>;
    return {
      id: doc.id,
      at: text(d.at),
      admin: { id: text(admin.id), name: text(admin.name), level: text(admin.level) },
      method: text(d.method),
      path: text(d.path),
      status: typeof d.status === 'number' ? d.status : null,
    };
  });
}
