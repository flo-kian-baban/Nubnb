/**
 * The month's money (dispatch 37A): one calculation per property and month.
 *
 * Kian's rulings of 2026-10-13:
 *   - Every page showing a property-month's figures reads them through this one calculation. No page computes its
 *     own.
 *   - Airbnb claw-backs count as less revenue, never as expenses. The fee base is what Airbnb actually paid (M1).
 *   - A month whose only money is a logged cleaning or a cash payment is owed a statement (M2): the owed-months rule
 *     counts a month with any confirmed line, whatever its source (`moneyMonthsByProperty` in statement.ts).
 *
 * ── What it reads ──
 * One property's records: its cost entries, its finished statements, the month's draft (as stored, or as the
 * property page holds it typed), its owner record, and which statement lines came from an accepted Airbnb line.
 *
 * ── What it gives ──
 *   - The statement: as frozen when finished, built live otherwise. `buildStatement` (statement.ts) is the
 *     statement's arithmetic and stays it: the preview, Finish's claim and every byte printed are its, unchanged.
 *   - The figures: revenue by source, typed expenses, recorded costs, the fee, the carried balance and the carried
 *     balances settled, Total and Revenue Share. While a correction is written, the figures are the statement the
 *     owner holds, and the correction's are given beside them.
 *   - The month's cost lines: each entry that belongs to the month, with every statement that charges it and how
 *     much, so the Costs tab, the ledger and its exports say where a cost went, as the statements do.
 *
 * ── The line ──
 * Every source is read as the same thing: a property, the month it belongs to, an amount, its source, whether it is
 * confirmed, and the statement it goes on. A line is made when it is read; it is never stored. Sources today:
 *   receipt, work, office   cost entries: the month an office cost is for, else the day sent (`entryMonth`);
 *                           confirmed when approved
 *   typed                   a line typed on the month's draft: confirmed when typed
 *   airbnb                  a draft line an accepted Airbnb line points to (`decided.lineId`): confirmed when
 *                           accepted. A copy made by acceptance keeps its source this way, rewritten nowhere.
 *   cleaning                a cleaning an admin logged (dispatch 37B), read as an entry of kind `cleaning`
 *                           (app/lib/cleanings/model.ts): the month of the day cleaned; confirmed when logged
 * A cash payment (37E) is a further source of the same line.
 *
 * ── Which statement charges a cost ──
 * The current finished statements, as stored: each cost row's total and each adjustment's difference. Then each
 * month not yet finished that would charge something, built exactly as its statement is built
 * (`buildStatement`, nothing typed): an entry's own month while it is open, else the next open one (dispatch 36);
 * a change after printing on the month after the latest statement that charged it (dispatch 35). Added up, an
 * entry's charges come to what it now adds up to: a correction is counted once.
 *
 * ── Signs ──
 * A figure is an amount, named by what it is: revenue, costs, the fee, the carried balance. A statement's rows keep
 * the statement's own signs, as it prints them. Nothing here is stored, and nothing stored changes.
 *
 * Pure and client-safe.
 */

import { formatCents, type CostEntryView } from '@/app/lib/cleaners/model';
import { entryMonth } from '@/app/lib/costs/report';
import { currentReports, monthLabel, type Line, type MonthlyReportView, type PropertyManagementView } from '@/app/lib/reports/model';
import { buildStatement, nextOpenMonth, printedLines, statementMonthFor, statementOf, type AnyStatement, type StatementBuild, type StatementInputs } from '@/app/lib/reports/statement';

// ─── Sources ───────────────────────────────────────────────────

export type MoneySource = 'receipt' | 'work' | 'office' | 'cleaning' | 'typed' | 'airbnb';

const NONE: ReadonlySet<string> = new Set();

/**
 * The statement lines that came from an accepted Airbnb line: the line each acceptance made (`decided.lineId`).
 * Line IDs are UUIDs, so one set serves every property and month.
 */
