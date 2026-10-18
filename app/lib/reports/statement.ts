/**
 * The statement's arithmetic, apart from React and apart from the server, so
 * the editor's live preview, the finish step and the tracker read the very
 * same numbers (dispatch 23B; the Payment Summary of dispatch 23E).
 *
 * ── Which entries a statement carries ──
 * An entry belongs to the month an office cost was logged for (dispatch 36),
 * else to the Toronto month it was sent in (`entryMonth`, the rule the ledger
 * follows too). A statement for a month carries the property's approved
 * entries sent in that month; then approved entries sent in an earlier
 * month, on or after the property's first statement month, that no current
 * statement of the property lists; then every entry a current statement
 * printed whose amount now differs from what that statement last printed,
 * or which has since left the ledger. A statement being superseded is not
 * current, so its entries come back into the one replacing it. Each change
 * is carried once: the comparison is with the most recent current statement
 * that printed the entry, in its costs or its adjustments (Kian's decision 5).
 * On the Payment Summary each of these is a line like any other, named by
 * the entry's reference and the day it was sent, never by its items
 * (Kian, 2026-10-02): "Expense - ref ykHRE5 · Oct 1, 2026", "Expense - ref
 * … · Sep 28, 2026 (from September 2026)", "Adjustment - ref … · …".
 *
 * ── Money ──
 * A line's amount is quantity × rate (Kian's ruling of 2026-10-01, the one
 * place code computes money; `lineAmount` in model.ts). The revenue is the
 * sum of the positive lines; the expenses are the negative lines negated;
 * the recorded costs are the cost rows plus the adjustments' differences;
 * the fee is its amount. Total = revenue − expenses − recorded − fee, and
 * Your Revenue Share = total − the carried balance. Negative is owed to
 * NuBNB. Nothing is stored here: the finish step stores what it printed.
 * The revenue and expenses split here (by sign) is what a finished report
 * stores; the figures every page shows are the month's money's
 * (app/lib/money/month.ts), which places an Airbnb claw-back in the revenue
 * (Kian's ruling M1). The Total and the Revenue Share are the same either way.
 *
 * Client-safe: model.ts, the cost model and the ledger's day functions.
 */

import { formatCents, type CostEntryView } from '@/app/lib/cleaners/model';
import { entryMonth, entryRef, officeWhen, sentDay } from '@/app/lib/costs/report';
import {
  LINE_SOURCE_LABELS,
  addMonths,
  currentReports,
  feeComputed,
  inStatementScope,
  isClosedMonth,
  isExcludedFromReporting,
  lastClosedMonth,
  monthLabel,
  monthOfDay,
  monthWordStyles,
  monthsBetween,
  rangeText,
  rateText,
  referenceFromStem,
  reportRef,
  statementMonths,
  type Carried,
  type Fee,
  type IncomeRow,
  type LineSource,
  type Line,
  type MonthlyReportView,
  type PropertyManagementView,
  type ReportFor,
  type StatementAdjustment,
  type StatementCarriedAdjustment,
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
  /** Carried balances settled on this statement (dispatch 35): a month's balance carried earlier, since corrected or deleted. */
  carriedAdjustments: StatementCarriedAdjustment[];
  incomeCents: number;
  expensesCents: number;
  recordedCents: number;
  costsCents: number;
  feeCents: number;
  /** The carried adjustments' differences, added up: deducted in the Total (dispatch 35). */
  carriedAdjustmentCents: number;
  totalCents: number;
  carriedCents: number;
  payableCents: number;
  pendingLeftOut: number;
  notes: string | null;
  /** When replacing an earlier statement: how it is named, its date, and the reason. */
  supersedes: { ref: string; reportDate: string | null; finishedAt: string | null; reason: string } | null;
  /**
   * The layout of dispatch 34: the property and the month printed at the top (Kian's ruling of 2026-10-12) and a
   * correction's reason printed in full. True for a draft and a report of version 4; false for a report of
   * version 3, which is drawn as it was stored.
   */
  heading: boolean;
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
  /** The lines read from the platforms' files (dispatch 37C): each stored line and its history's length. Absent: none. */
  platform?: { id: string; seen: number }[];
  earlier: { id: string; seen: number }[];
  adjustments: { entryId: string; statementId: string; deltaCents: number }[];
  /** The carried balance as the page built it, and the carried balances it settles (dispatch 35): absent from a page built before. */
  carried?: { fromMonth: string | null; amountCents: number } | null;
  carriedAdjustments?: { fromMonth: string; deltaCents: number }[];
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
  /** The property's accepted lines from the platforms' files, read where they are stored (dispatch 37C, M10). Absent: none. */
  platformLines?: PlatformLineInput[];
}

/**
 * A line from a platform's file, accepted and read where it is stored (dispatch 37C, Kian's ruling M10): never
 * copied into a draft; it prints as an ordinary line. It belongs to the month the platform paid it, and goes on that
 * month's statement while it is open, else on the next open one with its date printed (M11).
 */
