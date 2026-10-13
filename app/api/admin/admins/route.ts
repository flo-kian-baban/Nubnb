/**
 * GET  /api/admin/admins — Every admin (main admin only, dispatch 38).
 * POST /api/admin/admins — Add an admin (main admin only).
 *
 * Kian's ruling of 2026-10-13: one main admin, Kian, adds and removes admins
 * and sets their level; two levels, main admin and admin.
 *
 * GET response:  200 `{ admins: AdminSummary[] }`, oldest first — names,
 *                levels, the PIN's state (own, temporary, shared), any lock,
 *                last sign-in, who added them and their history. Never a PIN,
 *                its hash or salt.
 * POST request:  `{ name, level: 'main' | 'admin', pin }` — `pin` is a
 *                temporary PIN of six digits the main admin typed or
 *                generated; the new admin chooses their own when they first
 *                sign in (PUT /api/admin-auth/pin).
 * POST response: 201 `{ admin: AdminSummary }`; 409 ADMIN_NAME_TAKEN when the
 *                name, case and spacing aside, is another admin's; 422 for a
 *                name or PIN that is not allowed. 502: it may or may not have
 *                been added.
 *
 * A refused admin (403 MAIN_ADMIN_ONLY) gets nothing, the list included.
 */

import { NextRequest } from 'next/server';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { NewAdminSchema } from '@/app/lib/admins/schemas';
import { ADMIN_AUTH_NOT_CONFIGURED, getAdminPinKey } from '@/app/lib/admins/secrets';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { createAdmin, listAdmins } from '@/app/lib/firebase/server-admins';

function grpcCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? String(code) : 'unknown';
}

export const GET = adminRoute(
  async function GET() {
    try {
      return noStore(apiSuccess({ admins: await listAdmins() }));
    } catch (err) {
      console.error(`[admins] list failed: grpc code ${grpcCode(err)}`);
      return noStore(apiFailure({ message: 'Could not load the admins.', status: 500, code: 'ADMINS_READ_FAILED' }));
    }
  },
  { level: 'main' },
);

export const POST = adminRoute(
  async function POST(request: NextRequest, _context: unknown, { actor }) {
    const crossSite = refuseCrossSite(request);
    if (crossSite) return crossSite;
    const wrongType = requireMediaType(request, 'application/json');
    if (wrongType) return wrongType;
    const pinKey = getAdminPinKey();
    if (!pinKey) return noStore(apiFailure(ADMIN_AUTH_NOT_CONFIGURED));

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return noStore(apiError('Invalid JSON body', 400));
    }
    const parsed = NewAdminSchema.safeParse(body);
    if (!parsed.success) return noStore(apiValidationError(parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))));

    try {
      const outcome = await createAdmin(actor, parsed.data, pinKey);
      if (outcome.kind === 'name-taken') {
        return noStore(apiFailure({ status: 409, code: 'ADMIN_NAME_TAKEN', message: 'Another admin has that name.', hint: 'Names are matched without regard to case or spacing. Nothing was added.' }));
      }
      console.log(`[admins] ${actor.id} added ${outcome.admin.id} as ${parsed.data.level}`);
      return noStore(apiSuccess({ admin: outcome.admin }, 201));
    } catch (err) {
      console.error(`[admins] add failed: grpc code ${grpcCode(err)}`);
      return noStore(apiFailure({ status: 502, code: 'ADMIN_ADD_UNCONFIRMED', message: 'Could not confirm the admin was added.', hint: 'It may or may not have been. Reload the list to see.' }));
    }
  },
  { level: 'main' },
);
