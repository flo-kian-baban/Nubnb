/**
 * GET  /api/admin/monthly-reports — Everything the statements tracker works from (admin-only, dispatch 23B).
 * POST /api/admin/monthly-reports — Finish a statement: freeze it, store its PDF, record it.
 *
 * GET answers `{ reports, drafts, downloads, management, properties, entries, unreadable }`:
 * every finished report's summary, every draft's summary, every download
 * record, every management record, every property's name and every cost
 * entry — read whole, so nothing can silently drop out. A failed read is a
 * 500, never an empty tracker.
 *
 * POST takes the page's claim `{ propertyId, month, draftRevision,
 * entries: [{ id, seen }], earlier: [{ id, seen }], adjustments: [{ entryId,
 * statementId, deltaCents }] }` and answers 201 `{ report }`. The server
 * rebuilds the statement from what is stored and refuses unless that is
 * exactly the claim: 409 STATEMENT_CHANGED. A draft at another revision, or
 * already finished: 409 DRAFT_CHANGED. No reference, no date, or a fee rate
 * with no base (dispatch 26): 422 STATEMENT_INCOMPLETE, its evidence's
 * `missing` naming which. 409 STATEMENT_ENTRY_UNREADABLE, 502
 * STATEMENT_PDF_FAILED (nothing written), 502 STATEMENT_RECORD_FAILED (may
 * or may not have been finished). See finishStatement.
 *
 * Order: the admin session, then the cross-site and media-type refusals, then
 * the JSON and the schema, then the work. Every response is no-store.
 */

import { NextRequest } from 'next/server';
import { verifyAdminSession } from '@/app/lib/api/verify-admin';
import { apiSuccess, apiError, apiFailure, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { FINISH_REFUSALS, FinishInputSchema, finishStatement, readTracker } from '@/app/lib/firebase/server-reports';

export const maxDuration = 30;

function grpcCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? String(code) : 'unknown';
}

export async function GET(request: NextRequest) {
  const auth = verifyAdminSession(request);
  if (!auth.valid) return noStore(apiError(auth.error!, auth.status!));
  try {
    return noStore(apiSuccess(await readTracker()));
  } catch (err) {
    console.error(`[reports] tracker read failed: grpc code ${grpcCode(err)}`);
    return noStore(apiFailure({ message: 'Failed to load the statements.', status: 500, code: 'REPORTS_READ_FAILED' }));
  }
}

export async function POST(request: NextRequest) {
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
  const result = FinishInputSchema.safeParse(body);
  if (!result.success) {
    return noStore(apiValidationError(result.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))));
  }

  try {
    const outcome = await finishStatement(result.data);
    if (outcome.kind !== 'finished') {
      const refusal = FINISH_REFUSALS[outcome.kind];
      if (outcome.kind === 'unreadable') return noStore(apiFailure({ ...refusal, hint: `${refusal.hint} Entries: ${outcome.entryIds.join(', ')}.` }));
      if (outcome.kind === 'incomplete') return noStore(apiFailure({ ...refusal, evidence: { missing: outcome.missing.join(', ') } }));
      return noStore(apiFailure(refusal));
    }
    return noStore(apiSuccess({ report: outcome.report }, 201));
  } catch (err) {
    console.error(`[reports] finish failed before any write: grpc code ${grpcCode(err)}`);
    return noStore(apiFailure({ message: 'Could not read what the statement is built from.', status: 503, code: 'STATEMENT_READ_FAILED', hint: 'Nothing was written; retry.' }));
  }
}
