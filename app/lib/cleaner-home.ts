/**
 * What the cleaner app's home and History show, worked out from what the start call and the entries list send (Kian's
 * rulings of 2026-10-16, in CLAUDE.md under *Cleaner app*, and his rulings of 2026-11-02, Build 1 of the UX audit):
 *
 *   - the jobs on the home screen: today's and tomorrow's (ruling 3), and before them any job whose checkout has
 *     passed that the cleaner can still mark — Mark cleaned holds from the checkout day on, within the 45 days their
 *     list reaches (the cleaning schedule, 2026-10-14), so a missed job is not hidden while it can still be marked —
 *     and stays there, cleaned, for the rest of the day it was marked, rather than vanishing under the cleaner's thumb;
 *     within a day a same-day turnover comes first (Build 1, item 1), then by checkout time;
 *   - the home's groups (Build 1): "Still to do" for a past job, then today, then tomorrow, each named once, so no
 *     card repeats the day;
 *   - the property a new receipt starts on (ruling 5): the job marked cleaned that day, else the soonest job today,
 *     else none;
 *   - History (ruling 7; Build 1, item 8): month by month, newest first, the jobs done and the entries sent;
 *   - what a changed booking's card says (Kian's ruling R2 of 2026-10-19): "Cancelled: don't go", "Moved to <day>",
 *     as one grey line (Build 1, item 7);
 *   - the grey words under "Cleaned" (Build 1, item 4): recorded by the office; why Undo is gone. Never an amount;
 *   - the first name on the top bar's menu (2026-11-05).
 *
 * Pure and client-safe: no clock read (`today` is the server's Toronto day, from the start call), no storage, no
 * network. tests/cleaner/home.mjs, tests/cleaner/build1.mjs and tests/cleaner/header.mjs run it with made-up data.
 */

import { addDays, torontoDay } from '@/app/lib/availability/days';
import { STATEMENTS_FROM_DEFAULT, addMonths } from '@/app/lib/reports/model';
import type { CleanerCleaning, CleanerEntry } from '@/app/lib/cleaners/model';
import type { CleanerJobView } from '@/app/lib/schedule/model';

/** The Toronto day of an instant ("2026-10-16"), or null when it is not one. */
export function torontoDayOf(iso: string | null): string | null {
  const time = Date.parse(iso ?? '');
  return Number.isFinite(time) ? torontoDay(new Date(time)) : null;
}

/** A listed time as minutes after midnight: "11:00 AM" → 660, "4 PM" → 960, "16:30" → 990; null when it is not a time. */
export function minutesOf(time: string | null): number | null {
  const match = /^\s*(\d{1,2})(?::(\d{2}))?\s*([AaPp])?\.?\s*[Mm]?\.?\s*$/.exec(time ?? '');
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2] ?? '0');
  const half = match[3]?.toUpperCase();
  if (minutes > 59 || (half ? hours < 1 || hours > 12 : hours > 23)) return null;
  if (!half && match[2] === undefined) return null;
  return ((half ? (hours % 12) + (half === 'P' ? 12 : 0) : hours) * 60) + minutes;
}

/** A same-day turnover: the next guest arrives on the checkout day, on a booking that still checks out then. */
export function isSameDayTurnover(job: Pick<CleanerJobView, 'status' | 'nextCheckIn' | 'checkout'>): boolean {
  return job.status === 'open' && job.nextCheckIn !== null && job.nextCheckIn === job.checkout;
}

/**
 * Soonest first: by checkout day, then a same-day turnover before the rest (Build 1, item 1), then by the property's
 * checkout time (one with none last), then by name. A changed booking, one grey line (item 7), goes under the day's
 * cards.
 */
function bySoonest(a: CleanerJobView, b: CleanerJobView): number {
  const at = (job: CleanerJobView) => minutesOf(job.checkOutTime) ?? 24 * 60;
  const sameDay = (job: CleanerJobView) => (isSameDayTurnover(job) ? 0 : 1);
  const changed = (job: CleanerJobView) => (job.status === 'booking-changed' && job.markedAt === null ? 1 : 0);
  return a.checkout.localeCompare(b.checkout) || changed(a) - changed(b) || sameDay(a) - sameDay(b) || at(a) - at(b) || (a.propertyName ?? '').localeCompare(b.propertyName ?? '', 'en-CA') || a.id.localeCompare(b.id);
}

