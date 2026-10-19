/**
 * The admin home's property list (Kian's rulings of 2026-10-17, admin home): each row's Next step, the chips that
 * filter the list, the Needs attention order, and the figures of the Statements due and Turnovers tiles. Pure and
 * client-safe: the page and tests/home/next-step.mjs run the same functions.
 *
 * Nothing here decides a statement, an amount or a job's state. What is owed comes from `reportingStatus`
 * (app/lib/reports/statement.ts), what waits for review and what is overdue from the Income column's read
 * (app/lib/income/standing.ts), what a job needs from the Cleaning column's (app/lib/schedule/standing.ts), each as
 * already decided; this only picks the most pressing and says where it is done.
 *
 * A statement is blocked when Finish would refuse it: its property has no Report For name, the one check Finish
 * refuses (Kian's rulings of 2026-10-12). Every statement owed — the month due and every month past due — is counted,
 * blocked or ready.
 *
 * The Next step, most pressing first (one per row):
 *   Assign a cleaner for <day>   a job from 14 days back to 2 ahead with nobody on it, the earliest
 *   Check <day> was cleaned      a job from 14 days back whose checkout passed, assigned, with someone on it who has
 *                                not marked it cleaned and whose mark the office did not remove, the earliest
 *                                ("Not marked", Kian's ruling R3 of 2026-10-19)
 *   Add Report For name          a statement owed while Finish would refuse it
 *   Review n Airbnb lines        the month due's lines waiting on the Income page
 *   Record direct payment        a direct payment overdue
 *   Finish <month>               the oldest statement owed
 *   Calendar not read            no calendar link, or the last refresh could not read it
 *   Up to date                   none of these
 * A turnover cannot wait; a turnover that passed unmarked is the next thing to check (no cleaning is recorded for it,
 * so its cleaner is not paid and its owner not charged); what a statement holds comes before finishing it; a calendar
 * not read is said last.
 */

import { addDays, dayText } from '@/app/lib/availability/days';
import { monthLabel, monthName } from '@/app/lib/reports/model';
import type { ReportingStatus } from '@/app/lib/reports/statement';
import type { DirectStanding } from '@/app/lib/direct/periods';
import { COLUMN_DAYS_AHEAD, COLUMN_DAYS_BACK, type HomeJob } from '@/app/lib/schedule/standing';

export type StepKey = 'assign' | 'not-marked' | 'report-for' | 'review' | 'direct' | 'finish' | 'calendar' | 'none';

/** Most pressing first: the order the step is picked in, and the Needs attention sort's. */
export const STEP_ORDER: readonly StepKey[] = ['assign', 'not-marked', 'report-for', 'review', 'direct', 'finish', 'calendar', 'none'];

export interface NextStep {
  key: StepKey;
  label: string;
  /** Where it is done; null for Up to date. */
  href: string | null;
  /** The tooltip: the detail, in a sentence. */
  title: string;
  /** The day or month it is about, for the order among rows with the same step; null when none. */
  when: string | null;
}

export type ChipKey = 'attention' | 'blocked' | 'ready' | 'review' | 'cleaner' | 'not-marked' | 'calendar' | 'direct';

/** The chips above the list, in Kian's order; "Not marked" beside "Needs a cleaner" (Kian's ruling R3 of 2026-10-19). */
export const CHIPS: readonly { key: ChipKey; label: string }[] = [
  { key: 'attention', label: 'Needs attention' },
  { key: 'blocked', label: 'Statements blocked' },
  { key: 'ready', label: 'Statements ready' },
  { key: 'review', label: 'Airbnb lines to review' },
  { key: 'cleaner', label: 'Needs a cleaner' },
  { key: 'not-marked', label: 'Not marked' },
  { key: 'calendar', label: 'Calendar not read' },
  { key: 'direct', label: 'Direct overdue' },
];

/** One property's facts, each as its own read decided it. */
export interface RowFacts {
  propertyId: string;
  /** Toronto. */
  today: string;
  /** Its statements' standing. */
  status: ReportingStatus;
  /** Its management record holds a Report For name. */
  hasReportFor: boolean;
  /** The month the Income column is about (the last closed one), and its lines waiting for review. */
  incomeMonth: string;
  review: number;
  /** Its direct payments in one word, when it has an arrangement. */
  direct: DirectStanding | null;
  /** Its cleaning jobs, as the Cleaning column reads them. */
  jobs: readonly HomeJob[];
  /** Its calendar has a link. */
  hasCalendarLink: boolean;
  /** The last refresh read its calendar. */
  calendarRead: boolean;
}

