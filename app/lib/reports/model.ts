/**
 * Monthly statements (dispatch 23B): the names, limits and shapes every side
 * shares. Client-safe: no server imports.
 *
 * Four root collections and one Storage prefix, all server-only:
 *   monthly_report_drafts/{propertyId}_{YYYY-MM}  the working copy of one
 *                                     property-month, saved in place with a
 *                                     revision check, never deleted
 *   monthly_reports/{reportId}        a finished statement: created once,
 *                                     never updated; its PDF's bytes are in
 *                                     Storage with their SHA-256 here
 *   report_downloads/{autoId}         one per download link minted
 *   property_management/{propertyId}  the co-owners, the months statements
 *                                     run, the default fee
 *   monthly-reports/<reportId>.pdf    the statement's bytes, create-only
 *
 * ── Money ──
 * Integer cents throughout, as in the cost ledger. Income rows and the fee
 * are typed by an admin as dollars and cents and stored as cents through the
 * same string split; a negative income row is a refund or an adjustment; a
 * fee is never negative and is an amount, never a rate — code never
 * multiplies (Kian's decision 3 of 2026-09-30). The statement's
 * reconciliation is three sums and two subtractions, done in statement.ts.
 *
 * ── Readers ──
 * These collections are new and written only by this code, so a document is
 * read strictly: one not in the written shape is reported as unreadable,
 * never guessed at and never re-rendered.
 */

import type { Actor } from '@/app/lib/cleaners/model';

export const MONTHLY_REPORTS_COLLECTION = 'monthly_reports';
export const MONTHLY_REPORT_DRAFTS_COLLECTION = 'monthly_report_drafts';
export const REPORT_DOWNLOADS_COLLECTION = 'report_downloads';
export const PROPERTY_MANAGEMENT_COLLECTION = 'property_management';
/** Storage prefix of finished statements. Readers use the stored path and never rebuild it. */
export const MONTHLY_REPORTS_PREFIX = 'monthly-reports';

export const MONTHLY_REPORT_SCHEMA_VERSION = 1;
export const MONTHLY_REPORT_DRAFT_SCHEMA_VERSION = 1;
export const REPORT_DOWNLOAD_SCHEMA_VERSION = 1;
export const PROPERTY_MANAGEMENT_SCHEMA_VERSION = 1;

/** The first month statements are expected from, for a property with no management record (Kian's decision 4). */
export const STATEMENTS_FROM_DEFAULT = '2026-10';

/** The words an income row's source can be. Permanent; `other` so a new source never forces a new word. */
export const INCOME_SOURCES = ['airbnb', 'vrbo', 'private', 'other'] as const;
export type IncomeSource = (typeof INCOME_SOURCES)[number];
export const INCOME_SOURCE_LABELS: Record<IncomeSource, string> = {
  airbnb: 'Airbnb',
  vrbo: 'Vrbo',
  private: 'Private',
  other: 'Other',
};
export function isIncomeSource(value: unknown): value is IncomeSource {
  return typeof value === 'string' && (INCOME_SOURCES as readonly string[]).includes(value);
}

export const STATEMENT_LIMITS = {
  INCOME_ROWS_MAX: 200,
  INCOME_LABEL_MAX: 160,
  INCOME_REFERENCE_MAX: 60,
  FEE_LABEL_MAX: 120,
  NOTES_MAX: 1_000,
  REASON_MAX: 500,
  OWNERS_MAX: 10,
  OWNER_NAME_MAX: 80,
  OWNER_EMAIL_MAX: 120,
  /** Any one amount, either sign where a sign is allowed: $999,999.99. */
  AMOUNT_MAX_CENTS: 99_999_999,
  /** How long a download link works. */
  DOWNLOAD_LINK_SECONDS: 60,
  /** The page saves the draft this long after the last change. */
  SAVE_DELAY_MS: 800,
  /** The page redraws the PDF this long after the last change. */
  PREVIEW_DELAY_MS: 300,
} as const;

// ─── Months ────────────────────────────────────────────────────

const MONTH = /^(\d{4})-(\d{2})$/;
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A calendar month written yyyy-mm. */
export function isMonth(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = MONTH.exec(value);
  return !!match && Number(match[2]) >= 1 && Number(match[2]) <= 12;
}

/** The month of a yyyy-mm-dd day. */
export function monthOfDay(day: string): string {
  return day.slice(0, 7);
}

/** "September 2026". Anything that is not a month is returned as it is. */
export function monthLabel(month: string): string {
  const match = MONTH.exec(month);
  if (!match) return month;
  return `${MONTHS_LONG[Number(match[2]) - 1]} ${match[1]}`;
}

