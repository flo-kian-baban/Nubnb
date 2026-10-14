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

import { timingSafeEqual } from 'node:crypto';

/** Four digits (Kian's rulings of 2026-10-13, late night). */
export const PIN_PATTERN = /^[0-9]{4}$/;

const runsIn = (digits) => Array.from({ length: digits.length - 3 }, (_, start) => digits.slice(start, start + 4));

/** The cleaner codes' reserved list (app/lib/cleaners/model.ts): 0000 … 9999, 0123 … 6789 and 9876 … 3210. */
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

/** Why `pin` cannot be an admin's own from the PIN alone — not four digits, too easy, the shared PIN — or null. */
export function pinShapeProblem(pin, sharedPin) {
  if (typeof pin !== 'string' || !PIN_PATTERN.test(pin)) return 'Not four digits.';
  if (TOO_EASY.has(pin)) return 'Too easy to guess: it is on the list cleaner codes refuse.';
  if (typeof sharedPin === 'string' && samePin(pin, sharedPin)) return 'That is the shared PIN (ADMIN_PIN), which is never an admin’s own.';
  return null;
}

const MAX_TOKEN_EPOCH = 999_999_999;

/** Who the history names for the script's changes. */
export const RECOVERY_SCRIPT = { role: 'system', id: null, name: 'recovery script' };

/**
 * Set main admin `adminId`'s own PIN inside transaction `tx`, after every
 * check the app runs when a PIN is set: four digits, not too easy, not the
 * shared PIN, not another admin's PIN, not any cleaner code ever issued,
 * current or retired (Kian's rulings of 2026-10-13, late night). Every read
 * comes before the first write, as a transaction requires, and a refusal
 * writes nothing. With `write` false it stops after the checks: the dry run.
 *
 * On success the PIN is stored readably, its `admin_pins` entry is created
 * (refused whole if one appeared meanwhile), the admin's old entry is deleted
 * if it still names them, `pin_changed` by the recovery script goes into
 * their history, and their session epoch moves, so every session they hold
 * ends — what the app's own PIN change writes.
 *
 * Returns { kind: 'refused', reason } | { kind: 'checked' } | { kind: 'set', from, epoch, freed }.
 */
export async function setOwnPin(db, tx, { adminId, pin, sharedPin, at, write }) {
  const shape = pinShapeProblem(pin, sharedPin);
  if (shape) return { kind: 'refused', reason: shape };

  const ref = db.collection('admins').doc(adminId);
  const newRef = db.collection('admin_pins').doc(pin);
  const snap = await tx.get(ref);
  const takenByAdmin = await tx.get(newRef);
  const takenByCode = await tx.get(db.collection('cleaner_codes').doc(pin));
  if (!snap.exists) return { kind: 'refused', reason: 'The admin is gone.' };
  const data = snap.data() ?? {};
  const oldId = indexIdOf(data.pin);
  const oldRef = oldId ? db.collection('admin_pins').doc(oldId) : null;
  const oldIndex = oldRef ? await tx.get(oldRef) : null;

  if (data.level !== 'main') return { kind: 'refused', reason: 'Not a main admin: a main admin sets their PIN on the Admins page.' };
  if (data.pin?.state === 'readable' && typeof data.pin.value === 'string' && samePin(data.pin.value, pin)) return { kind: 'refused', reason: 'That is their PIN already.' };
  if (takenByAdmin.exists) return { kind: 'refused', reason: takenByAdmin.get('adminId') === adminId ? 'Its index entry names them already, though their document holds another PIN.' : 'Another admin’s PIN.' };
  if (takenByCode.exists) return { kind: 'refused', reason: takenByCode.get('retiredAt') == null ? 'A current cleaner code.' : 'A retired cleaner code: no admin PIN may equal a code ever issued.' };
  if (!write) return { kind: 'checked' };

  const epoch = Math.min((typeof data.sessionEpoch === 'number' ? data.sessionEpoch : 0) + 1, MAX_TOKEN_EPOCH);
  const from = viewStateOf(data.pin) ?? '';
  const history = Array.isArray(data.history) ? data.history : [];
  tx.update(ref, { pin: { state: 'readable', value: pin }, pinSetAt: at, sessionEpoch: epoch, history: [...history, { at, action: 'pin_changed', actor: RECOVERY_SCRIPT, from }] });
  tx.create(newRef, { adminId, createdAt: at });
  const freed = Boolean(oldRef && oldIndex?.exists && oldIndex.get('adminId') === adminId);
  if (freed) tx.delete(oldRef);
  return { kind: 'set', from, epoch, freed };
}
