/**
 * GET  /api/admin/monthly-reports/empty?month= — The month's empty statements: who can be finished together, who is
 *      left out and why, and the Airbnb titles unsettled (admin-only, dispatch 36).
 * POST /api/admin/monthly-reports/empty — Finish the confirmed ones: `{ month, items: [{ propertyId, reference }] }`.
 *
 * Kian's rulings of 2026-10-12: empty months can be finished together from the Statements panel. Each property
 * still gets its own statement, PDF and reference, the reference suggested from its last one. It refuses while any
 * Airbnb title in that month's file is neither linked nor set aside. The list leaves out any property whose
 * calendar showed stays the month's file does not hold, and any property missing a Report For name.
 *
 * GET answers 200 `{ eligible, leftOut, unsettled, today }`. POST answers 200 `{ results }`, one per item: finished
 * with its report and reference, left out with why, or failed with why; 409 TITLES_UNSETTLED with `unsettled`
 * (nothing finished); 422 MONTH_NOT_CLOSED for a month that has not ended. See server-empty-months.ts.
 *
 * Order: the admin session, then for POST the cross-site and media-type refusals, the JSON and the schema, then the
 * work. Every response is no-store.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminSession } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { EmptyFinishInputSchema, finishEmptyMonth, readEmptyMonth } from '@/app/lib/firebase/server-empty-months';
import { isMonth } from '@/app/lib/reports/model';

export const maxDuration = 60;

function grpcCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? String(code) : 'unknown';
}

const NOT_CLOSED = { status: 422, code: 'MONTH_NOT_CLOSED', message: 'That month has not ended: its statements are not due yet.' };

export async function GET(request: NextRequest) {
  const auth = verifyAdminSession(request);
  if (!auth.valid) return noStore(apiError(auth.error!, auth.status!));
  const month = request.nextUrl.searchParams.get('month') ?? '';
  if (!isMonth(month)) return noStore(apiError('Invalid month: write it as yyyy-mm', 400));
  try {
    const read = await readEmptyMonth(month);
    if (read.kind === 'not-closed') return noStore(apiFailure(NOT_CLOSED));
    return noStore(apiSuccess({ ...read.data, today: read.today }));
  } catch (err) {
    console.error(`[reports] empty month ${month} read failed: grpc code ${grpcCode(err)}`);
    return noStore(apiFailure({ status: 500, code: 'EMPTY_MONTH_READ_FAILED', message: 'Failed to read the month.' }));
  }
}

export async function POST(request: NextRequest) {
  const auth = verifyAdminSession(request);
  if (!auth.valid) return noStore(apiError(auth.error!, auth.status!));
  const crossSite = refuseCrossSite(request);
  if (crossSite) return crossSite;
  const wrongType = requireMediaType(request, 'application/json');
  if (wrongType) return wrongType;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return noStore(apiError('Invalid JSON body', 400));
  }
  const parsed = EmptyFinishInputSchema.safeParse(body);
  if (!parsed.success) return noStore(apiValidationError(parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))));
  try {
    const outcome = await finishEmptyMonth(parsed.data);
    if (outcome.kind === 'not-closed') return noStore(apiFailure(NOT_CLOSED));
    if (outcome.kind === 'unsettled') {
      return noStore(
        NextResponse.json(
          { success: false, error: `Nothing was finished: ${outcome.titles.length === 1 ? '1 title' : `${outcome.titles.length} titles`} in the month's Airbnb file ${outcome.titles.length === 1 ? 'is' : 'are'} neither linked nor set aside.`, code: 'TITLES_UNSETTLED', unsettled: outcome.titles },
          { status: 409 },
        ),
      );
    }
    return noStore(apiSuccess({ results: outcome.results }));
  } catch (err) {
    console.error(`[reports] empty month ${parsed.data.month} finish failed before or between statements: grpc code ${grpcCode(err)}`);
    return noStore(apiFailure({ status: 502, code: 'EMPTY_MONTH_FINISH_FAILED', message: 'The empty statements could not all be finished.', hint: 'Some may have been. Refresh to see what is on record.' }));
  }
}
