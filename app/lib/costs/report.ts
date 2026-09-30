/**
 * The costs page's calendar and sums, apart from React, so that the page, the
 * Excel file and the PDF read the very same numbers.
 *
 * ── Dates ──
 * An entry's day is the day it was sent (`createdAt`) in Toronto, where the
 * properties are. The cleaner app records no purchase date, so the day sent
 * is the only date every entry has. A range is inclusive of both its days,
 * and an empty end is open.
 *
 * ── Money ──
 * Amounts come from `linesNow`: the lines as sent with every correction
 * applied, in integer cents, each the total the receipt prints for its line.
 * Totals are sums, worked out to show and never stored. Approved and pending
 * entries count; rejected and removed ones do not. An entry whose lines
 * cannot be read is never added into a total; it is counted apart, so the
 * page can say so, and a report refuses to be made while one is in it.
 *
 * ── Reports ──
 * A report is one property over one period, and holds approved entries only:
 * it goes to the property's co-owners, and a pending entry has not been
 * checked. The page asks first when pending entries fall in the period.
 *
 * ── A PDF that went out, against the ledger now ──
 * An approved entry can be corrected or removed after a PDF holding it has
 * gone to a co-owner. Each PDF is recorded when it is made, with every
 * entry's history length and printed amounts; comparePdf and entryPdfState
 * set those beside the entries as they now stand, so the page can say which
 * PDFs no longer match and why. The comparison reads; it changes nothing.
 *
 * Client-safe: nothing but model.ts. The server uses the same day and range
 * functions when it records a PDF, so both sides agree on what a period holds.
 */

import {
  countsInTotals,
  formatCents,
  type CostEntryView,
  type LineNow,
  type ReportExportView,
  type TaxShape,
} from '@/app/lib/cleaners/model';

export const REPORT_TIME_ZONE = 'America/Toronto';

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const torontoParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: REPORT_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const torontoTime = new Intl.DateTimeFormat('en-CA', {
  timeZone: REPORT_TIME_ZONE,
  hour: 'numeric',
  minute: '2-digit',
});

const pad = (n: number) => String(n).padStart(2, '0');

// ─── Days ──────────────────────────────────────────────────────

