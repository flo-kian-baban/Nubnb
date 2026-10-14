/**
 * Server-side reads and writes of admin accounts (dispatch 38; sign-in by PIN
 * alone since Kian's rulings of 2026-10-13, evening; PINs set by the main
 * admin and stored readably since his rulings of that night).
 *
 * `admins`, `admin_names`, `admin_pins`, `admin_signin_locks` and
 * `admin_actions` are reached only through the Admin SDK, from the routes
 * under /api/admin-auth and /api/admin/admins and from the admin route
 * wrapper (verify-admin.ts). firestore.rules' catch-all denies every browser
 * read and write of all five.
 *
 * ── An admin's document ──
 *   name, nameKey      the name as shown, and the key it is kept unique by
 *   level              'main' | 'admin'
 *   pin                { state: 'readable', value } — the PIN as set, stored
 *                      readably (Kian's ruling) — or { state: 'shared' }: a
 *                      main admin the recovery script put back on ADMIN_PIN.
 *                      Earlier versions wrote { state: 'own' | 'temporary',
 *                      salted hash } and { state: 'set', lookup }; those are
 *                      read, never written, and sign in no more. The value
 *                      leaves the server only for a main admin's Admins page.
 *   sessionEpoch       carried by every session token; moved by every PIN
 *                      change, which ends every other session
 *   lastSignedInAt, createdAt, createdBy, history
 *   (failedTries, lockedUntil: the first version's per-admin lock, left as
 *   they are on its documents and read by nothing)
 *
 * `admin_names/{nameKey}` → `{ adminId }` keeps names unique. `admin_pins/
 * {PIN}` → `{ adminId }` finds an admin by PIN and keeps PINs unique, the way
 * `cleaner_codes/{code}` works; the evening's entries under a lookup key (64
 * hex characters) are only ever deleted, with their admin's PIN.
 * `admin_signin_locks/{keyed hash of the connection}` → `{ failedTries,
 * lockedUntil, lastFailedAt }`: five wrong PINs from one connection lock
 * sign-in from it for fifteen minutes (model.ts, afterTry). Each change of
 * one's own PIN counts there too, as a try: a PIN refused because another
 * admin holds it tells the chooser that admin's PIN, so choosing is no faster
 * than guessing at the door. The address itself is never stored.
 *
 * ── The shared PIN ──
 * ADMIN_PIN signs in only a main admin on `{ state: 'shared' }`, and only
 * when exactly one is; the gate then has them set their PIN before anything
 * else. When no admin exists at all, it makes the first main admin, Kian, on
 * the shared PIN, the same way. Otherwise it is a wrong PIN like any other.
 *
 * ── Writes ──
 * Every change is a transaction that reads first and writes after; history
 * is appended by reading the array, never with arrayUnion.
 *
 * Failure contract: signIn, changeOwnPin and readSessionAdmin never throw — a
 * failed read is `unavailable`, and access is never granted on an error.
 * Everything else throws when Firestore fails, and the route says the change
 * may or may not have been saved. Errors are logged as a gRPC code only.
 */

import type { DocumentReference, Firestore, Transaction } from 'firebase-admin/firestore';
import { getAdminDb } from './admin';
import { isDocumentId } from './server-leads';
import {
  ADMINS_COLLECTION,
  ADMIN_ACTIONS_COLLECTION,
  ADMIN_ACTION_SCHEMA_VERSION,
  ADMIN_NAMES_COLLECTION,
  ADMIN_PINS_COLLECTION,
  ADMIN_SCHEMA_VERSION,
  ADMIN_SIGNIN_LOCKS_COLLECTION,
  FIRST_MAIN_ADMIN_NAME,
  MAX_WRONG_TRIES,
  PIN_PATTERN,
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
  type SignInLockView,
} from '@/app/lib/admins/model';
import { pinLookup, pinMatches, samePin, sharedPinLength, sharedPinMatches } from '@/app/lib/admins/pin';
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

