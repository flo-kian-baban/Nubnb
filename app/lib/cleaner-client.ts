/**
 * Browser-side calls to the cleaner API, for the cleaner app at /cleaner.
 *
 * Every call resolves and never throws. Each answer is sorted into what the
 * app does next — carry on, ask for the code, say the phone is offline, or
 * say what was refused — rather than handed over as a status code.
 *
 * Sending an entry uses XMLHttpRequest rather than fetch, for one reason:
 * upload progress. A receipt photo on a weak signal takes a while, and a bar
 * that moves tells the cleaner it is working.
 *
 * Client-safe. From the cleaner library it imports only the model.
 */

import type { CleanerEntry, CleanerStart } from '@/app/lib/cleaners/model';
import type { CleanerJobView } from '@/app/lib/schedule/model';

/** The `entry` part of a send, exactly as POST /api/cleaner/entries reads it. */
export interface EntryPayload {
  submissionKey: string;
  propertyId: string;
  lines: { name: string; quantity: string; lineTotal: string }[];
  /** The receipt's tax as printed, "12.71", apart from the items (dispatch 21); null when none. */
  tax: string | null;
}

/** The body of a work send (dispatch 24), exactly as POST /api/cleaner/work reads it. */
export interface WorkPayload {
  submissionKey: string;
  propertyId: string;
  description: string;
  /** "185.00" */
  price: string;
}

/**
 * The `reading` part of a send (dispatch 20): the signed record the read
 * route gave this photo, verbatim, and for each entry line the model line
 * it was filled from, or null for a line the cleaner added.
 */
export interface ReadingPart {
  readingText: string;
  signature: string;
  fromReading: (number | null)[];
}

export type ReadReceiptResult =
  /** An answer, signed: the record inside may say `ok` or `failed`. */
  | { kind: 'ok'; readingText: string; signature: string }
  /** The session ended. The receipt is untouched. */
  | { kind: 'signed-out' }
  /** No answer: no signal, a timeout, or a server that could not read. The receipt is untouched. */
  | { kind: 'failed' };

export type StartResult =
  | { kind: 'ok'; start: CleanerStart }
  /** No session, or one that no longer holds: show the code screen. */
  | { kind: 'signed-out' }
  /** No answer at all. */
  | { kind: 'offline' }
  | { kind: 'failed' };

export type SignInResult =
  | { kind: 'ok' }
  /** `warning`: the line the server gives on the wrong code before a lock (Kian's ruling of 2026-10-14, evening). */
  | { kind: 'not-recognised'; warning: string | null }
  /** Sign-in from this connection is locked: until `until`, or, when null, until the office lifts it. */
  | { kind: 'locked'; until: string | null }
  | { kind: 'offline' }
  | { kind: 'failed' };

export type JobActionResult =
  /** Done; `job` is the job as it now stands, or null when it could not be read back (reload to see it). */
  | { kind: 'ok'; job: CleanerJobView | null }
  /** The session ended. Nothing was recorded. */
  | { kind: 'signed-out' }
  /** The server said no, in words fit for the cleaner. Nothing was recorded. */
  | { kind: 'refused'; message: string }
  /** No confirmation. Pressing again is safe: a mark is never made twice. */
  | { kind: 'not-sent'; offline: boolean };

export type SendResult =
  /** Recorded now, or by an earlier send of the same receipt whose answer was lost. */
  | { kind: 'sent'; id: string; alreadyReceived: boolean }
  /** The session ended (code changed, deactivated, 12 hours passed). Nothing was recorded. */
  | { kind: 'signed-out' }
  /** The server turned the entry down as it stands. Nothing was recorded. */
  | { kind: 'refused'; code: string | null }
  /**
   * No confirmation: no answer, a timeout, or a server failure. Sending
   * again is safe — the one-time key stops a second entry.
   */
  | { kind: 'not-sent'; offline: boolean };

export type MyEntriesResult =
  | { kind: 'ok'; entries: CleanerEntry[] }
  /** No session, or one that no longer holds: show the code screen. */
  | { kind: 'signed-out' }
  /** No answer at all. */
  | { kind: 'offline' }
  | { kind: 'failed' };

/** Long enough for a 4 MiB photo on a weak signal. */
const SEND_TIMEOUT_MS = 120_000;
/** The photo up, the model's 20 seconds, and the answer back. After this the form is the cleaner's alone. */
const READ_TIMEOUT_MS = 45_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const isTextOrNull = (value: unknown): boolean => value === null || typeof value === 'string';

