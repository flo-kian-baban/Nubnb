/**
 * GET /api/admin/admins/locks — Connections whose sign-in is locked now (main admin only, dispatch 38).
 *
 * Response: 200 `{ locks: SignInLockView[] }`, the latest-ending first: each
 * lock's keyed hash, when it ends and when its last wrong PIN came. Never an
 * address: none is kept (Kian's ruling of 2026-10-13, evening: the connection
 * is stored only as a keyed hash). One read per lock listed.
 */

import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiFailure, apiSuccess, noStore } from '@/app/lib/api/safe-response';
import { listSignInLocks } from '@/app/lib/firebase/server-admins';

export const GET = adminRoute(
  async function GET() {
    try {
      return noStore(apiSuccess({ locks: await listSignInLocks() }));
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      console.error(`[admins] locks read failed: grpc code ${typeof code === 'number' ? code : 'unknown'}`);
      return noStore(apiFailure({ message: 'Could not load the locked connections.', status: 500, code: 'ADMIN_LOCKS_READ_FAILED' }));
    }
  },
  { level: 'main' },
);
