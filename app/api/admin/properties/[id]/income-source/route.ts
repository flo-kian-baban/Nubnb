/**
 * PUT /api/admin/properties/[id]/income-source — Mark a property "not paid through Nubnb's files", or unmark it
 * (admin-only; Kian's ruling K2 of 2026-10-17: each property with Airbnb bookings is either linked to a title from an
 * uploaded file or marked so by an admin).
 *
 * Request: `{ notThroughFiles, expected }` — the mark wanted, and the mark as the page showed it. Saved in its own
 * server-only record (`property_income_sources`), never on the world-readable property document.
 *
 * Response: 200 `{ notThroughFiles }`. 409 SOURCE_CHANGED when the stored mark is not `expected`; 404
 * PROPERTY_NOT_FOUND; 502 SOURCE_WRITE_FAILED (may or may not be saved). Every response is no-store.
 */

import { NextRequest } from 'next/server';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { isDocumentId } from '@/app/lib/firebase/server-leads';
import { INCOME_SOURCE_REFUSALS, setIncomeSource } from '@/app/lib/firebase/server-income';
import { IncomeSourceInputSchema } from '@/app/lib/income/schemas';

interface RouteContext {
  params: Promise<{ id: string }>;
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
  const parsed = IncomeSourceInputSchema.safeParse(body);
  if (!parsed.success) return noStore(apiValidationError(parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))));
  const outcome = await setIncomeSource(actor, id, parsed.data);
  if (outcome.kind === 'set') return noStore(apiSuccess({ notThroughFiles: outcome.notThroughFiles }));
  return noStore(apiFailure(INCOME_SOURCE_REFUSALS[outcome.kind]));
});
