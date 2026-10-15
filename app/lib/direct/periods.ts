/**
 * An arrangement's months (part B of PROPERTY-LIST-COLUMNS-PLAN.md, §5; Kian's rulings of 2026-10-15): what each
 * month expects, what it has received, and its state. Worked out, never stored. The property page, the Income page,
 * the property list's Income column and Finish's check all read this one function. Pure and client-safe.
 *
 *   expected      its due day has not passed and nothing has been received for it
 *   partly paid   something has been received for it, less than expected, and its due day has not passed
 *   paid          what it expects has been received
 *   overdue       its due day has passed (from the day after) and it is not fully paid
 *
 * The months: from the arrangement's first month to its last (or to today's month while it runs), less the months
 * it is paused. Each month expects the amount in force from that month on: earlier months keep theirs.
 *
 * The payments (Kian's ruling: monthly periods only; a part payment goes to the oldest unpaid month first,
 * changeable; an overpayment waits for the next month): a payment the admin set months for pays those, as set; every
 * other pays the oldest month not yet paid, in the order received. What is left waits as credit, and pays the next
 * month once that month is expected. Only received money is income; none of this reaches a statement, which prints
 * each payment in the month it was received.
 */

import { addMonths, monthLabel, monthOfDay } from '@/app/lib/reports/model';
import type { ArrangementView, DirectPaymentView } from './model';

export type PeriodState = 'expected' | 'partly' | 'paid' | 'overdue';
export const PERIOD_STATE_LABELS: Record<PeriodState, string> = { expected: 'Expected', partly: 'Partly paid', paid: 'Paid', overdue: 'Overdue' };

export interface Period {
  month: string;
  /** The day it is due, yyyy-mm-dd; overdue from the day after. */
  dueDate: string;
  expectedCents: number;
  receivedCents: number;
  state: PeriodState;
  /** The payments that pay it, and how much of each. */
  paidBy: { paymentId: string; cents: number }[];
}

export type ArrangementStatus = 'upcoming' | 'running' | 'paused' | 'ended';
export const ARRANGEMENT_STATUS_LABELS: Record<ArrangementStatus, string> = { upcoming: 'Starts later', running: 'Running', paused: 'Paused', ended: 'Ended' };

export interface ArrangementMonths {
  arrangementId: string;
  status: ArrangementStatus;
  /** Every month expected through today's (or through its last month once ended), oldest first. */
  periods: Period[];
  /** Received and not owed to any month yet: it pays the next month expected. */
  creditCents: number;
  /** The next month expected after today's, if any: the one credit waits for. */
  nextMonth: string | null;
  /** How each payment of the arrangement was applied, by payment ID: the months and amounts, and credit. */
  applied: Map<string, { parts: { month: string; cents: number }[]; creditCents: number }>;
}

/** Whether a month falls in one of the arrangement's pauses. */
export function isPausedIn(arrangement: Pick<ArrangementView, 'pauses'>, month: string): boolean {
  return arrangement.pauses.some((p) => month >= p.from && (p.until === null || month <= p.until));
}

/** The amount a month expects: the latest change from that month or before. */
export function amountFor(arrangement: Pick<ArrangementView, 'amounts'>, month: string): number {
  let cents = arrangement.amounts[0].cents;
  for (const a of arrangement.amounts) if (a.from <= month) cents = a.cents;
  return cents;
}

/** Whether a month is one the arrangement expects: in its span and not paused. */
export function isExpectedMonth(arrangement: Pick<ArrangementView, 'fromMonth' | 'untilMonth' | 'pauses'>, month: string): boolean {
  return month >= arrangement.fromMonth && (arrangement.untilMonth === null || month <= arrangement.untilMonth) && !isPausedIn(arrangement, month);
}

/** The day a month is due: the due day, which every month has (1–28). */
export function dueDateOf(month: string, dueDay: number): string {
  return `${month}-${String(dueDay).padStart(2, '0')}`;
}

