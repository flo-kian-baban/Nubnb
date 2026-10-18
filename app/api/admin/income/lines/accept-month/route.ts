/**
 * POST /api/admin/income/lines/accept-month — A month's routine lines accepted in one confirmation (admin-only;
 * Kian's ruling K1 of 2026-10-17).
 *
 * Request: `{ month, groups: [{ propertyId, ids }], expected: { lines, properties, amountCents } }` — the routine
 * lines the page offered, by property, and what its confirmation named. Each line is accepted as proposed, exactly
 * as one property's Accept does; nothing else is accepted.
 *
 * Response: 200 `{ lines, statementMonths }` — the lines as decided, and for each property the month whose statement
 * they go on: theirs while it is open, else the next open one, with their date printed (M11). Refusals, each with
 * nothing accepted:
 *   409 LINES_CHANGED, LINK_CHANGED, TOTALS_CHANGED (not what the confirmation named)
 *   409 LINES_HELD — a line K1 holds back for a decision of its own: a negative amount, a stay that began more than
 *       a month before the month, an unknown row type, a possible duplicate, or a property that owes no statement
 *   404 PROPERTY_NOT_FOUND; 422 AMOUNT_TOO_LARGE, or a field that is not one
 *   502 ACCEPT_FAILED (may or may not be accepted)
 *
 * Every response is no-store.
 */

import { NextRequest } from 'next/server';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { ACCEPT_MONTH_REFUSALS, acceptMonthLines, heldRefusal } from '@/app/lib/firebase/server-income';
import { AcceptMonthInputSchema } from '@/app/lib/income/schemas';

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
  const parsed = AcceptMonthInputSchema.safeParse(body);
  if (!parsed.success) return noStore(apiValidationError(parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))));
  const outcome = await acceptMonthLines(actor, parsed.data);
  if (outcome.kind === 'accepted') return noStore(apiSuccess({ lines: outcome.lines, statementMonths: outcome.statementMonths }));
  if (outcome.kind === 'held') return noStore(apiFailure({ ...heldRefusal(outcome.reasons), evidence: { held: outcome.ids.length } }));
  return noStore(apiFailure(ACCEPT_MONTH_REFUSALS[outcome.kind]));
});
