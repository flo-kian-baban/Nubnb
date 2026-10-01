/**
 * The statement's arithmetic, apart from React and apart from the server, so
 * the editor's live preview, the finish step and the tracker read the very
 * same numbers (dispatch 23B; the Payment Summary of dispatch 23E).
 *
 * ── Which entries a statement carries ──
 * An entry belongs to the Toronto month it was sent in, the ledger's rule
 * (sentDay). A statement for a month carries the property's approved
 * entries sent in that month; then approved entries sent in an earlier
 * month, on or after the property's first statement month, that no current
 * statement of the property lists; then every entry a current statement
 * printed whose amount now differs from what that statement last printed,
 * or which has since left the ledger. A statement being superseded is not
 * current, so its entries come back into the one replacing it. Each change
 * is carried once: the comparison is with the most recent current statement
 * that printed the entry, in its costs or its adjustments (Kian's decision 5).
 * On the Payment Summary each of these is a line like any other: "Expense -
 * …", "Expense - … (from June 2026)", "Adjustment - …".
 *
 * ── Money ──
 * A line's amount is quantity × rate (Kian's ruling of 2026-10-01, the one
 * place code computes money; `lineAmount` in model.ts). The revenue is the
 * sum of the positive lines; the expenses are the negative lines negated;
 * the recorded costs are the cost rows plus the adjustments' differences;
 * the fee is its amount. Total = revenue − expenses − recorded − fee, and
 * Your Revenue Share = total − the carried balance. Negative is owed to
 * NuBNB. Nothing is stored here: the finish step stores what it printed.
 *
 * Client-safe: model.ts, the cost model and the ledger's day functions.
 */

import { formatCents, type CostEntryView } from '@/app/lib/cleaners/model';
import { entryRef, sentDay, whatWasBoughtText } from '@/app/lib/costs/report';
import {
  INCOME_SOURCE_LABELS,
  addMonths,
  currentReports,
  feeComputed,
  isClosedMonth,
  monthLabel,
  monthOfDay,
  monthRange,
  monthReferenceWord,
  monthsBetween,
  rangeText,
  rateText,
  reportRef,
  statementMonths,
  type Carried,
  type Fee,
  type IncomeRow,
  type Line,
  type MonthlyReportView,
  type PropertyManagementView,
  type ReportFor,
  type StatementAdjustment,
  type StatementCost,
  type StatementDraftView,
  type Supersedes,
} from './model';

/** The Payment Summary as the writer lays it out: a draft being previewed, or a finished report of version 3. */
export interface Statement {
  legacy: false;
  propertyName: string;
  month: string;
  /** "Aug-321-John"; '' on a draft that has none yet. */
  reference: string;
  /** yyyy-mm-dd, printed "Sep 1, 2026". */
  reportDate: string;
  reportFor: ReportFor | null;
  /** True while previewing: the document says it is not yet issued. */
  draft: boolean;
  lines: Line[];
  costs: StatementCost[];
  adjustments: StatementAdjustment[];
  fee: Fee | null;
  carried: Carried | null;
  incomeCents: number;
  expensesCents: number;
  recordedCents: number;
  costsCents: number;
  feeCents: number;
  totalCents: number;
  carriedCents: number;
  payableCents: number;
  pendingLeftOut: number;
  notes: string | null;
  /** When replacing an earlier statement: how it is named, its date, and the reason. */
  supersedes: { ref: string; reportDate: string | null; finishedAt: string | null; reason: string } | null;
}

/** A statement of dispatches 23B and 23D, as their writer lays it out; drawn for reports finished before 23E. */
export interface LegacyStatement {
  legacy: true;
  propertyName: string;
  month: string;
  owners: string[];
  ref: string | null;
  finishedAt: string | null;
  income: IncomeRow[];
  incomeCents: number;
  costs: StatementCost[];
  adjustments: StatementAdjustment[];
  costsCents: number;
  fee: { label: string; amountCents: number } | null;
  feeCents: number;
  payableCents: number;
  pendingLeftOut: number;
  notes: string | null;
  supersedes: { ref: string; finishedAt: string | null; reason: string } | null;
}

export type AnyStatement = Statement | LegacyStatement;

/** The page's claim of what it built the statement from, checked again by the server at finish. */
export interface FinishClaim {
  entries: { id: string; seen: number }[];
  earlier: { id: string; seen: number }[];
  adjustments: { entryId: string; statementId: string; deltaCents: number }[];
}

