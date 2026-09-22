#!/usr/bin/env node
/**
 * mirror-images.mjs — copy the catalogue's Airbnb-hosted images into this
 * project's Firebase Storage bucket, and record the mirrored URLs on each
 * property in two NEW fields.
 *
 *   node scripts/mirror-images.mjs --preflight   # checks only, no writes
 *   node scripts/mirror-images.mjs --canary      # first property only, then stop
 *   node scripts/mirror-images.mjs --run         # every remaining property
 *   node scripts/mirror-images.mjs --verify      # B3 verification against live state
 *   node scripts/mirror-images.mjs --run --only=<id|name>   # one property
 *   node scripts/mirror-images.mjs --variants    # backfill WebP variants only
 *   node scripts/mirror-images.mjs --variants --dry-run     # report, write nothing
 *   node scripts/mirror-images.mjs --variants --concurrency=8
 *
 * ── Safety model ──────────────────────────────────────────────────
 * ADDITIVE ONLY. The only fields ever written are `coverImageStored` (string)
 * and `imagesStored` (array). Enforced three ways:
 *   1. Writes go through `.update()` with exactly those two keys — never
 *      `.set()`, which would replace the document.
 *   2. `assertAdditiveOnly()` rejects any payload carrying another key.
 *   3. Before a document is written, its live `coverImage` and `images[]` are
 *      compared byte-for-byte against the reference backup. A mismatch skips
 *      the property rather than writing against a shape that has moved.
 *
 * A document is written only after EVERY one of its images has been fetched,
 * stored, and read back successfully. A partial `imagesStored` is never
 * written — on any failure the document is left untouched and the run moves on.
 *
 * ── Variants (--variants) ─────────────────────────────────────────
 * Every mirrored original also carries WebP variants at 200/400/750/1200px,
 * stored beside it as `<original-without-ext>_w<width>.webp` and written with
 * THE SAME download token as the original. That is what lets the public
 * surfaces derive a variant's URL from the stored URL alone, with no second
 * Firestore field. See app/lib/image-variants.ts.
 *
 * `--variants` is a STORAGE-ONLY mode: it reads `coverImageStored` /
 * `imagesStored` from Firestore and writes nothing back. No document is
 * touched, and `assertAdditiveOnly` is never reached because no payload is
 * built. It is idempotent — a re-run over a complete catalogue writes nothing
 * and downloads nothing, so it is safe to interrupt and restart at any point.
 *
 * `--concurrency=N` (default 1) processes N images at a time. Each image
 * writes only to its own derived paths, so parallel workers never contend for
 * an object; the shared `present` set is only ever added to. Serial is the
 * default because the `--run` mode it shares code with must stay gentle with
 * Airbnb's CDN — the variant backfill talks only to our own bucket, so it can
 * be pushed harder.
 *
 * ── Resumability ──────────────────────────────────────────────────
 * Object paths are derived deterministically from the source URL
 * (sha256 → 16 hex chars), so a re-run recognises what it already stored.
 * An existing object is re-verified (anonymous GET, byte count) and reused
 * rather than re-fetched from Airbnb. State lives in the bucket and in
 * Firestore; there is no local state file to get out of sync.
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = join(PROJECT_ROOT, '.env.local');
const REFERENCE_BACKUP = join(PROJECT_ROOT, 'backups/2026-09-21T04-48-44Z/properties.json');
const LIVENESS_FILE = join(PROJECT_ROOT, 'tmp-audit/listing-liveness.json');
const LOG_DIR = join(PROJECT_ROOT, 'backups/mirror-logs');

/** The single pre-existing object from the production upload test. Never touched. */
const BASELINE_OBJECT = 'properties/1789947877322_cb3b8518_064___A_Day_In_The_Life_CONNEX_Cover.jpg';
const BASELINE_BYTES = 160507;

/** Where mirrored objects live. Kept apart from the admin upload prefix. */
const MIRROR_PREFIX = 'properties/mirrored';

/** The only two fields this script may ever write. */
const ALLOWED_FIELDS = ['coverImageStored', 'imagesStored'];

/** Variant widths and encoding. Kept in sync with app/lib/image-variants.ts. */
const VARIANT_WIDTHS = [200, 400, 750, 1200];
const VARIANT_QUALITY = 75;

