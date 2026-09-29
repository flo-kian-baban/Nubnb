#!/usr/bin/env node
/**
 * Read-only check to run BEFORE changing ADMIN_PIN: is the candidate PIN
 * some cleaner's code, now or before?
 *
 *   CANDIDATE_ADMIN_PIN=<new pin> node scripts/check-admin-pin-vs-cleaner-codes.mjs
 *
 * Why it exists. Cleaner codes and the admin PIN are both four digits, and
 * the /admin PIN gate submits the moment the fourth digit is in. A cleaner
 * whose code were the admin PIN would therefore open /admin with it. The app
 * never issues or accepts the admin PIN as a code (reservedReason in
 * app/lib/cleaners/codes.ts), but only the PIN in force at that moment. If
 * ADMIN_PIN changes, the new PIN could be a code handed out earlier.
 *
 * Codes are stored readably (Kian's ruling of 2026-09-28): every code ever
 * issued is the ID of a `cleaner_codes` document, kept for ever. So the check
 * is one read — does `cleaner_codes/<candidate>` exist?
 *
 * Exit codes:
 *   0  the candidate PIN has never been a cleaner code
 *   1  it has: do not change ADMIN_PIN to this candidate, whatever the
 *      cleaner's status and whether the code has since been replaced. The
 *      admin door checks the PIN alone, so anyone who knows those four
 *      digits opens /admin
 *   2  no answer: an input is missing or malformed, a read failed, or
 *      `cleaner_codes` still holds documents from before codes were readable
 *
 * ── Inputs ────────────────────────────────────────────────────────
 *   CANDIDATE_ADMIN_PIN  from the process environment ONLY, never a file.
 *                        Exactly four digits: PinGate submits exactly four,
 *                        so a PIN of any other length could not be entered
 *                        at /admin at all.
 * The candidate is never printed. A hit is reported by cleaner ID, name and
 * status, and by whether the code is current or replaced.
 *
 * ── Codes from before ─────────────────────────────────────────────
 * Schema version 1 stored a code only as a keyed digest (the document's ID,
 * with `keyVersion: 1`). Such a code cannot be compared with the candidate
 * here, so while any version 1 document exists the answer is exit 2. The
 * only one written, KiKi's during testing, is deleted by ID in dispatch 18.
 *
 * Read-only by enforcement: enforceReadOnly() from export-firestore.mjs
 * disables every mutating Admin SDK method before the first query. Cost:
 * 1 read for the version 1 count, 1 for the candidate's code document, and
 * 1 for the cleaner if it is held.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

import { enforceReadOnly } from './export-firestore.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = join(PROJECT_ROOT, '.env.local');
const CODES_SOURCE = join(PROJECT_ROOT, 'app/lib/cleaners/codes.ts');
const MODEL_SOURCE = join(PROJECT_ROOT, 'app/lib/cleaners/model.ts');

/** Must equal CLEANERS_COLLECTION and CLEANER_CODES_COLLECTION in model.ts. Checked on every run. */
const CLEANERS_COLLECTION = 'cleaners';
const CLEANER_CODES_COLLECTION = 'cleaner_codes';

/** Must equal CODE_LENGTH in codes.ts. Checked on every run: the check is only right while codes and the PIN are the same length. */
const CODE_LENGTH = 4;

/** PinGate submits exactly four digits, the length of every cleaner code. */
const CANDIDATE_FORMAT = /^[0-9]{4}$/;

/** The key version of the digest documents written before codes were readable. */
const LEGACY_KEY_VERSION = 1;

/** A cleaner ID as issued: a Firestore auto ID. */
const AUTO_ID = /^[A-Za-z0-9]{20}$/;

const EXIT_CLEAN = 0;
const EXIT_ISSUED = 1;
const EXIT_NO_ANSWER = 2;

/**
 * What in the app no longer matches the copies above. Each entry is a line
 * that must appear in the app's source verbatim.
 */
function driftFromAppSource() {
  const expected = [
    [CODES_SOURCE, `export const CODE_LENGTH = ${CODE_LENGTH};`],
    [MODEL_SOURCE, `export const CLEANERS_COLLECTION = '${CLEANERS_COLLECTION}';`],
    [MODEL_SOURCE, `export const CLEANER_CODES_COLLECTION = '${CLEANER_CODES_COLLECTION}';`],
  ];
  const problems = [];
  for (const [file, line] of expected) {
    let source;
    try {
      source = readFileSync(file, 'utf8');
    } catch (err) {
      problems.push(`cannot read ${file}: ${err.message}`);
      continue;
    }
    if (!source.includes(line)) problems.push(`not found in ${file}: ${line}`);
  }
  return problems;
}

// ── Credentials ──────────────────────────────────────────────────

