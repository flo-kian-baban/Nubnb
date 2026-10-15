/**
 * PATCH  /api/admin/cleanings/[id] — Change or remove a cleaning (admin-only, dispatch 37B).
 * DELETE /api/admin/cleanings/[id] — Delete a cleaning outright, while no finished statement prints it.
 *
 * Kian's ruling of 2026-10-13: a cleaning changed or removed after printing is adjusted on the next month's
 * statement, the rules costs follow; the statements do that from what is stored. A removed cleaning stays,
 * marked, and counts nowhere. A deleted one leaves no record of who cleaned or what they were paid.
 *
 * Kian's rulings of 2026-10-14 (night): a job's cleaning keeps its cleaner (409 CLEANING_FROM_JOB), and removing or
 * deleting it leaves its cleaner's mark on the job as "removed by the office", until an admin reopens it.
 *
 * Kian's ruling of 2026-10-15: a cleaning dated on or before a payment to its cleaner cannot be deleted (409
 * CLEANING_BEFORE_PAYMENT, naming the payment); it can be removed.
 *
 * PATCH request:  `{ action: "change", seen, day?, amount?: "75.00", cleanerId?, note?, reason? }` or
 *                 `{ action: "remove", seen, reason? }` — `seen` is the length of its history as the page showed it
 * PATCH response: 200 `{ cleaning, changed, statementMonth }` or `{ cleaning }` for a removal
 * DELETE request:  `{ seen }`; response 200 `{ deleted: { id } }`
 *
 * Refusals, nothing written: 404 CLEANING_NOT_FOUND; 409 CLEANING_CHANGED (its history changed since the page
 * loaded); 409 CLEANING_REMOVED; 409 CLEANING_PRINTED_MONTH (printed in a finished statement: its day may move
 * within its month only); 409 CLEANING_IN_STATEMENT (a finished statement prints it: remove it instead); 422
 * BAD_DAY, NOT_A_CLEANER; 404 CLEANER_NOT_FOUND. 502: may or may not have been written.
 */

import { NextRequest } from 'next/server';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { ChangeCleaningSchema, DeleteCleaningSchema } from '@/app/lib/cleanings/schemas';
import { CHANGE_REFUSALS, DELETE_REFUSALS, REMOVE_REFUSALS, changeCleaning, deleteCleaning, removeCleaning } from '@/app/lib/firebase/server-cleanings';
import { paymentWords } from '@/app/lib/pay/model';
import { isDocumentId } from '@/app/lib/firebase/server-leads';
import { monthLabel, reportRef } from '@/app/lib/reports/model';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const statementWords = (statements: { id: string; month: string; reference: string }[]) =>
  statements.map((s) => `${s.month ? monthLabel(s.month) : 'a month that cannot be read'}'s statement (${s.reference.trim() ? `# ${s.reference.trim()}` : `ref ${reportRef(s.id)}`})`).join(', and ');

async function readBody(request: NextRequest): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  const crossSite = refuseCrossSite(request);
  if (crossSite) return { ok: false, response: crossSite };
  const wrongType = requireMediaType(request, 'application/json');
  if (wrongType) return { ok: false, response: wrongType };
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return { ok: false, response: noStore(apiError('Invalid JSON body', 400)) };
  }
}

export const PATCH = adminRoute(async function PATCH(request: NextRequest, context: RouteContext, { actor }) {
  const read = await readBody(request);
  if (!read.ok) return read.response;
  const { id } = await context.params;
  if (!isDocumentId(id)) return noStore(apiError('Invalid cleaning ID', 400));
  const parsed = ChangeCleaningSchema.safeParse(read.body);
  if (!parsed.success) return noStore(apiValidationError(parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))));

  if (parsed.data.action === 'remove') {
    const outcome = await removeCleaning(actor, id, parsed.data.seen, parsed.data.reason);
    return outcome.kind === 'removed' ? noStore(apiSuccess({ cleaning: outcome.cleaning })) : noStore(apiFailure(REMOVE_REFUSALS[outcome.kind]));
  }
  const { seen, day, amount, cleanerId, note, reason } = parsed.data;
  const outcome = await changeCleaning(actor, id, { day, amountCents: amount, cleanerId, ...(note !== undefined ? { note } : {}) }, seen, reason);
  switch (outcome.kind) {
    case 'changed':
      return noStore(apiSuccess({ cleaning: outcome.cleaning, changed: outcome.changed, statementMonth: outcome.statementMonth }));
    case 'bad-day':
      return noStore(apiFailure({ status: 422, code: 'BAD_DAY', message: outcome.problem, hint: 'Nothing was saved.' }));
    case 'printed-month':
      return noStore(
        apiFailure({
          status: 409,
          code: 'CLEANING_PRINTED_MONTH',
          message: 'This cleaning is printed in a finished statement, so it keeps its month.',
          hint: `It is in ${statementWords(outcome.statements)}. Its day can move within that month only. Nothing was saved.`,
        }),
      );
    default:
      return noStore(apiFailure(CHANGE_REFUSALS[outcome.kind]));
  }
});

export const DELETE = adminRoute(async function DELETE(request: NextRequest, context: RouteContext, { actor }) {
  const read = await readBody(request);
  if (!read.ok) return read.response;
  const { id } = await context.params;
  if (!isDocumentId(id)) return noStore(apiError('Invalid cleaning ID', 400));
  const parsed = DeleteCleaningSchema.safeParse(read.body);
  if (!parsed.success) return noStore(apiValidationError(parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))));
  const outcome = await deleteCleaning(actor, id, parsed.data.seen);
  switch (outcome.kind) {
    case 'deleted':
      return noStore(apiSuccess({ deleted: { id: outcome.id } }));
    case 'in-statement':
      return noStore(
        apiFailure({
          status: 409,
          code: 'CLEANING_IN_STATEMENT',
          message: 'This cleaning is printed in a finished statement, so it cannot be deleted.',
          hint: `It is in ${statementWords(outcome.statements)}. A statement already sent cannot point to a cleaning that no longer exists. Nothing was deleted. Remove it instead: the next open statement gives it back.`,
        }),
      );
    case 'before-payment':
      return noStore(
        apiFailure({
          status: 409,
          code: 'CLEANING_BEFORE_PAYMENT',
          message: `This cleaning is dated on or before ${outcome.cleanerName ? `${outcome.cleanerName}'s` : "its cleaner's"} ${paymentWords(outcome.payment).replace(/^the /, '')}, so it cannot be deleted.`,
          hint: 'Remove it instead: it stays on record, marked, and stops counting. Nothing was deleted.',
          evidence: { payment: outcome.payment.id },
        }),
      );
    default:
      return noStore(apiFailure(DELETE_REFUSALS[outcome.kind]));
  }
});