export interface PlatformLineInput {
  /** The stored line's ID: `earnings_lines/{id}`, or a direct payment's, `direct_payments/{id}` (part B). */
  id: string;
  /** The platform whose file it came from, or `direct`: a payment received outside Airbnb (part B, Kian's rulings of 2026-10-15). */
  platform: LineSource;
  /** The property it was accepted for. */
  propertyId: string;
  /** The month it belongs to: the day the platform paid it, Toronto calendar. */
  month: string;
  payoutDate: string;
  stay: { start: string | null; end: string | null };
  fileRow: number;
  /** As accepted, or as edited since: what its own month's statement prints. */
  description: string;
  amountCents: number;
  /** Its history's length: what the page built from, checked again at Finish. */
  seen: number;
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

/**
 * What a recorded cost is called on the statement (Kian, 2026-10-02): its
 * reference and the day it was sent — "ref ykHRE5 · Oct 1, 2026" — never
 * what was bought; the items are in the ledger and its PDF. A statement
 * finished before prints the description it stored.
 */
export function costLineName(entryId: string, day: string): string {
  return `ref ${entryRef(entryId)} · ${rangeText(day, day)}`;
}

/** What a cleaning's own row is called (dispatch 37B): "Cleaning · Oct 9, 2026", by the day cleaned. Never the cleaner (Kian's ruling of 2026-10-13). */
export function cleaningLineName(day: string): string {
  return `Cleaning · ${rangeText(day, day)}`;
}

/**
 * One readable entry as a statement cost row. `amountCents`, when given, is what the row charges instead of the
 * entry's total now: a month redone after a later statement adjusted the entry prints only what is left after
 * that adjustment (Kian's ruling of 2026-10-12, dispatch 35). The row then carries that amount alone, the items
 * and tax split being the entry's of its first printing, which no longer exists apart.
 */
function costRow(entry: CostEntryView, group: StatementCost['group'], amountCents: number | null = null): StatementCost | null {
  const day = sentDay(entry.createdAt);
  if (entry.linesNow.kind !== 'ok' || day === null || entry.history === null) return null;
  const left = amountCents !== null && amountCents !== entry.linesNow.totalCents;
  // An office cost prints the month it belongs to, with the day it was logged in brackets: "ref 1a2b3c · Sep 2026
  // (logged Oct 12)" (Kian's ruling of 2026-10-12); its row keeps that month. A cleaning (dispatch 37B) is named by
  // the day it was cleaned and keeps its month too: the statement prints a month's cleanings as one line. Any other
  // entry is named by its day.
  const office = officeWhen(entry);
  const cleaning = entry.kind === 'cleaning';
  const belongs = entryMonth(entry);
  const month = (office !== null || cleaning) && belongs !== null ? { month: belongs } : {};
  return {
    entryId: entry.id,
    ref: entryRef(entry.id),
    day,
    kind: entry.kind,
    description: office !== null ? `ref ${entryRef(entry.id)} · ${office}` : cleaning ? cleaningLineName(day) : costLineName(entry.id, day),
    itemsCents: left ? (amountCents as number) : entry.linesNow.itemsCents,
    taxCents: left ? null : entry.linesNow.taxCents,
    totalCents: left ? (amountCents as number) : entry.linesNow.totalCents,
    corrected: entry.linesNow.corrected,
    historyLength: entry.history.length,
    receiptSha256: entry.receipts?.[0]?.sha256 ?? null,
    group,
    ...month,
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

/**
 * What a finished report charged the owner for each entry (dispatch 35): a cost row's total, or an adjustment's
 * difference. Added up over the current statements, it is what the owner has been charged for the entry in all;
 * every statement charges only what that leaves, so a correction is counted once.
 */
export function chargedBy(report: Pick<MonthlyReportView, 'costs' | 'adjustments'>): PrintedEntry[] {
  return [...report.costs.map((cost) => ({ entryId: cost.entryId, cents: cost.totalCents })), ...report.adjustments.map((adjustment) => ({ entryId: adjustment.entryId, cents: adjustment.deltaCents }))];
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

/** The sums a set of lines, cost rows, adjustments, a fee, a carried balance and settled carried balances add up to. */
export function statementSums(lines: Line[], costs: StatementCost[], adjustments: StatementAdjustment[], fee: Fee | null, carried: Carried | null, carriedAdjustments: StatementCarriedAdjustment[] = []) {
  const incomeCents = lines.filter((line) => line.amountCents > 0).reduce((sum, line) => sum + line.amountCents, 0);
  const expensesCents = -lines.filter((line) => line.amountCents < 0).reduce((sum, line) => sum + line.amountCents, 0);
  const recordedCents = costs.reduce((sum, row) => sum + row.totalCents, 0) + adjustments.reduce((sum, row) => sum + row.deltaCents, 0);
  const costsCents = expensesCents + recordedCents;
  const feeCents = fee?.amountCents ?? 0;
  // A carried adjustment is a line of the table: deducted (or, negative, given back) in the Total.
  const carriedAdjustmentCents = carriedAdjustments.reduce((sum, row) => sum + row.deltaCents, 0);
  const totalCents = incomeCents - costsCents - feeCents - carriedAdjustmentCents;
  const carriedCents = carried?.amountCents ?? 0;
  return { incomeCents, expensesCents, recordedCents, costsCents, feeCents, carriedAdjustmentCents, totalCents, carriedCents, payableCents: totalCents - carriedCents };
}

// ─── Corrections that add up (dispatch 35, Kian's rulings of 2026-10-12) ───
//
// The current statements are a ledger. For each cost entry they have charged
// the owner something in all (cost rows and adjustments' differences); for
// each month whose closing balance was carried, they have deducted something
// in all (carried balances and their adjustments). A statement charges only
// what that leaves:
//   - a month redone (corrected, or deleted and finished again) after a later
//     statement printed an adjustment prints only what is left after that
//     adjustment, so a correction is counted once;
//   - a change after a statement was finished shows on the next month's
//     statement, never on an earlier month finished later: the first month
//     after the latest one that charged it which has no current statement;
//   - a carried balance is a link to the month it came from: while open it
//     carries what that month's current statement says is still owed; once
//     finished, a correction or delete of that month is settled by an
//     adjustment line on the next open statement;
//   - an uncarried debt keeps being offered until a statement carries it.

/** What the current statements charged for one entry, and the latest of them that did (by month, then by finishing). */
interface EntryCharge {
  cents: number;
  latest: { reportId: string; month: string; finishedAt: string; printedCents: number };
}

const isLater = (a: { month: string; finishedAt: string }, b: { month: string; finishedAt: string }) => a.month > b.month || (a.month === b.month && a.finishedAt > b.finishedAt);

function entryCharges(current: MonthlyReportView[]): Map<string, EntryCharge> {
  const charges = new Map<string, EntryCharge>();
  const add = (report: MonthlyReportView, entryId: string, cents: number, printedCents: number) => {
    const was = charges.get(entryId);
    const here = { reportId: report.id, month: report.month, finishedAt: report.finishedAt, printedCents };
    charges.set(entryId, { cents: (was?.cents ?? 0) + cents, latest: !was || isLater(here, was.latest) ? here : was.latest });
  };
  for (const report of current) {
    for (const cost of report.costs) add(report, cost.entryId, cost.totalCents, cost.totalCents);
    for (const adjustment of report.adjustments) add(report, adjustment.entryId, adjustment.deltaCents, adjustment.nowCents);
  }
  return charges;
}

/**
 * The month a change to something last charged in `latestMonth` shows on (Kian's ruling): the first month after
 * it with no current statement — the next month's, or, when that one is already finished, the next open one.
 */
export function nextOpenMonth(latestMonth: string, finishedMonths: ReadonlySet<string>): string {
  let month = addMonths(latestMonth, 1);
  for (let i = 0; i < 1_200 && finishedMonths.has(month); i += 1) month = addMonths(month, 1);
  return month;
}

/**
 * The statement something belonging to `month` goes on (Kian's ruling of 2026-10-12, dispatch 36): that month's,
 * or, when it is already finished, the next month's — the next open one.
 */
export function statementMonthFor(month: string, finishedMonths: ReadonlySet<string>): string {
  return finishedMonths.has(month) ? nextOpenMonth(month, finishedMonths) : month;
}

/** The current statement of a month, if any: the latest finished of the current ones. */
function currentOf(current: MonthlyReportView[], month: string): MonthlyReportView | null {
  return current.filter((report) => report.month === month).sort((a, b) => b.finishedAt.localeCompare(a.finishedAt))[0] ?? null;
}

/** What a month's current statement says is owed to NuBNB: its closing figure below zero, as an amount; 0 when it closes at or above zero, or has none. */
function owedBy(current: MonthlyReportView[], month: string): number {
  const report = currentOf(current, month);
  return report && report.payableCents < 0 ? -report.payableCents : 0;
}

/** The month a carried balance came from, when it is a link: its stored month, else its statement's; null for a balance typed by hand, or one whose statement and month are both gone. */
export function carriedFromMonth(carried: Pick<Carried, 'fromReportId' | 'fromMonth'> | null | undefined, reports: Pick<MonthlyReportView, 'id' | 'month'>[]): string | null {
  if (!carried || carried.fromReportId === null) return null;
  return carried.fromMonth ?? reports.find((report) => report.id === carried.fromReportId)?.month ?? null;
}

/** What the current statements deducted for each month's carried balance, the latest that did, and its label. */
interface CarryCharge {
  cents: number;
  label: string;
  latest: { reportId: string; month: string; finishedAt: string };
}

function carryCharges(current: MonthlyReportView[], all: MonthlyReportView[]): Map<string, CarryCharge> {
  const charges = new Map<string, CarryCharge>();
  const add = (report: MonthlyReportView, fromMonth: string, cents: number, label: string) => {
    const was = charges.get(fromMonth);
    const here = { reportId: report.id, month: report.month, finishedAt: report.finishedAt };
    const later = !was || isLater(here, was.latest);
    charges.set(fromMonth, { cents: (was?.cents ?? 0) + cents, label: later ? label : was!.label, latest: later ? here : was!.latest });
  };
  for (const report of current) {
    const fromMonth = carriedFromMonth(report.carried, all);
    if (report.carried && fromMonth !== null) add(report, fromMonth, report.carried.amountCents, report.carried.label);
    for (const row of report.carriedAdjustments ?? []) add(report, row.fromMonth, row.deltaCents, row.label);
  }
  return charges;
}

/**
 * A draft's carried balance as it stands (Kian's ruling: a link to the statement it came from). A balance typed
 * by hand is as typed; one taken from a statement carries what its month's current statement says is owed, less
 * what other current statements already deducted for that month, and names that statement and its month.
 */
function linkedCarried(carried: Carried | null, current: MonthlyReportView[], all: MonthlyReportView[]): Carried | null {
  const fromMonth = carriedFromMonth(carried, all);
  if (!carried || fromMonth === null) return carried;
  const charged = carryCharges(current, all).get(fromMonth)?.cents ?? 0;
  const source = currentOf(current, fromMonth);
  return { label: carried.label, amountCents: owedBy(current, fromMonth) - charged, fromReportId: source?.id ?? carried.fromReportId, fromMonth };
}

/** A month that closed owing NuBNB and that no current statement has carried: offered until one does. */
export interface UncarriedDebt {
  fromMonth: string;
  fromReportId: string;
  amountCents: number;
  label: string;
}

/**
 * Every earlier month that closed owing NuBNB and whose balance no current statement has carried, most recent
 * first (Kian's ruling: an uncarried debt keeps being offered until a statement carries it). A statement being
 * corrected still counts as carrying what it carried.
 */
export function uncarriedDebts(reports: MonthlyReportView[], month: string): UncarriedDebt[] {
  const current = currentReports(reports);
  const referenced = new Set(carryCharges(current, reports).keys());
  return current
    .filter((report) => report.month < month && report.payableCents < 0 && !referenced.has(report.month))
    .sort((a, b) => b.month.localeCompare(a.month))
    .filter((report, i, all) => all.findIndex((other) => other.month === report.month) === i)
    .map((report) => ({ fromMonth: report.month, fromReportId: report.id, amountCents: -report.payableCents, label: `Balance From ${monthLabel(report.month).split(' ')[0]}` }));
}

/**
 * Build one property's statement for one month from what is stored now.
 * Pure. The same function runs in the browser for the preview and on the
 * server at finish, on the same inputs, so the claim either side computes
 * is the same.
 */
// ─── Lines from the platforms' files (dispatch 37C) ───────────

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Sep 30", as "(paid Sep 30)" prints a day. */
function paidDayText(day: string): string {
  const match = /^\d{4}-(\d{2})-(\d{2})$/.exec(day);
  return match ? `${SHORT_MONTHS[Number(match[1]) - 1]} ${Number(match[2])}` : day;
}

/**
 * A line printed on a later month's statement than its own says when the platform paid it (Kian's ruling M11):
 * "(paid Sep 30)" after its words, unless they already end with one.
 */
export function withPaidDate(description: string, payoutDate: string): string {
  return /\(paid [^)]*\)$/.test(description) ? description : `${description} (paid ${paidDayText(payoutDate)})`;
}

/** Which current statement printed each platform line: a printed line is locked (M10) and goes on no other statement. */
export function printedPlatformLines(current: Pick<MonthlyReportView, 'id' | 'month' | 'lines'>[]): Map<string, { reportId: string; month: string }> {
  const printed = new Map<string, { reportId: string; month: string }>();
  for (const report of current) for (const line of report.lines ?? []) if (line.platformLineId) printed.set(line.platformLineId, { reportId: report.id, month: report.month });
  return printed;
}

/** Newest stay first (Kian's ruling of 2026-10-13): by the stay's first day, else the day paid; then its last day, the day paid, the file's order. */
function newestStayFirst(a: PlatformLineInput, b: PlatformLineInput): number {
  return (
    (b.stay.start ?? b.payoutDate).localeCompare(a.stay.start ?? a.payoutDate) ||
    (b.stay.end ?? b.payoutDate).localeCompare(a.stay.end ?? a.payoutDate) ||
    b.payoutDate.localeCompare(a.payoutDate) ||
    a.fileRow - b.fileRow ||
    a.id.localeCompare(b.id)
  );
}

/**
 * The platform lines a statement prints, in print order (dispatch 37C): the property's accepted lines that no
 * current statement printed, whose month is this one while it is open, or an earlier one already finished (M11:
 * the next open statement, with the date printed). A line before the property's first statement month goes on none.
 */
export function platformLinesOn(input: { propertyId: string; month: string; firstMonth: string; platformLines: readonly PlatformLineInput[]; current: Pick<MonthlyReportView, 'id' | 'month' | 'lines'>[] }): { line: Line; seen: number }[] {
  const printed = printedPlatformLines(input.current);
  const finishedMonths = new Set(input.current.map((report) => report.month));
  return input.platformLines
    .filter((line) => line.propertyId === input.propertyId && !printed.has(line.id) && line.month >= input.firstMonth && statementMonthFor(line.month, finishedMonths) === input.month)
    .sort(newestStayFirst)
    .map((line) => ({
      line: {
        id: line.id,
        // A direct payment's words already print the day it was received (Kian's ruling of 2026-10-15): kept as they are.
        description: line.month === input.month || line.platform === 'direct' ? line.description : withPaidDate(line.description, line.payoutDate),
        from: null,
        to: null,
        quantity: 1,
        rateCents: line.amountCents,
        amountCents: line.amountCents,
        source: line.platform,
        platformLineId: line.id,
      },
      seen: line.seen,
    }));
}

export function buildStatement(input: StatementInputs): StatementBuild {
  const { propertyId, month, draft, management } = input;
  const { from: firstMonth } = statementMonths(management);
  const mine = input.entries.filter((entry) => entry.property.id === propertyId);
  const supersedingId = draft?.supersedes?.reportId ?? null;
  const current = currentReports(input.reports).filter((report) => report.id !== supersedingId);
  const listed = new Set(current.flatMap((report) => report.entryIds));
  const finishedMonths = new Set(current.map((report) => report.month));
  const charges = entryCharges(current);

  const unreadable: string[] = [];
  const costs: StatementCost[] = [];
  const reportedElsewhere: string[] = [];
  for (const entry of [...mine].sort(byDay)) {
    // An entry another current statement charged only through adjustments is the redone month's to print, whatever it is now (dispatch 35).
    const charge = listed.has(entry.id) ? undefined : charges.get(entry.id);
    if (entry.status !== 'approved' && !charge) continue;
    // The month it belongs to (dispatch 36): an office cost's chosen month, else the month of the day it was sent.
    const belongs = entryMonth(entry);
    if (belongs === null) continue;
    const inMonth = belongs === month;
    const earlier = belongs < month && belongs >= firstMonth;
    if (!inMonth && !earlier) continue;
    if (listed.has(entry.id)) {
      if (inMonth) reportedElsewhere.push(entry.id);
      continue;
    }
    // An earlier month's cost goes on its own month's statement, or, once that is finished, on the next one (Kian's ruling of 2026-10-12).
    if (earlier && statementMonthFor(belongs, finishedMonths) !== month) continue;
    // What is left after the later statements' adjustments: what the latest of them printed it as, less what they charged.
    const left = charge ? charge.latest.printedCents - charge.cents : null;
    if (left === 0) continue;
    const row = costRow(entry, inMonth ? 'month' : 'earlier', left);
    if (row === null) unreadable.push(entry.id);
    else costs.push(row);
  }

  const rowIds = new Set(costs.map((row) => row.entryId));
  const byId = new Map(mine.map((entry) => [entry.id, entry]));
  const adjustments: StatementAdjustment[] = [];
  for (const [entryId, charge] of charges) {
    if (rowIds.has(entryId)) continue;
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
    if (nowCents === charge.cents) continue;
    // On the next month's statement, never on an earlier month finished later (Kian's ruling of 2026-10-12).
    if (month !== nextOpenMonth(charge.latest.month, finishedMonths)) continue;
    const day = entry ? sentDay(entry.createdAt) : null;
    const description = entry && day !== null ? (entry.kind === 'cleaning' ? cleaningLineName(day) : costLineName(entry.id, day)) : null;
    adjustments.push({ entryId, statementId: charge.latest.reportId, printedCents: charge.cents, nowCents, deltaCents: nowCents - charge.cents, historyLength, description, printedMonth: charge.latest.month });
  }
  adjustments.sort((a, b) => a.entryId.localeCompare(b.entryId));
  if (unreadable.length > 0) return { kind: 'unreadable', entryIds: [...new Set(unreadable)] };

  // ── The carried balance: a link, and the carried balances settled here ──
  const carried = linkedCarried(draft?.carried ?? null, current, input.reports);
  const carriedHere = carriedFromMonth(carried, input.reports);
  const carriedAdjustments: StatementCarriedAdjustment[] = [];
  for (const [fromMonth, charge] of carryCharges(current, input.reports)) {
    if (fromMonth === carriedHere) continue;
    const nowCents = owedBy(current, fromMonth);
    if (nowCents === charge.cents || month !== nextOpenMonth(charge.latest.month, finishedMonths)) continue;
    carriedAdjustments.push({ fromMonth, label: charge.label, statementId: charge.latest.reportId, carriedMonth: charge.latest.month, chargedCents: charge.cents, nowCents, deltaCents: nowCents - charge.cents });
  }
  carriedAdjustments.sort((a, b) => a.fromMonth.localeCompare(b.fromMonth));

  // The lines from the platforms' files first, newest stay first; then the lines typed, in the admin's order (dispatch 37C).
  const fromFiles = platformLinesOn({ propertyId, month, firstMonth, platformLines: input.platformLines ?? [], current });
  const lines = fromFiles.length > 0 ? [...fromFiles.map((row) => row.line), ...(draft?.lines ?? [])] : (draft?.lines ?? []);
  const fee = draft?.fee ?? null;
  const sums = statementSums(lines, costs, adjustments, fee, carried, carriedAdjustments);
  const reportById = new Map(input.reports.map((report) => [report.id, report]));
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
      carriedAdjustments,
      ...sums,
      pendingLeftOut: mine.filter((entry) => entry.status === 'pending' && entryMonth(entry) === month).length,
      notes: draft?.notes ?? null,
      supersedes,
      heading: true,
    },
    claim: {
      entries: costs.filter((row) => row.group === 'month').map((row) => ({ id: row.entryId, seen: row.historyLength })),
      ...(fromFiles.length > 0 ? { platform: fromFiles.map((row) => ({ id: row.line.id, seen: row.seen })) } : {}),
      earlier: costs.filter((row) => row.group === 'earlier').map((row) => ({ id: row.entryId, seen: row.historyLength })),
      adjustments: adjustments.map((row) => ({ entryId: row.entryId, statementId: row.statementId, deltaCents: row.deltaCents })),
      carried: carried ? { fromMonth: carriedHere, amountCents: carried.amountCents } : null,
      carriedAdjustments: carriedAdjustments.map((row) => ({ fromMonth: row.fromMonth, deltaCents: row.deltaCents })),
    },
    reportedElsewhere,
  };
}

/** How a report is named on paper: its reference when it has one, else its six-character ref. */
function displayName(report: Pick<MonthlyReportView, 'id' | 'reference'>): string {
  return report.reference?.trim() ? report.reference.trim() : reportRef(report.id);
}

/**
 * Whether two claims say the same thing, in any order. The carried balance and the carried balances settled
 * (dispatch 35) are compared when the page sent them; a page built before sends neither.
 */
export function sameClaim(a: FinishClaim, b: FinishClaim): boolean {
  const key = (claim: FinishClaim, withCarried: boolean) =>
    JSON.stringify({
      entries: [...claim.entries].sort((x, y) => x.id.localeCompare(y.id)),
      earlier: [...claim.earlier].sort((x, y) => x.id.localeCompare(y.id)),
      adjustments: [...claim.adjustments].sort((x, y) => x.entryId.localeCompare(y.entryId)),
      platform: [...(claim.platform ?? [])].sort((x, y) => x.id.localeCompare(y.id)),
      ...(withCarried ? { carried: claim.carried ?? null, carriedAdjustments: [...(claim.carriedAdjustments ?? [])].sort((x, y) => x.fromMonth.localeCompare(y.fromMonth)) } : {}),
    });
  const withCarried = b.carried !== undefined || b.carriedAdjustments !== undefined;
  return key(a, withCarried) === key(b, withCarried);
}

/**
 * The later statements that adjusted or carried from a finished one (Kian's ruling of 2026-10-12: the delete and
 * correct confirmations name them): current statements of later months that printed an adjustment for an entry it
 * charged, carried its closing balance, or settled a carried balance from its month.
 */
export function laterReferences(report: MonthlyReportView, reports: MonthlyReportView[]): { report: MonthlyReportView; adjusted: boolean; carried: boolean }[] {
  const charged = new Set(chargedBy(report).map((row) => row.entryId));
  return currentReports(reports)
    .filter((other) => other.id !== report.id && other.month > report.month)
    .map((other) => ({
      report: other,
      adjusted: other.adjustments.some((row) => charged.has(row.entryId) || row.statementId === report.id),
      carried: carriedFromMonth(other.carried, reports) === report.month || (other.carriedAdjustments ?? []).some((row) => row.fromMonth === report.month),
    }))
    .filter((row) => row.adjusted || row.carried)
    .sort((a, b) => a.report.month.localeCompare(b.report.month));
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
    carriedAdjustments: report.carriedAdjustments ?? [],
    incomeCents: report.incomeCents,
    expensesCents: report.expensesCents,
    recordedCents: report.recordedCents,
    costsCents: report.costsCents,
    feeCents: report.feeCents,
    carriedAdjustmentCents: (report.carriedAdjustments ?? []).reduce((sum, row) => sum + row.deltaCents, 0),
    totalCents: report.totalCents,
    carriedCents: report.carriedCents,
    payableCents: report.payableCents,
    pendingLeftOut: report.pendingLeftOut,
    notes: report.notes,
    supersedes: report.supersedes
      ? { ref: replaced ? displayName(replaced) : reportRef(report.supersedes.reportId), reportDate: replaced?.reportDate || null, finishedAt: replaced?.finishedAt ?? null, reason: report.supersedes.reason }
      : null,
    // A report finished before dispatch 34 is drawn exactly as it was stored.
    heading: report.schemaVersion >= 4,
  };
}

