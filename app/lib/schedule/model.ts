/**
 * The cleaning schedule, phase 1 (Kian's rulings of 2026-10-14, in CLAUDE.md
 * under *Cleaning schedule*): the job, its assignments, and how a page reads
 * them. Pure and dependency-free, like app/lib/availability, so the hourly
 * Cloud Function runs this same code (scripts/functions-sync.mjs copies the
 * folder in): nothing here imports Next, Firebase or anything under `@/`.
 *
 * A job is one property's turnover: `cleaning_jobs/{propertyId}_{checkout}`,
 * made two days before an Airbnb reservation's checkout from the property's
 * calendar copy (sync.ts), never from an owner block, never for a property
 * without a calendar link. The ID is the turnover itself, so one property has
 * at most one job a day and two runs at once cannot make two.
 *
 * ── What a job keeps of the booking ──
 * The reservation's UID (Airbnb's opaque event ID, stable across alterations:
 * CLEANING-SCHEDULE-PLAN.md §4) and its first night; never the DESCRIPTION,
 * which holds the reservation link and the guest's phone digits. The link it
 * was read from is kept only as `calendarKey`, the first ten hex of its
 * SHA-256 (store.ts): enough to tell that the link changed, never the link.
 *
 * ── Assignments and cleanings ──
 * Admins assign active cleaners (Kian's ruling 2). Each assignment is keyed by
 * the cleaner, so each marks their own (ruling 5). Mark cleaned makes a 37B
 * cleaning at once; the assignment keeps its ID, and the cleaning keeps the
 * job's (`jobId`): jobs link cleanings to bookings (Kian's ruling of the
 * evening). Undo deletes the cleaning and keeps the trail here: who marked,
 * when, which cleaning, and its amount (Kian's answer of the evening).
 *
 * ── Removed by the office ──
 * When an admin deletes a job's cleaning, the job keeps the mark as "removed
 * by the office", and that cleaner cannot mark it again; an admin can reopen
 * it for them from the Schedule, recorded in the job's history (Kian's ruling
 * of 2026-10-14, night). A cleaning the office removes, rather than deletes,
 * leaves the mark the same way.
 *
 * ── Booking changed ──
 * A job whose reservation disappears or moves is marked "booking changed",
 * never deleted (ruling 8); it is watched through its checkout day, then
 * settled. One whose day still ends a reservation under a new UID keeps the
 * job (Kian's ruling of the evening, recommendation 1).
 *
 * Every document keeps the shape it was written with: readers are strict, and
 * a job not in shape is reported, never guessed at.
 */

import { addDays, dayText } from '../availability/days';

export const CLEANING_JOBS_COLLECTION = 'cleaning_jobs';
export const JOB_SCHEMA_VERSION = 1;

/** A job is made this many days before its checkout (Kian's ruling 1: two days). */
export const CREATE_DAYS_AHEAD = 2;
/** How far back a cleaner's list reaches (Kian's answer of 2026-10-14, evening): older unprinted cleanings are the office's. */
export const CLEANER_LIST_DAYS = 45;

/** Who did something to a job: the same shape as the cleaners' `Actor`, written out here so the function needs no app import. */
export interface JobActor {
  role: 'admin' | 'cleaner' | 'handyman' | 'system';
  id: string | null;
  name: string | null;
}

/** The schedule's own runs: a job made or changed from the calendar copy. */
export const CALENDAR_ACTOR: JobActor = { role: 'system', id: null, name: 'calendar' };

export type JobStatus = 'open' | 'booking-changed';

/**
 * Why a job's booking changed: its reservation is gone, or moved to another
 * checkout (same UID, other days), or the property's calendar link changed or
 * was removed, or the property was deleted.
 */
export type ChangeKind = 'gone' | 'moved' | 'calendar-changed' | 'calendar-removed' | 'property-deleted';
export const CHANGE_KINDS: readonly ChangeKind[] = ['gone', 'moved', 'calendar-changed', 'calendar-removed', 'property-deleted'];

export interface StayDays {
  start: string | null;
  end: string | null;
}

