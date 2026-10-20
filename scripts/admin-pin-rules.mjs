/**
 * What the app checks when an admin PIN is set, for the recovery script's
 * --set-pin (scripts/admin-recover.mjs), which cannot import the app's
 * TypeScript. Kian's approval of 2026-10-14: the script sets a main admin's
 * own PIN directly, with every check the app runs, in one transaction.
 *
 * tests/admins/recover-pin.mjs proves these rules give the app's verdict —
 * PIN_PATTERN and pinProblem in app/lib/admins/model.ts, samePin and the
 * shared PIN's check in app/lib/admins/pin.ts — for every four-digit PIN, and
 * runs setOwnPin against an in-memory stand-in for Firestore.
 *
 * Nothing here reads the environment or prints, and no reason it gives holds
 * the PIN.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Four digits (Kian's rulings of 2026-10-13, late night). */
export const PIN_PATTERN = /^[0-9]{4}$/;

const runsIn = (digits) => Array.from({ length: digits.length - 3 }, (_, start) => digits.slice(start, start + 4));

/** The easy list (app/lib/cleaners/model.ts): the ten same-digit codes, the seven ascending runs and the seven descending runs. Admin PINs refuse it; cleaner codes no longer do (2026-10-17). */
export const TOO_EASY = new Set([...'0123456789'.split('').map((digit) => digit.repeat(4)), ...runsIn('0123456789'), ...runsIn('9876543210')]);

/** Whether two PINs are the same, in constant time, as app/lib/admins/pin.ts compares them. */
export function samePin(a, b) {
  const x = Buffer.from(a.padEnd(8, '\0'), 'utf8');
  const y = Buffer.from(b.padEnd(8, '\0'), 'utf8');
  return x.length === y.length && timingSafeEqual(x, y) && a.length === b.length;
}

/** The `admin_pins` ID a stored PIN is kept under — four digits, the night's six, or the evening's lookup key — or null. */
export function indexIdOf(pin) {
  if (pin?.state === 'readable' && typeof pin.value === 'string' && /^(?:[0-9]{4}|[0-9]{6})$/.test(pin.value)) return pin.value;
  if (pin?.state === 'set' && typeof pin.lookup === 'string' && /^[0-9a-f]{64}$/.test(pin.lookup)) return pin.lookup;
  return null;
}

/** A stored PIN's state as the app shows it: a readable one that is not four digits (the night's six) is "set". */
export function viewStateOf(pin) {
  const state = typeof pin?.state === 'string' ? pin.state : null;
  return state === 'readable' && !(typeof pin.value === 'string' && PIN_PATTERN.test(pin.value)) ? 'set' : state;
}

/** Why `pin` cannot be an admin's own from the PIN alone — not four digits, too easy, the shared PIN — in one plain line, or null. */
export function pinShapeProblem(pin, sharedPin) {
  if (typeof pin !== 'string' || !PIN_PATTERN.test(pin)) return 'A PIN is four digits.';
  if (TOO_EASY.has(pin)) return 'Too easy to guess: four of one digit, or a straight run.';
  if (typeof sharedPin === 'string' && samePin(pin, sharedPin)) return 'That is the shared PIN (ADMIN_PIN), which is never an admin’s own.';
  return null;
}

/** One Firestore document ID, as app/lib/firebase/server-leads.ts's isDocumentId reads it. */
const isDocumentId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 1500 && !id.includes('/') && id !== '.' && id !== '..' && !/^__.*__$/.test(id);

const MAX_TOKEN_EPOCH = 999_999_999;

/** Who the history names for the script's changes. */
export const RECOVERY_SCRIPT = { role: 'system', id: null, name: 'recovery script' };

/**
 * Set main admin `adminId`'s own PIN inside transaction `tx`, after every
 * check the app runs when a PIN is set: four digits, not too easy, not the
 * shared PIN, not another admin's PIN now, not any cleaner code ever issued,
 * current or retired (Kian's rulings of 2026-10-13, late night). A PIN no
 * admin holds any more may be set again (Kian's ruling of 2026-10-17): an
 * `admin_pins` entry counts only while the admin it names still holds those
 * digits, as the app's pinHeld reads it. Every read comes before the first
 * write, as a transaction requires, and a refusal writes nothing. With
 * `write` false it stops after the checks: the dry run.
 *
 * On success the PIN is stored readably, its `admin_pins` entry is created
 * (refused whole if one appeared meanwhile) or written over one left behind
 * by an admin no longer holding it, the admin's old entry is deleted
 * if it still names them, `pin_changed` by the recovery script goes into
 * their history, and their session epoch moves, so every session they hold
 * ends — what the app's own PIN change writes.
 *
 * Returns { kind: 'refused', reason } | { kind: 'checked' } | { kind: 'set', from, epoch, freed }.
 */
