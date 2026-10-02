/**
 * Browser-side calls to the statements API (dispatch 23B): the tracker's
 * read, the editor's read, the draft save, the finish, the download link,
 * and deleting a finished statement (dispatch 23G). The contract of
 * costs-client.ts: every call resolves to a result,
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

/**
 * A line as the page sends it (dispatch 23E): a description, its dates, a
 * quantity and a rate as typed, "60.00" or "-60.00"; the server computes
 * the amount. The two optional fields are sent back only on a line loaded
 * with them, exactly as loaded.
 */
export interface LinePayload {
  id: string;
  description: string;
  from: string | null;
  to: string | null;
  quantity: number;
  rate: string;
  source?: string;
  reference?: string | null;
}

/** The fee as the page sends it: the rate in percent ("20") or null, the base, the amount or null for the computed one. */
export interface FeePayload {
  label: string;
  rate: string | null;
  base: string;
  amount: string | null;
}

export interface CarriedPayload {
  label: string;
  amount: string;
  fromReportId: string | null;
}

/** The draft as the page saves it, whole (version 3). */
export interface DraftPayload {
  propertyId: string;
  month: string;
  revision: number;
  reference: string;
  reportDate: string;
  lines: LinePayload[];
  fee: FeePayload | null;
  carried: CarriedPayload | null;
  notes: string | null;
  supersedes: { reportId: string; reason: string } | null;
}

/** Everything a property's page shows about its statements (dispatch 23D). */
export interface PropertyStatements {
  propertyName: string;
  reports: MonthlyReportView[];
  drafts: StatementDraftView[];
  downloads: ReportDownloadView[];
  management: PropertyManagementView | null;
  unreadable: { reports: number; drafts: number; downloads: number };
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

const isDraft = (data: unknown): boolean => isRecord(data) && typeof data.id === 'string' && typeof data.revision === 'number' && Array.isArray(data.lines) && typeof data.month === 'string';
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

/** One property's statements, drafts, downloads and management record, for its page. */
export function fetchPropertyStatements(propertyId: string): Promise<ReportResult<PropertyStatements>> {
  return call(`/api/admin/properties/${encodeURIComponent(propertyId)}/statements`, {}, 'Loading the statements failed', (data) =>
    isRecord(data) && typeof data.propertyName === 'string' && Array.isArray(data.reports) && data.reports.every(isReport) && Array.isArray(data.drafts) && data.drafts.every(isDraft) && Array.isArray(data.downloads) && (data.management === null || isRecord(data.management)) && isRecord(data.unreadable),
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

/** Set "Report For" on the property's record from the editor (dispatch 23E); null clears it. */
export function setReportFor(propertyId: string, reportFor: { name: string; address: string } | null): Promise<ReportResult<{ record: PropertyManagementView }>> {
  return call(`/api/admin/properties/${encodeURIComponent(propertyId)}/report-for`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reportFor) }, 'Saving who the report is for failed', (data) => isRecord(data) && isRecord(data.record), ['REPORT_FOR_WRITE_FAILED']);
}

/** What deleting a finished statement answers: the draft reopened with everything it held, and the property's record when its Report For was set back. */
export interface StatementDeleted {
  deleted: { reportId: string; downloads: number; pdf: 'deleted' | 'missing' | 'left' };
  draft: StatementDraftView;
  management: PropertyManagementView | null;
}

/**
 * Delete a finished statement (Kian's ruling of 2026-10-02): its document,
 * its PDF and its download records, the month reopened as a draft. The page
 * sends how many downloads it showed the admin; DOWNLOADED_SINCE means one
 * was made since, and nothing was deleted.
 */
export function deleteStatement(reportId: string, downloadsSeen: number): Promise<ReportResult<StatementDeleted>> {
  return call(`/api/admin/monthly-reports/${encodeURIComponent(reportId)}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ downloadsSeen }) }, 'Deleting the statement failed', (data) => isRecord(data) && isRecord(data.deleted) && isDraft(data.draft), ['STATEMENT_DELETE_FAILED']);
}

/** A fresh 60-second link to a finished statement's PDF; one download record is made. */
export function fetchStatementLink(reportId: string): Promise<ReportResult<{ url: string; expiresAt: string; seconds: number; download: ReportDownloadView }>> {
  return call(`/api/admin/monthly-reports/${encodeURIComponent(reportId)}/pdf`, {}, 'Opening the statement failed', (data) => isRecord(data) && typeof data.url === 'string' && data.url.startsWith('https://') && typeof data.expiresAt === 'string' && isRecord(data.download));
}
