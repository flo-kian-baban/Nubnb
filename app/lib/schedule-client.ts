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
import type { CleaningPrices, PresetKind } from '@/app/lib/cleanings/prices';
import type { LastTyped } from '@/app/lib/schedule/add-job';

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

/** What "Already cleaned" made as the job was added (the UX pass of 2026-11-06): as Record as cleaned answers it. */
export interface RecordedOnAdd {
  cleanings: { cleanerId: string; cleaningId: string; amountCents: number | null }[];
  statementMonth: string;
}

/**
 * Add a job by hand (POST /api/admin/cleaning-jobs; Kian's ruling C of 2026-11-01; its label since Build 2), and with
 * `alreadyCleaned` record it cleaned in the same step (2026-11-06). `tier` is the tier the amount's price came from,
 * `amount` what the field held ("75.00", or null when empty). JOB_SAVE_FAILED: it may or may not have landed.
 */
export function addJobByHand(input: { propertyId: string; checkout: string; cleanerId: string | null; tier: PresetKind; amount: string | null; label: string | null; alreadyCleaned: boolean }): Promise<ScheduleResult<{ job: StoredJob; propertyName: string | null; recorded: RecordedOnAdd | null }>> {
  return call<{ job: StoredJob; propertyName: string | null; recorded?: RecordedOnAdd | null }>(
    '/api/admin/cleaning-jobs',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) },
    'Adding the job failed',
    (data) => isRecord(data) && isJobLike(data.job) && (data.recorded === undefined || data.recorded === null || (isRecord(data.recorded) && Array.isArray(data.recorded.cleanings) && typeof data.recorded.statementMonth === 'string')),
    ['JOB_SAVE_FAILED'],
  ).then((result) => (result.ok ? { ok: true, data: { ...result.data, recorded: result.data.recorded ?? null } } : result));
}

/** What "Add a job" fills its amount from (GET /api/admin/cleaning-jobs/amount-start): the property's cleaning prices, and the amount last typed per tier with none. */
export interface AmountStartAnswer {
  prices: CleaningPrices | null;
  lastTyped: LastTyped;
}

const isCentsOrNull = (value: unknown): boolean => value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value > 0);

/** A property's cleaning prices and "Last typed" amounts, for "Add a job" (2026-11-06). */
export function fetchAmountStart(propertyId: string): Promise<ScheduleResult<AmountStartAnswer>> {
  return call(
    `/api/admin/cleaning-jobs/amount-start?property=${encodeURIComponent(propertyId)}`,
    {},
    'Reading the cleaning price failed',
    (data) =>
      isRecord(data) &&
      (data.prices === null || (isRecord(data.prices) && isCentsOrNull(data.prices.shortTermCents) && isCentsOrNull(data.prices.midTermCents) && isCentsOrNull(data.prices.longTermCents))) &&
      isRecord(data.lastTyped) &&
      isCentsOrNull(data.lastTyped.short) &&
      isCentsOrNull(data.lastTyped.mid) &&
      isCentsOrNull(data.lastTyped.long),
  );
}

/** Change a job's cleaner in one step (ruling D): `from` off, `to` on, as the page saw it (`seen`). JOB_SAVE_FAILED: unknown whether it landed. */
export function swapJobCleaner(jobId: string, from: string, to: string, seen: number): Promise<ScheduleResult<{ job: StoredJob; changed: boolean; from: string | null; to: string | null }>> {
  return call(
    `/api/admin/cleaning-jobs/${encodeURIComponent(jobId)}`,
    { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'swap', from, to, seen }) },
    'Changing the cleaner failed',
    (data) => isRecord(data) && isJobLike(data.job) && (data.job as Record<string, unknown>).id === jobId,
    ['JOB_SAVE_FAILED'],
  );
}

/**
 * Delete a job and its cleaning (DELETE /api/admin/cleaning-jobs/[id]; Build 2, item 2), as the page saw it (`seen`).
 * Refused, with the reason in one sentence, when the cleaning is dated on or before a payment to its cleaner or printed
 * on a finished statement. JOB_DELETE_FAILED: it may or may not have landed.
 */
