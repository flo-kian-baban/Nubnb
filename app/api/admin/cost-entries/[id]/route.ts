/**
 * DELETE /api/admin/cost-entries/[id] — Delete a cost entry outright (admin-only, dispatch 23H).
 *
 * The one route that deletes a cost entry (Kian's ruling of 2026-10-02,
 * reversing the earlier one that nothing is deleted): the entry and its
 * history, the model's reading beside it, the one-time-key record naming it,
 * and its receipt object in Storage all go. A deleted entry leaves no record
 * of what was claimed or who logged it. See deleteCostEntry in
 * server-cost-entries.ts, the only code that does it. Removing an entry
 * (…/status) is unchanged and keeps it, marked.
 *
 * Request:  `{ seen }` — the length of the entry's history as the page showed
 *           it when the admin confirmed
 * Response: 200 `{ deleted: { id, receipts, reading, submissions } }` — each
 *           of `receipts` is "deleted", "missing" (already gone) or "left"
 *           (the entry is gone, the object could not be deleted and is logged)
 *
 * Refusals, nothing deleted: 404 ENTRY_NOT_FOUND; 409 ENTRY_CHANGED (its
 * history changed since the page loaded); 409 ENTRY_IN_STATEMENT (a finished
 * statement prints it, and the refusal names which). 502
 * ENTRY_DELETE_FAILED: may or may not have been deleted.
 *
 * Order: the admin session, then the cross-site and media-type refusals, then
 * the ID, the JSON and the schema, then the work. Every response is no-store.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { verifyAdminSession } from '@/app/lib/api/verify-admin';
import { apiSuccess, apiError, apiFailure, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { longDay, torontoDayOf } from '@/app/lib/costs/report';
import { DELETE_ENTRY_REFUSALS, deleteCostEntry, type PrintedIn } from '@/app/lib/firebase/server-cost-entries';
import { isDocumentId } from '@/app/lib/firebase/server-leads';
import { displayRef, monthLabel } from '@/app/lib/reports/model';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Strict: a body that carries anything else is refused, not trimmed. */
const DeleteSchema = z.strictObject({
  seen: z.number().int().min(0).max(1_000_000),
});

/** One statement in words: "the statement for September 2026 (# Sep-321-John), finished 2 October 2026". */
function statementWords(statement: PrintedIn): string {
  const month = statement.month ? monthLabel(statement.month) : 'a month that cannot be read';
  const finished = statement.finishedAt && !Number.isNaN(Date.parse(statement.finishedAt))
    ? `, finished ${longDay(torontoDayOf(new Date(statement.finishedAt)))}`
    : '';
  return `the statement for ${month} (${displayRef(statement)})${finished}${statement.replaced ? ', since replaced' : ''}`;
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  // ── Auth ──
  const auth = verifyAdminSession(request);
  if (!auth.valid) return noStore(apiError(auth.error!, auth.status!));

  // ── Cross-site and media type ──
  const crossSite = refuseCrossSite(request);
  if (crossSite) return crossSite;
  const wrongType = requireMediaType(request, 'application/json');
  if (wrongType) return wrongType;

  const { id } = await context.params;
  if (!isDocumentId(id)) return noStore(apiError('Invalid entry ID', 400));

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return noStore(apiError('Invalid JSON body', 400));
  }

  // ── Validate ──
  const result = DeleteSchema.safeParse(body);
  if (!result.success) {
    return noStore(
      apiValidationError(result.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))),
    );
  }

  const outcome = await deleteCostEntry(id, result.data.seen);
  switch (outcome.kind) {
    case 'deleted':
      return noStore(
        apiSuccess({
          deleted: { id: outcome.id, receipts: outcome.receipts, reading: outcome.reading, submissions: outcome.submissions },
        }),
      );
    case 'in-statement':
      return noStore(
        apiFailure({
          status: 409,
          code: 'ENTRY_IN_STATEMENT',
          message: 'This entry is printed in a finished statement, so it cannot be deleted.',
          hint: `It is in ${outcome.statements.map(statementWords).join(', and in ')}. A statement already sent cannot point to an entry that no longer exists. Nothing was deleted. To take it out of totals, remove it instead.`,
          evidence: { statements: outcome.statements.map((statement) => statement.id).join(',') },
        }),
      );
    default:
      return noStore(apiFailure(DELETE_ENTRY_REFUSALS[outcome.kind]));
  }
}
