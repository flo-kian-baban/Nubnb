#!/usr/bin/env node
/**
 * Read-only Firestore export.
 *
 *   node scripts/export-firestore.mjs
 *
 * Reads every document in every root collection via `.get()` and writes one
 * pretty-printed JSON file per collection to ./backups/<UTC timestamp>/.
 * Each record carries its Firestore document ID as `id`.
 *
 * Read-only by construction AND by enforcement: before any query runs, every
 * mutating method on the Admin SDK prototypes is replaced with a throw (see
 * `enforceReadOnly`). A stray write would abort the run rather than land.
 *
 * Exit code 0 only if every collection was read, written, and verified by
 * re-reading the file from disk. Any mismatch exits 1.
 *
 * Firestore-native values are encoded with a `__type` tag so the backup stays
 * restorable (JSON has no timestamp, geopoint, reference or bytes type):
 *   Timestamp         -> { __type: "timestamp", iso, seconds, nanoseconds }
 *   GeoPoint          -> { __type: "geopoint", latitude, longitude }
 *   DocumentReference -> { __type: "documentReference", path }
 *   Bytes (Buffer)    -> { __type: "bytes", base64 }
 *   Date              -> { __type: "date", iso }
 * Everything else is plain JSON. The summary reports which tags were used, so
 * "no tags" is a positive statement that the export is plain JSON throughout.
 */

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { initializeApp, cert } from 'firebase-admin/app';
import {
  getFirestore,
  Firestore,
  CollectionReference,
  DocumentReference,
  Timestamp,
  GeoPoint,
} from 'firebase-admin/firestore';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = join(PROJECT_ROOT, '.env.local');
const BACKUP_ROOT = join(PROJECT_ROOT, 'backups');

/** Collections the project is known to use. Absence is reported, not fatal. */
const EXPECTED_COLLECTIONS = ['properties', 'contact_submissions'];

/** Cap on the per-document subcollection probe, so a huge collection can't blow up the run. */
const SUBCOLLECTION_PROBE_LIMIT = 500;

// ── Read-only enforcement ────────────────────────────────────────

/**
 * Replace every mutating Admin SDK method with a throw. This runs before the
 * first query, so the script cannot write even by mistake — including through
 * a batch, a transaction or a BulkWriter.
 */
export function enforceReadOnly() {
  const blocked = [
    [DocumentReference.prototype, ['set', 'update', 'delete', 'create']],
    [CollectionReference.prototype, ['add']],
    [Firestore.prototype, ['batch', 'bulkWriter', 'runTransaction', 'recursiveDelete']],
  ];

  let patched = 0;
  for (const [proto, methods] of blocked) {
    for (const method of methods) {
      if (typeof proto?.[method] !== 'function') continue;
      Object.defineProperty(proto, method, {
        configurable: true,
        writable: true,
        value() {
          throw new Error(
            `export-firestore.mjs is read-only: blocked call to ${proto.constructor.name}.${method}()`,
          );
        },
      });
      patched++;
    }
  }
  return patched;
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

function loadServiceAccount() {
  const env = readEnvFile(ENV_FILE);
  let value = env.FIREBASE_SERVICE_ACCOUNT_KEY;

  if (!value) {
    throw new Error(`FIREBASE_SERVICE_ACCOUNT_KEY is not set in ${ENV_FILE}`);
  }

  // Tolerate the value being wrapped in single or double quotes.
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (err) {
    throw new Error(`FIREBASE_SERVICE_ACCOUNT_KEY is not valid JSON: ${err.message}`);
  }

  for (const field of ['project_id', 'client_email', 'private_key']) {
    if (!parsed[field]) {
      throw new Error(`FIREBASE_SERVICE_ACCOUNT_KEY is missing "${field}"`);
    }
  }
  return parsed;
}

// ── Value encoding ───────────────────────────────────────────────

/** Recursively convert Firestore-native values to tagged plain JSON. */
function encodeValue(value, tagsSeen) {
  if (value === null || value === undefined) return null;

  if (value instanceof Timestamp) {
    tagsSeen.add('timestamp');
    return {
      __type: 'timestamp',
      iso: value.toDate().toISOString(),
      seconds: value.seconds,
      nanoseconds: value.nanoseconds,
    };
  }

  if (value instanceof GeoPoint) {
    tagsSeen.add('geopoint');
    return { __type: 'geopoint', latitude: value.latitude, longitude: value.longitude };
  }

  if (value instanceof DocumentReference) {
    tagsSeen.add('documentReference');
    return { __type: 'documentReference', path: value.path };
  }

  if (Buffer.isBuffer(value)) {
    tagsSeen.add('bytes');
    return { __type: 'bytes', base64: value.toString('base64') };
  }

  if (value instanceof Date) {
    tagsSeen.add('date');
    return { __type: 'date', iso: value.toISOString() };
  }

  if (Array.isArray(value)) {
    return value.map((item) => encodeValue(item, tagsSeen));
  }

  if (typeof value === 'number' && !Number.isFinite(value)) {
    // JSON cannot represent Infinity/NaN; record it rather than emit null silently.
    tagsSeen.add('nonFiniteNumber');
    return { __type: 'nonFiniteNumber', value: String(value) };
  }

  if (typeof value === 'object') {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = encodeValue(inner, tagsSeen);
    }
    return out;
  }

  return value;
}

