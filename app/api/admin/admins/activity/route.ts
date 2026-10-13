/**
 * GET /api/admin/admins/activity — The newest lines of the activity log (main admin only, dispatch 38).
 *
 * Query:    `limit`, 1–500, 100 when absent
 * Response: 200 `{ actions: AdminActionView[] }`, newest first
 *
 * Kian's ruling of 2026-10-13: every admin action records which admin did
 * it, from now on. The admin route wrapper writes one line per admin write
 * that succeeded (verify-admin.ts): who, when, the method, the path and the
 * status. Where a record already named "admin" — histories, decisions,
 * downloads, finished statements — it names the admin too, in itself.
 */

import { NextRequest } from 'next/server';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiFailure, apiSuccess, noStore } from '@/app/lib/api/safe-response';
import { listAdminActions } from '@/app/lib/firebase/server-admins';

export const GET = adminRoute(
  async function GET(request: NextRequest) {
    const asked = Number(request.nextUrl.searchParams.get('limit') ?? '100');
    const limit = Number.isInteger(asked) && asked >= 1 && asked <= 500 ? asked : 100;
    try {
      return noStore(apiSuccess({ actions: await listAdminActions(limit) }));
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      console.error(`[admins] activity read failed: grpc code ${typeof code === 'number' ? code : 'unknown'}`);
      return noStore(apiFailure({ message: 'Could not load the activity.', status: 500, code: 'ADMIN_ACTIONS_READ_FAILED' }));
    }
  },
  { level: 'main' },
);