/** The Toronto calendar day of an instant, as yyyy-mm-dd. */
export function torontoDayOf(date: Date): string {
  const parts = Object.fromEntries(torontoParts.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** The Toronto day an entry was sent; null when its timestamp is not a date. */
export function sentDay(iso: string | null): string | null {
  if (iso === null) return null;
  const time = Date.parse(iso);
  return Number.isFinite(time) ? torontoDayOf(new Date(time)) : null;
}

/** A real calendar day written yyyy-mm-dd: 2026-02-30 is not one. */
export function isDay(value: string): boolean {
  const match = DAY.exec(value);
  if (!match) return false;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** "3 Sep 2026". Anything that is not a day is returned as it is. */
export function shortDay(day: string): string {
  const match = DAY.exec(day);
  if (!match) return day;
  return `${Number(match[3])} ${MONTHS_SHORT[Number(match[2]) - 1]} ${match[1]}`;
}

/** "3 September 2026". Anything that is not a day is returned as it is. */
export function longDay(day: string): string {
  const match = DAY.exec(day);
  if (!match) return day;
  return `${Number(match[3])} ${MONTHS_LONG[Number(match[2]) - 1]} ${match[1]}`;
}

/** "1 September 2026 – 30 September 2026", or one day alone. */
export function periodLabel(from: string, to: string): string {
  return from === to ? longDay(from) : `${longDay(from)} – ${longDay(to)}`;
}

/** "29 Sep 2026, 3:45 p.m., Toronto time". */
export function generatedLabel(now: Date): string {
  return `${shortDay(torontoDayOf(now))}, ${torontoTime.format(now)}, Toronto time`;
}

export type RangePreset = 'this-month' | 'last-month' | 'this-year' | 'all-time';

export const RANGE_PRESETS: { key: RangePreset; label: string }[] = [
  { key: 'this-month', label: 'This month' },
  { key: 'last-month', label: 'Last month' },
  { key: 'this-year', label: 'This year' },
  { key: 'all-time', label: 'All time' },
];

/** A preset's days, ending today at the latest; all time is both ends open. */
export function presetRange(preset: RangePreset, today: string): { from: string; to: string } {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  switch (preset) {
    case 'this-month':
      return { from: `${today.slice(0, 7)}-01`, to: today };
    case 'last-month': {
      const y = month === 1 ? year - 1 : year;
      const m = month === 1 ? 12 : month - 1;
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
      return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(lastDay)}` };
    }
    case 'this-year':
      return { from: `${year}-01-01`, to: today };
    case 'all-time':
      return { from: '', to: '' };
  }
}

/** Whether a day falls in a range. With both ends open, everything does, an entry with no date included. */
export function inRange(day: string | null, from: string, to: string): boolean {
  if (from === '' && to === '') return true;
  if (day === null) return false;
  return (from === '' || day >= from) && (to === '' || day <= to);
}

// ─── Names ─────────────────────────────────────────────────────

function firstNamed(...names: (string | null)[]): string | null {
  return names.find((name): name is string => name !== null && name.trim() !== '') ?? null;
}

/** The property's name now, or the one recorded with the entry. */
export function propertyLabel(entry: CostEntryView): string {
  return firstNamed(entry.property.name, entry.property.nameAtEntry) ?? 'Unknown property';
}

/** The cleaner's name now, or the one recorded with the entry. */
export function cleanerLabel(entry: CostEntryView): string {
  return firstNamed(entry.cleaner.name, entry.cleaner.nameAtEntry) ?? 'Unknown cleaner';
}

/** The first six characters of an entry's ID: enough to find it again from a report. */
export function entryRef(id: string): string {
  return id.slice(0, 6);
}

// ─── Filters and totals ────────────────────────────────────────

/**
 * The queue's default (dispatch 21): everything that is not approved —
 * pending, rejected, removed, and any status this code does not know —
 * because each of those still needs, or had, a decision. Approved entries
 * have left the queue for their property's ledger.
 */
export const NEEDS_ATTENTION = 'attention';

export interface CostFilters {
  /** A property ID, or '' for every property. */
  propertyId: string;
  /** A stored status, NEEDS_ATTENTION for everything not approved, or '' for every status. */
  status: string;
  /** yyyy-mm-dd, or '' for no start. */
  from: string;
  /** yyyy-mm-dd, or '' for no end. */
  to: string;
}

export function matchesStatus(entry: CostEntryView, status: string): boolean {
  if (status === '') return true;
  if (status === NEEDS_ATTENTION) return entry.status !== 'approved';
  return entry.status === status;
}

export function matchesFilters(entry: CostEntryView, filters: CostFilters): boolean {
  return (
    (filters.propertyId === '' || entry.property.id === filters.propertyId) &&
    matchesStatus(entry, filters.status) &&
    inRange(sentDay(entry.createdAt), filters.from, filters.to)
  );
}

export interface Totals {
  /** Every entry shown. */
  entries: number;
  approved: number;
  approvedCents: number;
  /** The tax fields of the approved entries added up (dispatch 21); tax kept among an older entry's lines is inside approvedCents. */
  approvedTaxCents: number;
  pending: number;
  pendingCents: number;
  pendingTaxCents: number;
  rejected: number;
  removed: number;
  /** Entries whose status is none of the four: shown as stored, never counted. */
  unknownStatus: number;
  /** Approved or pending entries whose lines cannot be read: left out of the sums, and said so. */
  unreadable: number;
}

export interface PropertyTotals extends Totals {
  propertyId: string | null;
  label: string;
}

function noTotals(): Totals {
  return {
    entries: 0,
    approved: 0,
    approvedCents: 0,
    approvedTaxCents: 0,
    pending: 0,
    pendingCents: 0,
    pendingTaxCents: 0,
    rejected: 0,
    removed: 0,
    unknownStatus: 0,
    unreadable: 0,
  };
}

function addTo(totals: Totals, entry: CostEntryView): void {
  totals.entries += 1;
  if (entry.status === 'rejected') totals.rejected += 1;
  else if (entry.status === 'removed') totals.removed += 1;
  else if (!countsInTotals(entry.status)) totals.unknownStatus += 1;
  else if (entry.linesNow.kind !== 'ok') totals.unreadable += 1;
  else if (entry.status === 'approved') {
    totals.approved += 1;
    totals.approvedCents += entry.linesNow.totalCents;
    totals.approvedTaxCents += entry.linesNow.taxCents ?? 0;
  } else {
    totals.pending += 1;
    totals.pendingCents += entry.linesNow.totalCents;
    totals.pendingTaxCents += entry.linesNow.taxCents ?? 0;
  }
}

/** Totals for the entries given, one row per property (A to Z), and all of them together. */
export function totalsByProperty(entries: CostEntryView[]): { rows: PropertyTotals[]; all: Totals } {
  const rows = new Map<string, PropertyTotals>();
  const all = noTotals();
  for (const entry of entries) {
    const key = entry.property.id ?? '';
    let row = rows.get(key);
    if (!row) {
      row = { ...noTotals(), propertyId: entry.property.id, label: propertyLabel(entry) };
      rows.set(key, row);
    }
    addTo(row, entry);
    addTo(all, entry);
  }
  return { rows: [...rows.values()].sort((a, b) => a.label.localeCompare(b.label, 'en-CA')), all };
}

// ─── Items ─────────────────────────────────────────────────────

/** One line bought, with the entry it is on. */
export interface ItemRow {
  entryId: string;
  day: string | null;
  status: string | null;
  line: LineNow;
}

/**
 * Every line that counts, from the entries given, in their order: what was
 * bought for a house, and what each line cost as printed.
 */
export function countedItems(entries: CostEntryView[]): ItemRow[] {
  const rows: ItemRow[] = [];
  for (const entry of entries) {
    if (!countsInTotals(entry.status) || entry.linesNow.kind !== 'ok') continue;
    for (const line of entry.linesNow.lines) {
      rows.push({ entryId: entry.id, day: sentDay(entry.createdAt), status: entry.status, line });
    }
  }
  return rows;
}

/** What one entry bought, for a report's one-line summary. */
export interface Bought {
  /** The names of the lines that cost something: each once, in receipt order. */
  items: string[];
  /** Every line that took money off — a discount, a return — with its amount: "Instant savings (-$5.00)". */
  adjustments: string[];
}

/**
 * What one entry bought: the items, then the money taken off with its amount,
 * so that the entry's total can be read from what is listed. A line of
 * exactly $0.00 neither adds nor takes off anything, and is left out.
 */
export function whatWasBought(lines: LineNow[]): Bought {
  const seen = new Set<string>();
  const items: string[] = [];
  const adjustments: string[] = [];
  for (const line of lines) {
    const name = line.name?.trim() || null;
    if (line.lineTotalCents < 0) {
      adjustments.push(`${name ?? 'Money back'} (${formatCents(line.lineTotalCents)})`);
    } else if (line.lineTotalCents > 0 && name !== null && !seen.has(name)) {
      seen.add(name);
      items.push(name);
    }
  }
  return { items, adjustments };
}

/** The same summary as one line of text, for the Excel file, where nothing is cut. */
export function whatWasBoughtText(lines: LineNow[]): string {
  const { items, adjustments } = whatWasBought(lines);
  return [...items, ...adjustments].join(', ');
}

// ─── Reports ───────────────────────────────────────────────────

export interface ReportEntry {
  id: string;
  ref: string;
  /** The Toronto day it was sent. */
  day: string;
  cleaner: string;
  lines: LineNow[];
  /** The lines added up: the items (dispatch 21). On an `in-lines` entry any tax the cleaner typed is among them. */
  itemsCents: number;
  /** The tax apart from the items; null when none was given, or the entry keeps it among its lines. */
  taxCents: number | null;
  taxShape: TaxShape;
  /** Items plus tax. */
  totalCents: number;
  corrected: boolean;
}

export interface CostReport {
  propertyId: string;
  propertyName: string;
  /** The period, yyyy-mm-dd, both days included. */
  from: string;
  to: string;
  /** Approved entries in the period, oldest first. */
  entries: ReportEntry[];
  /** The entries' items added up. */
  itemsCents: number;
  /** The entries' tax fields added up; tax kept among an older entry's lines is inside `itemsCents` instead. */
  taxCents: number;
  /** True when an entry in the report keeps its tax among its lines, so the reader is told. */
  taxInLines: boolean;
  totalCents: number;
  generatedAt: Date;
}

export type ReportBuild =
  | {
      kind: 'ok';
      report: CostReport;
      /** Pending entries in the period, which the report leaves out. */
      pendingLeftOut: number;
    }
  /** Approved entries in the period whose lines or date cannot be read. No report is made. */
  | { kind: 'unreadable'; entryIds: string[] };

/**
 * One property's report for one period: its approved entries, oldest first,
 * and their total. An open start is the property's first entry; an open end
 * is today. `knownName` is the property's name for a property that has no
 * entry to take it from.
 */
export function buildReport(
  all: CostEntryView[],
  propertyId: string,
  from: string,
  to: string,
  now: Date,
  knownName: string | null = null,
): ReportBuild {
  const forProperty = all.filter((entry) => entry.property.id === propertyId);
  const inPeriod = forProperty.filter((entry) => inRange(sentDay(entry.createdAt), from, to));
  const approved = inPeriod
    .filter((entry) => entry.status === 'approved')
    .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id));

  const unreadable = approved
    .filter((entry) => entry.linesNow.kind !== 'ok' || sentDay(entry.createdAt) === null)
    .map((entry) => entry.id);
  if (unreadable.length > 0) return { kind: 'unreadable', entryIds: unreadable };

  const entries: ReportEntry[] = [];
  for (const entry of approved) {
    const day = sentDay(entry.createdAt);
    if (entry.linesNow.kind !== 'ok' || day === null) continue; // refused above
    entries.push({
      id: entry.id,
      ref: entryRef(entry.id),
      day,
      cleaner: cleanerLabel(entry),
      lines: entry.linesNow.lines,
      itemsCents: entry.linesNow.itemsCents,
      taxCents: entry.linesNow.taxCents,
      taxShape: entry.linesNow.taxShape,
      totalCents: entry.linesNow.totalCents,
      corrected: entry.linesNow.corrected,
    });
  }

  const today = torontoDayOf(now);
  const firstDay = forProperty
    .map((entry) => sentDay(entry.createdAt))
    .filter((day): day is string => day !== null)
    .sort()[0];
  // An open end is today, but never a day before the last entry in the
  // report: on a computer whose clock is behind, "today" would otherwise end
  // the period before its own entries, and a PDF's period is what the server
  // checks its entries against when it records it.
  const lastDay = entries[entries.length - 1]?.day;

  return {
    kind: 'ok',
    report: {
      propertyId,
      propertyName: forProperty[0] ? propertyLabel(forProperty[0]) : (knownName ?? 'Unknown property'),
      from: from || entries[0]?.day || firstDay || today,
      to: to || (lastDay !== undefined && lastDay > today ? lastDay : today),
      entries,
      itemsCents: entries.reduce((sum, entry) => sum + entry.itemsCents, 0),
      taxCents: entries.reduce((sum, entry) => sum + (entry.taxCents ?? 0), 0),
      taxInLines: entries.some((entry) => entry.taxShape === 'in-lines'),
      totalCents: entries.reduce((sum, entry) => sum + entry.totalCents, 0),
      generatedAt: now,
    },
    pendingLeftOut: inPeriod.filter((entry) => entry.status === 'pending').length,
  };
}

/** "nubnb-costs-loft-plateau-2026-09-01-to-2026-09-30.pdf". */
export function reportFileName(report: CostReport, extension: 'pdf' | 'xlsx'): string {
  const slug =
    report.propertyName
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'property';
  return `nubnb-costs-${slug}-${report.from}-to-${report.to}.${extension}`;
}

// ─── A PDF that went out, against the ledger now ───────────────

/** One entry as a recorded PDF printed it, every field in the written shape. */
export interface PrintedEntry {
  entryId: string;
  /** How long the entry's history was when the PDF was made. */
  historyLength: number;
  itemsCents: number;
  taxCents: number | null;
  totalCents: number;
}

/** A recorded PDF that can be compared: every field in the written shape. */
export interface PdfRecord {
  id: string;
  /** When it was made: the PDF's "Generated" time. */
  createdAt: string;
  propertyId: string;
  propertyName: string | null;
  from: string;
  to: string;
  /** The entries in the PDF, oldest first. */
  entries: PrintedEntry[];
  /** The period total the PDF printed. */
  totalCents: number;
}

const isCents = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);

/**
 * The recorded PDFs that can be compared, newest first, and how many cannot
 * be. A record with a field missing or not in the written shape is counted
 * apart, so the page can say so, and is never guessed at.
 */
export function readPdfRecords(exports: ReportExportView[]): { records: PdfRecord[]; unreadable: number } {
  const records: PdfRecord[] = [];
  let unreadable = 0;
  for (const stored of exports) {
    if (stored.kind !== 'pdf') continue; // only PDFs are recorded; anything else is not one
    const entries: PrintedEntry[] = [];
    let readable =
      stored.createdAt !== null &&
      Number.isFinite(Date.parse(stored.createdAt)) &&
      stored.propertyId !== null &&
      stored.from !== null &&
      isDay(stored.from) &&
      stored.to !== null &&
      isDay(stored.to) &&
      stored.entries !== null &&
      isCents(stored.totalCents);
    for (const entry of stored.entries ?? []) {
      if (
        entry.entryId === null ||
        !isCents(entry.historyLength) ||
        entry.historyLength < 0 ||
        !isCents(entry.itemsCents) ||
        !(entry.taxCents === null || isCents(entry.taxCents)) ||
        !isCents(entry.totalCents)
      ) {
        readable = false;
        break;
      }
      entries.push({
        entryId: entry.entryId,
        historyLength: entry.historyLength,
        itemsCents: entry.itemsCents,
        taxCents: entry.taxCents,
        totalCents: entry.totalCents,
      });
    }
    if (!readable) {
      unreadable += 1;
      continue;
    }
    records.push({
      id: stored.id,
      createdAt: stored.createdAt as string,
      propertyId: stored.propertyId as string,
      propertyName: stored.propertyNameAtExport,
      from: stored.from as string,
      to: stored.to as string,
      entries,
      totalCents: stored.totalCents as number,
    });
  }
  records.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  return { records, unreadable };
}

/** How an entry now stands beside what a PDF printed for it. */
export type SincePdf =
  /** Still approved, the same amounts, and nothing corrected since. */
  | { kind: 'same' }
  /** Still approved with the same amounts, but a line or the tax was corrected since: what was bought may read differently. */
  | { kind: 'corrected' }
  /** Still approved, and it now adds up differently. */
  | { kind: 'amount-changed'; nowTotalCents: number }
  /** No longer approved — rejected or removed since — so it has left the ledger. */
  | { kind: 'left'; status: string | null }
  /** Still approved, but its lines can no longer be added up. */
  | { kind: 'unreadable' }
  /** No entry has this ID now. Nothing is ever erased, so this is not expected. */
  | { kind: 'missing' };

const CORRECTIONS = new Set(['line_corrected', 'line_added', 'tax_corrected']);

/** One entry now, beside what a PDF printed for it. */
export function sincePdf(entry: CostEntryView | undefined, printed: PrintedEntry): SincePdf {
  if (!entry) return { kind: 'missing' };
  if (entry.status !== 'approved') return { kind: 'left', status: entry.status };
  const now = entry.linesNow;
  if (now.kind !== 'ok') return { kind: 'unreadable' };
  if (
    now.itemsCents !== printed.itemsCents ||
    now.taxCents !== printed.taxCents ||
    now.totalCents !== printed.totalCents
  ) {
    return { kind: 'amount-changed', nowTotalCents: now.totalCents };
  }
  const later = (entry.history ?? []).slice(printed.historyLength);
  return later.some((event) => event.action !== null && CORRECTIONS.has(event.action)) ? { kind: 'corrected' } : { kind: 'same' };
}

/** An entry a PDF lists that is no longer as the PDF printed it. */
export interface PdfChange {
  printed: PrintedEntry;
  /** The entry now; null when no entry has that ID. */
  entry: CostEntryView | null;
  since: Exclude<SincePdf, { kind: 'same' }>;
}

export interface PdfComparison {
  record: PdfRecord;
  /** The entries the PDF lists that are no longer as it printed them. */
  changes: PdfChange[];
  /** Approved entries now in the PDF's period that it does not list: approved, or approved again, since it was made. */
  added: CostEntryView[];
  /** How many approved entries the PDF's period holds now. */
  nowEntries: number;
  /** What the PDF's period adds up to now; null when an approved entry in it cannot be added up. */
  nowTotalCents: number | null;
  /**
   *   matches  the PDF still says what the ledger says
   *   wording  every amount matches, but an entry in it was corrected since
   *   differs  an amount has changed, or which entries count has
   */
  verdict: 'matches' | 'wording' | 'differs';
}

/** One recorded PDF beside its property's ledger as it now stands, over the PDF's own period. */
export function comparePdf(record: PdfRecord, all: CostEntryView[]): PdfComparison {
  const byId = new Map(all.map((entry) => [entry.id, entry]));
  const changes: PdfChange[] = [];
  for (const printed of record.entries) {
    const entry = byId.get(printed.entryId);
    const since = sincePdf(entry, printed);
    if (since.kind !== 'same') changes.push({ printed, entry: entry ?? null, since });
  }

  const listed = new Set(record.entries.map((printed) => printed.entryId));
  const now = all.filter(
    (entry) =>
      entry.property.id === record.propertyId &&
      entry.status === 'approved' &&
      inRange(sentDay(entry.createdAt), record.from, record.to),
  );
  const added = now
    .filter((entry) => !listed.has(entry.id))
    .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id));

  const amountsMatch = added.length === 0 && changes.every((change) => change.since.kind === 'corrected');
  return {
    record,
    changes,
    added,
    nowEntries: now.length,
    nowTotalCents: now.every((entry) => entry.linesNow.kind === 'ok')
      ? now.reduce((sum, entry) => sum + (entry.linesNow.kind === 'ok' ? entry.linesNow.totalCents : 0), 0)
      : null,
    verdict: !amountsMatch ? 'differs' : changes.length > 0 ? 'wording' : 'matches',
  };
}

/** One PDF an entry went out in. */
export interface PdfAppearance {
  record: PdfRecord;
  printed: PrintedEntry;
  since: SincePdf;
}

export interface EntryPdfState {
  /** Every PDF the entry went out in, newest first. */
  appearances: PdfAppearance[];
  /**
   * What the newest PDF covering the entry's day says about it. When that
   * PDF lists the entry, how the entry stands beside it; `not-listed` when a
   * newer PDF for that day was made without it — after it was removed, say —
   * so the PDF to go by no longer carries it.
   */
  latest: SincePdf['kind'] | 'not-listed';
  /** The newest PDF that lists the entry. */
  lastListed: PdfAppearance;
}

/**
 * The PDFs one entry went out in, and whether the newest PDF for its day
 * still says what the entry says. null when it was never in a PDF.
 * `records` are newest first, as readPdfRecords returns them.
 */
export function entryPdfState(entry: CostEntryView, records: PdfRecord[]): EntryPdfState | null {
  const appearances: PdfAppearance[] = [];
  for (const record of records) {
    const printed = record.entries.find((line) => line.entryId === entry.id);
    if (printed) appearances.push({ record, printed, since: sincePdf(entry, printed) });
  }
  if (appearances.length === 0) return null;

  const day = sentDay(entry.createdAt);
  const covering =
    day === null
      ? appearances[0].record
      : records.find((record) => record.propertyId === entry.property.id && inRange(day, record.from, record.to));
  const inCovering = appearances.find((appearance) => appearance.record.id === covering?.id);
  return {
    appearances,
    latest: inCovering ? inCovering.since.kind : 'not-listed',
    lastListed: appearances[0],
  };
}
