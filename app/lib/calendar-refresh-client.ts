/**
 * Browser-side: when the calendars were last read, and Refresh, for the tag on every admin page (Kian's rulings of
 * 2026-10-17, admin home). The contract of the other clients: every call resolves and never throws, a failure is
 * never turned into an answer, requests are `no-store`, and nothing is retried.
 *
 * Refresh is the existing refresh (POST /api/admin/availability/refresh), one run at a time on the server. In the
 * page, one press at a time too: a second press while one is under way joins it. When it ends, every part of the
 * page that shows the calendars hears it (`useCalendarsRefreshed`): the Schedule and Availability pages show what it
 * did, the property list reads its columns again.
 *
 * A run this page did not press (the day's first visit, or a read on open: Kian's ruling R1 of 2026-10-19) is
 * watched (`watchCalendarRun`): the state is looked at every few seconds until the run has written the copy, synced
 * the jobs and let the lease go, and then every part of the page hears it (`useCalendarsRead`): the tag shows the new
 * time, the Schedule reads its days again. One watch at a time; a second asker joins it.
 *
 * Client-safe: imports only types and the tolerant error reader.
 */

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { describeErrorBody, readErrorBody } from '@/app/lib/api/http-failure';
import type { AvailabilityData } from '@/app/lib/availability-client';

export interface CalendarStatus {
  /** The last copy's time; null when no refresh has ever run. */
  refreshedAt: string | null;
  fetched: number;
  failed: number;
  /** A run reading the calendars now, when one holds the lease. */
  running: { startedAt: string } | null;
  /** The server's clock. */
  now: string;
}

export type Failure = { ok: false; status: number; title: string; detail?: string; code?: string; unknown: boolean };
export type StatusResult = { ok: true; data: CalendarStatus } | Failure;

/** What a refresh answered: the copy just written (the Availability page's own answer) and what the job sync did. */
export interface RefreshData {
  availability: AvailabilityData;
  jobs: { created: number; changed: number; failed: string | null };
}
export type RefreshResult = { ok: true; data: RefreshData } | Failure;

const isRecord = (data: unknown): data is Record<string, unknown> => !!data && typeof data === 'object' && !Array.isArray(data);
const isCount = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isStatus = (d: unknown): d is CalendarStatus =>
  isRecord(d) && (d.refreshedAt === null || typeof d.refreshedAt === 'string') && isCount(d.fetched) && isCount(d.failed) && (d.running === null || (isRecord(d.running) && typeof d.running.startedAt === 'string')) && typeof d.now === 'string';

const isRefresh = (d: unknown): boolean => {
  if (!isRecord(d) || typeof d.today !== 'string' || typeof d.now !== 'string' || !isRecord(d.jobs)) return false;
  const { snapshot, history, jobs } = d;
  const snapshotOk = snapshot === null || (isRecord(snapshot) && snapshot.version === 1 && typeof snapshot.refreshedAt === 'string' && isRecord(snapshot.properties) && isRecord(snapshot.run));
  const historyOk = history === null || (isRecord(history) && typeof history.day === 'string' && isRecord(history.reserved));
  return snapshotOk && historyOk && isCount(jobs.created) && isCount(jobs.changed) && (jobs.failed === null || typeof jobs.failed === 'string');
};

async function call(url: string, init: RequestInit, action: string, isExpected: (data: unknown) => boolean): Promise<{ ok: true; data: unknown } | Failure> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, cache: 'no-store' });
  } catch (err) {
    return { ok: false, status: 0, title: `${action}: the server could not be reached.`, detail: err instanceof Error ? err.message : undefined, unknown: true };
  }
  const body = await readErrorBody(res);
  if (!res.ok || body.success !== true) {
    const failure = describeErrorBody(body, res.status, action);
    return { ok: false, status: res.status, title: failure.title, detail: failure.detail, code: typeof body.code === 'string' ? body.code : undefined, unknown: res.status >= 500 };
  }
  if (!isExpected(body.data)) return { ok: false, status: res.status, title: `${action}: the server's answer was not in the expected form.`, unknown: true };
  return { ok: true, data: body.data };
}

