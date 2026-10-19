/**
 * Browser-side calls for the admin's Schedule (the cleaning schedule, phase 1, Kian's rulings of 2026-10-14).
 *
 * Every call resolves and never throws, as in cleaners-client.ts: an answer is either the data, checked for shape,
 * or a failure fit to show as a Notice, saying when it is not known whether a write landed.
 *
 * Client-safe: it imports only the schedule's model and the shared error reading.
 */

import { describeErrorBody, readErrorBody } from '@/app/lib/api/http-failure';
import type { AssigneeView, JobView, ScheduleRead, StoredJob, TeamMember } from '@/app/lib/schedule/model';

export type ScheduleResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; title: string; detail?: string; code?: string; unknown: boolean };

const isRecord = (data: unknown): data is Record<string, unknown> => !!data && typeof data === 'object' && !Array.isArray(data);

async function call<T>(url: string, init: RequestInit, action: string, isExpected: (data: unknown) => boolean, unconfirmedCodes: readonly string[] = []): Promise<ScheduleResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, cache: 'no-store' });
  } catch (err) {
    return { ok: false, status: 0, title: `${action}: the server could not be reached.`, detail: err instanceof Error ? err.message : undefined, unknown: true };
  }
  const body = await readErrorBody(res);
  if (!res.ok) {
    const failure = describeErrorBody(body, res.status, action);
    const code = typeof body.code === 'string' ? body.code : undefined;
    return { ok: false, status: failure.status, title: failure.title, detail: failure.detail, code, unknown: res.status >= 500 || (code !== undefined && unconfirmedCodes.includes(code)) };
  }
  if (!isExpected(body.data)) return { ok: false, status: res.status, title: `${action}: the server's answer was not in the expected form.`, detail: 'Nothing is shown rather than something that might be wrong.', unknown: true };
  return { ok: true, data: body.data as T };
}

const isJobLike = (value: unknown): boolean =>
  isRecord(value) && typeof value.id === 'string' && typeof value.propertyId === 'string' && typeof value.checkout === 'string' && Array.isArray(value.cleanerIds) && Array.isArray(value.history);

export interface ScheduleAnswer extends ScheduleRead {
  from: string;
  to: string;
  today: string;
  now: string;
  /**
   * The calendars being read again because the copy was more than three hours old (Kian's ruling R1 of 2026-10-19):
   * the page watches the run and reads its days again when it ends. Null: nothing is coming.
   */
  refresh: { state: 'starting' | 'running'; lastFinishedAt: string | null } | null;
}

/** The jobs whose checkout falls from `from` to `to`, both Toronto days; the server's default range without them. */
export function fetchSchedule(from?: string, to?: string): Promise<ScheduleResult<ScheduleAnswer>> {
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const query = params.toString();
  return call<ScheduleAnswer>(
    `/api/admin/cleaning-jobs${query ? `?${query}` : ''}`,
    {},
    'Loading the schedule failed',
    (data) =>
      isRecord(data) &&
      Array.isArray(data.jobs) &&
      data.jobs.every((job) => isJobLike(job) && isRecord((job as Record<string, unknown>).property) && Array.isArray((job as Record<string, unknown>).assignees)) &&
      Array.isArray(data.team) &&
      isRecord(data.calendar) &&
      typeof data.today === 'string' &&
      (data.refresh === undefined || data.refresh === null || (isRecord(data.refresh) && (data.refresh.state === 'starting' || data.refresh.state === 'running'))),
  ).then((result) => (result.ok ? { ok: true, data: { ...result.data, refresh: result.data.refresh ?? null } } : result));
}

/** A property's regular cleaner as the Schedule and the edit page read it (Kian's ruling R5 of 2026-10-19). */
export interface RegularCleanerAnswer {
  regular: { cleanerId: string; name: string | null; state: 'found' | 'missing'; role: string | null; status: string | null; assigns: boolean; setAt: string } | null;
  /** Every active cleaner, when asked for. */
  choices: { id: string; name: string | null }[] | null;
  /** The record exists but is not in the written shape: shown as none, and said. */
  unreadable: boolean;
}

/** A property's regular cleaner (GET /api/admin/properties/[id]/regular-cleaner); `withChoices` adds every active cleaner. */
export function fetchRegularCleaner(propertyId: string, withChoices = false): Promise<ScheduleResult<RegularCleanerAnswer>> {
  return call(
    `/api/admin/properties/${encodeURIComponent(propertyId)}/regular-cleaner${withChoices ? '?choices=1' : ''}`,
    {},
    'Loading the regular cleaner failed',
    (data) => isRecord(data) && (data.regular === null || (isRecord(data.regular) && typeof data.regular.cleanerId === 'string' && typeof data.regular.assigns === 'boolean')) && (data.choices === null || Array.isArray(data.choices)) && typeof data.unreadable === 'boolean',
  );
}