// ─── The printed lines ─────────────────────────────────────────

export type PrintedLineKind = 'line' | 'cost' | 'earlier' | 'adjustment' | 'carriedAdjustment' | 'fee';

/** One row of the Payment Summary's table, in print order. */
export interface PrintedLine {
  key: string;
  kind: PrintedLineKind;
  description: string;
  quantity: number;
  /** null on a cleaning line whose cleanings' amounts differ (dispatch 37B): the Rate column is left empty, the Amount their total. */
  rateCents: number | null;
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
 * back). A $0.00 fee does not print (Kian's ruling of 2026-10-12, dispatch
 * 34) on a statement of the dispatch 34 layout (`heading`); a report of
 * version 3 is drawn as it was stored.
 */
export function printedLines(statement: Pick<Statement, 'lines' | 'costs' | 'adjustments' | 'fee'> & { heading?: boolean; carriedAdjustments?: StatementCarriedAdjustment[] }): PrintedLine[] {
  const rows: PrintedLine[] = statement.lines.map((line) => ({ key: line.id, kind: 'line', description: lineText(line), quantity: line.quantity, rateCents: line.rateCents, amountCents: line.amountCents, entryId: null }));
  // A month's cleanings print as one line, "Expense - Cleaning", with the total (Kian's ruling of 2026-10-13); the cost
  // rows keep each cleaning. Cleanings of an earlier month carried here print as one line for that month, labelled with it.
  const cleaningLine = (group: StatementCost[], key: string, description: string) => {
    if (group.length === 0) return;
    const total = group.reduce((sum, row) => sum + row.totalCents, 0);
    const equal = group.every((row) => row.totalCents === group[0].totalCents);
    rows.push({ key, kind: 'cost', description, quantity: group.length, rateCents: equal ? -group[0].totalCents : null, amountCents: -total, entryId: null });
  };
  const isCleaningRow = (row: StatementCost) => row.kind === 'cleaning';
  cleaningLine(statement.costs.filter((cost) => cost.group === 'month' && isCleaningRow(cost)), 'cleaning-month', 'Expense - Cleaning');
  for (const row of statement.costs.filter((cost) => cost.group === 'month' && !isCleaningRow(cost))) {
    rows.push({ key: `cost-${row.entryId}`, kind: 'cost', description: `Expense - ${row.description}`, quantity: 1, rateCents: -row.totalCents, amountCents: -row.totalCents, entryId: row.entryId });
  }
  const earlierCleanings = statement.costs.filter((cost) => cost.group === 'earlier' && isCleaningRow(cost));
  for (const month of [...new Set(earlierCleanings.map((row) => row.month ?? monthOfDay(row.day)))].sort()) {
    cleaningLine(earlierCleanings.filter((row) => (row.month ?? monthOfDay(row.day)) === month), `cleaning-${month}`, `Expense - Cleaning (from ${monthLabel(month)})`);
  }
  for (const row of statement.costs.filter((cost) => cost.group === 'earlier' && !isCleaningRow(cost))) {
    // An earlier month's cost says the month it came from; an office cost's row already prints it (dispatch 36).
    const from = row.kind === 'office' && row.month ? '' : ` (from ${monthLabel(monthOfDay(row.day))})`;
    rows.push({ key: `cost-${row.entryId}`, kind: 'earlier', description: `Expense - ${row.description}${from}`, quantity: 1, rateCents: -row.totalCents, amountCents: -row.totalCents, entryId: row.entryId });
  }
  for (const row of statement.adjustments) {
    const what = row.description?.trim() ? row.description : `entry ${row.entryId.slice(0, 6)}`;
    const where = row.printedMonth ? `in ${monthLabel(row.printedMonth)}` : 'earlier';
    const now = row.nowCents === 0 ? 'no longer in the ledger' : `now ${formatCents(-row.nowCents)}`;
    rows.push({ key: `adj-${row.entryId}`, kind: 'adjustment', description: `Adjustment - ${what} (reported ${where} as ${formatCents(-row.printedCents)}, ${now})`, quantity: 1, rateCents: -row.deltaCents, amountCents: -row.deltaCents, entryId: row.entryId });
  }
  // A carried balance settled after its month was corrected or deleted (dispatch 35): what the owner gains, or, negative, owes.
  for (const row of statement.carriedAdjustments ?? []) {
    rows.push({ key: `carried-${row.fromMonth}`, kind: 'carriedAdjustment', description: `Adjustment - ${row.label} (carried in ${monthLabel(row.carriedMonth)} as ${formatCents(row.chargedCents)}, now ${formatCents(row.nowCents)})`, quantity: 1, rateCents: -row.deltaCents, amountCents: -row.deltaCents, entryId: null });
  }
  if (statement.fee && !(statement.heading && statement.fee.amountCents === 0)) rows.push({ key: 'fee', kind: 'fee', description: statement.fee.label, quantity: 1, rateCents: -statement.fee.amountCents, amountCents: -statement.fee.amountCents, entryId: null });
  return rows;
}

