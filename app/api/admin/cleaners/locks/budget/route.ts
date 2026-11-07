/**
 * DELETE /api/admin/cleaners/locks/budget — lift the cleaner door's daily budget (Kian's ruling of 2026-11-06: the Team
 * page shows when a daily budget is spent, with "Lift" for an admin). The budget starts over from the day's count, so
 * one wrong code no longer locks a connection until tomorrow until fifteen more have come; every connection the budget
 * locked today is unlocked, its counts kept. Any admin; recorded in the activity log.
 *
 * Response: 200 `{ success: true, data: { lifted: { door, dayKey, unlocked } } }`; 404 SIGN_IN_BUDGET_NOT_SPENT when
 * today's budget is not spent (it was lifted, or the day changed); 502 when the outcome is unknown.
 */

import { NextRequest } from 'next/server';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiFailure, apiSuccess, noStore } from '@/app/lib/api/safe-response';
import { refuseCrossSite } from '@/app/lib/cleaners/request-guard';
import { liftBudget } from '@/app/lib/firebase/server-signin-budget';

export const DELETE = adminRoute(async function DELETE(request: NextRequest, _context: unknown, { actor }) {
  const crossSite = refuseCrossSite(request);
  if (crossSite) return crossSite;
  try {
    const outcome = await liftBudget('cleaner', actor);
    if (outcome.kind === 'not-spent') return noStore(apiFailure({ status: 404, code: 'SIGN_IN_BUDGET_NOT_SPENT', message: 'Today’s budget is not spent.', hint: 'It was lifted already, or the day changed. Reload the list.' }));
    console.log('[cleaners] the cleaner door’s daily budget was lifted');
    return noStore(apiSuccess({ lifted: { door: 'cleaner', dayKey: outcome.dayKey, unlocked: outcome.unlocked } }));
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    console.error(`[cleaners] lifting the daily budget failed: grpc code ${typeof code === 'number' ? code : 'unknown'}`);
    return noStore(apiFailure({ status: 502, code: 'SIGN_IN_BUDGET_UNCONFIRMED', message: 'Could not confirm the budget was lifted.', hint: 'It may or may not have been. Reload the list to see.' }));
  }
});
