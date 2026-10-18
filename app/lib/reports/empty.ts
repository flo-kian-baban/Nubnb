/**
 * Empty months finished together (dispatch 36: Step 3 of the dispatch 31
 * plan, O3).
 *
 * Kian's rulings of 2026-10-12: empty months can be finished together from
 * the Statements panel. Each property still gets its own statement, PDF and
 * reference, the reference suggested from its last one — or, when the
 * property has a reference stem, as "<Mon>-<stem>" (Kian's ruling K5 of
 * 2026-10-17). It refuses while
 * any Airbnb title in that month's file is neither linked nor set aside. The
 * list leaves out any property whose calendar showed stays the month's file
 * does not hold, and any property missing a Report For name.
 *
 * A property is on the list when its month is owed and not finished — Due
 * or Past due, in Nubnb's cycle — and finishing it would issue a statement
 * with nothing in it ("Nothing to report this month.", no fee: the standing
 * rule that an empty month has no fee line) and nothing Finish would warn
 * about. Every other owed, unfinished property is left out, with why:
 *   - no Report For name;
 *   - a draft in progress (anything typed but its reference and date);
 *   - Airbnb lines for the month waiting on the Income page, or accepted and
 *     on its statement (read where they are stored since dispatch 37C);
 *   - its calendar shows check-ins in the month and the month's file holds
 *     nothing for it (I15);
 *   - a cost, an earlier month's cost, an adjustment or a carried balance;
 *   - anything else Finish would warn about (an uncarried debt, a pending
 *     entry, a cut Report For…): an empty statement goes out unread, so it
 *     goes out only when nothing needs a look.
 *
 * Pure and client-safe: the server decides with it, the panel shows it.
 */

import type { CostEntryView } from '@/app/lib/cleaners/model';
import { finishChecks } from './checks';
import { currentReports, inStatementScope, isExcludedFromReporting, monthLabel, type MonthlyReportView, type PropertyManagementView, type StatementDraftView } from './model';
import { moneyMonthsByProperty, monthStanding, nothingToReport, suggestedReference, type PlatformLineInput } from './statement';
import { monthMoney } from '@/app/lib/money/month';

/** A property whose empty month can be finished, with the reference suggested from its stem or its last statement (null when it has neither). */
export interface EmptyCandidate {
  propertyId: string;
  name: string;
  standing: 'due' | 'pastDue';
  reference: string | null;
}

/** An owed, unfinished property left off the list, and why, in one line. */
export interface EmptyLeftOut {
  propertyId: string;
  name: string;
  why: string;
}

/** A title in the month's file that is neither linked nor set aside: while any is, nothing is finished together. */
export interface UnsettledTitle {
  title: string;
  rows: number;
  amountCents: number;
}

export interface EmptyMonth {
  month: string;
  eligible: EmptyCandidate[];
  leftOut: EmptyLeftOut[];
  unsettled: UnsettledTitle[];
}

/** What became of one property the admin sent to be finished empty. */
export type EmptyFinishOutcome =
  | { propertyId: string; outcome: 'finished'; reportId: string; reference: string }
  | { propertyId: string; outcome: 'left-out' | 'failed'; why: string };

export interface EmptyInputs {
  month: string;
  /** Today, yyyy-mm-dd in Toronto. */
  today: string;
  properties: { id: string; name: string | null; internalName?: string | null; createdMonth?: string | null }[];
  management: PropertyManagementView[];
  /** Every finished report, of every property. */
  reports: MonthlyReportView[];
  /** Every draft, of every property and month. */
  drafts: StatementDraftView[];
  /** Every cost entry. */
  entries: CostEntryView[];
  /** What the month's file and calendar say: lines waiting by property, properties with check-ins and nothing in the file, titles unsettled. */
  income: { waiting: Map<string, number>; checkInsWithout: Set<string>; unsettled: UnsettledTitle[] };
  /** Every accepted line read where it is stored (dispatch 37C, `platformLinesOf`). Absent: none. */
  platformLines?: PlatformLineInput[];
}

