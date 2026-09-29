/**
 * POST /api/cleaner/entries — Log one receipt's costs for one property (cleaner-only).
 *
 * Request:  multipart/form-data with exactly two parts —
 *             receipt  the photo: JPEG, PNG or WebP, at most 4 MiB
 *             entry    JSON text of at most 32,768 characters:
 *                      { submissionKey, propertyId, purchasedOn?, note?,
 *                        lines: [{ name, quantity, lineTotal }] }
 * Response: 201 `{ success: true, data: { id, status: 'pending', createdAt, lineCount } }`
 *           200 `{ success: true, data: { id, createdAt, alreadyReceived: true } }`
 *               when this receipt's one-time key was sent before: the first
 *               send's entry, and nothing new is stored or written
 *
 * ── Who ──
 * The cleaner is the one the verified session names, and nothing in the body
 * can say otherwise: an `entry` carrying a key the schema does not name —
 * cleanerId, status, receipts — is refused. The session is checked before
 * any of the body is read, and again inside the write, so no entry lands
 * after the cleaner's deactivation commits.
 *
 * ── Order ──
 * Everything that can be refused is refused before anything is stored: the
 * request's size, its parts, the entry's fields, the receipt's declared type
 * and real bytes, and whether the property exists. Only then is the receipt
 * uploaded, and only once it is stored is the entry written, so an entry
 * never names a receipt that is not there. The gap runs the other way: if
 * the entry cannot be written after the upload, the receipt stays behind
 * with no entry. That orphan is private, its path is logged, and its
 * metadata names the entry and cleaner it was for. Nothing deletes it.
 *
 * ── Sent once ──
 * `submissionKey` is the one-time key the cleaner's phone gave this receipt.
 * A phone that lost the answer to a send — the signal dropped — sends the
 * same receipt again with the same key, and is told it already arrived.
 * Checked once the entry is read, before the photo is looked at or anything
 * is stored, and again inside the write for two sends in flight at once.
 *
 * ── Size ──
 * Vercel refuses a body over 4.5 MB before this route runs. The limits here
 * sit under that: 4,300,000 bytes per request, taken from Content-Length
 * before the body is read, and 4 MiB per receipt, counted on the real bytes.
 *
 * Amounts, dates and the note are validated by parseEntryPart
 * (server-cost-entries.ts); the receipt is stored by saveReceipt
 * (app/lib/cleaners/receipts.ts). Nothing here logs the body, the entry or
 * the photo. Every response, refusals included, is no-store.
 *
 * Firestore and Storage per entry: the session read, the one-time key read,
 * the property read, the upload, and a transaction of two reads and two
 * creates. A repeated send stops after the one-time key read.
 */

import {
  apiSuccess,
  apiFailure,
  apiValidationError,
  noStore,
} from '@/app/lib/api/safe-response';
import { LIMITS, isReceiptType, type ReceiptRef } from '@/app/lib/cleaners/model';
import { saveReceipt, sniffReceiptType } from '@/app/lib/cleaners/receipts';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { CLEANER_SESSION_INVALID, verifyCleanerSession } from '@/app/lib/cleaners/session';
import {
  DuplicateSubmissionError,
  SessionRevokedError,
  createCostEntry,
  findSubmission,
  lookupPropertyName,
  newEntryRef,
  parseEntryPart,
  type PropertyLookup,
  type SubmissionFound,
} from '@/app/lib/firebase/server-cost-entries';

export const maxDuration = 30;

/** The parts an entry request carries, and the only ones it may. */
const PARTS = new Set(['entry', 'receipt']);

/** HEIC and HEIF: what an iPhone camera saves by default. Not accepted. */
const HEIF_TYPE = /^image\/hei[cf](-sequence)?$/;

const RECEIPT_MAX_MIB = (LIMITS.RECEIPT_MAX_BYTES / 1048576).toFixed(0);

/**
 * The one thing logged about a Firestore or Storage error: its code — a gRPC
 * code from Firestore, an HTTP status or a system error name from Storage.
 * Never the message, which can carry a path or a request.
 */
function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'number') return String(code);
  if (typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code)) return code;
  return 'unknown';
}

