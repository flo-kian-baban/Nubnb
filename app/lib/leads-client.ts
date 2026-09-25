/**
 * Browser-side calls to the admin lead API.
 *
 * Every call resolves to a result and never throws. A failure is never turned
 * into an empty list: the dashboard and the inbox must be able to say "could
 * not load" rather than "no leads". Requests are `no-store`, so a reload
 * always shows what Firestore holds, never a cached answer from before a
 * status change.
 */

import { describeHttpFailure, readErrorBody } from '@/app/lib/api/http-failure';
import type { LeadDetail, LeadStatus, LeadStatusChange, LeadSummary } from '@/app/lib/leads';

export type LeadResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      /** HTTP status, or 0 when the request never reached the server. */
      status: number;
      /** One line, fit to show as a Notice title. */
      title: string;
      detail?: string;
    };

async function call<T>(
  url: string,
  init: RequestInit,
  /** What was attempted, used only when the server gave no reason, e.g. "Loading leads failed". */
  action: string,
  isExpected: (data: unknown) => boolean,
): Promise<LeadResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, cache: 'no-store' });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      title: `${action}: the server could not be reached.`,
      detail: err instanceof Error ? err.message : undefined,
    };
  }

  if (!res.ok) {
    const failure = await describeHttpFailure(res, action);
    return { ok: false, status: failure.status, title: failure.title, detail: failure.detail };
  }

  // readErrorBody is the tolerant JSON read — it never throws, whatever came back.
  const body = await readErrorBody(res);
  if (!isExpected(body.data)) {
    return {
      ok: false,
      status: res.status,
      title: `${action}: the server's answer was not in the expected form.`,
      detail: 'Nothing is shown rather than something that might be wrong.',
    };
  }
  return { ok: true, data: body.data as T };
}

const isRecord = (data: unknown): data is Record<string, unknown> =>
  !!data && typeof data === 'object' && !Array.isArray(data);

export function fetchLeads(): Promise<LeadResult<LeadSummary[]>> {
  return call('/api/leads', {}, 'Loading leads failed', Array.isArray);
}

export function fetchLead(id: string): Promise<LeadResult<LeadDetail>> {
  return call(
    `/api/leads/${encodeURIComponent(id)}`,
    {},
    'Loading this lead failed',
    (data) => isRecord(data) && typeof data.id === 'string' && isRecord(data.fields),
  );
}

export function changeLeadStatus(
  id: string,
  status: LeadStatus,
): Promise<LeadResult<LeadStatusChange>> {
  return call(
    `/api/leads/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    },
    'Changing the status failed',
    (data) =>
      isRecord(data) && data.status === status && typeof data.statusChangedAt === 'string',
  );
}
