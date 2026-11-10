/**
 * "Not tracked by Nubnb" (Kian's ruling of 2026-11-10): one switch per unit. A unit that is not tracked is not part
 * of cleaning at all, owes no statement and raises no income gap; the home row and the property page say so in those
 * words. The mark is the one that already existed, `excludedFromReporting: true` on the server-only management record
 * (`property_management/{propertyId}`, dispatch 24); nothing is renamed or backfilled, and every reader that honoured
 * it keeps doing so. What is new is in the rules below, and in what the pages and the sync do with them.
 *
 *   - The calendar sync makes no job for a unit that is not tracked, and leaves the jobs it has exactly as they are.
 *   - Turning tracking off removes the unit's open, unmarked jobs (nobody has marked them cleaned: no cleaning, no
 *     money); a calendar job leaves the deleted-job marker the sync already honours (Build 2), with the reason
 *     `tracking-off`. A job that carries a mark stays, with its cleaning: counted cleanings and paid or printed
 *     history are never touched. A booking-changed job stays too: it is history, and shown nowhere as a warning.
 *   - Turning tracking on resumes from that day: the markers the switch-off wrote for checkouts from today on are
 *     cleared, so the next calendar read makes jobs for future checkouts; past ones stay out (the sync never makes a
 *     job for a day gone by), and nothing is backfilled. A marker an admin's own delete wrote is never cleared here.
 *   - Where jobs are listed (the home, the Schedule, a cleaner's app), a job on a unit that is not tracked is shown
 *     only when it carries a mark: a counted cleaning's record, never a cleaning warning.
 *
 * Pure and client-safe: the pages, the server and tests/schedule/tracking.mjs run the same functions. The one
 * Firestore-shaped function, `readUntracked`, takes the caller's Firestore and runs one query.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { PROPERTY_MANAGEMENT_COLLECTION, isExcludedFromReporting, type PropertyManagementView } from '../reports/model';
import { DELETED_JOB_SCHEMA_VERSION, type DeletedJobMarker, type JobActor, type StoredJob } from './model';

/** The words, the same everywhere a unit's tracking is shown. */
export const NOT_TRACKED = 'Not tracked by Nubnb';
export const NOT_TRACKED_BANNER = 'Not tracked by Nubnb: no cleaning, income or statements';
/** What Add a job answers for such a unit (Kian's words). */
export const ADD_JOB_NOT_TRACKED = 'This unit isn’t tracked. Turn tracking on first.';
/** What Finish answers: it owes no statement. */
export const FINISH_NOT_TRACKED = 'This unit isn’t tracked by Nubnb: it owes no statement.';
/** The reason on a deleted-job marker the switch-off wrote, which the switch-on clears for future checkouts. */
export const TRACKING_OFF_REASON = 'tracking-off';

/** Whether the unit is tracked by Nubnb: no record, or one without the mark. */
export function isTracked(record: Pick<PropertyManagementView, 'excludedFromReporting'> | null | undefined): boolean {
  return !isExcludedFromReporting(record);
}

/** The IDs of the units that are not tracked, from their records. */
export function untrackedIds(records: readonly Pick<PropertyManagementView, 'propertyId' | 'excludedFromReporting'>[]): Set<string> {
  return new Set(records.filter((record) => !isTracked(record)).map((record) => record.propertyId));
}

/** The one query: every management record carrying the mark, IDs only (a handful of small documents). */
export async function readUntracked(db: Firestore): Promise<Set<string>> {
  const snapshot = await db.collection(PROPERTY_MANAGEMENT_COLLECTION).where('excludedFromReporting', '==', true).select().get();
  return new Set(snapshot.docs.map((doc) => doc.id));
}

/** Whether anyone on the job has marked it cleaned (a mark the office removed is still a mark: its history stands). */
export function hasMark(job: Pick<StoredJob, 'cleanerIds' | 'assignments'>): boolean {
  return job.cleanerIds.some((cleanerId) => (job.assignments[cleanerId]?.cleaningId ?? null) !== null);
}

