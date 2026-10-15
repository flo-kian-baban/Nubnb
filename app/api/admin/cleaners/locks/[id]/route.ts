/**
 * DELETE /api/admin/cleaners/locks/[id] — lift a cleaner-door lock and its count, before its time (Kian's ruling of
 * 2026-10-14, evening: an admin lifts it from the Team page). Any admin; recorded in the activity log.
 *
 * Response: 200 `{ success: true, data: { lifted: { id } } }`; 404 when no such lock is there (it ended, or was
 * lifted); 502 when the outcome is unknown.
 */

import { NextRequest } from 'next/server';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiFailure, apiSuccess, noStore } from '@/app/lib/api/safe-response';
import { refuseCrossSite } from '@/app/lib/cleaners/request-guard';
import { liftCleanerSignInLock } from '@/app/lib/firebase/server-cleaners';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const DELETE = adminRoute(async function DELETE(request: NextRequest, context: RouteContext) {
  const crossSite = refuseCrossSite(request);
  if (crossSite) return crossSite;
  const { id } = await context.params;
  const outcome = await liftCleanerSignInLock(id);
  if (outcome.kind === 'not-found') return noStore(apiFailure({ status: 404, code: 'SIGN_IN_LOCK_NOT_FOUND', message: 'That lock is not there.', hint: 'It may have ended, or been lifted. Reload the list.' }));
  if (outcome.kind === 'failed') return noStore(apiFailure({ status: 502, code: 'CLEANER_LOCK_UNCONFIRMED', message: 'Could not confirm the lock was lifted.', hint: 'It may or may not have been. Reload the list to see.' }));
  console.log('[cleaners] a cleaner sign-in lock was lifted');
  return noStore(apiSuccess({ lifted: { id } }));
});