/** "Revenue share", with the figure as printed: "-$359.96" below zero. */
export function closingWords(payableCents: number): { label: string; amount: string } {
  return { label: payableCents < 0 ? 'Revenue share, owed to NuBNB' : 'Revenue share', amount: formatCents(payableCents) };
}

/** The label the fee starts with: "NuBNB 20% Net of $9,539.78". */
export function feeLabelFor(rateBasisPoints: number | null, baseCents: number | null): string {
  if (rateBasisPoints === null) return 'NuBNB fee';
  // No base typed yet (dispatch 26: the base has no default): the label names the rate alone.
  return baseCents === null ? `NuBNB ${rateText(rateBasisPoints)}` : `NuBNB ${rateText(rateBasisPoints)} Net of ${formatCents(baseCents)}`;
}

/** A fee from a rate and a base, the amount computed; the amount given overrides it. */
export function feeFrom(label: string, rateBasisPoints: number | null, baseCents: number | null, amountCents: number | null): Fee {
  const computedCents = feeComputed(baseCents, rateBasisPoints);
  const amount = amountCents ?? computedCents ?? 0;
  return { label, rateBasisPoints, baseCents, computedCents, amountCents: amount, overwritten: amountCents !== null && amount !== computedCents };
}

/** "Airbnb · ref HMABC123", for a line loaded from a row written before dispatch 23D; "" when it carried nothing. */
export function lineDetailsText(line: Pick<Line, 'source' | 'reference'>): string {
  return [line.source === undefined ? null : LINE_SOURCE_LABELS[line.source], line.reference ? `ref ${line.reference}` : null].filter((part): part is string => part !== null).join(' · ');
}