/** A job whose checkout has passed, not marked, its booking unchanged, and markable now: still to do. */
function stillToMark(job: CleanerJobView, today: string): boolean {
  return job.checkout < today && job.markedAt === null && job.status === 'open' && job.markRefusal === null;
}

/** A job whose checkout has passed that was marked cleaned today: the day's work, on the home screen until tomorrow. */
function markedToday(job: CleanerJobView, today: string): boolean {
  return job.checkout < today && job.markedAt !== null && torontoDayOf(job.markedAt) === today;
}

/**
 * The jobs the home screen shows, soonest first: any from a day already past still to mark, or marked today, then
 * today's, then tomorrow's, marked or not. Nothing further ahead, and nothing marked on an earlier day: those are in
 * History.
 */
export function homeJobs(jobs: readonly CleanerJobView[], today: string): CleanerJobView[] {
  const tomorrow = addDays(today, 1);
  return jobs.filter((job) => job.checkout === today || job.checkout === tomorrow || stillToMark(job, today) || markedToday(job, today)).sort(bySoonest);
}

/** One group of the home screen (Build 1, item 1): its heading, said once, and its jobs in order. */
export interface HomeGroup {
  key: 'past' | 'today' | 'tomorrow';
  /** "Today · Sat, Nov 18". */
  heading: string;
  jobs: CleanerJobView[];
}