export interface StatementInputs {
  propertyId: string;
  propertyName: string;
  month: string;
  /** Every entry of the property. */
  entries: CostEntryView[];
  /** Every finished report of the property. */
  reports: MonthlyReportView[];
  draft: Pick<StatementDraftView, 'reference' | 'reportDate' | 'lines' | 'fee' | 'carried' | 'notes' | 'supersedes'> | null;
  management: PropertyManagementView | null;
}

export type StatementBuild =
  | {
      kind: 'ok';
      statement: Statement;
      claim: FinishClaim;
      /** Entries sent in the month that another current statement already lists (after a correction): left out, and said. */
      reportedElsewhere: string[];
    }
  /** An approved entry the statement would carry cannot be added up. No statement is made. */
  | { kind: 'unreadable'; entryIds: string[] };

const byDay = (a: CostEntryView, b: CostEntryView) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id);

/** One approved, readable entry as a statement cost row. */
function costRow(entry: CostEntryView, group: StatementCost['group']): StatementCost | null {
  const day = sentDay(entry.createdAt);
  if (entry.linesNow.kind !== 'ok' || day === null || entry.history === null) return null;
  return {
    entryId: entry.id,
    ref: entryRef(entry.id),
    day,
    kind: entry.kind,
    description: whatWasBoughtText(entry.linesNow.lines) || '—',
    itemsCents: entry.linesNow.itemsCents,
    taxCents: entry.linesNow.taxCents,
    totalCents: entry.linesNow.totalCents,
    corrected: entry.linesNow.corrected,
    historyLength: entry.history.length,
    receiptSha256: entry.receipts?.[0]?.sha256 ?? null,
    group,
  };
}

/** What a statement printed for one entry: a cost row's total, or an adjustment's "now". */
export interface PrintedEntry {
  entryId: string;
  cents: number;
}

/** Everything a finished report printed, entry by entry. A full report gives it; a summary carries it (dispatch 23D). */
export function printedBy(report: Pick<MonthlyReportView, 'costs' | 'adjustments'>): PrintedEntry[] {
  return [...report.costs.map((cost) => ({ entryId: cost.entryId, cents: cost.totalCents })), ...report.adjustments.map((adjustment) => ({ entryId: adjustment.entryId, cents: adjustment.nowCents }))];
}

/** A finished report as the printed-entry lookup needs it: a full view, or the tracker's summary. */
export interface PrintedReport {
  id: string;
  finishedAt: string;
  printed: PrintedEntry[];
}

/**
 * The most recent current statement that printed each entry, and the amount
 * it printed: a cost row's total, or an adjustment's "now".
 */
export function lastPrinted(current: PrintedReport[]): Map<string, { reportId: string; finishedAt: string; cents: number }> {
  const printed = new Map<string, { reportId: string; finishedAt: string; cents: number }>();
  for (const report of current) {
    for (const { entryId, cents } of report.printed) {
      const was = printed.get(entryId);
      if (!was || report.finishedAt > was.finishedAt) printed.set(entryId, { reportId: report.id, finishedAt: report.finishedAt, cents });
    }
  }
  return printed;
}

/** The sums a set of lines, cost rows, adjustments, a fee and a carried balance add up to. */
export function statementSums(lines: Line[], costs: StatementCost[], adjustments: StatementAdjustment[], fee: Fee | null, carried: Carried | null) {
  const incomeCents = lines.filter((line) => line.amountCents > 0).reduce((sum, line) => sum + line.amountCents, 0);
  const expensesCents = -lines.filter((line) => line.amountCents < 0).reduce((sum, line) => sum + line.amountCents, 0);
  const recordedCents = costs.reduce((sum, row) => sum + row.totalCents, 0) + adjustments.reduce((sum, row) => sum + row.deltaCents, 0);
  const costsCents = expensesCents + recordedCents;
  const feeCents = fee?.amountCents ?? 0;
  const totalCents = incomeCents - costsCents - feeCents;
  const carriedCents = carried?.amountCents ?? 0;
  return { incomeCents, expensesCents, recordedCents, costsCents, feeCents, totalCents, carriedCents, payableCents: totalCents - carriedCents };
}