/** The arrangement's status in today's month. */
export function arrangementStatus(arrangement: Pick<ArrangementView, 'fromMonth' | 'untilMonth' | 'pauses'>, today: string): ArrangementStatus {
  const now = monthOfDay(today);
  if (arrangement.untilMonth !== null && arrangement.untilMonth < now) return 'ended';
  if (arrangement.fromMonth > now) return 'upcoming';
  return isPausedIn(arrangement, now) ? 'paused' : 'running';
}

const byReceived = (a: DirectPaymentView, b: DirectPaymentView) => a.day.localeCompare(b.day) || a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id);

/** One arrangement's months, from its recorded payments, as of `today` (Toronto). */
export function arrangementMonths(arrangement: ArrangementView, payments: readonly DirectPaymentView[], today: string): ArrangementMonths {
  const now = monthOfDay(today);
  const last = arrangement.untilMonth !== null && arrangement.untilMonth < now ? arrangement.untilMonth : now;
  const periods: Period[] = [];
  for (let month = arrangement.fromMonth, i = 0; month <= last && i < 1_200; month = addMonths(month, 1), i += 1) {
    if (!isExpectedMonth(arrangement, month)) continue;
    periods.push({ month, dueDate: dueDateOf(month, arrangement.dueDay), expectedCents: amountFor(arrangement, month), receivedCents: 0, state: 'expected', paidBy: [] });
  }
  const byMonth = new Map(periods.map((p) => [p.month, p]));
  const applied = new Map<string, { parts: { month: string; cents: number }[]; creditCents: number }>();
  let creditCents = 0;
  const mine = payments.filter((p) => p.arrangementId === arrangement.id && p.status === 'recorded').sort(byReceived);

  // The months the admin set, as set; a month not expected (yet) holds it as credit.
  for (const payment of mine) {
    if (payment.appliesTo === null) continue;
    const parts: { month: string; cents: number }[] = [];
    let credit = 0;
    for (const part of payment.appliesTo) {
      const period = byMonth.get(part.month);
      if (period) {
        period.receivedCents += part.cents;
        period.paidBy.push({ paymentId: payment.id, cents: part.cents });
        parts.push({ month: part.month, cents: part.cents });
      } else credit += part.cents;
    }
    creditCents += credit;
    applied.set(payment.id, { parts, creditCents: credit });
  }
  // Every other payment: the oldest month not yet paid first, in the order received; what is left waits as credit.
  for (const payment of mine) {
    if (payment.appliesTo !== null) continue;
    let left = payment.amountCents;
    const parts: { month: string; cents: number }[] = [];
    for (const period of periods) {
      if (left === 0) break;
      const owed = period.expectedCents - period.receivedCents;
      if (owed <= 0) continue;
      const cents = Math.min(owed, left);
      period.receivedCents += cents;
      period.paidBy.push({ paymentId: payment.id, cents });
      parts.push({ month: period.month, cents });
      left -= cents;
    }
    creditCents += left;
    applied.set(payment.id, { parts, creditCents: left });
  }

  for (const period of periods) {
    period.state = period.receivedCents >= period.expectedCents ? 'paid' : today > period.dueDate ? 'overdue' : period.receivedCents > 0 ? 'partly' : 'expected';
  }
  let nextMonth: string | null = null;
  for (let month = addMonths(now, 1), i = 0; i < 24; month = addMonths(month, 1), i += 1) {
    if (arrangement.untilMonth !== null && month > arrangement.untilMonth) break;
    if (isExpectedMonth(arrangement, month)) {
      nextMonth = month;
      break;
    }
  }
  return { arrangementId: arrangement.id, status: arrangementStatus(arrangement, today), periods, creditCents, nextMonth, applied };
}

// ─── What the pages say ────────────────────────────────────────

/** A property's direct payments in one word, for the property list's Income column: the worst of its arrangements. */
export interface DirectStanding {
  state: PeriodState | 'paused';
  /** The month the word is about. */
  month: string;
  /** Its due day, for Expected. */
  dueDate: string | null;
  expectedCents: number;
  receivedCents: number;
  /** The arrangement's words, for the tooltip: "Monthly stay". */
  wording: string;
  /** How many months are overdue, across its arrangements. */
  overdueMonths: number;
}