/**
 * The list of codes never given out (security rule, 2026-10-19), as app/lib/cleaners/codes.ts keeps it: HMAC-SHA256 of
 * each value under CLEANER_SESSION_SECRET with this label, comma-separated in CLEANER_CODE_DENYLIST. The same list
 * refuses an admin PIN, with the same sentence (app/lib/admins/pin-denylist.ts).
 */
export const DENYLIST_LABEL = 'nubnb:code-denylist:v1:';
export const PUBLIC_REFUSAL_LINE = "That code has appeared in Nubnb's public code and is never given out.";
export const DENYLIST_UNKEYED_LINE = 'CLEANER_CODE_DENYLIST is set but CLEANER_SESSION_SECRET is not: the list of codes never given out cannot be checked.';
export function denylistHash(value, key) {
  return createHmac('sha256', key).update(`${DENYLIST_LABEL}${value}`, 'utf8').digest('hex');
}
/** The list from the environment: null when not set (or not hashes, as the app reads it); 'unkeyed' when set without the key; else its hashes with the key. */
export function readDenylist(value, secret) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const hashes = value.split(',').map((h) => h.trim()).filter(Boolean);
  if (hashes.length === 0 || !hashes.every((h) => /^[0-9a-f]{64}$/.test(h))) return null;
  if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43,}$/.test(secret)) return 'unkeyed';
  return { hashes: new Set(hashes), key: Buffer.from(secret, 'base64url') };
}
export const isPublicValue = (value, denylist) => !!denylist && denylist !== 'unkeyed' && denylist.hashes.has(denylistHash(value, denylist.key));

export async function setOwnPin(db, tx, { adminId, pin, sharedPin, at, write, denylist = null }) {
  const shape = pinShapeProblem(pin, sharedPin);
  if (shape) return { kind: 'refused', reason: shape };
  // The list of codes never given out (security rule, 2026-10-19): before any read, and failing closed when it cannot be checked.
  if (denylist === 'unkeyed') return { kind: 'refused', reason: DENYLIST_UNKEYED_LINE };
  if (isPublicValue(pin, denylist)) return { kind: 'refused', reason: PUBLIC_REFUSAL_LINE };

  const ref = db.collection('admins').doc(adminId);
  const newRef = db.collection('admin_pins').doc(pin);
  const snap = await tx.get(ref);
  const entry = await tx.get(newRef);
  // The admin the entry names, who must still hold the digits for them to count as taken.
  const entryAdminId = entry.exists ? entry.get('adminId') : null;
  const entryAdmin = isDocumentId(entryAdminId) ? await tx.get(db.collection('admins').doc(entryAdminId)) : null;
  const held = Boolean(entryAdmin?.exists && indexIdOf(entryAdmin.get('pin')) === pin);
  const takenByCode = await tx.get(db.collection('cleaner_codes').doc(pin));
  if (!snap.exists) return { kind: 'refused', reason: 'The admin is gone.' };
  const data = snap.data() ?? {};
  const oldId = indexIdOf(data.pin);
  const oldRef = oldId ? db.collection('admin_pins').doc(oldId) : null;
  const oldIndex = oldRef ? await tx.get(oldRef) : null;

  if (data.level !== 'main') return { kind: 'refused', reason: 'Not a main admin: a main admin sets their PIN on the Admins page.' };
  if (data.pin?.state === 'readable' && typeof data.pin.value === 'string' && samePin(data.pin.value, pin)) return { kind: 'refused', reason: 'That is their PIN already.' };
  if (held) return { kind: 'refused', reason: 'Another admin has that PIN.' };
  if (takenByCode.exists) return { kind: 'refused', reason: takenByCode.get('retiredAt') == null ? 'A current cleaner code.' : 'A retired cleaner code: no admin PIN may equal a code ever issued.' };
  if (!write) return { kind: 'checked' };

  const epoch = Math.min((typeof data.sessionEpoch === 'number' ? data.sessionEpoch : 0) + 1, MAX_TOKEN_EPOCH);
  const from = viewStateOf(data.pin) ?? '';
  const history = Array.isArray(data.history) ? data.history : [];
  tx.update(ref, { pin: { state: 'readable', value: pin }, pinSetAt: at, sessionEpoch: epoch, history: [...history, { at, action: 'pin_changed', actor: RECOVERY_SCRIPT, from }] });
  if (entry.exists) tx.set(newRef, { adminId, createdAt: at });
  else tx.create(newRef, { adminId, createdAt: at });
  const freed = Boolean(oldRef && oldIndex?.exists && oldIndex.get('adminId') === adminId);
  if (freed) tx.delete(oldRef);
  return { kind: 'set', from, epoch, freed };
}
