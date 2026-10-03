/**
 * PUT /api/admin/properties/[id]/visibility — Unlist a property, or list it again (admin-only, dispatch 24).
 *
 * Request:  `{ unlisted: boolean }`
 * Response: 200 `{ success: true, data: { unlisted, changed } }`
 *           404 PROPERTY_NOT_FOUND when no property has that ID
 *
 * Kian's ruling of 2026-10-03: an unlisted property does not appear anywhere
 * on the public site and stays fully usable inside. The mark is
 * `property_visibility/{propertyId}` (server-visibility.ts), never a field on
 * the property document. A change revalidates every public page that holds
 * the catalogue, so it shows on the next request rather than within the hour.
 *
 * Order: the admin session, then the cross-site and media-type refusals, then
 * the ID, the JSON and the flag, then the work. Every response is no-store.
 */

import { NextRequest } from 'next/server';
import { verifyAdminSession } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { isDocumentId } from '@/app/lib/firebase/server-leads';
import { setUnlisted } from '@/app/lib/firebase/server-visibility';
import { revalidateListingPages } from '@/app/lib/revalidate-listings';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** The one thing logged about a Firestore error: its gRPC code. */
function grpcCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? String(code) : 'unknown';
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

  // ── Validate: exactly { unlisted: boolean } ──
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => key !== 'unlisted')) {
    return noStore(apiError('Send exactly { unlisted: boolean }', 400));
  }
  const unlisted = (body as { unlisted?: unknown }).unlisted;
  if (typeof unlisted !== 'boolean') return noStore(apiValidationError([{ path: 'unlisted', message: 'true or false' }]));

  // ── The work ──
  try {
    const outcome = await setUnlisted(id, unlisted);
    if (outcome.kind === 'no-such-property') return noStore(apiFailure({ message: 'That property does not exist.', status: 404, code: 'PROPERTY_NOT_FOUND' }));
    if (outcome.changed) revalidateListingPages(`${unlisted ? 'unlist' : 'list'} ${id}`, id);
    console.log(`[visibility] property ${id} ${unlisted ? 'unlisted' : 'listed'}${outcome.changed ? '' : ' (unchanged)'}`);
    return noStore(apiSuccess({ unlisted: outcome.unlisted, changed: outcome.changed }));
  } catch (err) {
    console.error(`[visibility] write for ${id} failed: grpc code ${grpcCode(err)}`);
    return noStore(
      apiFailure({
        message: 'Could not save whether the property is listed.',
        status: 502,
        code: 'VISIBILITY_WRITE_FAILED',
        hint: 'It may or may not have been saved. Open the property again to see what is stored.',
      }),
    );
  }
}
