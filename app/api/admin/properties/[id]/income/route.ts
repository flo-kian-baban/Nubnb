/**
 * GET /api/admin/properties/[id]/income[?month=yyyy-mm] — One property's lines from the platforms' files, for its
 * page (admin-only, dispatch 27; dispatch 37C).
 *
 * Response: 200 `{ lines, uploads, unlinked, titles, calendar }` — every line under one of the property's titles
 * (active or previous, each on its own platform) and every line accepted for it, whatever the month; the name of
 * each file they came from; the titles in each month's files that no link names (dispatch 34: Finish warns while any
 * is left, as the property's money may be under one); the property's titles; and, with `month`, that month's daily
 * calendar copies and the property's reserved stays in them (null without), for the check-ins and the stays no line
 * covers (I8, I15). Since dispatch 37C an accepted line is read where it is stored (Kian's ruling M10): the Income
 * tab lists it with its file and row, and the statement prints it. Every response is no-store.
 */

import { NextRequest } from 'next/server';
import { verifyAdminSession } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, noStore } from '@/app/lib/api/safe-response';
import { isDocumentId } from '@/app/lib/firebase/server-leads';
import { readPropertyIncome } from '@/app/lib/firebase/server-income';
import { isMonth } from '@/app/lib/reports/model';

interface RouteContext {
  params: Promise<{ id: string }>;
}

function grpcCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? String(code) : 'unknown';
}

export async function GET(request: NextRequest, context: RouteContext) {
  const auth = verifyAdminSession(request);
  if (!auth.valid) return noStore(apiError(auth.error!, auth.status!));
  const { id } = await context.params;
  if (!isDocumentId(id)) return noStore(apiError('Invalid property ID', 400));
  // With ?month=yyyy-mm: that month's calendar copies and the property's stays in them (dispatch 37C, I8, I15).
  const month = request.nextUrl.searchParams.get('month');
  if (month !== null && !isMonth(month)) return noStore(apiError('Invalid month: write it as yyyy-mm', 400));
  try {
    return noStore(apiSuccess(await readPropertyIncome(id, month)));
  } catch (err) {
    console.error(`[income] property ${id} lines read failed: grpc code ${grpcCode(err)}`);
    return noStore(apiFailure({ message: 'Failed to load the lines from the files.', status: 500, code: 'INCOME_READ_FAILED' }));
  }
}
