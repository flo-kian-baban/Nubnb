/**
 * Empty months finished together, on the server (dispatch 36: Step 3 of the dispatch 31 plan; Kian's rulings of
 * 2026-10-12). Which properties are on the list is `emptyMonth`'s (reports/empty.ts); this reads what it needs and
 * finishes the ones the admin confirmed, each through `finishStatement`, so each gets its own statement, PDF and
 * reference, exactly as one finished on its page.
 *
 * Reads, for one month: every finished report and draft (whole), every cost entry with every property's name and
 * created month, every management record, and the Income page's month (its files, lines, links and calendar).
 *
 * A month that has not ended is refused (`not-closed`): only an owed month can be empty and due. While any title
 * in the month's file is neither linked nor set aside, nothing is finished (`unsettled`). Each confirmed property is
 * checked again before it is written; one no longer on the list is left out and said.
 */

import { z } from 'zod';
import { getAdminDb } from './admin';
import { isDocumentId } from './server-leads';
import { listCosts } from './server-cost-entries';
import { listManagement } from './server-management';
import { readIncomeMonth, unlinkedTitlesFromLines } from './server-income';
import { FINISH_REFUSALS, finishStatement, writeEmptyDraft } from './server-reports';
import type { Actor } from '@/app/lib/cleaners/model';
import { torontoDayOf } from '@/app/lib/costs/report';
import { monthView } from '@/app/lib/income/month';
import { EARNINGS_LINES_COLLECTION, platformLinesOf, readEarningsLine, type EarningsLineView } from '@/app/lib/income/model';
import { emptyMonth, type EmptyFinishOutcome, type EmptyMonth, type UnsettledTitle } from '@/app/lib/reports/empty';
import { MONTHLY_REPORTS_COLLECTION, MONTHLY_REPORT_DRAFTS_COLLECTION, STATEMENT_LIMITS, isMonth, monthOfDay, readMonthlyReport, readStatementDraft, type MonthlyReportView, type StatementDraftView } from '@/app/lib/reports/model';

const CONTROL_CHARACTER = /\p{Cc}/u;

export type EmptyMonthRead = { kind: 'ok'; data: EmptyMonth; today: string } | { kind: 'not-closed'; today: string };

/**
 * The list for a month: who can be finished empty, who is left out and why, and the titles unsettled.
 *
 * @throws if a read fails.
 */
export async function readEmptyMonth(month: string): Promise<EmptyMonthRead> {
  const today = torontoDayOf(new Date());
  if (month >= monthOfDay(today)) return { kind: 'not-closed', today };
  const db = getAdminDb();
  const [reportsSnap, draftsSnap, management, costs, income, acceptedSnap] = await Promise.all([
    db.collection(MONTHLY_REPORTS_COLLECTION).get(),
    db.collection(MONTHLY_REPORT_DRAFTS_COLLECTION).get(),
    listManagement(),
    listCosts(),
    readIncomeMonth(month),
    // Every accepted line, read where it is stored (dispatch 37C): a month holding one is not empty, and is owed.
    db.collection(EARNINGS_LINES_COLLECTION).where('status', '==', 'accepted').get(),
  ]);
  if (costs.properties === null) throw new Error('The property names could not be read');
  const reports = reportsSnap.docs.map((doc) => readMonthlyReport(doc.id, doc.data())).filter((report): report is MonthlyReportView => report !== null);
  const drafts = draftsSnap.docs.map((doc) => readStatementDraft(doc.id, doc.data())).filter((draft): draft is StatementDraftView => draft !== null);
  // The month's file, as the Income page reads it: lines waiting by property, check-ins with nothing in the file, titles unsettled.
  const view = monthView({ uploads: income.uploads, lines: income.lines, links: income.links, lastSeen: income.lastSeen, properties: income.properties, statements: income.statements, calendar: income.calendar, month });
  const platformLines = platformLinesOf(acceptedSnap.docs.map((doc) => readEarningsLine(doc.id, doc.data())).filter((line): line is EarningsLineView => line !== null));
  // Counted from the month's stored lines, each row once (dispatch 37A, T3): as the Income page and Finish count them.
  const unsettled: UnsettledTitle[] = unlinkedTitlesFromLines(income.lines, income.links)
    .filter((title) => title.month === month)
    .map(({ title, rows, amountCents }) => ({ title, rows, amountCents }));
  const data = emptyMonth({
    month,
    today,
    properties: costs.properties,
    management,
    reports,
    drafts,
    entries: costs.entries,
    income: { waiting: new Map(view.review.map((group) => [group.propertyId, group.lines.length])), checkInsWithout: new Set(view.gaps.checkIns.map((row) => row.propertyId)), unsettled },
    platformLines,
  });
  return { kind: 'ok', data, today };
}

export const EmptyFinishInputSchema = z.strictObject({
  month: z.string().refine(isMonth, 'A month, like 2026-10'),
  items: z
    .array(
      z.strictObject({
        propertyId: z.string().refine((id) => isDocumentId(id), 'Not a property ID'),
        reference: z
          .string()
          .transform((s) => s.normalize('NFC').replace(/\s+/g, ' ').trim())
          .pipe(z.string().min(1, 'Give it a reference').max(STATEMENT_LIMITS.REFERENCE_MAX, `At most ${STATEMENT_LIMITS.REFERENCE_MAX} characters`).refine((s) => !CONTROL_CHARACTER.test(s), 'No control characters')),
      }),
    )
    .min(1, 'Choose at least one property')
    .max(500),
});

export type EmptyFinishResult = { kind: 'done'; results: EmptyFinishOutcome[] } | { kind: 'not-closed' } | { kind: 'unsettled'; titles: UnsettledTitle[] };

/**
 * Finish the confirmed properties' empty month, one after another: the draft written empty with the reference
 * typed and today's date, then finished as any statement is. A property no longer on the list is left out.
 *
 * @throws if the list cannot be read.
 */
export async function finishEmptyMonth(actor: Actor, input: z.output<typeof EmptyFinishInputSchema>): Promise<EmptyFinishResult> {
  const read = await readEmptyMonth(input.month);
  if (read.kind === 'not-closed') return { kind: 'not-closed' };
  if (read.data.unsettled.length > 0) return { kind: 'unsettled', titles: read.data.unsettled };
  const eligible = new Set(read.data.eligible.map((candidate) => candidate.propertyId));
  const leftOut = new Map(read.data.leftOut.map((row) => [row.propertyId, row.why]));
  const results: EmptyFinishOutcome[] = [];
  for (const item of input.items) {
    if (!eligible.has(item.propertyId)) {
      results.push({ propertyId: item.propertyId, outcome: 'left-out', why: leftOut.get(item.propertyId) ?? 'Not an empty month that is due.' });
      continue;
    }
    const saved = await writeEmptyDraft(item.propertyId, input.month, item.reference, read.today);
    if (saved.kind !== 'saved') {
      results.push({ propertyId: item.propertyId, outcome: 'failed', why: saved.kind === 'not-empty' ? 'A draft was typed into meanwhile.' : 'The draft could not be written.' });
      continue;
    }
    const finished = await finishStatement(actor, { propertyId: item.propertyId, month: input.month, draftRevision: saved.revision, entries: [], earlier: [], adjustments: [], carried: null, carriedAdjustments: [] });
    results.push(finished.kind === 'finished' ? { propertyId: item.propertyId, outcome: 'finished', reportId: finished.report.id, reference: finished.report.reference } : { propertyId: item.propertyId, outcome: 'failed', why: FINISH_REFUSALS[finished.kind].message });
  }
  return { kind: 'done', results };
}
