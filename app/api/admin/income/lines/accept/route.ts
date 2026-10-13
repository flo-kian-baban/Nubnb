/**
 * POST /api/admin/income/lines/accept — Accept proposed lines for a property (admin-only, dispatch 27; dispatch 37C).
 *
 * Request: `{ propertyId, month, lines: [{ id, description?, amount? }] }` —
 * one line, edited or not, or a property's lines together. `description` and
 * `amount` ("2599.37", "-397.40") are sent only when the admin changed them.
 *
 * Response: 200 `{ lines, statementMonth }` — the lines as decided, and the
 * month whose statement they go on: theirs while it is open, else the next
 * open one, with their date printed (Kian's ruling M11). Since dispatch 37C
 * (M10) an accepted line is read where it is stored: nothing is copied into
 * a draft, and a finished statement is never touched. Refusals, each with
 * nothing accepted:
 *   409 LINES_CHANGED, LINK_CHANGED
 *   404 PROPERTY_NOT_FOUND
 *   422 AMOUNT_TOO_LARGE, or a field that is not one
 *   502 ACCEPT_FAILED (may or may not be accepted)
 *
 * Nothing reaches an owner's statement until an admin accepts it (Kian's
 * ruling); this is that step. Every response is no-store.
 */

import { NextRequest } from 'next/server';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { ACCEPT_REFUSALS, acceptLines } from '@/app/lib/firebase/server-income';
import { AcceptInputSchema } from '@/app/lib/income/schemas';

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
  const parsed = AcceptInputSchema.safeParse(body);
  if (!parsed.success) return noStore(apiValidationError(parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))));
  const { propertyId, month, lines } = parsed.data;
  const outcome = await acceptLines(actor, { propertyId, month, items: lines.map((line) => ({ id: line.id, ...(line.description === undefined ? {} : { description: line.description }), ...(line.amount === undefined ? {} : { amountCents: line.amount }) })) });
  if (outcome.kind === 'accepted') return noStore(apiSuccess({ lines: outcome.lines, statementMonth: outcome.statementMonth }));
  return noStore(apiFailure(ACCEPT_REFUSALS[outcome.kind]));
});