export interface JobChange {
  kind: ChangeKind;
  /** ISO-8601 UTC: the run that saw it. */
  at: string;
  /** On `moved`: the reservation's days now. */
  movedTo: { start: string; end: string } | null;
}

/** One cleaner on a job. */
export interface Assignment {
  /** Their name when assigned: a deleted cleaner's assignment still reads by it. */
  nameAtAssignment: string | null;
  assignedAt: string;
  assignedBy: JobActor;
  /** The cleaning their Mark cleaned made; null until they mark, and again after Undo or a reopen. */
  cleaningId: string | null;
  markedAt: string | null;
  /**
   * When the office deleted or removed the cleaning their mark made, and who: the mark stays, "removed by the
   * office", and they cannot mark the job again until an admin reopens it for them (Kian's ruling of 2026-10-14,
   * night). Null otherwise.
   */
  removedAt: string | null;
  removedBy: JobActor | null;
}

export type JobAction =
  | 'created'
  | 'assigned'
  | 'unassigned'
  | 'marked'
  | 'unmarked'
  | 'cleaning-removed'
  | 'cleaning-deleted'
  | 'mark-reopened'
  | 'booking-changed'
  | 'reopened'
  | 'reservation-replaced'
  | 'check-in-moved'
  | 'calendar-relinked'
  | 'next-check-in-changed';
const JOB_ACTIONS: readonly JobAction[] = ['created', 'assigned', 'unassigned', 'marked', 'unmarked', 'cleaning-removed', 'cleaning-deleted', 'mark-reopened', 'booking-changed', 'reopened', 'reservation-replaced', 'check-in-moved', 'calendar-relinked', 'next-check-in-changed'];

/**
 * One event of a job's history, append-only. Every field is always written; null where it does not apply.
 *
 * `cleaning-removed` and `cleaning-deleted`: the office removed or deleted the cleaning a mark made, and the mark
 * stayed, removed by the office. `mark-reopened`: an admin took that mark off, so the cleaner can mark the job again.
 * `reopened` is the calendar's: a changed booking's day ends a reservation again.
 */
export interface JobEvent {
  at: string;
  action: JobAction;
  actor: JobActor;
  /** The cleaner an assignment, a mark, an undo, a removal or a reopen is about. */
  cleanerId: string | null;
  cleanerName: string | null;
  /** On marked, unmarked, cleaning-removed and cleaning-deleted: the cleaning, and its amount then (null: none yet). On mark-reopened: the cleaning removed. */
  cleaningId: string | null;
  amountCents: number | null;
  /** Why, in words, when it was not the actor's own choice: "deactivated", "deleted". */
  reason: string | null;
  /** On booking-changed: what happened. */
  change: ChangeKind | null;
  /** The stay's days before and after, on the changes that move them. */
  before: StayDays | null;
  after: StayDays | null;
}

/** `cleaning_jobs/{propertyId}_{checkout}`, as written. */
export interface CleaningJob {
  schemaVersion: number;
  propertyId: string;
  /** The property's name when the job was made: a deleted property's job still reads by it. */
  propertyNameAtCreation: string | null;
  /** The turnover day, yyyy-mm-dd (Toronto): the reservation's checkout. Never changes. */
  checkout: string;
  /** The stay ending on `checkout`, as last read. */
  reservation: { uid: string; start: string };
  calendarKey: string;
  /** The next stay's first night on or after `checkout`; equal to it on a same-day turnover; null when none is on the calendar. */
  nextCheckIn: string | null;
  status: JobStatus;
  change: JobChange | null;
  /** Everyone assigned, in the order assigned: for queries; `assignments` holds the detail. */
  cleanerIds: string[];
  assignments: Record<string, Assignment>;
  createdAt: string;
  history: JobEvent[];
}

export type StoredJob = CleaningJob & { id: string };

/** A job's ID: the property and its checkout day. Property IDs are Firestore auto IDs, so the underscore is never theirs. */
export function jobIdOf(propertyId: string, checkout: string): string {
  return `${propertyId}_${checkout}`;
}