/**
 * Build one property's statement for one month from what is stored now.
 * Pure. The same function runs in the browser for the preview and on the
 * server at finish, on the same inputs, so the claim either side computes
 * is the same.
 */
export function buildStatement(input: StatementInputs): StatementBuild {
  const { propertyId, month, draft, management } = input;
  const range = monthRange(month);
  const { from: firstMonth } = statementMonths(management);
  const mine = input.entries.filter((entry) => entry.property.id === propertyId);
  const supersedingId = draft?.supersedes?.reportId ?? null;
  const current = currentReports(input.reports).filter((report) => report.id !== supersedingId);
  const listed = new Set(current.flatMap((report) => report.entryIds));

  const approved = mine.filter((entry) => entry.status === 'approved').sort(byDay);
  const unreadable: string[] = [];
  const costs: StatementCost[] = [];
  const reportedElsewhere: string[] = [];
  for (const entry of approved) {
    const day = sentDay(entry.createdAt);
    if (day === null) continue;
    const inMonth = day >= range.from && day <= range.to;
    const earlier = day < range.from && monthOfDay(day) >= firstMonth;
    if (!inMonth && !earlier) continue;
    if (listed.has(entry.id)) {
      if (inMonth) reportedElsewhere.push(entry.id);
      continue;
    }
    const row = costRow(entry, inMonth ? 'month' : 'earlier');
    if (row === null) unreadable.push(entry.id);
    else costs.push(row);
  }

  const byId = new Map(mine.map((entry) => [entry.id, entry]));
  const reportById = new Map(input.reports.map((report) => [report.id, report]));
  const adjustments: StatementAdjustment[] = [];
  for (const [entryId, { reportId, cents }] of lastPrinted(current.map((report) => ({ id: report.id, finishedAt: report.finishedAt, printed: printedBy(report) })))) {
    const entry = byId.get(entryId);
    let nowCents = 0;
    let historyLength = 0;
    if (entry) {
      if (entry.status === 'approved') {
        if (entry.linesNow.kind !== 'ok') {
          unreadable.push(entryId);
          continue;
        }
        nowCents = entry.linesNow.totalCents;
      }
      historyLength = entry.history?.length ?? 0;
    }
    if (nowCents !== cents) {
      const description = entry && entry.linesNow.kind === 'ok' ? whatWasBoughtText(entry.linesNow.lines) || null : null;
      adjustments.push({ entryId, statementId: reportId, printedCents: cents, nowCents, deltaCents: nowCents - cents, historyLength, description, printedMonth: reportById.get(reportId)?.month ?? null });
    }
  }
  adjustments.sort((a, b) => a.entryId.localeCompare(b.entryId));
  if (unreadable.length > 0) return { kind: 'unreadable', entryIds: [...new Set(unreadable)] };

  const lines = draft?.lines ?? [];
  const fee = draft?.fee ?? null;
  const carried = draft?.carried ?? null;
  const sums = statementSums(lines, costs, adjustments, fee, carried);
  const superseded = supersedingId === null ? null : (reportById.get(supersedingId) ?? null);
  const supersedes: Statement['supersedes'] =
    draft?.supersedes && supersedingId !== null
      ? { ref: superseded ? displayName(superseded) : reportRef(supersedingId), reportDate: superseded?.reportDate || null, finishedAt: superseded?.finishedAt ?? null, reason: draft.supersedes.reason }
      : null;

  return {
    kind: 'ok',
    statement: {
      legacy: false,
      propertyName: input.propertyName,
      month,
      reference: draft?.reference ?? '',
      reportDate: draft?.reportDate ?? '',
      reportFor: management?.reportFor ?? null,
      draft: true,
      lines,
      costs,
      adjustments,
      fee,
      carried,
      ...sums,
      pendingLeftOut: mine.filter((entry) => entry.status === 'pending' && (sentDay(entry.createdAt) ?? '') >= range.from && (sentDay(entry.createdAt) ?? '') <= range.to).length,
      notes: draft?.notes ?? null,
      supersedes,
    },
    claim: {
      entries: costs.filter((row) => row.group === 'month').map((row) => ({ id: row.entryId, seen: row.historyLength })),
      earlier: costs.filter((row) => row.group === 'earlier').map((row) => ({ id: row.entryId, seen: row.historyLength })),
      adjustments: adjustments.map((row) => ({ entryId: row.entryId, statementId: row.statementId, deltaCents: row.deltaCents })),
    },
    reportedElsewhere,
  };
}