/** A draft holds nothing but what the empty statement would print anyway: no lines, fee, balance, notes or correction. */
function draftIsEmpty(draft: StatementDraftView): boolean {
  return draft.lines.length === 0 && draft.fee === null && draft.carried === null && (draft.notes ?? '') === '' && draft.supersedes === null;
}

export function emptyMonth(input: EmptyInputs): EmptyMonth {
  const { month, today } = input;
  const records = new Map(input.management.map((record) => [record.propertyId, record]));
  const money = moneyMonthsByProperty(input.drafts, input.entries, input.platformLines ?? []);
  const eligible: EmptyCandidate[] = [];
  const leftOut: EmptyLeftOut[] = [];

  for (const property of input.properties) {
    const record = records.get(property.id) ?? null;
    if (isExcludedFromReporting(record)) continue;
    // The name the admin shows: its cleaner-facing name, else its public title (Kian's rulings of 2026-10-15, evening).
    const name = property.internalName?.trim() || property.name?.trim() || 'Unnamed property';
    const reports = input.reports.filter((report) => report.propertyId === property.id);
    const current = currentReports(reports);
    const finished = current.some((report) => report.month === month);
    const owed = inStatementScope(record, month, property.createdMonth ?? null, money.get(property.id) ?? []);
    const standing = monthStanding({ month, today, owed, finished });
    if (standing !== 'due' && standing !== 'pastDue') continue;
    const leave = (why: string) => leftOut.push({ propertyId: property.id, name, why });

    // ── The rulings' two, both said when both apply ──
    const ruled = [
      (record?.reportFor?.name ?? '').trim() === '' ? 'No Report For name.' : null,
      input.income.checkInsWithout.has(property.id) ? `Its calendar shows check-ins in ${monthLabel(month)} that the month's Airbnb file does not hold.` : null,
    ].filter((why): why is string => why !== null);
    if (ruled.length > 0) {
      leave(ruled.join(' '));
      continue;
    }
    // ── What makes the month not empty ──
    const draft = input.drafts.find((d) => d.propertyId === property.id && d.month === month && d.finishedAs === null) ?? null;
    if (draft && !draftIsEmpty(draft)) {
      leave('A draft is in progress.');
      continue;
    }
    const waiting = input.income.waiting.get(property.id) ?? 0;
    if (waiting > 0) {
      leave(`${waiting === 1 ? '1 Airbnb line waits' : `${waiting} Airbnb lines wait`} on the Income page.`);
      continue;
    }
    const last = current.filter((report) => report.month < month).sort((a, b) => b.month.localeCompare(a.month) || b.finishedAt.localeCompare(a.finishedAt))[0] ?? null;
    const reference = draft?.reference.trim() || suggestedReference(last, record?.referenceStem, month);
    // The month's money (dispatch 37A): the statement the empty draft would issue, as Finish builds it.
    const built = monthMoney({
      propertyId: property.id,
      propertyName: name,
      month,
      entries: input.entries,
      reports,
      draft: { reference: reference ?? '', reportDate: today, lines: [], fee: null, carried: null, notes: null, supersedes: null, finishedAs: null },
      management: record,
      platformLines: input.platformLines,
    }).build;
    if (built === null || built.kind !== 'ok') {
      leave('An approved cost cannot be added up.');
      continue;
    }
    if (built.statement.lines.some((line) => line.platformLineId !== undefined)) {
      leave('Accepted Airbnb lines are on its statement.');
      continue;
    }
    if (!nothingToReport(built.statement)) {
      leave('It has costs, an adjustment or a carried balance to settle.');
      continue;
    }
    // ── Anything else Finish would warn about: an empty statement goes out only when nothing needs a look ──
    const checks = finishChecks({ statement: built.statement, reports, entries: input.entries, income: { waiting: 0, unlinked: [], checkouts: 0 }, today });
    const warnings = [...checks.refusals, ...checks.warnings.filter((check) => check.key !== 'fee-none')];
    if (warnings.length > 0) {
      leave(warnings[0].text);
      continue;
    }
    eligible.push({ propertyId: property.id, name, standing, reference });
  }

  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'en-CA');
  return { month, eligible: eligible.sort(byName), leftOut: leftOut.sort(byName), unsettled: input.income.unsettled };
}