/** Who made the first main admin: no admin, the first sign-in with the shared PIN. */
const FIRST_SIGN_IN: Actor = { role: 'system', id: null, name: 'first sign-in' };

const LOCK_ID = /^[0-9a-f]{64}$/;

function grpcCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? String(code) : 'unknown';
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const epochOf = (data: Record<string, unknown>): number => (typeof data.sessionEpoch === 'number' ? data.sessionEpoch : 0);

function actorView(value: unknown): ActorView | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const a = value as Record<string, unknown>;
  return { role: text(a.role), id: text(a.id), name: text(a.name) };
}

/** The stored PIN's state, or null when it is none of them. */
function pinStateOf(pin: unknown): PinState | null {
  if (!pin || typeof pin !== 'object' || Array.isArray(pin)) return null;
  const state = (pin as Record<string, unknown>).state;
  return isPinState(state) ? state : null;
}

/** The PIN of a `readable` state, or null. */
function readableOf(pin: unknown): string | null {
  if (pinStateOf(pin) !== 'readable') return null;
  const value = (pin as Record<string, unknown>).value;
  return typeof value === 'string' && PIN_PATTERN.test(value) ? value : null;
}

/** The lookup key of an evening `set` PIN, or null. */
function lookupOf(pin: unknown): string | null {
  if (pinStateOf(pin) !== 'set') return null;
  const lookup = (pin as Record<string, unknown>).lookup;
  return typeof lookup === 'string' && LOCK_ID.test(lookup) ? lookup : null;
}

/** The ID of the `admin_pins` document a stored PIN is kept under: the PIN, or the evening's lookup key. */
const indexIdOf = (pin: unknown): string | null => readableOf(pin) ?? lookupOf(pin);

/** The `pin` field of a PIN set now. */
const readablePin = (value: string) => ({ state: 'readable', value });

function lockStateOf(data: Record<string, unknown> | undefined): LockState {
  const tries = data?.failedTries;
  return {
    failedTries: typeof tries === 'number' && Number.isFinite(tries) ? tries : 0,
    lockedUntil: typeof data?.lockedUntil === 'string' ? data.lockedUntil : null,
  };
}

function historyOf(data: Record<string, unknown>): AdminHistoryEvent[] {
  return Array.isArray(data.history) ? (data.history as AdminHistoryEvent[]) : [];
}

/**
 * A row of the Admins page, from a stored document, for main admins only: the
 * PIN when it is readable (Kian's ruling: main admins see every admin's PIN);
 * never a hash, a lookup key or the epoch.
 */
export function readAdminSummary(id: string, data: Record<string, unknown>): AdminSummary {
  return {
    id,
    name: text(data.name),
    level: text(data.level),
    pin: pinStateOf(data.pin) ?? (data.pin === undefined ? null : 'unreadable'),
    pinValue: readableOf(data.pin),
    lastSignedInAt: text(data.lastSignedInAt),
    createdAt: text(data.createdAt),
    createdBy: actorView(data.createdBy),
    history: historyOf(data).map((event) => {
      const e = (event ?? {}) as unknown as Record<string, unknown>;
      return { at: text(e.at), action: text(e.action), actor: actorView(e.actor), from: text(e.from), to: text(e.to) };
    }),
  };
}

function signedIn(id: string, data: Record<string, unknown>, epoch: number): SignedInAdmin | null {
  const level = data.level;
  const pin = pinStateOf(data.pin);
  if (typeof data.name !== 'string' || !isAdminLevel(level) || !pin) return null;
  return { id, name: data.name, level, pin, sessionEpoch: epoch };
}

// ─── The session check ─────────────────────────────────────────

export type SessionAdminRead = { kind: 'valid'; admin: SignedInAdmin } | { kind: 'invalid' } | { kind: 'unavailable' };

