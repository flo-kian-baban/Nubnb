/**
 * Browser-side calls to the admin availability API, for the Availability
 * page and the home tiles. The contract of costs-client.ts: every call
 * resolves to a result and never throws, a failure is never turned into an
 * empty answer, requests are `no-store`, and nothing is retried.
 *
 * Client-safe: imports only types and the tolerant error reader.
 */

import { describeErrorBody, readErrorBody } from '@/app/lib/api/http-failure';
import { isAvailabilityProperty } from '@/app/lib/availability/property';
import type { AvailabilityProperty, AvailabilitySnapshot, HistoryView } from '@/app/lib/availability/types';

/** A refresh the server started after its answer, or found under way, because the copy was stale (Kian's ruling K2 of 2026-10-19). */
export type OpenRefresh = { state: 'starting' | 'running'; lastFinishedAt: string | null } | null;

export interface AvailabilityData {
  /** Null when no refresh has ever run. */
  snapshot: AvailabilitySnapshot | null;
  /** Null before a week of daily snapshots exists. */
  history: HistoryView | null;
  /** The Toronto day, from the server. */
  today: string;
  /** The server's clock, ISO, to age the snapshot by. */
  now: string;
  /** A run coming or under way (K2); absent on answers that predate it. */
  refresh?: OpenRefresh;
}

export type AvailabilityResult =
  | { ok: true; data: AvailabilityData }
  | {
      ok: false;
      /** HTTP status, or 0 when the request never reached the server. */
      status: number;
      /** One line, fit to show as a Notice title. */
      title: string;
      detail?: string;
      code?: string;
    };

const isRecord = (data: unknown): data is Record<string, unknown> => !!data && typeof data === 'object' && !Array.isArray(data);

function isAvailabilityData(data: unknown): data is AvailabilityData {
  if (!isRecord(data)) return false;
  const snapshot = data.snapshot;
  const snapshotOk = snapshot === null || (isRecord(snapshot) && snapshot.version === 1 && isRecord(snapshot.properties) && isRecord(snapshot.run));
  const history = data.history;
  const historyOk = history === null || (isRecord(history) && typeof history.day === 'string' && isRecord(history.reserved));
  const refresh = data.refresh;
  const refreshOk = refresh === undefined || refresh === null || (isRecord(refresh) && (refresh.state === 'starting' || refresh.state === 'running') && (refresh.lastFinishedAt === null || typeof refresh.lastFinishedAt === 'string'));
  return snapshotOk && historyOk && refreshOk && typeof data.today === 'string' && typeof data.now === 'string';
}

async function call(url: string, init: RequestInit, action: string): Promise<AvailabilityResult> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, cache: 'no-store' });
  } catch (err) {
    return { ok: false, status: 0, title: `${action}: the server could not be reached.`, detail: err instanceof Error ? err.message : undefined };
  }
  const body = await readErrorBody(res);
  if (!res.ok || body.success !== true) {
    const failure = describeErrorBody(body, res.status, action);
    return { ok: false, status: res.status, title: failure.title, detail: failure.detail, code: typeof body.code === 'string' ? body.code : undefined };
  }
  if (!isAvailabilityData(body.data)) {
    return { ok: false, status: res.status, title: `${action}: the server answered in an unexpected form.` };
  }
  return { ok: true, data: body.data };
}

/** The stored copy, as last refreshed. */
export const fetchAvailability = (): Promise<AvailabilityResult> =>
  call('/api/admin/availability', { method: 'GET' }, 'Loading availability failed');

/** Fetch every feed now, then the stored copy as just written. */
export const refreshAvailability = (): Promise<AvailabilityResult> =>
  call('/api/admin/availability/refresh', { method: 'POST' }, 'Refreshing availability failed');

export type PropertiesResult = { ok: true; data: AvailabilityProperty[] } | { ok: false; status: number; title: string; detail?: string; code?: string };

/** The slice of every property this page works from (round 1): one small read in place of the whole admin list. */
export async function fetchAvailabilityProperties(): Promise<PropertiesResult> {
  let res: Response;
  try {
    res = await fetch('/api/admin/availability/properties', { method: 'GET', cache: 'no-store' });
  } catch (err) {
    return { ok: false, status: 0, title: 'Loading the properties failed: the server could not be reached.', detail: err instanceof Error ? err.message : undefined };
  }
  const body = await readErrorBody(res);
  if (!res.ok || body.success !== true) {
    const failure = describeErrorBody(body, res.status, 'Loading the properties failed');
    return { ok: false, status: res.status, title: failure.title, detail: failure.detail, code: typeof body.code === 'string' ? body.code : undefined };
  }
  const data = body.data;
  if (!isRecord(data) || !Array.isArray(data.properties) || !data.properties.every(isAvailabilityProperty)) {
    return { ok: false, status: res.status, title: 'Loading the properties failed: the server answered in an unexpected form.' };
  }
  return { ok: true, data: data.properties as AvailabilityProperty[] };
}
