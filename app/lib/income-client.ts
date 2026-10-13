/**
 * Browser-side calls to the income API (dispatch 27; dispatch 37C): the
 * Income page's read, the upload, a title's link (a property's active title),
 * accepting, rejecting one or a property's together, proposing again or
 * sending back, editing an accepted line, the kept file's link, a property's
 * lines for its page, and its titles for its edit page. The contract of
 * reports-client.ts: every call resolves to a result, never throws, never
 * turns a failure into an empty list, and says whether a write's outcome is
 * unknown. Nothing is retried.
 *
 * Client-safe. Imports only the models.
 */

import { describeErrorBody, readErrorBody } from '@/app/lib/api/http-failure';
import type { Line } from '@/app/lib/reports/model';
import type { EarningsLineView, EarningsUploadView, IncomeChannel, TitleLinkView } from '@/app/lib/income/model';
import type { RenameSuggestion } from '@/app/lib/income/month';

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
  /** While a correction is written: the lines of the statement it replaces, as sent (dispatch 37A). */
  sent: Line[] | null;
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
  /** Properties that owe no statement for the month, and why (dispatch 37C, I5). */
  noStatement: { propertyId: string; why: string }[];
  /** Titles that may be a linked title renamed (M14): offered, never applied. */
  renames: RenameSuggestion[];
  /** The month's accepted lines a finished statement prints, by line ID: locked (M10). */
  locked: Record<string, { month: string; reference: string }>;
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
const isLink = (data: unknown): boolean => isRecord(data) && typeof data.id === 'string' && typeof data.title === 'string';

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
    Array.isArray(data.calendar.checkIns) &&
    Array.isArray(data.noStatement) &&
    Array.isArray(data.renames) &&
    isRecord(data.locked),
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

/** What making a title a property's active title answers (dispatch 37C): the link, the title it replaced (now previous), how many lines went back for review. */
export interface TitleSet {
  link: TitleLinkView;
  previous: string | null;
  sentBack: number;
}
const isTitleSet = (data: unknown): boolean => isRecord(data) && isLink(data.link) && (data.previous === null || typeof data.previous === 'string') && typeof data.sentBack === 'number';

/**
 * Make a title a property's active title (Kian's rulings of 2026-10-13): the Income page's Link, the second way to set
 * the title the edit page sets. A title linked to another property moves while none of its lines is on a finished
 * statement (M13). `expected` is the title's link as the page showed it (`linkState`).
 */
export function linkTitle(input: { channel: IncomeChannel; title: string; propertyId: string; expected: string | null }): Promise<IncomeResult<TitleSet>> {
  return call('/api/admin/income/links', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }, 'Linking the title failed', isTitleSet, ['LINK_WRITE_FAILED']);
}

/**
 * Set a title aside as not a Nubnb property (dispatch 36, Kian's ruling of 2026-10-12): it stays listed and marked,
 * leaves the gaps count, and its proposed lines are rejected (`rejected`, how many). `expected` is the link's state
 * as the page showed it (`linkState`).
 */
export function setTitleAside(input: { channel: IncomeChannel; title: string; expected: string | null }): Promise<IncomeResult<{ link: TitleLinkView; rejected: number }>> {
  return call('/api/admin/income/links', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input, notNubnb: true }) }, 'Setting the title aside failed', (data) => isRecord(data) && isRecord(data.link) && typeof data.rejected === 'number', ['LINK_WRITE_FAILED']);
}

/**
 * Accept lines for a property (dispatch 37C, M10: read where they are stored, never copied into the draft);
 * `description` and `amount` only when the admin changed them. The answer names the month whose statement they go
 * on: theirs while open, else the next open one (M11).
 */
export function acceptIncomeLines(input: { propertyId: string; month: string; lines: { id: string; description?: string; amount?: string }[] }): Promise<IncomeResult<{ lines: EarningsLineView[]; statementMonth: string }>> {
  return call('/api/admin/income/lines/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }, 'Accepting failed', (data) => isRecord(data) && Array.isArray(data.lines) && data.lines.every(isLine) && typeof data.statementMonth === 'string', ['ACCEPT_FAILED']);
}

/** Reject a proposed line, or propose a line again: a rejected one, or an accepted one sent back for review while no finished statement locks it. */
export function decideIncomeLine(id: string, action: 'reject' | 'propose-again'): Promise<IncomeResult<{ line: EarningsLineView }>> {
  return call(`/api/admin/income/lines/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) }, action === 'reject' ? 'Rejecting failed' : 'Proposing again failed', (data) => isRecord(data) && isLine(data.line), ['DECISION_FAILED']);
}

/** Edit an accepted line (M10: the line itself changes, with its history), as the page saw it (`seen`: its history's length). */
export function editIncomeLine(id: string, input: { seen: number; description?: string; amount?: string }): Promise<IncomeResult<{ line: EarningsLineView }>> {
  return call(`/api/admin/income/lines/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'edit', ...input }) }, 'Saving the line failed', (data) => isRecord(data) && isLine(data.line), ['EDIT_FAILED']);
}