/** How a report is named on paper: its reference when it has one, else its six-character ref. */
function displayName(report: Pick<MonthlyReportView, 'id' | 'reference'>): string {
  return report.reference?.trim() ? report.reference.trim() : reportRef(report.id);
}

/** Whether two claims say the same thing, in any order. */
export function sameClaim(a: FinishClaim, b: FinishClaim): boolean {
  const key = (claim: FinishClaim) =>
    JSON.stringify({
      entries: [...claim.entries].sort((x, y) => x.id.localeCompare(y.id)),
      earlier: [...claim.earlier].sort((x, y) => x.id.localeCompare(y.id)),
      adjustments: [...claim.adjustments].sort((x, y) => x.entryId.localeCompare(y.entryId)),
    });
  return key(a) === key(b);
}

/** A finished report as its writer lays it out: the Payment Summary for version 3, the earlier layout for a legacy report. */
export function statementOf(report: MonthlyReportView, all: MonthlyReportView[]): AnyStatement {
  const replaced = report.supersedes ? (all.find((other) => other.id === report.supersedes!.reportId) ?? null) : null;
  if (report.legacy) {
    return {
      legacy: true,
      propertyName: report.propertyNameAtFinish,
      month: report.month,
      owners: report.ownersAtFinish.map((owner) => owner.name),
      ref: reportRef(report.id),
      finishedAt: report.finishedAt,
      income: report.income,
      incomeCents: report.incomeCents,
      costs: report.costs,
      adjustments: report.adjustments,
      costsCents: report.costsCents,
      fee: report.fee ? { label: report.fee.label, amountCents: report.fee.amountCents } : null,
      feeCents: report.feeCents,
      payableCents: report.payableCents,
      pendingLeftOut: report.pendingLeftOut,
      notes: report.notes,
      supersedes: report.supersedes ? { ref: reportRef(report.supersedes.reportId), finishedAt: replaced?.finishedAt ?? null, reason: report.supersedes.reason } : null,
    };
  }
  return {
    legacy: false,
    propertyName: report.propertyNameAtFinish,
    month: report.month,
    reference: report.reference,
    reportDate: report.reportDate,
    reportFor: report.reportFor,
    draft: false,
    lines: report.lines,
    costs: report.costs,
    adjustments: report.adjustments,
    fee: report.fee,
    carried: report.carried,
    incomeCents: report.incomeCents,
    expensesCents: report.expensesCents,
    recordedCents: report.recordedCents,
    costsCents: report.costsCents,
    feeCents: report.feeCents,
    totalCents: report.totalCents,
    carriedCents: report.carriedCents,
    payableCents: report.payableCents,
    pendingLeftOut: report.pendingLeftOut,
    notes: report.notes,
    supersedes: report.supersedes
      ? { ref: replaced ? displayName(replaced) : reportRef(report.supersedes.reportId), reportDate: replaced?.reportDate || null, finishedAt: replaced?.finishedAt ?? null, reason: report.supersedes.reason }
      : null,
  };
}

// ─── The printed lines ─────────────────────────────────────────

export type PrintedLineKind = 'line' | 'cost' | 'earlier' | 'adjustment' | 'fee';

/** One row of the Payment Summary's table, in print order. */
export interface PrintedLine {
  key: string;
  kind: PrintedLineKind;
  description: string;
  quantity: number;
  rateCents: number;
  amountCents: number;
  /** The entry behind a recorded line, for "Open entry". */
  entryId: string | null;
}

/** A typed line's description as printed: "Revenue - Aug 9–13, 2026" when it has dates. */
export function lineText(line: Pick<Line, 'description' | 'from' | 'to'>): string {
  const range = rangeText(line.from, line.to);
  return range ? `${line.description} - ${range}` : line.description;
}

/**
 * The table's rows: the typed lines in the admin's order, then the recorded
 * costs of the month, then the earlier-month entries, then the adjustments,
 * then the fee. Every recorded entry is one negative line; an adjustment's
 * amount is the difference negated (an entry corrected down gives money
 * back).
 */