// ─── Reading strictly ──────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string';
const isTextOrNull = (value: unknown): value is string | null => value === null || typeof value === 'string';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (value: unknown): value is string => isText(value) && DAY.test(value);
const isDayOrNull = (value: unknown): value is string | null => value === null || isDay(value);
const ACTOR_ROLES = ['admin', 'cleaner', 'handyman', 'system'];
const isActor = (value: unknown): value is JobActor => isRecord(value) && ACTOR_ROLES.includes(value.role as string) && isTextOrNull(value.id) && isTextOrNull(value.name);
const isCents = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const isStayDays = (value: unknown): value is StayDays => isRecord(value) && isDayOrNull(value.start) && isDayOrNull(value.end);

function readEvent(value: unknown): JobEvent | null {
  if (!isRecord(value) || !isText(value.at) || !JOB_ACTIONS.includes(value.action as JobAction) || !isActor(value.actor)) return null;
  const { cleanerId, cleanerName, cleaningId, amountCents, reason, change, before, after } = value;
  if (!isTextOrNull(cleanerId) || !isTextOrNull(cleanerName) || !isTextOrNull(cleaningId) || !(amountCents === null || isCents(amountCents)) || !isTextOrNull(reason)) return null;
  if (!(change === null || CHANGE_KINDS.includes(change as ChangeKind))) return null;
  if (!(before === null || isStayDays(before)) || !(after === null || isStayDays(after))) return null;
  return {
    at: value.at,
    action: value.action as JobAction,
    actor: value.actor,
    cleanerId,
    cleanerName,
    cleaningId,
    amountCents: amountCents as number | null,
    reason,
    change: change as ChangeKind | null,
    before: before as StayDays | null,
    after: after as StayDays | null,
  };
}

function readAssignment(value: unknown): Assignment | null {
  if (!isRecord(value)) return null;
  const { nameAtAssignment, assignedAt, assignedBy, cleaningId, markedAt, removedAt, removedBy } = value;
  if (!isTextOrNull(nameAtAssignment) || !isText(assignedAt) || !isActor(assignedBy) || !isTextOrNull(cleaningId) || !isTextOrNull(markedAt)) return null;
  if ((cleaningId === null) !== (markedAt === null)) return null;
  // Removed by the office: only ever a mark, and always with who removed it.
  if (!isTextOrNull(removedAt) || !(removedBy === null || isActor(removedBy)) || (removedAt === null) !== (removedBy === null) || (removedAt !== null && markedAt === null)) return null;
  return { nameAtAssignment, assignedAt, assignedBy, cleaningId, markedAt, removedAt, removedBy };
}

function readChange(value: unknown): JobChange | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !CHANGE_KINDS.includes(value.kind as ChangeKind) || !isText(value.at)) return undefined;
  const movedTo = value.movedTo;
  if (!(movedTo === null || (isRecord(movedTo) && isDay(movedTo.start) && isDay(movedTo.end)))) return undefined;
  return { kind: value.kind as ChangeKind, at: value.at, movedTo: movedTo === null ? null : { start: (movedTo as Record<string, string>).start, end: (movedTo as Record<string, string>).end } };
}

