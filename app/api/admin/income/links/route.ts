/**
 * PUT /api/admin/income/links — Make a listing title a property's active title, or set it aside (admin-only,
 * dispatch 27; dispatch 37C).
 *
 * Request: `{ channel, title, propertyId, expected }` — `expected` is the
 * title's link as the page showed it: the property's ID, "not-nubnb" for a
 * title set aside, or null for none. Or `{ channel, title, notNubnb: true,
 * expected }` to set the title aside as not a Nubnb property (dispatch 36,
 * Kian's ruling of 2026-10-12): it stays listed and marked, leaves the gaps
 * count, and its proposed lines are rejected; the answer then carries
 * `rejected`, how many.
 *
 * Kian's rulings of 2026-10-13 (dispatch 37C): each property holds one active
 * title, set on its edit page; the Income page's Link is a second way to set
 * the same title (M12). Its previous active title stays its own, as a
 * previous title, so older files still match. A title linked to another
 * property moves only while none of its lines is on a finished statement;
 * its unfinished accepted lines go back for review (M13). Lines still
 * proposed follow the link.
 *
 * Response: 200 `{ link, previous, sentBack }` — the title the property had
 * before (now previous), and how many lines went back for review. 404
 * PROPERTY_NOT_FOUND; 409 LINK_CHANGED when the stored link is not
 * `expected`, TITLE_LINES_PRINTED (with `evidence.statements`, the statements named) or
 * TITLE_LINES_IN_DRAFT: nothing changes; 422 for a title or ID that is not
 * one. Every response is no-store.
 */

import { NextRequest } from 'next/server';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { LINK_REFUSALS, setActiveTitle, setTitleAside } from '@/app/lib/firebase/server-income';
import { LinkInputSchema } from '@/app/lib/income/schemas';
import { monthLabel } from '@/app/lib/reports/model';

export const PUT = adminRoute(async function PUT(request: NextRequest, _context: unknown, { actor }) {
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
  const parsed = LinkInputSchema.safeParse(body);
  if (!parsed.success) return noStore(apiValidationError(parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))));
  const { channel, title, propertyId, notNubnb, expected } = parsed.data;
  if (notNubnb) {
    const aside = await setTitleAside(actor, { platform: channel, title, expected });
    if (aside.kind === 'set-aside') return noStore(apiSuccess({ link: aside.link, rejected: aside.rejected }));
    return noStore(apiFailure(LINK_REFUSALS[aside.kind]));
  }
  const outcome = await setActiveTitle(actor, { platform: channel, title, propertyId: propertyId!, expected });
  if (outcome.kind === 'linked') return noStore(apiSuccess({ link: outcome.link, previous: outcome.previous, sentBack: outcome.sentBack }));
  if (outcome.kind === 'printed') return noStore(apiFailure({ ...LINK_REFUSALS.printed, evidence: { statements: outcome.statements.map((row) => `${monthLabel(row.month)} (${row.reference})`).join('; ') } }));
  return noStore(apiFailure(LINK_REFUSALS[outcome.kind]));
});
