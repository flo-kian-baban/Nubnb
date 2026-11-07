/**
 * GET /api/admin/cleaners/locks — the cleaner door's locks holding now, and the day's budget, for the Team page (Kian's
 * ruling of 2026-10-14, evening: five wrong codes from one connection lock sign-in for 15 minutes; twenty in a Toronto
 * day lock it until an admin lifts it from the Team page; of 2026-11-06: after fifteen wrong codes across all
 * connections in a day, one wrong code locks a connection until tomorrow, shown here when spent, with Lift). Any admin.
 *
 * Response: 200 `{ success: true, data: { locks: [{ id, lockedUntil, capped, budget, lastFailedAt }], budget: BudgetView } }`:
 * each lock by its keyed hash, never the address, which is not kept. Reads: the locks holding, by two queries, and the
 * day's budget document.
 */

import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiFailure, apiSuccess, noStore } from '@/app/lib/api/safe-response';
import { listCleanerSignInLocks } from '@/app/lib/firebase/server-cleaners';
import { readBudgetView } from '@/app/lib/firebase/server-signin-budget';

export const GET = adminRoute(async function GET() {
  try {
    const [locks, budget] = await Promise.all([listCleanerSignInLocks(), readBudgetView('cleaner')]);
    return noStore(apiSuccess({ locks, budget }));
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    console.error(`[cleaners] locks read failed: grpc code ${typeof code === 'number' ? code : 'unknown'}`);
    return noStore(apiFailure({ message: 'Could not load the locked connections.', status: 500, code: 'CLEANER_LOCKS_READ_FAILED' }));
  }
});
