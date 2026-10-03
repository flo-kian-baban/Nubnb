/**
 * Browser-side calls to the admin cleaner API.
 *
 * The same contract as leads-client.ts: every call resolves to a result and
 * never throws, a failure is never turned into an empty list, and requests
 * are `no-store`, so a reload always shows what Firestore holds.
 *
 * One addition: a failure says whether its outcome is unknown. A request that
 * never got an answer, a 2xx in the wrong form, a 5xx the application did not
 * write (the platform's 502/503/504), or an application answer that says it
 * could not confirm the write, says nothing about whether the write landed,
 * and the page must not claim either way. Nothing is retried automatically:
 * a retried create could make the same person twice.
 *
 * Codes are readable by admins (Kian's ruling of 2026-09-28), so a cleaner's
 * code travels in its list row like any other field.
 *
 * Client-safe. From the cleaner library it imports only model.ts.
 */

import { describeErrorBody, readErrorBody } from '@/app/lib/api/http-failure';
import { isTooEasyCode, type CleanerRole, type CleanerStatus, type CleanerSummary } from '@/app/lib/cleaners/model';

export type CleanerResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      /** HTTP status, or 0 when the request never reached the server. */
      status: number;
      /** One line, fit to show as a Notice title. */
      title: string;
      detail?: string;
      /** The application's error code, when it gave one. */
      code?: string;
      /** True when the answer does not say whether a write landed. */
      unknown: boolean;
    };

/** A deactivated account that held the code just given out, and now has none (Kian's ruling of 2026-10-02). */
export interface CodeReleased {
  id: string;
  name: string | null;
}

/** The answer to a status or code change: the cleaner as now stored. */
export interface CleanerChange {
  cleaner: CleanerSummary;
  /** False when the cleaner already had that status or code and nothing was written. */
  changed: boolean;
  /** On a code change: who let the code go, or null. */
  released?: CodeReleased | null;
}

const isReleased = (value: unknown): boolean => value === null || value === undefined || (isRecord(value) && typeof value.id === 'string' && isTextOrNull(value.name));

/** A cleaner's new code: four digits the admin typed, or one the server draws. */
export type CodeRequest = { code: string } | { generate: true };

const isRecord = (data: unknown): data is Record<string, unknown> =>
  !!data && typeof data === 'object' && !Array.isArray(data);

/** A failure body the application wrote: `{ success: false, error: string }`. */
const isAppFailure = (body: Record<string, unknown>): boolean =>
  body.success === false && typeof body.error === 'string';

const isTextOrNull = (value: unknown): boolean => value === null || typeof value === 'string';

/** A list row in the shape the page renders. `history` is not rendered, so only its kind is checked. */
function isCleanerSummary(data: unknown): data is CleanerSummary {
  return (
    isRecord(data) &&
    typeof data.id === 'string' &&
    isTextOrNull(data.name) &&
    isTextOrNull(data.code) &&
    isTextOrNull(data.status) &&
    isTextOrNull(data.statusChangedAt) &&
    isTextOrNull(data.createdAt) &&
    (data.history === null || Array.isArray(data.history)) &&
    typeof data.role === 'string'
  );
}

/** The field-level issues of a 422, as one line. */
function describeIssues(body: Record<string, unknown>): string | null {
  if (!Array.isArray(body.issues)) return null;
  const issues = body.issues
    .filter(isRecord)
    .map((i) => [i.path, i.message].filter((part) => typeof part === 'string' && part).join(': '))
    .filter(Boolean);
  return issues.length > 0 ? issues.join('; ') : null;
}

async function call<T>(
  url: string,
  init: RequestInit,
  /** What was attempted, used only when the server gave no reason, e.g. "Loading cleaners failed". */
  action: string,
  isExpected: (data: unknown) => boolean,
  /** Application error codes that mean the write may or may not have landed. */
  unconfirmedCodes: readonly string[] = [],
): Promise<CleanerResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, cache: 'no-store' });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      title: `${action}: the server could not be reached.`,
      detail: err instanceof Error ? err.message : undefined,
      unknown: true,
    };
  }

  // readErrorBody is the tolerant JSON read — it never throws, whatever came back.
  const body = await readErrorBody(res);

  if (!res.ok) {
    const failure = describeErrorBody(body, res.status, action);
    const code = typeof body.code === 'string' ? body.code : undefined;
    const detail = [failure.detail, describeIssues(body)].filter(Boolean).join(' · ');
    return {
      ok: false,
      status: failure.status,
      title: failure.title,
      detail: detail || undefined,
      code,
      unknown:
        (res.status >= 500 && !isAppFailure(body)) ||
        (code !== undefined && unconfirmedCodes.includes(code)),
    };
  }

  if (!isExpected(body.data)) {
    return {
      ok: false,
      status: res.status,
      title: `${action}: the server's answer was not in the expected form.`,
      detail: 'Nothing is shown rather than something that might be wrong.',
      unknown: true,
    };
  }
  return { ok: true, data: body.data as T };
}