const EXPECTED_PROPERTIES = 43;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const FETCH_ATTEMPTS = 4;

// ── env ──────────────────────────────────────────────────────────

function readEnvFile(path) {
  const raw = readFileSync(path, 'utf8');
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

function unquote(v) {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

// ── image identification ─────────────────────────────────────────

/**
 * Confirm the bytes really are an image, by magic number. Mirrors
 * sniffImageType in /api/upload-image — the source is Airbnb's CDN rather
 * than a browser upload, but "trust the bytes, not the label" is the same rule.
 */
function sniffImageType(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (buf.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('ascii');
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
  }
  return null;
}

const EXT_FOR_TYPE = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
};

/** Stable 16-hex-char identity for a source URL — the basis of resumability. */
function urlHash(url) {
  return createHash('sha256').update(url, 'utf8').digest('hex').slice(0, 16);
}

function slotLabel(index) {
  return index === 0 ? 'cover' : `img-${String(index - 1).padStart(3, '0')}`;
}

function objectPathFor(propertyId, index, sourceUrl, ext) {
  return `${MIRROR_PREFIX}/${propertyId}/${slotLabel(index)}_${urlHash(sourceUrl)}.${ext}`;
}

function downloadUrlFor(bucketName, objectPath, token) {
  return (
    `https://firebasestorage.googleapis.com/v0/b/${bucketName}` +
    `/o/${encodeURIComponent(objectPath)}?alt=media&token=${token}`
  );
}

// ── network ──────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch with serial retries.
 *
 * Phase A established that concurrent requests to a0.muscache.com produce
 * connection resets that look exactly like dead URLs — 9 false positives in
 * that run. Requests here are serial and retried, so a reset is reported as a
 * reset only after the CDN has had several chances.
 */
async function fetchWithRetry(url, { anonymous = false } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        headers: anonymous ? {} : { 'User-Agent': 'nubnb-image-mirror/1.0' },
      });
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status}`);
      } else {
        const buf = Buffer.from(await res.arrayBuffer());
        return { ok: true, buf, status: res.status };
      }
    } catch (err) {
      lastErr = err;
    }
    if (attempt < FETCH_ATTEMPTS) await sleep(300 * attempt);
  }
  return { ok: false, error: lastErr?.message || 'unknown fetch error' };
}

// ── write guard ──────────────────────────────────────────────────

/**
 * Refuse any update payload that would touch a field other than the two new
 * ones. The run aborts rather than writing something unreviewed.
 */
function assertAdditiveOnly(payload) {
  const keys = Object.keys(payload);
  const illegal = keys.filter((k) => !ALLOWED_FIELDS.includes(k));
  if (illegal.length > 0) {
    throw new Error(
      `REFUSED: update payload carries non-additive field(s): ${illegal.join(', ')}`,
    );
  }
  if (keys.length === 0) throw new Error('REFUSED: empty update payload');
}

// ── ordering ─────────────────────────────────────────────────────

/**
 * Delisted properties first: their source images are the ones most at risk of
 * being garbage-collected once the listing is gone (§C.6 of the audit).
 *
 * The audit's count is 14: 12 whose URL returns the literal 404 title, plus
 * the 2 airbnb.com URLs that resolve to 404 against airbnb.ca. The stored
 * `verdict` field in listing-liveness.json is from the first, buggy pass —
 * it reads "LIVE" for every row — so it is deliberately not used here.
 */
function buildOrder(properties) {
  let deadNames = new Set();
  try {
    const liveness = JSON.parse(readFileSync(LIVENESS_FILE, 'utf8'));
    for (const row of liveness) {
      if (row.title === '404 Page Not Found - Airbnb') deadNames.add(row.name);
      else if (/airbnb\.com/.test(row.url || '')) deadNames.add(row.name);
    }
  } catch {
    deadNames = new Set();
  }

  const byName = (a, b) => String(a.name).localeCompare(String(b.name));
  const dead = properties.filter((p) => deadNames.has(p.name)).sort(byName);
  const live = properties.filter((p) => !deadNames.has(p.name)).sort(byName);
  return { ordered: [...dead, ...live], deadCount: dead.length };
}

// ── logging ──────────────────────────────────────────────────────

let logPath = null;

function initLog(mode) {
  mkdirSync(LOG_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  logPath = join(LOG_DIR, `mirror-${mode}-${stamp}.jsonl`);
  return logPath;
}

function logImage(record) {
  if (logPath) appendFileSync(logPath, JSON.stringify(record) + '\n');
}

// ── core ─────────────────────────────────────────────────────────

async function mirrorOneImage({ bucket, bucketName, propertyId, index, sourceUrl, existing, present }) {
  const key = urlHash(sourceUrl);
  const slot = slotLabel(index);
  const base = { property: propertyId, slot, sourceUrl };

  // ── Resume: object already present from an earlier run ──
  const already = existing.get(key);
  if (already) {
    const token = already.metadata?.metadata?.firebaseStorageDownloadTokens;
    if (token) {
      const url = downloadUrlFor(bucketName, already.name, String(token).split(',')[0]);
      const check = await fetchWithRetry(url, { anonymous: true });
      const storedBytes = Number(already.metadata?.size || 0);
      if (check.ok && check.buf.length === storedBytes) {
        // An image is not complete until its variants exist too.
        try {
          await ensureVariants({
            bucket, objectPath: already.name, token: String(token).split(',')[0], present, dryRun: false,
          });
        } catch (err) {
          const rec = { ...base, outcome: 'failed', reason: `variant generation failed: ${err.message}` };
          logImage(rec);
          return { ok: false, reason: rec.reason };
        }
        const rec = { ...base, outcome: 'skipped-already-stored', storedUrl: url, bytes: storedBytes };
        logImage(rec);
        return { ok: true, url, bytes: storedBytes, reused: true };
      }
    }
    // Present but unverifiable — fall through and re-store it.
  }

  // ── Fetch from source ──
  const got = await fetchWithRetry(sourceUrl);
  if (!got.ok) {
    const rec = { ...base, outcome: 'failed', reason: `source fetch failed: ${got.error}` };
    logImage(rec);
    return { ok: false, reason: rec.reason };
  }
  const bytes = got.buf;

  if (bytes.length === 0) {
    const rec = { ...base, outcome: 'failed', reason: 'source returned 0 bytes' };
    logImage(rec);
    return { ok: false, reason: rec.reason };
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    const rec = { ...base, outcome: 'failed', reason: `oversize: ${bytes.length} bytes` };
    logImage(rec);
    return { ok: false, reason: rec.reason };
  }

  // ── Must be a real image ──
  const sniffed = sniffImageType(bytes);
  if (!sniffed) {
    const rec = { ...base, outcome: 'failed', reason: 'content is not a recognised image format' };
    logImage(rec);
    return { ok: false, reason: rec.reason };
  }

  // ── Store ──
  const objectPath = objectPathFor(propertyId, index, sourceUrl, EXT_FOR_TYPE[sniffed]);
  const token = randomUUID();
  try {
    await bucket.file(objectPath).save(bytes, {
      resumable: false,
      contentType: sniffed,
      metadata: {
        contentType: sniffed,
        cacheControl: 'public, max-age=31536000, immutable',
        metadata: {
          firebaseStorageDownloadTokens: token,
          mirroredFrom: sourceUrl,
          mirroredAt: new Date().toISOString(),
        },
      },
    });
  } catch (err) {
    const rec = { ...base, outcome: 'failed', reason: `storage write failed: ${err.message}` };
    logImage(rec);
    return { ok: false, reason: rec.reason };
  }

  // ── Read back anonymously and compare byte count ──
  const url = downloadUrlFor(bucketName, objectPath, token);
  const back = await fetchWithRetry(url, { anonymous: true });
  if (!back.ok) {
    const rec = { ...base, outcome: 'failed', reason: `stored URL not readable: ${back.error}`, storedUrl: url };
    logImage(rec);
    return { ok: false, reason: rec.reason };
  }
  if (back.buf.length !== bytes.length) {
    const rec = {
      ...base,
      outcome: 'failed',
      reason: `byte count mismatch: stored ${bytes.length}, read back ${back.buf.length}`,
      storedUrl: url,
    };
    logImage(rec);
    return { ok: false, reason: rec.reason };
  }

  // ── Variants, from the bytes already in hand ──
  present.add(objectPath);
  try {
    await ensureVariants({ bucket, objectPath, token, present, dryRun: false });
  } catch (err) {
    const rec = { ...base, outcome: 'failed', reason: `variant generation failed: ${err.message}`, storedUrl: url };
    logImage(rec);
    return { ok: false, reason: rec.reason };
  }

  logImage({ ...base, outcome: 'mirrored', storedUrl: url, bytes: bytes.length, contentType: sniffed });
  return { ok: true, url, bytes: bytes.length, reused: false };
}

async function mirrorProperty({ db, bucket, bucketName, reference, dryRun }) {
  const propertyId = reference.id;
  const result = {
    id: propertyId,
    name: reference.name,
    attempted: 0,
    mirrored: 0,
    reused: 0,
    failed: 0,
    failures: [],
    updated: false,
    skipReason: null,
  };

  // ── Establish what this run is allowed to write against ──
  //
  // The guard exists so the script never writes an `imagesStored` that was
  // computed from a shape the document has since moved away from.
  //
  // Originally it compared the live document against the reference backup,
  // which silently excluded every property created after that backup was
  // taken — precisely the properties this script is the catch-up tool for.
  // A property absent from the backup is now guarded against its own live
  // state instead: read it here, re-read it before the write, and refuse if
  // anything about its images changed in between. Same protection, no
  // dependency on the property predating the backup.
  const snap = await db.collection('properties').doc(propertyId).get();
  if (!snap.exists) {
    result.skipReason = 'document no longer exists in Firestore';
    return result;
  }
  const live = snap.data();
  const liveImages = Array.isArray(live.images) ? live.images : [];

  const inBackup = reference.fromBackup === true;
  if (inBackup) {
    if (live.coverImage !== reference.coverImage) {
      result.skipReason = 'live coverImage differs from reference backup';
      return result;
    }
    const refImages = Array.isArray(reference.images) ? reference.images : [];
    if (
      liveImages.length !== refImages.length ||
      liveImages.some((u, i) => u !== refImages[i])
    ) {
      result.skipReason = 'live images[] differs from reference backup';
      return result;
    }
  }

  // Mirror what the document says right now. For a backup-guarded property
  // these are identical to the backup's values, as just asserted.
  const coverImage = live.coverImage;
  const sourceImages = liveImages;
  if (!coverImage) {
    result.skipReason = 'no coverImage on the document';
    return result;
  }

  // ── What is already in the bucket for this property ──
  // Keyed by source-URL hash alone, not "<slot>_<hash>": reordering a
  // property's images changes each image's slot, and keying on the slot
  // would re-upload bytes already stored under the old name. Nothing is ever
  // deleted here, so that would leak an object on every reorder.
  const existing = new Map();
  // Every object name under this property, so `ensureVariants` can test a
  // variant's existence without a request per width.
  const present = new Set();
  const [files] = await bucket.getFiles({ prefix: `${MIRROR_PREFIX}/${propertyId}/` });
  for (const f of files) {
    present.add(f.name);
    // A variant is not a reuse candidate for an original, and parsing one as
    // if it were yields a "hash" of `w200`. Skip them.
    if (/_w\d+\.webp$/i.test(f.name)) continue;
    const base = (f.name.split('/').pop() || '').replace(/\.[a-z0-9]+$/i, '');
    const hash = base.includes('_') ? base.slice(base.lastIndexOf('_') + 1) : base;
    existing.set(hash, f);
  }

  const sources = [coverImage, ...sourceImages];
  const storedUrls = [];

  for (let i = 0; i < sources.length; i++) {
    result.attempted++;
    if (dryRun) continue;
    const r = await mirrorOneImage({
      bucket,
      bucketName,
      propertyId,
      index: i,
      sourceUrl: sources[i],
      existing,
      present,
    });
    if (r.ok) {
      storedUrls.push(r.url);
      if (r.reused) result.reused++;
      else result.mirrored++;
      process.stdout.write(r.reused ? '·' : '.');
    } else {
      result.failed++;
      result.failures.push({ slot: slotLabel(i), sourceUrl: sources[i], reason: r.reason });
      process.stdout.write('x');
    }
  }
  process.stdout.write('\n');

  if (dryRun) return result;

  // ── Update only if every image landed ──
  if (result.failed > 0) {
    result.skipReason = `${result.failed} image(s) failed — document left untouched`;
    return result;
  }

  const payload = {
    coverImageStored: storedUrls[0],
    imagesStored: storedUrls.slice(1),
  };
  assertAdditiveOnly(payload);

  if (payload.imagesStored.length !== sourceImages.length) {
    result.skipReason =
      `length guard: imagesStored ${payload.imagesStored.length} != images[] ${sourceImages.length}`;
    return result;
  }

  // ── Re-read immediately before writing ──
  // Mirroring a property takes long enough that an admin could have saved it
  // in the meantime. Writing then would attach stored URLs to a shape that no
  // longer exists. Cheap insurance, and it is what lets a property absent
  // from the reference backup be guarded at all.
  const fresh = await db.collection('properties').doc(propertyId).get();
  if (!fresh.exists) {
    result.skipReason = 'document was deleted while its images were being mirrored';
    return result;
  }
  const freshData = fresh.data();
  const freshImages = Array.isArray(freshData.images) ? freshData.images : [];
  if (
    freshData.coverImage !== coverImage ||
    freshImages.length !== sourceImages.length ||
    freshImages.some((u, i) => u !== sourceImages[i])
  ) {
    result.skipReason = 'document changed while its images were being mirrored — left untouched';
    return result;
  }

  await db.collection('properties').doc(propertyId).update(payload);
  result.updated = true;
  return result;
}

// ── preflight ────────────────────────────────────────────────────

async function preflight({ bucket, reference }) {
  const lines = [];
  let ok = true;

  if (reference.length !== EXPECTED_PROPERTIES) {
    ok = false;
    lines.push(`FAIL  reference backup holds ${reference.length} properties, expected ${EXPECTED_PROPERTIES}`);
  } else {
    lines.push(`OK    reference backup holds ${EXPECTED_PROPERTIES} properties`);
  }

  const [files] = await bucket.getFiles();
  const mirrored = files.filter((f) => f.name.startsWith(`${MIRROR_PREFIX}/`));
  const others = files.filter((f) => !f.name.startsWith(`${MIRROR_PREFIX}/`));

  const baseline = others.find((f) => f.name === BASELINE_OBJECT);
  if (others.length === 1 && baseline && Number(baseline.metadata.size) === BASELINE_BYTES) {
    lines.push(`OK    bucket holds exactly 1 non-mirror object, ${BASELINE_BYTES} bytes — the upload test`);
  } else {
    ok = false;
    lines.push(`FAIL  expected exactly 1 non-mirror object (${BASELINE_BYTES} bytes); found ${others.length}`);
    for (const f of others) lines.push(`        ${f.name} (${f.metadata.size} bytes)`);
  }

  lines.push(`INFO  mirrored objects already present: ${mirrored.length}`);
  return { ok, lines, mirroredCount: mirrored.length, totalObjects: files.length };
}

// ── verification (B3) ────────────────────────────────────────────

async function verify({ db, bucket, reference }) {
  const out = [];
  const snap = await db.collection('properties').get();
  const live = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

  out.push(`properties live: ${live.length} (expected ${EXPECTED_PROPERTIES})`);

  const refById = new Map(reference.map((p) => [p.id, p]));
  const liveById = new Map(live.map((p) => [p.id, p]));

  // no document lost
  const missing = [...refById.keys()].filter((id) => !liveById.has(id));
  out.push(`documents missing vs reference: ${missing.length}${missing.length ? ' — ' + missing.join(', ') : ''}`);

  // no field lost, and source image fields byte-identical
  let fieldLoss = 0, coverDiff = 0, imagesDiff = 0, reviewsDiff = 0;
  const lossDetail = [];
  for (const [id, ref] of refById) {
    const cur = liveById.get(id);
    if (!cur) continue;
    for (const k of Object.keys(ref)) {
      if (!(k in cur)) { fieldLoss++; lossDetail.push(`${id}.${k}`); }
    }
    if (cur.coverImage !== ref.coverImage) coverDiff++;
    const a = Array.isArray(cur.images) ? cur.images : [];
    const b = Array.isArray(ref.images) ? ref.images : [];
    if (a.length !== b.length || a.some((u, i) => u !== b[i])) imagesDiff++;
    if (JSON.stringify(cur.reviews ?? null) !== JSON.stringify(ref.reviews ?? null)) reviewsDiff++;
  }
  out.push(`documents that lost a field: ${fieldLoss}${lossDetail.length ? ' — ' + lossDetail.join(', ') : ''}`);
  out.push(`coverImage differs from reference: ${coverDiff}`);
  out.push(`images[] differs from reference:   ${imagesDiff}`);
  out.push(`reviews differs from reference:    ${reviewsDiff}`);

  // new fields
  let withCover = 0, withImages = 0, lengthOk = 0, lengthBad = [];
  for (const p of live) {
    if (typeof p.coverImageStored === 'string' && p.coverImageStored) withCover++;
    if (Array.isArray(p.imagesStored)) {
      withImages++;
      const refLen = (refById.get(p.id)?.images || []).length;
      if (p.imagesStored.length === refLen) lengthOk++;
      else lengthBad.push(`${p.id}: ${p.imagesStored.length} vs ${refLen}`);
    }
  }
  out.push(`coverImageStored present: ${withCover}`);
  out.push(`imagesStored present:     ${withImages}`);
  out.push(`imagesStored length == images[] length: ${lengthOk}${lengthBad.length ? ' — mismatches: ' + lengthBad.join('; ') : ''}`);

  // every stored URL returns 200 anonymously
  const urls = [];
  for (const p of live) {
    if (p.coverImageStored) urls.push(p.coverImageStored);
    for (const u of p.imagesStored || []) urls.push(u);
  }
  let ok200 = 0; const bad = [];
  for (const u of urls) {
    const r = await fetchWithRetry(u, { anonymous: true });
    if (r.ok) ok200++; else bad.push(`${u} — ${r.error}`);
  }
  out.push(`stored URLs checked: ${urls.length}, returned 200: ${ok200}, failed: ${bad.length}`);
  for (const b of bad.slice(0, 10)) out.push(`    ${b}`);

  // bucket totals
  const [files] = await bucket.getFiles();
  const total = files.reduce((s, f) => s + Number(f.metadata.size || 0), 0);
  out.push(`bucket objects: ${files.length} (expected 872 if all succeed)`);
  out.push(`bucket bytes:   ${total} (${(total / 1048576).toFixed(2)} MiB)`);

  return out;
}

// ── variants ─────────────────────────────────────────────────────

/** `properties/mirrored/x/cover_ab12.jpg` -> `properties/mirrored/x/cover_ab12_w750.webp` */
function variantObjectPath(originalPath, width) {
  return `${originalPath.replace(/\.[a-z0-9]+$/i, '')}_w${width}.webp`;
}

/** The object path and token inside one of our own download URLs, or null. */
function ownObjectRef(url) {
  const m = /^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/[^/]+\/o\/([^?]+)\?(.*)$/.exec(url);
  if (!m) return null;
  const token = new URLSearchParams(m[2]).get('token');
  if (!token) return null;
  try {
    return { path: decodeURIComponent(m[1]), token };
  } catch {
    return null;
  }
}

/**
 * Write any missing variants of `objectPath`, each carrying `token`.
 *
 * `present` is the set of object names already in the bucket, so a complete
 * image costs one set lookup per width and no network at all. The original is
 * downloaded only when something is actually missing.
 */
async function ensureVariants({ bucket, objectPath, token, present, dryRun }) {
  const missing = VARIANT_WIDTHS.filter((w) => !present.has(variantObjectPath(objectPath, w)));
  if (missing.length === 0) return { written: 0, missing: [] };
  if (dryRun) return { written: 0, missing };

  const [bytes] = await bucket.file(objectPath).download();

  for (const width of missing) {
    const target = variantObjectPath(objectPath, width);
    const out = await sharp(bytes)
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: VARIANT_QUALITY })
      .toBuffer();

    await bucket.file(target).save(out, {
      resumable: false,
      contentType: 'image/webp',
      metadata: {
        contentType: 'image/webp',
        cacheControl: 'public, max-age=31536000, immutable',
        metadata: {
          // Same token as the original — this is what makes the variant URL
          // derivable from the stored URL. See app/lib/image-variants.ts.
          firebaseStorageDownloadTokens: token,
          variantOf: objectPath,
          variantWidth: String(width),
        },
      },
    });
    present.add(target);
    logImage({ property: '-', slot: `w${width}`, outcome: 'variant', storedUrl: target, bytes: out.length });
  }

  return { written: missing.length, missing };
}

/**
 * Backfill variants for every stored image in the live catalogue.
 *
 * Firestore is READ ONLY here: `coverImageStored` and `imagesStored` are read
 * to find the objects, and no document is written. Storage is the only thing
 * that changes.
 */
async function backfillVariants({ db, bucket, dryRun, concurrency = 1 }) {
  const lines = [];
  const snap = await db.collection('properties').select('name', 'coverImageStored', 'imagesStored').get();

  // One listing of the whole prefix, so existence is a set lookup.
  const present = new Set();
  const [files] = await bucket.getFiles({ prefix: 'properties/' });
  for (const f of files) present.add(f.name);
  lines.push(`objects in bucket before: ${present.size}`);

  let complete = 0, written = 0, done = 0;
  const unaddressable = [], failed = [];

  // Flatten to one work item per stored image, so the pool is evenly fed
  // regardless of how many images each property has (6 to 48).
  const work = [];
  for (const doc of snap.docs) {
    const d = doc.data();
    const urls = [d.coverImageStored, ...(Array.isArray(d.imagesStored) ? d.imagesStored : [])]
      .filter((u) => typeof u === 'string' && u);
    for (const url of urls) work.push({ id: doc.id, url });
  }
  const images = work.length;

  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= work.length) return;
      const { id, url } = work[i];
      const ref = ownObjectRef(url);
      if (!ref) { unaddressable.push(`${id} ${url.slice(0, 60)}`); continue; }
      try {
        const r = await ensureVariants({ bucket, objectPath: ref.path, token: ref.token, present, dryRun });
        if (r.missing.length === 0) complete++;
        written += r.written;
      } catch (err) {
        failed.push(`${id} ${ref.path}: ${err.message}`);
      }
      if (++done % 25 === 0) process.stdout.write(`\r  ${done}/${images} images`);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  process.stdout.write(`\r  ${done}/${images} images\n`);

  lines.push(`properties:            ${snap.size}`);
  lines.push(`stored images:         ${images}`);
  lines.push(`already complete:      ${complete}`);
  lines.push(`variants written:      ${written}${dryRun ? ' (dry run — nothing written)' : ''}`);
  lines.push(`concurrency:           ${concurrency}`);
  lines.push(`unaddressable URLs:    ${unaddressable.length}${unaddressable.length ? ' — ' + unaddressable.join('; ') : ''}`);
  lines.push(`failed:                ${failed.length}${failed.length ? ' — ' + failed.join('; ') : ''}`);
  lines.push(`FIRESTORE WRITES:      0 (this mode never writes a document)`);
  return { lines, ok: failed.length === 0 };
}

// ── main ─────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const mode =
    args.includes('--variants') ? 'variants'
    : args.includes('--verify') ? 'verify'
    : args.includes('--canary') ? 'canary'
    : args.includes('--run') ? 'run'
    : 'preflight';
  const dryRun = args.includes('--dry-run');
  const concurrency = Number((args.find((a) => a.startsWith('--concurrency=')) || '').split('=')[1]) || 1;

  const env = readEnvFile(ENV_FILE);
  const sa = JSON.parse(unquote(env.FIREBASE_SERVICE_ACCOUNT_KEY || ''));
  const bucketName = env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
  if (!bucketName) throw new Error('NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET is not set');

  const app = initializeApp({ credential: cert(sa), storageBucket: bucketName });
  const db = getFirestore(app);
  const bucket = getStorage(app).bucket(bucketName);

  const reference = JSON.parse(readFileSync(REFERENCE_BACKUP, 'utf8'));

  console.log(`mode:    ${mode}`);
  console.log(`project: ${sa.project_id}`);
  console.log(`bucket:  ${bucketName}`);
  console.log(`backup:  ${REFERENCE_BACKUP}`);
  console.log('');

  if (mode === 'variants') {
    console.log(`log:   ${initLog('variants')}`);
    console.log('');
    const { lines, ok } = await backfillVariants({ db, bucket, dryRun, concurrency });
    console.log('── VARIANT BACKFILL ──');
    for (const l of lines) console.log(l);
    if (!ok) process.exitCode = 1;
    return;
  }

  if (mode === 'verify') {
    const lines = await verify({ db, bucket, reference });
    console.log('── B3 VERIFICATION ──');
    for (const l of lines) console.log(l);
    return;
  }

  const pf = await preflight({ bucket, reference });
  console.log('── PRE-FLIGHT ──');
  for (const l of pf.lines) console.log(l);
  console.log('');
  if (!pf.ok) {
    console.error('Pre-flight failed. Stopping without writing anything.');
    process.exitCode = 1;
    return;
  }
  if (mode === 'preflight') {
    console.log('Pre-flight only. No writes performed.');
    return;
  }

  // ── Work list ──
  // Built from the LIVE collection, not the reference backup. The backup is a
  // guard, not an inventory: a property created after it was taken is exactly
  // the case this script needs to catch up, and keying the list off the
  // backup made those properties invisible to it.
  const liveSnap = await db.collection('properties').get();
  const backupIds = new Set(reference.map((r) => r.id));
  const liveDocs = liveSnap.docs.map((d) => {
    const data = d.data();
    const fromBackup = backupIds.has(d.id);
    const ref = fromBackup ? reference.find((r) => r.id === d.id) : null;
    return {
      id: d.id,
      name: data.name,
      coverImage: ref ? ref.coverImage : data.coverImage,
      images: ref ? ref.images : data.images,
      fromBackup,
    };
  });

  const newSinceBackup = liveDocs.filter((d) => !d.fromBackup).length;
  const { ordered, deadCount } = buildOrder(liveDocs);
  console.log(
    `order: ${deadCount} delisted first, then ${ordered.length - deadCount} live` +
      (newSinceBackup > 0
        ? `  (${newSinceBackup} not in the reference backup — guarded against their own live state)`
        : ''),
  );
  const log = initLog(mode);
  console.log(`log:   ${log}`);
  console.log('');

  // `--only <id or name fragment>` narrows the run to one property. Without
  // it, catching up a single failed save means re-verifying all 870-odd
  // already-stored images first.
  const onlyFlag = args.find((a) => a.startsWith('--only='));
  const only = onlyFlag ? onlyFlag.slice('--only='.length).toLowerCase() : null;

  let targets = mode === 'canary' ? ordered.slice(0, 1) : ordered;
  if (only) {
    targets = targets.filter(
      (p) => p.id.toLowerCase() === only || String(p.name).toLowerCase().includes(only),
    );
    console.log(`--only ${only}: ${targets.length} property(ies) selected`);
  }
  const results = [];

  for (let i = 0; i < targets.length; i++) {
    const p = targets[i];
    const imgCount = 1 + (p.images || []).length;
    process.stdout.write(
      `[${String(i + 1).padStart(2)}/${targets.length}] ${p.name} (${imgCount} images)\n  `,
    );
    const r = await mirrorProperty({ db, bucket, bucketName, reference: p, dryRun: false });
    results.push(r);
    console.log(
      `  → attempted ${r.attempted}, mirrored ${r.mirrored}, reused ${r.reused}, ` +
        `failed ${r.failed}, document ${r.updated ? 'UPDATED' : 'untouched'}` +
        (r.skipReason ? ` (${r.skipReason})` : ''),
    );
    for (const f of r.failures.slice(0, 5)) console.log(`      x ${f.slot}: ${f.reason}`);
  }

  console.log('');
  console.log('── TOTALS ──');
  const sum = (k) => results.reduce((s, r) => s + r[k], 0);
  console.log(`properties processed: ${results.length}`);
  console.log(`images attempted:     ${sum('attempted')}`);
  console.log(`images mirrored:      ${sum('mirrored')}`);
  console.log(`images reused:        ${sum('reused')}`);
  console.log(`images failed:        ${sum('failed')}`);
  console.log(`documents updated:    ${results.filter((r) => r.updated).length}`);
  console.log(`documents untouched:  ${results.filter((r) => !r.updated).length}`);
  for (const r of results.filter((x) => !x.updated)) {
    console.log(`    untouched: ${r.name} — ${r.skipReason}`);
  }
  console.log(`log: ${log}`);
}

main().catch((err) => {
  console.error('\nFATAL:', err.message);
  process.exitCode = 1;
});
