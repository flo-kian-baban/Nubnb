/**
 * Mirror a property's images into this project's Storage bucket.
 *
 * The one-off migration (scripts/mirror-images.mjs) gave all 43 existing
 * properties `coverImageStored` / `imagesStored`. Nothing maintained them
 * afterwards: a new property got neither, and an edit that removed or
 * reordered an image left the stored arrays misaligned with `images[]`.
 * This module is the maintaining half, called after every admin save.
 *
 * Guarantees, in the order they matter:
 *
 *  - **All or nothing.** The caller is handed a result only when every image
 *    mirrored *and every one of its WebP variants exists*. A partial
 *    `imagesStored` is never produced, so the arrays can never disagree with
 *    `images[]` about length or order, and a stored URL always has the full
 *    set of variants its derived URLs will ask for.
 *  - **Nothing is ever deleted.** Re-mirroring writes new objects at most;
 *    an object that stops being referenced is left in place.
 *  - **Idempotent.** Object paths derive from a sha256 of the source URL, the
 *    same scheme scripts/mirror-images.mjs uses, so a re-run of either tool
 *    finds and reuses what the other stored. Variants are named from the
 *    original's path, so the same holds for them.
 *  - **Variants share their original's download token.** That is what lets a
 *    variant's URL be derived from the stored URL alone, with no second
 *    Firestore field to keep in sync. See app/lib/image-variants.ts.
 *  - **Bounded.** A deadline is enforced between images. Running out of time
 *    is a failure like any other: the caller leaves the document alone.
 */

import { createHash, randomUUID } from 'crypto';
import sharp from 'sharp';
import { getAdminBucket } from '@/app/lib/firebase/admin';
import { VARIANT_WIDTHS, variantObjectPath } from '@/app/lib/image-variants';

/** Where mirrored objects live. Matches scripts/mirror-images.mjs. */
const MIRROR_PREFIX = 'properties/mirrored';

/** WebP quality for every generated variant. Matches scripts/mirror-images.mjs. */
const VARIANT_QUALITY = 75;

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const FETCH_ATTEMPTS = 3;

const EXT_FOR_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
};

export interface MirrorResult {
  ok: boolean;
  coverImageStored?: string;
  imagesStored?: string[];
  /** Per-image accounting, for the server log and the operator's warning. */
  mirrored: number;
  reused: number;
  alreadyStored: number;
  failed: number;
  /** WebP variants written this run. Zero on a re-run of a complete property. */
  variants: number;
  reason?: string;
}

/** Stable 16-hex identity for a source URL — the basis of reuse. */
function urlHash(url: string): string {
  return createHash('sha256').update(url, 'utf8').digest('hex').slice(0, 16);
}

function slotLabel(index: number): string {
  return index === 0 ? 'cover' : `img-${String(index - 1).padStart(3, '0')}`;
}

/**
 * True when a URL is already an object in our own bucket — an image the admin
 * uploaded through /api/upload-image. It is its own stored URL: re-fetching
 * and re-storing it would duplicate an object we already own.
 */
export function isOwnStorageUrl(url: string): boolean {
  return (
    url.startsWith('https://firebasestorage.googleapis.com/') ||
    url.startsWith('https://storage.googleapis.com/')
  );
}

/**
 * The object path and download token inside one of our own Storage URLs.
 *
 * `null` when the URL is not a Firebase download URL we can address — a
 * `storage.googleapis.com` path style, or one with no token. Such a URL can
 * still be served as-is; it just cannot carry variants.
 */
function ownObjectRef(url: string): { path: string; token: string } | null {
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

function sniffImageType(buf: Buffer): string | null {
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Serial fetch with retries — concurrent requests to Airbnb's CDN reset. */
async function fetchWithRetry(url: string): Promise<Buffer | null> {
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (res.ok) return Buffer.from(await res.arrayBuffer());
    } catch {
      /* retry */
    }
    if (attempt < FETCH_ATTEMPTS) await sleep(250 * attempt);
  }
  return null;
}

/** Matches a generated variant, e.g. `cover_ab12cd34_w750.webp`. */
const IS_VARIANT = /_w\d+\.webp$/i;