/** "Sat, Oct 24": a day as the cards name it. */
export const cardDay = (day: string) => new Intl.DateTimeFormat('en-CA', { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(`${day}T12:00:00`));

/**
 * The home's jobs in their groups: a past job still to do (or done today) under "Still to do", then today's, then
 * tomorrow's, each heading naming the day once (Build 1: no card repeats the day line). An empty group is left out.
 */
export function homeGroups(jobs: readonly CleanerJobView[], today: string): HomeGroup[] {
  const shown = homeJobs(jobs, today);
  const tomorrow = addDays(today, 1);
  const groups: HomeGroup[] = [
    { key: 'past', heading: 'Still to do', jobs: shown.filter((job) => job.checkout < today) },
    { key: 'today', heading: `Today · ${cardDay(today)}`, jobs: shown.filter((job) => job.checkout === today) },
    { key: 'tomorrow', heading: `Tomorrow · ${cardDay(tomorrow)}`, jobs: shown.filter((job) => job.checkout === tomorrow) },
  ];
  return groups.filter((group) => group.jobs.length > 0);
}

/**
 * The next guest, in the fewest words (Build 1, item 1): "Next guest today 4:00 PM", "Next guest tomorrow 4:00 PM" (a
 * same-day turnover on tomorrow's job), "Next guest Sun, Nov 19"; null when none is on the calendar.
 */
export function guestWords(job: Pick<CleanerJobView, 'nextCheckIn' | 'checkInTime' | 'checkout'>, today: string): string | null {
  if (!job.nextCheckIn) return null;
  const time = job.checkInTime ? ` ${job.checkInTime}` : '';
  if (job.nextCheckIn === job.checkout) {
    if (job.checkout === today) return `Next guest today${time}`;
    if (job.checkout === addDays(today, 1)) return `Next guest tomorrow${time}`;
    return `Next guest the same day${time}`;
  }
  if (job.nextCheckIn === today) return `Next guest today${time}`;
  if (job.nextCheckIn === addDays(today, 1)) return `Next guest tomorrow${time}`;
  return `Next guest ${cardDay(job.nextCheckIn)}`;
}

/** The property a receipt is for: its ID and its name for cleaners. */
export interface ReceiptProperty {
  id: string;
  name: string | null;
}

/**
 * The property a new receipt starts on (ruling 5): the job this cleaner marked cleaned today — the latest mark when
 * there are several; a mark the office removed does not count — else the soonest job of theirs checking out today
 * that is still to mark and whose booking is unchanged, else none, and the cleaner chooses it.
 */
export function receiptProperty(jobs: readonly CleanerJobView[], today: string): ReceiptProperty | null {
  const markedToday = jobs
    .filter((job) => job.markedAt !== null && job.markRefusal !== 'removed' && torontoDayOf(job.markedAt) === today)
    .sort((a, b) => (b.markedAt as string).localeCompare(a.markedAt as string) || a.id.localeCompare(b.id))[0];
  const job = markedToday ?? jobs.filter((j) => j.checkout === today && j.markedAt === null && j.status === 'open').sort(bySoonest)[0];
  return job ? { id: job.propertyId, name: job.propertyName } : null;
}

/**
 * One line of History: a job done within the 45 days their job list reaches (marked by them, the office's removal
 * included; its Undo and grey words come with it), a cleaning of theirs from further back, read from the cleanings
 * themselves (Kian's ruling H4 of 2026-11-02: every month back to the statements floor), or an entry they sent.
 */
export type HistoryItem =
  | { kind: 'job'; day: string; at: string; job: CleanerJobView }
  | { kind: 'cleaning'; day: string; at: string; cleaning: CleanerCleaning }
  | { kind: 'entry'; day: string | null; at: string; entry: CleanerEntry };

/**
 * History, newest first: each cleaning of theirs on its day — as its job when the job is in hand (the last 45 days:
 * Undo holds there), else as the cleaning itself — a marked job whose cleaning the read did not return (deleted by the
 * office: "Removed by the office"), and each entry they sent, on the day it was sent; within a day, the latest first.
 * An entry with no readable date goes last.
 */
export function historyItems(jobs: readonly CleanerJobView[], entries: readonly CleanerEntry[], cleanings: readonly CleanerCleaning[] = []): HistoryItem[] {
  const jobsById = new Map(jobs.filter((job) => job.markedAt !== null).map((job) => [job.id, job]));
  const inHand = new Map(jobs.map((job) => [job.id, job]));
  const covered = new Set<string>();
  const items: HistoryItem[] = [];
  for (const cleaning of cleanings) {
    const job = cleaning.jobId === null ? undefined : jobsById.get(cleaning.jobId);
    // A cleaning whose job is in hand and no longer marked was undone since the month was read (Build 3): it is gone.
    if (!job && cleaning.jobId !== null && inHand.get(cleaning.jobId)?.markedAt === null) continue;
    if (job) {
      covered.add(job.id);
      items.push({ kind: 'job', day: job.checkout, at: job.markedAt as string, job });
    } else {
      items.push({ kind: 'cleaning', day: cleaning.day, at: `${cleaning.day}T12:00:00.000Z`, cleaning });
    }
  }
  for (const job of jobsById.values()) {
    if (!covered.has(job.id)) items.push({ kind: 'job', day: job.checkout, at: job.markedAt as string, job });
  }
  for (const entry of entries) items.push({ kind: 'entry', day: torontoDayOf(entry.createdAt), at: entry.createdAt ?? '', entry });
  const idOf = (item: HistoryItem) => (item.kind === 'job' ? item.job.id : item.kind === 'cleaning' ? item.cleaning.id : item.entry.id);
  return items.sort((a, b) => (b.day ?? '').localeCompare(a.day ?? '') || b.at.localeCompare(a.at) || idOf(a).localeCompare(idOf(b)));
}

/** The month of a History item, yyyy-mm; an undated entry belongs to no month and is listed under the month shown. */
const monthOf = (item: HistoryItem): string | null => (item.day ? item.day.slice(0, 7) : null);

/**
 * The months History can show (Build 1, item 8), newest first: every month with an item, and this month even when it
 * is empty, so the switcher always opens on now.
 */
export function historyMonths(items: readonly HistoryItem[], today: string): string[] {
  const months = new Set<string>([today.slice(0, 7)]);
  for (const item of items) {
    const month = monthOf(item);
    if (month) months.add(month);
  }
  return [...months].sort((a, b) => b.localeCompare(a));
}

/**
 * The months History can show since it reads one month at a time (Build 3, Kian's ruling 7 of 2026-11-03), newest
 * first: every month from this one back to the statements floor (H4), whether or not it holds anything, so the switcher
 * always opens on now and reaches every month the floor allows.
 */
export function historyMonthRange(today: string, floor: string = STATEMENTS_FROM_DEFAULT): string[] {
  const months: string[] = [];
  for (let month = today.slice(0, 7); month >= floor && months.length < 600; month = addMonths(month, -1)) months.push(month);
  return months;
}

/** The items of one month, in History's order; items with no readable date go under the month shown when it is the newest. */
export function monthItems(items: readonly HistoryItem[], month: string, months: readonly string[]): HistoryItem[] {
  const newest = months[0];
  return items.filter((item) => monthOf(item) === month || (monthOf(item) === null && month === newest));
}

/** "November 2028": a month as the switcher names it. */
export function monthWords(month: string): string {
  return new Intl.DateTimeFormat('en-CA', { month: 'long', year: 'numeric' }).format(new Date(`${month}-15T12:00:00`));
}

/** A job card's badges (Kian's ruling of 2026-10-17), in this order: Today or Tomorrow by its checkout day; Same-day
 * turnover when the next guest arrives on the checkout day and the booking still checks out then (a cancelled or moved
 * booking has no turnover that day: its card says "Cancelled: don't go" or "Moved to <day>" alone); Cleaned once they
 * marked it (not a mark the office removed). Since Build 1 the cards carry only the same-day word; the day is the
 * group's heading and Cleaned the green line. Kept for the tests and for whatever reads it. */
export function jobBadges(job: CleanerJobView, today: string): string[] {
  const badges: string[] = [];
  if (job.checkout === today) badges.push('Today');
  if (job.checkout === addDays(today, 1)) badges.push('Tomorrow');
  if (isSameDayTurnover(job)) badges.push('Same-day turnover');
  if (job.markedAt !== null && job.markRefusal !== 'removed') badges.push('Cleaned');
  return badges;
}

/**
 * What a changed booking's card says in place of Mark cleaned (Kian's ruling R2 of 2026-10-19): a cancelled one,
 * "Cancelled: don't go"; a moved one, "Moved to <day>", the day it now checks out; any other change (its calendar
 * link changed or was removed, the property deleted), as before: "Don't go unless the office asks." `plain` is false
 * for those others, so the card keeps "Booking changed" beside the day.
 */
export function changedWords(job: Pick<CleanerJobView, 'change'>): { words: string; plain: boolean } {
  if (job.change?.kind === 'gone') return { words: 'Cancelled: don’t go', plain: true };
  if (job.change?.kind === 'moved' && job.change.movedTo) return { words: `Moved to ${cardDay(job.change.movedTo.end)}`, plain: true };
  return { words: 'Don’t go unless the office asks.', plain: false };
}

/**
 * The grey words under "Cleaned" (Build 1, item 4), when they apply: the office recorded it for them; why Undo is gone.
 * No amount, ever (ruling H). Nothing on a job whose Undo holds and which they marked themselves.
 */
export function cleanedWords(job: Pick<CleanerJobView, 'markedAt' | 'markRefusal' | 'canUndo' | 'undoBlocked' | 'recordedByOffice'>): string[] {
  if (job.markedAt === null || job.markRefusal === 'removed') return [];
  const words: string[] = [];
  if (job.recordedByOffice) words.push('Recorded by the office');
  if (!job.canUndo && job.undoBlocked === 'paid') words.push('Can’t undo: already paid');
  if (!job.canUndo && job.undoBlocked === 'statement') words.push('Can’t undo: on a statement');
  return words;
}

/**
 * The name on the top bar (Kian's instruction of 2026-11-05: "the person's first name with a small chevron on the
 * right"): the first word of the name the office gave them, as typed. Null when there is none; the bar then says
 * "Account".
 */
export function firstNameOf(name: string | null | undefined): string | null {
  const first = (name ?? '').trim().split(/\s+/)[0] ?? '';
  return first === '' ? null : first;
}
