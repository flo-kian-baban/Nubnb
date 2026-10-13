/**
 * /api/admin/properties/[id]/airbnb-title — A property's Airbnb title, from its edit page (admin-only, dispatch 37C).
 *
 * Kian's rulings of 2026-10-13: each property holds one active Airbnb title, set on its edit page; previous titles
 * are kept so older files still match. The property save never writes it: it is saved here, in its own record
 * (`earnings_title_links`, server-only), never on the world-readable property document. The Income page's Link is a
 * second way to set the same title (PUT /api/admin/income/links).
 *
 *   GET  200 `{ titles, candidates }` — the property's titles, active first, each with the last month it was in a
 *        file; and the titles in the uploaded files it could take: unlinked, set aside, or one of its own previous
 *        ones. 404 PROPERTY_NOT_FOUND.
 *   PUT  `{ title, expected }` — make `title` its active title, typed exactly or picked. `expected` is that title's
 *        link as the page showed it (its property's ID, "not-nubnb", or null). The answer and refusals are the
 *        links route's: 200 `{ link, previous, sentBack }`; 409 LINK_CHANGED, TITLE_LINES_PRINTED (M13: a title moves
 *        only while none of its lines is on a finished statement), TITLE_LINES_IN_DRAFT; 404 PROPERTY_NOT_FOUND.
 *
 * Every response is no-store.
 */

import { NextRequest } from 'next/server';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { isDocumentId } from '@/app/lib/firebase/server-leads';
import { LINK_REFUSALS, readPropertyTitles, setActiveTitle } from '@/app/lib/firebase/server-income';
import { TitleInputSchema } from '@/app/lib/income/schemas';
import { monthLabel } from '@/app/lib/reports/model';

interface RouteContext {
  params: Promise<{ id: string }>;
}

function grpcCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? String(code) : 'unknown';
}

export const GET = adminRoute(async function GET(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  if (!isDocumentId(id)) return noStore(apiError('Invalid property ID', 400));
  try {
    const titles = await readPropertyTitles(id);
    if (titles === null) return noStore(apiFailure(LINK_REFUSALS['no-such-property']));
    return noStore(apiSuccess(titles));
  } catch (err) {
    console.error(`[income] property ${id} titles read failed: grpc code ${grpcCode(err)}`);
    return noStore(apiFailure({ message: 'Failed to load the property\'s Airbnb title.', status: 500, code: 'TITLES_READ_FAILED' }));
  }
});

export const PUT = adminRoute(async function PUT(request: NextRequest, context: RouteContext, { actor }) {
  const crossSite = refuseCrossSite(request);
  if (crossSite) return crossSite;
  const wrongType = requireMediaType(request, 'application/json');
  if (wrongType) return wrongType;
  const { id } = await context.params;
  if (!isDocumentId(id)) return noStore(apiError('Invalid property ID', 400));
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return noStore(apiError('Invalid JSON body', 400));
  }
  const parsed = TitleInputSchema.safeParse(body);
  if (!parsed.success) return noStore(apiValidationError(parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))));
  const outcome = await setActiveTitle(actor, { platform: 'airbnb', title: parsed.data.title, propertyId: id, expected: parsed.data.expected });
  if (outcome.kind === 'linked') return noStore(apiSuccess({ link: outcome.link, previous: outcome.previous, sentBack: outcome.sentBack }));
  if (outcome.kind === 'printed') return noStore(apiFailure({ ...LINK_REFUSALS.printed, evidence: { statements: outcome.statements.map((row) => `${monthLabel(row.month)} (${row.reference})`).join('; ') } }));
  return noStore(apiFailure(LINK_REFUSALS[outcome.kind]));
});
