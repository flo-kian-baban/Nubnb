/**
 * GET  /api/admin/payments — Every payment to the team, recorded or deleted, newest first (admin-only; Team pay,
 *                            Kian's rulings of 2026-10-15). The Team page works each person's Earned, Paid and Balance
 *                            out from these and the cost list it already loads (app/lib/pay/balance.ts).
 * POST /api/admin/payments — Record a payment to a team member (ruling 2): `{ memberId, amount: "300.00",
 *                            day: "yyyy-mm-dd", method: "e-transfer" | "cash" | "other", note? }`. The admin who
 *                            records it is the session's.
 *
 * Responses: GET 200 `{ payments, unreadable }`; POST 201 `{ payment }`. Refusals, nothing written: 400 for a body not
 * in shape; 422 PAYMENT_BAD_DAY (after today, or more than 12 months back); 404 MEMBER_NOT_FOUND. 502
 * PAYMENT_RECORD_FAILED: may or may not have been recorded. Every response is no-store.
 *
 * Reads: GET one per payment ever recorded; POST one (the team member).
 */

import { NextRequest } from 'next/server';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { RECORD_REFUSALS, listPayments, recordPayment } from '@/app/lib/firebase/server-pay';
import { RecordPaymentSchema } from '@/app/lib/pay/schemas';

const grpcCode = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? String(code) : 'unknown';
};

export const GET = adminRoute(async function GET() {
  try {
    const { payments, unreadable } = await listPayments();
    return noStore(apiSuccess({ payments, unreadable }));
  } catch (err) {
    console.error(`[pay] listing payments failed: grpc code ${grpcCode(err)}`);
    return noStore(apiFailure({ status: 503, code: 'PAYMENTS_UNAVAILABLE', message: 'Could not read the payments.', hint: 'Nothing is shown rather than a balance that might be wrong. Try again.' }));
  }
});

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
  const parsed = RecordPaymentSchema.safeParse(body);
  if (!parsed.success) return noStore(apiValidationError(parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))));

  const { memberId, amount, day, method, note } = parsed.data;
  const outcome = await recordPayment(actor, { memberId, amountCents: amount, day, method, note });
  switch (outcome.kind) {
    case 'recorded':
      return noStore(apiSuccess({ payment: outcome.payment }, 201));
    case 'bad-day':
      return noStore(apiFailure({ status: 422, code: 'PAYMENT_BAD_DAY', message: outcome.problem, hint: 'Nothing was recorded.' }));
    default:
      return noStore(apiFailure(RECORD_REFUSALS[outcome.kind]));
  }
});
