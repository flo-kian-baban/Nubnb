/**
 * Paydays (Kian's rulings of 2026-11-03, Build 3 of the UX audit; CLEANER-COSTS-DESIGN.md §70): the 1st and the 15th.
 *
 *   "A payday pays everything counted and dated before it, minus payments: the 15th covers up to the 14th, the 1st up
 *    to the last day of the previous month. The balance stays a running total; anything decided late joins the next
 *    payday."
 *
 * Item dates are the ones pay already uses (balance.ts): a cleaning by its job's day, a receipt or work entry by the
 * day it was sent, a payment by the day paid. "Decided late" is read from each row's `countedAt` (balance.ts): an item
 * that started counting after a payday's day is not in that payday's due, whatever its date; it is in the next one's.
 * An item decided on the payday itself is in it.
 *
 * What is still due on a payday now subtracts every payment on record (the running total): a payday paid is settled,
 * paid late or not. What was due on a past payday, as the month calendar marks it, subtracts the payments dated before
 * that payday: what the admin saw that morning. Nothing here changes how anything is counted. Pure and client-safe.
 */

import { addDays, torontoDay } from '../availability/days';
import { formatCents } from '../cleaners/model';
import type { PayRow } from './balance';

/** The days of the month that are paydays. */
export const PAYDAYS = [1, 15] as const;

/** Every payment on record: what "still due now" subtracts. */
export const ALL_PAYMENTS = '9999-12-31';

/** The month `by` months from `month` (yyyy-mm). */
function monthPlus(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** A month's paydays, yyyy-mm-dd, in order. */
export function paydaysOf(month: string): string[] {
  return PAYDAYS.map((d) => `${month}-${String(d).padStart(2, '0')}`);
}

/** The first payday on or after `today`: today when today is one. */
export function nextPayday(today: string): string {
  const month = today.slice(0, 7);
  return paydaysOf(month).find((d) => d >= today) ?? paydaysOf(monthPlus(month, 1))[0];
}

/** The latest payday on or before `today`: the one just passed, or today. */
export function lastPayday(today: string): string {
  const month = today.slice(0, 7);
  return [...paydaysOf(month)].reverse().find((d) => d <= today) ?? paydaysOf(monthPlus(month, -1))[PAYDAYS.length - 1];
}

/** The last day a payday covers: the day before it (the 14th for the 15th; the month's last day for the 1st). */
export function cutoffOf(payday: string): string {
  return addDays(payday, -1);
}

/** The Toronto day a row started counting, or null when it does not count (or is a payment). */
export function countedDayOf(row: Pick<PayRow, 'countedAt'>): string | null {
  if (row.countedAt === null) return null;
  const time = Date.parse(row.countedAt);
  return Number.isFinite(time) ? torontoDay(new Date(time)) : null;
}

/** Whether a row that counts belongs to a payday: dated before it, and counting by its day (decided late joins the next). */
export function inPayday(row: Pick<PayRow, 'kind' | 'day' | 'earnedCents' | 'countedAt'>, payday: string): boolean {
  if (row.kind === 'payment' || row.earnedCents === null || row.day === null || row.day >= payday) return false;
  const counted = countedDayOf(row);
  return counted === null || counted <= payday;
}

export interface DueOn {
  payday: string;
  /** The last day the payday covers. */
  cutoff: string;
  /** What counts for it: dated before it, counting by its day. */
  earnedCents: number;
  /** The payments subtracted: every one on record (ALL_PAYMENTS), or those dated through `paidThrough`. */
  paidCents: number;
  /** Earned minus paid; below zero when the payments went past it (then the balance reads "Paid ahead"). */
  dueCents: number;
}

/**
 * What is due on `payday` from these rows (one person's, balance.ts): the counted items dated before it and counting
 * by its day, minus the payments dated through `paidThrough` — every payment on record for what is still due now.
 */
export function dueOn(payday: string, rows: readonly PayRow[], paidThrough: string = ALL_PAYMENTS): DueOn {
  let earnedCents = 0;
  let paidCents = 0;
  for (const row of rows) {
    if (row.kind === 'payment') {
      if (row.paidCents !== null && row.day !== null && row.day <= paidThrough) paidCents += row.paidCents;
    } else if (inPayday(row, payday)) earnedCents += row.earnedCents as number;
  }
  return { payday, cutoff: cutoffOf(payday), earnedCents, paidCents, dueCents: earnedCents - paidCents };
}

/**
 * The head's second figure, in words (the admin's one word per state, §69.2): "$X" while something is due on the
 * payday; "Paid ahead $X" while the balance is below zero; "Settled" when nothing is due on it.
 */
export function dueWords(dueCents: number, balanceCents: number): { words: string; tone: 'due' | 'ahead' | 'settled' } {
  if (balanceCents < 0) return { words: `Paid ahead ${formatCents(-balanceCents)}`, tone: 'ahead' };
  if (dueCents <= 0) return { words: 'Settled', tone: 'settled' };
  return { words: formatCents(dueCents), tone: 'due' };
}

/** "Dec 1", "Nov 15": a payday as the head names it. */
export function paydayWords(payday: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(`${payday}T12:00:00Z`));
}

export interface PaydayMarker {
  payday: string;
  cutoff: string;
  /** Before today: what was due that morning (payments dated before it subtracted); today or ahead: what is due now. */
  dueCents: number;
  past: boolean;
}

/** The paydays of a month as the calendar marks them, each with what was (or is) due on it. */
export function paydayMarkers(month: string, rows: readonly PayRow[], today: string): PaydayMarker[] {
  return paydaysOf(month).map((payday) => {
    const past = payday < today;
    const due = dueOn(payday, rows, past ? cutoffOf(payday) : ALL_PAYMENTS);
    return { payday, cutoff: due.cutoff, dueCents: due.dueCents, past };
  });
}