export function printedLines(statement: Pick<Statement, 'lines' | 'costs' | 'adjustments' | 'fee'>): PrintedLine[] {
  const rows: PrintedLine[] = statement.lines.map((line) => ({ key: line.id, kind: 'line', description: lineText(line), quantity: line.quantity, rateCents: line.rateCents, amountCents: line.amountCents, entryId: null }));
  for (const row of statement.costs.filter((cost) => cost.group === 'month')) {
    rows.push({ key: `cost-${row.entryId}`, kind: 'cost', description: `Expense - ${row.description}`, quantity: 1, rateCents: -row.totalCents, amountCents: -row.totalCents, entryId: row.entryId });
  }
  for (const row of statement.costs.filter((cost) => cost.group === 'earlier')) {
    rows.push({ key: `cost-${row.entryId}`, kind: 'earlier', description: `Expense - ${row.description} (from ${monthLabel(monthOfDay(row.day))})`, quantity: 1, rateCents: -row.totalCents, amountCents: -row.totalCents, entryId: row.entryId });
  }
  for (const row of statement.adjustments) {
    const what = row.description?.trim() ? row.description : `entry ${row.entryId.slice(0, 6)}`;
    const where = row.printedMonth ? `in ${monthLabel(row.printedMonth)}` : 'earlier';
    const now = row.nowCents === 0 ? 'no longer in the ledger' : `now ${formatCents(-row.nowCents)}`;
    rows.push({ key: `adj-${row.entryId}`, kind: 'adjustment', description: `Adjustment - ${what} (reported ${where} as ${formatCents(-row.printedCents)}, ${now})`, quantity: 1, rateCents: -row.deltaCents, amountCents: -row.deltaCents, entryId: row.entryId });
  }
  if (statement.fee) rows.push({ key: 'fee', kind: 'fee', description: statement.fee.label, quantity: 1, rateCents: -statement.fee.amountCents, amountCents: -statement.fee.amountCents, entryId: null });
  return rows;
}

/** "Revenue share", with the figure as printed: "-$359.96" below zero. */
export function closingWords(payableCents: number): { label: string; amount: string } {
  return { label: payableCents < 0 ? 'Revenue share, owed to NuBNB' : 'Revenue share', amount: formatCents(payableCents) };
}

/** The label the fee starts with: "NuBNB 20% Net of $9,539.78". */
export function feeLabelFor(rateBasisPoints: number | null, baseCents: number): string {
  return rateBasisPoints === null ? 'NuBNB fee' : `NuBNB ${rateText(rateBasisPoints)} Net of ${formatCents(baseCents)}`;
}

/** A fee from a rate and a base, the amount computed; the amount given overrides it. */
export function feeFrom(label: string, rateBasisPoints: number | null, baseCents: number, amountCents: number | null): Fee {
  const computedCents = feeComputed(baseCents, rateBasisPoints);
  const amount = amountCents ?? computedCents ?? 0;
  return { label, rateBasisPoints, baseCents, computedCents, amountCents: amount, overwritten: amount !== computedCents };
}

/** "Airbnb · ref HMABC123", for a line loaded from a row written before dispatch 23D; "" when it carried nothing. */
export function lineDetailsText(line: Pick<Line, 'source' | 'reference'>): string {
  return [line.source === undefined ? null : INCOME_SOURCE_LABELS[line.source], line.reference ? `ref ${line.reference}` : null].filter((part): part is string => part !== null).join(' · ');
}

/** Whether a statement has anything in it: no line, no cost, no adjustment and no fee is "Nothing to report". */
export function nothingToReport(statement: { income?: IncomeRow[]; lines?: Line[]; costs: StatementCost[]; adjustments: StatementAdjustment[]; fee: { amountCents: number } | null }): boolean {
  return (statement.income?.length ?? 0) === 0 && (statement.lines?.length ?? 0) === 0 && statement.costs.length === 0 && statement.adjustments.length === 0 && (statement.fee === null || statement.fee.amountCents === 0);
}

// ─── Suggestions from the previous month ───────────────────────

/** The previous month's current finished statement of the property, if any. */
export function previousStatement(reports: MonthlyReportView[], month: string): MonthlyReportView | null {
  const previous = addMonths(month, -1);
  return currentReports(reports).filter((report) => report.month === previous).sort((a, b) => b.finishedAt.localeCompare(a.finishedAt))[0] ?? null;
}