/** Whether a statement has anything in it: no line, no cost, no adjustment and no fee is "Nothing to report". */
export function nothingToReport(statement: { income?: IncomeRow[]; lines?: Line[]; costs: StatementCost[]; adjustments: StatementAdjustment[]; carriedAdjustments?: StatementCarriedAdjustment[]; fee: { amountCents: number } | null }): boolean {
  return (statement.income?.length ?? 0) === 0 && (statement.lines?.length ?? 0) === 0 && statement.costs.length === 0 && statement.adjustments.length === 0 && (statement.carriedAdjustments?.length ?? 0) === 0 && (statement.fee === null || statement.fee.amountCents === 0);
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
  return { label: `Balance From ${monthLabel(previous.month).split(' ')[0]}`, amountCents: -previous.payableCents, fromReportId: previous.id, fromMonth: previous.month };
}

/**
 * The reference to offer: the previous one with its month word swapped ("June-321-John" → "July-321-John"),
 * when it starts with its month's word. Any of the three words is read, in any case — "Sept-", "Sep-" or
 * "September-" (dispatch 34, S24) — and the next month's word is written in the same style; the reports' own
 * word is tried first, so "July-19-Tannery" is followed by "Aug-19-Tannery", as the reports NuBNB sends have it.
 */
export function referenceSuggestion(previous: MonthlyReportView | null, month: string): string | null {
  if (!previous || !previous.reference) return null;
  const was = monthWordStyles(previous.month);
  const next = monthWordStyles(month);
  if (!was || !next) return null;
  for (const style of ['reference', 'long', 'short'] as const) {
    const word = `${was[style]}-`;
    if (previous.reference.toLowerCase().startsWith(word.toLowerCase())) return `${next[style]}-${previous.reference.slice(word.length)}`;
  }
  return null;
}