/**
 * The admin a session token names, if they still exist on the token's epoch.
 * One read, of four fields; never the PIN.
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

// ─── The connection lock ───────────────────────────────────────

/**
 * One more try counted against a connection inside the transaction: a wrong PIN, or a change of one's own PIN.
 * `lockedUntil` when this try was the fifth.
 */
function countTry(tx: Transaction, lockRef: DocumentReference, lock: LockState, nowMs: number): { triesLeft: number; lockedUntil: string | null } {
  const outcome = afterTry(lock, false, nowMs);
  tx.set(lockRef, { ...outcome.next, lastFailedAt: new Date(nowMs).toISOString() });
  if (outcome.kind === 'locked-now') {
    console.log(`[admins] sign-in locked after ${MAX_WRONG_TRIES} tries from one connection, until ${outcome.lockedUntil}`);
    return { triesLeft: 0, lockedUntil: outcome.lockedUntil };
  }
  return { triesLeft: outcome.kind === 'wrong' ? outcome.triesLeft : 0, lockedUntil: null };
}

/** A wrong PIN, counted; the answer to give. */
function countWrong(tx: Transaction, lockRef: DocumentReference, lock: LockState, nowMs: number): { kind: 'wrong'; triesLeft: number } | { kind: 'locked'; lockedUntil: string; now: boolean } {
  const counted = countTry(tx, lockRef, lock, nowMs);
  return counted.lockedUntil ? { kind: 'locked', lockedUntil: counted.lockedUntil, now: true } : { kind: 'wrong', triesLeft: counted.triesLeft };
}

/** Locks holding now, newest first. THROWS when the read fails. */
export async function listSignInLocks(nowMs: number = Date.now()): Promise<SignInLockView[]> {
  const snap = await getAdminDb().collection(ADMIN_SIGNIN_LOCKS_COLLECTION).where('lockedUntil', '>', new Date(nowMs).toISOString()).get();
  return snap.docs
    .map((doc) => ({ id: doc.id, lockedUntil: String(doc.get('lockedUntil')), lastFailedAt: text(doc.get('lastFailedAt')) }))
    .sort((a, b) => b.lockedUntil.localeCompare(a.lockedUntil));
}

/** Lift a connection's lock, and its count, before its time (the main admin, on the Admins page). */
export async function liftSignInLock(lockId: string): Promise<{ kind: 'lifted' } | { kind: 'not-found' }> {
  if (!LOCK_ID.test(lockId)) return { kind: 'not-found' };
  const db = getAdminDb();
  const ref = db.collection(ADMIN_SIGNIN_LOCKS_COLLECTION).doc(lockId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { kind: 'not-found' as const };
    tx.delete(ref);
    return { kind: 'lifted' as const };
  });
}

// ─── Sign-in ───────────────────────────────────────────────────

export type SignInResult =
  | { kind: 'signed-in'; admin: SignedInAdmin }
  /** No admin holds that PIN; `triesLeft` before this connection's lock. */
  | { kind: 'wrong'; triesLeft: number }
  /** Sign-in from this connection is locked until `lockedUntil`; `now` when this PIN was the fifth. */
  | { kind: 'locked'; lockedUntil: string; now: boolean }
  /** The shared PIN, with more than one main admin on it: it cannot say which. */
  | { kind: 'shared-ambiguous' }
  | { kind: 'unavailable' };

/**
 * Sign in by PIN alone (Kian's ruling: the PIN identifies the admin). A
 * locked connection is refused before anything else is read. Otherwise the
 * PIN's own `admin_pins` document finds its admin, whose stored PIN is
 * checked; a PIN no admin holds counts against the connection, and the fifth
 * in a row locks it for fifteen minutes. The shared PIN signs in the one main
 * admin on it, or makes the first main admin of an empty database; either
 * then sets their PIN.
 *
 * The answer's timing never says whether a PIN was the shared one: every PIN
 * of the shared PIN's length that no admin holds reads the main admins the
 * same way. No PIN is hashed.
 */