export function deleteJob(jobId: string, seen: number): Promise<ScheduleResult<{ deleted: { id: string; cleanings: number; marker: boolean } }>> {
  return call(
    `/api/admin/cleaning-jobs/${encodeURIComponent(jobId)}`,
    { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seen }) },
    'Deleting the job failed',
    (data) => isRecord(data) && isRecord(data.deleted) && (data.deleted as Record<string, unknown>).id === jobId,
    ['JOB_DELETE_FAILED'],
  );
}

/** Set, change or clear a job's own amount (ruling B), "75.00" or null, as the page saw it (`seen`). */
export function setJobAmountOf(jobId: string, amount: string | null, seen: number): Promise<ScheduleResult<{ job: StoredJob; changed: boolean; cleaningsChanged: number }>> {
  return call(
    `/api/admin/cleaning-jobs/${encodeURIComponent(jobId)}`,
    { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'amount', amount, seen }) },
    'Saving the job’s amount failed',
    (data) => isRecord(data) && isJobLike(data.job) && (data.job as Record<string, unknown>).id === jobId && typeof data.changed === 'boolean',
    ['JOB_SAVE_FAILED'],
  );
}

/** Record a job cleaned for its assigned cleaners (ruling E), as the page saw it (`seen`). RECORD_FAILED: unknown whether it landed. */
export function recordJobCleaned(jobId: string, cleanerIds: string[], seen: number): Promise<ScheduleResult<{ job: StoredJob; cleanings: { cleanerId: string; cleaningId: string; amountCents: number | null }[]; statementMonth: string }>> {
  return call(
    `/api/admin/cleaning-jobs/${encodeURIComponent(jobId)}/record`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cleanerIds, seen }) },
    'Recording the job cleaned failed',
    (data) => isRecord(data) && isJobLike(data.job) && (data.job as Record<string, unknown>).id === jobId && Array.isArray(data.cleanings) && typeof data.statementMonth === 'string',
    ['RECORD_FAILED'],
  );
}

/** Decide the extra a cleaner asked for on a job's cleaning (ruling F), from the Schedule row: approve at its amount or a new one, or decline. */
export function decideJobExtra(cleaningId: string, decision: 'approve' | 'decline', amount: string | undefined, seen: number): Promise<ScheduleResult<{ cleaning: { id: string; amountCents: number | null; history: unknown[] }; statementMonth: string }>> {
  return call(
    `/api/admin/cleanings/${encodeURIComponent(cleaningId)}`,
    { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'extra', decision, ...(amount !== undefined ? { amount } : {}), seen, reason: null }) },
    'Deciding the extra failed',
    (data) => isRecord(data) && isRecord(data.cleaning) && typeof (data.cleaning as Record<string, unknown>).id === 'string' && typeof data.statementMonth === 'string',
    ['CLEANING_SAVE_FAILED'],
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
    return { ...a, cleanerId: cid, name: member?.name ?? a.nameAtAssignment, status: member?.status ?? null, state: member ? 'found' : 'missing', cleaning: a.cleaningId === null || a.removedAt !== null ? null : had?.cleaningId === a.cleaningId ? had.cleaning : { state: 'found', status: 'logged', amountCents: null, amountFrom: null, extra: a.extraAsked ? 'asked' : null, seen: 1 } };
  });
  return { ...rest, property: previous.property, calendar: previous.calendar, assignees };
}

/** A job as the page holds it with one mark's cleaning changed: the amount recorded, or the extra decided (the page reads no more). */
export function withCleaning(job: JobView, cleanerId: string, cleaning: Partial<NonNullable<AssigneeView['cleaning']>>): JobView {
  return { ...job, assignees: job.assignees.map((a) => (a.cleanerId === cleanerId && a.cleaning ? { ...a, cleaning: { ...a.cleaning, ...cleaning } } : a)) };
}
