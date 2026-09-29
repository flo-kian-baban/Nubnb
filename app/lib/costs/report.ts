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
 * Client-safe: nothing but model.ts.
 */

import { countsInTotals, formatCents, type CostEntryView, type LineNow } from '@/app/lib/cleaners/model';

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

export interface CostFilters {
  /** A property ID, or '' for every property. */
  propertyId: string;
  /** A stored status, or '' for every status. */
  status: string;
  /** yyyy-mm-dd, or '' for no start. */
  from: string;
  /** yyyy-mm-dd, or '' for no end. */
  to: string;
}

export function matchesFilters(entry: CostEntryView, filters: CostFilters): boolean {
  return (
    (filters.propertyId === '' || entry.property.id === filters.propertyId) &&
    (filters.status === '' || entry.status === filters.status) &&
    inRange(sentDay(entry.createdAt), filters.from, filters.to)
  );
}

export interface Totals {
  /** Every entry shown. */
  entries: number;
  approved: number;
  approvedCents: number;
  pending: number;
  pendingCents: number;
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
    pending: 0,
    pendingCents: 0,
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
  } else {
    totals.pending += 1;
    totals.pendingCents += entry.linesNow.totalCents;
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
 * is today.
 */
export function buildReport(
  all: CostEntryView[],
  propertyId: string,
  from: string,
  to: string,
  now: Date,
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
      totalCents: entry.linesNow.totalCents,
      corrected: entry.linesNow.corrected,
    });
  }

  const today = torontoDayOf(now);
  const firstDay = forProperty
    .map((entry) => sentDay(entry.createdAt))
    .filter((day): day is string => day !== null)
    .sort()[0];

  return {
    kind: 'ok',
    report: {
      propertyId,
      propertyName: forProperty[0] ? propertyLabel(forProperty[0]) : 'Unknown property',
      from: from || entries[0]?.day || firstDay || today,
      to: to || today,
      entries,
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
