/**
 * GET /api/admin/cleaners/[id]/month?month=yyyy-mm — a team member's jobs in one month, for their person page's calendar
 * and month summary (Build 3, Kian's rulings of 2026-11-03; CLEANER-COSTS-DESIGN.md §70): every job they are on whose
 * checkout falls in the month, named as the admin names the property, with their mark on it (when, the cleaning, a
 * removal by the office), the job's label, amount and booking state. The page already holds their cleanings, receipts,
 * work and payments from the Team page's reads; this is the one read a person's month adds.
 *
 * Response: 200 `{ success: true, data: { month, jobs: PersonJob[] } }`. 400 for a month not in shape. 500
 * MEMBER_MONTH_READ_FAILED: not "nothing". Reads: their jobs of the month (one query, through the composite index on
 * `cleanerIds` and `checkout`), those jobs' properties' cleaner-facing names. A read, not recorded in the activity log.
 */

import { NextRequest } from 'next/server';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, noStore } from '@/app/lib/api/safe-response';
import { memberJobsInMonth } from '@/app/lib/firebase/server-cleaning-jobs';
import { isDocumentId } from '@/app/lib/firebase/server-leads';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export const GET = adminRoute(async function GET(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  if (!isDocumentId(id)) return noStore(apiError('Invalid cleaner ID', 400));
  const month = new URL(request.url).searchParams.get('month') ?? '';
  if (!MONTH.test(month)) return noStore(apiError('Invalid month: yyyy-mm', 400));
  try {
    return noStore(apiSuccess({ month, jobs: await memberJobsInMonth(id, month) }));
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    console.error(`[cleaners] a team member's month could not be read: grpc code ${typeof code === 'number' ? code : 'unknown'}`);
    return noStore(apiFailure({ message: 'Could not read their jobs for the month.', status: 500, code: 'MEMBER_MONTH_READ_FAILED' }));
  }
});
