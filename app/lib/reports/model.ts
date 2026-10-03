/**
 * Monthly statements — the Payment Summary (dispatch 23E, over 23B and 23D):
 * the names, limits and shapes every side shares. Client-safe: no server
 * imports.
 *
 * Four root collections and one Storage prefix, all server-only:
 *   monthly_report_drafts/{propertyId}_{YYYY-MM}  the working copy of one
 *                                     property-month, saved in place with a
 *                                     revision check, never deleted
 *   monthly_reports/{reportId}        a finished statement: created once,
 *                                     never updated; its PDF's bytes are in
 *                                     Storage with their SHA-256 here
 *   report_downloads/{autoId}         one per download link minted
 *   property_management/{propertyId}  "Report For", the owners, the months
 *                                     statements run, the default fee rate
 *   monthly-reports/<reportId>.pdf    the statement's bytes, create-only
 *
 * ── Money ──
 * Integer cents throughout, as in the cost ledger. A line is a description,
 * a quantity, a rate and an amount, and the code multiplies quantity by rate
 * (Kian's ruling of 2026-10-01: the one place code computes money); an
 * amount may be negative — expenses and the fee are negative lines. The fee
 * is a rate the admin picks, applied to a base prefilled from the revenue
 * lines; the admin may overwrite the amount, and the rate, the amount and
 * whether it was overwritten are stored. The carried balance is a typed
 * amount, never written automatically. The reconciliation is in statement.ts.
 *
 * ── Versions ──
 * Schema version 3 (dispatch 23E) writes `lines`, a `reference`, a
 * `reportDate`, the fee with its rate, and the carried balance; a report of
 * version 3 freezes "Report For" as printed. Versions 1 and 2 (dispatches
 * 23B and 23D) wrote `income` rows and a fee that was an amount. Every
 * version written so far is read; nothing is backfilled. A report of version
 * 1 or 2 is `legacy` and is drawn by the writer that drew it.
 *
 * ── Readers ──
 * These collections are written only by this code, so a document is read
 * strictly: one not in a written shape is reported as unreadable, never
 * guessed at and never re-rendered.
 */

import type { Actor } from '@/app/lib/cleaners/model';

export const MONTHLY_REPORTS_COLLECTION = 'monthly_reports';
export const MONTHLY_REPORT_DRAFTS_COLLECTION = 'monthly_report_drafts';
export const REPORT_DOWNLOADS_COLLECTION = 'report_downloads';
export const PROPERTY_MANAGEMENT_COLLECTION = 'property_management';
/** Storage prefix of finished statements. Readers use the stored path and never rebuild it. */
export const MONTHLY_REPORTS_PREFIX = 'monthly-reports';

/** 3 (dispatch 23E): lines with a quantity and a rate, the fee with its rate, the carried balance, the reference and date, "Report For" frozen. */
export const MONTHLY_REPORT_SCHEMA_VERSION = 3;
export const MONTHLY_REPORT_DRAFT_SCHEMA_VERSION = 3;
/** 2 (dispatch 24): `via` may be present — 'month-package' when the statement went out in a month's ZIP. */
export const REPORT_DOWNLOAD_SCHEMA_VERSION = 2;
/** One record per month ZIP an admin downloaded (dispatch 24). */
export const MONTH_DOWNLOADS_COLLECTION = 'month_downloads';
export const MONTH_DOWNLOAD_SCHEMA_VERSION = 1;
/** 2 (dispatch 23E): `reportFor` and `defaultFeeRateBasisPoints` may be present. 3 (dispatch 24): `excludedFromReporting` may be present. */
export const PROPERTY_MANAGEMENT_SCHEMA_VERSION = 3;

/**
 * The first month any property owes a statement for. Kian's ruling of
 * 2026-10-02: every property owes a statement for every closed month by
 * default; a record's start month excludes earlier ones and its end month
 * later ones. Nubnb's statements begin with September 2026, the first month
 * of its costs; with no first month at all, every month before would read
 * past due. (Decision 4 had October 2026.) Since 2026-10-03 a property added
 * later owes from the month it was added (`statementMonths`).
 */
