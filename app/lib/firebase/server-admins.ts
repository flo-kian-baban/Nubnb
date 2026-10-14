/**
 * Server-side reads and writes of admin accounts (dispatch 38; sign-in by PIN
 * alone since Kian's rulings of 2026-10-13, evening).
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
 *   pin                { state: 'set', scheme: 'lookup-v1', lookup } — the
 *                      lookup key of a PIN Nubnb generated (pin.ts) — or
 *                      { state: 'shared' }: a main admin the recovery script
 *                      put back on ADMIN_PIN. Dispatch 38's first version
 *                      wrote { state: 'own' | 'temporary', salted hash };
 *                      those are read, never written. Never leaves the server.
 *   sessionEpoch       carried by every session token; moved by every new
 *                      PIN, which ends every other session
 *   lastSignedInAt, createdAt, createdBy, history
 *   (failedTries, lockedUntil: the first version's per-admin lock, left as
 *   they are on its documents and read by nothing)
 *
 * `admin_names/{nameKey}` → `{ adminId }` keeps names unique. `admin_pins/
 * {lookup}` → `{ adminId }` finds an admin by PIN and keeps PINs unique.
 * `admin_signin_locks/{keyed hash of the connection}` → `{ failedTries,
 * lockedUntil, lastFailedAt }`: five wrong PINs from one connection lock
 * sign-in from it for fifteen minutes (model.ts, afterTry). The address
 * itself is never stored.
 *
 * ── The shared PIN ──
 * ADMIN_PIN signs in only a main admin on `{ state: 'shared' }`, and only
 * when exactly one is; that sign-in gives them a generated PIN in the same
 * transaction, shown once. When no admin exists at all, it makes the first
 * main admin, Kian, the same way. Otherwise it is a wrong PIN like any other.
 *
 * ── Writes ──
 * Every change is a transaction that reads first and writes after; history
 * is appended by reading the array, never with arrayUnion. A PIN's lookup
 * needs a scrypt, so a new PIN is drawn and hashed before its transaction,
 * and drawn again in the rare case that another admin holds it.
 *
 * Failure contract: signIn, renewOwnPin and readSessionAdmin never throw — a
 * failed read is `unavailable`, and access is never granted on an error.
 * Everything else throws when Firestore fails, and the route says the change
 * may or may not have been saved. Errors are logged as a gRPC code only.
 */

import { timingSafeEqual } from 'crypto';
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
import { PIN_LOOKUP_SCHEME, drawPin, pinLookup, pinMatches, sharedPinLength, sharedPinMatches } from '@/app/lib/admins/pin';
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

/** Draws of a new PIN before giving up: each collision with a held PIN is one in about a million per admin. */
const MAX_DRAWS = 5;

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

/** The lookup key a 'set' PIN is kept under, or null. */
function lookupOf(pin: unknown): string | null {
  if (pinStateOf(pin) !== 'set') return null;
  const lookup = (pin as Record<string, unknown>).lookup;
  return typeof lookup === 'string' && LOCK_ID.test(lookup) ? lookup : null;
}

const sameKey = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

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

