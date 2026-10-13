/**
 * PATCH  /api/admin/admins/[id] — Set an admin's level (main admin only, dispatch 38).
 * DELETE /api/admin/admins/[id] — Remove an admin (main admin only).
 *
 * PATCH request:  `{ level: 'main' | 'admin' }`; response 200 `{ admin, changed }`.
 *                 The level holds on that admin's next request: it is read
 *                 from their document every time, never from their token.
 * DELETE response: 200 `{ removed: { id, name } }`. Their document and name
 *                 go; every session they hold ends at its next request; what
 *                 they did keeps their ID and name in its own records.
 *
 * Kian's ruling of 2026-10-13: a main admin cannot be removed, demoted or
 * given a new PIN by anyone but themselves. Another main admin's account is
 * refused (409 MAIN_ADMIN_PROTECTED). A main admin may step down or remove
 * themselves while another main admin remains (409 LAST_MAIN_ADMIN when none
 * would); removing oneself also takes the session cookie off this browser.
 * Promoting an admin stays open. 404 ADMIN_NOT_FOUND. 502: it may or may not
 * have been saved.
 */

import { NextRequest } from 'next/server';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { ACCOUNT_REFUSALS } from '@/app/lib/admins/responses';
import { SetLevelSchema } from '@/app/lib/admins/schemas';
import { clearAdminSessionCookie } from '@/app/lib/admins/session';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { removeAdmin, setAdminLevel } from '@/app/lib/firebase/server-admins';
import { isDocumentId } from '@/app/lib/firebase/server-leads';

interface RouteContext {
  params: Promise<{ id: string }>;
}

function grpcCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? String(code) : 'unknown';
}

export const PATCH = adminRoute(
  async function PATCH(request: NextRequest, context: RouteContext, { actor }) {
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
    const parsed = SetLevelSchema.safeParse(body);
    if (!parsed.success) return noStore(apiValidationError(parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))));
    try {
      const outcome = await setAdminLevel(actor, id, parsed.data.level);
      if (outcome.kind !== 'done') return noStore(apiFailure(ACCOUNT_REFUSALS[outcome.kind]));
      return noStore(apiSuccess({ admin: outcome.admin, changed: outcome.changed }));
    } catch (err) {
      console.error(`[admins] level change for ${id} failed: grpc code ${grpcCode(err)}`);
      return noStore(apiFailure({ status: 502, code: 'ADMIN_CHANGE_UNCONFIRMED', message: 'Could not confirm the level was set.', hint: 'It may or may not have been. Reload the list to see.' }));
    }
  },
  { level: 'main' },
);

export const DELETE = adminRoute(
  async function DELETE(request: NextRequest, context: RouteContext, { actor }) {
    const crossSite = refuseCrossSite(request);
    if (crossSite) return crossSite;
    const { id } = await context.params;
    if (!isDocumentId(id)) return noStore(apiError('Invalid admin ID', 400));
    try {
      const outcome = await removeAdmin(actor, id);
      if (outcome.kind !== 'removed') return noStore(apiFailure(ACCOUNT_REFUSALS[outcome.kind]));
      console.log(`[admins] ${actor.id} removed ${id}`);
      const response = noStore(apiSuccess({ removed: { id, name: outcome.name } }));
      if (id === actor.id) clearAdminSessionCookie(response);
      return response;
    } catch (err) {
      console.error(`[admins] removal of ${id} failed: grpc code ${grpcCode(err)}`);
      return noStore(apiFailure({ status: 502, code: 'ADMIN_CHANGE_UNCONFIRMED', message: 'Could not confirm the admin was removed.', hint: 'They may or may not have been. Reload the list to see.' }));
    }
  },
  { level: 'main' },
);
