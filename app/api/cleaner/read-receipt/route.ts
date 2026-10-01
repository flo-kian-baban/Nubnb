/**
 * POST /api/cleaner/read-receipt — Read a receipt photo into lines (cleaner-only, dispatch 20).
 *
 * Request:  multipart/form-data with exactly one part —
 *             receipt  the prepared photo: JPEG, PNG or WebP, at most 4 MiB
 * Response: 200 `{ success: true, data: { readingText, signature } }`
 *           `readingText` is a ReadingRecord as JSON text, signed by
 *           `signature`. The phone keeps both, verbatim, and sends them back
 *           with the entry (POST /api/cleaner/entries, the `reading` part).
 *           A record's `status` is `ok` with the lines read, or `failed`
 *           with a reason: the model timed out, refused, answered badly, or
 *           the cleaner or the day is at its reading limit. A failure is a
 *           normal answer, recorded like a success, so the failure rate can
 *           be measured.
 *
 * ── What this route never does ──
 * It stores nothing of the photo: the entry route stores the receipt, as
 * before, when the cleaner sends. It never fills the purchase date: that is
 * the cleaner's (Kian's ruling of 2026-09-30). It never returns or logs the
 * key, the photo or the reading.
 *
 * ── Order ──
 * Cross-site, then the session (before any of the body is read), the size
 * from Content-Length, the media type, the one part, the declared type,
 * the real bytes. Then the keys, then a reading slot for today (the
 * runaway-bill guard, reading-quota.ts), and only then the model.
 *
 * ── Failing closed ──
 * No GEMINI_API_KEY: 503 RECEIPT_READER_NOT_CONFIGURED. The slot cannot be
 * taken: 503 RECEIPT_READER_UNAVAILABLE. Either way the phone shows the
 * form to type into, with the photo kept.
 *
 * Firestore per call: the session read and the slot transaction (one read,
 * one write). The photo goes to Google once. Every response is no-store.
 */

import { randomUUID } from 'crypto';
import { apiFailure, apiSuccess, noStore } from '@/app/lib/api/safe-response';
import { getGeminiSecrets, readReceiptWithGemini } from '@/app/lib/cleaners/gemini';
import {
  LIMITS,
  RECEIPT_READER_MODEL,
  RECEIPT_READER_THINKING,
  isReceiptType,
  type ReadingRecord,
} from '@/app/lib/cleaners/model';
import { takeReadingSlot } from '@/app/lib/cleaners/reading-quota';
import { readingKey, signReading } from '@/app/lib/cleaners/readings';
import { sniffReceiptType } from '@/app/lib/cleaners/receipts';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { CLEANER_AUTH_NOT_CONFIGURED, getCleanerSecrets } from '@/app/lib/cleaners/secrets';
import { requireRole, verifyCleanerSession } from '@/app/lib/cleaners/session';

export const maxDuration = 30;

const RECEIPT_MAX_MIB = (LIMITS.RECEIPT_MAX_BYTES / 1048576).toFixed(0);

/** The one thing logged about a Firestore error: its gRPC code. */
function grpcCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? String(code) : 'unknown';
}

function badRequest(hint: string) {
  return noStore(apiFailure({ message: 'The photo could not be read from the request.', status: 400, code: 'READ_BAD_REQUEST', hint }));
}

const PART_HINT = 'Send multipart/form-data with exactly one part: `receipt` (the photo).';

