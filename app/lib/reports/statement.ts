/**
 * The statement's arithmetic, apart from React and apart from the server, so
 * the editor's live preview, the finish step and the tracker read the very
 * same numbers (dispatch 23B).
 *
 * ── Which entries a statement carries ──
 * An entry belongs to the Toronto month it was sent in, the ledger's rule
 * (sentDay). A statement for a month carries the property's approved
 * entries sent in that month; then, under "From earlier months, not
 * previously reported", approved entries sent in an earlier month, on or
 * after the property's first statement month, that no current statement
 * of the property lists; then, under "Adjustments to earlier statements",
 * every entry a current statement printed whose amount now differs from
 * what that statement last printed, or which has since left the ledger.
 * A statement being superseded is not current, so its entries come back
 * into the one replacing it. Each change is carried once: the comparison
 * is with the most recent current statement that printed the entry, in its
 * costs or its adjustments (Kian's decision 5).
 *
 * ── Money ──
 * Income − costs − fee = payable, each a sum of integer cents; negative is
 * "owed to Nubnb". Nothing is multiplied and nothing is stored here: the
 * finish step stores what it printed.
 *
 * Client-safe: model.ts, the cost model and the ledger's day functions.
 */

import { formatCents, type CostEntryView } from '@/app/lib/cleaners/model';
import { entryRef, sentDay, whatWasBoughtText } from '@/app/lib/costs/report';
import {
  currentReports,
  monthOfDay,
  monthRange,
  reportRef,
  statementMonths,
  type Fee,
  type IncomeRow,
  type MonthlyReportView,
  type PropertyManagementView,
  type StatementAdjustment,
  type StatementCost,
  type StatementDraftView,
  type Supersedes,
} from './model';

/** The statement as the writer lays it out: a draft being previewed, or a finished report. */
export interface Statement {
  propertyName: string;
  month: string;
  /** The co-owners' names; empty means "the owners of <property>". */
  owners: string[];
  /** The printed reference; null on a draft, which prints "Draft". */
  ref: string | null;
  /** When it was finished; null on a draft. */
  finishedAt: string | null;
  income: IncomeRow[];
  incomeCents: number;
  costs: StatementCost[];
  adjustments: StatementAdjustment[];
  costsCents: number;
  fee: Fee | null;
  feeCents: number;
  payableCents: number;
  pendingLeftOut: number;
  notes: string | null;
  /** When replacing an earlier statement: its ref, when it was finished, and the reason. */
  supersedes: { ref: string; finishedAt: string | null; reason: string } | null;
}

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
  draft: Pick<StatementDraftView, 'income' | 'fee' | 'notes' | 'supersedes'> | null;
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

/**
 * The most recent current statement that printed each entry, and the amount
 * it printed: a cost row's total, or an adjustment's "now".
 */