/** Parse .env.local into a plain object. Values are taken verbatim after the first `=`. */
function readEnvFile(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read ${path}: ${err.message}`);
  }

  const env = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return env;
}

/** Tolerate a value wrapped in single or double quotes. */
function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function loadServiceAccount(env) {
  const value = env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (!value) {
    throw new Error(`FIREBASE_SERVICE_ACCOUNT_KEY is not set in ${ENV_FILE}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(unquote(value));
  } catch {
    // The parser's message can quote the key's text, so it is not repeated.
    throw new Error('FIREBASE_SERVICE_ACCOUNT_KEY is not valid JSON');
  }

  for (const field of ['project_id', 'client_email', 'private_key']) {
    if (!parsed[field]) {
      throw new Error(`FIREBASE_SERVICE_ACCOUNT_KEY is missing "${field}"`);
    }
  }
  return parsed;
}

/**
 * Firestore errors are reported by gRPC code only: their messages can carry
 * a document path, and a `cleaner_codes` path is a code.
 */
function describeError(err) {
  const code = err?.code;
  if (typeof code === 'number') return `Firestore read failed: grpc code ${code}`;
  return err instanceof Error ? err.message : String(err);
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  const patched = enforceReadOnly();
  console.log(`Read-only guard: ${patched} mutating Admin SDK methods disabled.\n`);

  // ── Inputs, all checked before the first read ──
  const candidate = process.env.CANDIDATE_ADMIN_PIN;
  if (!candidate) {
    console.error('FAILURE: set CANDIDATE_ADMIN_PIN in the environment. It is never read from a file.');
    return EXIT_NO_ANSWER;
  }
  if (!CANDIDATE_FORMAT.test(candidate)) {
    console.error('FAILURE: CANDIDATE_ADMIN_PIN must be exactly 4 digits: PinGate submits exactly four.');
    return EXIT_NO_ANSWER;
  }

  const drift = driftFromAppSource();
  if (drift.length > 0) {
    console.error('FAILURE: this script no longer matches the app it checks.');
    for (const line of drift) console.error(`  - ${line}`);
    return EXIT_NO_ANSWER;
  }

  const env = readEnvFile(ENV_FILE);
  const serviceAccount = loadServiceAccount(env);
  initializeApp({ credential: cert(serviceAccount) });
  const db = getFirestore();

  console.log(`Project:   ${serviceAccount.project_id}`);
  console.log(`Account:   ${serviceAccount.client_email}`);
  console.log('Candidate: CANDIDATE_ADMIN_PIN from the environment\n');

  // ── Codes from before: stored as digests, so not comparable ──
  const legacy = await db
    .collection(CLEANER_CODES_COLLECTION)
    .where('keyVersion', '==', LEGACY_KEY_VERSION)
    .count()
    .get();
  const legacyCount = legacy.data().count;
  if (legacyCount > 0) {
    console.error(
      `FAILURE: ${CLEANER_CODES_COLLECTION} holds ${legacyCount} document(s) from before codes were stored readably. Their codes are digests and cannot be compared with the candidate, so there is no answer. Nothing was checked.`,
    );
    return EXIT_NO_ANSWER;
  }

  // ── The candidate, as a code ──
  const [codeDoc] = await db.getAll(db.collection(CLEANER_CODES_COLLECTION).doc(candidate), {
    fieldMask: ['cleanerId', 'retiredAt'],
  });

  if (!codeDoc.exists) {
    console.log('Checked the candidate PIN against every code ever issued: not one of them.');
    return EXIT_CLEAN;
  }

  // ── Who holds it, or held it ──
  const cleanerId = codeDoc.get('cleanerId');
  const retiredAt = codeDoc.get('retiredAt');
  const when = retiredAt === null ? 'their current code' : `replaced ${typeof retiredAt === 'string' ? retiredAt : '(date not recorded)'}`;
  let who = '(not a cleaner ID)';
  if (typeof cleanerId === 'string' && AUTO_ID.test(cleanerId)) {
    const [cleaner] = await db.getAll(db.collection(CLEANERS_COLLECTION).doc(cleanerId), {
      fieldMask: ['name', 'status'],
    });
    if (!cleaner.exists) {
      who = `${cleanerId}  (no cleaner document)`;
    } else {
      const name = cleaner.get('name');
      const status = cleaner.get('status');
      who = `${cleanerId}  ${typeof status === 'string' ? status : '(status not recorded)'}  ${typeof name === 'string' ? JSON.stringify(name) : '(name not recorded)'}`;
    }
  }

  console.log('The candidate PIN is a cleaner code (cleaner ID, status, name):');
  console.log(`  ${who}`);
  console.log(`  — ${when}\n`);
  console.error(
    'FAILURE: the candidate PIN is a cleaner code. Do not change ADMIN_PIN to it: whoever knows that code could type it into /admin, whatever their status as a cleaner and whether the code has been replaced.',
  );
  return EXIT_ISSUED;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`\nFAILURE: ${describeError(err)}`);
    process.exit(EXIT_NO_ANSWER);
  });