export async function signIn(pin: string, connection: string, nowMs: number = Date.now()): Promise<SignInResult> {
  const nowIso = new Date(nowMs).toISOString();
  try {
    const db = getAdminDb();
    const lockRef = db.collection(ADMIN_SIGNIN_LOCKS_COLLECTION).doc(connection);
    const before = await lockRef.get();
    const holding = before.exists ? lockHolding(lockStateOf(before.data()), nowMs) : null;
    if (holding) return { kind: 'locked', lockedUntil: holding, now: false };

    const shared = sharedPinMatches(pin) === true;
    const sharedShape = pin.length === sharedPinLength();
    const outcome = await db.runTransaction(async (tx) => {
      // ── Reads ──
      const lockSnap = await tx.get(lockRef);
      const lock = lockStateOf(lockSnap.data());
      const locked = lockHolding(lock, nowMs);
      if (locked) return { kind: 'locked' as const, lockedUntil: locked, now: false };

      let via: 'pin' | 'shared' | 'first' | null = null;
      let adminRef: DocumentReference | null = null;
      let adminData: Record<string, unknown> = {};
      if (PIN_PATTERN.test(pin)) {
        const index = await tx.get(db.collection(ADMIN_PINS_COLLECTION).doc(pin));
        const id = index.exists ? text(index.get('adminId')) : null;
        if (id && isDocumentId(id)) {
          const snap = await tx.get(db.collection(ADMINS_COLLECTION).doc(id));
          const held = snap.exists ? readableOf(snap.get('pin')) : null;
          if (held && samePin(held, pin)) {
            via = 'pin';
            adminRef = snap.ref;
            adminData = snap.data() ?? {};
          }
        }
      }
      const firstNameRef = db.collection(ADMIN_NAMES_COLLECTION).doc(nameKeyOf(FIRST_MAIN_ADMIN_NAME));
      if (!via && sharedShape) {
        // The same reads for every PIN of this length, the shared PIN or not: the main admins' PIN states, and, only
        // when there is no main admin, whether there is any admin at all.
        const mains = await tx.get(db.collection(ADMINS_COLLECTION).where('level', '==', 'main').select('pin.state'));
        const onShared = mains.docs.filter((doc) => doc.get('pin.state') === 'shared');
        const empty = mains.empty && (await tx.get(db.collection(ADMINS_COLLECTION).limit(1))).empty;
        const firstFree = empty && !(await tx.get(firstNameRef)).exists;
        if (shared && onShared.length > 1) return { kind: 'shared-ambiguous' as const };
        if (shared && onShared.length === 1) {
          const snap = await tx.get(onShared[0].ref);
          if (snap.exists && snap.get('level') === 'main' && pinStateOf(snap.get('pin')) === 'shared') {
            via = 'shared';
            adminRef = snap.ref;
            adminData = snap.data() ?? {};
          }
        } else if (shared && firstFree) {
          via = 'first';
        }
      }

      // ── Writes ──
      if (!via) return countWrong(tx, lockRef, lock, nowMs);
      if (lockSnap.exists) tx.delete(lockRef);
      if ((via === 'pin' || via === 'shared') && adminRef) {
        tx.update(adminRef, { lastSignedInAt: nowIso });
        if (via === 'shared') console.log(`[admins] ${adminRef.id} signed in with the shared PIN`);
        return { kind: 'in' as const, id: adminRef.id, data: adminData, epoch: epochOf(adminData) };
      }
      // The first main admin of an empty database, on the shared PIN until they set theirs.
      const ref = db.collection(ADMINS_COLLECTION).doc();
      const name = FIRST_MAIN_ADMIN_NAME;
      const stored = {
        schemaVersion: ADMIN_SCHEMA_VERSION,
        name,
        nameKey: nameKeyOf(name),
        level: 'main',
        pin: { state: 'shared' },
        pinSetAt: nowIso,
        sessionEpoch: 1,
        lastSignedInAt: nowIso,
        createdAt: nowIso,
        createdBy: FIRST_SIGN_IN,
        history: [{ at: nowIso, action: 'created', actor: FIRST_SIGN_IN, to: 'main' } satisfies AdminHistoryEvent],
      };
      tx.create(ref, stored);
      tx.create(firstNameRef, { adminId: ref.id, name, createdAt: nowIso });
      console.log(`[admins] first main admin created: ${ref.id}`);
      return { kind: 'in' as const, id: ref.id, data: stored as Record<string, unknown>, epoch: 1 };
    });
    if (outcome.kind !== 'in') return outcome;
    const admin = signedIn(outcome.id, outcome.data, outcome.epoch);
    return admin ? { kind: 'signed-in', admin } : { kind: 'unavailable' };
  } catch (err) {
    console.error(`[admins] sign-in failed: grpc code ${grpcCode(err)}`);
    return { kind: 'unavailable' };
  }
}