export function airbnbLineIdsOf(lines: readonly { decided: { status: string; lineId?: string } | null }[]): Set<string> {
  const ids = new Set<string>();
  for (const line of lines) if (line.decided?.status === 'accepted' && typeof line.decided.lineId === 'string') ids.add(line.decided.lineId);
  return ids;
}

/** Where a statement line came from: an accepted Airbnb line, or typed. A line loaded from a row written before dispatch 23D says so itself. */
export function lineSource(line: Pick<Line, 'id' | 'source'>, airbnbLineIds: ReadonlySet<string>): 'airbnb' | 'typed' {
  return airbnbLineIds.has(line.id) || line.source === 'airbnb' ? 'airbnb' : 'typed';
}

/** What a statement's lines bring in. */
export interface IncomeFigures {
  /** Revenue: every Airbnb line, claw-backs taken off (Kian's ruling M1), and every typed line above zero. */
  revenueCents: number;
  /** What Airbnb actually paid: its lines added up, claw-backs included. */
  airbnbCents: number;
  /** Typed lines above zero. */
  typedRevenueCents: number;
  /** Typed expenses: typed lines below zero, as an amount. Never an Airbnb line. */
  expensesCents: number;
}

/** A statement's lines by source (M1): an Airbnb line below zero takes revenue off; it is never an expense. */
export function incomeFigures(lines: readonly Pick<Line, 'id' | 'amountCents' | 'source'>[], airbnbLineIds: ReadonlySet<string> = NONE): IncomeFigures {
  let airbnbCents = 0;
  let typedRevenueCents = 0;
  let expensesCents = 0;
  for (const line of lines) {
    if (lineSource(line, airbnbLineIds) === 'airbnb') airbnbCents += line.amountCents;
    else if (line.amountCents > 0) typedRevenueCents += line.amountCents;
    else expensesCents -= line.amountCents;
  }
  return { revenueCents: airbnbCents + typedRevenueCents, airbnbCents, typedRevenueCents, expensesCents };
}

// ─── Figures ───────────────────────────────────────────────────

/**
 * A statement's figures. revenue − costs − fee − settled carried balances = Total; Total − carried balance =
 * Revenue Share. Each is an amount; Revenue Share below zero is owed to NuBNB.
 */
export interface Figures extends IncomeFigures {
  /** Recorded costs: cost rows, and adjustments' differences. */
  recordedCents: number;
  /** Typed expenses and recorded costs. */
  costsCents: number;
  feeCents: number;
  /** Carried balances settled on this statement after their month was corrected or deleted (dispatch 35). */
  carriedAdjustmentCents: number;
  totalCents: number;
  /** The carried balance, deducted after the Total. */
  carriedCents: number;
  payableCents: number;
}

/** A statement's figures, from its rows: a finished one's as it printed them, a draft's as it stands. */
export function figuresOf(statement: AnyStatement, airbnbLineIds: ReadonlySet<string> = NONE): Figures {
  if (statement.legacy) {
    // A statement finished before dispatch 23E: income rows and stored sums; no carried balance.
    const airbnbCents = statement.income.filter((row) => row.source === 'airbnb').reduce((sum, row) => sum + row.amountCents, 0);
    return {
      revenueCents: statement.incomeCents,
      airbnbCents,
      typedRevenueCents: statement.incomeCents - airbnbCents,
      expensesCents: 0,
      recordedCents: statement.costsCents,
      costsCents: statement.costsCents,
      feeCents: statement.feeCents,
      carriedAdjustmentCents: 0,
      totalCents: statement.payableCents,
      carriedCents: 0,
      payableCents: statement.payableCents,
    };
  }
  const income = incomeFigures(statement.lines, airbnbLineIds);
  return {
    ...income,
    recordedCents: statement.recordedCents,
    costsCents: income.expensesCents + statement.recordedCents,
    feeCents: statement.feeCents,
    carriedAdjustmentCents: statement.carriedAdjustmentCents,
    totalCents: statement.totalCents,
    carriedCents: statement.carriedCents,
    payableCents: statement.payableCents,
  };
}