/** A stored job, read strictly: null when any field is not in the written shape. */
export function readJob(id: string, fields: Record<string, unknown>): StoredJob | null {
  const { propertyId, propertyNameAtCreation, checkout, reservation, calendarKey, nextCheckIn, status, cleanerIds, assignments, createdAt, history } = fields;
  if (typeof fields.schemaVersion !== 'number') return null;
  if (!isText(propertyId) || !isTextOrNull(propertyNameAtCreation) || !isDay(checkout) || id !== jobIdOf(propertyId, checkout)) return null;
  if (!isRecord(reservation) || !isText(reservation.uid) || !isDay(reservation.start)) return null;
  if (!isText(calendarKey) || !isDayOrNull(nextCheckIn) || (status !== 'open' && status !== 'booking-changed')) return null;
  const change = readChange(fields.change);
  if (change === undefined || (status === 'booking-changed') !== (change !== null)) return null;
  if (!Array.isArray(cleanerIds) || !cleanerIds.every(isText) || new Set(cleanerIds).size !== cleanerIds.length) return null;
  if (!isRecord(assignments) || Object.keys(assignments).length !== cleanerIds.length || !cleanerIds.every((cid) => cid in assignments)) return null;
  const read: Record<string, Assignment> = {};
  for (const cid of cleanerIds) {
    const a = readAssignment(assignments[cid]);
    if (!a) return null;
    read[cid] = a;
  }
  if (!isText(createdAt) || !Array.isArray(history)) return null;
  const events = history.map(readEvent);
  if (events.some((event) => event === null)) return null;
  return {
    id,
    schemaVersion: fields.schemaVersion,
    propertyId,
    propertyNameAtCreation,
    checkout,
    reservation: { uid: reservation.uid, start: reservation.start },
    calendarKey,
    nextCheckIn,
    status,
    change,
    cleanerIds: [...cleanerIds],
    assignments: read,
    createdAt,
    history: events as JobEvent[],
  };
}

/** A history event with every field written, the ones not given as null. */
export function jobEvent(at: string, action: JobAction, actor: JobActor, fields: Partial<Omit<JobEvent, 'at' | 'action' | 'actor'>> = {}): JobEvent {
  return {
    at,
    action,
    actor,
    cleanerId: fields.cleanerId ?? null,
    cleanerName: fields.cleanerName ?? null,
    cleaningId: fields.cleaningId ?? null,
    amountCents: fields.amountCents ?? null,
    reason: fields.reason ?? null,
    change: fields.change ?? null,
    before: fields.before ?? null,
    after: fields.after ?? null,
  };
}

// ─── What a job says ───────────────────────────────────────────

/** A same-day turnover: the next guest's first night is the checkout day. */
export function isSameDay(job: Pick<CleaningJob, 'checkout' | 'nextCheckIn'>): boolean {
  return job.nextCheckIn !== null && job.nextCheckIn === job.checkout;
}

/** How many of the cleaners on a job have marked it cleaned: a mark removed by the office stays a mark. */
export function markedCount(job: Pick<CleaningJob, 'cleanerIds' | 'assignments'>): number {
  return job.cleanerIds.filter((cid) => job.assignments[cid]?.cleaningId !== null).length;
}

/** Done: someone is on it, and everyone on it has marked it. Never stored. */
export function isDone(job: Pick<CleaningJob, 'cleanerIds' | 'assignments'>): boolean {
  return job.cleanerIds.length > 0 && markedCount(job) === job.cleanerIds.length;
}

/** A booking that changed after a cleaner had marked the job: the cleaning stays, charged as usual, for an admin to decide (Kian's answer). */
export function changedAfterMark(job: Pick<CleaningJob, 'status' | 'change' | 'cleanerIds' | 'assignments'>): boolean {
  if (job.status !== 'booking-changed' || !job.change) return false;
  const at = job.change.at;
  return job.cleanerIds.some((cid) => {
    const marked = job.assignments[cid]?.markedAt;
    return typeof marked === 'string' && marked <= at;
  });
}

/** What changed, in a few words: "Cancelled", "Moved to Oct 27", "Calendar link changed". */
export function changeWords(change: JobChange | null): string | null {
  if (!change) return null;
  switch (change.kind) {
    case 'gone':
      return 'Cancelled';
    case 'moved':
      return change.movedTo ? `Moved to ${dayText(change.movedTo.end)}` : 'Moved';
    case 'calendar-changed':
      return 'Calendar link changed';
    case 'calendar-removed':
      return 'Calendar link removed';
    case 'property-deleted':
      return 'Property deleted';
  }
}

/** The first day a cleaner's list holds, for a Toronto `today`. */
export function cleanerListFrom(today: string): string {
  return addDays(today, -CLEANER_LIST_DAYS);
}

