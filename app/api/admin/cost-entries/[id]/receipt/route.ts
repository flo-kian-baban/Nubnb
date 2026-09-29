/**
 * GET /api/admin/cost-entries/[id]/receipt?i=0 — A 60-second link to an entry's receipt (admin-only).
 *
 * Response: 200 `{ success: true, data: { url, expiresAt, seconds, publicToken } }`
 *
 * Receipts are private: no public URL, no download token, and storage.rules
 * denies every browser. This route reads the receipt's path from the entry —
 * never from the request, and never returned — and answers with a V4 signed
 * URL that reads that one object for 60 seconds and then stops working. The
 * admin page puts it straight into an image and keeps it nowhere else; Google
 * serves the bytes, so a receipt costs no Vercel bandwidth. The link is a
 * bearer link, so it is never logged.
 *
 * Nothing here can make a permanent download token. If the object already
 * carries one — the Firebase console's Storage browser can mint one — the
 * answer says so (`publicToken: true`) and nothing is changed.
 *
 * Reads: the entry (field mask `receipts`) and the object's metadata. Every
 * response, refusals included, is no-store.
 */

import { NextRequest } from 'next/server';
import { verifyAdminSession } from '@/app/lib/api/verify-admin';
import { apiSuccess, apiError, apiFailure, noStore } from '@/app/lib/api/safe-response';
import { RECEIPT_LINK_SECONDS, receiptLink } from '@/app/lib/cleaners/receipts';
import { findReceipt } from '@/app/lib/firebase/server-cost-entries';
import { isDocumentId } from '@/app/lib/firebase/server-leads';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** The one thing logged about a failure: its code. Never the link, which would work for anyone. */
function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' || typeof code === 'string' ? String(code) : 'unknown';
}

export async function GET(request: NextRequest, context: RouteContext) {
  // ── Auth ──
  const auth = verifyAdminSession(request);
  if (!auth.valid) return noStore(apiError(auth.error!, auth.status!));

  const { id } = await context.params;
  if (!isDocumentId(id)) return noStore(apiError('Invalid entry ID', 400));

  // Which receipt on the entry: one digit, 0 when not given. Entries hold one today.
  const i = request.nextUrl.searchParams.get('i') ?? '0';
  if (!/^[0-9]$/.test(i)) return noStore(apiError('Invalid receipt number', 400));

  try {
    const found = await findReceipt(id, Number(i));
    if (found.kind === 'no-entry') {
      return noStore(apiFailure({ status: 404, code: 'ENTRY_NOT_FOUND', message: 'Entry not found' }));
    }
    if (found.kind === 'no-receipt') {
      return noStore(
        apiFailure({ status: 404, code: 'RECEIPT_NOT_ON_ENTRY', message: 'This entry has no receipt at that place.' }),
      );
    }

    const link = await receiptLink(found.path);
    if (link.kind === 'missing') {
      console.error(`[cost-entries] receipt object missing for entry ${id}`);
      return noStore(
        apiFailure({
          status: 404,
          code: 'RECEIPT_OBJECT_MISSING',
          message: 'The entry names a receipt that is not in storage.',
        }),
      );
    }

    return noStore(
      apiSuccess({
        url: link.url,
        expiresAt: link.expiresAt,
        seconds: RECEIPT_LINK_SECONDS,
        publicToken: link.publicToken,
      }),
    );
  } catch (err) {
    console.error(`[cost-entries] receipt link failed for entry ${id}: code ${errorCode(err)}`);
    return noStore(
      apiFailure({
        status: 502,
        code: 'RECEIPT_LINK_FAILED',
        message: 'Could not open the receipt.',
        hint: 'Try again in a moment.',
      }),
    );
  }
}