/**
 * The carried balance to offer: the previous month's closing figure when it
 * was below zero (the owner carried a balance to NuBNB), as "Balance From
 * June: $359.96". A month that closed above zero was paid out and suggests
 * nothing. Never applied by code: the admin accepts or types their own.
 */
export function carriedSuggestion(previous: MonthlyReportView | null): Carried | null {
  if (!previous || previous.payableCents >= 0) return null;
  return { label: `Balance From ${monthLabel(previous.month).split(' ')[0]}`, amountCents: -previous.payableCents, fromReportId: previous.id };
}

/** The reference to offer: the previous one with its month word swapped ("June-321-John" → "July-321-John"), when it has that form. */
export function referenceSuggestion(previous: MonthlyReportView | null, month: string): string | null {
  if (!previous || !previous.reference) return null;
  const was = `${monthReferenceWord(previous.month)}-`;
  if (!previous.reference.startsWith(was)) return null;
  return `${monthReferenceWord(month)}-${previous.reference.slice(was.length)}`;
}

/** The fee rate to start from: the previous statement's, else the property's default. */
export function feeRateSuggestion(previous: MonthlyReportView | null, management: PropertyManagementView | null): number | null {
  return previous?.fee?.rateBasisPoints ?? management?.defaultFeeRateBasisPoints ?? null;
}

// ─── The tracker ───────────────────────────────────────────────

export type StatementState =
  /** A closed month with no finished statement and nothing started. */
  | { kind: 'outstanding' }
  /** A month that has not ended, with nothing started: open, not yet due (dispatch 23D). Never outstanding. */
  | { kind: 'open' }
  | { kind: 'draft'; savedAt: string; superseding: boolean }
  | { kind: 'finished'; report: MonthlyReportSummaryLike; replaced: number };

/**
 * The words for each state. A closed month with nothing finished and nothing
 * started reads "Past due" (dispatch 23F: "past due for closed months"); the
 * current month with nothing started reads "Open, not yet due" (dispatch 23D).
 */
export const STATEMENT_STATE_LABELS: Record<StatementState['kind'], string> = {
  outstanding: 'Past due',
  open: 'Open, not yet due',
  draft: 'Draft',
  finished: 'Finished',
};

/** The fields of a finished report the tracker needs; a full report satisfies it too. */
export interface MonthlyReportSummaryLike {
  id: string;
  propertyId: string;
  month: string;
  reference?: string | null;
  incomeCents: number;
  costsCents: number;
  feeCents: number;
  payableCents: number;
  finishedAt: string;
  supersedes: Supersedes | null;
  pdf: { path: string; bytes: number; sha256: string };
}

export interface TrackerRow {
  propertyId: string;
  propertyName: string;
  state: StatementState;
  /** Download records of the current finished report: how many, and the last. */
  downloads: number;
  lastDownloadAt: string | null;
  /** Every finished report for the property-month, newest first, with which replaced which. */
  reports: { report: MonthlyReportSummaryLike; replacedBy: MonthlyReportSummaryLike | null }[];
}

export interface DraftLike {
  propertyId: string;
  month: string;
  updatedAt: string;
  finishedAs: string | null;
  superseding: boolean;
}

export interface TrackerInputs {
  month: string;
  /** Today, yyyy-mm-dd in Toronto: a month that has not ended is open, never outstanding (dispatch 23D). */
  today: string;
  properties: { id: string; name: string | null }[];
  reports: MonthlyReportSummaryLike[];
  drafts: DraftLike[];
  downloads: { reportId: string; at: string }[];
  management: PropertyManagementView[];
}

const ORDER: Record<StatementState['kind'], number> = { outstanding: 0, open: 1, draft: 2, finished: 3 };

/** One property-month's reports, newest first, its live one, and its open draft. */
function propertyMonth(propertyId: string, month: string, reports: MonthlyReportSummaryLike[], drafts: DraftLike[], current: Set<string>) {
  const mine = reports.filter((report) => report.propertyId === propertyId && report.month === month).sort((a, b) => b.finishedAt.localeCompare(a.finishedAt) || a.id.localeCompare(b.id));
  const draft = drafts.find((d) => d.propertyId === propertyId && d.month === month && d.finishedAs === null) ?? null;
  const live = mine.find((report) => current.has(report.id)) ?? null;
  return { reports: mine, draft, live };
}