/** The first and last day of a month, yyyy-mm-dd. */
export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

/** The month `by` months after (or, negative, before) `month`. */
export function addMonths(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The last closed month before `today` (yyyy-mm-dd, Toronto): the month before today's. */
export function lastClosedMonth(today: string): string {
  return addMonths(monthOfDay(today), -1);
}

// ─── Stored shapes ─────────────────────────────────────────────

/** One income row, as typed and as frozen. */
export interface IncomeRow {
  /** A UUID the browser made, for ordering and React. */
  id: string;
  source: IncomeSource;
  /** 1–160 characters: "Airbnb payout, stay 12–15 Sep". */
  label: string;
  /** A booking code, up to 60 characters; null when none. */
  reference: string | null;
  /** The stay, yyyy-mm-dd; null when not given. */
  from: string | null;
  to: string | null;
  /** Non-zero; negative for a refund or an adjustment. */
  amountCents: number;
}

/** The management fee: a label the admin writes and an amount, never a rate. */
export interface Fee {
  label: string;
  /** Zero or more. */
  amountCents: number;
}

/** On a statement that replaces an earlier one: which, and why. On the newer document only. */
export interface Supersedes {
  reportId: string;
  reason: string;
}

/** `monthly_report_drafts/{propertyId}_{YYYY-MM}`, as stored. */
export interface StatementDraft {
  schemaVersion: number;
  propertyId: string;
  month: string;
  income: IncomeRow[];
  fee: Fee | null;
  notes: string | null;
  supersedes: Supersedes | null;
  /** 1 on creation, +1 on every save. A save must name the revision it loaded. */
  revision: number;
  createdAt: string;
  updatedAt: string;
  /** The report this draft was last finished as; null while it is a draft (or a correction in progress). */
  finishedAs: string | null;
  finishedRevision: number | null;
}

/** One cost row of a frozen statement: an approved entry as the statement printed it. */
export interface StatementCost {
  entryId: string;
  ref: string;
  /** The Toronto day it was sent. */
  day: string;
  kind: string;
  /** What was bought or the work done, as the ledger PDF prints it. */
  description: string;
  itemsCents: number;
  taxCents: number | null;
  totalCents: number;
  corrected: boolean;
  historyLength: number;
  receiptSha256: string | null;
  /** Sent in the statement's month, or an earlier month and not previously reported. */
  group: 'month' | 'earlier';
}

/** An entry an earlier statement printed that has since changed or left the ledger. */
export interface StatementAdjustment {
  entryId: string;
  /** The statement that last printed it. */
  statementId: string;
  printedCents: number;
  /** What it now adds up to; 0 when it has left the ledger. */
  nowCents: number;
  deltaCents: number;
  historyLength: number;
}

/** `monthly_reports/{reportId}`, as stored: created once, never updated. */
export interface MonthlyReport {
  schemaVersion: number;
  propertyId: string;
  propertyNameAtFinish: string;
  month: string;
  ownersAtFinish: { name: string }[];
  income: IncomeRow[];
  incomeCents: number;
  costs: StatementCost[];
  adjustments: StatementAdjustment[];
  costsCents: number;
  fee: Fee | null;
  feeCents: number;
  /** Income − costs − fee. Negative is owed to Nubnb. */
  payableCents: number;
  pendingLeftOut: number;
  notes: string | null;
  /** Every entry in `costs`: what later statements treat as already reported. */
  entryIds: string[];
  finishedAt: string;
  actor: Actor;
  supersedes: Supersedes | null;
  draftRevision: number;
  pdf: { path: string; bytes: number; sha256: string };
}

/** `report_downloads/{autoId}`: one download link minted. */
export interface ReportDownload {
  schemaVersion: number;
  reportId: string;
  propertyId: string;
  month: string;
  at: string;
  actor: Actor;
}

export interface Owner {
  name: string;
  email: string | null;
}

/** `property_management/{propertyId}`, set whole on save. */
export interface PropertyManagement {
  schemaVersion: number;
  propertyId: string;
  owners: Owner[];
  /** The first month a statement is expected, yyyy-mm. */
  statementsFrom: string;
  /** The last month, when the property has left management; null while it has not. */
  statementsUntil: string | null;
  defaultFee: Fee | null;
  setAt: string;
}

// ─── Views ─────────────────────────────────────────────────────
// What the API returns: the stored document with its ID, read strictly.

export interface StatementDraftView extends StatementDraft {
  id: string;
}
export interface MonthlyReportView extends MonthlyReport {
  id: string;
}
export interface ReportDownloadView extends ReportDownload {
  id: string;
}
export interface PropertyManagementView extends PropertyManagement {
  id: string;
}

/** A finished report's summary, for the tracker: the detail arrays left out. */
export type MonthlyReportSummary = Omit<MonthlyReportView, 'income' | 'costs' | 'adjustments' | 'notes'> & {
  /** How many of each the detail holds. */
  incomeRows: number;
  costRows: number;
  adjustmentRows: number;
};

/** A draft's summary, for the tracker. */
export interface StatementDraftSummary {
  id: string;
  propertyId: string;
  month: string;
  revision: number;
  updatedAt: string;
  finishedAs: string | null;
  superseding: boolean;
}

// ─── Reading strictly ──────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isCents = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);
const isText = (value: unknown): value is string => typeof value === 'string';
const isTextOrNull = (value: unknown): value is string | null => value === null || typeof value === 'string';
const isDayText = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
const isActor = (value: unknown): value is Actor => isRecord(value) && isText(value.role) && isTextOrNull(value.id) && isTextOrNull(value.name);

export function readIncomeRow(value: unknown): IncomeRow | null {
  if (!isRecord(value)) return null;
  const { id, source, label, reference, from, to, amountCents } = value;
  if (!isText(id) || !isIncomeSource(source) || !isText(label) || !isTextOrNull(reference) || !isCents(amountCents)) return null;
  if (!(from === null || isDayText(from)) || !(to === null || isDayText(to))) return null;
  return { id, source, label, reference, from, to, amountCents };
}

export function readFee(value: unknown): Fee | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !isText(value.label) || !isCents(value.amountCents)) return undefined;
  return { label: value.label, amountCents: value.amountCents };
}