function isCleanerStart(data: unknown): data is CleanerStart {
  return (
    isRecord(data) &&
    isRecord(data.cleaner) &&
    typeof data.cleaner.id === 'string' &&
    isTextOrNull(data.cleaner.name) &&
    typeof data.cleaner.role === 'string' &&
    Array.isArray(data.properties) &&
    data.properties.every(
      (p) => isRecord(p) && typeof p.id === 'string' && isTextOrNull(p.name) && isTextOrNull(p.city),
    ) &&
    Array.isArray(data.recentPropertyIds) &&
    data.recentPropertyIds.every((id) => typeof id === 'string') &&
    Array.isArray(data.itemNames) &&
    data.itemNames.every((name) => typeof name === 'string') &&
    Array.isArray(data.jobs) &&
    data.jobs.every(isCleanerJob) &&
    // Their own pay (Team pay, 2026-10-15): three figures and two counts, theirs only.
    isRecord(data.pay) &&
    ['earnedCents', 'paidCents', 'balanceCents', 'waiting', 'cannotAddUp'].every((key) => typeof (data.pay as Record<string, unknown>)[key] === 'number') &&
    typeof data.today === 'string'
  );
}

/** A job as the server sends it to a cleaner (the cleaning schedule, 2026-10-14). */
function isCleanerJob(data: unknown): data is CleanerJobView {
  return (
    isRecord(data) &&
    typeof data.id === 'string' &&
    typeof data.propertyId === 'string' &&
    isTextOrNull(data.propertyName) &&
    isTextOrNull(data.city) &&
    typeof data.checkout === 'string' &&
    isTextOrNull(data.checkOutTime) &&
    isTextOrNull(data.checkInTime) &&
    isTextOrNull(data.nextCheckIn) &&
    (data.status === 'open' || data.status === 'booking-changed') &&
    isTextOrNull(data.markedAt) &&
    typeof data.canUndo === 'boolean' &&
    isTextOrNull(data.markRefusal)
  );
}

const isNumberOrNull = (value: unknown): boolean => value === null || typeof value === 'number';

function isCleanerEntry(data: unknown): data is CleanerEntry {
  return (
    isRecord(data) &&
    typeof data.id === 'string' &&
    isTextOrNull(data.createdAt) &&
    isTextOrNull(data.propertyId) &&
    isTextOrNull(data.propertyNameAtEntry) &&
    isNumberOrNull(data.lineCount) &&
    isNumberOrNull(data.totalCents) &&
    isNumberOrNull(data.sentTotalCents) &&
    typeof data.corrected === 'boolean' &&
    isTextOrNull(data.status) &&
    isTextOrNull(data.statusReason) &&
    typeof data.kind === 'string' &&
    isTextOrNull(data.description)
  );
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const body = await res.json();
    return isRecord(body) ? body : {};
  } catch {
    return {};
  }
}

function parseJson(text: string): Record<string, unknown> {
  try {
    const body: unknown = JSON.parse(text);
    return isRecord(body) ? body : {};
  } catch {
    return {};
  }
}

/** Who is signed in, and what the app lists. */
export async function loadStart(): Promise<StartResult> {
  let res: Response;
  try {
    res = await fetch('/api/cleaner/start', { cache: 'no-store' });
  } catch {
    return { kind: 'offline' };
  }
  if (res.status === 401) return { kind: 'signed-out' };
  const body = await readJson(res);
  if (res.ok && isCleanerStart(body.data)) return { kind: 'ok', start: body.data };
  return { kind: 'failed' };
}

/** This cleaner's own entries, newest first, with their status. A failure is never an empty list. */
export async function loadMyEntries(): Promise<MyEntriesResult> {
  let res: Response;
  try {
    res = await fetch('/api/cleaner/entries', { cache: 'no-store' });
  } catch {
    return { kind: 'offline' };
  }
  if (res.status === 401) return { kind: 'signed-out' };
  const body = await readJson(res);
  const data = isRecord(body.data) ? body.data : null;
  if (res.ok && data && Array.isArray(data.entries) && data.entries.every(isCleanerEntry)) {
    return { kind: 'ok', entries: data.entries };
  }
  return { kind: 'failed' };
}

/** Sign in with a four-digit code. The session cookie comes back with a 200. */
export async function signIn(code: string): Promise<SignInResult> {
  let res: Response;
  try {
    res = await fetch('/api/cleaner/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
      cache: 'no-store',
    });
  } catch {
    return { kind: 'offline' };
  }
  if (res.ok) return { kind: 'ok' };
  if (res.status === 401) {
    const body = await readJson(res);
    return { kind: 'not-recognised', warning: typeof body.hint === 'string' && body.hint ? body.hint : null };
  }
  if (res.status === 429) {
    const body = await readJson(res);
    if (body.code === 'CLEANER_SIGN_IN_LOCKED') return { kind: 'locked', until: typeof body.lockedUntil === 'string' ? body.lockedUntil : null };
  }
  return { kind: 'failed' };
}