export function lastPrinted(current: MonthlyReportView[]): Map<string, { report: MonthlyReportView; cents: number }> {
  const printed = new Map<string, { report: MonthlyReportView; cents: number }>();
  const consider = (entryId: string, report: MonthlyReportView, cents: number) => {
    const was = printed.get(entryId);
    if (!was || report.finishedAt > was.report.finishedAt) printed.set(entryId, { report, cents });
  };
  for (const report of current) {
    for (const cost of report.costs) consider(cost.entryId, report, cost.totalCents);
    for (const adjustment of report.adjustments) consider(adjustment.entryId, report, adjustment.nowCents);
  }
  return printed;
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
  const adjustments: StatementAdjustment[] = [];
  for (const [entryId, { report, cents }] of lastPrinted(current)) {
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
      adjustments.push({ entryId, statementId: report.id, printedCents: cents, nowCents, deltaCents: nowCents - cents, historyLength });
    }
  }
  adjustments.sort((a, b) => a.entryId.localeCompare(b.entryId));
  if (unreadable.length > 0) return { kind: 'unreadable', entryIds: [...new Set(unreadable)] };

  const income = draft?.income ?? [];
  const fee = draft?.fee ?? null;
  const incomeCents = income.reduce((sum, row) => sum + row.amountCents, 0);
  const costsCents = costs.reduce((sum, row) => sum + row.totalCents, 0) + adjustments.reduce((sum, row) => sum + row.deltaCents, 0);
  const feeCents = fee?.amountCents ?? 0;
  const superseded = supersedingId === null ? null : (input.reports.find((report) => report.id === supersedingId) ?? null);
  const supersedes: Statement['supersedes'] =
    draft?.supersedes && supersedingId !== null
      ? { ref: reportRef(supersedingId), finishedAt: superseded?.finishedAt ?? null, reason: draft.supersedes.reason }
      : null;

  return {
    kind: 'ok',
    statement: {
      propertyName: input.propertyName,
      month,
      owners: management?.owners.map((owner) => owner.name) ?? [],
      ref: null,
      finishedAt: null,
      income,
      incomeCents,
      costs,
      adjustments,
      costsCents,
      fee,
      feeCents,
      payableCents: incomeCents - costsCents - feeCents,
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

/** A finished report as the writer lays it out, with its printed reference and the statement it replaced. */
export function statementOf(report: MonthlyReportView, all: MonthlyReportView[]): Statement {
  const replaced = report.supersedes ? (all.find((other) => other.id === report.supersedes!.reportId) ?? null) : null;
  return {
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
    fee: report.fee,
    feeCents: report.feeCents,
    payableCents: report.payableCents,
    pendingLeftOut: report.pendingLeftOut,
    notes: report.notes,
    supersedes: report.supersedes ? { ref: reportRef(report.supersedes.reportId), finishedAt: replaced?.finishedAt ?? null, reason: report.supersedes.reason } : null,
  };
}

/** "Payable to the owners" or "Balance owed to Nubnb", with the figure as printed. */
export function closingWords(payableCents: number): { label: string; amount: string } {
  return payableCents < 0
    ? { label: 'Balance owed to Nubnb', amount: formatCents(-payableCents) }
    : { label: 'Payable to the owners', amount: formatCents(payableCents) };
}

/** "Prepared for Ann Lee and Bo Chen", or "Prepared for the owners of <property>". */
export function preparedFor(statement: Pick<Statement, 'owners' | 'propertyName'>): string {
  const names = statement.owners.map((name) => name.trim()).filter(Boolean);
  if (names.length === 0) return `Prepared for the owners of ${statement.propertyName}`;
  if (names.length === 1) return `Prepared for ${names[0]}`;
  return `Prepared for ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Whether a statement has anything in it: no income, no cost, no adjustment and no fee is "Nothing to report". */
export function nothingToReport(statement: Pick<Statement, 'income' | 'costs' | 'adjustments' | 'fee'>): boolean {
  return statement.income.length === 0 && statement.costs.length === 0 && statement.adjustments.length === 0 && (statement.fee === null || statement.fee.amountCents === 0);
}

// ─── The tracker ───────────────────────────────────────────────

export type StatementState =
  | { kind: 'outstanding' }
  | { kind: 'draft'; savedAt: string; superseding: boolean }
  | { kind: 'finished'; report: MonthlyReportSummaryLike; replaced: number };

/** The fields of a finished report the tracker needs; a full report satisfies it too. */
export interface MonthlyReportSummaryLike {
  id: string;
  propertyId: string;
  month: string;
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

export interface TrackerInputs {
  month: string;
  properties: { id: string; name: string | null }[];
  reports: MonthlyReportSummaryLike[];
  drafts: { propertyId: string; month: string; updatedAt: string; finishedAs: string | null; superseding: boolean }[];
  downloads: { reportId: string; at: string }[];
  management: PropertyManagementView[];
}

const ORDER: Record<StatementState['kind'], number> = { outstanding: 0, draft: 1, finished: 2 };

/**
 * One row per property in scope for the month — or with a statement or a
 * draft for it, whatever its scope: a statement that exists is never hidden
 * — outstanding first, then drafts, then finished.
 */
export function trackerRows(input: TrackerInputs): TrackerRow[] {
  const management = new Map(input.management.map((record) => [record.propertyId, record]));
  const current = new Set(currentReports(input.reports).map((report) => report.id));
  const rows: TrackerRow[] = [];
  for (const property of input.properties) {
    const record = management.get(property.id) ?? null;
    const { from, until } = statementMonths(record);
    const reports = input.reports
      .filter((report) => report.propertyId === property.id && report.month === input.month)
      .sort((a, b) => b.finishedAt.localeCompare(a.finishedAt) || a.id.localeCompare(b.id));
    const draft = input.drafts.find((d) => d.propertyId === property.id && d.month === input.month && d.finishedAs === null) ?? null;
    const inScope = input.month >= from && (until === null || input.month <= until);
    if (!inScope && reports.length === 0 && draft === null) continue;
    const live = reports.find((report) => current.has(report.id)) ?? null;
    let state: StatementState;
    if (live && !draft) state = { kind: 'finished', report: live, replaced: reports.length - 1 };
    else if (draft) state = { kind: 'draft', savedAt: draft.updatedAt, superseding: draft.superseding };
    else state = { kind: 'outstanding' };
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

/** The line at the top, and the tile: how many finished, outstanding, in draft. */
export function trackerCounts(rows: TrackerRow[]): { inScope: number; finished: number; outstanding: number; drafts: number } {
  return {
    inScope: rows.length,
    finished: rows.filter((row) => row.state.kind === 'finished').length,
    outstanding: rows.filter((row) => row.state.kind === 'outstanding').length,
    drafts: rows.filter((row) => row.state.kind === 'draft').length,
  };
}

/** Loose ends for a month, in words: pending entries sent in it; late approved entries; adjustments waiting. */
export interface LooseEnds {
  pending: { propertyId: string; propertyName: string; count: number }[];
  late: { propertyId: string; propertyName: string; count: number }[];
  adjustments: { propertyId: string; propertyName: string; count: number }[];
}

export function looseEnds(
  month: string,
  entries: CostEntryView[],
  reports: MonthlyReportView[],
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
