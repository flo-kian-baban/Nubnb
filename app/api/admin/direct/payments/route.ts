/**
 * POST /api/admin/direct/payments — Record a payment received outside Airbnb (admin-only; part B of
 * PROPERTY-LIST-COLUMNS-PLAN.md, Kian's rulings of 2026-10-15): `{ propertyId, arrangementId | null, purpose |
 * null, payerName?, day: "yyyy-mm-dd", amount: "1200.00", method: "cash" | "e-transfer" | "cheque" | "other",
 * wording, note?, appliesTo?, stay? }`. An arrangement's payment pays the oldest unpaid month first unless
 * `appliesTo` sets the months; a one-off payment is a stay of 30 nights or more, with its stay's dates (`stay: { from,
 * to }`), or not a stay (no direct short stay is recorded until Kian confirms its tax treatment; the threshold is 30
 * nights, his ruling). The admin who records it is the session's, and received it.
 *
 * Responses: 201 `{ payment }`. Refusals, nothing written: 400; 422 DIRECT_PAYMENT_REFUSED (a day after today or more
 * than 12 months back, a month the arrangement does not expect, a stay under 30 nights); 404 PROPERTY_NOT_FOUND, ARRANGEMENT_NOT_FOUND. 502
 * DIRECT_PAYMENT_SAVE_FAILED: may or may not have been recorded.
 */

import { NextRequest } from 'next/server';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { RecordDirectPaymentSchema } from '@/app/lib/direct/schemas';
import { PAYMENT_REFUSALS, lockedRefusal, recordDirectPayment } from '@/app/lib/firebase/server-direct';

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
  const parsed = RecordDirectPaymentSchema.safeParse(body);
  if (!parsed.success) return noStore(apiValidationError(parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))));
  const b = parsed.data;
  const outcome = await recordDirectPayment(actor, { propertyId: b.propertyId, arrangementId: b.arrangementId, purpose: b.purpose, payerName: b.payerName, stay: b.stay, day: b.day, cents: b.amount, method: b.method, wording: b.wording, note: b.note, appliesTo: b.appliesTo });
  switch (outcome.kind) {
    case 'saved':
      return noStore(apiSuccess({ payment: outcome.payment }, 201));
    case 'refused':
      return noStore(apiFailure({ status: 422, code: 'DIRECT_PAYMENT_REFUSED', message: outcome.problem, hint: 'Nothing was recorded.' }));
    case 'locked':
      return noStore(apiFailure(lockedRefusal(outcome)));
    default:
      return noStore(apiFailure(PAYMENT_REFUSALS[outcome.kind]));
  }
});