/**
 * The reference a new statement starts from: "<Mon>-<stem>" when the property has a reference stem (Kian's ruling K5
 * of 2026-10-17), else the previous one with its month word swapped; null when neither gives one. Always a suggestion:
 * the admin can type over it.
 */
export function suggestedReference(previous: MonthlyReportView | null, stem: string | null | undefined, month: string): string | null {
  return referenceFromStem(stem, month) ?? referenceSuggestion(previous, month);
}

/** The fee rate to start from: the previous statement's, else the property's default. */
export function feeRateSuggestion(previous: MonthlyReportView | null, management: PropertyManagementView | null): number | null {
  return previous?.fee?.rateBasisPoints ?? management?.defaultFeeRateBasisPoints ?? null;
}

// ─── Nubnb's reporting cycle ───────────────────────────────────
//
// Kian's ruling of 2026-10-02 (dispatch 23G): admins write the previous
// month's statements between the 1st and the 10th of the current month. A
// property's status is read from the previous month — what is due now:
// finished is done; not finished is a warning, from the 1st to the 10th and
// unchanged after the 10th; any month two or more months back with no
// finished statement is a problem, which outranks the warning. The current
// month is never counted: it is not due.
//
// This is the only place that rule is written. The property list's column,
// the property page's head and month control, the Finish tab's release
// status, the home panel and the Statements tile all read `monthStanding`
// or `reportingStatus` and print `STANDING_LABELS`; none decides for itself.
//
// A month is owed when it is in the property's statement months: every
// closed month by default, from STATEMENTS_FROM_DEFAULT, narrowed only by the
// property's management record — its start month excludes earlier ones, its
// end month later ones (Kian's ruling of 2026-10-02) — and never one before
// the month the property's document was created, by Firestore's own create
// time (Kian's ruling of 2026-10-03). A draft does not make a month owed. It is finished when it has a current finished statement — one
// no other statement replaces; a correction in progress beside it does not
// unfinish it, and a draft is not a statement.

/** Where one property-month stands in the cycle. */
export type Standing =
  /** It has a current finished statement. */
  | 'finished'
  /** The previous month, owed and not finished: a warning, whatever the day of the month. */
  | 'due'
  /** Two or more months back, owed and not finished: a problem. */
  | 'pastDue'
  /** The current month or a later one: never counted. */
  | 'open'
  /** Outside the property's statement months, and not finished. */
  | 'notExpected'
  /** The property is excluded from reporting (Kian's ruling of 2026-10-03), and the month is not finished: owed by nobody, counted nowhere. */
  | 'excluded';

/** The words for each standing, the same everywhere a statement's status is shown. */
export const STANDING_LABELS: Record<Standing, string> = {
  finished: 'Finished',
  due: 'Due',
  pastDue: 'Past due',
  open: 'Open, not yet due',
  notExpected: 'No statement expected',
  excluded: 'Excluded from reporting',
};

/**
 * The rule, for one property-month. `today` is yyyy-mm-dd in Toronto; `owed`:
 * the month is in the property's statement months; `excluded`: the property
 * is excluded from reporting, so no month of it is owed.
 */
export function monthStanding(input: { month: string; today: string; owed: boolean; finished: boolean; excluded?: boolean }): Standing {
  if (input.finished) return 'finished';
  if (input.excluded) return 'excluded';
  if (!input.owed) return 'notExpected';
  const previous = lastClosedMonth(input.today);
  if (input.month > previous) return 'open';
  return input.month === previous ? 'due' : 'pastDue';
}

/** A property's status: done, a warning, a problem, or nothing due yet. */
export type ReportingTone = 'done' | 'warning' | 'problem' | 'none';

export interface ReportingStatus {
  tone: ReportingTone;
  /** The standing of `month`, whose label is the status's words. */
  standing: Standing;
  /**
   * The month in question, where the list's column leads: the oldest
   * past-due month for a problem; the previous month for a warning or done
   * (the last month of the property's statements, when they ended before
   * it); the first month a statement will be due when none is yet.
   */
  month: string;
  /** Every month two or more back that is owed and not finished, oldest first. */
  pastDue: string[];
  /** The previous month and its standing. */
  previous: { month: string; standing: Standing };
}

export interface ReportingInputs {
  propertyId: string;
  /** Today, yyyy-mm-dd in Toronto. */
  today: string;
  management: PropertyManagementView | null;
  /** The Toronto month the property's document was created (Kian's ruling of 2026-10-03); null when not known. */
  createdMonth?: string | null;
  /** The months the property has accepted income or approved costs in (Kian's ruling of 2026-10-04; `moneyMonthsByProperty`). */
  moneyMonths?: readonly string[];
  /** Finished reports — of this property or of every property; only this property's are read. */
  reports: { id: string; propertyId: string; month: string; supersedes: Supersedes | null }[];
}

const TONE_OF: Record<Standing, ReportingTone> = { finished: 'done', due: 'warning', pastDue: 'problem', open: 'none', notExpected: 'none', excluded: 'none' };

/**
 * The months each property has money in, by property ID, oldest first (Kian's
 * ruling of 2026-10-04: a property owes a statement for any month in which it
 * has accepted income or approved costs, regardless of when it was added; and
 * of 2026-10-13, M2: a month whose only money is a logged cleaning or a cash
 * payment is owed a statement). A month counts when it holds any confirmed
 * line of the month's money (app/lib/money/month.ts), whatever its source:
 *   typed           a line on the month's statement draft, typed by an admin
 *   airbnb          a line accepted from a platform's file, in the month the
 *                   platform paid it: read where it is stored since dispatch
 *                   37C (M10), or, accepted before, copied into the draft. A
 *                   proposed line counts nowhere
 *   receipt, work,  an approved entry, in the month it belongs to: an office
 *   office          cost's chosen month, else the Toronto month it was sent
 *                   (`entryMonth`), the month its ledger and statement put it in
 *   cleaning        a cleaning an admin logged (dispatch 37B), in the month of
 *                   the day cleaned: one of the entries, of kind `cleaning`
 * A received cash payment (37E) is a further source: added here, beside these.
 */
