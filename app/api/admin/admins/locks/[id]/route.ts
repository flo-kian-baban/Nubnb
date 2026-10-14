/**
 * DELETE /api/admin/admins/locks/[id] — Lift a connection's sign-in lock (main admin only, dispatch 38).
 *
 * Kian's ruling of 2026-10-13 (evening): five wrong PINs from one connection
 * lock sign-in from that connection for fifteen minutes, and the main admin
 * can lift a lock on the Admins page. Lifting deletes the lock and its count:
 * the connection starts again from nothing. Response: 200 `{ lifted: { id } }`;
 * 404 SIGN_IN_LOCK_NOT_FOUND when there is none (it ended, or was lifted).
 * 502: it may or may not have been lifted.
 */

import { NextRequest } from 'next/server';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiFailure, apiSuccess, noStore } from '@/app/lib/api/safe-response';
import { refuseCrossSite } from '@/app/lib/cleaners/request-guard';
import { liftSignInLock } from '@/app/lib/firebase/server-admins';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const DELETE = adminRoute(
  async function DELETE(request: NextRequest, context: RouteContext) {
    const crossSite = refuseCrossSite(request);
    if (crossSite) return crossSite;
    const { id } = await context.params;
    try {
      const outcome = await liftSignInLock(id);
      if (outcome.kind === 'not-found') return noStore(apiFailure({ status: 404, code: 'SIGN_IN_LOCK_NOT_FOUND', message: 'That lock is not there.', hint: 'It may have ended, or been lifted. Reload the list.' }));
      console.log('[admins] a sign-in lock was lifted');
      return noStore(apiSuccess({ lifted: { id } }));
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      console.error(`[admins] lifting a lock failed: grpc code ${typeof code === 'number' ? code : 'unknown'}`);
      return noStore(apiFailure({ status: 502, code: 'ADMIN_CHANGE_UNCONFIRMED', message: 'Could not confirm the lock was lifted.', hint: 'It may or may not have been. Reload the list to see.' }));
    }
  },
  { level: 'main' },
);
