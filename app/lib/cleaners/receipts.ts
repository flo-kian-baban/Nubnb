/**
 * Receipt images: which are accepted, and how one is stored.
 *
 * Path: receipts/<entryId>/<random UUID>.<jpg|png|webp>. The entry ID is
 * allocated before the upload so that the path can carry it. The path never
 * holds a file name, a cleaner's name or a property. Readers use the path
 * stored on the entry and never rebuild it, so the scheme can change for new
 * uploads.
 *
 * ── Private ──
 * Unlike a property photo (app/api/upload-image), a receipt is stored with
 * no download token, no ACL option and no public flag. It takes the bucket's
 * project-private default ACL; storage.rules denies every client read, list
 * and write; and with no token, the Firebase download endpoint has no
 * credential to accept. Admins read receipts through signed URLs that work
 * for 60 seconds (receiptLink). Never open a receipt in the Firebase
 * console's Storage browser: that can mint a download token, which is a
 * permanent public URL.
 *
 * ── Create-only ──
 * Written with `ifGenerationMatch: 0`, so the app can never overwrite a
 * receipt, and the app has no code that removes one. A receipt whose entry
 * was then not written stays behind as an orphan: private, costing cents,
 * and attributable through its `entryId` and `cleanerId` metadata.
 *
 * ── Bytes ──
 * Stored exactly as received: no re-encoding, and no server CPU spent on it.
 * `sha256` is taken over the stored bytes, so a later replacement is
 * detectable. The type recorded is the one sniffed from the bytes, never the
 * one the browser declared.
 */

import { createHash, randomUUID } from 'crypto';
import { getAdminBucket } from '@/app/lib/firebase/admin';
import { RECEIPTS_PREFIX, type ReceiptRef, type ReceiptType } from './model';

/** A Firestore auto ID, which is what an entry ID always is. */
const AUTO_ID = /^[A-Za-z0-9]{20}$/;

/**
 * The receipt type the bytes really are, or null. The browser's declared type
 * is caller-controlled, so it is checked but never trusted.
 *
 * Copied from the property-photo upload route rather than shared, so that
 * route stays untouched; AVIF is left out.
 */
export function sniffReceiptType(buf: Buffer): ReceiptType | null {
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

  return null;
}

const EXTENSIONS: Record<ReceiptType, 'jpg' | 'png' | 'webp'> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** The object name's extension for a sniffed type. */
export function extensionFor(type: ReceiptType): 'jpg' | 'png' | 'webp' {
  return EXTENSIONS[type];
}

export interface SaveReceiptInput {
  /** The pre-allocated ID of the entry this receipt belongs to. */
  entryId: string;
  /** From the verified session. */
  cleanerId: string;
  /** Exactly the bytes received. */
  bytes: Buffer;
  /** sniffReceiptType of these same bytes. */
  contentType: ReceiptType;
  /** The browser's file name. Kept, sanitised, in metadata only; never in the path. */
  originalName: string;
}

/**
 * Store one receipt, create-only and private, and describe what was stored.
 *
 * The file name goes in metadata so an orphan can be attributed and a test
 * object can carry its `__TEST__` marker.
 *
 * @throws if the bytes are not the type claimed, the entry ID is not an auto
 * ID, or the upload fails — nothing is recorded in Firestore in any of these
 * cases.
 */
export async function saveReceipt(input: SaveReceiptInput): Promise<ReceiptRef> {
  const { entryId, cleanerId, bytes, contentType } = input;
  if (!AUTO_ID.test(entryId)) throw new Error('saveReceipt: the entry ID is not a Firestore auto ID');
  if (sniffReceiptType(bytes) !== contentType) {
    throw new Error('saveReceipt: the bytes are not the receipt type given');
  }

  const path = `${RECEIPTS_PREFIX}/${entryId}/${randomUUID()}.${extensionFor(contentType)}`;
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const uploadedAt = new Date().toISOString();
  const originalName = (input.originalName || 'receipt').replace(/[^A-Za-z0-9._-]/g, '_').slice(-120);

  await getAdminBucket()
    .file(path)
    .save(bytes, {
      resumable: false,
      contentType,
      // Create-only: fails if an object already has this name.
      preconditionOpts: { ifGenerationMatch: 0 },
      metadata: {
        contentType,
        contentDisposition: 'inline',
        cacheControl: 'private, max-age=0, no-store',
        metadata: { entryId, cleanerId, sha256, uploadedAt, originalName },
      },
    });

  return { path, contentType, bytes: bytes.length, sha256, uploadedAt };
}

// ─── Reading one back ──────────────────────────────────────────

/**
 * How long a receipt link works. The admin page loads the image the moment
 * it has the link, so a minute is ample; a link copied out of the page stops
 * working within that minute.
 */
export const RECEIPT_LINK_SECONDS = 60;

export type ReceiptLink =
  | {
      kind: 'ok';
      /** A V4 signed URL for reading this one object. A bearer link: never logged, never stored. */
      url: string;
      expiresAt: string;
      /**
       * True when the object carries a Firebase download token — a permanent
       * public URL, minted outside the app (the console's Storage browser can
       * do it). Reported, never changed here.
       */
      publicToken: boolean;
    }
  /** The entry names an object that is not in the bucket. */
  | { kind: 'missing' };

/**
 * A link that reads one receipt for RECEIPT_LINK_SECONDS and then stops
 * working. It is signed with the service account's own key; nothing is
 * written to the object, and no download token is made. The object's
 * `Cache-Control: private, max-age=0, no-store`, set at upload, keeps the
 * image out of the browser's disk cache.
 *
 * @throws if the metadata read or the signing fails.
 */
export async function receiptLink(path: string): Promise<ReceiptLink> {
  const file = getAdminBucket().file(path);

  let custom: Record<string, unknown>;
  try {
    const [metadata] = await file.getMetadata();
    custom = (metadata.metadata ?? {}) as Record<string, unknown>;
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === 404) return { kind: 'missing' };
    throw err;
  }
  const token = custom.firebaseStorageDownloadTokens;

  const expires = Date.now() + RECEIPT_LINK_SECONDS * 1000;
  const [url] = await file.getSignedUrl({
    version: 'v4',
    action: 'read',
    expires,
    responseDisposition: 'inline',
  });

  return {
    kind: 'ok',
    url,
    expiresAt: new Date(expires).toISOString(),
    publicToken: typeof token === 'string' && token.trim() !== '',
  };
}