/** 400 ENTRY_BAD_REQUEST: the body is not the request this route reads. */
function entryBadRequest(hint: string) {
  return noStore(
    apiFailure({
      message: 'The entry could not be read.',
      status: 400,
      code: 'ENTRY_BAD_REQUEST',
      hint,
    }),
  );
}

const PARTS_HINT =
  'Send multipart/form-data with exactly two parts: `entry` (JSON text) and `receipt` (the photo).';

/** 200: this receipt arrived before, as `first`. Nothing new was stored or written. */
function alreadyReceived(first: SubmissionFound) {
  return noStore(apiSuccess({ id: first.entryId, createdAt: first.createdAt, alreadyReceived: true }));
}

export async function POST(request: Request) {
  // ── 1. Cross-site ──
  const crossSite = refuseCrossSite(request);
  if (crossSite) return crossSite;

  // ── 2. Auth — before any of the body is read ──
  const session = await verifyCleanerSession(request);
  if (!session.ok) return noStore(apiFailure(session.refusal));
  const { cleaner } = session;

  // ── 3. Size — from the header, before the body is read ──
  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (declaredLength > LIMITS.REQUEST_MAX_BYTES) {
    return noStore(
      apiFailure({
        message: 'The entry is too large to send.',
        status: 413,
        code: 'ENTRY_REQUEST_TOO_LARGE',
        hint: `A request can be at most ${LIMITS.REQUEST_MAX_BYTES.toLocaleString('en-CA')} bytes, and a receipt photo at most ${RECEIPT_MAX_MIB} MiB. Nothing was recorded.`,
      }),
    );
  }

  // ── 4. Media type ──
  const wrongType = requireMediaType(request, 'multipart/form-data');
  if (wrongType) return wrongType;

  // ── 5. Read the multipart body ──
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return entryBadRequest(PARTS_HINT);
  }

  // ── 6. Exactly `entry` (text) and `receipt` (a file) ──
  if ([...form.keys()].some((name) => !PARTS.has(name))) return entryBadRequest(PARTS_HINT);

  const entryParts = form.getAll('entry');
  const entryText = entryParts.length === 1 ? entryParts[0] : null;
  if (typeof entryText !== 'string') return entryBadRequest(PARTS_HINT);

  const receiptParts = form.getAll('receipt');
  if (receiptParts.length > 1) return entryBadRequest('One receipt per entry. Send each receipt as its own entry.');
  const receipt = receiptParts[0];
  if (!receipt || typeof receipt === 'string') {
    return noStore(
      apiFailure({
        message: 'No receipt photo was included.',
        status: 400,
        code: 'RECEIPT_MISSING',
        hint: 'Attach the photo of the receipt under the form field name `receipt`.',
      }),
    );
  }

  // ── 7. The entry: length, JSON, then the schema (422) ──
  const parsed = parseEntryPart(entryText);
  if (parsed.kind === 'bad-request') {
    return entryBadRequest(
      `The \`entry\` part must be JSON text of at most ${LIMITS.ENTRY_JSON_MAX_CHARS.toLocaleString('en-CA')} characters.`,
    );
  }
  if (parsed.kind === 'invalid') return noStore(apiValidationError(parsed.issues));

  // ── 8. The lines must add up to more than zero ──
  if (parsed.kind === 'total-not-positive') {
    return noStore(
      apiFailure({
        message: 'The lines must add up to more than $0.00.',
        status: 422,
        code: 'ENTRY_TOTAL_NOT_POSITIVE',
        hint: 'A purchase is a positive amount; a discount or a return is negative.',
      }),
    );
  }
  const { entry } = parsed;

  // ── 8b. Sent before? Then say so, and store nothing ──
  let first: SubmissionFound | null;
  try {
    first = await findSubmission(cleaner.id, entry.submissionKey);
  } catch (err) {
    console.error(`[cost-entries] one-time key check failed: grpc code ${errorCode(err)}`);
    return noStore(
      apiFailure({
        message: 'Could not check whether this receipt was already sent.',
        status: 502,
        code: 'SUBMISSION_CHECK_FAILED',
        hint: 'Nothing was recorded; retry.',
      }),
    );
  }
  if (first) return alreadyReceived(first);

  // ── 9. Declared type must be on the list ──
  const declaredType = receipt.type;
  if (!isReceiptType(declaredType)) {
    return noStore(
      apiFailure({
        message: 'That file is not an accepted image type.',
        status: 415,
        code: 'RECEIPT_TYPE_REJECTED',
        hint: HEIF_TYPE.test(declaredType)
          ? 'Take the photo as JPEG.'
          : 'Send the receipt as a JPEG, PNG or WebP photo.',
      }),
    );
  }

  // ── 10. The real bytes: size, then content ──
  const bytes = Buffer.from(await receipt.arrayBuffer());
  if (bytes.length > LIMITS.RECEIPT_MAX_BYTES) {
    return noStore(
      apiFailure({
        message: 'That photo is too large.',
        status: 413,
        code: 'RECEIPT_TOO_LARGE',
        hint: `The limit is ${RECEIPT_MAX_MIB} MiB per receipt. Take the photo again at a lower resolution.`,
      }),
    );
  }

  if (bytes.length === 0) {
    return noStore(
      apiFailure({
        message: 'That photo is empty.',
        status: 422,
        code: 'RECEIPT_EMPTY',
        hint: 'The file contains no data. Take the photo again.',
      }),
    );
  }

  // The declared type is the sender's word; the stored type is the sniffed one.
  const sniffed = sniffReceiptType(bytes);
  if (!sniffed) {
    return noStore(
      apiFailure({
        message: 'That file is not a real image.',
        status: 415,
        code: 'RECEIPT_NOT_AN_IMAGE',
        hint: 'Its contents are not a JPEG, PNG or WebP, whatever its name or type says.',
      }),
    );
  }

  // ── 11. The property must exist — checked before anything is stored ──
  let property: PropertyLookup;
  try {
    property = await lookupPropertyName(entry.propertyId);
  } catch (err) {
    // Not a 422: a read that failed says nothing about whether it exists.
    console.error(`[cost-entries] property lookup failed: grpc code ${errorCode(err)}`);
    return noStore(
      apiFailure({
        message: 'Could not check the property.',
        status: 502,
        code: 'PROPERTY_LOOKUP_FAILED',
        hint: 'Nothing was recorded; retry.',
      }),
    );
  }
  if (property.kind === 'missing') {
    return noStore(
      apiFailure({
        message: 'That property does not exist.',
        status: 422,
        code: 'ENTRY_PROPERTY_NOT_FOUND',
        hint: 'Choose the property again. Nothing was recorded.',
      }),
    );
  }

  // ── 12. Allocate the entry's ID — nothing is written ──
  const entryRef = newEntryRef();

  // ── 13. Store the receipt, under the entry's ID ──
  let stored: ReceiptRef;
  try {
    stored = await saveReceipt({
      entryId: entryRef.id,
      cleanerId: cleaner.id,
      bytes,
      contentType: sniffed,
      originalName: receipt.name,
    });
  } catch (err) {
    console.error(`[cost-entries] receipt not stored (entry ${entryRef.id} not written): code ${errorCode(err)}`);
    return noStore(
      apiFailure({
        message: 'The receipt could not be stored.',
        status: 502,
        code: 'RECEIPT_STORAGE_FAILED',
        hint: 'Nothing was recorded; retry.',
      }),
    );
  }

  // ── 14. Write the entry, re-checking the cleaner and the one-time key inside the transaction ──
  // On any failure createCostEntry has already logged the orphaned
  // receipt's path, so nothing more is logged here.
  try {
    const created = await createCostEntry({
      entryRef,
      cleanerId: cleaner.id,
      sessionEpoch: cleaner.sessionEpoch,
      entry,
      propertyNameAtEntry: property.name,
      receipt: stored,
    });
    return noStore(apiSuccess(created, 201));
  } catch (err) {
    if (err instanceof SessionRevokedError) {
      // Deactivated, or given a new code, while this request was in flight.
      return noStore(apiFailure({ ...CLEANER_SESSION_INVALID, hint: 'Nothing was logged.' }));
    }
    if (err instanceof DuplicateSubmissionError) {
      // Another send of this same receipt wrote its entry first.
      return alreadyReceived(err.first);
    }
    return noStore(
      apiFailure({
        message: 'The entry could not be saved.',
        status: 502,
        code: 'ENTRY_WRITE_FAILED',
        hint: 'The receipt was received but the entry may not have been recorded; check before submitting again.',
      }),
    );
  }
}
