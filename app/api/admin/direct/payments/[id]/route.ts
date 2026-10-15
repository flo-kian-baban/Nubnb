/**
 * PATCH /api/admin/direct/payments/[id] — Remove a payment, or set the months it pays (admin-only; part B of
 * PROPERTY-LIST-COLUMNS-PLAN.md, Kian's rulings of 2026-10-15): `{ action: "remove", seen }` or `{ action: "apply",
 * seen, appliesTo: [{ month, amount }] | null }` (null: the oldest unpaid month first). A removed payment is kept,
 * struck through and out of every total; never deleted. One printed on a finished statement is locked until that
 * statement is being corrected (409 DIRECT_PAYMENT_LOCKED, naming it). Setting its months changes no statement.
 *
 * Responses: 200 `{ payment }`. Refusals, nothing written: 400; 404 DIRECT_PAYMENT_NOT_FOUND; 409
 * DIRECT_PAYMENT_CHANGED, DIRECT_PAYMENT_REMOVED, DIRECT_PAYMENT_LOCKED; 422 DIRECT_PAYMENT_REFUSED. 502
 * DIRECT_PAYMENT_SAVE_FAILED: may or may not have been saved.
 */

import { NextRequest } from 'next/server';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { ChangeDirectPaymentSchema, isDirectPaymentId } from '@/app/lib/direct/schemas';
import { PAYMENT_REFUSALS, changeDirectPayment, lockedRefusal } from '@/app/lib/firebase/server-direct';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const PATCH = adminRoute(async function PATCH(request: NextRequest, context: RouteContext, { actor }) {
  const crossSite = refuseCrossSite(request);
  if (crossSite) return crossSite;
  const wrongType = requireMediaType(request, 'application/json');
  if (wrongType) return wrongType;
  const { id } = await context.params;
  if (!isDirectPaymentId(id)) return noStore(apiError('Invalid payment ID', 400));
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return noStore(apiError('Invalid JSON body', 400));
  }
  const parsed = ChangeDirectPaymentSchema.safeParse(body);
  if (!parsed.success) return noStore(apiValidationError(parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))));
  const data = parsed.data;
  const outcome = await changeDirectPayment(actor, id, data.seen, data.action === 'remove' ? { action: 'remove' } : { action: 'apply', appliesTo: data.appliesTo });
  switch (outcome.kind) {
    case 'saved':
      return noStore(apiSuccess({ payment: outcome.payment }));
    case 'refused':
      return noStore(apiFailure({ status: 422, code: 'DIRECT_PAYMENT_REFUSED', message: outcome.problem, hint: 'Nothing was changed.' }));
    case 'locked':
      return noStore(apiFailure(lockedRefusal(outcome)));
    default:
      return noStore(apiFailure(PAYMENT_REFUSALS[outcome.kind]));
  }
});