/** Mark a job cleaned, or undo one's own mark (POST /api/cleaner/jobs/[id]). Never throws. */
export async function jobAction(jobId: string, action: 'mark' | 'undo'): Promise<JobActionResult> {
  let res: Response;
  try {
    res = await fetch(`/api/cleaner/jobs/${encodeURIComponent(jobId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
      cache: 'no-store',
    });
  } catch {
    return { kind: 'not-sent', offline: !navigator.onLine };
  }
  const body = await readJson(res);
  if (res.ok) {
    const data = isRecord(body.data) ? body.data : {};
    return { kind: 'ok', job: isCleanerJob(data.job) ? data.job : null };
  }
  if (res.status === 401) return { kind: 'signed-out' };
  if (res.status >= 400 && res.status < 500 && body.success === false) {
    const message = typeof body.error === 'string' && body.error ? body.error : 'That could not be done.';
    return { kind: 'refused', message: typeof body.hint === 'string' && body.hint ? `${message} ${body.hint}` : message };
  }
  return { kind: 'not-sent', offline: false };
}

/** Take the session cookie off this phone. True when the server confirmed it. */
export async function signOut(): Promise<boolean> {
  try {
    const res = await fetch('/api/cleaner/session', { method: 'DELETE', cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  }
}

function sortSend(status: number, body: Record<string, unknown>): SendResult {
  const data = isRecord(body.data) ? body.data : null;
  if ((status === 200 || status === 201) && data && typeof data.id === 'string') {
    return { kind: 'sent', id: data.id, alreadyReceived: data.alreadyReceived === true };
  }
  if (status === 401) return { kind: 'signed-out' };

  const code = typeof body.code === 'string' ? body.code : null;
  // An application answer in the 4xx range: the entry, as it stands, will not go.
  if (status >= 400 && status < 500 && body.success === false) return { kind: 'refused', code };
  // Anything else — a 5xx, a platform error page, a 2xx in the wrong form —
  // does not say whether the entry was recorded. The one-time key makes
  // sending again safe.
  return { kind: 'not-sent', offline: false };
}

/**
 * Ask the server to read the receipt photo (dispatch 20). Resolves always.
 * The photo is sent once and never stored by this call; the entry's send
 * stores it, as before.
 */
export async function readReceipt(photo: Blob, fileName: string): Promise<ReadReceiptResult> {
  const form = new FormData();
  form.append('receipt', photo, fileName);
  let res: Response;
  try {
    res = await fetch('/api/cleaner/read-receipt', {
      method: 'POST',
      body: form,
      cache: 'no-store',
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
  } catch {
    return { kind: 'failed' };
  }
  if (res.status === 401) return { kind: 'signed-out' };
  const body = await readJson(res);
  const data = isRecord(body.data) ? body.data : null;
  if (res.ok && data && typeof data.readingText === 'string' && typeof data.signature === 'string') {
    return { kind: 'ok', readingText: data.readingText, signature: data.signature };
  }
  return { kind: 'failed' };
}

/**
 * Send one piece of work (dispatch 24): JSON, no upload. Resolves always,
 * sorted as a receipt send is; the one-time key makes sending again safe.
 */
export async function sendWork(work: WorkPayload): Promise<SendResult> {
  let res: Response;
  try {
    res = await fetch('/api/cleaner/work', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(work),
      cache: 'no-store',
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
  } catch {
    return { kind: 'not-sent', offline: !navigator.onLine };
  }
  return sortSend(res.status, await readJson(res));
}

/**
 * Send one receipt: the entry as JSON text, the photo, and the reading when
 * the photo had one. `onProgress` gets the share of the upload done, from 0
 * to 1, when the browser can tell.
 */
export function sendEntry(
  entry: EntryPayload,
  photo: Blob,
  fileName: string,
  reading: ReadingPart | null,
  onProgress: (done: number) => void,
): Promise<SendResult> {
  return new Promise((resolve) => {
    const form = new FormData();
    form.append('entry', JSON.stringify(entry));
    form.append('receipt', photo, fileName);
    if (reading) form.append('reading', JSON.stringify(reading));

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/cleaner/entries');
    xhr.timeout = SEND_TIMEOUT_MS;
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => resolve(sortSend(xhr.status, parseJson(xhr.responseText)));
    xhr.onerror = () => resolve({ kind: 'not-sent', offline: !navigator.onLine });
    xhr.ontimeout = () => resolve({ kind: 'not-sent', offline: !navigator.onLine });
    xhr.onabort = () => resolve({ kind: 'not-sent', offline: !navigator.onLine });
    try {
      xhr.send(form);
    } catch {
      resolve({ kind: 'not-sent', offline: !navigator.onLine });
    }
  });
}