/**
 * Why this cleaner cannot mark this job now, or null when they can: on it,
 * not marked yet, the booking unchanged, and from the checkout day on
 * (Kian's ruling 4, and his answer of the evening: a changed job cannot be
 * marked). A mark removed by the office is `removed` until an admin reopens
 * it (Kian's ruling of the night).
 */
export function markRefusal(job: Pick<CleaningJob, 'status' | 'checkout' | 'assignments'>, cleanerId: string, today: string): 'not-assigned' | 'removed' | 'already-marked' | 'booking-changed' | 'too-early' | null {
  const mine = job.assignments[cleanerId];
  if (!mine) return 'not-assigned';
  if (mine.removedAt !== null) return 'removed';
  if (mine.cleaningId !== null) return 'already-marked';
  if (job.status !== 'open') return 'booking-changed';
  if (today < job.checkout) return 'too-early';
  return null;
}

/**
 * Why an admin cannot reopen this job for this cleaner, or null when they can:
 * the office removed their mark's cleaning, and the booking is unchanged (a
 * changed job cannot be marked anyway). Who the cleaner is now, and how far
 * back their list reaches, the server checks.
 */
export function reopenRefusal(job: Pick<CleaningJob, 'status' | 'assignments'>, cleanerId: string): 'not-removed' | 'booking-changed' | null {
  const mine = job.assignments[cleanerId];
  if (!mine || mine.removedAt === null) return 'not-removed';
  if (job.status !== 'open') return 'booking-changed';
  return null;
}

// ─── What pages read ───────────────────────────────────────────

/** A lookup that may have found nothing, or failed. The same words as the cleaners' model. */
export type JobLookup = 'found' | 'missing' | 'unreadable';

/** One cleaner on a job, as the admin's Schedule shows them. */
export interface AssigneeView extends Assignment {
  cleanerId: string;
  /** The current name, else the name when assigned. */
  name: string | null;
  /** The account's status now; null when it no longer exists or could not be read. */
  status: string | null;
  state: JobLookup;
  /** The cleaning their mark made, as it stands; null when not marked, or removed by the office. */
  cleaning: { state: JobLookup; status: string | null; amountCents: number | null } | null;
}

/** A job as the admin's Schedule reads it. */
export interface JobView extends Omit<StoredJob, 'assignments'> {
  property: { state: JobLookup; name: string | null; checkOut: string | null; checkIn: string | null };
  assignees: AssigneeView[];
  /** The property's calendar in the copy: whether this run could read it, and since when it could not. */
  calendar: { status: string | null; failedSince: string | null; fetchedAt: string | null };
}

/** A job as a cleaner's app shows it: theirs only, by the property's name for cleaners. */
export interface CleanerJobView {
  id: string;
  propertyId: string;
  /** The cleaner-facing name when an admin set one (dispatch 21), else the real name. */
  propertyName: string | null;
  city: string | null;
  checkout: string;
  /** The property's listed times, as typed on it: "11:00 AM". */
  checkOutTime: string | null;
  checkInTime: string | null;
  nextCheckIn: string | null;
  status: JobStatus;
  /** Their own mark: when, and whether Undo still holds (no finished statement prints the cleaning, and the office has not removed it). */
  markedAt: string | null;
  canUndo: boolean;
  /** Null when they can mark it now; otherwise why not: `removed` reads "Removed by the office". */
  markRefusal: ReturnType<typeof markRefusal>;
}

/** A team member as the Schedule's picker and filters need them. */
export interface TeamMember {
  id: string;
  name: string | null;
  role: string;
  status: string | null;
}

/** What the Schedule reads (GET /api/admin/cleaning-jobs). */
export interface ScheduleRead {
  jobs: JobView[];
  team: TeamMember[];
  /** The calendar copy the jobs come from: when it was last refreshed, and the calendars it could not read. */
  calendar: { refreshedAt: string | null; failed: { propertyId: string; name: string; since: string | null }[] };
  unreadable: number;
}

/** One job a cleaner is on and has not marked: what the Team page's dialog names before deactivating or deleting them. */
export interface UnmarkedJob {
  id: string;
  propertyName: string | null;
  checkout: string;
  status: string;
}