// ─── An admin's own PIN and name ───────────────────────────────

export type ChangePinResult =
  | { kind: 'changed'; admin: SignedInAdmin; lockedUntil: string | null }
  /** The current PIN typed was wrong: it counts against the connection like a sign-in. */
  | { kind: 'wrong'; triesLeft: number }
  /** Another admin holds the new PIN. Counted against the connection like every change. */
  | { kind: 'taken'; triesLeft: number }
  /** The new PIN is the one already set. Nothing changed, nothing counted. */
  | { kind: 'same' }
  | { kind: 'locked'; lockedUntil: string; now: boolean }
  /** The session's admin is gone or on another epoch. */
  | { kind: 'session-ended' }
  | { kind: 'not-configured' }
  | { kind: 'unavailable' };

/** Whether `typed` is the PIN an admin's document holds, whatever its state. */
async function isCurrentPin(pinKey: Buffer, stored: unknown, typed: string): Promise<boolean> {
  const state = pinStateOf(stored);
  if (state === 'readable') {
    const held = readableOf(stored);
    return held !== null && samePin(held, typed);
  }
  if (state === 'shared') return sharedPinMatches(typed) === true;
  if (state === 'set') {
    const held = lookupOf(stored);
    return held !== null && PIN_PATTERN.test(typed) && samePin(await pinLookup(pinKey, typed), held);
  }
  if (state === 'own' || state === 'temporary') return PIN_PATTERN.test(typed) && (await pinMatches(pinKey, stored, typed));
  return false;
}

/**
 * Change PIN, from an admin's own menu or the gate's Set your PIN: the
 * current PIN, checked against their own document whatever its state, then
 * the new one, stored readably (Kian's ruling). A wrong current PIN counts
 * against the connection like a sign-in. So does every change: a PIN refused
 * because another admin holds it tells the chooser that admin's PIN, and
 * counting keeps choosing no faster than guessing at the door. Every other
 * session the admin holds ends; the caller gives this browser a new token on
 * the new epoch. The new PIN's shape is the route's to check.
 */
