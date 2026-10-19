/**
 * The property list's Cleaning column (Kian's rulings of 2026-10-15, part A of PROPERTY-LIST-COLUMNS-PLAN.md): each
 * property's most pressing cleaning job, in one badge. Pure and dependency-free, like model.ts.
 *
 * It looks at the jobs with a checkout from 14 days back to 2 days ahead (jobs are made 2 days ahead: nothing later
 * exists). Its words are the Schedule's, and four of its own: Not marked, Amount needed, No turnover, Calendar not read.
 *
 *   red     a job with nobody on it, from its checkout day on (the Schedule's rule, needsCleanerNow in model.ts:
 *           the two pages never disagree); a checkout passed with someone on it who has not marked it cleaned (from
 *           the day after the checkout: on the day itself an unmarked job is the normal state)
 *   amber   a job ahead with nobody on it; a mark the office removed; a booking that changed after it was marked; a
 *           cleaning waiting for its amount
 *   blue    the next job, with someone on it
 *   green   the latest job done, nothing ahead
 *   words   no job in the days looked at
 *
 * With no job to show, a property whose calendar has no link, or could not be read in the last refresh, reads
 * "Calendar not read" in amber, never "No turnover" (Kian's ruling of 2026-10-17, admin home): no turnover is known
 * there. A job already made from an earlier read still shows as itself.
 *
 * A booking that changed before anyone marked it is not shown: it is not a problem.
 */

import { addDays, dayText } from '../availability/days';
import { changedAfterMark, changeWords, needsCleanerNow, type StoredJob } from './model';

/** How far back the column looks, and ahead: the furthest a job is made (CREATE_DAYS_AHEAD). */
export const COLUMN_DAYS_BACK = 14;
export const COLUMN_DAYS_AHEAD = 2;

/** A job as the column needs it: no IDs of cleaners or cleanings, no history. */
export interface HomeJob {
  propertyId: string;
  checkout: string;
  status: 'open' | 'booking-changed';
  /** The booking changed after a cleaner had marked the job: their cleaning stays, for an admin to decide. */
  changedAfterMark: boolean;
  /** What changed, in a few words ("Cancelled"); null while open. */
  change: string | null;
  cleaners: {
    /** Their name when assigned. */
    name: string | null;
    /** They marked it cleaned (a mark removed by the office stays a mark). */
    marked: boolean;
    /** The office removed the cleaning their mark made, and it has not been reopened. */
    removed: boolean;
    /** Their mark's cleaning is logged and waits for an admin to type its amount (37B). */
    pending: boolean;
  }[];
}

/** The cleanings marks made, as read: whether each is logged and has an amount. */
export type CleaningLookup = ReadonlyMap<string, { status: string | null; amountCents: number | null }>;

/** A stored job, made small for the column. */
export function homeJobOf(job: StoredJob, cleanings: CleaningLookup): HomeJob {
  return {
    propertyId: job.propertyId,
    checkout: job.checkout,
    status: job.status,
    changedAfterMark: changedAfterMark(job),
    change: job.status === 'booking-changed' ? changeWords(job.change) : null,
    cleaners: job.cleanerIds.map((cid) => {
      const a = job.assignments[cid];
      const removed = a.removedAt !== null;
      const cleaning = a.cleaningId !== null && !removed ? cleanings.get(a.cleaningId) : undefined;
      return { name: a.nameAtAssignment, marked: a.cleaningId !== null, removed, pending: cleaning?.status === 'logged' && cleaning.amountCents === null };
    }),
  };
}

export type CleaningTone = 'problem' | 'warning' | 'assigned' | 'done' | 'none';

export interface CleaningStanding {
  key: 'needs-now' | 'not-marked' | 'needs' | 'removed' | 'changed' | 'amount' | 'assigned' | 'done' | 'no-turnover' | 'not-read';
  label: string;
  tone: CleaningTone;
  /** The job's checkout; null for the quiet words. */
  day: string | null;
  /** The tooltip: the job, who is on it, and how many others need something. */
  title: string;
}

/** Most pressing first: the order the column picks in. */
const ORDER: CleaningStanding['key'][] = ['needs-now', 'not-marked', 'needs', 'removed', 'changed', 'amount', 'assigned', 'done'];