// ── Formatting helpers ───────────────────────────────────────────

/** Filesystem-safe UTC stamp, e.g. 2026-09-20T17-42-05Z. */
function utcStamp(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function padEnd(value, width) {
  return String(value).padEnd(width);
}

function padStart(value, width) {
  return String(value).padStart(width);
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  const patched = enforceReadOnly();
  console.log(`Read-only guard: ${patched} mutating Admin SDK methods disabled.\n`);

  const serviceAccount = loadServiceAccount();
  initializeApp({ credential: cert(serviceAccount) });
  const db = getFirestore();

  console.log(`Project:   ${serviceAccount.project_id}`);
  console.log(`Account:   ${serviceAccount.client_email}`);

  const stamp = utcStamp();
  const outDir = join(BACKUP_ROOT, stamp);
  mkdirSync(outDir, { recursive: true });
  console.log(`Output:    ${outDir}\n`);

  // Discover every root collection rather than assuming the expected two.
  const collectionRefs = await db.listCollections();
  const collectionIds = collectionRefs.map((ref) => ref.id).sort();

  if (collectionIds.length === 0) {
    console.error('FAILURE: the database reports zero root collections.');
    return 1;
  }

  console.log(`Collections found (${collectionIds.length}): ${collectionIds.join(', ')}`);
  const missing = EXPECTED_COLLECTIONS.filter((id) => !collectionIds.includes(id));
  const extra = collectionIds.filter((id) => !EXPECTED_COLLECTIONS.includes(id));
  if (missing.length > 0) console.log(`  ! expected but not found: ${missing.join(', ')}`);
  if (extra.length > 0) console.log(`  + beyond the expected set, exported anyway: ${extra.join(', ')}`);
  console.log('');

  const tagsSeen = new Set();
  const results = [];
  const subcollectionHits = [];
  let probedDocs = 0;
  let probeTruncated = false;

  for (const ref of collectionRefs.sort((a, b) => a.id.localeCompare(b.id))) {
    process.stdout.write(`Reading ${ref.id} … `);
    const snapshot = await ref.get();

    const records = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...encodeValue(doc.data(), tagsSeen),
    }));

    // A backup that silently omits subcollections is not a backup. Probe for
    // them (read-only) so their existence is reported rather than lost.
    for (const doc of snapshot.docs) {
      if (probedDocs >= SUBCOLLECTION_PROBE_LIMIT) {
        probeTruncated = true;
        break;
      }
      probedDocs++;
      const subs = await doc.ref.listCollections();
      for (const sub of subs) {
        subcollectionHits.push(`${ref.id}/${doc.id}/${sub.id}`);
      }
    }

    const fileName = `${ref.id.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`;
    const filePath = join(outDir, fileName);
    writeFileSync(filePath, `${JSON.stringify(records, null, 2)}\n`, 'utf8');

    results.push({
      collection: ref.id,
      readCount: snapshot.size,
      recordCount: records.length,
      filePath,
      fileName,
      bytes: statSync(filePath).size,
    });
    console.log(`${snapshot.size} document${snapshot.size === 1 ? '' : 's'}`);
  }

  // ── Summary ────────────────────────────────────────────────────
  const nameWidth = Math.max(10, ...results.map((r) => r.collection.length));
  const pathWidth = Math.max(4, ...results.map((r) => r.fileName.length));

  console.log('\nSUMMARY');
  console.log(
    `  ${padEnd('COLLECTION', nameWidth)}  ${padStart('DOCS', 6)}  ${padEnd('FILE', pathWidth)}  ${padStart('SIZE', 9)}`,
  );
  console.log(`  ${'-'.repeat(nameWidth)}  ${'-'.repeat(6)}  ${'-'.repeat(pathWidth)}  ${'-'.repeat(9)}`);
  for (const r of results) {
    console.log(
      `  ${padEnd(r.collection, nameWidth)}  ${padStart(r.readCount, 6)}  ${padEnd(r.fileName, pathWidth)}  ${padStart(formatBytes(r.bytes), 9)}`,
    );
  }
  const totalDocs = results.reduce((sum, r) => sum + r.readCount, 0);
  const totalBytes = results.reduce((sum, r) => sum + r.bytes, 0);
  console.log(`  ${'-'.repeat(nameWidth)}  ${'-'.repeat(6)}  ${'-'.repeat(pathWidth)}  ${'-'.repeat(9)}`);
  console.log(
    `  ${padEnd('TOTAL', nameWidth)}  ${padStart(totalDocs, 6)}  ${padEnd(`${results.length} file(s)`, pathWidth)}  ${padStart(formatBytes(totalBytes), 9)}`,
  );
  console.log(`\n  Output directory: ${outDir}`);

  console.log(
    tagsSeen.size === 0
      ? '  Encoding: plain JSON throughout — no Firestore-native types encountered.'
      : `  Encoding: __type tags used for ${[...tagsSeen].sort().join(', ')} (see script header).`,
  );

  if (subcollectionHits.length > 0) {
    console.log(
      `\n  ! ${subcollectionHits.length} subcollection(s) found and NOT exported (root documents only):`,
    );
    for (const path of subcollectionHits.slice(0, 10)) console.log(`      ${path}`);
    if (subcollectionHits.length > 10) console.log(`      … and ${subcollectionHits.length - 10} more`);
  } else if (probeTruncated) {
    console.log(
      `\n  ! Subcollection probe stopped at ${SUBCOLLECTION_PROBE_LIMIT} documents; none found so far, remainder unchecked.`,
    );
  } else {
    console.log(`  Subcollections: none on any of the ${probedDocs} documents — export is complete.`);
  }

  // ── Verification: re-read every file from disk ──────────────────
  console.log('\nVERIFICATION (re-reading each file from disk)');
  const failures = [];

  for (const r of results) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(r.filePath, 'utf8'));
    } catch (err) {
      failures.push(`${r.collection}: output file is not valid JSON — ${err.message}`);
      console.log(`  FAIL  ${r.collection}: unreadable (${err.message})`);
      continue;
    }

    if (!Array.isArray(parsed)) {
      failures.push(`${r.collection}: output is ${typeof parsed}, expected an array`);
      console.log(`  FAIL  ${r.collection}: output is not an array`);
      continue;
    }

    const problems = [];
    if (parsed.length !== r.readCount) {
      problems.push(`count mismatch: read ${r.readCount} from Firestore, file holds ${parsed.length}`);
    }

    const missingIds = parsed.filter((rec) => !rec || typeof rec.id !== 'string' || !rec.id).length;
    if (missingIds > 0) problems.push(`${missingIds} record(s) missing a document ID`);

    const uniqueIds = new Set(parsed.map((rec) => rec?.id));
    if (uniqueIds.size !== parsed.length) {
      problems.push(`duplicate IDs: ${parsed.length} records but ${uniqueIds.size} distinct IDs`);
    }

    if (problems.length > 0) {
      for (const p of problems) failures.push(`${r.collection}: ${p}`);
      console.log(`  FAIL  ${r.collection}: ${problems.join('; ')}`);
    } else {
      console.log(`  OK    ${r.collection}: ${parsed.length} records, IDs present and unique`);
    }
  }

  if (failures.length > 0) {
    console.error(`\nFAILURE: ${failures.length} problem(s) found.`);
    for (const f of failures) console.error(`  - ${f}`);
    return 1;
  }

  console.log(`\nOK: ${results.length} collection(s), ${totalDocs} documents exported and verified.`);
  return 0;
}

// Run only when invoked directly, so the read-only guard can be imported and
// tested without performing an export.
const isDirectRun =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`\nFAILURE: ${err instanceof Error ? err.message : String(err)}`);
      if (err instanceof Error && err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
      process.exit(1);
    });
}
