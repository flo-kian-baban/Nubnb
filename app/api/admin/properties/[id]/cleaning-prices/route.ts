/**
 * GET /api/admin/properties/[id]/cleaning-prices — a property's cleaning prices (admin-only; Kian's ruling of
 *     2026-10-19): its short-term and long-term presets, and their history.
 * PUT /api/admin/properties/[id]/cleaning-prices — set both presets.
 *
 * Request (PUT): `{ shortTerm: "80.00" | null, longTerm: "120.00" | null }` — each a preset in dollars and cents, or
 *                null for none.
 * Response:      GET 200 `{ success: true, data: { record, unreadable } }` — `record` null when the property has no
 *                prices: `{ propertyId, shortTermCents, longTermCents, setAt, setBy, history }`.
 *                PUT 200 `{ success: true, data: { record, changed } }`; 404 PROPERTY_NOT_FOUND; 422 VALIDATION_ERROR;
 *                502 when it is not known whether it was saved.
 *
 * The record is `property_cleaning_prices/{propertyId}`, a server-only collection, never a field of the world-readable
 * property document: a body sent to PUT /api/properties/[id] that carries a price is refused there. Changing a preset
 * never changes an existing cleaning. Recorded in the activity log.
 *
 * Order: the admin session, then the cross-site and media-type refusals, then the ID, the JSON and the body, then the
 * work. Every response is no-store.
 */

import { NextRequest } from 'next/server';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { CleaningPricesSchema } from '@/app/lib/cleanings/schemas';
import { isDocumentId } from '@/app/lib/firebase/server-leads';
import { getCleaningPrices, setCleaningPrices } from '@/app/lib/firebase/server-cleaning-prices';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const grpcCode = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? String(code) : 'unknown';
};

export const GET = adminRoute(async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  if (!isDocumentId(id)) return noStore(apiError('Invalid property ID', 400));
  try {
    return noStore(apiSuccess(await getCleaningPrices(id)));
  } catch (err) {
    console.error(`[cleaning-prices] read of ${id} failed: grpc code ${grpcCode(err)}`);
    return noStore(apiFailure({ message: 'Could not read the cleaning prices.', status: 503, code: 'CLEANING_PRICES_UNAVAILABLE' }));
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
  const parsed = CleaningPricesSchema.safeParse(body);
  if (!parsed.success) return noStore(apiValidationError(parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))));

  const outcome = await setCleaningPrices(actor, id, { shortTermCents: parsed.data.shortTerm, longTermCents: parsed.data.longTerm });
  switch (outcome.kind) {
    case 'set':
      return noStore(apiSuccess({ record: outcome.record, changed: outcome.changed }));
    case 'no-such-property':
      return noStore(apiFailure({ message: 'That property does not exist.', status: 404, code: 'PROPERTY_NOT_FOUND' }));
    case 'failed':
      return noStore(apiFailure({ status: 502, code: 'CLEANING_PRICES_SAVE_FAILED', message: 'Could not save the cleaning prices.', hint: 'They may or may not have been saved. Reload to see.' }));
  }
});