export function fetchCleaners(): Promise<CleanerResult<CleanerSummary[]>> {
  return call(
    '/api/admin/cleaners',
    {},
    'Loading cleaners failed',
    (data) => Array.isArray(data) && data.every(isCleanerSummary),
  );
}

/** Create a cleaner or a handyman (dispatch 24). The answer carries the new account, code included. Never retried. */
/** Create a cleaner or a handyman holding the four digits the admin typed (dispatch 23H). */
export function createCleaner(name: string, role: CleanerRole, code: string): Promise<CleanerResult<{ cleaner: CleanerSummary; released: CodeReleased | null }>> {
  return call(
    '/api/admin/cleaners',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, role, code }),
    },
    'Creating the cleaner failed',
    (data) => isRecord(data) && isCleanerSummary(data.cleaner) && data.cleaner.code === code && isReleased(data.released),
    ['CLEANER_CREATE_UNCONFIRMED'],
  );
}

/**
 * A code to offer in the create dialog: four digits drawn uniformly from the
 * browser's CSPRNG, never one on the reserved list. Only a suggestion, typed
 * into the field for the admin to keep or change: the server still refuses
 * the admin PIN and any code issued before.
 */
export function suggestCode(): string {
  const draw = new Uint16Array(1);
  for (;;) {
    crypto.getRandomValues(draw);
    // 60,000 is the largest multiple of 10,000 under 65,536: no digit is favoured.
    if (draw[0] >= 60_000) continue;
    const code = String(draw[0] % 10_000).padStart(4, '0');
    if (!isTooEasyCode(code)) return code;
  }
}

export function changeCleanerStatus(
  id: string,
  status: CleanerStatus,
): Promise<CleanerResult<CleanerChange>> {
  return call(
    `/api/admin/cleaners/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    },
    'Changing the status failed',
    (data) =>
      isRecord(data) &&
      isCleanerSummary(data.cleaner) &&
      data.cleaner.id === id &&
      data.cleaner.status === status &&
      typeof data.changed === 'boolean',
  );
}

/**
 * Give a cleaner a new code. On success the answer's cleaner holds the new
 * code — the typed one, or the one the server drew.
 */
export function changeCleanerCode(
  id: string,
  request: CodeRequest,
): Promise<CleanerResult<CleanerChange>> {
  return call(
    `/api/admin/cleaners/${encodeURIComponent(id)}/code`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    },
    'Changing the code failed',
    (data) =>
      isRecord(data) &&
      isCleanerSummary(data.cleaner) &&
      data.cleaner.id === id &&
      typeof data.cleaner.code === 'string' &&
      ('code' in request ? data.cleaner.code === request.code : true) &&
      typeof data.changed === 'boolean' &&
      isReleased(data.released),
    ['CLEANER_CODE_CHANGE_FAILED'],
  );
}

/** What a delete answers: the account as it was, and how many of its codes were retired. */
export interface CleanerDeleted {
  id: string;
  name: string | null;
  role: string;
  codes: number;
}

/**
 * Delete a cleaner or a handyman for good (Kian's ruling of 2026-10-02). The
 * page confirms before calling; CLEANER_DELETE_FAILED means the answer does
 * not say whether the account is gone.
 */
export function deleteCleaner(id: string): Promise<CleanerResult<{ deleted: CleanerDeleted }>> {
  return call(
    `/api/admin/cleaners/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
    'Deleting the team member failed',
    (data) =>
      isRecord(data) &&
      isRecord(data.deleted) &&
      data.deleted.id === id &&
      isTextOrNull(data.deleted.name) &&
      typeof data.deleted.role === 'string' &&
      typeof data.deleted.codes === 'number',
    ['CLEANER_DELETE_FAILED'],
  );
}
