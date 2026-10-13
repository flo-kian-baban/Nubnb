/**
 * POST /api/admin/admins/[id]/pin — Give another admin a new temporary PIN (main admin only, dispatch 38).
 *
 * Request:  `{ pin }` — six digits the main admin typed or generated
 * Response: 200 `{ admin, changed: true }`
 *
 * For an admin who forgot their PIN, or whose PIN may be known to someone
 * else: every session they hold ends, any lock is cleared, and at their next
 * sign-in the temporary PIN opens only the step where they choose their own.
 * Not for yourself (409 ADMIN_IS_YOU): change your own PIN from the header.
 * Never for another main admin (409 MAIN_ADMIN_PROTECTED; Kian's ruling of
 * 2026-10-13: only they give themselves a new PIN). 404 ADMIN_NOT_FOUND; 422
 * for a PIN not allowed. 502: it may or may not have been set. The body holds
 * a PIN: never logged, never echoed.
 */

import { NextRequest } from 'next/server';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { ACCOUNT_REFUSALS } from '@/app/lib/admins/responses';
import { NewPinSchema } from '@/app/lib/admins/schemas';
import { ADMIN_AUTH_NOT_CONFIGURED, getAdminPinKey } from '@/app/lib/admins/secrets';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { resetAdminPin } from '@/app/lib/firebase/server-admins';
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
    const wrongType = requireMediaType(request, 'application/json');
    if (wrongType) return wrongType;
    const pinKey = getAdminPinKey();
    if (!pinKey) return noStore(apiFailure(ADMIN_AUTH_NOT_CONFIGURED));
    const { id } = await context.params;
    if (!isDocumentId(id)) return noStore(apiError('Invalid admin ID', 400));
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return noStore(apiError('Invalid JSON body', 400));
    }
    const parsed = NewPinSchema.safeParse(body);
    if (!parsed.success) return noStore(apiValidationError(parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))));
    try {
      const outcome = await resetAdminPin(actor, id, parsed.data.pin, pinKey);
      if (outcome.kind !== 'done') return noStore(apiFailure(ACCOUNT_REFUSALS[outcome.kind]));
      console.log(`[admins] ${actor.id} gave ${id} a new temporary PIN`);
      return noStore(apiSuccess({ admin: outcome.admin, changed: true }));
    } catch (err) {
      console.error(`[admins] new PIN for ${id} failed: grpc code ${grpcCode(err)}`);
      return noStore(apiFailure({ status: 502, code: 'ADMIN_CHANGE_UNCONFIRMED', message: 'Could not confirm the new PIN was set.', hint: 'It may or may not have been. Reload the list to see.' }));
    }
  },
  { level: 'main' },
);
