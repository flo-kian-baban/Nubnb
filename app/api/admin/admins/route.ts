/**
 * GET  /api/admin/admins — Every admin (main admin only, dispatch 38).
 * POST /api/admin/admins — Add an admin (main admin only).
 *
 * Kian's rulings of 2026-10-13: one main admin, Kian, adds and removes admins
 * and sets their level; two levels, main admin and admin. (Evening:) the main
 * admin sets an admin's name when adding them. (Night:) the main admin sets
 * each admin's PIN when adding them; main admins see every admin's PIN, their
 * own included; PINs are stored readably and stay unique.
 *
 * GET response:  200 `{ admins: AdminSummary[] }`, oldest first — names,
 *                levels, the PIN (or, for one kept before PINs were
 *                readable, its state), last sign-in, who added them and their
 *                history. Never a hash or a lookup key.
 * POST request:  `{ name, level: 'main' | 'admin', pin }`
 * POST response: 201 `{ admin: AdminSummary }`. 409 ADMIN_NAME_TAKEN when the
 *                name, case and spacing aside, is another admin's; 409
 *                ADMIN_PIN_TAKEN when another admin holds the PIN now (one no
 *                admin holds any more may be set again: Kian's ruling of
 *                2026-10-17), 409 ADMIN_PIN_IS_A_CODE when a cleaner code,
 *                current or retired, is those digits (late night); 422 for a
 *                name not allowed, or a PIN that is not four digits, is too
 *                easy, or is the shared PIN; 422 ADMIN_PIN_PUBLIC for a value
 *                that appeared in Nubnb's public code (security rule,
 *                2026-10-19: the cleaner codes' list refuses PINs too), 503
 *                ADMIN_PIN_DENYLIST_UNKEYED when that list is set and cannot be
 *                checked. Each PIN refusal is one plain line
 *                that says why (Kian's ruling of 2026-10-17). 502: it may or
 *                may not have been added.
 *
 * A refused admin (403 MAIN_ADMIN_ONLY) gets nothing, the list included.
 */

import { NextRequest } from 'next/server';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { sharedPinMatches } from '@/app/lib/admins/pin';
import { PIN_IS_A_CODE, PIN_IS_SHARED, PIN_TAKEN } from '@/app/lib/admins/responses';
import { pinDenied } from '@/app/lib/admins/pin-denylist';
import { NewAdminSchema } from '@/app/lib/admins/schemas';
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

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return noStore(apiError('Invalid JSON body', 400));
    }
    const parsed = NewAdminSchema.safeParse(body);
    if (!parsed.success) return noStore(apiValidationError(parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))));
    if (sharedPinMatches(parsed.data.pin) === true) return noStore(apiFailure(PIN_IS_SHARED));
    // The list of codes never given out refuses a PIN too (security rule, 2026-10-19), before any read.
    const denied = pinDenied(parsed.data.pin);
    if (denied) return noStore(apiFailure(denied));

    try {
      const outcome = await createAdmin(actor, parsed.data);
      if (outcome.kind === 'name-taken') {
        return noStore(apiFailure({ status: 409, code: 'ADMIN_NAME_TAKEN', message: 'Another admin has that name.', hint: 'Names are matched without regard to case or spacing. Nothing was added.' }));
      }
      if (outcome.kind === 'pin-taken') return noStore(apiFailure(outcome.by === 'code' ? PIN_IS_A_CODE : PIN_TAKEN));
      console.log(`[admins] ${actor.id} added ${outcome.admin.id} as ${parsed.data.level}`);
      return noStore(apiSuccess({ admin: outcome.admin }, 201));
    } catch (err) {
      console.error(`[admins] add failed: grpc code ${grpcCode(err)}`);
      return noStore(apiFailure({ status: 502, code: 'ADMIN_ADD_UNCONFIRMED', message: 'Could not confirm the admin was added.', hint: 'It may or may not have been. Reload the list to see.' }));
    }
  },
  { level: 'main' },
);
