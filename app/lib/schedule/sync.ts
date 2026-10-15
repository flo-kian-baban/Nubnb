/**
 * What one run of the calendar copy does to the jobs: which to make, which
 * changed. Pure: the copy just written and the jobs already stored go in, a
 * plan comes out, and store.ts writes it. The Cloud Function and Refresh now
 * run the same plan (Kian's rulings of 2026-10-14: the hourly copy deploys
 * with the job sync inside it; until then, jobs come from Refresh now only).
 *
 * ── Made ──
 * A job for every reservation ending today, tomorrow or the day after
 * (Toronto), on a calendar this run read. Only `Reserved` events: an owner
 * block, Airbnb's prep nights and the booking-window tail are all "Airbnb
 * (Not available)" and never make a job (ruling 1).
 *
 * ── Watched, through the checkout day ──
 * An open job becomes "booking changed" when no reservation ends on its day
 * any more (ruling 8): `moved` when its UID is still on the calendar with
 * other days, `calendar-changed` when the property's link changed,
 * `calendar-removed` when it has none, `property-deleted`, else `gone`.
 * Another reservation still ending that day keeps the job open, the swap in
 * its history (Kian's ruling of the evening, recommendation 1). A changed job
 * reopens if a reservation ends on its day again. After the checkout day
 * nothing changes: Airbnb drops a stay from the feed within a day of its
 * checkout, which is not a change.
 *
 * ── Skipped ──
 * A calendar this run could not read: the copy keeps its last events, marked
 * failed, and old events never make or change a job.
 */

import { addDays } from '../availability/days';
import type { AvailabilityEvent, AvailabilitySnapshot } from '../availability/types';
import {
  CALENDAR_ACTOR,
  CREATE_DAYS_AHEAD,
  JOB_SCHEMA_VERSION,
  jobEvent,
  jobIdOf,
  type ChangeKind,
  type CleaningJob,
  type JobEvent,
  type StoredJob,
} from './model';

/** Whether this run read the property's calendar (a failed read keeps the copy's old events, marked failed). */
export function readThisRun(snapshot: AvailabilitySnapshot, propertyId: string): boolean {
  const entry = snapshot.properties[propertyId];
  return !!entry && entry.status === 'ok' && entry.fetchedAt === snapshot.refreshedAt;
}

const reservationsOf = (events: readonly AvailabilityEvent[]) => events.filter((event) => event.kind === 'reserved');

/** The next stay's first night on or after `checkout`, not counting the stay that ends there. */
export function nextCheckInOf(reserved: readonly AvailabilityEvent[], checkout: string, endingUid: string | null): string | null {
  let next: string | null = null;
  for (const stay of reserved) {
    if (stay.uid === endingUid || stay.start < checkout) continue;
    if (next === null || stay.start < next) next = stay.start;
  }
  return next;
}

export interface PlannedCreate {
  id: string;
  job: CleaningJob;
}

/**
 * The jobs to make: one per reservation checking out in the next
 * CREATE_DAYS_AHEAD days, today included, on a calendar read this run, where
 * no job exists yet. `existing` holds every stored job's ID from today on.
 */
export function planCreates(input: { snapshot: AvailabilitySnapshot; existing: ReadonlySet<string>; keys: ReadonlyMap<string, string>; nowIso: string }): PlannedCreate[] {
  const { snapshot, existing, keys, nowIso } = input;
  const today = snapshot.today;
  const last = addDays(today, CREATE_DAYS_AHEAD);
  const planned: PlannedCreate[] = [];
  const ids = new Set<string>();
  for (const propertyId of Object.keys(snapshot.properties).sort()) {
    if (!readThisRun(snapshot, propertyId)) continue;
    const feed = snapshot.properties[propertyId];
    const reserved = reservationsOf(feed.events);
    for (const stay of reserved) {
      if (stay.end < today || stay.end > last) continue;
      const id = jobIdOf(propertyId, stay.end);
      if (existing.has(id) || ids.has(id)) continue;
      ids.add(id);
      planned.push({
        id,
        job: {
          schemaVersion: JOB_SCHEMA_VERSION,
          propertyId,
          propertyNameAtCreation: feed.name || null,
          checkout: stay.end,
          reservation: { uid: stay.uid, start: stay.start },
          calendarKey: keys.get(propertyId) ?? '',
          nextCheckIn: nextCheckInOf(reserved, stay.end, stay.uid),
          status: 'open',
          change: null,
          cleanerIds: [],
          assignments: {},
          createdAt: nowIso,
          history: [jobEvent(nowIso, 'created', CALENDAR_ACTOR, { after: { start: stay.start, end: stay.end } })],
        },
      });
    }
  }
  return planned;
}

