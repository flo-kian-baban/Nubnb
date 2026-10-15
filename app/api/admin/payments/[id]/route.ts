/**
 * DELETE /api/admin/payments/[id] — Delete a payment (admin-only; Team pay, Kian's ruling 4 of 2026-10-15): any admin,
 * after a confirmation naming it. It is marked deleted, with who and when, stops counting as paid, and stays in the
 * person's history: never erased.
 *
 * Request:  `{ seen }` — the length of the payment's history as the page showed it when the admin confirmed.
 * Response: 200 `{ payment }`, the payment as stored now. Refusals, nothing written: 404 PAYMENT_NOT_FOUND; 409
 * PAYMENT_CHANGED (its history changed since the page loaded); 409 PAYMENT_ALREADY_DELETED. 502
 * PAYMENT_DELETE_FAILED: may or may not have been deleted. Every response is no-store.
 */

import { NextRequest } from 'next/server';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { DELETE_PAYMENT_REFUSALS, deletePayment } from '@/app/lib/firebase/server-pay';
import { isDocumentId } from '@/app/lib/firebase/server-leads';
import { DeletePaymentSchema } from '@/app/lib/pay/schemas';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const DELETE = adminRoute(async function DELETE(request: NextRequest, context: RouteContext, { actor }) {
  const crossSite = refuseCrossSite(request);
  if (crossSite) return crossSite;
  const wrongType = requireMediaType(request, 'application/json');
  if (wrongType) return wrongType;
  const { id } = await context.params;
  if (!isDocumentId(id)) return noStore(apiError('Invalid payment ID', 400));
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return noStore(apiError('Invalid JSON body', 400));
  }
  const parsed = DeletePaymentSchema.safeParse(body);
  if (!parsed.success) return noStore(apiValidationError(parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))));
  const outcome = await deletePayment(actor, id, parsed.data.seen);
  return outcome.kind === 'deleted' ? noStore(apiSuccess({ payment: outcome.payment })) : noStore(apiFailure(DELETE_PAYMENT_REFUSALS[outcome.kind]));
});
