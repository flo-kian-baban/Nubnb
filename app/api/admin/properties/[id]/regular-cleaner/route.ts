/**
 * GET /api/admin/properties/[id]/regular-cleaner — a property's regular cleaner (admin-only; Kian's ruling R5 of
 *     2026-10-19). `?choices=1` adds every active cleaner, for the edit page's choice.
 * PUT /api/admin/properties/[id]/regular-cleaner — set it, or clear it.
 *
 * Request (PUT): `{ cleanerId: string | null }` — an active cleaner, or null to clear it.
 * Response:      GET 200 `{ success: true, data: { regular, choices, unreadable } }` — `regular` null when none:
 *                `{ cleanerId, name, state, role, status, assigns, setAt, setBy }`, `assigns` false when they are no
 *                longer an active cleaner (the next job is then made with nobody on it).
 *                PUT 200 `{ success: true, data: { cleanerId, name, changed } }`; 404 PROPERTY_NOT_FOUND; 422
 *                CLEANER_NOT_ASSIGNABLE (deleted, a handyman, or deactivated); 502 when it is not known whether it was
 *                saved.
 *
 * The record is `property_regular_cleaners/{propertyId}`, a server-only collection, never a field of the
 * world-readable property document: a body sent to PUT /api/properties/[id] that carries it is refused there. When
 * the job sync makes a job for the property and its regular cleaner is an active cleaner, it puts them on it (the
 * job's history says "regular cleaner"). Jobs already made are never changed. Recorded in the activity log.
 *
 * Order: the admin session, then the cross-site and media-type refusals, then the ID, the JSON and the body, then the
 * work. Every response is no-store.
 */

import { NextRequest } from 'next/server';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { isDocumentId } from '@/app/lib/firebase/server-leads';
import { getRegularCleaner, setRegularCleaner } from '@/app/lib/firebase/server-regular-cleaners';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const grpcCode = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? String(code) : 'unknown';
};

const NOT_ASSIGNABLE = { missing: 'no longer exists', 'not-a-cleaner': 'is a handyman, not a cleaner', inactive: 'is deactivated' } as const;

export const GET = adminRoute(async function GET(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  if (!isDocumentId(id)) return noStore(apiError('Invalid property ID', 400));
  const withChoices = new URL(request.url).searchParams.get('choices') === '1';
  try {
    return noStore(apiSuccess(await getRegularCleaner(id, withChoices)));
  } catch (err) {
    console.error(`[regular-cleaner] read of ${id} failed: grpc code ${grpcCode(err)}`);
    return noStore(apiFailure({ message: 'Could not read the regular cleaner.', status: 503, code: 'REGULAR_CLEANER_UNAVAILABLE' }));
  }
});

export const PUT = adminRoute(async function PUT(request: NextRequest, context: RouteContext, { actor }) {
  const crossSite = refuseCrossSite(request);
  if (crossSite) return crossSite;
  const wrongType = requireMediaType(request, 'application/json');
  if (wrongType) return wrongType;

  const { id } = await context.params;
  if (!isDocumentId(id)) return noStore(apiError('Invalid property ID', 400));

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return noStore(apiError('Invalid JSON body', 400));
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => key !== 'cleanerId') || !('cleanerId' in body)) {
    return noStore(apiError('Send exactly { cleanerId: string | null }', 400));
  }
  const cleanerId = (body as { cleanerId: unknown }).cleanerId;
  if (cleanerId !== null && (typeof cleanerId !== 'string' || !isDocumentId(cleanerId))) {
    return noStore(apiValidationError([{ path: 'cleanerId', message: 'A cleaner’s ID, or null to clear it' }]));
  }

  const outcome = await setRegularCleaner(actor, id, cleanerId);
  switch (outcome.kind) {
    case 'set':
      return noStore(apiSuccess({ cleanerId, name: outcome.name, changed: true }));
    case 'cleared':
      return noStore(apiSuccess({ cleanerId: null, name: null, changed: true }));
    case 'unchanged':
      return noStore(apiSuccess({ cleanerId, name: null, changed: false }));
    case 'no-such-property':
      return noStore(apiFailure({ message: 'That property does not exist.', status: 404, code: 'PROPERTY_NOT_FOUND' }));
    case 'not-assignable':
      return noStore(apiFailure({ status: 422, code: 'CLEANER_NOT_ASSIGNABLE', message: `${outcome.name ?? 'That team member'} ${NOT_ASSIGNABLE[outcome.why]}.`, hint: 'Nothing was saved. Only an active cleaner is a regular cleaner.' }));
    case 'failed':
      return noStore(apiFailure({ status: 502, code: 'REGULAR_CLEANER_SAVE_FAILED', message: 'Could not save the regular cleaner.', hint: 'It may or may not have been saved. Reload to see.' }));
  }
});