const RANK: Record<DirectStanding['state'], number> = { overdue: 4, partly: 3, expected: 2, paid: 1, paused: 0 };

/**
 * A property's standing across its arrangements that run, are paused, or start later: the oldest overdue month; else
 * this month's state (partly paid, then expected, then paid); else paused. null when it has none of them.
 */
export function directStanding(arrangements: readonly ArrangementView[], payments: readonly DirectPaymentView[], today: string): DirectStanding | null {
  const now = monthOfDay(today);
  let best: DirectStanding | null = null;
  let overdueMonths = 0;
  for (const arrangement of arrangements) {
    const months = arrangementMonths(arrangement, payments, today);
    if (months.status === 'ended') {
      // An ended arrangement still owes what it did not receive.
      const owed = months.periods.filter((p) => p.state === 'overdue');
      overdueMonths += owed.length;
      if (owed.length > 0) best = pick(best, { state: 'overdue', month: owed[0].month, dueDate: owed[0].dueDate, expectedCents: owed[0].expectedCents, receivedCents: owed[0].receivedCents, wording: arrangement.wording, overdueMonths: 0 });
      continue;
    }
    const overdue = months.periods.filter((p) => p.state === 'overdue');
    overdueMonths += overdue.length;
    let here: DirectStanding;
    if (overdue.length > 0) {
      const p = overdue[0];
      here = { state: 'overdue', month: p.month, dueDate: p.dueDate, expectedCents: p.expectedCents, receivedCents: p.receivedCents, wording: arrangement.wording, overdueMonths: 0 };
    } else if (months.status === 'upcoming') {
      here = { state: 'expected', month: arrangement.fromMonth, dueDate: dueDateOf(arrangement.fromMonth, arrangement.dueDay), expectedCents: amountFor(arrangement, arrangement.fromMonth), receivedCents: 0, wording: arrangement.wording, overdueMonths: 0 };
    } else if (months.status === 'paused') {
      here = { state: 'paused', month: now, dueDate: null, expectedCents: 0, receivedCents: 0, wording: arrangement.wording, overdueMonths: 0 };
    } else {
      const p = months.periods.find((period) => period.month === now);
      if (!p) continue;
      here = { state: p.state, month: p.month, dueDate: p.dueDate, expectedCents: p.expectedCents, receivedCents: p.receivedCents, wording: arrangement.wording, overdueMonths: 0 };
    }
    best = pick(best, here);
  }
  return best ? { ...best, overdueMonths } : null;
}

function pick(a: DirectStanding | null, b: DirectStanding): DirectStanding {
  if (!a) return b;
  if (RANK[b.state] !== RANK[a.state]) return RANK[b.state] > RANK[a.state] ? b : a;
  return b.month < a.month ? b : a;
}

/**
 * The month's expected payments not fully received, for Finish's warning: every arrangement of the property that
 * expects the month, with what it expects and what it has received. A month the arrangement does not expect, or one
 * fully paid, is not listed.
 */
export function unpaidInMonth(arrangements: readonly ArrangementView[], payments: readonly DirectPaymentView[], month: string, today: string): { wording: string; payerName: string; expectedCents: number; receivedCents: number; state: PeriodState }[] {
  // As of today: a month after today's expects nothing yet, and is not listed.
  const out: { wording: string; payerName: string; expectedCents: number; receivedCents: number; state: PeriodState }[] = [];
  for (const arrangement of arrangements) {
    if (!isExpectedMonth(arrangement, month)) continue;
    const period = arrangementMonths(arrangement, payments, today).periods.find((p) => p.month === month);
    if (period && period.state !== 'paid') out.push({ wording: arrangement.wording, payerName: arrangement.payerName, expectedCents: period.expectedCents, receivedCents: period.receivedCents, state: period.state });
  }
  return out;
}

/** "Partly paid · October", "Expected · Oct 20". */
export function periodWords(state: PeriodState, month: string): string {
  return `${PERIOD_STATE_LABELS[state]} · ${monthLabel(month)}`;
}
