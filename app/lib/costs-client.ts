/**
 * Browser-side calls to the admin cost-entry API, for the costs page.
 *
 * The contract of cleaners-client.ts, whose `call` this copies (that file is
 * left as it is): every call resolves to a result and never throws, a failure
 * is never turned into an empty list, requests are `no-store`, and a failure
 * says whether its outcome is unknown — no answer, a 2xx in the wrong form, a
 * platform 5xx, or ENTRY_REVIEW_FAILED all say nothing about whether a review
 * landed, and the page must not claim either way. Nothing is retried.
 *
 * The receipt link is a bearer link that works for 60 seconds. It is handed
 * to the page to put into an image and is never stored.
 *
 * A PDF is recorded before it is downloaded (recordPdfExport): the page
 * downloads only when the server has answered with the record.
 *
 * Client-safe. From the cleaner library it imports only model.ts.
 */

import { describeErrorBody, readErrorBody } from '@/app/lib/api/http-failure';
import type { CostEntryView, CostsView, LinesNow, ReportExportView, ReviewStatus } from '@/app/lib/cleaners/model';

export type CostResult<T> =
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

/** The answer to a review: the entry as now stored. */
export interface EntryChange {
  entry: CostEntryView;
  /** False when the entry already said this and nothing was written. */
  changed: boolean;
}

/** A link to one receipt image, good for `seconds`. */
export interface ReceiptLinkData {
  url: string;
  expiresAt: string;
  seconds: number;
  /** True when the object carries a permanent download token, minted outside the app. */
  publicToken: boolean;
}

/** A line as the admin typed it, in the form the server reads: "7.98", "-5.00". */
export interface LineInput {
  name: string;
  quantity: string;
  lineTotal: string;
}

const isRecord = (data: unknown): data is Record<string, unknown> =>
  !!data && typeof data === 'object' && !Array.isArray(data);

/** A failure body the application wrote: `{ success: false, error: string }`. */
const isAppFailure = (body: Record<string, unknown>): boolean =>
  body.success === false && typeof body.error === 'string';

const isTextOrNull = (value: unknown): boolean => value === null || typeof value === 'string';

function isLinesNow(data: unknown): data is LinesNow {
  if (!isRecord(data)) return false;
  if (data.kind === 'unreadable') return typeof data.reason === 'string';
  return (
    data.kind === 'ok' &&
    Array.isArray(data.lines) &&
    data.lines.every(
      (line) =>
        isRecord(line) &&
        typeof line.index === 'number' &&
        typeof line.lineTotalCents === 'number' &&
        (line.origin === 'sent' || line.origin === 'added') &&
        Array.isArray(line.earlier),
    ) &&
    typeof data.totalCents === 'number' &&
    typeof data.sentTotalCents === 'number' &&
    typeof data.corrected === 'boolean'
  );
}

