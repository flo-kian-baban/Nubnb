/**
 * GET /api/admin/cost-entries/receipt-links?ids=a,b,c — Thumbnails for the review queue's folded list (admin-only; the
 * Costs page, round 1).
 *
 * Response: 200 `{ success: true, data: { links: { [entryId]: { url, expiresAt } } } }` — each entry's first receipt as
 * a signed link lasting RECEIPT_LINK_SECONDS, the page loading each image the moment it has it; an entry with no
 * receipt has none. At most THUMB_LINKS_MAX IDs; one read per entry, of its receipts alone. Object paths are never
 * returned. 400 when an ID is not one; 502 RECEIPT_LINKS_FAILED when the read or the signing fails.
 *
 * A GET: it changes nothing, so it is not in the activity log. Every response is no-store.
 */

import { NextRequest } from 'next/server';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, noStore } from '@/app/lib/api/safe-response';
import { THUMB_LINKS_MAX, receiptThumbLinks } from '@/app/lib/firebase/server-cost-entries';
import { isDocumentId } from '@/app/lib/firebase/server-leads';

export const GET = adminRoute(async function GET(request: NextRequest) {
  const ids = (request.nextUrl.searchParams.get('ids') ?? '').split(',').filter(Boolean);
  if (ids.length === 0 || ids.length > THUMB_LINKS_MAX || !ids.every((id) => isDocumentId(id))) return noStore(apiError(`Give 1 to ${THUMB_LINKS_MAX} entry IDs`, 400));
  try {
    return noStore(apiSuccess({ links: await receiptThumbLinks(ids) }));
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    console.error(`[cost-entries] receipt links failed: code ${typeof code === 'number' || typeof code === 'string' ? code : 'unknown'}`);
    return noStore(apiFailure({ status: 502, code: 'RECEIPT_LINKS_FAILED', message: 'Could not open the receipts.', hint: 'Try again in a moment.' }));
  }
});
