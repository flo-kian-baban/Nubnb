/**
 * GET /api/admin/cost-entries/month?month=yyyy-mm — The Costs page's Month tab (admin-only; the Costs page, round 1).
 *
 * Response: 200 `{ success: true, data: { month, rows, totals, quiet } }` — one row per property with anything for the
 * month: what its statement charges for costs (the month's own, late costs from earlier months, adjustments), entries
 * waiting for a decision and cleanings with no amount that go on it, as the property's statement preview shows them
 * (costsMonth, from the month's money); `quiet`, how many properties have nothing. 400 for a month that is not one;
 * 500 COSTS_MONTH_READ_FAILED, never an empty month. One read of the month (readCostsMonth). Every response is no-store.
 */

import { NextRequest } from 'next/server';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, noStore } from '@/app/lib/api/safe-response';
import { isMonth } from '@/app/lib/reports/model';
import { readCostsMonth } from '@/app/lib/firebase/server-costs-month';

export const GET = adminRoute(async function GET(request: NextRequest) {
  const month = request.nextUrl.searchParams.get('month');
  if (!isMonth(month)) return noStore(apiError('A month, like 2026-10', 400));
  try {
    return noStore(apiSuccess(await readCostsMonth(month)));
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    console.error(`[cost-entries] the month's read failed: grpc code ${typeof code === 'number' ? code : 'unknown'}`);
    return noStore(apiFailure({ status: 500, code: 'COSTS_MONTH_READ_FAILED', message: 'Failed to load the month' }));
  }
});
