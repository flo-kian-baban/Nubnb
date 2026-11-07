#!/usr/bin/env node
/**
 * Before every commit, and for the tree of every commit before a push (security rule, 2026-10-19; Kian's standing rule
 * of 2026-10-31): every tracked file — not only the staged diff — is scanned for the four digits of every CURRENT
 * cleaner code and every admin PIN, read from an export made by scripts/export-firestore.mjs (the newest folder under
 * ./backups, or the one given). The shared PIN (ADMIN_PIN in .env.local) is checked too when present.
 *
 *   node scripts/scan-tree-for-codes.mjs [backups/<folder>]                 the working tree's tracked files
 *   node scripts/scan-tree-for-codes.mjs [backups/<folder>] --commit <sha>  that commit's files AND its message
 *   node scripts/scan-tree-for-codes.mjs [backups/<folder>] --message-file <path>   a commit message to be, as well
 *
 * Kian's ruling of 2026-11-06 (the security round, item 3; scripts/lib/code-context.mjs): a hit BLOCKS the commit only
 * in a code-like context — a line mentioning codes or PINs, an easy-code list, anything under tests/, a .md file, the
 * commit message, anything unclassified — and is only REPORTED in an incidental one: a hex colour, a date or time, the
 * inside of an ID or a hash. The advice for a reported hit is to change the code, never to rewrite the file.
 *
 * Prints counts, file names, line numbers and contexts only, never a value or a line. Exit 0 with no blocking hit; 1
 * with any; 2 when the export is missing a collection it needs. A four-digit run bounded by non-digits counts; years
 * are not set aside by themselves (a code that reads like a year is still found, and blocks unless it stands in a date).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findRuns, isTextBuffer } from './lib/code-context.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKUPS = path.join(REPO, 'backups');
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const commit = flag('--commit');
const messageFile = flag('--message-file');
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--commit' && args[i - 1] !== '--message-file');
const folder = positional[0] ? path.resolve(REPO, positional[0]) : path.join(BACKUPS, fs.readdirSync(BACKUPS).filter((d) => /^\d{4}-\d{2}-\d{2}T/.test(d)).sort().pop() ?? '');
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

// ── The files: the working tree's tracked files, or one commit's ──
const texts = new Map();
let sha = null;
if (commit) {
  sha = execFileSync('git', ['-C', REPO, 'rev-parse', '--verify', `${commit}^{commit}`], { encoding: 'utf8' }).trim();
  const names = execFileSync('git', ['-C', REPO, 'ls-tree', '-r', '-z', '--name-only', sha], { encoding: 'utf8', maxBuffer: 1 << 26 }).split('\0').filter(Boolean);
  const batch = spawnSync('git', ['-C', REPO, 'cat-file', '--batch'], { input: names.map((n) => `${sha}:${n}`).join('\n') + '\n', maxBuffer: 1 << 30 });
  const out = batch.stdout;
  let pos = 0;
  let i = 0;
  while (pos < out.length && i < names.length) {
    const nl = out.indexOf(10, pos);
    const header = out.subarray(pos, nl).toString('utf8').split(' ');
    if (header[1] === 'missing') {
      pos = nl + 1;
      i += 1;
      continue;
    }
    const size = Number(header[2]);
    const body = out.subarray(nl + 1, nl + 1 + size);
    if (isTextBuffer(body)) texts.set(names[i], body.toString('utf8'));
    pos = nl + 1 + size + 1;
    i += 1;
  }
} else {
  const files = execFileSync('git', ['-C', REPO, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 26 }).split('\0').filter(Boolean);
  for (const f of files) {
    const full = path.join(REPO, f);
    if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) continue;
    const buf = fs.readFileSync(full);
    if (!isTextBuffer(buf)) continue;
    texts.set(f, buf.toString('utf8'));
  }
}
// ── The message: the commit's, or the file given ──
let message = null;
if (commit) message = execFileSync('git', ['-C', REPO, 'log', '-1', '--format=%B', commit], { encoding: 'utf8' });
else if (messageFile) message = fs.readFileSync(path.resolve(REPO, messageFile), 'utf8');

let blocking = 0;
let reported = 0;
for (const [kind, values] of Object.entries(kinds)) {
  const blocks = [];
  const reports = [];
  for (const [f, text] of texts) {
    for (const hit of findRuns(text, values, { path: f })) (hit.kind === 'code-like' ? blocks : reports).push(`${f}:${hit.line} (${hit.context})`);
  }
  if (message !== null) for (const hit of findRuns(message, values, { message: true })) blocks.push(`the commit message, line ${hit.line} (${hit.context})`);
  blocking += blocks.length;
  reported += reports.length;
  const parts = [];
  if (blocks.length) parts.push(`${blocks.length} BLOCKING hit(s): ${blocks.join(', ')}`);
  if (reports.length) parts.push(`${reports.length} reported, information only: ${reports.join(', ')}`);
  console.log(`${kind}: ${values.length} value(s) checked${parts.length ? ` · ${parts.join(' · ')}` : ', no hit'}`);
}
const what = sha ? `the ${texts.size} text files and the message of commit ${sha.slice(0, 7)}` : `${texts.size} tracked text files${message !== null ? ' and the commit message given' : ''}`;
console.log(`scanned ${what} against export ${path.basename(folder)}: ${blocking === 0 ? 'clean, the commit may go ahead' : 'REFUSED: rewrite each blocking hit (a literal as 1_440, an example as a description) and scan again'}`);
if (reported > 0) console.log(`reported hits are information: the digits of a current code or PIN stand in a colour, a date or an ID. The fix, if one is wanted, is to change the code, never the file.`);
process.exit(blocking === 0 ? 0 : 1);
