/**
 * GET /api/admin/direct[?property=<id>] — Every direct arrangement and payment, or one property's (admin-only; part B
 * of PROPERTY-LIST-COLUMNS-PLAN.md, Kian's rulings of 2026-10-15). Removed payments are included, marked. What each
 * month expects and has received, the pages work out with app/lib/direct/periods.ts.
 *
 * Response: 200 `{ arrangements, payments, unreadable, today }`. A failed read is a 503, never none. Every response is
 * no-store. Reads: one per arrangement and payment.
 */

import { NextRequest } from 'next/server';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, noStore } from '@/app/lib/api/safe-response';
import { torontoDay } from '@/app/lib/availability/days';
import { readDirect } from '@/app/lib/firebase/server-direct';
import { isDocumentId } from '@/app/lib/firebase/server-leads';

export const GET = adminRoute(async function GET(request: NextRequest) {
  const property = request.nextUrl.searchParams.get('property');
  if (property !== null && !isDocumentId(property)) return noStore(apiError('Invalid property ID', 400));
  try {
    return noStore(apiSuccess({ ...(await readDirect(property ?? undefined)), today: torontoDay() }));
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    console.error(`[direct] read failed: grpc code ${typeof code === 'number' ? code : 'unknown'}`);
    return noStore(apiFailure({ status: 503, code: 'DIRECT_UNAVAILABLE', message: 'Could not read the direct payments.', hint: 'Nothing is shown rather than something that might be wrong. Try again.' }));
  }
});