function readSupersedes(value: unknown): Supersedes | null | undefined {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || !isText(value.reportId) || !isText(value.reason)) return undefined;
  return { reportId: value.reportId, reason: value.reason };
}

function readRows<T>(value: unknown, read: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const rows: T[] = [];
  for (const item of value) {
    const row = read(item);
    if (row === null) return null;
    rows.push(row);
  }
  return rows;
}

/** A draft in the written shape, or null. */
export function readStatementDraft(id: string, fields: Record<string, unknown>): StatementDraftView | null {
  const { propertyId, month, income, notes, revision, createdAt, updatedAt, finishedAs, finishedRevision, schemaVersion } = fields;
  const fee = readFee(fields.fee);
  const supersedes = readSupersedes(fields.supersedes);
  const rows = readRows(income, readIncomeRow);
  if (!isText(propertyId) || !isMonth(month) || rows === null || fee === undefined || supersedes === undefined) return null;
  if (!isTextOrNull(notes ?? null) || !isCents(revision) || !isText(createdAt) || !isText(updatedAt)) return null;
  if (!isTextOrNull(finishedAs ?? null) || !(finishedRevision === null || finishedRevision === undefined || isCents(finishedRevision))) return null;
  return {
    id,
    schemaVersion: isCents(schemaVersion) ? schemaVersion : 0,
    propertyId,
    month,
    income: rows,
    fee,
    notes: (notes as string | null | undefined) ?? null,
    supersedes,
    revision,
    createdAt,
    updatedAt,
    finishedAs: (finishedAs as string | null | undefined) ?? null,
    finishedRevision: (finishedRevision as number | null | undefined) ?? null,
  };
}

function readCost(value: unknown): StatementCost | null {
  if (!isRecord(value)) return null;
  const { entryId, ref, day, kind, description, itemsCents, taxCents, totalCents, corrected, historyLength, receiptSha256, group } = value;
  if (!isText(entryId) || !isText(ref) || !isDayText(day) || !isText(kind) || !isText(description)) return null;
  if (!isCents(itemsCents) || !(taxCents === null || isCents(taxCents)) || !isCents(totalCents) || typeof corrected !== 'boolean') return null;
  if (!isCents(historyLength) || !isTextOrNull(receiptSha256) || (group !== 'month' && group !== 'earlier')) return null;
  return { entryId, ref, day, kind, description, itemsCents, taxCents, totalCents, corrected, historyLength, receiptSha256, group };
}

function readAdjustment(value: unknown): StatementAdjustment | null {
  if (!isRecord(value)) return null;
  const { entryId, statementId, printedCents, nowCents, deltaCents, historyLength } = value;
  if (!isText(entryId) || !isText(statementId) || !isCents(printedCents) || !isCents(nowCents) || !isCents(deltaCents) || !isCents(historyLength)) return null;
  return { entryId, statementId, printedCents, nowCents, deltaCents, historyLength };
}