export async function changeOwnPin(admin: SignedInAdmin, currentPin: string, newPin: string, connection: string, nowMs: number = Date.now()): Promise<ChangePinResult> {
  const pinKey = getAdminPinKey();
  if (!pinKey) return { kind: 'not-configured' };
  const nowIso = new Date(nowMs).toISOString();
  try {
    const db = getAdminDb();
    const lockRef = db.collection(ADMIN_SIGNIN_LOCKS_COLLECTION).doc(connection);
    const ref = db.collection(ADMINS_COLLECTION).doc(admin.id);
    const before = await lockRef.get();
    const holding = before.exists ? lockHolding(lockStateOf(before.data()), nowMs) : null;
    if (holding) return { kind: 'locked', lockedUntil: holding, now: false };

    const snap = await ref.get();
    if (!snap.exists || snap.get('sessionEpoch') !== admin.sessionEpoch) return { kind: 'session-ended' };
    const stored = snap.get('pin');
    const right = await isCurrentPin(pinKey, stored, currentPin);
    const held = readableOf(stored);
    if (right && held !== null && samePin(held, newPin)) return { kind: 'same' };

    const outcome = await db.runTransaction(async (tx) => {
      const lockSnap = await tx.get(lockRef);
      const lock = lockStateOf(lockSnap.data());
      const locked = lockHolding(lock, nowMs);
      if (locked) return { kind: 'locked' as const, lockedUntil: locked, now: false };
      const current = await tx.get(ref);
      // Every PIN change moves the epoch: the same epoch means the PIN checked is still the one stored.
      if (!current.exists || current.get('sessionEpoch') !== admin.sessionEpoch) return { kind: 'session-ended' as const };
      const newRef = db.collection(ADMIN_PINS_COLLECTION).doc(newPin);
      const taken = await tx.get(newRef);
      const oldId = indexIdOf(current.get('pin'));
      const oldRef = oldId ? db.collection(ADMIN_PINS_COLLECTION).doc(oldId) : null;
      const oldIndex = oldRef ? await tx.get(oldRef) : null;
      if (!right) return countWrong(tx, lockRef, lock, nowMs);
      const counted = countTry(tx, lockRef, lock, nowMs);
      if (taken.exists) return counted.lockedUntil ? { kind: 'locked' as const, lockedUntil: counted.lockedUntil, now: true } : { kind: 'taken' as const, triesLeft: counted.triesLeft };
      const data = current.data() ?? {};
      const epoch = Math.min(admin.sessionEpoch + 1, MAX_TOKEN_EPOCH);
      const event: AdminHistoryEvent = { at: nowIso, action: 'pin_changed', actor: { role: 'admin', id: admin.id, name: admin.name }, from: pinStateOf(data.pin) ?? '' };
      tx.update(ref, { pin: readablePin(newPin), pinSetAt: nowIso, sessionEpoch: epoch, history: [...historyOf(data), event] });
      tx.create(newRef, { adminId: admin.id, createdAt: nowIso });
      if (oldRef && oldIndex?.exists && oldIndex.get('adminId') === admin.id) tx.delete(oldRef);
      return { kind: 'changed' as const, epoch, lockedUntil: counted.lockedUntil };
    });
    if (outcome.kind !== 'changed') return outcome;
    return { kind: 'changed', admin: { ...admin, pin: 'readable', sessionEpoch: outcome.epoch }, lockedUntil: outcome.lockedUntil };
  } catch (err) {
    console.error(`[admins] PIN change failed: grpc code ${grpcCode(err)}`);
    return { kind: 'unavailable' };
  }
}

export type ChangeNameResult = { kind: 'changed'; admin: SignedInAdmin; changed: boolean } | { kind: 'name-taken' } | { kind: 'session-ended' };

/**
 * Change name, from an admin's own menu (Kian's ruling: the admin can change
 * their own name later; names stay unique, case and spacing aside). The
 * history keeps the name before and after. Records made before keep the name
 * they were made under. THROWS when Firestore fails.
 */
