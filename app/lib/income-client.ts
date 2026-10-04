/**
 * Browser-side calls to the income API (dispatch 27): the Income page's read,
 * the upload, a title's link, accepting, rejecting and proposing again, the
 * kept file's link, and a property's lines for its page. The contract of
 * reports-client.ts: every call resolves to a result, never throws, never
 * turns a failure into an empty list, and says whether a write's outcome is
 * unknown. Nothing is retried.
 *
 * Client-safe. Imports only the models.
 */

import { describeErrorBody, readErrorBody } from '@/app/lib/api/http-failure';
import type { Line, StatementDraftView } from '@/app/lib/reports/model';
import type { EarningsLineView, EarningsUploadView, IncomeChannel, TitleLinkView } from '@/app/lib/income/model';

export type IncomeResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; title: string; detail?: string; code?: string; evidence?: Record<string, unknown>; unknown: boolean };

/** One property-month's statement as the Income page reads it. */
export interface MonthStatement {
  propertyId: string;
  draftId: string | null;
  revision: number | null;
  finished: boolean;
  lines: Line[];
}

/** What GET /api/admin/income answers. */
export interface IncomeMonth {
  month: string;
  today: string;
  uploads: EarningsUploadView[];
  lines: EarningsLineView[];
  links: TitleLinkView[];
  lastSeen: Record<string, string>;
  properties: { id: string; name: string }[];
  statements: MonthStatement[];
  calendar: { days: string[]; checkIns: { propertyId: string; days: string[] }[] };
  unreadable: number;
}

const isRecord = (data: unknown): data is Record<string, unknown> => !!data && typeof data === 'object' && !Array.isArray(data);
const isAppFailure = (body: Record<string, unknown>): boolean => body.success === false && typeof body.error === 'string';

function describeIssues(body: Record<string, unknown>): string | null {
  if (!Array.isArray(body.issues)) return null;
  const issues = body.issues
    .filter(isRecord)
    .map((i) => [i.path, i.message].filter((part) => typeof part === 'string' && part).join(': '))
    .filter(Boolean);
  return issues.length > 0 ? issues.join('; ') : null;
}

async function call<T>(url: string, init: RequestInit, action: string, isExpected: (data: unknown) => boolean, unconfirmedCodes: readonly string[] = []): Promise<IncomeResult<T>> {
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
    const detail = [failure.detail, describeIssues(body)].filter(Boolean).join(' · ');
    return {
      ok: false,
      status: failure.status,
      title: failure.title,
      detail: detail || undefined,
      code,
      evidence: isRecord(body.evidence) ? body.evidence : undefined,
      unknown: (res.status >= 500 && !isAppFailure(body)) || (code !== undefined && unconfirmedCodes.includes(code)),
    };
  }
  if (!isExpected(body.data)) {
    return { ok: false, status: res.status, title: `${action}: the server's answer was not in the expected form.`, detail: 'Nothing is shown rather than something that might be wrong.', unknown: true };
  }
  return { ok: true, data: body.data as T };
}

const isLine = (data: unknown): boolean => isRecord(data) && typeof data.id === 'string' && typeof data.amountCents === 'number' && typeof data.status === 'string' && typeof data.month === 'string';
const isUpload = (data: unknown): boolean => isRecord(data) && typeof data.id === 'string' && isRecord(data.file) && isRecord(data.read) && Array.isArray(data.titles);
const isDraft = (data: unknown): boolean => isRecord(data) && typeof data.id === 'string' && typeof data.revision === 'number' && Array.isArray(data.lines);

export function fetchIncomeMonth(month: string): Promise<IncomeResult<IncomeMonth>> {
  return call(`/api/admin/income?month=${encodeURIComponent(month)}`, {}, 'Loading the month\'s income failed', (data) =>
    isRecord(data) &&
    typeof data.month === 'string' &&
    Array.isArray(data.uploads) &&
    data.uploads.every(isUpload) &&
    Array.isArray(data.lines) &&
    data.lines.every(isLine) &&
    Array.isArray(data.links) &&
    isRecord(data.lastSeen) &&
    Array.isArray(data.properties) &&
    Array.isArray(data.statements) &&
    isRecord(data.calendar) &&
    Array.isArray(data.calendar.days) &&
    Array.isArray(data.calendar.checkIns),
  );
}

/** Upload a file for a month. A 502 UPLOAD_RECORD_FAILED is unknown: reload to see. */
export function uploadIncomeFile(month: string, channel: IncomeChannel, file: File): Promise<IncomeResult<{ upload: EarningsUploadView }>> {
  const form = new FormData();
  form.append('month', month);
  form.append('channel', channel);
  form.append('file', file, file.name);
  return call('/api/admin/income/uploads', { method: 'POST', body: form }, 'Uploading the file failed', (data) => isRecord(data) && isUpload(data.upload), ['UPLOAD_RECORD_FAILED']);
}

export function linkTitle(input: { channel: IncomeChannel; title: string; propertyId: string; expected: string | null }): Promise<IncomeResult<{ link: TitleLinkView }>> {
  return call('/api/admin/income/links', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }, 'Linking the title failed', (data) => isRecord(data) && isRecord(data.link), ['LINK_WRITE_FAILED']);
}

/** Accept lines into the property's draft; `description` and `amount` only when the admin changed them. */
export function acceptIncomeLines(input: { propertyId: string; month: string; lines: { id: string; description?: string; amount?: string }[] }): Promise<IncomeResult<{ draft: StatementDraftView; lines: EarningsLineView[] }>> {
  return call('/api/admin/income/lines/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }, 'Accepting failed', (data) => isRecord(data) && isDraft(data.draft) && Array.isArray(data.lines) && data.lines.every(isLine), ['ACCEPT_FAILED']);
}

export function decideIncomeLine(id: string, action: 'reject' | 'propose-again'): Promise<IncomeResult<{ line: EarningsLineView }>> {
  return call(`/api/admin/income/lines/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) }, action === 'reject' ? 'Rejecting failed' : 'Proposing again failed', (data) => isRecord(data) && isLine(data.line), ['DECISION_FAILED']);
}

/** A 60-second link to an upload's kept file (Guest and Details blanked). */
export function fetchUploadFileLink(uploadId: string): Promise<IncomeResult<{ url: string; expiresAt: string; seconds: number }>> {
  return call(`/api/admin/income/uploads/${encodeURIComponent(uploadId)}/file`, {}, 'Opening the file failed', (data) => isRecord(data) && typeof data.url === 'string' && data.url.startsWith('https://'));
}

/** One property's lines from the files, for its page. */
export function fetchPropertyIncome(propertyId: string): Promise<IncomeResult<{ lines: EarningsLineView[]; uploads: { id: string; name: string; month: string }[] }>> {
  return call(`/api/admin/properties/${encodeURIComponent(propertyId)}/income`, {}, 'Loading the lines from the files failed', (data) => isRecord(data) && Array.isArray(data.lines) && data.lines.every(isLine) && Array.isArray(data.uploads));
}