/** The carried balance and the carried balances settled, together: what the Total loses besides costs and fee, and the Revenue Share besides that. */
export function carriedAllCents(figures: Pick<Figures, 'carriedCents' | 'carriedAdjustmentCents'>): number {
  return figures.carriedCents + figures.carriedAdjustmentCents;
}

/** "−$359.96 owed to NuBNB" below zero; the amount otherwise. */
export function payableText(payableCents: number): string {
  return payableCents < 0 ? `${formatCents(payableCents)} owed to NuBNB` : formatCents(payableCents);
}

// ─── Which statement charges a cost ────────────────────────────

/** One statement's charge for a cost: a finished statement's, or the open month's it goes on. */
export interface Charge {
  month: string;
  /** The current finished statement that charged it; null on a month not finished yet. */
  reportId: string | null;
  /** What it charges, a cost as an amount: a cost row's total, or an adjustment's difference (below zero: given back). */
  cents: number;
  kind: 'cost' | 'adjustment';
}

export interface ChargeInputs {
  propertyId: string;
  /** The property's entries (any others are left aside). */
  entries: CostEntryView[];
  /** The property's finished statements (any others are left aside). */
  reports: MonthlyReportView[];
  management: PropertyManagementView | null;
}

/**
 * Every statement that charges each of the property's cost entries, by entry ID, oldest month first: what the
 * current finished statements charged, and what each month not yet finished would, built as its statement is.
 */
export function costCharges(input: ChargeInputs): Map<string, Charge[]> {
  const { propertyId, management } = input;
  const entries = input.entries.filter((entry) => entry.property.id === propertyId);
  const reports = input.reports.filter((report) => report.propertyId === propertyId);
  const current = currentReports(reports);
  const finished = new Set(current.map((report) => report.month));
  const charges = new Map<string, Charge[]>();
  const add = (entryId: string, charge: Charge) => charges.set(entryId, [...(charges.get(entryId) ?? []), charge]);
  for (const report of current) {
    for (const row of report.costs) add(row.entryId, { month: report.month, reportId: report.id, cents: row.totalCents, kind: 'cost' });
    for (const row of report.adjustments) add(row.entryId, { month: report.month, reportId: report.id, cents: row.deltaCents, kind: 'adjustment' });
  }
  // The months not yet finished that charge something: each entry's statement month, and the month after each finished one.
  const open = new Set<string>();
  for (const entry of entries) {
    const month = entryMonth(entry);
    if (month !== null) open.add(statementMonthFor(month, finished));
  }
  for (const month of finished) open.add(nextOpenMonth(month, finished));
  for (const month of [...open].sort()) {
    const built = buildStatement({ propertyId, propertyName: '', month, entries, reports, draft: null, management });
    if (built.kind !== 'ok') continue;
    for (const row of built.statement.costs) add(row.entryId, { month, reportId: null, cents: row.totalCents, kind: 'cost' });
    for (const row of built.statement.adjustments) add(row.entryId, { month, reportId: null, cents: row.deltaCents, kind: 'adjustment' });
  }
  for (const list of charges.values()) list.sort((a, b) => a.month.localeCompare(b.month) || (a.kind === b.kind ? 0 : a.kind === 'cost' ? -1 : 1));
  return charges;
}

/** Charges added up by statement month, oldest first. */
export function chargesByMonth(charges: readonly Charge[]): { month: string; finished: boolean; cents: number }[] {
  const byMonth = new Map<string, { month: string; finished: boolean; cents: number }>();
  for (const charge of charges) {
    const was = byMonth.get(charge.month);
    byMonth.set(charge.month, { month: charge.month, finished: (was?.finished ?? false) || charge.reportId !== null, cents: (was?.cents ?? 0) + charge.cents });
  }
  return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
}

/** Whether a cost is charged anywhere but its own month's statement. */
export function chargedElsewhere(month: string | null, charges: readonly Charge[]): boolean {
  return charges.some((charge) => charge.month !== month);
}

/** "September 2026's statement". */
export function statementName(month: string): string {
  return `${monthLabel(month)}'s statement`;
}