export async function changeOwnName(admin: SignedInAdmin, typed: string): Promise<ChangeNameResult> {
  const name = cleanAdminName(typed);
  const key = nameKeyOf(name);
  const db = getAdminDb();
  const ref = db.collection(ADMINS_COLLECTION).doc(admin.id);
  const nowIso = new Date().toISOString();
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.get('sessionEpoch') !== admin.sessionEpoch) return { kind: 'session-ended' as const };
    const data = snap.data() ?? {};
    const before = text(data.name) ?? '';
    const oldKey = text(data.nameKey);
    if (before === name) return { kind: 'changed' as const, admin, changed: false };
    const newRef = db.collection(ADMIN_NAMES_COLLECTION).doc(key);
    const oldRef = oldKey && isDocumentId(oldKey) ? db.collection(ADMIN_NAMES_COLLECTION).doc(oldKey) : null;
    const moving = key !== oldKey;
    const taken = moving ? await tx.get(newRef) : null;
    const oldIndex = oldRef ? await tx.get(oldRef) : null;
    if (taken?.exists) return { kind: 'name-taken' as const };
    const event: AdminHistoryEvent = { at: nowIso, action: 'name_changed', actor: { role: 'admin', id: admin.id, name: before }, from: before, to: name };
    tx.update(ref, { name, nameKey: key, history: [...historyOf(data), event] });
    if (moving) {
      tx.create(newRef, { adminId: admin.id, name, createdAt: nowIso });
      if (oldRef && oldIndex?.exists && oldIndex.get('adminId') === admin.id) tx.delete(oldRef);
    } else if (oldRef && oldIndex?.exists) {
      tx.update(oldRef, { name });
    }
    return { kind: 'changed' as const, admin: { ...admin, name }, changed: true };
  });
}

// ─── The main admin's work ─────────────────────────────────────

/** Every admin, oldest first, with the PINs stored readably (for a main admin's page only). THROWS when the read fails; never an empty list for a failure. */
export async function listAdmins(): Promise<AdminSummary[]> {
  const db = getAdminDb();
  const snap = await db.collection(ADMINS_COLLECTION).select('name', 'level', 'pin.state', 'pin.value', 'lastSignedInAt', 'createdAt', 'createdBy', 'history').get();
  return snap.docs
    .map((doc) => readAdminSummary(doc.id, doc.data()))
    .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id));
}

export type CreateAdminResult = { kind: 'created'; admin: AdminSummary } | { kind: 'name-taken' } | { kind: 'pin-taken' };

/**
 * Add an admin with the name, level and PIN the main admin sets (Kian's
 * rulings: the main admin sets each admin's PIN when adding them; PINs stay
 * unique and are stored readably). The name must be free, case and spacing
 * aside, and the PIN free. The PIN's shape is the route's to check. THROWS
 * when Firestore fails.
 */
export async function createAdmin(actor: Actor, input: { name: string; level: AdminLevel; pin: string }): Promise<CreateAdminResult> {
  const name = cleanAdminName(input.name);
  const key = nameKeyOf(name);
  const db = getAdminDb();
  const nameRef = db.collection(ADMIN_NAMES_COLLECTION).doc(key);
  const pinRef = db.collection(ADMIN_PINS_COLLECTION).doc(input.pin);
  const nowIso = new Date().toISOString();
  const ref = db.collection(ADMINS_COLLECTION).doc();
  const stored = {
    schemaVersion: ADMIN_SCHEMA_VERSION,
    name,
    nameKey: key,
    level: input.level,
    pin: readablePin(input.pin),
    pinSetAt: nowIso,
    sessionEpoch: 1,
    lastSignedInAt: null,
    createdAt: nowIso,
    createdBy: actor,
    history: [{ at: nowIso, action: 'created', actor, to: input.level } satisfies AdminHistoryEvent],
  };
  const outcome = await db.runTransaction(async (tx) => {
    const existing = await tx.get(nameRef);
    const taken = await tx.get(pinRef);
    if (existing.exists) return 'name-taken' as const;
    if (taken.exists) return 'pin-taken' as const;
    tx.create(ref, stored);
    tx.create(nameRef, { adminId: ref.id, name, createdAt: nowIso });
    tx.create(pinRef, { adminId: ref.id, createdAt: nowIso });
    return 'created' as const;
  });
  if (outcome !== 'created') return { kind: outcome };
  return { kind: 'created', admin: readAdminSummary(ref.id, stored) };
}

