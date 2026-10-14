#!/usr/bin/env node
/**
 * Getting a main admin back in after a forgotten PIN (dispatch 38).
 *
 *   node scripts/export-firestore.mjs                 (first, as before every write)
 *   node scripts/admin-recover.mjs <name>             (dry run: says what it would do)
 *   node scripts/admin-recover.mjs <name> --write     (does it)
 *
 * Or set that main admin's own PIN directly (Kian's approval of 2026-10-14),
 * the PIN in NEW_ADMIN_PIN, never on the command line, where the shell's
 * history would keep it:
 *
 *   read -rs NEW_ADMIN_PIN && export NEW_ADMIN_PIN    (typed unseen)
 *   node scripts/admin-recover.mjs <name> --set-pin           (dry run: every check, nothing written)
 *   node scripts/admin-recover.mjs <name> --set-pin --write   (sets it)
 *   unset NEW_ADMIN_PIN
 *
 * --set-pin runs every check the app runs when a PIN is set, in one
 * transaction (scripts/admin-pin-rules.mjs): four digits; not on the
 * too-easy list; not ADMIN_PIN (as .env.local holds it); not another admin's
 * PIN; not any cleaner code ever issued. Any failure is refused with its
 * reason and writes nothing. Otherwise the PIN is stored readably, its index
 * entry written, the admin's old entry removed, "pin_changed" by the recovery
 * script recorded in their history, and their session epoch moved, so every
 * session they hold ends. The PIN is never printed. An argument that looks
 * like a PIN is refused without being echoed.
 *
 * It puts that main admin back on the shared PIN — ADMIN_PIN, as set in
 * Vercel Production (and .env.local) — and ends every session they hold.
 * Their old PIN stops working at once: its index entry, `admin_pins/{PIN}`
 * (four digits, the night's six, or the evening's lookup key), is deleted
 * with it. They then sign in with the shared PIN alone and set their own
 * four digits before anything else (Kian's rulings of 2026-10-13: the shared
 * PIN stays only as the recovery script's PIN; his own account comes back
 * this way, and Set your PIN takes four digits).
 *
 * Only for a main admin: an admin who forgets their PIN is given a new one by
 * a main admin on the Admins page. And only while no other main admin is on
 * the shared PIN: the shared PIN signs in the one main admin on it, so two
 * would leave it unable to say which.
 *
 * It needs the service account in .env.local, which only Kian holds. It
 * prints no PIN and writes none; the PIN it reads is only the old one's index
 * entry, to delete it. The write is one transaction, and the admin's history
 * records it as the recovery script's.
 * A connection locked by five wrong PINs stays locked until its fifteen
 * minutes end, and one locked by twenty tries in a Toronto day until a main
 * admin lifts it on the Admins page, signed in from another connection; this
 * script does not touch locks.
 *
 * If ADMIN_PIN is no longer set in Vercel, set it (four digits: sign-in takes
 * four) and redeploy before signing in: the shared PIN is whatever the server
 * has.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cert, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { setOwnPin } from './admin-pin-rules.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const write = args.includes('--write');
const setPin = args.includes('--set-pin');
const USAGE = 'Usage: node scripts/admin-recover.mjs <name> [--set-pin] [--write], with --set-pin reading the PIN from NEW_ADMIN_PIN';
// A PIN never goes on the command line. Such an argument is refused, and never echoed (the name is, below).
if (args.some((a) => /[0-9]{4}/.test(a))) {
  console.error('A PIN never goes on the command line: --set-pin reads it from NEW_ADMIN_PIN. Nothing was changed.');
  process.exit(2);
}
if (args.some((a) => a.startsWith('-') && a !== '--write' && a !== '--set-pin')) {
  console.error(`Unknown option. ${USAGE}. Nothing was changed.`);
  process.exit(2);
}
const name = args.filter((a) => a !== '--write' && a !== '--set-pin').join(' ').trim();
if (!name) {
  console.error(USAGE);
  process.exit(2);
}
const newPin = setPin ? (process.env.NEW_ADMIN_PIN ?? '') : null;
if (setPin && newPin === '') {
  console.error('--set-pin reads the new PIN from NEW_ADMIN_PIN, which is not set (read -rs NEW_ADMIN_PIN && export NEW_ADMIN_PIN). Nothing was changed.');
  process.exit(2);
}

// The same key the server matches names by (app/lib/admins/model.ts: nameKeyOf).
const nameKey = name.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
// The ID of a PIN's index document: the PIN itself (four digits, or the night's six), or the evening's lookup key.
const READABLE = /^(?:[0-9]{4}|[0-9]{6})$/;
const LOOKUP = /^[0-9a-f]{64}$/;

const env = {};
for (const line of readFileSync(join(ROOT, '.env.local'), 'utf8').split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const eq = line.indexOf('=');
  if (eq < 1) continue;
  let v = line.slice(eq + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  env[line.slice(0, eq).trim()] = v;
}
if (!env.FIREBASE_SERVICE_ACCOUNT_KEY) {
  console.error('FIREBASE_SERVICE_ACCOUNT_KEY is not set in .env.local');
  process.exit(2);
}
initializeApp({ credential: cert(JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_KEY)) });
const db = getFirestore();

const nameDoc = await db.collection('admin_names').doc(nameKey).get();
const adminId = nameDoc.exists ? nameDoc.get('adminId') : null;
if (typeof adminId !== 'string') {
  console.error(`No admin is named "${name}". Nothing was changed.`);
  process.exit(1);
}
const ref = db.collection('admins').doc(adminId);
const before = await ref.get();
if (!before.exists) {
  console.error(`The name "${name}" points at admins/${adminId}, which does not exist. Nothing was changed.`);
  process.exit(1);
}
const data = before.data();
console.log(`admins/${adminId}: ${data.name}, level ${data.level}, PIN ${data.pin?.state ?? 'none'}, session epoch ${data.sessionEpoch}`);
if (data.level !== 'main') {
  console.error(`${data.name} is not a main admin: a main admin gives them a new PIN on the Admins page. Nothing was changed.`);
  process.exit(1);
}

// ── --set-pin: the main admin's own PIN, set directly ──
if (setPin) {
  const sharedPin = env.ADMIN_PIN ?? '';
  if (!/^[0-9]{4}$/.test(sharedPin)) {
    console.error('ADMIN_PIN in .env.local is not four digits, so the new PIN cannot be checked against it. Nothing was changed.');
    process.exit(2);
  }
  const at = new Date().toISOString();
  const outcome = await db.runTransaction((tx) => setOwnPin(db, tx, { adminId, pin: newPin, sharedPin, at, write }));
  if (outcome.kind === 'refused') {
    console.error(`Refused: ${outcome.reason} Nothing was changed.`);
    process.exit(1);
  }
  if (outcome.kind === 'checked') {
    console.log('Dry run: every check passed (four digits, not too easy, not ADMIN_PIN, no other admin’s PIN, never a cleaner code). With --write, it becomes their PIN, stored readably, and every session they hold ends.');
    process.exit(0);
  }
  const after = (await ref.get()).data();
  console.log(`Done: PIN ${after.pin?.state} (was ${outcome.from || 'none'}), session epoch ${after.sessionEpoch}, its index entry written${outcome.freed ? ', the old one deleted' : ''}, "pin_changed" by the recovery script in the history.`);
  console.log('Sign in with the new PIN alone.');
  process.exit(0);
}

/** Other main admins on the shared PIN: with one, the shared PIN could not say which of the two is signing in. */
const othersOnShared = async (read) =>
  (await read(db.collection('admins').where('pin.state', '==', 'shared'))).docs.filter((doc) => doc.id !== adminId && doc.get('level') === 'main').map((doc) => doc.get('name'));
