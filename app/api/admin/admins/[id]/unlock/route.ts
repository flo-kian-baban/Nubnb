/**
 * POST /api/admin/admins/[id]/unlock — End an admin's lock before its fifteen minutes (main admin only, dispatch 38).
 *
 * Response: 200 `{ admin, changed }` — `changed: false` when no lock held and
 * no wrong tries were counted. The count of wrong tries starts again. 404
 * ADMIN_NOT_FOUND. 502: it may or may not have been saved.
 */

import { NextRequest } from 'next/server';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, noStore } from '@/app/lib/api/safe-response';
import { ACCOUNT_REFUSALS } from '@/app/lib/admins/responses';
import { refuseCrossSite } from '@/app/lib/cleaners/request-guard';
import { unlockAdmin } from '@/app/lib/firebase/server-admins';
import { isDocumentId } from '@/app/lib/firebase/server-leads';

interface RouteContext {
  params: Promise<{ id: string }>;
}

function grpcCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? String(code) : 'unknown';
}

export const POST = adminRoute(
  async function POST(request: NextRequest, context: RouteContext, { actor }) {
    const crossSite = refuseCrossSite(request);
    if (crossSite) return crossSite;
    const { id } = await context.params;
    if (!isDocumentId(id)) return noStore(apiError('Invalid admin ID', 400));
    try {
      const outcome = await unlockAdmin(actor, id);
      if (outcome.kind !== 'done') return noStore(apiFailure(ACCOUNT_REFUSALS[outcome.kind]));
      return noStore(apiSuccess({ admin: outcome.admin, changed: outcome.changed }));
    } catch (err) {
      console.error(`[admins] unlock of ${id} failed: grpc code ${grpcCode(err)}`);
      return noStore(apiFailure({ status: 502, code: 'ADMIN_CHANGE_UNCONFIRMED', message: 'Could not confirm the PIN was unlocked.', hint: 'It may or may not have been. Reload the list to see.' }));
    }
  },
  { level: 'main' },
);
