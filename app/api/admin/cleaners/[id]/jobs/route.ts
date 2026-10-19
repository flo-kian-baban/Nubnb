/**
 * GET /api/admin/cleaners/[id]/jobs — the jobs a team member is on and has not marked cleaned: what deactivating or
 * deleting them takes them off (the cleaning schedule, 2026-10-14). The Team page's dialog names them before asking.
 *
 * Response: 200 `{ success: true, data: { jobs: [{ id, propertyName, checkout, status }], regularAt: string[],
 * regularFor: [{ propertyId, name }] } }`. `regularAt` and `regularFor` (Kian's rulings R5 and K4 of 2026-10-19): the
 * properties they are the regular cleaner for, by name, and by ID and name — the dialog offers a replacement for each
 * (another active cleaner, or nobody), applied with the deactivation or delete. Reads: the jobs that name them (one
 * query), and the regular-cleaner records naming them with those properties' names.
 */

import { NextRequest } from 'next/server';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, noStore } from '@/app/lib/api/safe-response';
import { unmarkedJobsOf } from '@/app/lib/firebase/server-cleaning-jobs';
import { isDocumentId } from '@/app/lib/firebase/server-leads';
import { regularFor } from '@/app/lib/firebase/server-regular-cleaners';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const GET = adminRoute(async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  if (!isDocumentId(id)) return noStore(apiError('Invalid cleaner ID', 400));
  try {
    const [jobs, regular] = await Promise.all([unmarkedJobsOf(id), regularFor(id)]);
    return noStore(apiSuccess({ jobs, regularAt: regular.map((p) => p.name), regularFor: regular }));
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    console.error(`[jobs] a team member's jobs could not be read: grpc code ${typeof code === 'number' ? code : 'unknown'}`);
    return noStore(apiFailure({ message: 'Could not read their jobs.', status: 500, code: 'JOBS_READ_FAILED' }));
  }
});