export function moneyMonthsByProperty(
  drafts: { propertyId: string; month: string; lines: readonly unknown[] }[],
  entries: Pick<CostEntryView, 'property' | 'status' | 'createdAt' | 'month'>[],
  platformLines: readonly Pick<PlatformLineInput, 'propertyId' | 'month'>[] = [],
): Map<string, string[]> {
  const months = new Map<string, Set<string>>();
  const add = (propertyId: string, month: string) => months.set(propertyId, (months.get(propertyId) ?? new Set<string>()).add(month));
  // Lines on the month's draft: typed, or accepted from a platform's file before dispatch 37C (copied into it).
  for (const draft of drafts) if (draft.lines.length > 0) add(draft.propertyId, draft.month);
  // Lines accepted from a platform's file since dispatch 37C, read where they are stored (M10), in the month paid.
  for (const line of platformLines) add(line.propertyId, line.month);
  // Approved cost entries, in the month they belong to.
  for (const entry of entries) {
    if (entry.status !== 'approved' || entry.property.id === null) continue;
    const belongs = entryMonth(entry);
    if (belongs !== null) add(entry.property.id, belongs);
  }
  return new Map([...months].map(([propertyId, set]) => [propertyId, [...set].sort()]));
}

/** The rule, for one property: the worst of its months up to the previous one. */
export function reportingStatus(input: ReportingInputs): ReportingStatus {
  const createdMonth = input.createdMonth ?? null;
  const moneyMonths = input.moneyMonths ?? [];
  const { from, until } = statementMonths(input.management, createdMonth, moneyMonths);
  const previous = lastClosedMonth(input.today);
  // Excluded from reporting (Kian's ruling of 2026-10-03): it owes no statements, so nothing of it is due, past due or counted as finished.
  if (isExcludedFromReporting(input.management)) return { tone: 'none', standing: 'excluded', month: previous, pastDue: [], previous: { month: previous, standing: 'excluded' } };
  const finished = new Set(currentReports(input.reports.filter((report) => report.propertyId === input.propertyId)).map((report) => report.month));
  const owed = (month: string) => inStatementScope(input.management, month, createdMonth, moneyMonths);
  const standingOf = (month: string) => monthStanding({ month, today: input.today, owed: owed(month), finished: finished.has(month) });
  const last = until !== null && until < previous ? until : previous;
  const pastDue = monthsBetween(from, last).filter((month) => standingOf(month) === 'pastDue');
  const before = { month: previous, standing: standingOf(previous) };
  const at = (month: string, standing: Standing): ReportingStatus => ({ tone: TONE_OF[standing], standing, month, pastDue, previous: before });
  if (pastDue.length > 0) return at(pastDue[0], 'pastDue');
  if (before.standing === 'due' || before.standing === 'finished') return at(previous, before.standing);
  // The previous month is not owed: the record ends the statements before it (every one finished, or a month would be past due), or starts them later.
  // The month named is the last one owed: a month before the property was added with no money in it is not.
  if (until !== null && until < previous && from <= until) return at(monthsBetween(from, until).filter(owed).pop() ?? until, 'finished');
  const first = from > monthOfDay(input.today) ? from : monthOfDay(input.today);
  return at(first, standingOf(first));
}

/** Every property's status, by property ID, from the tracker's one read (the list, the panel and the tile share it). */
export function reportingStatuses(input: { today: string; properties: { id: string; createdMonth?: string | null; moneyMonths?: readonly string[] }[]; management: PropertyManagementView[]; reports: ReportingInputs['reports'] }): Map<string, ReportingStatus> {
  const records = new Map(input.management.map((record) => [record.propertyId, record]));
  return new Map(input.properties.map((property) => [property.id, reportingStatus({ propertyId: property.id, today: input.today, management: records.get(property.id) ?? null, createdMonth: property.createdMonth ?? null, moneyMonths: property.moneyMonths ?? [], reports: input.reports })]));
}

/** What the Statements tile counts, over every property's status: statements past due, the previous month's due and finished. */
export function reportingCounts(statuses: ReportingStatus[]): { pastDue: number; pastDueProperties: number; due: number; finished: number; owed: number } {
  return {
    pastDue: statuses.reduce((sum, status) => sum + status.pastDue.length, 0),
    pastDueProperties: statuses.filter((status) => status.pastDue.length > 0).length,
    due: statuses.filter((status) => status.previous.standing === 'due').length,
    finished: statuses.filter((status) => status.previous.standing === 'finished').length,
    owed: statuses.filter((status) => status.previous.standing === 'due' || status.previous.standing === 'finished').length,
  };
}

// ─── The tracker ───────────────────────────────────────────────

/** What is stored for a property-month. Its standing in the cycle is `monthStanding`'s. */
export type StatementState =
  /** A closed month with no finished statement and nothing started. */
  | { kind: 'outstanding' }
  /** A month that has not ended, with nothing started (dispatch 23D). */
  | { kind: 'open' }
  | { kind: 'draft'; savedAt: string; superseding: boolean }
  | { kind: 'finished'; report: MonthlyReportSummaryLike; replaced: number };

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
  /** The month's standing in the cycle: the row's badge. */
  standing: Standing;
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
  /** Each property with the Toronto month its document was created, when known (Kian's ruling of 2026-10-03), and the months it has money in (2026-10-04). */
  properties: { id: string; name: string | null; internalName?: string | null; createdMonth?: string | null; moneyMonths?: readonly string[] }[];
  reports: MonthlyReportSummaryLike[];
  drafts: DraftLike[];
  downloads: { reportId: string; at: string }[];
  management: PropertyManagementView[];
}

/** The panel's order: what needs work first. */
const ORDER: Record<Standing, number> = { pastDue: 0, due: 1, open: 2, notExpected: 3, excluded: 3, finished: 4 };

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
 * — past due first, then due, then open, then finished.
 */
export function trackerRows(input: TrackerInputs): TrackerRow[] {
  const management = new Map(input.management.map((record) => [record.propertyId, record]));
  const current = new Set(currentReports(input.reports).map((report) => report.id));
  const rows: TrackerRow[] = [];
  for (const property of input.properties) {
    const record = management.get(property.id) ?? null;
    // An excluded property leaves the panel (Kian's ruling of 2026-10-03), statements and drafts included: it owes nothing.
    if (isExcludedFromReporting(record)) continue;
    const found = propertyMonth(property.id, input.month, input.reports, input.drafts, current);
    const inScope = inStatementScope(record, input.month, property.createdMonth ?? null, property.moneyMonths ?? []);
    if (!inScope && found.reports.length === 0 && found.draft === null) continue;
    const state = stateOf(input.month, input.today, found);
    const { live, reports } = found;
    const downloads = live ? input.downloads.filter((d) => d.reportId === live.id).map((d) => d.at).sort() : [];
    rows.push({
      propertyId: property.id,
      // The name the admin shows: its cleaner-facing name, else its public title (Kian's rulings of 2026-10-15, evening).
      propertyName: property.internalName?.trim() || property.name?.trim() || 'Unnamed property',
      state,
      standing: monthStanding({ month: input.month, today: input.today, owed: inScope, finished: live !== null }),
      downloads: downloads.length,
      lastDownloadAt: downloads[downloads.length - 1] ?? null,
      reports: reports.map((report) => ({ report, replacedBy: input.reports.find((other) => other.supersedes?.reportId === report.id) ?? null })),
    });
  }
  return rows.sort((a, b) => ORDER[a.standing] - ORDER[b.standing] || a.propertyName.localeCompare(b.propertyName, 'en-CA'));
}