/** When the calendars were last read. */
export async function fetchCalendarStatus(): Promise<StatusResult> {
  const result = await call('/api/admin/availability/status', { method: 'GET' }, 'Loading when the calendars were read failed', isStatus);
  return result.ok ? { ok: true, data: result.data as CalendarStatus } : result;
}

// ─── One refresh at a time, heard by the whole page ───

const EVENT = 'nubnb:calendars-refreshed';
let running: Promise<RefreshResult> | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

/** Read every calendar now (the existing refresh). A press while one is under way joins it. */
export function refreshCalendarsNow(): Promise<RefreshResult> {
  if (running) return running;
  running = call('/api/admin/availability/refresh', { method: 'POST' }, 'Refreshing the calendars failed', isRefresh).then((result): RefreshResult => {
    const outcome: RefreshResult = result.ok ? { ok: true, data: { availability: result.data as AvailabilityData, jobs: (result.data as { jobs: RefreshData['jobs'] }).jobs } } : result;
    running = null;
    emit();
    window.dispatchEvent(new CustomEvent<RefreshResult>(EVENT, { detail: outcome }));
    return outcome;
  });
  emit();
  return running;
}

/** Whether a refresh from this page is under way. */
export function useCalendarsRefreshing(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => running !== null,
    () => false,
  );
}

// ─── A run this page did not press, watched to its end ───

const READ_EVENT = 'nubnb:calendars-read';
/** How often the watch looks, and for how long at most: a run reads 52 calendars in a few seconds, 154 s at worst. */
const WATCH_FIRST_MS = 1_500;
const WATCH_EVERY_MS = 3_000;
const WATCH_MAX_MS = 180_000;
/** Looks that found no run under way and nothing new: then nothing is coming, and the watch stops. */
const WATCH_QUIET_LOOKS = 2;
let watching: Promise<CalendarStatus | null> | null = null;
const watchers = new Set<() => void>();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Watch a run that is starting or under way until it ends: the status is read (two reads) at 1.5 s, then every 3 s.
 * It ended when no run holds the lease and the copy is newer than `knownRefreshedAt` (the copy is written before the
 * jobs are synced, so the lease's release is what says the jobs are made too). Then the page hears it
 * (`useCalendarsRead`) and the watch answers the new status. Two looks in a row with no run and nothing new: nothing
 * is coming, it answers null. A second call while one watches joins it.
 */
export function watchCalendarRun(knownRefreshedAt: string | null): Promise<CalendarStatus | null> {
  if (watching) return watching;
  watching = (async (): Promise<CalendarStatus | null> => {
    const started = Date.now();
    let quiet = 0;
    for (let look = 0; Date.now() - started < WATCH_MAX_MS; look += 1) {
      await sleep(look === 0 ? WATCH_FIRST_MS : WATCH_EVERY_MS);
      const status = await fetchCalendarStatus();
      if (!status.ok) continue;
      const { running, refreshedAt } = status.data;
      if (!running && refreshedAt !== null && refreshedAt !== knownRefreshedAt) {
        window.dispatchEvent(new CustomEvent<CalendarStatus>(READ_EVENT, { detail: status.data }));
        return status.data;
      }
      quiet = running ? 0 : quiet + 1;
      if (quiet >= WATCH_QUIET_LOOKS) return null;
    }
    return null;
  })().finally(() => {
    watching = null;
    watchers.forEach((listener) => listener());
  });
  watchers.forEach((listener) => listener());
  return watching;
}

/** Whether a watch of a run is under way on this page. */
export function useCalendarRunWatched(): boolean {
  return useSyncExternalStore(
    (listener) => {
      watchers.add(listener);
      return () => watchers.delete(listener);
    },
    () => watching !== null,
    () => false,
  );
}

/** Calls `handler` with the status once a watched run has ended: the copy and the jobs are new. */
export function useCalendarsRead(handler: (status: CalendarStatus) => void): void {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => {
    const on = (event: Event) => ref.current((event as CustomEvent<CalendarStatus>).detail);
    window.addEventListener(READ_EVENT, on);
    return () => window.removeEventListener(READ_EVENT, on);
  }, []);
}

/** Calls `handler` with each refresh's outcome, from whichever control pressed it. */
export function useCalendarsRefreshed(handler: (outcome: RefreshResult) => void): void {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => {
    const on = (event: Event) => ref.current((event as CustomEvent<RefreshResult>).detail);
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
}