export interface RowView {
  step: NextStep;
  /** Which chips the row is under. */
  under: Record<ChipKey, boolean>;
  /** Its statements owed, oldest first: past due, then the month due. */
  owed: string[];
  /** Of those, how many Finish would refuse, and how many it would not. */
  blocked: number;
  ready: number;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const enc = encodeURIComponent;
const propertyMonth = (id: string, month: string, tab: string | null) => `/admin/property?id=${enc(id)}&month=${month}${tab ? `&tab=${tab}` : ''}`;

/** The month in a step's words: alone in the year it is in, with its year otherwise. */
const monthWords = (month: string, today: string) => (month.slice(0, 4) === today.slice(0, 4) ? monthName(month) : monthLabel(month));

/** Every statement the property owes now, oldest first: each month past due, then the month due. */
export function owedMonths(status: ReportingStatus): string[] {
  return [...status.pastDue, ...(status.previous.standing === 'due' ? [status.previous.month] : [])];
}

/** The jobs the Cleaning column looks at with nobody on them, earliest first. */
export function unstaffedJobs(jobs: readonly HomeJob[], today: string): HomeJob[] {
  const from = addDays(today, -COLUMN_DAYS_BACK);
  const to = addDays(today, COLUMN_DAYS_AHEAD);
  return jobs.filter((job) => job.status === 'open' && job.cleaners.length === 0 && job.checkout >= from && job.checkout <= to).sort((a, b) => a.checkout.localeCompare(b.checkout));
}

/**
 * The jobs the Cleaning column looks at whose checkout has passed with someone on them who has not marked them
 * cleaned, and whose mark the office did not remove: "Not marked" (Kian's ruling R3 of 2026-10-19), earliest first. A
 * mark the office removed is a mark (`marked`), so it is not one of these. A booking that changed is not a turnover.
 */
export function unmarkedJobs(jobs: readonly HomeJob[], today: string): HomeJob[] {
  const from = addDays(today, -COLUMN_DAYS_BACK);
  return jobs.filter((job) => job.status === 'open' && job.checkout < today && job.checkout >= from && job.cleaners.some((c) => !c.marked)).sort((a, b) => a.checkout.localeCompare(b.checkout));
}

/** One row: its Next step, the chips it is under, and its statements owed. */
export function rowView(f: RowFacts): RowView {
  const owed = owedMonths(f.status);
  const unstaffed = unstaffedJobs(f.jobs, f.today);
  const notMarked = unmarkedJobs(f.jobs, f.today);
  const overdue = f.direct?.state === 'overdue' ? f.direct : null;
  const blocked = f.hasReportFor ? 0 : owed.length;
  const ready = f.hasReportFor ? owed.length : 0;
  const owedText = owed.map(monthLabel).join(', ');

  let step: NextStep;
  if (unstaffed.length > 0) {
    const day = unstaffed[0].checkout;
    const from = day < addDays(f.today, -7) ? `&from=${day}` : '';
    const more = unstaffed.length > 1 ? ` · ${plural(unstaffed.length - 1, 'other job', 'other jobs')} too` : '';
    step = { key: 'assign', label: `Assign a cleaner for ${dayText(day)}`, href: `/admin/schedule?property=${enc(f.propertyId)}${from}`, title: `Checkout ${dayText(day)}: nobody is on it${more}`, when: day };
  } else if (notMarked.length > 0) {
    const job = notMarked[0];
    const who = job.cleaners.filter((c) => !c.marked).map((c) => c.name ?? 'a deleted cleaner').join(', ');
    const more = notMarked.length > 1 ? ` · ${plural(notMarked.length - 1, 'other job', 'other jobs')} too` : '';
    step = { key: 'not-marked', label: `Check ${dayText(job.checkout)} was cleaned`, href: `/admin/schedule?property=${enc(f.propertyId)}&from=${job.checkout}`, title: `Checkout ${dayText(job.checkout)}: not marked cleaned by ${who}${more}`, when: job.checkout };
  } else if (blocked > 0) {
    step = { key: 'report-for', label: 'Add Report For name', href: propertyMonth(f.propertyId, owed[0], 'details'), title: `${plural(owed.length, 'statement', 'statements')} owed (${owedText}): Finish refuses a statement with no Report For name`, when: owed[0] };
  } else if (f.review > 0) {
    step = { key: 'review', label: `Review ${plural(f.review, 'Airbnb line', 'Airbnb lines')}`, href: `/admin/income?month=${f.incomeMonth}&property=${enc(f.propertyId)}`, title: `${monthLabel(f.incomeMonth)}: ${plural(f.review, "line from Airbnb's file waits", "lines from Airbnb's file wait")} for review`, when: f.incomeMonth };
  } else if (overdue) {
    step = { key: 'direct', label: 'Record direct payment', href: propertyMonth(f.propertyId, overdue.month, null), title: `${overdue.wording}, ${monthLabel(overdue.month)}: overdue${overdue.overdueMonths > 1 ? ` · ${overdue.overdueMonths} months overdue` : ''}`, when: overdue.month };
  } else if (ready > 0) {
    step = { key: 'finish', label: `Finish ${monthWords(owed[0], f.today)}`, href: propertyMonth(f.propertyId, owed[0], 'finish'), title: `${plural(owed.length, 'statement', 'statements')} owed: ${owedText}`, when: owed[0] };
  } else if (!f.calendarRead) {
    step = { key: 'calendar', label: 'Calendar not read', href: `/admin/property/edit?id=${enc(f.propertyId)}&section=calendar`, title: f.hasCalendarLink ? 'The last refresh could not read its calendar: check its link' : 'No calendar link: no turnover is known', when: null };
  } else {
    step = { key: 'none', label: 'Up to date', href: null, title: 'Nothing to do', when: null };
  }

  return {
    step,
    owed,
    blocked,
    ready,
    under: {
      attention: step.key !== 'none',
      blocked: blocked > 0,
      ready: ready > 0,
      review: f.review > 0,
      cleaner: unstaffed.length > 0,
      'not-marked': notMarked.length > 0,
      calendar: !f.calendarRead,
      direct: overdue !== null,
    },
  };
}

/** A row as the Needs attention sort needs it. */
export interface Ranked {
  step: NextStep;
  /** The worst of its Statement, Income and Cleaning cells: 2 red, 1 amber, 0 neither. */
  worst: number;
  name: string;
}

/** Needs attention: by Next step, most pressing first; then its day or month, earliest first; then its worst cell; then its name. */
export function byAttention(a: Ranked, b: Ranked): number {
  const step = STEP_ORDER.indexOf(a.step.key) - STEP_ORDER.indexOf(b.step.key);
  if (step !== 0) return step;
  if (a.step.when !== b.step.when) return a.step.when === null ? 1 : b.step.when === null ? -1 : a.step.when.localeCompare(b.step.when);
  return b.worst - a.worst || a.name.localeCompare(b.name, 'en-CA');
}

/** Next checkout: the soonest first, a property with none last; then its name. */
export function byNextCheckout(a: { nextCheckout: string | null; name: string }, b: { nextCheckout: string | null; name: string }): number {
  if (a.nextCheckout !== b.nextCheckout) return a.nextCheckout === null ? 1 : b.nextCheckout === null ? -1 : a.nextCheckout.localeCompare(b.nextCheckout);
  return a.name.localeCompare(b.name, 'en-CA');
}

/**
 * The Statements due tile, over every property: every statement owed (the month due and every month past due),
 * blocked and ready, and the month due's finished ones. The rows' own counts are the same rule (`rowView`).
 */
export function statementFigures(items: readonly { status: ReportingStatus; hasReportFor: boolean }[]): { due: number; blocked: number; ready: number; finished: number } {
  let blocked = 0;
  let ready = 0;
  for (const { status, hasReportFor } of items) {
    const owed = owedMonths(status).length;
    if (hasReportFor) ready += owed;
    else blocked += owed;
  }
  return { due: blocked + ready, blocked, ready, finished: items.filter(({ status }) => status.previous.standing === 'finished').length };
}

/** How many days the Turnovers tile looks at: today and tomorrow. */
export const TURNOVER_DAYS = 2;

/** The Turnovers tile: open jobs with a checkout today or tomorrow, and how many have nobody on them. */
export function turnoverFigures(jobs: readonly HomeJob[], today: string): { count: number; needCleaner: number; from: string; to: string } {
  const to = addDays(today, TURNOVER_DAYS - 1);
  const ahead = jobs.filter((job) => job.status === 'open' && job.checkout >= today && job.checkout <= to);
  return { count: ahead.length, needCleaner: ahead.filter((job) => job.cleaners.length === 0).length, from: today, to };
}
