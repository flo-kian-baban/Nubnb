/**
 * PATCH /api/admin/direct/arrangements/[id] — Change an arrangement (admin-only; part B of
 * PROPERTY-LIST-COLUMNS-PLAN.md, Kian's rulings of 2026-10-15): `{ action: "pause" | "resume" | "end", seen, month }`
 * or `{ action: "amount", seen, month, amount: "1250.00" }` — from that month on (ended: its last month). Earlier
 * months keep theirs. Each change is a step in its history, with the session's admin; nothing is erased.
 *
 * Responses: 200 `{ arrangement }`. Refusals, nothing written: 400; 404 ARRANGEMENT_NOT_FOUND; 409 ARRANGEMENT_CHANGED
 * (its history changed since the page loaded); 422 ARRANGEMENT_REFUSED, saying why. 502 ARRANGEMENT_SAVE_FAILED.
 */

import { NextRequest } from 'next/server';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { ChangeArrangementSchema } from '@/app/lib/direct/schemas';
import { ARRANGEMENT_REFUSALS, changeArrangement, type ArrangementChange } from '@/app/lib/firebase/server-direct';
import { isDocumentId } from '@/app/lib/firebase/server-leads';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const PATCH = adminRoute(async function PATCH(request: NextRequest, context: RouteContext, { actor }) {
  const crossSite = refuseCrossSite(request);
  if (crossSite) return crossSite;
  const wrongType = requireMediaType(request, 'application/json');
  if (wrongType) return wrongType;
  const { id } = await context.params;
  if (!isDocumentId(id)) return noStore(apiError('Invalid arrangement ID', 400));
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return noStore(apiError('Invalid JSON body', 400));
  }
  const parsed = ChangeArrangementSchema.safeParse(body);
  if (!parsed.success) return noStore(apiValidationError(parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))));
  const data = parsed.data;
  const change: ArrangementChange = data.action === 'amount' ? { action: 'amount', month: data.month, cents: data.amount } : { action: data.action, month: data.month };
  const outcome = await changeArrangement(actor, id, data.seen, change);
  if (outcome.kind === 'saved') return noStore(apiSuccess({ arrangement: outcome.arrangement }));
  if (outcome.kind === 'refused') return noStore(apiFailure({ status: 422, code: 'ARRANGEMENT_REFUSED', message: outcome.problem, hint: 'Nothing was saved.' }));
  return noStore(apiFailure(ARRANGEMENT_REFUSALS[outcome.kind]));
});
