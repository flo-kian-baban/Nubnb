/**
 * PATCH /api/admin/income/lines/[id] — One line (admin-only, dispatch 27; dispatch 37C).
 *
 * Request, one of:
 *   `{ action: "reject" }`           a proposed line
 *   `{ action: "propose-again" }`    a rejected line; an accepted one sent back for review while no finished
 *                                    statement locks it (Kian's ruling M10); or one accepted before dispatch 37C
 *                                    whose copy was removed from its draft
 *   `{ action: "edit", seen, description?, amount? }`   an accepted line, read where it is stored: the line itself
 *                                    changes, with its history (I10). `seen` is its history's length as the page saw it.
 *
 * Response: 200 `{ line }`. Refusals, nothing changed: 409 LINES_CHANGED, STILL_IN_STATEMENT, TITLE_SET_ASIDE,
 * LINE_LOCKED (a finished statement prints it), LINE_NOT_ACCEPTED, LINE_IN_DRAFT; 404 LINE_NOT_FOUND; 422
 * AMOUNT_TOO_LARGE; 502 DECISION_FAILED or EDIT_FAILED (may or may not have landed). Every response is no-store.
 */

import { NextRequest } from 'next/server';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { DECIDE_REFUSALS, EDIT_REFUSALS, decideLine, editAcceptedLine, isEarningsLineId, lockedRefusal } from '@/app/lib/firebase/server-income';
import { LineInputSchema } from '@/app/lib/income/schemas';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const PATCH = adminRoute(async function PATCH(request: NextRequest, context: RouteContext, { actor }) {
  const crossSite = refuseCrossSite(request);
  if (crossSite) return crossSite;
  const wrongType = requireMediaType(request, 'application/json');
  if (wrongType) return wrongType;
  const { id } = await context.params;
  if (!isEarningsLineId(id)) return noStore(apiError('Invalid line ID', 400));
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return noStore(apiError('Invalid JSON body', 400));
  }
  const parsed = LineInputSchema.safeParse(body);
  if (!parsed.success) return noStore(apiValidationError(parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))));
  const input = parsed.data;
  if (input.action === 'edit') {
    const outcome = await editAcceptedLine(actor, id, { ...(input.description !== undefined ? { description: input.description } : {}), ...(input.amount !== undefined ? { amountCents: input.amount } : {}) }, input.seen);
    if (outcome.kind === 'edited') return noStore(apiSuccess({ line: outcome.line }));
    if (outcome.kind === 'locked') return noStore(apiFailure(lockedRefusal(outcome, 'changed')));
    return noStore(apiFailure(EDIT_REFUSALS[outcome.kind]));
  }
  const outcome = await decideLine(actor, id, input.action);
  if (outcome.kind === 'decided') return noStore(apiSuccess({ line: outcome.line }));
  if (outcome.kind === 'locked') return noStore(apiFailure(lockedRefusal(outcome, 'sent back')));
  return noStore(apiFailure(DECIDE_REFUSALS[outcome.kind]));
});