export async function POST(request: Request) {
  // ── 1. Cross-site ──
  const crossSite = refuseCrossSite(request);
  if (crossSite) return crossSite;

  // ── 2. Auth — before any of the body is read ──
  const session = await verifyCleanerSession(request);
  if (!session.ok) return noStore(apiFailure(session.refusal));
  const { cleaner } = session;
  // Only a cleaner has receipts to read (dispatch 24): a handyman's session is refused, 403 ROLE_MISMATCH.
  const wrongRole = requireRole(cleaner, 'cleaner');
  if (wrongRole) return noStore(apiFailure(wrongRole));

  // ── 3. Size — from the header, before the body is read ──
  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (declaredLength > LIMITS.REQUEST_MAX_BYTES) {
    return noStore(
      apiFailure({
        message: 'The photo is too large to send.',
        status: 413,
        code: 'READ_REQUEST_TOO_LARGE',
        hint: `A receipt photo can be at most ${RECEIPT_MAX_MIB} MiB.`,
      }),
    );
  }

  // ── 4. Media type ──
  const wrongType = requireMediaType(request, 'multipart/form-data');
  if (wrongType) return wrongType;

  // ── 5. The one part ──
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return badRequest(PART_HINT);
  }
  if ([...form.keys()].some((name) => name !== 'receipt')) return badRequest(PART_HINT);
  const parts = form.getAll('receipt');
  const receipt = parts.length === 1 ? parts[0] : null;
  if (!receipt || typeof receipt === 'string') return badRequest(PART_HINT);

  // ── 6. Declared type, then the real bytes ──
  if (!isReceiptType(receipt.type)) {
    return noStore(
      apiFailure({
        message: 'That file is not an accepted image type.',
        status: 415,
        code: 'RECEIPT_TYPE_REJECTED',
        hint: 'Send the receipt as a JPEG, PNG or WebP photo.',
      }),
    );
  }
  const bytes = Buffer.from(await receipt.arrayBuffer());
  if (bytes.length > LIMITS.RECEIPT_MAX_BYTES) {
    return noStore(
      apiFailure({
        message: 'That photo is too large.',
        status: 413,
        code: 'RECEIPT_TOO_LARGE',
        hint: `The limit is ${RECEIPT_MAX_MIB} MiB per receipt.`,
      }),
    );
  }
  const sniffed = sniffReceiptType(bytes);
  if (bytes.length === 0 || !sniffed) {
    return noStore(
      apiFailure({
        message: 'That file is not a real image.',
        status: 415,
        code: 'RECEIPT_NOT_AN_IMAGE',
        hint: 'Its contents are not a JPEG, PNG or WebP, whatever its name or type says.',
      }),
    );
  }

  // ── 7. The keys ──
  const secrets = getCleanerSecrets();
  if (secrets.kind !== 'ok') return noStore(apiFailure(CLEANER_AUTH_NOT_CONFIGURED));
  const gemini = getGeminiSecrets();
  if (gemini.kind !== 'ok') {
    return noStore(
      apiFailure({
        message: 'Receipt reading is not set up on this server.',
        status: 503,
        code: 'RECEIPT_READER_NOT_CONFIGURED',
        hint: 'GEMINI_API_KEY must be set. Type the items instead; nothing was changed.',
      }),
    );
  }

  const requestedAt = new Date().toISOString();
  const base: Omit<ReadingRecord, 'modelVersion' | 'ms' | 'status' | 'reason' | 'usage' | 'output' | 'rawText'> = {
    v: 1,
    id: randomUUID(),
    cleanerId: cleaner.id,
    requestedAt,
    model: RECEIPT_READER_MODEL,
    thinkingLevel: RECEIPT_READER_THINKING,
  };
  const key = readingKey(secrets.sessionKey);

  // ── 8. A reading slot for today, or a recorded refusal ──
  try {
    const slot = await takeReadingSlot(cleaner.id);
    if (slot.kind === 'over') {
      console.error(`[read-receipt] over the ${slot.which} limit for ${slot.day}`);
      const record: ReadingRecord = {
        ...base,
        modelVersion: null,
        ms: 0,
        status: 'failed',
        reason: `over_limit_${slot.which}`,
        usage: null,
        output: null,
        rawText: null,
      };
      return noStore(apiSuccess(signReading(record, key)));
    }
  } catch (err) {
    console.error(`[read-receipt] reading slot not taken: grpc code ${grpcCode(err)}`);
    return noStore(
      apiFailure({
        message: 'Receipt reading is not available right now.',
        status: 503,
        code: 'RECEIPT_READER_UNAVAILABLE',
        hint: 'Type the items instead; nothing was changed.',
      }),
    );
  }

  // ── 9. The model ──
  const outcome = await readReceiptWithGemini(gemini, bytes, sniffed);
  const record: ReadingRecord = { ...base, ...outcome };
  return noStore(apiSuccess(signReading(record, key)));
}
