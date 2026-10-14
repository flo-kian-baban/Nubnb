/**
 * Browser-side calls for admin accounts (dispatch 38): signing in by PIN and
 * out, one's own PIN and name, and the main admin's Admins page.
 *
 * The contract of cleaners-client.ts: every call resolves to a result and
 * never throws, a failure is never turned into an empty list, requests are
 * `no-store`, and a failure says whether its outcome is unknown — a request
 * that got no answer, or a 5xx the application did not write, says nothing
 * about whether a write landed. Nothing is retried automatically.
 *
 * PINs travel in request bodies, and to a main admin in the Admins list's
 * answer (Kian's rulings of 2026-10-13, night: main admins see every admin's
 * PIN); this module never stores one.
 *
 * Client-safe. From the admin library it imports only model.ts.
 */

import { describeErrorBody, readErrorBody } from '@/app/lib/api/http-failure';
import { isPinState } from '@/app/lib/admins/model';
import type { AdminActionView, AdminLevel, AdminSummary, SignInLockView, SignedInAdminView } from '@/app/lib/admins/model';

export type AdminResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      /** HTTP status, or 0 when the request never reached the server. */
      status: number;
      title: string;
      detail?: string;
      code?: string;
      /** On a locked connection (429 ADMIN_SIGN_IN_LOCKED): when the lock ends (null: until a main admin lifts it), and whether this try locked it. */
      lockedUntil?: string | null;
      capped?: boolean;
      lockedNow?: boolean;
      /** The route's hint alone, unjoined: the sign-in shows it under its one line. */
      hint?: string;
      unknown: boolean;
    };

const isRecord = (data: unknown): data is Record<string, unknown> => !!data && typeof data === 'object' && !Array.isArray(data);

function describeIssues(body: Record<string, unknown>): string | null {
  if (!Array.isArray(body.issues)) return null;
  const issues = body.issues.filter(isRecord).map((i) => (typeof i.message === 'string' ? i.message : '')).filter(Boolean);
  return issues.length > 0 ? issues.join(' ') : null;
}

async function call<T>(url: string, init: RequestInit, action: string, pick: (data: unknown) => T | null): Promise<AdminResult<T>> {
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
    const issues = describeIssues(body);
    return {
      ok: false,
      status: res.status,
      title: issues && res.status === 422 ? issues : failure.title,
      detail: failure.detail,
      code,
      hint: typeof body.hint === 'string' ? body.hint : undefined,
      lockedUntil: typeof body.lockedUntil === 'string' ? body.lockedUntil : body.lockedUntil === null ? null : undefined,
      capped: body.capped === true,
      lockedNow: body.lockedNow === true,
      unknown: (res.status >= 500 && !(body.success === false && typeof body.error === 'string')) || code?.endsWith('_UNCONFIRMED') === true,
    };
  }
  const data = pick(body.data);
  if (data === null) {
    return { ok: false, status: res.status, title: `${action}: the server's answer was not in the expected form.`, unknown: true };
  }
  return { ok: true, data };
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

function pickAdmin(data: unknown): SignedInAdminView | null {
  if (!isRecord(data) || !isRecord(data.admin)) return null;
  const a = data.admin;
  if (typeof a.id !== 'string' || typeof a.name !== 'string' || (a.level !== 'main' && a.level !== 'admin') || !isPinState(a.pin)) return null;
  return { id: a.id, name: a.name, level: a.level, pin: a.pin };
}

const pickSummary = (value: unknown): AdminSummary | null => (isRecord(value) && typeof value.id === 'string' && Array.isArray(value.history) ? (value as unknown as AdminSummary) : null);


// ─── Signing in, and one's own account ─────────────────────────

/** Who this browser is signed in as; a 401 means nobody. */
export const fetchSignedIn = () => call('/api/admin-auth', { method: 'GET' }, 'Checking your sign-in', pickAdmin);

/** Sign in by PIN alone. */
export const signIn = (pin: string) => call('/api/admin-auth', json('POST', { pin }), 'Signing in', pickAdmin);

export const signOut = () => call('/api/admin-auth', { method: 'DELETE' }, 'Signing out', (data) => (isRecord(data) ? true : null));

/** Change PIN, from one's own menu or the gate's Set your PIN: the current PIN, then the new one. */
export const changeOwnPin = (currentPin: string, newPin: string) => call('/api/admin-auth/pin', json('POST', { currentPin, newPin }), 'Changing your PIN', pickAdmin);

export const changeOwnName = (name: string) =>
  call('/api/admin-auth/name', json('PUT', { name }), 'Changing your name', (data) => {
    const admin = pickAdmin(data);
    return admin && isRecord(data) ? { admin, changed: data.changed !== false } : null;
  });

// ─── The main admin's page ─────────────────────────────────────

export const fetchAdmins = () =>
  call('/api/admin/admins', { method: 'GET' }, 'Loading admins', (data) => {
    if (!isRecord(data) || !Array.isArray(data.admins)) return null;
    const admins = data.admins.map(pickSummary);
    return admins.every((a): a is AdminSummary => a !== null) ? admins : null;
  });

export const fetchActivity = (limit = 100) =>
  call(`/api/admin/admins/activity?limit=${limit}`, { method: 'GET' }, 'Loading the activity', (data) => (isRecord(data) && Array.isArray(data.actions) ? (data.actions as AdminActionView[]) : null));

export const fetchLocks = () =>
  call('/api/admin/admins/locks', { method: 'GET' }, 'Loading the locked connections', (data) => (isRecord(data) && Array.isArray(data.locks) ? (data.locks as SignInLockView[]) : null));

export const liftLock = (id: string) => call(`/api/admin/admins/locks/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'Lifting the lock', (data) => (isRecord(data) && isRecord(data.lifted) ? true : null));

const pickChange = (data: unknown) => {
  if (!isRecord(data)) return null;
  const admin = pickSummary(data.admin);
  return admin ? { admin, changed: data.changed !== false } : null;
};

/** Add an admin, with the PIN the main admin sets. */
export const createAdmin = (name: string, level: AdminLevel, pin: string) =>
  call('/api/admin/admins', json('POST', { name, level, pin }), 'Adding the admin', (data) => (isRecord(data) ? pickSummary(data.admin) : null));

export const setAdminLevel = (id: string, level: AdminLevel) => call(`/api/admin/admins/${encodeURIComponent(id)}`, json('PATCH', { level }), 'Setting the level', pickChange);

/** Set an ordinary admin's PIN, from the main admin's page. */
export const setAdminPin = (id: string, pin: string) => call(`/api/admin/admins/${encodeURIComponent(id)}/pin`, json('POST', { pin }), 'Setting the PIN', pickChange);

export const removeAdmin = (id: string) =>
  call(`/api/admin/admins/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'Removing the admin', (data) => (isRecord(data) && isRecord(data.removed) ? true : null));

/** A lock's end as the sign-in shows it: "4:32 pm", in this browser's time; "a main admin lifts it" for the day's cap. */
export function lockTimeWords(iso: string | null): string {
  if (iso === null) return 'a main admin lifts it';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'later';
  return date.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' }).replace('a.m.', 'am').replace('p.m.', 'pm');
}

/** Whether a failed answer is a locked connection: 429 with when it ends, or with no end (the day's cap). */
export const isLockedAnswer = (result: { status: number; lockedUntil?: string | null }): result is { status: 429; lockedUntil: string | null } => result.status === 429 && result.lockedUntil !== undefined;
