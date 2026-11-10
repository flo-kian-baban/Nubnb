/**
 * PUT /api/admin/properties/[id]/tracking — turn a unit's tracking on or off (admin-only; Kian's ruling of 2026-11-10,
 * "Not tracked by Nubnb").
 *
 * Request:  `{ tracked: boolean }`
 * Response: 200 `{ success: true, data: { record, tracked, changed, change } }` — the management record as stored
 *           (null when the unit has none and stays tracked), and what the switch did: `change` is
 *           `{ tracked, jobsRemoved, markersWritten, markersCleared, unreadable }`, or null when nothing differed
 *           404 PROPERTY_NOT_FOUND when no property has that ID
 *           500 MANAGEMENT_UNREADABLE when the stored record is not in the written shape
 *           502 TRACKING_WRITE_FAILED when the outcome is unknown
 *
 * The mark is `excludedFromReporting` on `property_management/{propertyId}` (server-only, dispatch 24), never a field
 * on the world-readable property document. Off removes the unit's open, unmarked jobs, each calendar job leaving the
 * deleted-job marker the sync honours; on clears those markers for checkouts from today on (server-tracking.ts). The
 * property form's Save flips the same mark through PUT …/management and does the same. Recorded in the activity log.
 * Every response is no-store.
 */

import { NextRequest } from 'next/server';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { isDocumentId } from '@/app/lib/firebase/server-leads';
import { setTracking } from '@/app/lib/firebase/server-tracking';

interface RouteContext {
  params: Promise<{ id: string }>;
}

function grpcCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? String(code) : 'unknown';
}

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
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => key !== 'tracked')) {
    return noStore(apiError('Send exactly { tracked: boolean }', 400));
  }
  const tracked = (body as { tracked?: unknown }).tracked;
  if (typeof tracked !== 'boolean') return noStore(apiValidationError([{ path: 'tracked', message: 'true or false' }]));

  try {
    const outcome = await setTracking(actor, id, tracked);
    if (outcome.kind === 'no-such-property') return noStore(apiFailure({ message: 'That property does not exist.', status: 404, code: 'PROPERTY_NOT_FOUND' }));
    if (outcome.kind === 'unreadable') return noStore(apiFailure({ message: 'The stored statements record is not in the shape a change needs.', status: 500, code: 'MANAGEMENT_UNREADABLE', hint: 'Nothing was changed.' }));
    const c = outcome.change;
    console.log(`[tracking] property ${id} ${tracked ? 'tracked' : 'not tracked'}${outcome.changed ? ` (jobs removed ${c?.jobsRemoved ?? 0}, markers written ${c?.markersWritten ?? 0}, cleared ${c?.markersCleared ?? 0})` : ' (unchanged)'}`);
    return noStore(apiSuccess({ record: outcome.record, tracked: outcome.tracked, changed: outcome.changed, change: outcome.change }));
  } catch (err) {
    console.error(`[tracking] write for ${id} failed: grpc code ${grpcCode(err)}`);
    return noStore(apiFailure({ message: 'Could not save whether the unit is tracked.', status: 502, code: 'TRACKING_WRITE_FAILED', hint: 'It may or may not have been saved. Open the property again to see what is stored.' }));
  }
});
