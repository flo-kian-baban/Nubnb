/**
 * GET /api/admin/properties/[id]/income — One property's lines from the platforms' files, for its page (admin-only, dispatch 27).
 *
 * Response: 200 `{ lines, uploads }` — every line under a title linked to the
 * property, and every line accepted into its statements, whatever the month;
 * and the name of each file they came from. The property page's Income tab
 * reads them beside its draft: an accepted line is an ordinary line of the
 * draft, marked with its file and row, and the month's proposed lines are
 * counted with a way to the Income page. Every response is no-store.
 */

import { NextRequest } from 'next/server';
import { verifyAdminSession } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, noStore } from '@/app/lib/api/safe-response';
import { isDocumentId } from '@/app/lib/firebase/server-leads';
import { readPropertyIncome } from '@/app/lib/firebase/server-income';

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
  try {
    return noStore(apiSuccess(await readPropertyIncome(id)));
  } catch (err) {
    console.error(`[income] property ${id} lines read failed: grpc code ${grpcCode(err)}`);
    return noStore(apiFailure({ message: 'Failed to load the lines from the files.', status: 500, code: 'INCOME_READ_FAILED' }));
  }
}
