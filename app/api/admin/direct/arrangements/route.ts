/**
 * POST /api/admin/direct/arrangements — Start an arrangement on a property (admin-only; part B of
 * PROPERTY-LIST-COLUMNS-PLAN.md, Kian's rulings of 2026-10-15): `{ propertyId, payerName, wording, amount: "1200.00",
 * dueDay: 1–28, fromMonth: "yyyy-mm" }`. Monthly; the payer's name is never printed. The admin is the session's.
 *
 * Responses: 201 `{ arrangement }`. Refusals, nothing written: 400 for a body not in shape; 422 ARRANGEMENT_REFUSED
 * (a month more than 12 away); 404 PROPERTY_NOT_FOUND. 502 ARRANGEMENT_SAVE_FAILED: may or may not have been saved.
 */

import { NextRequest } from 'next/server';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { StartArrangementSchema } from '@/app/lib/direct/schemas';
import { ARRANGEMENT_REFUSALS, startArrangement } from '@/app/lib/firebase/server-direct';

export const POST = adminRoute(async function POST(request: NextRequest, _context: unknown, { actor }) {
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
  const parsed = StartArrangementSchema.safeParse(body);
  if (!parsed.success) return noStore(apiValidationError(parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))));
  const { propertyId, payerName, wording, amount, dueDay, fromMonth } = parsed.data;
  const outcome = await startArrangement(actor, { propertyId, payerName, wording, cents: amount, dueDay, fromMonth });
  if (outcome.kind === 'saved') return noStore(apiSuccess({ arrangement: outcome.arrangement }, 201));
  if (outcome.kind === 'refused') return noStore(apiFailure({ status: 422, code: 'ARRANGEMENT_REFUSED', message: outcome.problem, hint: 'Nothing was saved.' }));
  return noStore(apiFailure(ARRANGEMENT_REFUSALS[outcome.kind]));
});