function standingOf(job: HomeJob, today: string): Omit<CleaningStanding, 'title'> | null {
  const day = job.checkout;
  if (job.status === 'booking-changed') return job.changedAfterMark ? { key: 'changed', label: 'Booking changed', tone: 'warning', day } : null;
  const on = job.cleaners.length;
  const marked = job.cleaners.filter((c) => c.marked).length;
  if (on === 0) return needsCleanerNow(day, today) ? { key: 'needs-now', label: 'Needs a cleaner', tone: 'problem', day } : { key: 'needs', label: 'Needs a cleaner', tone: 'warning', day };
  if (marked < on && day < today) return { key: 'not-marked', label: 'Not marked', tone: 'problem', day };
  if (job.cleaners.some((c) => c.removed)) return { key: 'removed', label: 'Removed by the office', tone: 'warning', day };
  if (marked < on) return { key: 'assigned', label: marked === 0 ? 'Assigned' : `${marked} of ${on} done`, tone: 'assigned', day };
  if (job.cleaners.some((c) => c.pending)) return { key: 'amount', label: 'Amount needed', tone: 'warning', day };
  return { key: 'done', label: 'Done', tone: 'done', day };
}

const DETAIL: Record<CleaningStanding['key'], string> = {
  'needs-now': 'checkout passed with nobody on it',
  'not-marked': 'checkout passed and not everyone on it has marked it cleaned',
  needs: 'nobody is on it yet',
  removed: 'the office removed a mark; reopen it for them from the Schedule, or leave it',
  changed: 'the booking changed after it was marked: its cleaning stays, charged as usual, for an admin to decide',
  amount: 'cleaned; its cleaning waits for an admin to type its amount',
  assigned: 'someone is on it',
  done: 'cleaned',
  'no-turnover': '',
  'not-read': '',
};

/**
 * One property's badge: the most pressing of its jobs in the days looked at. Of two of the same kind, a problem or a
 * warning shows the earliest (the longest waiting), Assigned the next one, Done the latest. `calendarRead` is false
 * when the last refresh could not read the property's calendar (absent: read).
 */
export function cleaningStanding(jobs: readonly HomeJob[], input: { today: string; hasCalendar: boolean; calendarRead?: boolean }): CleaningStanding {
  const from = addDays(input.today, -COLUMN_DAYS_BACK);
  const to = addDays(input.today, COLUMN_DAYS_AHEAD);
  const seen = jobs
    .filter((job) => job.checkout >= from && job.checkout <= to)
    .map((job) => ({ job, state: standingOf(job, input.today) }))
    .filter((x): x is { job: HomeJob; state: Omit<CleaningStanding, 'title'> } => x.state !== null);
  if (seen.length === 0) {
    if (!input.hasCalendar) return { key: 'not-read', label: 'Calendar not read', tone: 'warning', day: null, title: 'No calendar link, so no cleaning jobs' };
    if (input.calendarRead === false) return { key: 'not-read', label: 'Calendar not read', tone: 'warning', day: null, title: 'The last refresh could not read its calendar, so its turnovers are not known' };
    return { key: 'no-turnover', label: 'No turnover', tone: 'none', day: null, title: `No checkout from ${dayText(from)} to ${dayText(to)}` };
  }
  const rank = (key: CleaningStanding['key']) => ORDER.indexOf(key);
  seen.sort((a, b) => rank(a.state.key) - rank(b.state.key) || (a.state.key === 'done' ? b.job.checkout.localeCompare(a.job.checkout) : a.job.checkout.localeCompare(b.job.checkout)));
  const { job, state } = seen[0];
  const who = job.cleaners.length === 0 ? '' : ` · ${job.cleaners.map((c) => `${c.name ?? 'a deleted cleaner'}${c.removed ? ' (removed by the office)' : c.marked ? ' ✓' : ''}`).join(', ')}`;
  const others = seen.slice(1).filter((x) => x.state.tone === 'problem' || x.state.tone === 'warning').length;
  const more = others > 0 ? ` · +${others} more ${others === 1 ? 'needs' : 'need'} something` : '';
  const detail = state.key === 'needs-now' && job.checkout === input.today ? 'checkout today with nobody on it' : DETAIL[state.key];
  return { ...state, title: `Checkout ${dayText(job.checkout)}: ${detail}${who}${more}` };
}