export const STATEMENTS_FROM_DEFAULT = '2026-09';

/**
 * The words an income row's `source` could be, on rows written before
 * dispatch 23D. Permanent, for reading those rows; a line written now has no
 * source, and names the platform in its description if the admin wants it named.
 */
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
  LINES_MAX: 200,
  LINE_DESCRIPTION_MAX: 160,
  /** A line's quantity: a whole number, 1 to this. */
  QUANTITY_MAX: 9_999,
  /** Kept for reading rows written before dispatch 23D. */
  INCOME_ROWS_MAX: 200,
  INCOME_LABEL_MAX: 160,
  INCOME_REFERENCE_MAX: 60,
  FEE_LABEL_MAX: 120,
  CARRIED_LABEL_MAX: 120,
  REFERENCE_MAX: 60,
  REPORT_FOR_NAME_MAX: 120,
  REPORT_FOR_ADDRESS_MAX: 300,
  REPORT_FOR_ADDRESS_LINES_MAX: 6,
  NOTES_MAX: 1_000,
  REASON_MAX: 500,
  OWNERS_MAX: 10,
  OWNER_NAME_MAX: 80,
  OWNER_EMAIL_MAX: 120,
  /** Any one amount or rate, either sign where a sign is allowed: $999,999.99. */
  AMOUNT_MAX_CENTS: 99_999_999,
  /** A line's amount, quantity × rate, at most this. */
  LINE_AMOUNT_MAX_CENTS: 999_999_999,
  /** How long a download link works. */
  DOWNLOAD_LINK_SECONDS: 60,
  /** The page saves the draft this long after the last change. */
  SAVE_DELAY_MS: 800,
  /** The page redraws the PDF this long after the last change. */
  PREVIEW_DELAY_MS: 300,
} as const;

// ─── Months and days ───────────────────────────────────────────

const MONTH = /^(\d{4})-(\d{2})$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** The three-letter months the reports NuBNB sends print in dates and ranges: "Sep 1, 2026", "Aug 29–Sep 3, 2026". */
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** The month words the reports' references use: "Aug-321-John", "July-19-Tannery", "June-321-John". */
const MONTHS_REFERENCE = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'June', 'July', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];

/** A calendar month written yyyy-mm. */
export function isMonth(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = MONTH.exec(value);
  return !!match && Number(match[2]) >= 1 && Number(match[2]) <= 12;
}