/** Whether a job is shown where a unit that is not tracked still appears: only with a mark (a counted cleaning's record). */
export function shownWhenUntracked(job: Pick<StoredJob, 'cleanerIds' | 'assignments'>): boolean {
  return hasMark(job);
}

/** The jobs a list shows: every job of a tracked unit; of a unit that is not tracked, only those with a mark. */
export function jobsShown<T extends Pick<StoredJob, 'propertyId' | 'cleanerIds' | 'assignments'>>(jobs: readonly T[], untracked: ReadonlySet<string>): T[] {
  return jobs.filter((job) => !untracked.has(job.propertyId) || shownWhenUntracked(job));
}

/** A cleaner's own list: every job of a tracked unit; of a unit that is not tracked, only those they marked themselves. */
export function cleanerJobsShown<T extends Pick<StoredJob, 'propertyId' | 'assignments'>>(jobs: readonly T[], cleanerId: string, untracked: ReadonlySet<string>): T[] {
  return jobs.filter((job) => !untracked.has(job.propertyId) || (job.assignments[cleanerId]?.cleaningId ?? null) !== null);
}

export type TrackingMarker = DeletedJobMarker & { id: string };

/**
 * Turning tracking off: which of the unit's jobs go, and the markers they leave. Open and unmarked goes; a calendar job
 * among them leaves a marker keyed by its turnover and holding its booking (the sync's own shape), with the reason
 * `tracking-off`; a job added by hand leaves none (the calendar never made it). Everything else is kept.
 */
export function planTrackingOff(jobs: readonly StoredJob[], actor: JobActor, nowIso: string): { remove: StoredJob[]; markers: TrackingMarker[]; kept: StoredJob[] } {
  const remove = jobs.filter((job) => job.status === 'open' && !hasMark(job));
  const kept = jobs.filter((job) => !remove.includes(job));
  const markers: TrackingMarker[] = remove
    .filter((job) => job.origin === 'calendar' && job.reservation !== null)
    .map((job) => ({
      id: job.id,
      schemaVersion: DELETED_JOB_SCHEMA_VERSION,
      propertyId: job.propertyId,
      checkout: job.checkout,
      reservation: { uid: (job.reservation as { uid: string; start: string }).uid, start: (job.reservation as { uid: string; start: string }).start },
      deletedAt: nowIso,
      deletedBy: actor,
      reason: TRACKING_OFF_REASON,
    }));
  return { remove, markers, kept };
}

/**
 * Turning tracking on, from `today` (Toronto): the markers the switch-off wrote for a checkout today or later are
 * cleared, so the next calendar read makes those jobs again; a marker for a day gone by stays (the sync would not make
 * that job anyway, and nothing is backfilled), and a marker an admin's own delete wrote is never touched.
 */
export function planTrackingOn(markers: readonly TrackingMarker[], today: string): { clear: string[]; kept: string[] } {
  const clear = markers.filter((marker) => marker.reason === TRACKING_OFF_REASON && marker.checkout >= today).map((marker) => marker.id);
  return { clear, kept: markers.filter((marker) => !clear.includes(marker.id)).map((marker) => marker.id) };
}

/** What a switch changed, for the page's words and the tests. */
export interface TrackingChange {
  tracked: boolean;
  jobsRemoved: number;
  markersWritten: number;
  markersCleared: number;
  /** Stored jobs or markers not in the written shape: left as they are, never guessed at. */
  unreadable: number;
}

/** The notice a switch earns, in one sentence. */
export function trackingWords(name: string, change: TrackingChange | null, tracked: boolean): string {
  if (!tracked) {
    const removed = change?.jobsRemoved ?? 0;
    return `${name} is not tracked by Nubnb: no cleaning, income or statements.${removed > 0 ? ` ${removed} open ${removed === 1 ? 'job was' : 'jobs were'} removed.` : ''}`;
  }
  return `${name} is tracked by Nubnb again. The next calendar read makes jobs for future checkouts only.`;
}
