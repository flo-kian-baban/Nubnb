/**
 * What Finish checks before a statement is issued (dispatch 34: Step 1 of
 * the dispatch 31 plan, "Safe to finish").
 *
 * Kian's rulings of 2026-10-12: each check warns, and Finish asks for one
 * extra confirmation while any stands; only a statement with no Report For
 * name is refused. Unseen automatic approvals warn only. The month's Airbnb
 * checkouts may be shown beside a missing cleaning line, as a count, never
 * a charge.
 *
 * The checks, by the audit's IDs:
 *   refused  S20  no Report For name
 *   warned   S4   no NuBNB fee            S15  a $0.00 fee (which does not print, Kian's ruling of 2026-10-12)
 *            S7   a fee label that does not work out to its amount
 *            S6   lines changed since the fee's base was typed
 *            S3   an earlier month closed owing NuBNB and no statement carries it (dispatch 35: every such month, not only the last)
 *            S2   a carried balance whose month's statement was deleted and not finished again (dispatch 35: a corrected one is followed by the link)
 *            I1   Airbnb lines waiting, or titles in the month's file linked to no property
 *            N4   no cleaning line while the month's Airbnb file shows checkouts
 *            C2   costs approved automatically that nobody has looked at
 *            —    entries sent in the month still pending (said before, in the old confirmation)
 *            S25  Report For cut short on the PDF
 *            S13  a statement dated before the day it is finished
 *
 * Nothing here computes a price or fills anything in: a check reads what is
 * typed and stored and says so in one line. The fee label's check works the
 * label's own rate and base out only to compare them with the amount; the
 * checkout count is a count.
 *
 * Pure and client-safe: the Finish tab, its dialog and the verification run
 * the same function.
 */

import { awaitingLook, formatCents, type CostEntryView } from '@/app/lib/cleaners/model';
import { currentReports, dateText, feeComputed, isDayText, monthLabel, monthName, monthRange, type Fee, type MonthlyReportView } from './model';
import { carriedFromMonth, uncarriedDebts, type Statement } from './statement';
import { reportForCut } from './statement-pdf';

/** The tab where a check is put right. */
export type CheckTab = 'income' | 'costs' | 'details' | 'finish';

export interface FinishCheck {
  key: string;
  /** One line, as the Finish tab and the Finish dialog print it. */
  text: string;
  tab: CheckTab;
}

export interface FinishChecks {
  /** What stops Finish: only a statement with no Report For name (Kian's ruling of 2026-10-12). */
  refusals: FinishCheck[];
  /** What Finish warns about, asking one extra confirmation. */
  warnings: FinishCheck[];
}

/** What the platforms' files say about the property's month (dispatch 27's lines). */
export interface IncomeFacts {
  /** Lines under the property's titles for the month, still waiting on the Income page. */
  waiting: number;
  /** Titles in the month's files that are linked to no property. */
  unlinked: { title: string; rows: number; amountCents: number }[];
  /** Airbnb stays under the property's titles that checked out in the month: distinct reservations. */
  checkouts: number;
}

export interface CheckInputs {
  /** The statement as built for the month: the draft, its costs, Report For as it will print, its carried balance as linked. */
  statement: Statement;
  /** Every finished report of the property: the months that closed owing NuBNB, and where a carried balance came from. */
  reports: MonthlyReportView[];
  /** The property's cost entries: which of the statement's costs were approved automatically and not looked at. */
  entries: CostEntryView[];
  /** The files' facts for the month; null while they are not loaded, or when they could not be read. */
  income: IncomeFacts | null;
  /** Today, yyyy-mm-dd in Toronto. */
  today: string;
}

/** A line that charges cleaning: its description says so ("Expense - Cleaning", as the reports NuBNB sends have it). */
export function hasCleaningLine(statement: Pick<Statement, 'lines'>): boolean {
  return statement.lines.some((line) => /clean/i.test(line.description));
}

/**
 * The amount a fee's label works out to, when the label names a rate and a base ("NuBNB 20% Net of $9,539.78"),
 * and it is not the fee's amount (S7: "NuBNB 25% Net of $1,000.00 … −$180.00"). null when the label names no
 * rate and base, or works out to the amount.
 */
export function feeLabelMismatch(fee: Pick<Fee, 'label' | 'amountCents'> | null): { labelCents: number } | null {
  if (!fee) return null;
  const match = /(\d{1,3}(?:\.\d{1,2})?)\s*%\s*net\s+of\s+\$?\s*(\d{1,3}(?:,\d{3})*(?:\.\d{2})|\d+\.\d{2})/i.exec(fee.label);
  if (!match) return null;
  const rate = Math.round(Number(match[1]) * 100);
  const base = Math.round(Number(match[2].replace(/,/g, '')) * 100);
  const labelCents = feeComputed(base, rate);
  return labelCents === null || labelCents === fee.amountCents ? null : { labelCents };
}