/**
 * Make sure every width in VARIANT_WIDTHS exists beside `objectPath`.
 *
 * Each variant is written with `token` — its original's download token — which
 * is what lets app/lib/image-variants.ts derive a variant's URL from the
 * stored URL alone. Nothing here writes Firestore.
 *
 * `sourceBytes` is the original's bytes when the caller already has them (a
 * freshly mirrored image). Otherwise they are downloaded from the bucket, and
 * only when at least one variant is actually missing — a re-run over a
 * complete property downloads nothing.
 *
 * Returns the number of variants written, or throws with a reason the caller
 * turns into a failed run. A variant that cannot be produced fails the image,
 * because a stored URL whose variants do not exist would render a 403.
 */
async function ensureVariants(
  bucket: ReturnType<typeof getAdminBucket>,
  objectPath: string,
  token: string,
  present: Set<string>,
  sourceBytes?: Buffer,
): Promise<number> {
  const missing = VARIANT_WIDTHS.filter((w) => !present.has(variantObjectPath(objectPath, w)));
  if (missing.length === 0) return 0;

  let bytes = sourceBytes;
  if (!bytes) {
    const [buf] = await bucket.file(objectPath).download();
    bytes = buf;
  }

  for (const width of missing) {
    const target = variantObjectPath(objectPath, width);
    // `withoutEnlargement` so a source narrower than the variant width is
    // never upscaled — it is stored at its own width under the wider name,
    // which is the best available rather than a blurred fake.
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
          // The same token as the original. See app/lib/image-variants.ts.
          firebaseStorageDownloadTokens: token,
          variantOf: objectPath,
          variantWidth: String(width),
        },
      },
    });
    present.add(target);
  }

  return missing.length;
}

function downloadUrlFor(bucketName: string, objectPath: string, token: string): string {
  return (
    `https://firebasestorage.googleapis.com/v0/b/${bucketName}` +
    `/o/${encodeURIComponent(objectPath)}?alt=media&token=${token}`
  );
}

/**
 * Mirror every image of one property and return arrays aligned to the input.
 *
 * `sources[0]` is the cover; the rest are `images[]` in order. The returned
 * `imagesStored` has exactly the length of `images[]`, index for index.
 */