/** Make a cleaner a property's regular cleaner, or clear it (null). REGULAR_CLEANER_SAVE_FAILED: it may or may not have landed. */
export function setRegularCleanerOf(propertyId: string, cleanerId: string | null): Promise<ScheduleResult<{ cleanerId: string | null; name: string | null; changed: boolean }>> {
  return call(
    `/api/admin/properties/${encodeURIComponent(propertyId)}/regular-cleaner`,
    { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cleanerId }) },
    'Saving the regular cleaner failed',
    (data) => isRecord(data) && typeof data.changed === 'boolean',
    ['REGULAR_CLEANER_SAVE_FAILED'],
  );
}

/** Set who is on a job, as the page saw it (`seen`: its history's length). JOB_SAVE_FAILED: it may or may not have landed. */
export function setJobCleaners(jobId: string, cleanerIds: string[], seen: number): Promise<ScheduleResult<{ job: StoredJob; changed: boolean }>> {
  return call(
    `/api/admin/cleaning-jobs/${encodeURIComponent(jobId)}`,
    { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cleanerIds, seen }) },
    'Saving who is on the job failed',
    (data) => isRecord(data) && isJobLike(data.job) && (data.job as Record<string, unknown>).id === jobId && typeof data.changed === 'boolean',
    ['JOB_SAVE_FAILED'],
  );
}

/**
 * Reopen a job for a cleaner whose mark the office removed, as the page saw it (`seen`: its history's length): they
 * can mark it cleaned again. JOB_SAVE_FAILED: it may or may not have landed.
 */
export function reopenJobFor(jobId: string, cleanerId: string, seen: number): Promise<ScheduleResult<{ job: StoredJob }>> {
  return call(
    `/api/admin/cleaning-jobs/${encodeURIComponent(jobId)}/reopen`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cleanerId, seen }) },
    'Reopening the job failed',
    (data) => isRecord(data) && isJobLike(data.job) && (data.job as Record<string, unknown>).id === jobId,
    ['JOB_SAVE_FAILED'],
  );
}

/** What Refresh calendars made and changed: the job sync's outcome, after the copy was written. */
export interface RefreshAnswer {
  jobs: { created: number; changed: number; watched: number; unreadable: number; failed: string | null };
  refreshedAt: string;
}

/** Fetch every calendar now, write the copy, and make and watch the jobs from it (POST /api/admin/availability/refresh). */
export function refreshCalendars(): Promise<ScheduleResult<RefreshAnswer>> {
  return call<{ jobs: RefreshAnswer['jobs']; snapshot: { refreshedAt: string } }>(
    '/api/admin/availability/refresh',
    { method: 'POST' },
    'Refreshing the calendars failed',
    (data) => isRecord(data) && isRecord(data.jobs) && typeof (data.jobs as Record<string, unknown>).created === 'number' && isRecord(data.snapshot),
    ['AVAILABILITY_REFRESH_FAILED'],
  ).then((result) => (result.ok ? { ok: true, data: { jobs: result.data.jobs, refreshedAt: result.data.snapshot.refreshedAt } } : result));
}

/**
 * A job as stored, answered by an assignment or a reopen, put back into the page's view: the property and the
 * calendar as the page already holds them, each assignee named from the team (else by the name when assigned), and
 * each mark's cleaning as the page last read it.
 */
export function mergeJob(previous: JobView, stored: StoredJob, team: readonly TeamMember[]): JobView {
  const byId = new Map(team.map((member) => [member.id, member]));
  const before = new Map(previous.assignees.map((a) => [a.cleanerId, a]));
  const { assignments, ...rest } = stored;
  const assignees: AssigneeView[] = stored.cleanerIds.map((cid) => {
    const a = assignments[cid];
    const member = byId.get(cid);
    const had = before.get(cid);
    return { ...a, cleanerId: cid, name: member?.name ?? a.nameAtAssignment, status: member?.status ?? null, state: member ? 'found' : 'missing', cleaning: a.cleaningId === null || a.removedAt !== null ? null : had?.cleaningId === a.cleaningId ? had.cleaning : { state: 'found', status: 'logged', amountCents: null } };
  });
  return { ...rest, property: previous.property, calendar: previous.calendar, assignees };
}