/** A row of the Admins page, from a stored document: never a PIN, its lookup key or hash, nor the epoch. */
export function readAdminSummary(id: string, data: Record<string, unknown>): AdminSummary {
  return {
    id,
    name: text(data.name),
    level: text(data.level),
    pin: pinStateOf(data.pin) ?? (data.pin === undefined ? null : 'unreadable'),
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

/** A new PIN and its lookup key, worked out before a transaction (the scrypt is slow). */
async function draw(pinKey: Buffer): Promise<{ pin: string; lookup: string }> {
  const pin = drawPin();
  return { pin, lookup: await pinLookup(pinKey, pin) };
}

/** The `pin` field of a generated PIN. */
const setPin = (lookup: string) => ({ state: 'set', scheme: PIN_LOOKUP_SCHEME, lookup });

// ─── The session check ─────────────────────────────────────────

export type SessionAdminRead = { kind: 'valid'; admin: SignedInAdmin } | { kind: 'invalid' } | { kind: 'unavailable' };

/**
 * The admin a session token names, if they still exist on the token's epoch.
 * One read, of four fields; never the PIN's lookup key or hash.
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

/** A wrong PIN, counted against its connection inside the transaction; the answer to give. */
function countWrong(tx: Transaction, lockRef: DocumentReference, lock: LockState, nowMs: number): { kind: 'wrong'; triesLeft: number } | { kind: 'locked'; lockedUntil: string; now: boolean } {
  const outcome = afterTry(lock, false, nowMs);
  tx.set(lockRef, { ...outcome.next, lastFailedAt: new Date(nowMs).toISOString() });
  if (outcome.kind === 'locked-now') {
    console.log(`[admins] sign-in locked after ${MAX_WRONG_TRIES} wrong PINs from one connection, until ${outcome.lockedUntil}`);
    return { kind: 'locked', lockedUntil: outcome.lockedUntil, now: true };
  }
  return { kind: 'wrong', triesLeft: outcome.kind === 'wrong' ? outcome.triesLeft : 0 };
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
  /** `newPin`: generated now, by a sign-in with the shared PIN; shown once, stored nowhere. */
  | { kind: 'signed-in'; admin: SignedInAdmin; newPin: string | null }
  /** No admin holds that PIN; `triesLeft` before this connection's lock. */
  | { kind: 'wrong'; triesLeft: number }
  /** Sign-in from this connection is locked until `lockedUntil`; `now` when this PIN was the fifth. */
  | { kind: 'locked'; lockedUntil: string; now: boolean }
  /** The shared PIN, with more than one main admin on it: it cannot say which. */
  | { kind: 'shared-ambiguous' }
  | { kind: 'not-configured' }
  | { kind: 'unavailable' };

/**
 * Sign in by PIN alone (Kian's ruling: the PIN identifies the admin). A
 * locked connection is refused before any hash is worked out. Otherwise the
 * PIN's lookup key finds its admin in one read; a PIN no admin holds counts
 * against the connection, and the fifth in a row locks it for fifteen
 * minutes. The shared PIN signs in the one main admin on it, or makes the
 * first main admin of an empty database, and gives them a generated PIN.
 *
 * The answer's timing never says whether a PIN was the shared one: every
 * PIN of the shared PIN's length that no admin holds reads the main admins
 * the same way, and a new PIN is drawn (a scrypt) only once a sign-in by the
 * shared PIN is certain, in a second pass of the transaction.
 */
export async function signIn(pin: string, connection: string, nowMs: number = Date.now()): Promise<SignInResult> {
  const pinKey = getAdminPinKey();
  if (!pinKey) return { kind: 'not-configured' };
  const nowIso = new Date(nowMs).toISOString();
  try {
    const db = getAdminDb();
    const lockRef = db.collection(ADMIN_SIGNIN_LOCKS_COLLECTION).doc(connection);
    const before = await lockRef.get();
    const holding = before.exists ? lockHolding(lockStateOf(before.data()), nowMs) : null;
    if (holding) return { kind: 'locked', lockedUntil: holding, now: false };

    const lookup = PIN_PATTERN.test(pin) ? await pinLookup(pinKey, pin) : null;
    const shared = sharedPinMatches(pin) === true;
    const sharedShape = pin.length === sharedPinLength();
    let fresh: { pin: string; lookup: string } | null = null;

    // One pass more than the draws: the first sign-in by the shared PIN learns it needs one.
    for (let attempt = 0; attempt <= MAX_DRAWS; attempt++) {
      const drawn = fresh;
      const outcome = await db.runTransaction(async (tx) => {
        // ── Reads ──
        const lockSnap = await tx.get(lockRef);
        const lock = lockStateOf(lockSnap.data());
        const locked = lockHolding(lock, nowMs);
        if (locked) return { kind: 'locked' as const, lockedUntil: locked, now: false };

        let via: 'pin' | 'shared' | 'first' | null = null;
        let adminRef: DocumentReference | null = null;
        let adminData: Record<string, unknown> = {};
        if (lookup) {
          const index = await tx.get(db.collection(ADMIN_PINS_COLLECTION).doc(lookup));
          const id = index.exists ? text(index.get('adminId')) : null;
          if (id && isDocumentId(id)) {
            const snap = await tx.get(db.collection(ADMINS_COLLECTION).doc(id));
            const held = snap.exists ? lookupOf(snap.get('pin')) : null;
            if (held && sameKey(held, lookup)) {
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
        if (via === 'shared' || via === 'first') {
          // Only now is a new PIN worth its scrypt: drawn outside, then this pass again.
          if (!drawn) return { kind: 'draw' as const };
          if ((await tx.get(db.collection(ADMIN_PINS_COLLECTION).doc(drawn.lookup))).exists) return { kind: 'draw' as const };
        }

        // ── Writes ──
        if (!via) return countWrong(tx, lockRef, lock, nowMs);
        if (lockSnap.exists) tx.delete(lockRef);
        if (via === 'pin' && adminRef) {
          tx.update(adminRef, { lastSignedInAt: nowIso });
          return { kind: 'in' as const, id: adminRef.id, data: adminData, epoch: epochOf(adminData), newPin: null };
        }
        if (via === 'shared' && adminRef && drawn) {
          const epoch = Math.min(epochOf(adminData) + 1, MAX_TOKEN_EPOCH);
          const event: AdminHistoryEvent = { at: nowIso, action: 'pin_generated', actor: { role: 'admin', id: adminRef.id, name: text(adminData.name) }, from: 'shared' };
          const update = { pin: setPin(drawn.lookup), pinSetAt: nowIso, sessionEpoch: epoch, lastSignedInAt: nowIso, history: [...historyOf(adminData), event] };
          tx.update(adminRef, update);
          tx.create(db.collection(ADMIN_PINS_COLLECTION).doc(drawn.lookup), { adminId: adminRef.id, createdAt: nowIso });
          console.log(`[admins] ${adminRef.id} signed in with the shared PIN and was given a generated PIN`);
          return { kind: 'in' as const, id: adminRef.id, data: { ...adminData, ...update }, epoch, newPin: drawn.pin };
        }
        if (via !== 'first' || !drawn) return { kind: 'unavailable' as const };
        // The first main admin of an empty database.
        const ref = db.collection(ADMINS_COLLECTION).doc();
        const name = FIRST_MAIN_ADMIN_NAME;
        const stored = {
          schemaVersion: ADMIN_SCHEMA_VERSION,
          name,
          nameKey: nameKeyOf(name),
          level: 'main',
          pin: setPin(drawn.lookup),
          pinSetAt: nowIso,
          sessionEpoch: 1,
          lastSignedInAt: nowIso,
          createdAt: nowIso,
          createdBy: FIRST_SIGN_IN,
          history: [{ at: nowIso, action: 'created', actor: FIRST_SIGN_IN, to: 'main' } satisfies AdminHistoryEvent],
        };
        tx.create(ref, stored);
        tx.create(firstNameRef, { adminId: ref.id, name, createdAt: nowIso });
        tx.create(db.collection(ADMIN_PINS_COLLECTION).doc(drawn.lookup), { adminId: ref.id, createdAt: nowIso });
        console.log(`[admins] first main admin created: ${ref.id}`);
        return { kind: 'in' as const, id: ref.id, data: stored as Record<string, unknown>, epoch: 1, newPin: drawn.pin };
      });
      if (outcome.kind === 'draw') {
        fresh = await draw(pinKey);
        continue;
      }
      if (outcome.kind !== 'in') return outcome;
      const admin = signedIn(outcome.id, outcome.data, outcome.epoch);
      return admin ? { kind: 'signed-in', admin, newPin: outcome.newPin } : { kind: 'unavailable' };
    }
    return { kind: 'unavailable' };
  } catch (err) {
    console.error(`[admins] sign-in failed: grpc code ${grpcCode(err)}`);
    return { kind: 'unavailable' };
  }
}

// ─── An admin's own PIN and name ───────────────────────────────

export type RenewPinResult =
  | { kind: 'renewed'; admin: SignedInAdmin; newPin: string }
  /** The current PIN typed was wrong: it counts against the connection like a sign-in. */
  | { kind: 'wrong'; triesLeft: number }
  | { kind: 'locked'; lockedUntil: string; now: boolean }
  /** The session's admin is gone or on another epoch. */
  | { kind: 'session-ended' }
  | { kind: 'not-configured' }
  | { kind: 'unavailable' };

/**
 * New PIN, from an admin's own menu: their current PIN, checked against their
 * own document — a generated PIN by its lookup key, the shared PIN, or a PIN
 * of dispatch 38's first version by its salted hash — then a generated one,
 * shown once. Every other session they hold ends; the caller gives this
 * browser a new token on the new epoch.
 */
export async function renewOwnPin(admin: SignedInAdmin, currentPin: string, connection: string, nowMs: number = Date.now()): Promise<RenewPinResult> {
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
    const data = snap.data() ?? {};
    const state = pinStateOf(data.pin);
    const held = lookupOf(data.pin);
    let right = false;
    if (state === 'set' && held) right = PIN_PATTERN.test(currentPin) && sameKey(await pinLookup(pinKey, currentPin), held);
    else if (state === 'shared') right = sharedPinMatches(currentPin) === true;
    else if (state === 'own' || state === 'temporary') right = PIN_PATTERN.test(currentPin) && (await pinMatches(pinKey, data.pin, currentPin));

    let fresh = await draw(pinKey);
    for (let attempt = 0; attempt < MAX_DRAWS; attempt++) {
      const drawn = fresh;
      const outcome = await db.runTransaction(async (tx) => {
        const lockSnap = await tx.get(lockRef);
        const lock = lockStateOf(lockSnap.data());
        const locked = lockHolding(lock, nowMs);
        if (locked) return { kind: 'locked' as const, lockedUntil: locked, now: false };
        const current = await tx.get(ref);
        // Every PIN change moves the epoch: the same epoch means the PIN checked is still the one stored.
        if (!current.exists || current.get('sessionEpoch') !== admin.sessionEpoch) return { kind: 'session-ended' as const };
        const taken = await tx.get(db.collection(ADMIN_PINS_COLLECTION).doc(drawn.lookup));
        const oldRef = held ? db.collection(ADMIN_PINS_COLLECTION).doc(held) : null;
        const oldIndex = oldRef ? await tx.get(oldRef) : null;
        if (!right) return countWrong(tx, lockRef, lock, nowMs);
        if (taken.exists) return { kind: 'redraw' as const };
        const fresher = current.data() ?? {};
        const epoch = Math.min(admin.sessionEpoch + 1, MAX_TOKEN_EPOCH);
        const event: AdminHistoryEvent = { at: nowIso, action: 'pin_generated', actor: { role: 'admin', id: admin.id, name: admin.name }, from: state ?? '' };
        tx.update(ref, { pin: setPin(drawn.lookup), pinSetAt: nowIso, sessionEpoch: epoch, history: [...historyOf(fresher), event] });
        tx.create(db.collection(ADMIN_PINS_COLLECTION).doc(drawn.lookup), { adminId: admin.id, createdAt: nowIso });
        if (oldRef && oldIndex?.exists && oldIndex.get('adminId') === admin.id) tx.delete(oldRef);
        if (lockSnap.exists) tx.delete(lockRef);
        return { kind: 'renewed' as const, epoch };
      });
      if (outcome.kind === 'redraw') {
        fresh = await draw(pinKey);
        continue;
      }
      if (outcome.kind !== 'renewed') return outcome;
      return { kind: 'renewed', admin: { ...admin, pin: 'set', sessionEpoch: outcome.epoch }, newPin: drawn.pin };
    }
    return { kind: 'unavailable' };
  } catch (err) {
    console.error(`[admins] new PIN failed: grpc code ${grpcCode(err)}`);
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

/** Every admin, oldest first. THROWS when the read fails; never an empty list for a failure. */
export async function listAdmins(): Promise<AdminSummary[]> {
  const db = getAdminDb();
  const snap = await db.collection(ADMINS_COLLECTION).select('name', 'level', 'pin.state', 'lastSignedInAt', 'createdAt', 'createdBy', 'history').get();
  return snap.docs
    .map((doc) => readAdminSummary(doc.id, doc.data()))
    .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id));
}

export type CreateAdminResult = { kind: 'created'; admin: AdminSummary; pin: string } | { kind: 'name-taken' };

/**
 * Add an admin, with a PIN Nubnb generates (Kian's ruling: never chosen),
 * returned to be shown once to the main admin and stored nowhere. The name
 * must be free, case and spacing aside. THROWS when Firestore fails.
 */
export async function createAdmin(actor: Actor, input: { name: string; level: AdminLevel }, pinKey: Buffer): Promise<CreateAdminResult> {
  const name = cleanAdminName(input.name);
  const key = nameKeyOf(name);
  const db = getAdminDb();
  const nameRef = db.collection(ADMIN_NAMES_COLLECTION).doc(key);
  for (let attempt = 0; attempt < MAX_DRAWS; attempt++) {
    const drawn = await draw(pinKey);
    const nowIso = new Date().toISOString();
    const ref = db.collection(ADMINS_COLLECTION).doc();
    const stored = {
      schemaVersion: ADMIN_SCHEMA_VERSION,
      name,
      nameKey: key,
      level: input.level,
      pin: setPin(drawn.lookup),
      pinSetAt: nowIso,
      sessionEpoch: 1,
      lastSignedInAt: null,
      createdAt: nowIso,
      createdBy: actor,
      history: [{ at: nowIso, action: 'created', actor, to: input.level } satisfies AdminHistoryEvent],
    };
    const outcome = await db.runTransaction(async (tx) => {
      const existing = await tx.get(nameRef);
      const taken = await tx.get(db.collection(ADMIN_PINS_COLLECTION).doc(drawn.lookup));
      if (existing.exists) return 'name-taken' as const;
      if (taken.exists) return 'redraw' as const;
      tx.create(ref, stored);
      tx.create(nameRef, { adminId: ref.id, name, createdAt: nowIso });
      tx.create(db.collection(ADMIN_PINS_COLLECTION).doc(drawn.lookup), { adminId: ref.id, createdAt: nowIso });
      return 'created' as const;
    });
    if (outcome === 'name-taken') return { kind: 'name-taken' };
    if (outcome === 'created') return { kind: 'created', admin: readAdminSummary(ref.id, stored), pin: drawn.pin };
  }
  throw Object.assign(new Error('no free PIN drawn'), { code: 'NO_FREE_PIN' });
}

export type AdminChangeResult =
  | { kind: 'done'; admin: AdminSummary; changed: boolean }
  | { kind: 'not-found' }
  /** A new PIN for oneself: that is New PIN, from one's name in the header. */
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

export type ResetPinResult = { kind: 'done'; admin: AdminSummary; pin: string } | { kind: 'not-found' } | { kind: 'yourself' } | { kind: 'main-admin' };

/**
 * New PIN for an ordinary admin, from the main admin's Admins page: a
 * generated one, returned to be shown once. Their sessions end. Never a main
 * admin's (Kian's ruling of 2026-10-13: theirs alone), and never one's own.
 * THROWS when Firestore fails.
 */
export async function resetAdminPin(actor: Actor, adminId: string, pinKey: Buffer): Promise<ResetPinResult> {
  if (adminId === actor.id) return { kind: 'yourself' };
  if (!isDocumentId(adminId)) return { kind: 'not-found' };
  const db = getAdminDb();
  const ref = db.collection(ADMINS_COLLECTION).doc(adminId);
  for (let attempt = 0; attempt < MAX_DRAWS; attempt++) {
    const drawn = await draw(pinKey);
    const nowIso = new Date().toISOString();
    const outcome = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { kind: 'not-found' as const };
      const data = snap.data() ?? {};
      const taken = await tx.get(db.collection(ADMIN_PINS_COLLECTION).doc(drawn.lookup));
      const held = lookupOf(data.pin);
      const oldRef = held ? db.collection(ADMIN_PINS_COLLECTION).doc(held) : null;
      const oldIndex = oldRef ? await tx.get(oldRef) : null;
      const verdict = accountVerdict('new-pin', { self: false, targetIsMain: data.level === 'main' }, 0);
      if (verdict === 'main-admin') return { kind: 'main-admin' as const };
      if (taken.exists) return { kind: 'redraw' as const };
      const event: AdminHistoryEvent = { at: nowIso, action: 'pin_reset', actor };
      const update = { pin: setPin(drawn.lookup), pinSetAt: nowIso, sessionEpoch: Math.min(epochOf(data) + 1, MAX_TOKEN_EPOCH), history: [...historyOf(data), event] };
      tx.update(ref, update);
      tx.create(db.collection(ADMIN_PINS_COLLECTION).doc(drawn.lookup), { adminId, createdAt: nowIso });
      if (oldRef && oldIndex?.exists && oldIndex.get('adminId') === adminId) tx.delete(oldRef);
      return { kind: 'done' as const, admin: readAdminSummary(adminId, { ...data, ...update }) };
    });
    if (outcome.kind === 'redraw') continue;
    if (outcome.kind === 'done') return { ...outcome, pin: drawn.pin };
    return outcome;
  }
  throw Object.assign(new Error('no free PIN drawn'), { code: 'NO_FREE_PIN' });
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
    const held = lookupOf(data.pin);
    const pinRef = held ? db.collection(ADMIN_PINS_COLLECTION).doc(held) : null;
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