/** The panel's line: how many rows stand where — `owed` every row but a draft on a month not owed — and how many hold a draft in progress. */
export function trackerCounts(rows: TrackerRow[]): { owed: number; finished: number; due: number; pastDue: number; open: number; notExpected: number; drafts: number } {
  const count = (standing: Standing) => rows.filter((row) => row.standing === standing).length;
  return { owed: rows.length - count('notExpected') - count('excluded'), finished: count('finished'), due: count('due'), pastDue: count('pastDue'), open: count('open'), notExpected: count('notExpected'), drafts: rows.filter((row) => row.state.kind === 'draft').length };
}

// ─── One property's months (the property page, dispatch 23D) ───

export interface PropertyMonthRow {
  month: string;
  state: StatementState;
  /** The month's standing in the cycle. */
  standing: Standing;
  /** Every finished report for the month, newest first, with which replaced which. */
  reports: { report: MonthlyReportSummaryLike; replacedBy: MonthlyReportSummaryLike | null }[];
  /** Whether the month is in the property's statement scope. */
  inScope: boolean;
}

export interface PropertyMonthsInputs {
  propertyId: string;
  today: string;
  management: PropertyManagementView | null;
  /** The Toronto month the property's document was created, when known (Kian's ruling of 2026-10-03). */
  createdMonth?: string | null;
  /** The months the property has accepted income or approved costs in (Kian's ruling of 2026-10-04). */
  moneyMonths?: readonly string[];
  /** The property's reports and drafts only. */
  reports: MonthlyReportSummaryLike[];
  drafts: DraftLike[];
}

/**
 * The months a property's page lists: from its first statement month, or the
 * current month, or an earlier month that has a statement or a draft,
 * whichever is earliest, to the current month or a later one that has one;
 * each with its state, newest first. The current month is always listed, so
 * a statement can be made for it whatever the property's scope. Which
 * months need work is `reportingStatus`'s to say, not this list's.
 */
export function propertyMonths(input: PropertyMonthsInputs): { rows: PropertyMonthRow[] } {
  const createdMonth = input.createdMonth ?? null;
  const moneyMonths = input.moneyMonths ?? [];
  const { from } = statementMonths(input.management, createdMonth, moneyMonths);
  const thisMonth = monthOfDay(input.today);
  const touched = [...input.reports.map((report) => report.month), ...input.drafts.map((draft) => draft.month)].sort();
  const first = [from, thisMonth, ...(touched[0] !== undefined ? [touched[0]] : [])].sort()[0];
  const lastTouched = touched[touched.length - 1];
  const last = lastTouched !== undefined && lastTouched > thisMonth ? lastTouched : thisMonth;
  const rows: PropertyMonthRow[] = [];
  for (const month of monthsBetween(first, last)) {
    const inScope = inStatementScope(input.management, month, createdMonth, moneyMonths);
    const one = propertyMonthState({ ...input, month, inScope, excluded: isExcludedFromReporting(input.management) });
    if (!inScope && month !== thisMonth && one.reports.length === 0 && one.state.kind !== 'draft') continue;
    rows.push({ month, inScope, ...one });
  }
  return { rows: rows.reverse() };
}

/**
 * One property-month's state, its standing and its reports, for the
 * property page's month control (dispatch 23F): the same reading
 * `trackerRows` and `propertyMonths` make, for any month, listed or not.
 */
export function propertyMonthState(input: { propertyId: string; month: string; today: string; inScope: boolean; excluded?: boolean; reports: MonthlyReportSummaryLike[]; drafts: DraftLike[] }): Pick<PropertyMonthRow, 'state' | 'standing' | 'reports'> {
  const current = new Set(currentReports(input.reports).map((report) => report.id));
  const found = propertyMonth(input.propertyId, input.month, input.reports, input.drafts, current);
  return {
    state: stateOf(input.month, input.today, found),
    standing: monthStanding({ month: input.month, today: input.today, owed: input.inScope, finished: found.live !== null, excluded: input.excluded }),
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
  /** What it charged for each entry (dispatch 35): cost rows' totals and adjustments' differences. Absent on a summary made before. */
  charged?: PrintedEntry[];
}

export function looseEnds(
  month: string,
  entries: CostEntryView[],
  reports: LooseEndsReport[],
  management: PropertyManagementView[],
  nameOf: (propertyId: string) => string,
): LooseEnds {
  const byProperty = new Map<string, CostEntryView[]>();
  for (const entry of entries) {
    if (entry.property.id === null) continue;
    byProperty.set(entry.property.id, [...(byProperty.get(entry.property.id) ?? []), entry]);
  }
  const records = new Map(management.map((record) => [record.propertyId, record]));
  const current = currentReports(reports);
  const out: LooseEnds = { pending: [], late: [], adjustments: [] };
  for (const [propertyId, list] of byProperty) {
    // An excluded property owes no statement, so nothing of it is a loose end of one.
    if (isExcludedFromReporting(records.get(propertyId))) continue;
    const pending = list.filter((entry) => entry.status === 'pending' && entryMonth(entry) === month).length;
    if (pending > 0) out.pending.push({ propertyId, propertyName: nameOf(propertyId), count: pending });
    const mine = current.filter((report) => report.propertyId === propertyId);
    const listed = new Set(mine.flatMap((report) => report.entryIds));
    const { from: firstMonth } = statementMonths(records.get(propertyId) ?? null);
    const late = list.filter((entry) => {
      const belongs = entryMonth(entry);
      return entry.status === 'approved' && belongs !== null && belongs <= month && belongs >= firstMonth && !listed.has(entry.id);
    }).length;
    if (late > 0) out.late.push({ propertyId, propertyName: nameOf(propertyId), count: late });
    const byId = new Map(list.map((entry) => [entry.id, entry]));
    // What the current statements charged for each entry in all (dispatch 35): a month redone after a later adjustment
    // charges only what is left, so its last printing alone is no longer the amount charged.
    const charged = new Map<string, number>();
    if (mine.every((report) => report.charged !== undefined)) {
      for (const report of mine) for (const { entryId, cents } of report.charged ?? []) charged.set(entryId, (charged.get(entryId) ?? 0) + cents);
    } else {
      for (const [entryId, { cents }] of lastPrinted(mine)) charged.set(entryId, cents);
    }
    let changed = 0;
    for (const [entryId, cents] of charged) {
      const entry = byId.get(entryId);
      const now = entry && entry.status === 'approved' && entry.linesNow.kind === 'ok' ? entry.linesNow.totalCents : 0;
      if (now !== cents) changed += 1;
    }
    if (changed > 0) out.adjustments.push({ propertyId, propertyName: nameOf(propertyId), count: changed });
  }
  return out;
}
