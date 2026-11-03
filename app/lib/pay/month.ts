/**
 * A team member's month (Kian's rulings of 2026-11-03, Build 3; CLEANER-COSTS-DESIGN.md §70): the summary above the
 * calendar and what each day of the calendar holds, worked out from what pay already reads (balance.ts rows, the
 * person's cleanings) and their jobs of the month (the server's `memberJobsInMonth`). Every figure comes from existing
 * data; nothing here changes how anything is counted. No time-spent metric: no start time is recorded. Pure and
 * client-safe.
 *
 * Words are the admin's (§69.2): Done, Not marked, Assigned, Needs an amount, Needs a decision, Counted, Settled,
 * Paid ahead; the Schedule's for a changed booking.
 */

import { addDays, torontoDay } from '../availability/days';
import { formatCents } from '../cleaners/model';
import type { CleaningExtra } from '../cleanings/model';
import { changeWords, type ChangeKind, type JobOrigin, type JobStatus } from '../schedule/model';
import type { PayRow } from './balance';
import { PAYMENT_METHOD_LABELS } from './model';
import { paydayMarkers, paydayWords, type PaydayMarker } from './payday';

/** One of a person's jobs in a month, as the person page reads it (GET /api/admin/cleaners/[id]/month). */
export interface PersonJob {
  id: string;
  propertyId: string;
  /** The name the admin knows the property by: its cleaner-facing name, else its title. */
  propertyName: string | null;
  checkout: string;
  /** The label of a job added by hand ("Deep clean"); null on a turnover. */
  label: string | null;
  origin: JobOrigin;
  status: JobStatus;
  change: { kind: ChangeKind; movedTo: { start: string; end: string } | null } | null;
  /** Their mark: when, the cleaning it made, and whether the office removed it. */
  markedAt: string | null;
  cleaningId: string | null;
  removedAt: string | null;
  note: string | null;
  extraAsked: boolean;
  /** The amount an admin set on the job, if any. */
  amountCents: number | null;
}

/** A cleaning as the month needs it: the person page's CleaningView, or the server's read. */
export interface MonthCleaning {
  id: string;
  cleanerId: string;
  day: string;
  status: string;
  createdAt: string;
  /** Who logged it: the cleaner's own mark, or an admin (logged by hand, or recorded for them). */
  actor: { role: string };
  extra: Pick<CleaningExtra, 'status'> | null;
  jobId: string | null;
}

export interface MonthSummary {
  month: string;
  /** Their cleanings in the month, logged (not removed): each a job done, counted or not. */
  jobsDone: number;
  /** Of those, marked by them on the job's day; marked by them on a later day; recorded or logged by the office. */
  markedOnDay: number;
  markedLater: number;
  byOffice: number;
  /** Their jobs in the month whose checkout passed, still assigned to them, not marked (the Schedule's "Not marked"). */
  notMarked: number;
  /** Cleanings in the month on which they sent a note (decided or not). */
  notesSent: number;
  cleanings: { cents: number; count: number; averageCents: number | null };
  /** Receipts counted in the month; `cardCents` the approved ones paid with Nubnb's card, which are not owed. */
  receipts: { cents: number; count: number; cardCents: number };
  work: { cents: number; count: number };
  /** Payments dated in the month. */
  paidCents: number;
  /** The running balance at the month's last day: counted items dated through it, minus payments dated through it. */
  owedAtEndCents: number;
}

/** The first and last day of a month. */
export function monthBounds(month: string): { first: string; last: string } {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { first: `${month}-01`, last: `${month}-${String(last).padStart(2, '0')}` };
}

const inMonth = (day: string | null, month: string) => day !== null && day.slice(0, 7) === month;

/** The month's figures (the summary above the calendar). `today` decides which unmarked jobs are "Not marked". */
export function monthSummary(month: string, rows: readonly PayRow[], cleanings: readonly MonthCleaning[], jobs: readonly PersonJob[], today: string): MonthSummary {
  const { last } = monthBounds(month);
  const done = cleanings.filter((c) => c.status === 'logged' && inMonth(c.day, month));
  const dayOf = (iso: string) => {
    const time = Date.parse(iso);
    return Number.isFinite(time) ? torontoDay(new Date(time)) : null;
  };
  const own = done.filter((c) => c.actor.role !== 'admin');
  const markedOnDay = own.filter((c) => dayOf(c.createdAt) === c.day).length;
  const sum = (list: readonly PayRow[], pick: (row: PayRow) => number | null) => list.reduce((total, row) => total + (pick(row) ?? 0), 0);
  const month_ = rows.filter((row) => inMonth(row.day, month));
  const cleaningRows = month_.filter((row) => row.kind === 'cleaning' && row.earnedCents !== null);
  const receiptRows = month_.filter((row) => row.kind === 'receipt' && row.earnedCents !== null);
  const workRows = month_.filter((row) => row.kind === 'work' && row.earnedCents !== null);
  const cleaningsCents = sum(cleaningRows, (row) => row.earnedCents);
  const through = rows.filter((row) => row.day !== null && row.day <= last);
  return {
    month,
    jobsDone: done.length,
    markedOnDay,
    markedLater: own.length - markedOnDay,
    byOffice: done.length - own.length,
    notMarked: jobs.filter((job) => inMonth(job.checkout, month) && job.status === 'open' && job.cleaningId === null && job.checkout < today).length,
    notesSent: done.filter((c) => c.extra !== null).length,
    cleanings: { cents: cleaningsCents, count: cleaningRows.length, averageCents: cleaningRows.length === 0 ? null : Math.round(cleaningsCents / cleaningRows.length) },
    receipts: { cents: sum(receiptRows, (row) => row.earnedCents), count: receiptRows.length, cardCents: sum(month_.filter((row) => row.kind === 'receipt' && row.state === 'nubnb-card'), (row) => row.amountCents) },
    work: { cents: sum(workRows, (row) => row.earnedCents), count: workRows.length },
    paidCents: sum(month_, (row) => row.paidCents),
    owedAtEndCents: sum(through, (row) => row.earnedCents) - sum(through, (row) => row.paidCents),
  };
}