// ─── The month's money ─────────────────────────────────────────

/** The month's draft: as stored, or as the property page holds it typed. `finishedAs` names the statement it was finished as. */
export type MoneyDraft = NonNullable<StatementInputs['draft']> & { finishedAs?: string | null };

export interface MonthMoneyInputs {
  propertyId: string;
  propertyName: string;
  month: string;
  /** The property's cost entries (any others are left aside). */
  entries: CostEntryView[];
  /** The property's finished statements (any others are left aside). */
  reports: MonthlyReportView[];
  draft: MoneyDraft | null;
  management: PropertyManagementView | null;
  /** The statement lines that came from accepted Airbnb lines (`airbnbLineIdsOf`). Without them every line reads as typed. */
  airbnbLineIds?: ReadonlySet<string>;
  /** The property's charges (`costCharges`), when the caller already holds them for every month. */
  charges?: ReadonlyMap<string, Charge[]>;
}

/** One cost entry that belongs to the month, and where it is charged. */
export interface CostLine {
  entry: CostEntryView;
  source: 'receipt' | 'work' | 'office' | 'cleaning';
  /** confirmed: approved; waiting: pending review; setAside: rejected, removed, or a status this code does not know. */
  state: 'confirmed' | 'waiting' | 'setAside';
  /** What it adds up to now; null when its lines cannot be read. A set-aside cost counts nothing. */
  nowCents: number | null;
  /** Every statement that charges it, oldest month first. */
  charges: Charge[];
}

/** What the month's costs add up to, and which statements charge them. */
export interface CostTotals {
  /** Approved costs of the month. */
  count: number;
  cents: number;
  taxCents: number;
  /** Approved costs whose lines cannot be read: never added in. */
  unreadable: number;
  /** Costs waiting for review, apart: in no statement until approved. */
  waiting: { count: number; cents: number };
  /** Where the month's costs are charged, by statement month, the month's own included; a cost removed after printing gives back on a later one. */
  byStatement: { month: string; finished: boolean; cents: number }[];
  /** Approved costs no statement charges: before the property's first statement month. */
  unchargedCents: number;
}

/** A row the month's statement charges for another month's cost, as a cost amount (dispatch 37A: one sign for costs). */
export interface AlsoCharged {
  key: string;
  description: string;
  cents: number;
  entryId: string | null;
}

export interface MonthMoney {
  propertyId: string;
  month: string;
  /** The month's current finished statement: what the owner received, also while a correction of it is written. */
  report: MonthlyReportView | null;
  /** A correction of `report` is being written. */
  correcting: boolean;
  /** The draft built as it stands; null while the month is finished and not being corrected. */
  build: StatementBuild | null;
  /** The statement the property page shows and Finish issues: the finished one, else the draft's as it stands. */
  statement: AnyStatement | null;
  /** The statement the owner holds or will: the finished one (also while it is corrected), else the draft's. */
  held: AnyStatement | null;
  /** The figures of `held`. */
  figures: Figures | null;
  /** While a correction is written: its figures, beside the statement as sent. */
  correction: Figures | null;
  /** The lines of `statement`, each with its source. */
  income: { line: Line; source: 'typed' | 'airbnb' }[];
  /** Every cost entry that belongs to the month, oldest first. */
  costs: CostLine[];
  costTotals: CostTotals;
  /** What `statement` charges for other months' costs: earlier months' entries and adjustments. */
  alsoCharged: AlsoCharged[];
}

const sourceOf = (kind: string): CostLine['source'] => (kind === 'work' || kind === 'office' || kind === 'cleaning' ? kind : 'receipt');
const stateOf = (status: string | null): CostLine['state'] => (status === 'approved' ? 'confirmed' : status === 'pending' ? 'waiting' : 'setAside');

/** The month's current finished statement, if any: the latest finished of the current ones. */
function currentOf(reports: MonthlyReportView[], month: string): MonthlyReportView | null {
  return currentReports(reports).filter((report) => report.month === month).sort((a, b) => b.finishedAt.localeCompare(a.finishedAt))[0] ?? null;
}

