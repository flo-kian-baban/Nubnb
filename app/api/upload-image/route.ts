/**
 * POST /api/upload-image — Store one image in Cloud Storage (admin-only).
 *
 * Why this route exists
 * ─────────────────────
 * The admin form used to upload straight from the browser with the client
 * Storage SDK (`uploadBytesResumable`). There is no Firebase Auth in this app,
 * so the browser holds no credential: any Storage rule permissive enough for
 * the admin would be permissive enough for the entire internet. The stock
 * starter rules papered over that with a 30-day expiry, and when it lapsed on
 * 2026-04-16 every client upload began failing with `storage/unauthorized`.
 *
 * Uploads now go through the Admin SDK, which authenticates as the service
 * account and bypasses Storage rules entirely — the same arrangement every
 * Firestore write in this app already uses. That lets storage.rules deny all
 * client access outright.
 *
 * Serving still works, because the response URL carries a Firebase download
 * token. Token URLs are served by the Storage API without consulting the
 * rules, so `<img src>` keeps resolving under a deny-all ruleset.
 *
 * Request:  multipart/form-data with a single `file` part.
 * Response: `{ success: true, data: { url, path, bytes, contentType } }`
 */

import { randomUUID } from 'crypto';
import { getAdminBucket } from '@/app/lib/firebase/admin';
import { verifyAdminSession } from '@/app/lib/api/verify-admin';
import { createRateLimiter } from '@/app/lib/api/rate-limit';
import { apiSuccess, apiError, apiFailure, apiRateLimited } from '@/app/lib/api/safe-response';

export const maxDuration = 30;

// 30 uploads per minute per IP — matches check-availability / fetch-booked-dates.
// One request carries one file, so this also caps a multi-image batch.
const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 30, prefix: 'upload' });

/**
 * 4 MiB per file.
 *
 * The binding constraint is the platform, not the bucket: Vercel serverless
 * functions reject request bodies over 4.5 MB before the handler ever runs, so
 * a higher cap here would pass locally and 413 in production. 4 MiB leaves
 * room for multipart framing underneath that ceiling.
 *
 * For scale, measured across the 871 mirrored catalogue photos: median
 * 109 KiB, mean 122 KiB, largest 412 KiB — none within an order of magnitude
 * of this cap. A real property photo has never come close to it. The limit is
 * there for the other kind of upload: an unoptimised desktop screenshot.
 */
const MAX_FILE_BYTES = 4 * 1024 * 1024;

/**
 * Accepted image types. SVG is deliberately excluded: it is a document format
 * that can carry script, and these files are served from a URL the public
 * loads.
 */
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);

/**
 * Confirm the bytes really are the image type they claim to be. The browser's
 * declared MIME type is caller-controlled and trivially spoofed, so the
 * allowlist check above is necessary but not sufficient.
 */
function sniffImageType(buf: Buffer): string | null {
  if (buf.length < 12) return null;

  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }

  // WebP: "RIFF" .... "WEBP"
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }

  // AVIF: ISO-BMFF "ftyp" box with an AVIF brand
  if (buf.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('ascii');
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
  }

  return null;
}

/** Same shape the client SDK produced, so existing object paths stay uniform. */
function buildObjectPath(originalName: string): string {
  const safe = (originalName || 'upload').replace(/[^a-zA-Z0-9.]/g, '_').slice(-120);
  return `properties/${Date.now()}_${randomUUID().slice(0, 8)}_${safe}`;
}

export async function POST(request: Request) {
  // ── Auth — reject before touching the body ──
  const auth = verifyAdminSession(request);
  if (!auth.valid) return apiError(auth.error!, auth.status!);

  // ── Rate limit ──
  const limit = await limiter.check(request);
  if (limit.limited) return apiRateLimited(limit.retryAfterMs);

  // ── Read the multipart body ──
  let form: FormData;
  try {
    form = await request.formData();
  } catch (err) {
    return apiFailure({
      message: 'Could not read the uploaded file.',
      status: 400,
      code: 'UPLOAD_BAD_REQUEST',
      hint: 'The request must be multipart/form-data with a single `file` part.',
      internalError: err,
    });
  }

  const file = form.get('file');
  if (!file || typeof file === 'string') {
    return apiFailure({
      message: 'No file was included in the upload.',
      status: 400,
      code: 'UPLOAD_NO_FILE',
      hint: 'Attach the image under the form field name `file`.',
    });
  }

  const declaredType = file.type || 'application/octet-stream';
  const originalName = file.name || 'upload';

  // ── Declared type must be on the allowlist ──
  if (!ALLOWED_TYPES.has(declaredType)) {
    return apiFailure({
      message: 'That file is not an accepted image type.',
      status: 415,
      code: 'UPLOAD_TYPE_REJECTED',
      hint: `Upload a JPEG, PNG, WebP or AVIF. SVG is not accepted.`,
      evidence: { file: originalName, receivedType: declaredType },
    });
  }

  // ── Size cap, checked against the real byte count ──
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length > MAX_FILE_BYTES) {
    return apiFailure({
      message: 'That image is too large.',
      status: 413,
      code: 'UPLOAD_TOO_LARGE',
      hint: `The limit is ${(MAX_FILE_BYTES / 1048576).toFixed(0)} MiB per image. Resize or re-export it and try again.`,
      evidence: {
        file: originalName,
        size: `${(bytes.length / 1048576).toFixed(2)} MiB`,
        limit: `${(MAX_FILE_BYTES / 1048576).toFixed(0)} MiB`,
      },
    });
  }

  if (bytes.length === 0) {
    return apiFailure({
      message: 'That file is empty.',
      status: 422,
      code: 'UPLOAD_EMPTY',
      hint: 'The selected file contains no data.',
      evidence: { file: originalName },
    });
  }

  // ── Content must match the claim ──
  const sniffed = sniffImageType(bytes);
  if (!sniffed) {
    return apiFailure({
      message: 'That file is not a real image.',
      status: 415,
      code: 'UPLOAD_NOT_AN_IMAGE',
      hint: 'The contents do not match any accepted image format, whatever the file extension says.',
      evidence: { file: originalName, declaredType },
    });
  }

  // ── Store it ──
  const objectPath = buildObjectPath(originalName);
  // The download token is the read credential for this object. Storage rules
  // are not consulted for token URLs, which is what keeps images viewable
  // while every client-side path stays denied.
  const downloadToken = randomUUID();

  try {
    const bucket = getAdminBucket();
    await bucket.file(objectPath).save(bytes, {
      resumable: false,
      contentType: sniffed,
      metadata: {
        contentType: sniffed,
        cacheControl: 'public, max-age=31536000, immutable',
        metadata: { firebaseStorageDownloadTokens: downloadToken },
      },
    });

    const url =
      `https://firebasestorage.googleapis.com/v0/b/${bucket.name}` +
      `/o/${encodeURIComponent(objectPath)}?alt=media&token=${downloadToken}`;

    return apiSuccess({ url, path: objectPath, bytes: bytes.length, contentType: sniffed }, 201);
  } catch (err) {
    return apiFailure({
      message: 'The image could not be saved to storage.',
      status: 502,
      code: 'UPLOAD_STORAGE_FAILED',
      hint: 'This is server-side. Nothing was saved; retry, and check the Firebase service account if it persists.',
      evidence: { file: originalName },
      internalError: err,
    });
  }
}