/** "12 jobs done · 10 marked on the day · 1 later · 1 by the office · 1 Not marked": the summary's first line. */
export function jobsWords(s: MonthSummary): string {
  const parts = [`${s.jobsDone === 1 ? '1 job' : `${s.jobsDone} jobs`} done`];
  if (s.jobsDone > 0) {
    parts.push(`${s.markedOnDay} marked on the day`);
    if (s.markedLater > 0) parts.push(`${s.markedLater} later`);
    if (s.byOffice > 0) parts.push(`${s.byOffice} by the office`);
  }
  if (s.notMarked > 0) parts.push(`${s.notMarked} Not marked`);
  return parts.join(' · ');
}

// ─── The calendar ──────────────────────────────────────────────

export type DayItemKind = 'job' | 'cleaning' | 'receipt' | 'work' | 'payment' | 'payday';
export type DayItemTone = 'done' | 'needs' | 'alert' | 'ahead' | 'paid' | 'payday' | 'muted';

/** One line in a day of the calendar, and in the day's list under it. */
export interface DayItem {
  kind: DayItemKind;
  id: string;
  /** "14 Sample St · Turnover", "Receipt · 3 items", "Payment · E-transfer", "Payday". */
  words: string;
  /** Its state in the admin's word: "Done", "Not marked", "Assigned", "Approved", "Needs a decision", "due $275.00". */
  state: string;
  /** The amount shown beside it, when one is: a receipt's or work's total, a payment, the payday's due. */
  amountCents: number | null;
  tone: DayItemTone;
  /** The order within the day: paydays first, then jobs, then the rest by time. */
  at: string;
}

export interface CalendarDay {
  day: string;
  /** Days before the first and after the last of the month fill the grid's first and last weeks. */
  inMonth: boolean;
  isToday: boolean;
  payday: PaydayMarker | null;
  items: DayItem[];
}

/** The weeks of a month's calendar, Sunday first, each week seven days; days outside the month fill the edges. */
export function calendarWeeks(month: string): string[][] {
  const { first, last } = monthBounds(month);
  const firstWeekday = new Date(`${first}T12:00:00Z`).getUTCDay();
  const start = addDays(first, -firstWeekday);
  const weeks: string[][] = [];
  for (let day = start; day <= last || weeks.length === 0 || weeks[weeks.length - 1].length < 7; day = addDays(day, 1)) {
    if (weeks.length === 0 || weeks[weeks.length - 1].length === 7) weeks.push([]);
    weeks[weeks.length - 1].push(day);
    if (day >= last && weeks[weeks.length - 1].length === 7) break;
  }
  return weeks;
}

/** What a job's cell says (the Schedule's words; a job done takes its cleaning's state when that needs the admin). */
export function jobWords(job: PersonJob, cleaningRow: PayRow | undefined, today: string): { state: string; tone: DayItemTone } {
  if (job.status === 'booking-changed') return { state: `Booking changed · ${changeWords(job.change ? { kind: job.change.kind, at: '', movedTo: job.change.movedTo } : null) ?? ''}${job.markedAt !== null ? ' · after it was marked' : ''}`, tone: 'alert' };
  if (job.cleaningId !== null && job.removedAt !== null) return { state: 'Removed by the office', tone: 'muted' };
  if (job.cleaningId !== null) {
    if (cleaningRow?.state === 'no-amount') return { state: 'Done · Needs an amount', tone: 'needs' };
    if (cleaningRow?.state === 'extra-asked') return { state: 'Done · Needs a decision', tone: 'needs' };
    if (cleaningRow?.state === 'removed') return { state: 'Done · Removed', tone: 'muted' };
    return { state: 'Done', tone: 'done' };
  }
  if (job.checkout < today) return { state: 'Not marked', tone: 'alert' };
  return { state: 'Assigned', tone: 'ahead' };
}

