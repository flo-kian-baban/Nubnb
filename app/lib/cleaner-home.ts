/**
 * What the cleaner app's home and History show, worked out from what the start call and the entries list send (Kian's
 * rulings of 2026-10-16, in CLAUDE.md under *Cleaner app*):
 *
 *   - the jobs on the home screen: today's and tomorrow's (ruling 3), and before them any job whose checkout has
 *     passed that the cleaner can still mark — Mark cleaned holds from the checkout day on, within the 45 days their
 *     list reaches (the cleaning schedule, 2026-10-14), so a missed job is not hidden while it can still be marked —
 *     and stays there, cleaned, for the rest of the day it was marked, rather than vanishing under the cleaner's thumb;
 *   - the property a new receipt starts on (ruling 5): the job marked cleaned that day, else the soonest job today,
 *     else none;
 *   - History (ruling 7): the jobs done and the entries sent, newest first, by day;
 *   - the badges on a job's card (Kian's ruling of 2026-10-17): Today, Tomorrow, Same-day turnover, Cleaned.
 *
 * Pure and client-safe: no clock read (`today` is the server's Toronto day, from the start call), no storage, no
 * network. tests/cleaner/home.mjs runs it with made-up jobs.
 */

import { addDays, torontoDay } from '@/app/lib/availability/days';
import type { CleanerEntry } from '@/app/lib/cleaners/model';
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

/** Soonest first: by checkout day, then by the property's checkout time (one with none last), then by name. */
function bySoonest(a: CleanerJobView, b: CleanerJobView): number {
  const at = (job: CleanerJobView) => minutesOf(job.checkOutTime) ?? 24 * 60;
  return a.checkout.localeCompare(b.checkout) || at(a) - at(b) || (a.propertyName ?? '').localeCompare(b.propertyName ?? '', 'en-CA') || a.id.localeCompare(b.id);
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

/** One line of History: a job done (marked by them, the office's removal included), or an entry they sent. */
export type HistoryItem =
  | { kind: 'job'; day: string; at: string; job: CleanerJobView }
  | { kind: 'entry'; day: string | null; at: string; entry: CleanerEntry };

/**
 * History, newest first: each job they marked, on its checkout day (a cleaning's day), and each entry they sent, on
 * the day it was sent; within a day, the latest first. An entry with no readable date goes last.
 */
export function historyItems(jobs: readonly CleanerJobView[], entries: readonly CleanerEntry[]): HistoryItem[] {
  const items: HistoryItem[] = [
    ...jobs.filter((job) => job.markedAt !== null).map((job): HistoryItem => ({ kind: 'job', day: job.checkout, at: job.markedAt as string, job })),
    ...entries.map((entry): HistoryItem => ({ kind: 'entry', day: torontoDayOf(entry.createdAt), at: entry.createdAt ?? '', entry })),
  ];
  const idOf = (item: HistoryItem) => (item.kind === 'job' ? item.job.id : item.entry.id);
  return items.sort((a, b) => (b.day ?? '').localeCompare(a.day ?? '') || b.at.localeCompare(a.at) || idOf(a).localeCompare(idOf(b)));
}

/** A job card's badges (Kian's ruling of 2026-10-17), in this order: Today or Tomorrow by its checkout day; Same-day
 * turnover when the next guest arrives on the checkout day; Cleaned once they marked it (not a mark the office removed). */
export function jobBadges(job: CleanerJobView, today: string): string[] {
  const badges: string[] = [];
  if (job.checkout === today) badges.push('Today');
  if (job.checkout === addDays(today, 1)) badges.push('Tomorrow');
  if (job.nextCheckIn !== null && job.nextCheckIn === job.checkout) badges.push('Same-day turnover');
  if (job.markedAt !== null && job.markRefusal !== 'removed') badges.push('Cleaned');
  return badges;
}