/** Distinct Airbnb reservations that checked out in `month`: Reservation lines, not rejected, whose stay ends in it. */
export function checkoutsInMonth(lines: { type: string; status: string; confirmationCode: string; stay: { end: string | null } }[], month: string): number {
  const { from, to } = monthRange(month);
  const codes = new Set<string>();
  for (const line of lines) {
    if (line.type !== 'Reservation' || line.status === 'rejected' || line.stay.end === null) continue;
    if (line.stay.end >= from && line.stay.end <= to) codes.add(line.confirmationCode);
  }
  return codes.size;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Every check, for one statement as it stands. */
export function finishChecks(input: CheckInputs): FinishChecks {
  const { statement: s, income, today } = input;
  const month = monthLabel(s.month);
  const refusals: FinishCheck[] = [];
  const warnings: FinishCheck[] = [];

  // ── Refused (S20) ──
  if (!s.reportFor || s.reportFor.name.trim() === '') refusals.push({ key: 'report-for', text: 'No Report For name: a statement is never finished without one.', tab: 'details' });

  // ── The fee (S4, S15, S7, S6) ──
  if (!s.fee) warnings.push({ key: 'fee-none', text: 'No NuBNB fee.', tab: 'details' });
  else if (s.fee.amountCents === 0) warnings.push({ key: 'fee-zero', text: 'The NuBNB fee is $0.00: it does not print.', tab: 'details' });
  const mismatch = feeLabelMismatch(s.fee);
  if (s.fee && mismatch) warnings.push({ key: 'fee-label', text: `The fee's label works out to ${formatCents(mismatch.labelCents)}; its amount is ${formatCents(s.fee.amountCents)}.`, tab: 'details' });
  if (s.fee && s.fee.baseCents !== null && typeof s.fee.baseRevenueCents === 'number' && s.fee.baseRevenueCents !== s.incomeCents) {
    warnings.push({ key: 'fee-base', text: `Lines changed since the fee's base was typed: revenue was ${formatCents(s.fee.baseRevenueCents)}, now ${formatCents(s.incomeCents)}; the base is ${formatCents(s.fee.baseCents)}.`, tab: 'details' });
  }

  // ── The carried balance (S3, S2) ──
  // Every earlier month that closed owing NuBNB and that no statement carries (Kian's ruling: offered until one does).
  const carriedHere = carriedFromMonth(s.carried, input.reports);
  for (const debt of uncarriedDebts(input.reports, s.month).filter((row) => row.fromMonth !== carriedHere)) {
    warnings.push({ key: `debt-${debt.fromMonth}`, text: `${monthLabel(debt.fromMonth)} closed owing NuBNB ${formatCents(debt.amountCents)}; this statement does not carry it.`, tab: 'details' });
  }
  // A carried balance is a link (dispatch 35): a corrected statement is followed; a deleted one, not finished again, leaves nothing to follow.
  if (s.carried?.fromReportId) {
    const current = currentReports(input.reports);
    if (carriedHere === null) warnings.push({ key: 'carried-source', text: 'The carried balance came from a statement that has since been deleted.', tab: 'details' });
    else if (!current.some((report) => report.month === carriedHere)) warnings.push({ key: 'carried-source', text: `The carried balance came from ${monthLabel(carriedHere)}'s statement, since deleted: it carries ${formatCents(s.carried.amountCents)} until that month is finished again.`, tab: 'details' });
  }

  // ── Airbnb (I1, N4) ──
  if (income === null) {
    warnings.push({ key: 'airbnb-unread', text: 'The Airbnb lines are not loaded: waiting lines, unlinked titles and checkouts are not checked.', tab: 'income' });
  } else {
    if (income.waiting > 0) warnings.push({ key: 'airbnb-waiting', text: `${plural(income.waiting, 'Airbnb line', 'Airbnb lines')} for ${month} wait on the Income page.`, tab: 'income' });
    if (income.unlinked.length > 0) {
      const total = income.unlinked.reduce((sum, title) => sum + title.amountCents, 0);
      warnings.push({ key: 'airbnb-unlinked', text: `${plural(income.unlinked.length, 'title', 'titles')} in ${monthName(s.month)}'s Airbnb file ${income.unlinked.length === 1 ? 'is' : 'are'} linked to no property (${formatCents(total)}).`, tab: 'income' });
    }
    if (income.checkouts > 0 && !hasCleaningLine(s)) warnings.push({ key: 'cleaning', text: `No cleaning line · ${plural(income.checkouts, 'Airbnb checkout', 'Airbnb checkouts')} in ${monthName(s.month)}.`, tab: 'income' });
  }

  // ── Costs (C2, and the pending entries the old confirmation named) ──
  const printed = new Set(s.costs.map((cost) => cost.entryId));
  const unseen = input.entries.filter((entry) => printed.has(entry.id) && awaitingLook(entry)).length;
  if (unseen > 0) warnings.push({ key: 'auto-unseen', text: `${plural(unseen, 'cost', 'costs')} approved automatically ${unseen === 1 ? 'has' : 'have'} not been looked at.`, tab: 'costs' });
  if (s.pendingLeftOut > 0) warnings.push({ key: 'pending', text: `${plural(s.pendingLeftOut, 'entry', 'entries')} sent in ${month} ${s.pendingLeftOut === 1 ? 'is' : 'are'} still pending and not in it.`, tab: 'costs' });

  // ── The PDF (S25) and the date (S13) ──
  if (reportForCut(s.reportFor)) warnings.push({ key: 'report-for-cut', text: 'Report For is cut short on the PDF.', tab: 'details' });
  if (isDayText(s.reportDate) && s.reportDate < today) warnings.push({ key: 'date', text: `Dated ${dateText(s.reportDate)}, before today (${dateText(today)}).`, tab: 'finish' });

  return { refusals, warnings };
}
