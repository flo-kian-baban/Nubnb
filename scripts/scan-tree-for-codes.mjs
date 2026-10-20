#!/usr/bin/env node
/**
 * Before every commit (security rule, 2026-10-19): every tracked file of the repository — not only the staged diff —
 * is scanned for the four digits of every CURRENT cleaner code and every admin PIN, read from an export made by
 * scripts/export-firestore.mjs (the newest folder under ./backups, or the one given). A commit is refused on any hit.
 *
 *   node scripts/scan-tree-for-codes.mjs [backups/<folder>]
 *
 * Prints counts and file names only, never a value or a line. Exit 0 with no hit; 1 with any; 2 when the export is
 * missing a collection it needs. A four-digit run bounded by non-digits counts; 20xx years are not set aside, so a
 * code that reads like a year is still found. The shared PIN (ADMIN_PIN in .env.local) is checked too when present.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKUPS = path.join(REPO, 'backups');
const folder = process.argv[2] ? path.resolve(REPO, process.argv[2]) : path.join(BACKUPS, fs.readdirSync(BACKUPS).filter((d) => /^\d{4}-\d{2}-\d{2}T/.test(d)).sort().pop() ?? '');
const read = (coll) => {
  const file = path.join(folder, `${coll}.json`);
  if (!fs.existsSync(file)) {
    console.error(`the export ${path.basename(folder)} has no ${coll}.json: refusing to scan against an incomplete export`);
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
};
const four = (v) => typeof v === 'string' && /^\d{4}$/.test(v);
const kinds = {
  'current cleaner codes': [...new Set(read('cleaners').map((d) => d.code).filter(four))],
  'admin PINs (stored readably, and the PIN index)': [...new Set([...read('admins').map((d) => d.pin?.value), ...read('admin_pins').map((d) => d.id)].filter(four))],
};
try {
  const env = fs.readFileSync(path.join(REPO, '.env.local'), 'utf8');
  const shared = /^ADMIN_PIN=["']?(\d{4})["']?\s*$/m.exec(env)?.[1];
  if (shared) kinds['the shared PIN (.env.local)'] = [shared];
} catch {
  /* no .env.local here */
}
const files = execFileSync('git', ['-C', REPO, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 26 }).split('\0').filter(Boolean);
const texts = new Map();
for (const f of files) {
  const full = path.join(REPO, f);
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) continue;
  const buf = fs.readFileSync(full);
  if (buf.subarray(0, 8000).includes(0)) continue; // binary
  texts.set(f, buf.toString('utf8'));
}
let total = 0;
for (const [kind, values] of Object.entries(kinds)) {
  const hitFiles = new Map();
  let hits = 0;
  for (const v of values) {
    const re = new RegExp(`(?<![0-9])${v}(?![0-9])`);
    for (const [f, text] of texts) if (re.test(text)) { hits += 1; hitFiles.set(f, (hitFiles.get(f) ?? 0) + 1); }
  }
  total += hits;
  console.log(`${kind}: ${values.length} value(s) checked, ${hits} hit(s)${hitFiles.size ? ` in ${[...hitFiles].map(([f, n]) => `${f} (${n})`).join(', ')}` : ''}`);
}
console.log(`scanned ${texts.size} tracked text files against export ${path.basename(folder)}: ${total === 0 ? 'clean, the commit may go ahead' : 'REFUSED: rewrite each hit (a literal as 1_440, an example as a description) and scan again'}`);
process.exit(total === 0 ? 0 : 1);