const already = await othersOnShared((q) => q.get());
if (already.length > 0) {
  console.error(`${already.join(', ')} ${already.length === 1 ? 'is' : 'are'} on the shared PIN already: sign in with it first and set a PIN, then run this again. Nothing was changed.`);
  process.exit(1);
}
if (!write) {
  console.log('Dry run: with --write, this admin goes back to the shared PIN, their old PIN stops working and every session they hold ends.');
  process.exit(0);
}

const at = new Date().toISOString();
const freed = await db.runTransaction(async (tx) => {
  const snap = await tx.get(ref);
  if (!snap.exists) throw new Error('the admin was removed meanwhile');
  const others = await othersOnShared((q) => tx.get(q));
  if (others.length > 0) throw new Error(`${others.join(', ')} went on the shared PIN meanwhile`);
  const fresh = snap.data();
  const indexId =
    fresh.pin?.state === 'readable' && typeof fresh.pin.value === 'string' && READABLE.test(fresh.pin.value)
      ? fresh.pin.value
      : fresh.pin?.state === 'set' && typeof fresh.pin.lookup === 'string' && LOOKUP.test(fresh.pin.lookup)
        ? fresh.pin.lookup
        : null;
  const indexRef = indexId ? db.collection('admin_pins').doc(indexId) : null;
  const index = indexRef ? await tx.get(indexRef) : null;
  const epoch = typeof fresh.sessionEpoch === 'number' ? fresh.sessionEpoch : 0;
  const history = Array.isArray(fresh.history) ? fresh.history : [];
  tx.update(ref, {
    pin: { state: 'shared' },
    pinSetAt: at,
    sessionEpoch: Math.min(epoch + 1, 999_999_999),
    history: [...history, { at, action: 'pin_reset', actor: { role: 'system', id: null, name: 'recovery script' } }],
  });
  if (indexRef && index?.exists && index.get('adminId') === adminId) {
    tx.delete(indexRef);
    return true;
  }
  return false;
});
const after = (await ref.get()).data();
console.log(`Done: PIN ${after.pin?.state}, session epoch ${after.sessionEpoch}${freed ? ', old PIN index entry deleted' : ''}.`);
console.log('Sign in with the shared PIN (ADMIN_PIN in Vercel) alone, then set your own four digits.');
