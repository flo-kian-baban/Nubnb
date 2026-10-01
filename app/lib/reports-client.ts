/**
 * Browser-side calls to the statements API (dispatch 23B): the tracker's
 * read, the editor's read, the draft save, the finish, and the download
 * link. The contract of costs-client.ts: every call resolves to a result,
 * never throws, never turns a failure into an empty list, and says whether
 * a write's outcome is unknown. Nothing is retried.
 *
 * Client-safe. Imports only the models.
 */

import { describeErrorBody, readErrorBody } from '@/app/lib/api/http-failure';
import type { CostEntryView } from '@/app/lib/cleaners/model';
import type {
  MonthlyReportSummary,
  MonthlyReportView,
  PropertyManagementView,
  ReportDownloadView,
  StatementDraftSummary,
  StatementDraftView,
} from '@/app/lib/reports/model';
import type { FinishClaim } from '@/app/lib/reports/statement';

export type ReportResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; title: string; detail?: string; code?: string; unknown: boolean };

export interface TrackerData {
  reports: MonthlyReportSummary[];
  drafts: StatementDraftSummary[];
  downloads: ReportDownloadView[];
  management: PropertyManagementView[];
  properties: { id: string; name: string | null }[];
  entries: CostEntryView[];
  unreadable: { reports: number; drafts: number; downloads: number };
}

export interface StatementBundle {
  propertyName: string;
  draft: StatementDraftView | null;
  entries: CostEntryView[];
  reports: MonthlyReportView[];
  management: PropertyManagementView | null;
}

/** The draft as the page saves it: amounts as typed strings, "1234.50". */
export interface DraftPayload {
  propertyId: string;
  month: string;
  revision: number;
  income: { id: string; source: string; label: string; reference: string | null; from: string | null; to: string | null; amount: string }[];
  fee: { label: string; amount: string } | null;
  notes: string | null;
  supersedes: { reportId: string; reason: string } | null;
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

async function call<T>(url: string, init: RequestInit, action: string, isExpected: (data: unknown) => boolean, unconfirmedCodes: readonly string[] = []): Promise<ReportResult<T>> {
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
    return { ok: false, status: failure.status, title: failure.title, detail: detail || undefined, code, unknown: (res.status >= 500 && !isAppFailure(body)) || (code !== undefined && unconfirmedCodes.includes(code)) };
  }
  if (!isExpected(body.data)) {
    return { ok: false, status: res.status, title: `${action}: the server's answer was not in the expected form.`, detail: 'Nothing is shown rather than something that might be wrong.', unknown: true };
  }
  return { ok: true, data: body.data as T };
}

const isDraft = (data: unknown): boolean => isRecord(data) && typeof data.id === 'string' && typeof data.revision === 'number' && Array.isArray(data.income) && typeof data.month === 'string';
const isReport = (data: unknown): boolean => isRecord(data) && typeof data.id === 'string' && typeof data.month === 'string' && typeof data.payableCents === 'number' && isRecord(data.pdf) && typeof data.pdf.sha256 === 'string';

export function fetchTracker(): Promise<ReportResult<TrackerData>> {
  return call('/api/admin/monthly-reports', {}, 'Loading the statements failed', (data) =>
    isRecord(data) && Array.isArray(data.reports) && data.reports.every(isReport) && Array.isArray(data.drafts) && Array.isArray(data.downloads) && Array.isArray(data.management) && Array.isArray(data.properties) && Array.isArray(data.entries),
  );
}

export function fetchStatementBundle(propertyId: string, month: string): Promise<ReportResult<StatementBundle>> {
  return call(`/api/admin/monthly-reports/draft?property=${encodeURIComponent(propertyId)}&month=${encodeURIComponent(month)}`, {}, 'Loading the statement failed', (data) =>
    isRecord(data) && typeof data.propertyName === 'string' && (data.draft === null || isDraft(data.draft)) && Array.isArray(data.entries) && Array.isArray(data.reports) && data.reports.every(isReport) && (data.management === null || isRecord(data.management)),
  );
}

/** Save the draft whole. DRAFT_CHANGED means the page has fallen behind; the page reloads the draft. */
export function saveDraft(payload: DraftPayload): Promise<ReportResult<{ draft: StatementDraftView }>> {
  return call('/api/admin/monthly-reports/draft', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }, 'Saving the draft failed', (data) => isRecord(data) && isDraft(data.draft), ['DRAFT_SAVE_FAILED']);
}

/** Finish the statement. The answer's report is the frozen object the PDF was made from. */
export function finishStatement(claim: FinishClaim & { propertyId: string; month: string; draftRevision: number }): Promise<ReportResult<{ report: MonthlyReportView }>> {
  return call('/api/admin/monthly-reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(claim) }, 'Finishing the statement failed', (data) => isRecord(data) && isReport(data.report), ['STATEMENT_RECORD_FAILED']);
}

/** A fresh 60-second link to a finished statement's PDF; one download record is made. */
export function fetchStatementLink(reportId: string): Promise<ReportResult<{ url: string; expiresAt: string; seconds: number; download: ReportDownloadView }>> {
  return call(`/api/admin/monthly-reports/${encodeURIComponent(reportId)}/pdf`, {}, 'Opening the statement failed', (data) => isRecord(data) && typeof data.url === 'string' && data.url.startsWith('https://') && typeof data.expiresAt === 'string' && isRecord(data.download));
}