/** The state of one property-month: finished, a draft, or nothing yet — outstanding once the month has ended, open until then. */
function stateOf(month: string, today: string, found: ReturnType<typeof propertyMonth>): StatementState {
  const { reports, draft, live } = found;
  if (live && !draft) return { kind: 'finished', report: live, replaced: reports.length - 1 };
  if (draft) return { kind: 'draft', savedAt: draft.updatedAt, superseding: draft.superseding };
  return isClosedMonth(month, today) ? { kind: 'outstanding' } : { kind: 'open' };
}

/**
 * One row per property in scope for the month — or with a statement or a
 * draft for it, whatever its scope: a statement that exists is never hidden
 * — outstanding first, then open, then drafts, then finished.
 */
export function trackerRows(input: TrackerInputs): TrackerRow[] {
  const management = new Map(input.management.map((record) => [record.propertyId, record]));
  const current = new Set(currentReports(input.reports).map((report) => report.id));
  const rows: TrackerRow[] = [];
  for (const property of input.properties) {
    const record = management.get(property.id) ?? null;
    const { from, until } = statementMonths(record);
    const found = propertyMonth(property.id, input.month, input.reports, input.drafts, current);
    const inScope = input.month >= from && (until === null || input.month <= until);
    if (!inScope && found.reports.length === 0 && found.draft === null) continue;
    const state = stateOf(input.month, input.today, found);
    const { live, reports } = found;
    const downloads = live ? input.downloads.filter((d) => d.reportId === live.id).map((d) => d.at).sort() : [];
    rows.push({
      propertyId: property.id,
      propertyName: property.name?.trim() || 'Unnamed property',
      state,
      downloads: downloads.length,
      lastDownloadAt: downloads[downloads.length - 1] ?? null,
      reports: reports.map((report) => ({ report, replacedBy: input.reports.find((other) => other.supersedes?.reportId === report.id) ?? null })),
    });
  }
  return rows.sort((a, b) => ORDER[a.state.kind] - ORDER[b.state.kind] || a.propertyName.localeCompare(b.propertyName, 'en-CA'));
}

/** The line at the top, and the tile: how many finished, outstanding, open, in draft. */
export function trackerCounts(rows: TrackerRow[]): { inScope: number; finished: number; outstanding: number; open: number; drafts: number } {
  return {
    inScope: rows.length,
    finished: rows.filter((row) => row.state.kind === 'finished').length,
    outstanding: rows.filter((row) => row.state.kind === 'outstanding').length,
    open: rows.filter((row) => row.state.kind === 'open').length,
    drafts: rows.filter((row) => row.state.kind === 'draft').length,
  };
}

// ─── One property's months (the property page, dispatch 23D) ───

export interface PropertyMonthRow {
  month: string;
  state: StatementState;
  /** Every finished report for the month, newest first, with which replaced which. */
  reports: { report: MonthlyReportSummaryLike; replacedBy: MonthlyReportSummaryLike | null }[];
  /** Whether the month is in the property's statement scope. */
  inScope: boolean;
}

export interface PropertyMonthsInputs {
  propertyId: string;
  today: string;
  management: PropertyManagementView | null;
  /** The property's reports and drafts only. */
  reports: MonthlyReportSummaryLike[];
  drafts: DraftLike[];
}

/**
 * The months a property's page lists: from its first statement month, or the
 * current month, or an earlier month that has a statement or a draft,
 * whichever is earliest, to the current month or a later one that has one;
 * each with its state, newest first. The current month is always listed, so
 * a statement can be made for it whatever the property's scope. `outstanding`
 * is every closed month in scope with no finished current statement — a
 * month with only a draft included, since a draft is not a statement —
 * oldest first. The current month is never in it, nor is a month out of scope.
 */
