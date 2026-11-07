#!/usr/bin/env node
/**
 * Whether any duplicate code or PIN exists in an export (Kian's ruling of 2026-11-06, item 1: codes and PINs must be
 * unique — no cleaner code equals another cleaner's code or any admin PIN, and no admin PIN equals another's). Reads the
 * newest export under ./backups (or the one given) and the shared PIN from .env.local when present. Prints each finding
 * by role and name only, never a value. Exit 0 with none; 1 with any; 2 when the export lacks a collection it needs.
 *
 *   node scripts/code-duplicates.mjs [backups/<folder>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { duplicateLines, findDuplicates } from './lib/duplicates.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKUPS = path.join(REPO, 'backups');
const folder = process.argv[2] ? path.resolve(REPO, process.argv[2]) : path.join(BACKUPS, fs.readdirSync(BACKUPS).filter((d) => /^\d{4}-\d{2}-\d{2}T/.test(d)).sort().pop() ?? '');
const read = (coll) => {
  const file = path.join(folder, `${coll}.json`);
  if (!fs.existsSync(file)) {
    console.error(`the export ${path.basename(folder)} has no ${coll}.json: refusing to check an incomplete export`);
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
};
let shared = null;
try {
  shared = /^ADMIN_PIN=["']?(\d{4})["']?\s*$/m.exec(fs.readFileSync(path.join(REPO, '.env.local'), 'utf8'))?.[1] ?? null;
} catch {
  /* no .env.local here */
}
const found = findDuplicates(read('cleaners'), read('admins'), shared);
console.log(`export ${path.basename(folder)}: ${found.counts.cleanersWithCode} cleaner codes held, ${found.counts.adminsWithPin} admin PINs held, the shared PIN ${shared ? 'checked' : 'not set here'}`);
for (const line of duplicateLines(found)) console.log(`  DUPLICATE: ${line}`);
console.log(found.clean ? 'no duplicate: every code and PIN is unique' : `${duplicateLines(found).length} duplicate(s)`);
process.exit(found.clean ? 0 : 1);
