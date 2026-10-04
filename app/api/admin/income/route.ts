/**
 * GET /api/admin/income?month=yyyy-mm — The Income page's read (admin-only, dispatch 27).
 *
 * Response: 200 `{ success: true, data: IncomeMonth }` — the month's uploads,
 * its lines whatever their status, every title link with the last month its
 * title was in a file, every property's name, the month's statements (draft
 * lines, finished or not) and the check-ins in the month on the stored daily
 * calendar copies. 400 for a month not written yyyy-mm.
 *
 * Read whole, no limit: a failed read is a 500, never an empty month. No
 * calendar link and no guest detail is in the answer. Every response is
 * no-store.
 */

import { NextRequest } from 'next/server';
import { verifyAdminSession } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, noStore } from '@/app/lib/api/safe-response';
import { readIncomeMonth } from '@/app/lib/firebase/server-income';
import { isMonth } from '@/app/lib/reports/model';

function grpcCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? String(code) : 'unknown';
}

export async function GET(request: NextRequest) {
  const auth = verifyAdminSession(request);
  if (!auth.valid) return noStore(apiError(auth.error!, auth.status!));
  const month = request.nextUrl.searchParams.get('month') ?? '';
  if (!isMonth(month)) return noStore(apiError('Invalid month: write it as yyyy-mm', 400));
  try {
    return noStore(apiSuccess(await readIncomeMonth(month)));
  } catch (err) {
    console.error(`[income] read of ${month} failed: grpc code ${grpcCode(err)}`);
    return noStore(apiFailure({ message: 'Failed to load the month\'s income.', status: 500, code: 'INCOME_READ_FAILED' }));
  }
}
