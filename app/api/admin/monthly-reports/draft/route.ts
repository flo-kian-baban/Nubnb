/**
 * GET /api/admin/monthly-reports/draft?property=&month= — The editor's read (admin-only, dispatch 23B).
 * PUT /api/admin/monthly-reports/draft — Save the draft, whole.
 *
 * GET answers `{ propertyName, draft, entries, reports, management }`: the
 * draft as stored (null when none yet), every entry of the property, every
 * finished report of the property and its management record. 404 when no
 * property has the ID.
 *
 * PUT takes `{ propertyId, month, revision, income, fee, notes, supersedes }`
 * and answers 200 `{ draft }`. `revision` is the one the page loaded (0 when
 * there was none); another stored revision is 409 DRAFT_CHANGED and nothing
 * is saved. A finished month is 409 DRAFT_FINISHED unless `supersedes` names
 * the report it was finished as, which reopens the draft as a correction.
 *
 * Order: the admin session, then the cross-site and media-type refusals, then
 * the JSON and the schema, then the work. Every response is no-store.
 */

import { NextRequest } from 'next/server';
import { verifyAdminSession } from '@/app/lib/api/verify-admin';
import { apiSuccess, apiError, apiFailure, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { DRAFT_REFUSALS, DraftInputSchema, readStatementBundle, saveDraft } from '@/app/lib/firebase/server-reports';
import { isDocumentId } from '@/app/lib/firebase/server-leads';
import { isMonth } from '@/app/lib/reports/model';

function grpcCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? String(code) : 'unknown';
}

export async function GET(request: NextRequest) {
  const auth = verifyAdminSession(request);
  if (!auth.valid) return noStore(apiError(auth.error!, auth.status!));
  const propertyId = request.nextUrl.searchParams.get('property') ?? '';
  const month = request.nextUrl.searchParams.get('month') ?? '';
  if (!isDocumentId(propertyId)) return noStore(apiError('Invalid property ID', 400));
  if (!isMonth(month)) return noStore(apiError('Invalid month: write it as yyyy-mm', 400));
  try {
    const bundle = await readStatementBundle(propertyId, month);
    if (bundle === null) return noStore(apiFailure({ message: 'Property not found', status: 404, code: 'PROPERTY_NOT_FOUND' }));
    return noStore(apiSuccess(bundle));
  } catch (err) {
    console.error(`[reports] draft read for ${propertyId} ${month} failed: grpc code ${grpcCode(err)}`);
    return noStore(apiFailure({ message: 'Failed to load the statement.', status: 500, code: 'STATEMENT_READ_FAILED' }));
  }
}

export async function PUT(request: NextRequest) {
  const auth = verifyAdminSession(request);
  if (!auth.valid) return noStore(apiError(auth.error!, auth.status!));
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
  const result = DraftInputSchema.safeParse(body);
  if (!result.success) {
    return noStore(apiValidationError(result.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))));
  }
  try {
    const outcome = await saveDraft(result.data);
    if (outcome.kind !== 'saved') {
      const refusal = DRAFT_REFUSALS[outcome.kind];
      return noStore(apiFailure(outcome.kind === 'changed-since' ? { ...refusal, hint: `${refusal.hint} It is at revision ${outcome.revision}.` } : refusal));
    }
    return noStore(apiSuccess({ draft: outcome.draft }));
  } catch (err) {
    console.error(`[reports] draft save failed before the transaction: grpc code ${grpcCode(err)}`);
    return noStore(apiFailure({ message: 'Could not check the property.', status: 503, code: 'STATEMENT_READ_FAILED', hint: 'Nothing was saved; retry.' }));
  }
}