/** An entry's state word (the admin's): Approved, Needs a decision, Rejected, Removed, Paid with Nubnb's card. */
function entryState(row: PayRow): { state: string; tone: DayItemTone } {
  switch (row.state) {
    case 'counts':
      return { state: 'Approved', tone: 'done' };
    case 'waiting':
      return { state: 'Needs a decision', tone: 'needs' };
    case 'rejected':
      return { state: 'Rejected', tone: 'muted' };
    case 'removed':
      return { state: 'Removed', tone: 'muted' };
    case 'nubnb-card':
      return { state: "Paid with Nubnb's card", tone: 'muted' };
    case 'cannot-add-up':
      return { state: 'Cannot add up', tone: 'alert' };
    default:
      return { state: row.note ?? row.state, tone: 'muted' };
  }
}

/**
 * The calendar of a month: each day's items — the person's jobs (unit, label, done or not), their cleanings with no job
 * (logged by the office), receipts and work (amount, status), payments, and the 1st and the 15th marked with what was
 * due. Clicking a day lists the same items.
 */
export function calendarOf(month: string, rows: readonly PayRow[], jobs: readonly PersonJob[], today: string): CalendarDay[][] {
  const markers = new Map(paydayMarkers(month, rows, today).map((m) => [m.payday, m]));
  const byCleaning = new Map(rows.filter((row) => row.kind === 'cleaning').map((row) => [row.id, row]));
  const jobCleanings = new Set(jobs.map((job) => job.cleaningId).filter((id): id is string => id !== null));
  const items = new Map<string, DayItem[]>();
  const push = (day: string, item: DayItem) => items.set(day, [...(items.get(day) ?? []), item]);
  for (const marker of markers.values()) {
    push(marker.payday, { kind: 'payday', id: marker.payday, words: `Payday · covers up to ${paydayWords(marker.cutoff)}`, state: marker.dueCents > 0 ? `${marker.past ? 'was due' : 'due'} ${formatCents(marker.dueCents)}` : 'Settled', amountCents: marker.dueCents > 0 ? marker.dueCents : null, tone: 'payday', at: '0' });
  }
  for (const job of jobs) {
    if (!inMonth(job.checkout, month)) continue;
    const row = job.cleaningId === null ? undefined : byCleaning.get(job.cleaningId);
    const { state, tone } = jobWords(job, row, today);
    push(job.checkout, { kind: 'job', id: job.id, words: `${job.propertyName ?? 'Unknown property'} · ${job.label ?? 'Turnover'}`, state, amountCents: null, tone, at: `1 ${job.markedAt ?? ''}` });
  }
  for (const row of rows) {
    if (row.day === null || !inMonth(row.day, month)) continue;
    if (row.kind === 'cleaning') {
      // A cleaning whose job is in the month's jobs is shown on that job; one logged by hand, or whose job is not theirs now, on its own.
      if (jobCleanings.has(row.id)) continue;
      const state = row.state === 'counts' ? 'Done' : row.state === 'no-amount' ? 'Done · Needs an amount' : row.state === 'extra-asked' ? 'Done · Needs a decision' : row.state === 'removed' ? 'Removed' : row.state === 'moved' ? 'Given to another cleaner' : (row.note ?? row.state);
      push(row.day, { kind: 'cleaning', id: row.id, words: `${row.property ?? 'Unknown property'} · Cleaning`, state, amountCents: null, tone: row.state === 'counts' ? 'done' : row.state === 'no-amount' || row.state === 'extra-asked' ? 'needs' : 'muted', at: `2 ${row.at ?? ''}` });
    } else if (row.kind === 'payment') {
      if (row.payment === null) continue;
      push(row.day, { kind: 'payment', id: row.id, words: `Payment · ${PAYMENT_METHOD_LABELS[row.payment.method]}${row.payment.note ? ` · “${row.payment.note}”` : ''}`, state: row.state === 'deleted' ? 'Deleted' : `Paid ${formatCents(row.payment.amountCents)}`, amountCents: row.payment.amountCents, tone: row.state === 'deleted' ? 'muted' : 'paid', at: `3 ${row.at ?? ''}` });
    } else {
      const { state, tone } = entryState(row);
      push(row.day, { kind: row.kind, id: row.id, words: `${row.kind === 'work' ? 'Work' : 'Receipt'}${row.property ? ` · ${row.property}` : ''}${row.detail ? ` · ${row.detail}` : ''}`, state, amountCents: row.amountCents, tone, at: `2 ${row.at ?? ''}` });
    }
  }
  return calendarWeeks(month).map((week) =>
    week.map((day) => ({
      day,
      inMonth: inMonth(day, month),
      isToday: day === today,
      payday: markers.get(day) ?? null,
      items: (items.get(day) ?? []).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)),
    })),
  );
}
