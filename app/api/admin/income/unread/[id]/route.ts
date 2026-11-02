/**
 * POST /api/admin/income/unread/[id] — Decide a row of a platform's file that became no line (admin-only; Kian's
 * ruling of 2026-11-01). Until decided it is a gap of its month, on the Income page and in Finish's warnings.
 *
 * Request, one of:
 *   `{ action: "place", seen, propertyId, lineId }`   placed with a typed line already on the property's statement
 *                                                     for the row's month (its draft); the line is copied into the
 *                                                     decision as it stands
 *   `{ action: "not-ours", seen, reason }`            not Nubnb's money, with the admin's reason (1–300 characters)
 * `seen` is the row's history length as the page saw it.
 *
 * Response: 200 `{ unread }`, the row as decided. Refusals, nothing written: 400 for a body not in shape; 404
 * UNREAD_NOT_FOUND; 409 UNREAD_CHANGED, UNREAD_DECIDED; 422 UNREAD_LINE_NOT_FOUND; 500 UNREAD_UNREADABLE; 502
 * UNREAD_DECISION_FAILED (may or may not have landed). Every response is no-store.
 *
 * Reads: the row; for "place", the property's draft for the month. Writes: the row.
 */

import { NextRequest } from 'next/server';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { UNREAD_REFUSALS, markUnreadNotOurs, noSuchLineRefusal, placeUnread } from '@/app/lib/firebase/server-unread';
import { UnreadDecisionSchema } from '@/app/lib/income/schemas';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const POST = adminRoute(async function POST(request: NextRequest, context: RouteContext, { actor }) {
  const crossSite = refuseCrossSite(request);
  if (crossSite) return crossSite;
  const wrongType = requireMediaType(request, 'application/json');
  if (wrongType) return wrongType;
  const { id } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return noStore(apiError('Invalid JSON body', 400));
  }
  const parsed = UnreadDecisionSchema.safeParse(body);
  if (!parsed.success) return noStore(apiValidationError(parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))));
  const input = parsed.data;
  const outcome = input.action === 'place' ? await placeUnread(actor, id, { seen: input.seen, propertyId: input.propertyId, lineId: input.lineId }) : await markUnreadNotOurs(actor, id, { seen: input.seen, reason: input.reason });
  switch (outcome.kind) {
    case 'decided':
      return noStore(apiSuccess({ unread: outcome.unread }));
    case 'no-such-line':
      return noStore(apiFailure(noSuchLineRefusal(outcome.month)));
    default:
      return noStore(apiFailure(UNREAD_REFUSALS[outcome.kind]));
  }
});