export async function mirrorPropertyImages(opts: {
  propertyId: string;
  coverImage: string;
  images: string[];
  /** Wall-clock budget. Exceeding it fails the run rather than half-writing. */
  deadlineMs?: number;
}): Promise<MirrorResult> {
  const { propertyId, coverImage, images } = opts;
  const deadline = Date.now() + (opts.deadlineMs ?? 90_000);

  const tally = { mirrored: 0, reused: 0, alreadyStored: 0, failed: 0, variants: 0 };

  if (!coverImage) {
    return { ok: false, ...tally, reason: 'the property has no cover image to mirror' };
  }

  const bucket = getAdminBucket();
  const bucketName = bucket.name;

  // What this property already has in the bucket, keyed by source-URL hash.
  //
  // Keyed by hash alone, NOT by "<slot>_<hash>": reordering images changes an
  // image's slot, and keying on the slot would re-upload bytes already held
  // under the old name. Since nothing is ever deleted, that would leak an
  // object on every reorder.
  const existing = new Map<string, { name: string; token: string | null }>();
  // Every object already in the bucket, so a variant's existence is a set
  // lookup rather than a HEAD request per width per image.
  const present = new Set<string>();
  try {
    const [files] = await bucket.getFiles({ prefix: `${MIRROR_PREFIX}/${propertyId}/` });
    for (const f of files) {
      present.add(f.name);

      // Variants are named from their original and are not reuse candidates
      // themselves. Without this they would poison the map: the "hash" parsed
      // out of `cover_<hash>_w200.webp` is `w200`.
      if (IS_VARIANT.test(f.name)) continue;

      const base = (f.name.split('/').pop() || '').replace(/\.[a-z0-9]+$/i, '');
      const hash = base.includes('_') ? base.slice(base.lastIndexOf('_') + 1) : base;
      const rawToken = (f.metadata?.metadata as Record<string, unknown> | undefined)
        ?.firebaseStorageDownloadTokens;
      existing.set(hash, {
        name: f.name,
        token: rawToken ? String(rawToken).split(',')[0] : null,
      });
    }
  } catch {
    // A listing failure is not fatal; it just means nothing is reused and
    // every variant is re-checked against the bucket individually.
  }

  const sources = [coverImage, ...images];
  const stored: string[] = [];

  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];

    if (Date.now() > deadline) {
      return {
        ok: false,
        ...tally,
        reason: `ran out of time after ${i} of ${sources.length} images`,
      };
    }

    if (!source) {
      tally.failed++;
      return { ok: false, ...tally, reason: `image ${i} is empty` };
    }

    // Already ours — an admin upload. Keep the URL as its own stored URL,
    // but it still needs variants: it is what the surfaces will derive from.
    if (isOwnStorageUrl(source)) {
      const own = ownObjectRef(source);
      if (!own) {
        tally.failed++;
        return { ok: false, ...tally, reason: `image ${i + 1} is a Storage URL we cannot address` };
      }
      try {
        tally.variants += await ensureVariants(bucket, own.path, own.token, present);
      } catch (err) {
        tally.failed++;
        return {
          ok: false,
          ...tally,
          reason: `resizing image ${i + 1} failed: ${err instanceof Error ? err.message : 'unknown error'}`,
        };
      }
      stored.push(source);
      tally.alreadyStored++;
      continue;
    }

    const hash = urlHash(source);
    const hit = existing.get(hash);
    if (hit?.token) {
      try {
        tally.variants += await ensureVariants(bucket, hit.name, hit.token, present);
      } catch (err) {
        tally.failed++;
        return {
          ok: false,
          ...tally,
          reason: `resizing image ${i + 1} failed: ${err instanceof Error ? err.message : 'unknown error'}`,
        };
      }
      stored.push(downloadUrlFor(bucketName, hit.name, hit.token));
      tally.reused++;
      continue;
    }

    const bytes = await fetchWithRetry(source);
    if (!bytes || bytes.length === 0) {
      tally.failed++;
      return { ok: false, ...tally, reason: `could not fetch image ${i + 1} of ${sources.length}` };
    }
    if (bytes.length > MAX_IMAGE_BYTES) {
      tally.failed++;
      return { ok: false, ...tally, reason: `image ${i + 1} is larger than 25 MiB` };
    }

    const sniffed = sniffImageType(bytes);
    if (!sniffed) {
      tally.failed++;
      return { ok: false, ...tally, reason: `image ${i + 1} is not a recognised image format` };
    }

    const objectPath = `${MIRROR_PREFIX}/${propertyId}/${slotLabel(i)}_${hash}.${EXT_FOR_TYPE[sniffed]}`;
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
            mirroredFrom: source,
            mirroredAt: new Date().toISOString(),
          },
        },
      });
    } catch (err) {
      tally.failed++;
      return {
        ok: false,
        ...tally,
        reason: `storing image ${i + 1} failed: ${err instanceof Error ? err.message : 'unknown error'}`,
      };
    }

    present.add(objectPath);
    try {
      tally.variants += await ensureVariants(bucket, objectPath, token, present, bytes);
    } catch (err) {
      tally.failed++;
      return {
        ok: false,
        ...tally,
        reason: `resizing image ${i + 1} failed: ${err instanceof Error ? err.message : 'unknown error'}`,
      };
    }

    stored.push(downloadUrlFor(bucketName, objectPath, token));
    existing.set(hash, { name: objectPath, token });
    tally.mirrored++;
  }

  // Alignment is the whole point of the field; refuse to return a result that
  // does not have it, rather than let the caller write a misaligned array.
  if (stored.length !== sources.length) {
    return { ok: false, ...tally, reason: 'internal mismatch between sources and stored URLs' };
  }

  return {
    ok: true,
    coverImageStored: stored[0],
    imagesStored: stored.slice(1),
    ...tally,
  };
}
