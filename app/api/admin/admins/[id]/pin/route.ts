/**
 * POST /api/admin/admins/[id]/pin — Set an ordinary admin's PIN (main admin only, dispatch 38).
 *
 * Request:  `{ pin }` — six digits the main admin chooses
 * Response: 200 `{ admin, changed }` — the row, its PIN included (main admins
 *           see every admin's PIN)
 *
 * Kian's rulings of 2026-10-13 (night): the main admin can change any
 * ordinary admin's PIN; PINs stay unique and are stored readably. Every
 * session the admin holds ends. Not for yourself (409 ADMIN_IS_YOU: Change
 * PIN in your own menu), never for another main admin (409
 * MAIN_ADMIN_PROTECTED: only they set their own). 409 ADMIN_PIN_TAKEN when
 * another admin holds it; 422 for a PIN that is not six digits, is too easy,
 * or is the shared PIN. 404 ADMIN_NOT_FOUND. 502: it may or may not have been
 * set.
 */

import { NextRequest } from 'next/server';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { sharedPinMatches } from '@/app/lib/admins/pin';
import { ACCOUNT_REFUSALS, PIN_IS_SHARED, PIN_TAKEN } from '@/app/lib/admins/responses';
import { SetPinSchema } from '@/app/lib/admins/schemas';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { setAdminPin } from '@/app/lib/firebase/server-admins';
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
    const { id } = await context.params;
    if (!isDocumentId(id)) return noStore(apiError('Invalid admin ID', 400));
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return noStore(apiError('Invalid JSON body', 400));
    }
    const parsed = SetPinSchema.safeParse(body);
    if (!parsed.success) return noStore(apiValidationError(parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))));
    if (sharedPinMatches(parsed.data.pin) === true) return noStore(apiFailure(PIN_IS_SHARED));
    try {
      const outcome = await setAdminPin(actor, id, parsed.data.pin);
      if (outcome.kind === 'pin-taken') return noStore(apiFailure(PIN_TAKEN));
      if (outcome.kind !== 'done') return noStore(apiFailure(ACCOUNT_REFUSALS[outcome.kind]));
      console.log(`[admins] ${actor.id} set the PIN of ${id}`);
      return noStore(apiSuccess({ admin: outcome.admin, changed: outcome.changed }));
    } catch (err) {
      console.error(`[admins] setting the PIN of ${id} failed: grpc code ${grpcCode(err)}`);
      return noStore(apiFailure({ status: 502, code: 'ADMIN_CHANGE_UNCONFIRMED', message: 'Could not confirm the PIN was set.', hint: 'It may or may not have been. Reload the list to see.' }));
    }
  },
  { level: 'main' },
);
