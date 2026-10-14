/**
 * PUT /api/admin-auth/name — Change name, from the signed-in admin's own menu (dispatch 38).
 *
 * Request:  `{ name }`; response 200 `{ admin, changed }`.
 *
 * Kian's ruling of 2026-10-13 (evening): the main admin sets an admin's name
 * when adding them; the admin can change their own name later; names stay
 * unique (409 ADMIN_NAME_TAKEN, case and spacing aside). The admin's history
 * keeps the name before and after; records made before keep the name they
 * were made under. 422 for a name not allowed. 502: it may or may not have
 * been saved.
 */

import { NextRequest } from 'next/server';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { signedInView } from '@/app/lib/admins/responses';
import { ChangeNameSchema } from '@/app/lib/admins/schemas';
import { ADMIN_SESSION_INVALID } from '@/app/lib/admins/session';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { changeOwnName } from '@/app/lib/firebase/server-admins';

function grpcCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? String(code) : 'unknown';
}

export const PUT = adminRoute(async function PUT(request: NextRequest, _context: unknown, { admin }) {
  const crossSite = refuseCrossSite(request);
  if (crossSite) return crossSite;
  const wrongType = requireMediaType(request, 'application/json');
  if (wrongType) return wrongType;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return noStore(apiError('Invalid JSON body', 400));
  }
  const parsed = ChangeNameSchema.safeParse(body);
  if (!parsed.success) return noStore(apiValidationError(parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))));
  try {
    const outcome = await changeOwnName(admin, parsed.data.name);
    if (outcome.kind === 'session-ended') return noStore(apiFailure(ADMIN_SESSION_INVALID));
    if (outcome.kind === 'name-taken') {
      return noStore(apiFailure({ status: 409, code: 'ADMIN_NAME_TAKEN', message: 'Another admin has that name.', hint: 'Names are matched without regard to case or spacing. Nothing was changed.' }));
    }
    return noStore(apiSuccess({ admin: signedInView(outcome.admin), changed: outcome.changed }));
  } catch (err) {
    console.error(`[admins] name change for ${admin.id} failed: grpc code ${grpcCode(err)}`);
    return noStore(apiFailure({ status: 502, code: 'ADMIN_CHANGE_UNCONFIRMED', message: 'Could not confirm the name was changed.', hint: 'It may or may not have been. Reload to see.' }));
  }
});