export function propertyMonths(input: PropertyMonthsInputs): { rows: PropertyMonthRow[]; outstanding: string[] } {
  const { from, until } = statementMonths(input.management);
  const thisMonth = monthOfDay(input.today);
  const touched = [...input.reports.map((report) => report.month), ...input.drafts.map((draft) => draft.month)].sort();
  const first = [from, thisMonth, ...(touched[0] !== undefined ? [touched[0]] : [])].sort()[0];
  const lastTouched = touched[touched.length - 1];
  const last = lastTouched !== undefined && lastTouched > thisMonth ? lastTouched : thisMonth;
  const current = new Set(currentReports(input.reports).map((report) => report.id));
  const rows: PropertyMonthRow[] = [];
  const outstanding: string[] = [];
  for (const month of monthsBetween(first, last)) {
    const inScope = month >= from && (until === null || month <= until);
    const found = propertyMonth(input.propertyId, month, input.reports, input.drafts, current);
    if (!inScope && month !== thisMonth && found.reports.length === 0 && found.draft === null) continue;
    const state = stateOf(month, input.today, found);
    if (inScope && state.kind !== 'finished' && isClosedMonth(month, input.today)) outstanding.push(month);
    rows.push({
      month,
      state,
      inScope,
      reports: found.reports.map((report) => ({ report, replacedBy: input.reports.find((other) => other.supersedes?.reportId === report.id) ?? null })),
    });
  }
  return { rows: rows.reverse(), outstanding };
}

/**
 * One property-month's state and its reports, for the property page's month
 * control (dispatch 23F): the same reading `trackerRows` and `propertyMonths`
 * make, for any month, listed or not.
 */
export function propertyMonthState(input: { propertyId: string; month: string; today: string; reports: MonthlyReportSummaryLike[]; drafts: DraftLike[] }): Pick<PropertyMonthRow, 'state' | 'reports'> {
  const current = new Set(currentReports(input.reports).map((report) => report.id));
  const found = propertyMonth(input.propertyId, input.month, input.reports, input.drafts, current);
  return {
    state: stateOf(input.month, input.today, found),
    reports: found.reports.map((report) => ({ report, replacedBy: input.reports.find((other) => other.supersedes?.reportId === report.id) ?? null })),
  };
}

/** Loose ends for a month, in words: pending entries sent in it; late approved entries; adjustments waiting. */
export interface LooseEnds {
  pending: { propertyId: string; propertyName: string; count: number }[];
  late: { propertyId: string; propertyName: string; count: number }[];
  adjustments: { propertyId: string; propertyName: string; count: number }[];
}

/** A finished report as the loose ends read it: the tracker's summary carries all of this (dispatch 23D fixed the adjustments count, which read cost rows the summary never had). */
export interface LooseEndsReport extends PrintedReport {
  propertyId: string;
  supersedes: Supersedes | null;
  entryIds: string[];
}

export function looseEnds(
  month: string,
  entries: CostEntryView[],
  reports: LooseEndsReport[],
  management: PropertyManagementView[],
  nameOf: (propertyId: string) => string,
): LooseEnds {
  const range = monthRange(month);
  const byProperty = new Map<string, CostEntryView[]>();
  for (const entry of entries) {
    if (entry.property.id === null) continue;
    byProperty.set(entry.property.id, [...(byProperty.get(entry.property.id) ?? []), entry]);
  }
  const records = new Map(management.map((record) => [record.propertyId, record]));
  const current = currentReports(reports);
  const out: LooseEnds = { pending: [], late: [], adjustments: [] };
  for (const [propertyId, list] of byProperty) {
    const pending = list.filter((entry) => entry.status === 'pending' && (sentDay(entry.createdAt) ?? '') >= range.from && (sentDay(entry.createdAt) ?? '') <= range.to).length;
    if (pending > 0) out.pending.push({ propertyId, propertyName: nameOf(propertyId), count: pending });
    const mine = current.filter((report) => report.propertyId === propertyId);
    const listed = new Set(mine.flatMap((report) => report.entryIds));
    const { from: firstMonth } = statementMonths(records.get(propertyId) ?? null);
    const late = list.filter((entry) => {
      const day = sentDay(entry.createdAt);
      return entry.status === 'approved' && day !== null && day <= range.to && monthOfDay(day) >= firstMonth && !listed.has(entry.id);
    }).length;
    if (late > 0) out.late.push({ propertyId, propertyName: nameOf(propertyId), count: late });
    const byId = new Map(list.map((entry) => [entry.id, entry]));
    let changed = 0;
    for (const [entryId, { cents }] of lastPrinted(mine)) {
      const entry = byId.get(entryId);
      const now = entry && entry.status === 'approved' && entry.linesNow.kind === 'ok' ? entry.linesNow.totalCents : 0;
      if (now !== cents) changed += 1;
    }
    if (changed > 0) out.adjustments.push({ propertyId, propertyName: nameOf(propertyId), count: changed });
  }
  return out;
}
