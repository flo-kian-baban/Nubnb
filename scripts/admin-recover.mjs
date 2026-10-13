#!/usr/bin/env node
/**
 * Getting a main admin back in after a forgotten PIN (dispatch 38).
 *
 *   node scripts/export-firestore.mjs                 (first, as before every write)
 *   node scripts/admin-recover.mjs <name>             (dry run: says what it would do)
 *   node scripts/admin-recover.mjs <name> --write     (does it)
 *
 * It puts that main admin back on the shared PIN — ADMIN_PIN, as set in
 * Vercel Production (and .env.local) — clears any lock and any count of wrong
 * tries, and ends every session they hold. They sign in with their name and
 * the shared PIN, then set a new six-digit PIN from their name in the header
 * (Change PIN). Kian's ruling of 2026-10-13 made the shared PIN the main
 * admin's until he changes it; this returns a main admin to that state.
 *
 * Only for a main admin: an admin who forgets their PIN is given a new one by
 * a main admin on the Admins page. It needs the service account in
 * .env.local, which only Kian holds; it reads no PIN and no key, writes none,
 * and prints none. The write is one transaction on the admin's document, and
 * the history records it as the recovery script's.
 *
 * If ADMIN_PIN is no longer set in Vercel, set it (four or six digits) and
 * redeploy before signing in: the shared PIN is whatever the server has.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cert, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const write = args.includes('--write');
const name = args.filter((a) => a !== '--write').join(' ').trim();
if (!name) {
  console.error('Usage: node scripts/admin-recover.mjs <name> [--write]');
  process.exit(2);
}

// The same key the server matches names by (app/lib/admins/model.ts: nameKeyOf).
const nameKey = name.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();

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
const lockedUntil = typeof data.lockedUntil === 'string' && Date.parse(data.lockedUntil) > Date.now() ? data.lockedUntil : null;
console.log(`admins/${adminId}: ${data.name}, level ${data.level}, PIN ${data.pin?.state ?? 'none'}, ${lockedUntil ? `locked until ${lockedUntil}` : `${data.failedTries ?? 0} wrong tries`}, session epoch ${data.sessionEpoch}`);
if (data.level !== 'main') {
  console.error(`${data.name} is not a main admin: a main admin gives them a new PIN on the Admins page. Nothing was changed.`);
  process.exit(1);
}
if (!write) {
  console.log('Dry run: with --write, this admin goes back to the shared PIN, any lock is cleared and every session they hold ends.');
  process.exit(0);
}

const at = new Date().toISOString();
await db.runTransaction(async (tx) => {
  const snap = await tx.get(ref);
  if (!snap.exists) throw new Error('the admin was removed meanwhile');
  const fresh = snap.data();
  const epoch = typeof fresh.sessionEpoch === 'number' ? fresh.sessionEpoch : 0;
  const history = Array.isArray(fresh.history) ? fresh.history : [];
  tx.update(ref, {
    pin: { state: 'shared' },
    pinSetAt: at,
    sessionEpoch: Math.min(epoch + 1, 999_999_999),
    failedTries: 0,
    lockedUntil: null,
    history: [...history, { at, action: 'pin_reset', actor: { role: 'system', id: null, name: 'recovery script' } }],
  });
});
const after = (await ref.get()).data();
console.log(`Done: PIN ${after.pin?.state}, ${after.failedTries} wrong tries, locked until ${after.lockedUntil}, session epoch ${after.sessionEpoch}.`);
console.log(`Sign in as ${after.name} with the shared PIN (ADMIN_PIN in Vercel), then choose a new PIN from your name in the header.`);