/** An entry in the shape the page renders. */
function isCostEntryView(data: unknown): data is CostEntryView {
  return (
    isRecord(data) &&
    typeof data.id === 'string' &&
    isTextOrNull(data.createdAt) &&
    isTextOrNull(data.status) &&
    isTextOrNull(data.statusChangedAt) &&
    isTextOrNull(data.statusReason) &&
    (data.history === null || Array.isArray(data.history)) &&
    isRecord(data.cleaner) &&
    isRecord(data.property) &&
    (data.lines === null || Array.isArray(data.lines)) &&
    isLinesNow(data.linesNow) &&
    (data.receipts === null || Array.isArray(data.receipts)) &&
    typeof data.kind === 'string' &&
    (data.autoApproved === null || isRecord(data.autoApproved))
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
  /** What was attempted, used only when the server gave no reason, e.g. "Loading cost entries failed". */
  action: string,
  isExpected: (data: unknown) => boolean,
  /** Application error codes that mean the write may or may not have landed. */
  unconfirmedCodes: readonly string[] = [],
): Promise<CostResult<T>> {
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

const isTextOrNumberOrNull = (value: unknown): boolean =>
  value === null || typeof value === 'string' || typeof value === 'number';

/** A recorded PDF in the shape the page reads. */
function isReportExportView(data: unknown): data is ReportExportView {
  return (
    isRecord(data) &&
    typeof data.id === 'string' &&
    isTextOrNull(data.createdAt) &&
    isTextOrNull(data.kind) &&
    isTextOrNull(data.propertyId) &&
    isTextOrNull(data.propertyNameAtExport) &&
    isTextOrNull(data.from) &&
    isTextOrNull(data.to) &&
    (data.entries === null ||
      (Array.isArray(data.entries) &&
        data.entries.every(
          (entry) =>
            isRecord(entry) &&
            isTextOrNull(entry.entryId) &&
            isTextOrNumberOrNull(entry.historyLength) &&
            isTextOrNumberOrNull(entry.itemsCents) &&
            isTextOrNumberOrNull(entry.taxCents) &&
            isTextOrNumberOrNull(entry.totalCents),
        ))) &&
    isTextOrNumberOrNull(data.totalCents)
  );
}

/** Everything the costs page works from: the entries, the recorded PDFs and the property names. */
export function fetchCosts(): Promise<CostResult<CostsView>> {
  return call(
    '/api/admin/cost-entries',
    {},
    'Loading cost entries failed',
    (data) =>
      isRecord(data) &&
      Array.isArray(data.entries) &&
      data.entries.every(isCostEntryView) &&
      Array.isArray(data.exports) &&
      data.exports.every(isReportExportView) &&
      (data.properties === null ||
        (Array.isArray(data.properties) &&
          data.properties.every((p) => isRecord(p) && typeof p.id === 'string' && isTextOrNull(p.name)))),
  );
}

/**
 * Record a PDF before downloading it: the property, the period the PDF
 * prints, and each entry in it with the history length the page shows. The
 * server records it only if that is what is stored now; REPORT_CHANGED means
 * the page has fallen behind and nothing may be downloaded.
 */
export function recordPdfExport(request: {
  propertyId: string;
  from: string;
  to: string;
  entries: { id: string; seen: number }[];
}): Promise<CostResult<{ export: ReportExportView }>> {
  return call(
    '/api/admin/cost-reports',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    },
    'Recording the PDF failed',
    (data) =>
      isRecord(data) &&
      isReportExportView(data.export) &&
      data.export.propertyId === request.propertyId &&
      typeof data.export.createdAt === 'string' &&
      Number.isFinite(Date.parse(data.export.createdAt)),
    ['REPORT_RECORD_FAILED'],
  );
}

/**
 * Approve, reject or remove an entry. `seen` is the length of its history as
 * the page shows it; an entry changed since is refused with ENTRY_CHANGED.
 */
export function setEntryStatus(
  id: string,
  request: { status: ReviewStatus; reason: string | null; seen: number },
): Promise<CostResult<EntryChange>> {
  return call(
    `/api/admin/cost-entries/${encodeURIComponent(id)}/status`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    },
    'Saving the review failed',
    (data) =>
      isRecord(data) &&
      isCostEntryView(data.entry) &&
      data.entry.id === id &&
      data.entry.status === request.status &&
      typeof data.changed === 'boolean',
    ['ENTRY_REVIEW_FAILED'],
  );
}

/**
 * Mark an entry approved automatically as seen (dispatch 24). `seen` is the
 * history length the page shows. The answer's entry carries the `seen`
 * event; `changed` is false when an admin had already acted on it.
 */
export function markEntrySeen(id: string, request: { seen: number }): Promise<CostResult<EntryChange>> {
  return call(
    `/api/admin/cost-entries/${encodeURIComponent(id)}/seen`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    },
    'Marking the entry as seen failed',
    (data) =>
      isRecord(data) && isCostEntryView(data.entry) && data.entry.id === id && typeof data.changed === 'boolean',
    ['ENTRY_REVIEW_FAILED'],
  );
}

/** Correct the line at `index`, or add one when `index` is null. */
export function changeEntryLine(
  id: string,
  request: { index: number | null; line: LineInput; seen: number },
): Promise<CostResult<EntryChange>> {
  return call(
    `/api/admin/cost-entries/${encodeURIComponent(id)}/lines`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    },
    'Saving the line failed',
    (data) =>
      isRecord(data) && isCostEntryView(data.entry) && data.entry.id === id && typeof data.changed === 'boolean',
    ['ENTRY_REVIEW_FAILED'],
  );
}

/** Correct the entry's tax (dispatch 21): the amount as printed, "12.71", or null for none. */
export function changeEntryTax(
  id: string,
  request: { tax: string | null; seen: number },
): Promise<CostResult<EntryChange>> {
  return call(
    `/api/admin/cost-entries/${encodeURIComponent(id)}/tax`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    },
    'Saving the tax failed',
    (data) =>
      isRecord(data) && isCostEntryView(data.entry) && data.entry.id === id && typeof data.changed === 'boolean',
    ['ENTRY_REVIEW_FAILED'],
  );
}

/** A fresh 60-second link to an entry's receipt image. */
export function fetchReceiptLink(id: string): Promise<CostResult<ReceiptLinkData>> {
  return call(
    `/api/admin/cost-entries/${encodeURIComponent(id)}/receipt?i=0`,
    {},
    'Opening the receipt failed',
    (data) =>
      isRecord(data) &&
      typeof data.url === 'string' &&
      data.url.startsWith('https://') &&
      typeof data.expiresAt === 'string' &&
      typeof data.seconds === 'number' &&
      typeof data.publicToken === 'boolean',
  );
}