/** Reject a property's proposed lines together (N2). */
export function rejectIncomeLines(ids: string[]): Promise<IncomeResult<{ lines: EarningsLineView[] }>> {
  return call('/api/admin/income/lines/reject', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) }, 'Rejecting failed', (data) => isRecord(data) && Array.isArray(data.lines) && data.lines.every(isLine), ['DECISION_FAILED']);
}

/** A 60-second link to an upload's kept file (Guest and Details blanked). */
export function fetchUploadFileLink(uploadId: string): Promise<IncomeResult<{ url: string; expiresAt: string; seconds: number }>> {
  return call(`/api/admin/income/uploads/${encodeURIComponent(uploadId)}/file`, {}, 'Opening the file failed', (data) => isRecord(data) && typeof data.url === 'string' && data.url.startsWith('https://'));
}

/** A title in a month's files that no link names (dispatch 34, I1). */
export interface UnlinkedTitle {
  month: string;
  title: string;
  rows: number;
  amountCents: number;
}

const isUnlinkedTitle = (data: unknown): boolean => isRecord(data) && typeof data.month === 'string' && typeof data.title === 'string' && typeof data.rows === 'number' && typeof data.amountCents === 'number';

/** What GET /api/admin/properties/[id]/income answers. */
export interface PropertyIncome {
  lines: EarningsLineView[];
  uploads: { id: string; name: string; month: string }[];
  unlinked: UnlinkedTitle[];
  /** Its titles: the active one and the previous ones (dispatch 37C). */
  titles: TitleLinkView[];
  /** With a month: its daily calendar copies and the property's reserved stays in them (I8, I15). */
  calendar: { month: string; days: string[]; stays: { start: string; end: string }[] } | null;
}

/** One property's lines from the files, for its page, the titles in each month's files that no link names, its titles, and, with a month, its calendar's stays. */
export function fetchPropertyIncome(propertyId: string, month?: string): Promise<IncomeResult<PropertyIncome>> {
  const query = month ? `?month=${encodeURIComponent(month)}` : '';
  return call(`/api/admin/properties/${encodeURIComponent(propertyId)}/income${query}`, {}, 'Loading the lines from the files failed', (data) =>
    isRecord(data) &&
    Array.isArray(data.lines) &&
    data.lines.every(isLine) &&
    Array.isArray(data.uploads) &&
    Array.isArray(data.unlinked) &&
    data.unlinked.every(isUnlinkedTitle) &&
    Array.isArray(data.titles) &&
    data.titles.every(isLink) &&
    (data.calendar === null || (isRecord(data.calendar) && Array.isArray(data.calendar.days) && Array.isArray(data.calendar.stays))),
  );
}

/** What a property's edit page shows of its titles (dispatch 37C). */
export interface PropertyTitles {
  titles: { link: TitleLinkView; lastSeen: string | null }[];
  candidates: { platform: IncomeChannel; title: string; months: string[]; setAside: boolean }[];
  /** Every other title with a link, and whose it is: a title typed that is one of these moves only by M13. */
  elsewhere: { platform: IncomeChannel; title: string; state: string | null; propertyName: string | null }[];
}

export function fetchPropertyTitles(propertyId: string): Promise<IncomeResult<PropertyTitles>> {
  return call(`/api/admin/properties/${encodeURIComponent(propertyId)}/airbnb-title`, {}, 'Loading the Airbnb title failed', (data) => isRecord(data) && Array.isArray(data.titles) && Array.isArray(data.candidates) && Array.isArray(data.elsewhere));
}

/** Make `title` the property's active Airbnb title, from its edit page; `expected` is that title's link as the page showed it. */
export function setPropertyTitle(propertyId: string, input: { title: string; expected: string | null }): Promise<IncomeResult<TitleSet>> {
  return call(`/api/admin/properties/${encodeURIComponent(propertyId)}/airbnb-title`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }, 'Saving the Airbnb title failed', isTitleSet, ['LINK_WRITE_FAILED']);
}
