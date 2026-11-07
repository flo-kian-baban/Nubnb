/**
 * DELETE /api/admin/admins/locks/budget — lift the admin door's daily budget (Kian's ruling of 2026-11-06: after ten
 * wrong PINs across all connections in a Toronto day, one wrong PIN locks a connection until tomorrow; a lift on the
 * Admins page). The budget starts over from the day's count; every connection it locked today is unlocked, its counts
 * kept. Main admin only, like every lift at the admin door; recorded in the activity log.
 *
 * Response: 200 `{ success: true, data: { lifted: { door, dayKey, unlocked } } }`; 404 SIGN_IN_BUDGET_NOT_SPENT when
 * today's budget is not spent (it was lifted, or the day changed); 502 when the outcome is unknown.
 */

import { NextRequest } from 'next/server';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiFailure, apiSuccess, noStore } from '@/app/lib/api/safe-response';
import { refuseCrossSite } from '@/app/lib/cleaners/request-guard';
import { liftBudget } from '@/app/lib/firebase/server-signin-budget';

export const DELETE = adminRoute(
  async function DELETE(request: NextRequest, _context: unknown, { actor }) {
    const crossSite = refuseCrossSite(request);
    if (crossSite) return crossSite;
    try {
      const outcome = await liftBudget('admin', actor);
      if (outcome.kind === 'not-spent') return noStore(apiFailure({ status: 404, code: 'SIGN_IN_BUDGET_NOT_SPENT', message: 'Today’s budget is not spent.', hint: 'It was lifted already, or the day changed. Reload the list.' }));
      console.log('[admins] the admin door’s daily budget was lifted');
      return noStore(apiSuccess({ lifted: { door: 'admin', dayKey: outcome.dayKey, unlocked: outcome.unlocked } }));
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      console.error(`[admins] lifting the daily budget failed: grpc code ${typeof code === 'number' ? code : 'unknown'}`);
      return noStore(apiFailure({ status: 502, code: 'ADMIN_CHANGE_UNCONFIRMED', message: 'Could not confirm the budget was lifted.', hint: 'It may or may not have been. Reload the list to see.' }));
    }
  },
  { level: 'main' },
);
