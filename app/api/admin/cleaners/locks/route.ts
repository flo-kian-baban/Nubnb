/**
 * GET /api/admin/cleaners/locks — the cleaner door's locks holding now, for the Team page (Kian's ruling of
 * 2026-10-14, evening: five wrong codes from one connection lock sign-in for 15 minutes; twenty in a Toronto day lock
 * it until an admin lifts it from the Team page). Any admin.
 *
 * Response: 200 `{ success: true, data: { locks: [{ id, lockedUntil, capped, lastFailedAt }] } }`: each lock by its
 * keyed hash, never the address, which is not kept. Reads: the locks holding, by two queries.
 */

import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiFailure, apiSuccess, noStore } from '@/app/lib/api/safe-response';
import { listCleanerSignInLocks } from '@/app/lib/firebase/server-cleaners';

export const GET = adminRoute(async function GET() {
  try {
    return noStore(apiSuccess({ locks: await listCleanerSignInLocks() }));
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    console.error(`[cleaners] locks read failed: grpc code ${typeof code === 'number' ? code : 'unknown'}`);
    return noStore(apiFailure({ message: 'Could not load the locked connections.', status: 500, code: 'CLEANER_LOCKS_READ_FAILED' }));
  }
});
