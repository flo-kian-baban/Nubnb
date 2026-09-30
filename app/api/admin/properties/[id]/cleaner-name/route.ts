/**
 * GET /api/admin/properties/[id]/cleaner-name — The name cleaners see for a property (admin-only, dispatch 21).
 * PUT /api/admin/properties/[id]/cleaner-name — Set it, or clear it.
 *
 * Request (PUT):  `{ name: string | null }` — null, or an empty string, clears it
 * Response:       200 `{ success: true, data: { name: string | null, changed } }`
 *                 404 PROPERTY_NOT_FOUND when no property has that ID
 *
 * The name lives in `property_cleaner_names/{propertyId}`, a server-only
 * collection, and never on the world-readable property document (Kian's
 * ruling of 2026-09-30: these may be street addresses). Cleaners read it
 * through GET /api/cleaner/start; no public page reads it. A body sent to
 * PUT /api/properties/[id] that carries `cleanerName` is refused there.
 *
 * Order: the admin session, then the cross-site and media-type refusals, then
 * the ID, the JSON and the name, then the work. Every response is no-store.
 */

import { NextRequest } from 'next/server';
import { verifyAdminSession } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { isDocumentId } from '@/app/lib/firebase/server-leads';
import {
  getCleanerFacingName,
  normaliseCleanerFacingName,
  setCleanerFacingName,
} from '@/app/lib/firebase/server-property-names';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** The one thing logged about a Firestore error: its gRPC code. */
function grpcCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? String(code) : 'unknown';
}

const NOT_FOUND = { message: 'That property does not exist.', status: 404, code: 'PROPERTY_NOT_FOUND' } as const;

export async function GET(request: NextRequest, context: RouteContext) {
  const auth = verifyAdminSession(request);
  if (!auth.valid) return noStore(apiError(auth.error!, auth.status!));

  const { id } = await context.params;
  if (!isDocumentId(id)) return noStore(apiError('Invalid property ID', 400));

  try {
    return noStore(apiSuccess({ name: await getCleanerFacingName(id) }));
  } catch (err) {
    console.error(`[cleaner-name] read of ${id} failed: grpc code ${grpcCode(err)}`);
    return noStore(apiFailure({ message: 'Could not read the name cleaners see.', status: 503, code: 'CLEANER_NAME_UNAVAILABLE' }));
  }
}

export async function PUT(request: NextRequest, context: RouteContext) {
  // ── Auth ──
  const auth = verifyAdminSession(request);
  if (!auth.valid) return noStore(apiError(auth.error!, auth.status!));

  // ── Cross-site and media type ──
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

  // ── Validate: exactly { name: string | null } ──
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => key !== 'name')) {
    return noStore(apiError('Send exactly { name: string | null }', 400));
  }
  const typed = (body as { name?: unknown }).name;
  if (typed !== null && typeof typed !== 'string') {
    return noStore(apiValidationError([{ path: 'name', message: 'A string, or null to clear it' }]));
  }
  const normalised = typed === null ? { name: null } : normaliseCleanerFacingName(typed);
  if ('problem' in normalised) return noStore(apiValidationError([{ path: 'name', message: normalised.problem }]));

  // ── The work ──
  try {
    const outcome = await setCleanerFacingName(id, normalised.name);
    if (outcome.kind === 'no-such-property') return noStore(apiFailure(NOT_FOUND));
    const name = outcome.kind === 'set' ? outcome.name : outcome.kind === 'cleared' ? null : outcome.name;
    console.log(`[cleaner-name] ${outcome.kind} for property ${id}`);
    return noStore(apiSuccess({ name, changed: outcome.kind !== 'unchanged' }));
  } catch (err) {
    console.error(`[cleaner-name] write for ${id} failed: grpc code ${grpcCode(err)}`);
    return noStore(
      apiFailure({
        message: 'Could not save the name cleaners see.',
        status: 502,
        code: 'CLEANER_NAME_WRITE_FAILED',
        hint: 'It may or may not have been saved. Open the property again to see what is stored.',
      }),
    );
  }
}
