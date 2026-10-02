/**
 * DELETE /api/admin/monthly-reports/[id] — Delete a finished statement and reopen its month as a draft (admin-only, dispatch 23G).
 *
 * The one route that deletes a finished statement (Kian's ruling of
 * 2026-10-02): its document, its stored PDF and every download record of
 * it go; the month's draft comes back holding everything the statement
 * held. Once deleted, there is no record of what an owner received. See
 * deleteFinishedStatement in server-reports.ts, the only code that does it.
 *
 * Body: `{ downloadsSeen }`, how many downloads the page showed when the
 * admin confirmed. Response: 200 `{ deleted: { reportId, downloads, pdf },
 * draft, management }` — `pdf` is "deleted", "missing" (already gone) or
 * "left" (the record is gone, the object could not be deleted and is
 * logged); `management` is the property's record when its Report For was
 * set back to what the statement printed, else null.
 *
 * Refusals, nothing deleted: 404 REPORT_NOT_FOUND; 409 REPORT_REPLACED (a
 * newer statement replaces it); 409 CORRECTION_IN_PROGRESS; 409
 * DRAFT_CHANGED; 409 DOWNLOADED_SINCE (a link was made since the page
 * loaded). 502 STATEMENT_DELETE_FAILED: may or may not have been deleted.
 *
 * Order: the admin session, then the cross-site and media-type refusals, then
 * the JSON and the schema, then the work. Every response is no-store.
 */

import { NextRequest } from 'next/server';
import { verifyAdminSession } from '@/app/lib/api/verify-admin';
import { apiSuccess, apiError, apiFailure, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { isDocumentId } from '@/app/lib/firebase/server-leads';
import { DELETE_REFUSALS, DeleteStatementInputSchema, deleteFinishedStatement } from '@/app/lib/firebase/server-reports';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const auth = verifyAdminSession(request);
  if (!auth.valid) return noStore(apiError(auth.error!, auth.status!));
  const crossSite = refuseCrossSite(request);
  if (crossSite) return crossSite;
  const wrongType = requireMediaType(request, 'application/json');
  if (wrongType) return wrongType;

  const { id } = await context.params;
  if (!isDocumentId(id)) return noStore(apiError('Invalid report ID', 400));
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return noStore(apiError('Invalid JSON body', 400));
  }
  const result = DeleteStatementInputSchema.safeParse(body);
  if (!result.success) {
    return noStore(apiValidationError(result.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))));
  }

  const outcome = await deleteFinishedStatement(id, result.data);
  if (outcome.kind !== 'deleted') {
    const refusal = DELETE_REFUSALS[outcome.kind];
    if (outcome.kind === 'replaced') return noStore(apiFailure({ ...refusal, hint: `${refusal.hint} It was replaced by ${outcome.by.slice(0, 6)}.` }));
    if (outcome.kind === 'downloaded-since') return noStore(apiFailure({ ...refusal, hint: `${refusal.hint} It now has ${outcome.downloads} download record${outcome.downloads === 1 ? '' : 's'}.` }));
    return noStore(apiFailure(refusal));
  }
  return noStore(apiSuccess({ deleted: { reportId: outcome.reportId, downloads: outcome.downloads, pdf: outcome.pdf }, draft: outcome.draft, management: outcome.management }));
}