/** What a run changes on one stored job: the fields written, and the history events appended. */
export interface JobPatch {
  fields: Partial<Pick<CleaningJob, 'status' | 'change' | 'reservation' | 'calendarKey' | 'nextCheckIn'>>;
  events: JobEvent[];
}

function bookingChanged(job: StoredJob, kind: ChangeKind, movedTo: { start: string; end: string } | null, nowIso: string): JobPatch {
  return {
    fields: { status: 'booking-changed', change: { kind, at: nowIso, movedTo } },
    events: [jobEvent(nowIso, 'booking-changed', CALENDAR_ACTOR, { change: kind, before: { start: job.reservation.start, end: job.checkout }, after: movedTo })],
  };
}

/**
 * What this run changes on one stored job, or null for nothing. `key` is the
 * calendar key of the property's link as this run read it (null: the
 * property is not in the copy at all).
 */
export function planJob(job: StoredJob, snapshot: AvailabilitySnapshot, key: string | null, nowIso: string): JobPatch | null {
  // Settled from the day after checkout.
  if (job.checkout < snapshot.today) return null;
  const feed = snapshot.properties[job.propertyId];
  if (!feed) return job.status === 'open' ? bookingChanged(job, 'property-deleted', null, nowIso) : null;
  if (feed.status === 'no-feed' || !feed.icalUrl) return job.status === 'open' ? bookingChanged(job, 'calendar-removed', null, nowIso) : null;
  if (!readThisRun(snapshot, job.propertyId)) return null;

  const reserved = reservationsOf(feed.events);
  const ending = reserved.find((stay) => stay.end === job.checkout) ?? null;
  const linkNow = key ?? '';

  if (job.status === 'booking-changed') {
    if (!ending) return null;
    return {
      fields: { status: 'open', change: null, reservation: { uid: ending.uid, start: ending.start }, calendarKey: linkNow, nextCheckIn: nextCheckInOf(reserved, job.checkout, ending.uid) },
      events: [jobEvent(nowIso, 'reopened', CALENDAR_ACTOR, { before: null, after: { start: ending.start, end: ending.end } })],
    };
  }

  if (!ending) {
    if (linkNow !== job.calendarKey) return bookingChanged(job, 'calendar-changed', null, nowIso);
    const same = reserved.find((stay) => stay.uid === job.reservation.uid);
    if (same) return bookingChanged(job, 'moved', { start: same.start, end: same.end }, nowIso);
    return bookingChanged(job, 'gone', null, nowIso);
  }

  const fields: JobPatch['fields'] = {};
  const events: JobEvent[] = [];
  if (ending.uid !== job.reservation.uid) {
    // Same day, another reservation: the turnover stands (recommendation 1).
    fields.reservation = { uid: ending.uid, start: ending.start };
    if (linkNow !== job.calendarKey) fields.calendarKey = linkNow;
    events.push(jobEvent(nowIso, 'reservation-replaced', CALENDAR_ACTOR, { reason: linkNow !== job.calendarKey ? 'the calendar link changed' : null, before: { start: job.reservation.start, end: job.checkout }, after: { start: ending.start, end: ending.end } }));
  } else {
    if (ending.start !== job.reservation.start) {
      fields.reservation = { uid: ending.uid, start: ending.start };
      events.push(jobEvent(nowIso, 'check-in-moved', CALENDAR_ACTOR, { before: { start: job.reservation.start, end: job.checkout }, after: { start: ending.start, end: ending.end } }));
    }
    if (linkNow !== job.calendarKey) {
      fields.calendarKey = linkNow;
      events.push(jobEvent(nowIso, 'calendar-relinked', CALENDAR_ACTOR));
    }
  }
  const next = nextCheckInOf(reserved, job.checkout, ending.uid);
  if (next !== job.nextCheckIn) {
    fields.nextCheckIn = next;
    events.push(jobEvent(nowIso, 'next-check-in-changed', CALENDAR_ACTOR, { before: { start: job.nextCheckIn, end: null }, after: { start: next, end: null } }));
  }
  return events.length > 0 ? { fields, events } : null;
}