/** A finished report in the written shape, or null: such a report is never re-rendered or added up. */
export function readMonthlyReport(id: string, fields: Record<string, unknown>): MonthlyReportView | null {
  const { propertyId, propertyNameAtFinish, month, ownersAtFinish, incomeCents, costsCents, feeCents, payableCents, pendingLeftOut, notes, entryIds, finishedAt, actor, draftRevision, pdf, schemaVersion } = fields;
  const income = readRows(fields.income, readIncomeRow);
  const costs = readRows(fields.costs, readCost);
  const adjustments = readRows(fields.adjustments, readAdjustment);
  const owners = readRows(ownersAtFinish, (o) => (isRecord(o) && isText(o.name) ? { name: o.name } : null));
  const fee = readFee(fields.fee);
  const supersedes = readSupersedes(fields.supersedes);
  if (!isText(propertyId) || !isText(propertyNameAtFinish) || !isMonth(month) || owners === null) return null;
  if (income === null || costs === null || adjustments === null || fee === undefined || supersedes === undefined) return null;
  if (!isCents(incomeCents) || !isCents(costsCents) || !isCents(feeCents) || !isCents(payableCents) || !isCents(pendingLeftOut)) return null;
  if (!isTextOrNull(notes ?? null) || !Array.isArray(entryIds) || !entryIds.every(isText) || !isText(finishedAt) || !isActor(actor) || !isCents(draftRevision)) return null;
  if (!isRecord(pdf) || !isText(pdf.path) || !isCents(pdf.bytes) || !isText(pdf.sha256)) return null;
  return {
    id,
    schemaVersion: isCents(schemaVersion) ? schemaVersion : 0,
    propertyId,
    propertyNameAtFinish,
    month,
    ownersAtFinish: owners,
    income,
    incomeCents,
    costs,
    adjustments,
    costsCents,
    fee,
    feeCents,
    payableCents,
    pendingLeftOut,
    notes: (notes as string | null | undefined) ?? null,
    entryIds: entryIds as string[],
    finishedAt,
    actor,
    supersedes,
    draftRevision,
    pdf: { path: pdf.path, bytes: pdf.bytes, sha256: pdf.sha256 },
  };
}

export function readReportDownload(id: string, fields: Record<string, unknown>): ReportDownloadView | null {
  const { reportId, propertyId, month, at, actor, schemaVersion } = fields;
  if (!isText(reportId) || !isText(propertyId) || !isMonth(month) || !isText(at) || !isActor(actor)) return null;
  return { id, schemaVersion: isCents(schemaVersion) ? schemaVersion : 0, reportId, propertyId, month, at, actor };
}

export function readPropertyManagement(id: string, fields: Record<string, unknown>): PropertyManagementView | null {
  const { propertyId, statementsFrom, statementsUntil, setAt, schemaVersion } = fields;
  const owners = readRows(fields.owners, (o) => (isRecord(o) && isText(o.name) && isTextOrNull(o.email ?? null) ? { name: o.name, email: (o.email as string | null | undefined) ?? null } : null));
  const defaultFee = readFee(fields.defaultFee ?? null);
  if (!isText(propertyId) || owners === null || !isMonth(statementsFrom) || !(statementsUntil === null || statementsUntil === undefined || isMonth(statementsUntil))) return null;
  if (defaultFee === undefined || !isText(setAt)) return null;
  return {
    id,
    schemaVersion: isCents(schemaVersion) ? schemaVersion : 0,
    propertyId,
    owners,
    statementsFrom,
    statementsUntil: (statementsUntil as string | null | undefined) ?? null,
    defaultFee,
    setAt,
  };
}

/** The months a property's statements run, from its record or the default. */
export function statementMonths(management: PropertyManagementView | null): { from: string; until: string | null } {
  return { from: management?.statementsFrom ?? STATEMENTS_FROM_DEFAULT, until: management?.statementsUntil ?? null };
}

/** Whether a property expects a statement for `month`. */
export function inStatementScope(management: PropertyManagementView | null, month: string): boolean {
  const { from, until } = statementMonths(management);
  return month >= from && (until === null || month <= until);
}

/** The report's reference as printed: the first six characters of its ID, as an entry's ref. */
export function reportRef(id: string): string {
  return id.slice(0, 6);
}

/** The reports that are current: not named by any newer report's `supersedes`. */
export function currentReports<T extends { id: string; supersedes: Supersedes | null }>(reports: T[]): T[] {
  const replaced = new Set(reports.map((report) => report.supersedes?.reportId).filter((id): id is string => id !== undefined && id !== null));
  return reports.filter((report) => !replaced.has(report.id));
}

/** Which newer report replaced this one, if any. */
export function replacedBy<T extends { id: string; supersedes: Supersedes | null }>(report: { id: string }, reports: T[]): T | null {
  return reports.find((other) => other.supersedes?.reportId === report.id) ?? null;
}
