/**
 * Browser-side calls to the admin availability API, for the Availability
 * page and the home tiles. The contract of costs-client.ts: every call
 * resolves to a result and never throws, a failure is never turned into an
 * empty answer, requests are `no-store`, and nothing is retried.
 *
 * Client-safe: imports only types and the tolerant error reader.
 */

import { describeErrorBody, readErrorBody } from '@/app/lib/api/http-failure';
import type { AvailabilitySnapshot, HistoryView } from '@/app/lib/availability/types';

export interface AvailabilityData {
  /** Null when no refresh has ever run. */
  snapshot: AvailabilitySnapshot | null;
  /** Null before a week of daily snapshots exists. */
  history: HistoryView | null;
  /** The Toronto day, from the server. */
  today: string;
  /** The server's clock, ISO, to age the snapshot by. */
  now: string;
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
  return snapshotOk && historyOk && typeof data.today === 'string' && typeof data.now === 'string';
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
