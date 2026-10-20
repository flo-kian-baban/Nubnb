#!/usr/bin/env node
/**
 * The list of codes never given out (security rule, 2026-10-19): every code or PIN ever issued — the cleaner_codes
 * index (current and retired), every account's current code, the codes in the accounts' histories, the admin PIN index,
 * the admins' readable PINs and the shared PIN — whose four digits appear anywhere in the repository's git history
 * (every commit's patch and message; every four-digit window of every digit run, so a code inside a longer number
 * counts too). The repository is public, so such a code is known and must never be a cleaner's again.
 *
 *   node scripts/code-denylist.mjs [backups/<folder>]
 *
 * Reads the newest export under ./backups (or the one given) and CLEANER_SESSION_SECRET from .env.local, and prints
 * the environment line to set — CLEANER_CODE_DENYLIST=<hashes> — as HMAC-SHA256 of each code under that key (codes.ts,
 * denylistValue), plus counts. It never prints a code or PIN, and it writes nothing: the line goes into the server's
 * environment (Vercel's project settings and .env.local), never into the repository. Rotating CLEANER_SESSION_SECRET
 * means running this again.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKUPS = path.join(REPO, 'backups');
const folder = process.argv[2] ? path.resolve(REPO, process.argv[2]) : path.join(BACKUPS, fs.readdirSync(BACKUPS).filter((d) => /^\d{4}-\d{2}-\d{2}T/.test(d)).sort().pop() ?? '');
const read = (coll) => {
  const file = path.join(folder, `${coll}.json`);
  if (!fs.existsSync(file)) {
    console.error(`the export ${path.basename(folder)} has no ${coll}.json: refusing to build the list from an incomplete export`);
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
};
const env = Object.fromEntries(fs.readFileSync(path.join(REPO, '.env.local'), 'utf8').split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#')).map((l) => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v]; }));
if (!/^[A-Za-z0-9_-]{43,}$/.test(env.CLEANER_SESSION_SECRET ?? '')) {
  console.error('CLEANER_SESSION_SECRET is not set in .env.local: the hashes need the key the server checks them with');
  process.exit(2);
}
const key = Buffer.from(env.CLEANER_SESSION_SECRET, 'base64url');
const four = (v) => typeof v === 'string' && /^\d{4}$/.test(v);
const issued = new Set();
for (const d of read('cleaner_codes')) if (four(d.id)) issued.add(d.id);
for (const d of read('cleaners')) {
  if (four(d.code)) issued.add(d.code);
  for (const e of d.history ?? []) for (const v of [e.from, e.to]) if ((e.action === 'code_changed' || e.action === 'code_released') && four(v)) issued.add(v);
}
for (const d of read('admin_pins')) if (four(d.id)) issued.add(d.id);
for (const d of read('admins')) if (four(d.pin?.value)) issued.add(d.pin.value);
if (four(env.ADMIN_PIN)) issued.add(env.ADMIN_PIN);
// Every four-digit window of every digit run in every commit's patch and message.
const history = execFileSync('git', ['-C', REPO, 'log', '--all', '-p', '--no-color', '--format=%B'], { encoding: 'utf8', maxBuffer: 1 << 30 });
const seen = new Set();
for (const m of history.matchAll(/\d{4,}/g)) for (let i = 0; i + 4 <= m[0].length; i += 1) seen.add(m[0].slice(i, i + 4));
const denied = [...issued].filter((code) => seen.has(code)).sort();
const hash = (code) => createHmac('sha256', key).update(`nubnb:code-denylist:v1:${code}`, 'utf8').digest('hex');
const value = [...new Set(denied.map(hash))].sort().join(',');
const commits = execFileSync('git', ['-C', REPO, 'rev-list', '--all', '--count'], { encoding: 'utf8' }).trim();
console.error(`history: ${commits} commits, ${Math.round(history.length / 1e6)} MB of patches and messages, ${seen.size} distinct four-digit windows of 10,000`);
console.error(`issued: ${issued.size} codes and PINs ever (export ${path.basename(folder)}); ${denied.length} of them appear in the history and go on the list`);
console.error(`set this in Vercel (Production) and in .env.local, then redeploy; ${denied.length} hash(es), ${value.length} characters:`);
console.log(`CLEANER_CODE_DENYLIST=${value}`);