/** A calendar day written yyyy-mm-dd that exists. */
export function isDayText(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = DAY.exec(value);
  if (!match) return false;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
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

/** "September": the month alone, for a place where the year goes without saying (the property list's column, Kian 2026-10-02). */
export function monthName(month: string): string {
  const match = MONTH.exec(month);
  if (!match) return month;
  return MONTHS_LONG[Number(match[2]) - 1];
}

/** The word a reference uses for a month: "Aug", "July", "June", "Sept". */
export function monthReferenceWord(month: string): string {
  const match = MONTH.exec(month);
  if (!match) return month;
  return MONTHS_REFERENCE[Number(match[2]) - 1];
}

/** "Sep 1, 2026", as the reports print the date. The text itself if it is not a day. */
export function dateText(day: string): string {
  const match = DAY.exec(day);
  if (!match) return day;
  return `${MONTHS_SHORT[Number(match[2]) - 1]} ${Number(match[3])}, ${match[1]}`;
}

/**
 * A line's date range as the reports print it: "Aug 9–13, 2026" within a
 * month, "Aug 29–Sep 3, 2026" across months, "Dec 30, 2026–Jan 2, 2027"
 * across years, "Aug 9, 2026" for one day; one end alone prints as a day.
 */
export function rangeText(from: string | null, to: string | null): string {
  if (from && to && DAY.test(from) && DAY.test(to)) {
    if (from === to) return dateText(from);
    const [fy, fm, fd] = from.split('-').map(Number);
    const [ty, tm, td] = to.split('-').map(Number);
    if (fy === ty && fm === tm) return `${MONTHS_SHORT[fm - 1]} ${fd}–${td}, ${fy}`;
    if (fy === ty) return `${MONTHS_SHORT[fm - 1]} ${fd}–${MONTHS_SHORT[tm - 1]} ${td}, ${fy}`;
    return `${dateText(from)}–${dateText(to)}`;
  }
  const one = from ?? to;
  return one ? dateText(one) : '';
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

/**
 * Whether `month` has ended by `today` (Toronto). A closed month with no
 * finished statement is outstanding; the current month is "open, not yet
 * due" and never outstanding (Kian's ruling of 2026-09-30, dispatch 23D). A
 * statement may still be finished for an open month.
 */
export function isClosedMonth(month: string, today: string): boolean {
  return month < monthOfDay(today);
}

/** Every month from `from` to `to`, both included, oldest first; empty when `to` is before `from`. */
export function monthsBetween(from: string, to: string): string[] {
  const months: string[] = [];
  for (let month = from; month <= to && months.length < 1_200; month = addMonths(month, 1)) months.push(month);
  return months;
}

// ─── Money the code computes ───────────────────────────────────

/** A line's amount: quantity × rate, in cents (Kian's ruling of 2026-10-01). */
export function lineAmount(quantity: number, rateCents: number): number {
  return quantity * rateCents;
}

/** The fee the rate gives on the base, rounded half up to the cent; null without a rate. */
export function feeComputed(baseCents: number | null, rateBasisPoints: number | null): number | null {
  if (rateBasisPoints === null || baseCents === null) return null;
  return Math.round((baseCents * rateBasisPoints) / 10_000);
}

/** "20%" or "12.5%", for a label or a field. */
export function rateText(rateBasisPoints: number): string {
  const whole = Math.floor(rateBasisPoints / 100);
  const rest = rateBasisPoints % 100;
  return rest === 0 ? `${whole}%` : `${whole}.${String(rest).padStart(2, '0').replace(/0$/, '')}%`;
}

// ─── Stored shapes ─────────────────────────────────────────────

/**
 * One income row as dispatches 23B and 23D stored it: a description and an
 * amount, with four optional fields on rows written before 23D. Read, never
 * written now; a draft that holds them is saved as lines.
 */
export interface IncomeRow {
  id: string;
  label: string;
  /** Non-zero; negative for a refund or an adjustment. */
  amountCents: number;
  source?: IncomeSource;
  reference?: string | null;
  from?: string | null;
  to?: string | null;
}

/** Whether a row carries any of the fields rows had before dispatch 23D. */
export function incomeRowHasDetails(row: IncomeRow): boolean {
  return row.source !== undefined || (row.reference ?? null) !== null || (row.from ?? null) !== null || (row.to ?? null) !== null;
}

/**
 * One line, typed on a draft and frozen on a report (dispatch 23E): a
 * description, a date range when it has one, a quantity, a rate and the
 * amount the code computed from the two. A line loaded from an income row
 * written before keeps the row's `source` and `reference` exactly when the
 * row had them; a line written now has neither.
 */
export interface Line {
  /** A UUID the browser made, for ordering and React. */
  id: string;
  /** 1–160 characters: "Revenue", "Expense - Cleaning". */
  description: string;
  /** The stay or the period, yyyy-mm-dd, printed after the description as "Aug 9–13, 2026". */
  from: string | null;
  to: string | null;
  /** A whole number, 1–9,999: the "Transaction" column. */
  quantity: number;
  /** Non-zero, either sign: negative for an expense. */
  rateCents: number;
  /** quantity × rateCents, as printed. */
  amountCents: number;
  /** On a line loaded from a row written before dispatch 23D: where the money came from. */
  source?: IncomeSource;
  /** On a line loaded from a row written before dispatch 23D: a booking code, or null. */
  reference?: string | null;
}

/** Whether a line carries what a row written before dispatch 23D carried, so the editor shows it. */
export function lineHasDetails(line: Line): boolean {
  return line.source !== undefined || (line.reference ?? null) !== null;
}

/** A row written before, as a line: quantity 1, the rate its amount, its stay the range. */
export function lineFromIncomeRow(row: IncomeRow): Line {
  const line: Line = { id: row.id, description: row.label, from: row.from ?? null, to: row.to ?? null, quantity: 1, rateCents: row.amountCents, amountCents: row.amountCents };
  if (row.source !== undefined) line.source = row.source;
  if ('reference' in row) line.reference = row.reference ?? null;
  return line;
}

/**
 * The management fee (dispatch 23E): a rate the admin picks, the base the
 * rate is applied to (prefilled from the revenue lines, editable), what the
 * code computed, the amount printed, and whether the admin overwrote it. A
 * fee stored before, an amount with a label, reads as rate null, base 0,
 * computed null, overwritten true.
 */
export interface Fee {
  /** The admin's words: "NuBNB 20% Net of $9,539.78". */
  label: string;
  /** 2000 for 20 %; null when the amount was typed with no rate. */
  rateBasisPoints: number | null;
  /**
   * What the rate is applied to, zero or more, as the admin typed it. Null
   * until it is typed: the base has no default (Kian's ruling, dispatch 26),
   * and a statement with a rate and no base cannot be finished. A fee with
   * no rate may keep it null.
   */
  baseCents: number | null;
  /** round(base × rate / 10,000); null without a rate or without a base. */
  computedCents: number | null;
  /** Zero or more: printed as a negative line. */
  amountCents: number;
  /** Whether amountCents differs from computedCents. */
  overwritten: boolean;
}

/** The carried balance (dispatch 23E): deducted from the total; "Balance From June: $359.96" is 35996. */
export interface Carried {
  label: string;
  /** Either sign: positive is a balance the owner carried over, deducted from the total. */
  amountCents: number;
  /** The previous month's statement the suggestion came from; null when typed by hand. */
  fromReportId: string | null;
}

/** "Report For": the name and postal address a statement prints. */
export interface ReportFor {
  name: string;
  /** Line breaks kept; may be empty. */
  address: string;
}

/** On a statement that replaces an earlier one: which, and why. On the newer document only. */
export interface Supersedes {
  reportId: string;
  reason: string;
}

/** `monthly_report_drafts/{propertyId}_{YYYY-MM}`, as written now (version 3). */
export interface StatementDraft {
  schemaVersion: number;
  propertyId: string;
  month: string;
  /** "Aug-321-John"; may be empty while drafting, never at finish. */
  reference: string;
  /** The date the report prints, yyyy-mm-dd. */
  reportDate: string;
  lines: Line[];
  fee: Fee | null;
  carried: Carried | null;
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
  /** As printed: the entry's reference and the day it was sent (Kian, 2026-10-02); on a report finished before, what was bought. */
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
  /** What the entry is, for its line; absent on adjustments written before dispatch 23E. */
  description?: string | null;
  /** The month of the statement that printed it; absent on adjustments written before dispatch 23E. */
  printedMonth?: string | null;
}

/** `monthly_reports/{reportId}`, as written now (version 3): created once, never updated. */
export interface MonthlyReport {
  schemaVersion: number;
  propertyId: string;
  propertyNameAtFinish: string;
  month: string;
  reference: string;
  reportDate: string;
  reportFor: ReportFor | null;
  lines: Line[];
  costs: StatementCost[];
  adjustments: StatementAdjustment[];
  fee: Fee | null;
  carried: Carried | null;
  /** The revenue: the lines with a positive amount. */
  incomeCents: number;
  /** The typed expenses: the lines with a negative amount, negated. */
  expensesCents: number;
  /** The recorded cost rows plus the adjustments' differences; can be negative. */
  recordedCents: number;
  /** expensesCents + recordedCents. */
  costsCents: number;
  feeCents: number;
  /** incomeCents − costsCents − feeCents: the printed Total. */
  totalCents: number;
  carriedCents: number;
  /** totalCents − carriedCents: "Your Revenue Share". Negative is owed to NuBNB. */
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
  /** How it went out, when not as its own PDF link (dispatch 24): 'month-package' for a month's ZIP. */
  via?: string;
}

export interface Owner {
  name: string;
  email: string | null;
}

/** `property_management/{propertyId}`, set whole from the property form; `reportFor` also set alone from the editor. */
export interface PropertyManagement {
  schemaVersion: number;
  propertyId: string;
  /** The name and address a statement prints; null omits the block (dispatch 23E). */
  reportFor: ReportFor | null;
  owners: Owner[];
  /** The first month a statement is expected, yyyy-mm. */
  statementsFrom: string;
  /** The last month, when the property has left management; null while it has not. */
  statementsUntil: string | null;
  /** The rate a new statement's fee starts from (dispatch 23E); null for none. */
  defaultFeeRateBasisPoints: number | null;
  /** The default fee of dispatch 23B, an amount; read and kept, no longer used. */
  defaultFee: { label: string; amountCents: number } | null;
  /**
   * Excluded from reporting (Kian's ruling of 2026-10-03, dispatch 24): the
   * property owes no statements. Written only as `true`, and absent
   * otherwise, so a record that never set it keeps its shape.
   */
  excludedFromReporting?: boolean;
  setAt: string;
}

// ─── Views ─────────────────────────────────────────────────────
// What the API returns: the stored document with its ID, read strictly, in
// one shape whatever its version.

export interface StatementDraftView extends StatementDraft {
  id: string;
}

/**
 * A finished report of any version. `legacy` says it was written before
 * dispatch 23E: `income` holds its rows and `ownersAtFinish` its owners, and
 * its statement is drawn by the writer of that time; `lines` is empty and
 * `reference`, `reportDate`, `reportFor`, `carried` are null. A report of
 * version 3 has `lines` and the rest, and `income` empty.
 */
export interface MonthlyReportView extends MonthlyReport {
  id: string;
  legacy: boolean;
  income: IncomeRow[];
  ownersAtFinish: { name: string }[];
}
export interface ReportDownloadView extends ReportDownload {
  id: string;
}
export interface PropertyManagementView extends PropertyManagement {
  id: string;
}

/** A finished report's summary, for the tracker: the detail arrays left out. */
export type MonthlyReportSummary = Omit<MonthlyReportView, 'income' | 'lines' | 'costs' | 'adjustments' | 'notes'> & {
  /** How many of each the detail holds. */
  lineRows: number;
  costRows: number;
  adjustmentRows: number;
  /** What the report printed for each entry (a cost row's total, an adjustment's "now"), so the loose ends can compare without the rows (dispatch 23D). */
  printed: { entryId: string; cents: number }[];
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
const isDayOrNull = (value: unknown): value is string | null => value === null || isDayText(value);
const isActor = (value: unknown): value is Actor => isRecord(value) && isText(value.role) && isTextOrNull(value.id) && isTextOrNull(value.name);

/**
 * A row in either shape dispatches 23B and 23D wrote: `{ id, label,
 * amountCents }`, or with `source`, `reference`, `from` and `to`. Each of the
 * four is kept exactly when it is present in the stored object; one in a
 * form it never had makes the row not a row.
 */
export function readIncomeRow(value: unknown): IncomeRow | null {
  if (!isRecord(value)) return null;
  const { id, label, amountCents } = value;
  if (!isText(id) || !isText(label) || !isCents(amountCents)) return null;
  const row: IncomeRow = { id, label, amountCents };
  if ('source' in value) {
    if (!isIncomeSource(value.source)) return null;
    row.source = value.source;
  }
  if ('reference' in value) {
    if (!isTextOrNull(value.reference)) return null;
    row.reference = value.reference;
  }
  if ('from' in value) {
    if (!(value.from === null || /^\d{4}-\d{2}-\d{2}$/.test(String(value.from)))) return null;
    row.from = value.from as string | null;
  }
  if ('to' in value) {
    if (!(value.to === null || /^\d{4}-\d{2}-\d{2}$/.test(String(value.to)))) return null;
    row.to = value.to as string | null;
  }
  return row;
}

/** A line as written (version 3): its amount must be its quantity times its rate. */
export function readLine(value: unknown): Line | null {
  if (!isRecord(value)) return null;
  const { id, description, from, to, quantity, rateCents, amountCents } = value;
  if (!isText(id) || !isText(description) || !isDayOrNull(from ?? null) || !isDayOrNull(to ?? null)) return null;
  if (!isCents(quantity) || !isCents(rateCents) || !isCents(amountCents) || lineAmount(quantity, rateCents) !== amountCents) return null;
  const line: Line = { id, description, from: (from as string | null | undefined) ?? null, to: (to as string | null | undefined) ?? null, quantity, rateCents, amountCents };
  if ('source' in value) {
    if (!isIncomeSource(value.source)) return null;
    line.source = value.source;
  }
  if ('reference' in value) {
    if (!isTextOrNull(value.reference)) return null;
    line.reference = value.reference;
  }
  return line;
}

/** A fee in either written shape: the version-3 one with its rate, or the earlier amount with a label. undefined when it is neither. */
export function readFee(value: unknown): Fee | null | undefined {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || !isText(value.label) || !isCents(value.amountCents)) return undefined;
  if (!('rateBasisPoints' in value)) return { label: value.label, rateBasisPoints: null, baseCents: 0, computedCents: null, amountCents: value.amountCents, overwritten: true };
  const { rateBasisPoints, baseCents, computedCents, amountCents, overwritten } = value;
  if (!(rateBasisPoints === null || isCents(rateBasisPoints)) || !(baseCents === null || isCents(baseCents)) || !(computedCents === null || isCents(computedCents)) || typeof overwritten !== 'boolean') return undefined;
  return { label: value.label, rateBasisPoints: rateBasisPoints as number | null, baseCents: baseCents as number | null, computedCents: computedCents as number | null, amountCents, overwritten };
}

export function readCarried(value: unknown): Carried | null | undefined {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || !isText(value.label) || !isCents(value.amountCents) || !isTextOrNull(value.fromReportId ?? null)) return undefined;
  return { label: value.label, amountCents: value.amountCents, fromReportId: (value.fromReportId as string | null | undefined) ?? null };
}

export function readReportFor(value: unknown): ReportFor | null | undefined {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || !isText(value.name) || !isText(value.address)) return undefined;
  return { name: value.name, address: value.address };
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

/**
 * A draft of any version written so far, or null. A draft of version 1 or 2
 * gives its `income` rows as lines (quantity 1, the rate its amount), an
 * empty reference and today's date is not assumed: `reportDate` is '' and
 * the page fills it.
 */
export function readStatementDraft(id: string, fields: Record<string, unknown>): StatementDraftView | null {
  const { propertyId, month, notes, revision, createdAt, updatedAt, finishedAs, finishedRevision, schemaVersion, reference, reportDate } = fields;
  const fee = readFee(fields.fee);
  const carried = readCarried(fields.carried);
  const supersedes = readSupersedes(fields.supersedes);
  const version = isCents(schemaVersion) ? schemaVersion : 0;
  const lines = version >= 3 ? readRows(fields.lines, readLine) : readRows(fields.income, readIncomeRow)?.map(lineFromIncomeRow) ?? null;
  if (!isText(propertyId) || !isMonth(month) || lines === null || fee === undefined || carried === undefined || supersedes === undefined) return null;
  if (!isTextOrNull(notes ?? null) || !isCents(revision) || !isText(createdAt) || !isText(updatedAt)) return null;
  if (!isTextOrNull(finishedAs ?? null) || !(finishedRevision === null || finishedRevision === undefined || isCents(finishedRevision))) return null;
  if (version >= 3 && (!isText(reference) || !isDayText(reportDate))) return null;
  return {
    id,
    schemaVersion: version,
    propertyId,
    month,
    reference: version >= 3 ? (reference as string) : '',
    reportDate: version >= 3 ? (reportDate as string) : '',
    lines,
    fee,
    carried,
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
  const row: StatementAdjustment = { entryId, statementId, printedCents, nowCents, deltaCents, historyLength };
  if ('description' in value) {
    if (!isTextOrNull(value.description)) return null;
    row.description = value.description;
  }
  if ('printedMonth' in value) {
    if (!(value.printedMonth === null || isMonth(value.printedMonth))) return null;
    row.printedMonth = value.printedMonth as string | null;
  }
  return row;
}

/**
 * A finished report of any version written so far, or null: such a report
 * is never re-rendered or added up. A report of version 1 or 2 is `legacy`.
 */
export function readMonthlyReport(id: string, fields: Record<string, unknown>): MonthlyReportView | null {
  const { propertyId, propertyNameAtFinish, month, incomeCents, costsCents, feeCents, payableCents, pendingLeftOut, notes, entryIds, finishedAt, actor, draftRevision, pdf, schemaVersion } = fields;
  const version = isCents(schemaVersion) ? schemaVersion : 0;
  const legacy = version < 3;
  const costs = readRows(fields.costs, readCost);
  const adjustments = readRows(fields.adjustments, readAdjustment);
  const fee = readFee(fields.fee);
  const supersedes = readSupersedes(fields.supersedes);
  if (!isText(propertyId) || !isText(propertyNameAtFinish) || !isMonth(month)) return null;
  if (costs === null || adjustments === null || fee === undefined || supersedes === undefined) return null;
  if (!isCents(incomeCents) || !isCents(costsCents) || !isCents(feeCents) || !isCents(payableCents) || !isCents(pendingLeftOut)) return null;
  if (!isTextOrNull(notes ?? null) || !Array.isArray(entryIds) || !entryIds.every(isText) || !isText(finishedAt) || !isActor(actor) || !isCents(draftRevision)) return null;
  if (!isRecord(pdf) || !isText(pdf.path) || !isCents(pdf.bytes) || !isText(pdf.sha256)) return null;

  const base = {
    id,
    schemaVersion: version,
    legacy,
    propertyId,
    propertyNameAtFinish,
    month,
    costs,
    adjustments,
    fee,
    incomeCents,
    costsCents,
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

  if (legacy) {
    const income = readRows(fields.income, readIncomeRow);
    const owners = readRows(fields.ownersAtFinish, (o) => (isRecord(o) && isText(o.name) ? { name: o.name } : null));
    if (income === null || owners === null) return null;
    return {
      ...base,
      income,
      ownersAtFinish: owners,
      reference: '',
      reportDate: '',
      reportFor: null,
      lines: [],
      carried: null,
      expensesCents: 0,
      recordedCents: costsCents,
      totalCents: payableCents,
      carriedCents: 0,
    };
  }

  const { reference, reportDate, expensesCents, recordedCents, totalCents, carriedCents } = fields;
  const lines = readRows(fields.lines, readLine);
  const reportFor = readReportFor(fields.reportFor);
  const carried = readCarried(fields.carried);
  if (lines === null || reportFor === undefined || carried === undefined || !isText(reference) || !isDayText(reportDate)) return null;
  if (!isCents(expensesCents) || !isCents(recordedCents) || !isCents(totalCents) || !isCents(carriedCents)) return null;
  return {
    ...base,
    income: [],
    ownersAtFinish: [],
    reference,
    reportDate,
    reportFor,
    lines,
    carried,
    expensesCents,
    recordedCents,
    totalCents,
    carriedCents,
  };
}

export function readReportDownload(id: string, fields: Record<string, unknown>): ReportDownloadView | null {
  const { reportId, propertyId, month, at, actor, schemaVersion, via } = fields;
  if (!isText(reportId) || !isText(propertyId) || !isMonth(month) || !isText(at) || !isActor(actor)) return null;
  if (via !== undefined && !isText(via)) return null;
  return { id, schemaVersion: isCents(schemaVersion) ? schemaVersion : 0, reportId, propertyId, month, at, actor, ...(via === undefined ? {} : { via }) };
}

export function readPropertyManagement(id: string, fields: Record<string, unknown>): PropertyManagementView | null {
  const { propertyId, statementsFrom, statementsUntil, setAt, schemaVersion, defaultFeeRateBasisPoints } = fields;
  const owners = readRows(fields.owners, (o) => (isRecord(o) && isText(o.name) && isTextOrNull(o.email ?? null) ? { name: o.name, email: (o.email as string | null | undefined) ?? null } : null));
  const defaultFee = fields.defaultFee === null || fields.defaultFee === undefined ? null : isRecord(fields.defaultFee) && isText(fields.defaultFee.label) && isCents(fields.defaultFee.amountCents) ? { label: fields.defaultFee.label, amountCents: fields.defaultFee.amountCents } : undefined;
  const reportFor = readReportFor(fields.reportFor);
  if (!isText(propertyId) || owners === null || !isMonth(statementsFrom) || !(statementsUntil === null || statementsUntil === undefined || isMonth(statementsUntil))) return null;
  if (defaultFee === undefined || reportFor === undefined || !isText(setAt)) return null;
  if (!(defaultFeeRateBasisPoints === null || defaultFeeRateBasisPoints === undefined || isCents(defaultFeeRateBasisPoints))) return null;
  const { excludedFromReporting } = fields;
  if (excludedFromReporting !== undefined && typeof excludedFromReporting !== 'boolean') return null;
  return {
    id,
    schemaVersion: isCents(schemaVersion) ? schemaVersion : 0,
    propertyId,
    reportFor,
    owners,
    statementsFrom,
    statementsUntil: (statementsUntil as string | null | undefined) ?? null,
    defaultFeeRateBasisPoints: (defaultFeeRateBasisPoints as number | null | undefined) ?? null,
    defaultFee,
    ...(excludedFromReporting === undefined ? {} : { excludedFromReporting }),
    setAt,
  };
}

/** Whether the property is excluded from reporting (dispatch 24): it then owes no statement for any month. */
export function isExcludedFromReporting(management: Pick<PropertyManagementView, 'excludedFromReporting'> | null | undefined): boolean {
  return management?.excludedFromReporting === true;
}

/**
 * The months a property's statements run (Kian's rulings): from the later of
 * STATEMENTS_FROM_DEFAULT (September 2026) and the month the property's
 * document was created, by Firestore's own create time (2026-10-03: a
 * property added in October owes nothing for September); a management
 * record's start month narrows that further, never widens it; its end month
 * ends them. `createdMonth` is null where the create time is not known, which
 * leaves the default.
 */
export function statementMonths(management: PropertyManagementView | null, createdMonth: string | null = null): { from: string; until: string | null } {
  const base = createdMonth !== null && createdMonth > STATEMENTS_FROM_DEFAULT ? createdMonth : STATEMENTS_FROM_DEFAULT;
  const recordFrom = management?.statementsFrom ?? null;
  return { from: recordFrom !== null && recordFrom > base ? recordFrom : base, until: management?.statementsUntil ?? null };
}

/**
 * Whether a property expects a statement for `month`: inside its statement
 * months, and not excluded from reporting (Kian's ruling of 2026-10-03: an
 * excluded property owes no statements).
 */
export function inStatementScope(management: PropertyManagementView | null, month: string, createdMonth: string | null = null): boolean {
  if (isExcludedFromReporting(management)) return false;
  const { from, until } = statementMonths(management, createdMonth);
  return month >= from && (until === null || month <= until);
}

/** A report's internal reference: the first six characters of its ID, as an entry's ref. Printed on legacy statements; shown in the admin for any. */
export function reportRef(id: string): string {
  return id.slice(0, 6);
}

/** How a report is named in the admin: its printed reference ("# Aug-321-John") when it has one, else "ref cagTIh". */
export function displayRef(report: { id: string; reference?: string | null }): string {
  const reference = report.reference?.trim();
  return reference ? `# ${reference}` : `ref ${reportRef(report.id)}`;
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