export type AdminChangeResult =
  | { kind: 'done'; admin: AdminSummary; changed: boolean }
  | { kind: 'not-found' }
  /** A PIN for oneself: that is Change PIN, from one's name in the header. */
  | { kind: 'yourself' }
  /** Another main admin's account: only they can be removed, demoted or given a new PIN, by themselves. */
  | { kind: 'main-admin' }
  /** The acting main admin would leave no main admin behind. */
  | { kind: 'last-main-admin' };

/** Main admins other than `actorId`, read inside the transaction so two who step down at once cannot both go. */
async function otherMainAdmins(db: Firestore, tx: Transaction, actorId: string | null): Promise<number> {
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

export type SetPinResult = { kind: 'done'; admin: AdminSummary; changed: boolean } | { kind: 'not-found' } | { kind: 'yourself' } | { kind: 'main-admin' } | { kind: 'pin-taken' };

/**
 * Set an ordinary admin's PIN, from the main admin's Admins page (Kian's
 * ruling: the main admin can change any ordinary admin's PIN). Their sessions
 * end. Never a main admin's (Kian's ruling of 2026-10-13: theirs alone), and
 * never one's own (Change PIN in one's menu). The PIN's shape is the route's
 * to check. THROWS when Firestore fails.
 */
export async function setAdminPin(actor: Actor, adminId: string, pin: string): Promise<SetPinResult> {
  if (adminId === actor.id) return { kind: 'yourself' };
  if (!isDocumentId(adminId)) return { kind: 'not-found' };
  const db = getAdminDb();
  const ref = db.collection(ADMINS_COLLECTION).doc(adminId);
  const newRef = db.collection(ADMIN_PINS_COLLECTION).doc(pin);
  const nowIso = new Date().toISOString();
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { kind: 'not-found' as const };
    const data = snap.data() ?? {};
    const taken = await tx.get(newRef);
    const oldId = indexIdOf(data.pin);
    const oldRef = oldId ? db.collection(ADMIN_PINS_COLLECTION).doc(oldId) : null;
    const oldIndex = oldRef ? await tx.get(oldRef) : null;
    const verdict = accountVerdict('set-pin', { self: false, targetIsMain: data.level === 'main' }, 0);
    if (verdict === 'main-admin') return { kind: 'main-admin' as const };
    const held = readableOf(data.pin);
    if (held !== null && samePin(held, pin)) return { kind: 'done' as const, admin: readAdminSummary(adminId, data), changed: false };
    if (taken.exists) return { kind: 'pin-taken' as const };
    const event: AdminHistoryEvent = { at: nowIso, action: 'pin_set', actor };
    const update = { pin: readablePin(pin), pinSetAt: nowIso, sessionEpoch: Math.min(epochOf(data) + 1, MAX_TOKEN_EPOCH), history: [...historyOf(data), event] };
    tx.update(ref, update);
    tx.create(newRef, { adminId, createdAt: nowIso });
    if (oldRef && oldIndex?.exists && oldIndex.get('adminId') === adminId) tx.delete(oldRef);
    return { kind: 'done' as const, admin: readAdminSummary(adminId, { ...data, ...update }), changed: true };
  });
}

export type RemoveAdminResult = { kind: 'removed'; name: string | null } | { kind: 'not-found' } | { kind: 'main-admin' } | { kind: 'last-main-admin' };

/**
 * Remove an admin: their document, their name and their PIN go, so both are
 * free again, and every session they hold ends at its next request. What they
 * did keeps their ID and name in its own records. A main admin is removed by
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
    const indexId = indexIdOf(data.pin);
    const pinRef = indexId ? db.collection(ADMIN_PINS_COLLECTION).doc(indexId) : null;
    const pinDoc = pinRef ? await tx.get(pinRef) : null;
    tx.delete(ref);
    if (nameRef && nameDoc?.exists && nameDoc.get('adminId') === adminId) tx.delete(nameRef);
    if (pinRef && pinDoc?.exists && pinDoc.get('adminId') === adminId) tx.delete(pinRef);
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