/**
 * The month's finished statement the admin is not correcting (the property page's rule since dispatch 23F): a draft
 * finished as a statement is that statement; a draft not finished is being written, a correction when it replaces
 * one; with no draft, the month's current finished statement, if any.
 */
export function frozenStatement(reports: MonthlyReportView[], month: string, draft: Pick<MoneyDraft, 'finishedAs'> | null): MonthlyReportView | null {
  const current = currentOf(reports, month);
  return draft ? (draft.finishedAs ? (reports.find((report) => report.id === draft.finishedAs) ?? current) : null) : current;
}

/** The month's money for one property: its statement, its figures, its cost lines and where each is charged. */
export function monthMoney(input: MonthMoneyInputs): MonthMoney {
  const { propertyId, month, draft, management } = input;
  const airbnb = input.airbnbLineIds ?? NONE;
  const reports = input.reports.filter((report) => report.propertyId === propertyId);
  const entries = input.entries.filter((entry) => entry.property.id === propertyId);

  // ── The statement ──
  const frozen = frozenStatement(reports, month, draft);
  const correcting = frozen === null && (draft?.supersedes ?? null) !== null;
  const build = frozen ? null : buildStatement({ propertyId, propertyName: input.propertyName, month, entries, reports, draft, management });
  const statement: AnyStatement | null = frozen ? statementOf(frozen, reports) : build?.kind === 'ok' ? build.statement : null;
  const replaced = correcting ? (reports.find((report) => report.id === draft?.supersedes?.reportId) ?? null) : null;
  const report = frozen ?? replaced;
  const held: AnyStatement | null = report ? statementOf(report, reports) : statement;
  const figures = held ? figuresOf(held, airbnb) : null;
  const correction = correcting && statement ? figuresOf(statement, airbnb) : null;
  const income = statement && !statement.legacy ? statement.lines.map((line) => ({ line, source: lineSource(line, airbnb) })) : [];

  // ── The month's cost lines, and where each is charged ──
  const charges = input.charges ?? costCharges({ propertyId, entries, reports, management });
  const costs: CostLine[] = entries
    .filter((entry) => entryMonth(entry) === month)
    .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id))
    .map((entry) => {
      const state = stateOf(entry.status);
      const readable = entry.linesNow.kind === 'ok' ? entry.linesNow.totalCents : null;
      return { entry, source: sourceOf(entry.kind), state, nowCents: state === 'setAside' ? 0 : readable, charges: charges.get(entry.id) ?? [] };
    });
  const confirmed = costs.filter((line) => line.state === 'confirmed');
  const waiting = costs.filter((line) => line.state === 'waiting');
  const cents = confirmed.reduce((sum, line) => sum + (line.nowCents ?? 0), 0);
  const byStatement = chargesByMonth(costs.filter((line) => line.state !== 'waiting').flatMap((line) => line.charges));
  const costTotals: CostTotals = {
    count: confirmed.length,
    cents,
    taxCents: confirmed.reduce((sum, line) => sum + (line.entry.linesNow.kind === 'ok' ? (line.entry.linesNow.taxCents ?? 0) : 0), 0),
    unreadable: confirmed.filter((line) => line.nowCents === null).length,
    waiting: { count: waiting.length, cents: waiting.reduce((sum, line) => sum + (line.nowCents ?? 0), 0) },
    byStatement,
    unchargedCents: cents - byStatement.reduce((sum, row) => sum + row.cents, 0),
  };

  // ── What the statement charges for other months' costs ──
  const alsoCharged: AlsoCharged[] =
    statement && !statement.legacy
      ? printedLines({ lines: [], costs: statement.costs.filter((cost) => cost.group === 'earlier'), adjustments: statement.adjustments, fee: null }).map((row) => ({
          key: row.key,
          description: row.description,
          cents: -row.amountCents,
          entryId: row.entryId,
        }))
      : [];

  return { propertyId, month, report, correcting, build, statement, held, figures, correction, income, costs, costTotals, alsoCharged };
}
