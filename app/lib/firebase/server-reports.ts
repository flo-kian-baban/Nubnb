/**
 * Server-side reads and writes of monthly statements (dispatch 23B): the
 * working draft, the finished report with its PDF in Storage, the download
 * records, and the tracker's one read. All four collections are reached
 * only through the Admin SDK; firestore.rules denies every browser.
 *
 * ── The draft ──
 * `monthly_report_drafts/{propertyId}_{YYYY-MM}` is saved whole, in a
 * transaction that refuses unless the stored `revision` is the one the
 * page loaded (409 DRAFT_CHANGED: a second admin, or a second tab). Once
 * finished it is read-only, until a correction rewrites it with
 * `supersedes` naming the finished report; then it is a draft again.
 *
 * ── Finishing ──
 * The page sends its claim (which entries, each with the history length it
 * saw; which late entries; which adjustments). The server rebuilds the
 * statement from what is stored and refuses unless that is exactly the
 * claim (409 STATEMENT_CHANGED). Then it writes the PDF's bytes to Storage,
 * create-only, with their SHA-256 in the object's metadata, and in one
 * transaction re-reads and re-checks the same claim, `create()`s the
 * report and marks the draft finished. A claim that fails the second check
 * leaves an orphan PDF object, logged by path, as an orphaned receipt is.
 *
 * ── What is never done ──
 * A finished report is never updated or deleted; a draft is never deleted;
 * no entry is written. The stored money figures are what was printed and
 * are never read back into a total.
 */

import { createHash } from 'crypto';
import { z } from 'zod';
import type { Transaction } from 'firebase-admin/firestore';
import { getAdminBucket, getAdminDb } from './admin';
import { isDocumentId } from './server-leads';
import { listCosts, listPropertyEntries, propertyEntriesInTransaction, toCents } from './server-cost-entries';
import { getManagement, listManagement, FeeInputSchema } from './server-management';
import { ADMIN_ACTOR, type CostEntryView, type Refusal } from '@/app/lib/cleaners/model';
import { isDay } from '@/app/lib/costs/report';
import {
  MONTHLY_REPORTS_COLLECTION,
  MONTHLY_REPORTS_PREFIX,
  MONTHLY_REPORT_DRAFTS_COLLECTION,
  MONTHLY_REPORT_DRAFT_SCHEMA_VERSION,
  MONTHLY_REPORT_SCHEMA_VERSION,
  REPORT_DOWNLOADS_COLLECTION,
  REPORT_DOWNLOAD_SCHEMA_VERSION,
  INCOME_SOURCES,
  STATEMENT_LIMITS,
  isMonth,
  readMonthlyReport,
  readReportDownload,
  readStatementDraft,
  reportRef,
  type MonthlyReport,
  type MonthlyReportSummary,
  type MonthlyReportView,
  type PropertyManagementView,
  type ReportDownloadView,
  type StatementDraft,
  type StatementDraftSummary,
  type StatementDraftView,
} from '@/app/lib/reports/model';
import { buildStatement, sameClaim, type FinishClaim, type Statement } from '@/app/lib/reports/statement';
import { statementPdf } from '@/app/lib/reports/statement-pdf';

const CONTROL_CHARACTER = /\p{Cc}/u;
const SIGNED_AMOUNT = /^-?(0|[1-9][0-9]{0,5})\.[0-9]{2}$/;

function grpcCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? String(code) : typeof code === 'string' ? code : 'unknown';
}

const draftId = (propertyId: string, month: string) => `${propertyId}_${month}`;

// ─── Schemas ───────────────────────────────────────────────────

const line = (max: number, what: string) =>
  z
    .string()
    .transform((s) => s.normalize('NFC').replace(/\s+/g, ' ').trim())
    .pipe(z.string().min(1, what).max(max, `At most ${max} characters`).refine((s) => !CONTROL_CHARACTER.test(s), 'No control characters'));

const DaySchema = z.string().refine(isDay, 'Write the date as yyyy-mm-dd');

export const IncomeRowInputSchema = z
  .strictObject({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, 'Not a row ID'),
    source: z.enum(INCOME_SOURCES),
    label: line(STATEMENT_LIMITS.INCOME_LABEL_MAX, 'Describe the income'),
    reference: z
      .string()
      .transform((s) => s.normalize('NFC').replace(/\s+/g, ' ').trim())
      .pipe(z.string().max(STATEMENT_LIMITS.INCOME_REFERENCE_MAX, `At most ${STATEMENT_LIMITS.INCOME_REFERENCE_MAX} characters`).refine((s) => !CONTROL_CHARACTER.test(s), 'No control characters'))
      .nullable()
      .transform((value) => (value ? value : null)),
    from: DaySchema.nullable(),
    to: DaySchema.nullable(),
    /** "1234.50" or "-120.00": not zero. */
    amount: z
      .string()
      .regex(SIGNED_AMOUNT, 'An amount with two decimals, like 1234.50 or -120.00')
      .transform(toCents)
      .pipe(z.number().refine((cents) => cents !== 0, 'An income row is never $0.00')),
  })
  .superRefine((row, ctx) => {
    if (row.from !== null && row.to !== null && row.to < row.from) ctx.addIssue({ code: 'custom', path: ['to'], message: 'The stay ends before it starts' });
  })
  .transform((row) => ({ id: row.id, source: row.source, label: row.label, reference: row.reference, from: row.from, to: row.to, amountCents: row.amount }));

const NotesSchema = z
  .string()
  .transform((s) => s.normalize('NFC').replace(/\r\n/g, '\n').trim())
  .pipe(z.string().max(STATEMENT_LIMITS.NOTES_MAX, `At most ${STATEMENT_LIMITS.NOTES_MAX} characters`).refine((s) => !CONTROL_CHARACTER.test(s.replace(/\n/g, '')), 'No control characters other than line breaks'))
  .nullable()
  .transform((value) => (value ? value : null));

/** The draft as the page saves it, whole. Strict: anything else is refused. */
export const DraftInputSchema = z.strictObject({
  propertyId: z.string().refine((id) => isDocumentId(id), 'Not a property ID'),
  month: z.string().refine(isMonth, 'A month, like 2026-09'),
  /** The revision the page loaded; 0 when there was no draft yet. */
  revision: z.number().int().min(0).max(1_000_000),
  income: z.array(IncomeRowInputSchema).max(STATEMENT_LIMITS.INCOME_ROWS_MAX, `At most ${STATEMENT_LIMITS.INCOME_ROWS_MAX} income rows`),
  fee: FeeInputSchema.nullable(),
  notes: NotesSchema,
  supersedes: z
    .strictObject({
      reportId: z.string().refine((id) => isDocumentId(id), 'Not a report ID'),
      reason: line(STATEMENT_LIMITS.REASON_MAX, 'Say why the statement is corrected'),
    })
    .nullable(),
});
export type DraftInput = z.output<typeof DraftInputSchema>;

const Seen = z.number().int().min(1).max(1_000_000);
/** The finish claim, as the page sends it. */
export const FinishInputSchema = z.strictObject({
  propertyId: z.string().refine((id) => isDocumentId(id), 'Not a property ID'),
  month: z.string().refine(isMonth, 'A month, like 2026-09'),
  draftRevision: z.number().int().min(1).max(1_000_000),
  entries: z.array(z.strictObject({ id: z.string().refine((id) => isDocumentId(id), 'Not an entry ID'), seen: Seen })).max(5_000),
  earlier: z.array(z.strictObject({ id: z.string().refine((id) => isDocumentId(id), 'Not an entry ID'), seen: Seen })).max(5_000),
  adjustments: z
    .array(z.strictObject({ entryId: z.string().refine((id) => isDocumentId(id), 'Not an entry ID'), statementId: z.string().refine((id) => isDocumentId(id), 'Not a report ID'), deltaCents: z.number().int() }))
    .max(5_000),
});
export type FinishInput = z.output<typeof FinishInputSchema>;

// ─── Reads ─────────────────────────────────────────────────────

/** A property's finished reports, every one in shape; one not in shape is logged and left out. */
async function propertyReports(propertyId: string, tx?: Transaction): Promise<MonthlyReportView[]> {
  const query = getAdminDb().collection(MONTHLY_REPORTS_COLLECTION).where('propertyId', '==', propertyId);
  const snapshot = tx ? await tx.get(query) : await query.get();
  const reports: MonthlyReportView[] = [];
  for (const doc of snapshot.docs) {
    const report = readMonthlyReport(doc.id, doc.data());
    if (report) reports.push(report);
    else console.error(`[reports] monthly_reports/${doc.id} is not in the written shape; left out`);
  }
  return reports.sort((a, b) => b.finishedAt.localeCompare(a.finishedAt) || a.id.localeCompare(b.id));
}

async function propertyName(propertyId: string): Promise<string | null> {
  const db = getAdminDb();
  const [doc] = await db.getAll(db.collection('properties').doc(propertyId), { fieldMask: ['name'] });
  if (!doc.exists) return null;
  const name: unknown = doc.get('name');
  return typeof name === 'string' && name.trim() !== '' ? name : 'Unnamed property';
}

/** Everything the editor works from. */
export interface StatementBundle {
  propertyName: string;
  draft: StatementDraftView | null;
  entries: CostEntryView[];
  reports: MonthlyReportView[];
  management: PropertyManagementView | null;
}

/** The editor's read. null when no property has the ID. @throws if a read fails. */
export async function readStatementBundle(propertyId: string, month: string): Promise<StatementBundle | null> {
  if (!isDocumentId(propertyId) || !isMonth(month)) return null;
  const name = await propertyName(propertyId);
  if (name === null) return null;
  const db = getAdminDb();
  const [draftDoc, entries, reports, management] = await Promise.all([
    db.collection(MONTHLY_REPORT_DRAFTS_COLLECTION).doc(draftId(propertyId, month)).get(),
    listPropertyEntries(propertyId),
    propertyReports(propertyId),
    getManagement(propertyId),
  ]);
  const draft = draftDoc.exists ? readStatementDraft(draftDoc.id, draftDoc.data() ?? {}) : null;
  if (draftDoc.exists && draft === null) console.error(`[reports] monthly_report_drafts/${draftDoc.id} is not in the written shape; read as none`);
  return { propertyName: name, draft, entries, reports, management };
}

// ─── The draft ─────────────────────────────────────────────────

export type SaveDraftResult =
  | { kind: 'saved'; draft: StatementDraftView }
  | { kind: 'changed-since'; revision: number }
  /** The month is finished; a save must name the finished report in `supersedes` to correct it. */
  | { kind: 'finished'; finishedAs: string }
  | { kind: 'no-such-property' }
  | { kind: 'no-such-report' }
  | { kind: 'failed' };

export const DRAFT_REFUSALS: Record<Exclude<SaveDraftResult['kind'], 'saved'>, Refusal> = {
  'changed-since': { status: 409, code: 'DRAFT_CHANGED', message: 'This draft changed since it was loaded.', hint: 'Nothing was saved. The page reloads the draft as it is stored.' },
  finished: { status: 409, code: 'DRAFT_FINISHED', message: 'This statement is finished and cannot be edited.', hint: 'Use "Correct this statement" to replace it with a corrected one.' },
  'no-such-property': { status: 404, code: 'PROPERTY_NOT_FOUND', message: 'Property not found' },
  'no-such-report': { status: 422, code: 'REPORT_NOT_FOUND', message: 'The statement to correct is not this month\'s finished statement.', hint: 'Nothing was saved. Reload the page.' },
  failed: { status: 502, code: 'DRAFT_SAVE_FAILED', message: 'Could not save the draft.', hint: 'It may or may not have been saved. Reload to see what is stored.' },
};

/**
 * Save the draft whole, in a transaction that refuses unless the stored
 * revision is the one the page loaded. A finished month takes a save only
 * as a correction: `supersedes` must name the report it was finished as,
 * and the draft becomes a draft again.
 */
export async function saveDraft(input: DraftInput): Promise<SaveDraftResult> {
  const { propertyId, month } = input;
  if ((await propertyName(propertyId)) === null) return { kind: 'no-such-property' };
  const db = getAdminDb();
  const ref = db.collection(MONTHLY_REPORT_DRAFTS_COLLECTION).doc(draftId(propertyId, month));
  try {
    return await db.runTransaction(async (tx): Promise<SaveDraftResult> => {
      const snap = await tx.get(ref);
      const now = new Date().toISOString();
      const stored = snap.exists ? readStatementDraft(snap.id, snap.data() ?? {}) : null;
      if (snap.exists && stored === null) return { kind: 'failed' };
      const revision = stored?.revision ?? 0;
      if (revision !== input.revision) return { kind: 'changed-since', revision };
      if (stored?.finishedAs !== null && stored?.finishedAs !== undefined) {
        // Only a correction of the finished statement reopens the draft.
        if (input.supersedes === null) return { kind: 'finished', finishedAs: stored.finishedAs };
        if (input.supersedes.reportId !== stored.finishedAs) return { kind: 'no-such-report' };
      }
      if (input.supersedes !== null) {
        const report = await tx.get(db.collection(MONTHLY_REPORTS_COLLECTION).doc(input.supersedes.reportId));
        const read = report.exists ? readMonthlyReport(report.id, report.data() ?? {}) : null;
        if (!read || read.propertyId !== propertyId || read.month !== month) return { kind: 'no-such-report' };
      }
      const next: StatementDraft = {
        schemaVersion: MONTHLY_REPORT_DRAFT_SCHEMA_VERSION,
        propertyId,
        month,
        income: input.income,
        fee: input.fee,
        notes: input.notes,
        supersedes: input.supersedes,
        revision: revision + 1,
        createdAt: stored?.createdAt ?? now,
        updatedAt: now,
        finishedAs: null,
        finishedRevision: null,
      };
      if (stored) tx.update(ref, { ...next });
      else tx.create(ref, next);
      return { kind: 'saved', draft: { id: ref.id, ...next } };
    });
  } catch (err) {
    console.error(`[reports] draft save for ${ref.id} failed: grpc code ${grpcCode(err)}`);
    return { kind: 'failed' };
  }
}

// ─── Finishing ─────────────────────────────────────────────────

export type FinishResult =
  | { kind: 'finished'; report: MonthlyReportView }
  | { kind: 'no-such-property' }
  /** No draft at that revision, or the draft is already finished. */
  | { kind: 'draft-changed' }
  /** What is stored is not what the page built the statement from. */
  | { kind: 'changed-since' }
  | { kind: 'unreadable'; entryIds: string[] }
  /** The PDF object could not be stored. Nothing was written. */
  | { kind: 'pdf-failed' }
  /** The transaction failed after the PDF was stored: it may or may not have landed. */
  | { kind: 'failed' };

export const FINISH_REFUSALS: Record<Exclude<FinishResult['kind'], 'finished'>, Refusal> = {
  'no-such-property': { status: 404, code: 'PROPERTY_NOT_FOUND', message: 'Property not found' },
  'draft-changed': { status: 409, code: 'DRAFT_CHANGED', message: 'The draft changed since it was loaded, or is already finished.', hint: 'Nothing was written. Reload the page.' },
  'changed-since': { status: 409, code: 'STATEMENT_CHANGED', message: 'An entry in this statement changed since the page loaded.', hint: 'Nothing was written. Reload, check what changed, and finish again.' },
  unreadable: { status: 409, code: 'STATEMENT_ENTRY_UNREADABLE', message: 'An approved entry in this statement cannot be added up.', hint: 'Nothing was written. Open the entry in the ledger to see why.' },
  'pdf-failed': { status: 502, code: 'STATEMENT_PDF_FAILED', message: 'The statement\'s PDF could not be stored.', hint: 'Nothing was written. Try again.' },
  failed: { status: 502, code: 'STATEMENT_RECORD_FAILED', message: 'Could not record the statement.', hint: 'It may or may not have been finished. Reload to see what is on record.' },
};

/** The frozen report, built from the bundle and the draft, with its PDF's bytes. */
function freeze(bundle: StatementBundle, draft: StatementDraftView, propertyId: string, month: string, id: string, finishedAt: string): { report: MonthlyReport; bytes: Uint8Array; statement: Statement; claim: FinishClaim } | { kind: 'unreadable'; entryIds: string[] } {
  const built = buildStatement({ propertyId, propertyName: bundle.propertyName, month, entries: bundle.entries, reports: bundle.reports, draft, management: bundle.management });
  if (built.kind === 'unreadable') return built;
  const statement: Statement = { ...built.statement, ref: reportRef(id), finishedAt };
  const bytes = statementPdf(statement);
  const report: MonthlyReport = {
    schemaVersion: MONTHLY_REPORT_SCHEMA_VERSION,
    propertyId,
    propertyNameAtFinish: bundle.propertyName,
    month,
    ownersAtFinish: (bundle.management?.owners ?? []).map((owner) => ({ name: owner.name })),
    income: statement.income,
    incomeCents: statement.incomeCents,
    costs: statement.costs,
    adjustments: statement.adjustments,
    costsCents: statement.costsCents,
    fee: statement.fee,
    feeCents: statement.feeCents,
    payableCents: statement.payableCents,
    pendingLeftOut: statement.pendingLeftOut,
    notes: statement.notes,
    entryIds: statement.costs.map((row) => row.entryId),
    finishedAt,
    actor: ADMIN_ACTOR,
    supersedes: draft.supersedes,
    draftRevision: draft.revision,
    pdf: { path: `${MONTHLY_REPORTS_PREFIX}/${id}.pdf`, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
  };
  return { report, bytes, statement, claim: built.claim };
}

/**
 * Finish a statement: rebuild it from what is stored, refuse unless that is
 * the page's claim, store the PDF, then record it in one transaction that
 * re-checks the claim.
 */
export async function finishStatement(input: FinishInput): Promise<FinishResult> {
  const { propertyId, month } = input;
  const claim: FinishClaim = { entries: input.entries, earlier: input.earlier, adjustments: input.adjustments };
  const bundle = await readStatementBundle(propertyId, month);
  if (bundle === null) return { kind: 'no-such-property' };
  const { draft } = bundle;
  if (draft === null || draft.revision !== input.draftRevision || draft.finishedAs !== null) return { kind: 'draft-changed' };

  const db = getAdminDb();
  const reportRefDoc = db.collection(MONTHLY_REPORTS_COLLECTION).doc();
  const finishedAt = new Date().toISOString();
  const frozen = freeze(bundle, draft, propertyId, month, reportRefDoc.id, finishedAt);
  if ('kind' in frozen) return frozen;
  if (!sameClaim(frozen.claim, claim)) return { kind: 'changed-since' };

  // ── The PDF, create-only, before the record ──
  try {
    await getAdminBucket()
      .file(frozen.report.pdf.path)
      .save(Buffer.from(frozen.bytes), {
        resumable: false,
        contentType: 'application/pdf',
        preconditionOpts: { ifGenerationMatch: 0 },
        metadata: {
          contentType: 'application/pdf',
          contentDisposition: 'inline',
          cacheControl: 'private, max-age=0, no-store',
          metadata: { reportId: reportRefDoc.id, propertyId, month, sha256: frozen.report.pdf.sha256, finishedAt },
        },
      });
  } catch (err) {
    console.error(`[reports] statement PDF not stored (report ${reportRefDoc.id} not written): code ${grpcCode(err)}`);
    return { kind: 'pdf-failed' };
  }

  // ── The record, re-checking the claim inside the transaction ──
  try {
    const draftRef = db.collection(MONTHLY_REPORT_DRAFTS_COLLECTION).doc(draftId(propertyId, month));
    const outcome = await db.runTransaction(async (tx): Promise<FinishResult> => {
      const [draftSnap, entries, reports] = await Promise.all([tx.get(draftRef), propertyEntriesInTransaction(tx, propertyId), propertyReports(propertyId, tx)]);
      const draftNow = draftSnap.exists ? readStatementDraft(draftSnap.id, draftSnap.data() ?? {}) : null;
      if (!draftNow || draftNow.revision !== input.draftRevision || draftNow.finishedAs !== null) return { kind: 'draft-changed' };
      const again = buildStatement({ propertyId, propertyName: bundle.propertyName, month, entries, reports, draft: draftNow, management: bundle.management });
      if (again.kind === 'unreadable') return again;
      if (!sameClaim(again.claim, claim)) return { kind: 'changed-since' };
      tx.create(reportRefDoc, frozen.report);
      tx.update(draftRef, { finishedAs: reportRefDoc.id, finishedRevision: draftNow.revision, updatedAt: finishedAt });
      return { kind: 'finished', report: { id: reportRefDoc.id, ...frozen.report } };
    });
    if (outcome.kind !== 'finished') console.error(`[reports] orphaned statement PDF ${frozen.report.pdf.path} (report ${reportRefDoc.id} not written: ${outcome.kind})`);
    return outcome;
  } catch (err) {
    console.error(`[reports] orphaned statement PDF ${frozen.report.pdf.path}? recording report ${reportRefDoc.id} failed: grpc code ${grpcCode(err)}`);
    return { kind: 'failed' };
  }
}

// ─── Downloads ─────────────────────────────────────────────────

export type DownloadLinkResult =
  | { kind: 'ok'; url: string; expiresAt: string; seconds: number; download: ReportDownloadView }
  | { kind: 'no-such-report' }
  | { kind: 'object-missing' };

/**
 * A 60-second signed link to a finished statement's PDF, and one download
 * record, create-only. The path comes from the report, never from the
 * request. Google serves the bytes.
 *
 * @throws if a read, the signing or the record fails.
 */
export async function downloadLink(reportId: string): Promise<DownloadLinkResult> {
  if (!isDocumentId(reportId)) return { kind: 'no-such-report' };
  const db = getAdminDb();
  const doc = await db.collection(MONTHLY_REPORTS_COLLECTION).doc(reportId).get();
  const report = doc.exists ? readMonthlyReport(doc.id, doc.data() ?? {}) : null;
  if (!report || !report.pdf.path.startsWith(`${MONTHLY_REPORTS_PREFIX}/`) || report.pdf.path.includes('..')) return { kind: 'no-such-report' };
  const file = getAdminBucket().file(report.pdf.path);
  const [exists] = await file.exists();
  if (!exists) return { kind: 'object-missing' };
  const expires = Date.now() + STATEMENT_LIMITS.DOWNLOAD_LINK_SECONDS * 1000;
  const [url] = await file.getSignedUrl({ version: 'v4', action: 'read', expires, responseDisposition: `attachment; filename="nubnb-statement-${report.month}-${reportRef(report.id)}.pdf"` });
  const ref = db.collection(REPORT_DOWNLOADS_COLLECTION).doc();
  const record = { schemaVersion: REPORT_DOWNLOAD_SCHEMA_VERSION, reportId, propertyId: report.propertyId, month: report.month, at: new Date().toISOString(), actor: ADMIN_ACTOR };
  await ref.create(record);
  return { kind: 'ok', url, expiresAt: new Date(expires).toISOString(), seconds: STATEMENT_LIMITS.DOWNLOAD_LINK_SECONDS, download: { id: ref.id, ...record } };
}

// ─── The tracker ───────────────────────────────────────────────

export interface TrackerData {
  reports: MonthlyReportSummary[];
  drafts: StatementDraftSummary[];
  downloads: ReportDownloadView[];
  management: PropertyManagementView[];
  properties: { id: string; name: string | null }[];
  entries: CostEntryView[];
  /** Documents left out because they are not in the written shape. */
  unreadable: { reports: number; drafts: number; downloads: number };
}

export function summarise(report: MonthlyReportView): MonthlyReportSummary {
  const { income, costs, adjustments, notes, ...rest } = report;
  void notes;
  return { ...rest, incomeRows: income.length, costRows: costs.length, adjustmentRows: adjustments.length };
}

/**
 * Everything the tracker and the two tiles work from, in one answer. Read
 * whole: no orderBy, no limit, nothing can silently drop out.
 *
 * @throws if any read fails: a failed read is never an empty tracker.
 */
export async function readTracker(): Promise<TrackerData> {
  const db = getAdminDb();
  const [reportsSnap, draftsSnap, downloadsSnap, management, costs] = await Promise.all([
    db.collection(MONTHLY_REPORTS_COLLECTION).get(),
    db.collection(MONTHLY_REPORT_DRAFTS_COLLECTION).get(),
    db.collection(REPORT_DOWNLOADS_COLLECTION).get(),
    listManagement(),
    listCosts(),
  ]);
  const unreadable = { reports: 0, drafts: 0, downloads: 0 };
  const reports: MonthlyReportSummary[] = [];
  for (const doc of reportsSnap.docs) {
    const report = readMonthlyReport(doc.id, doc.data());
    if (report) reports.push(summarise(report));
    else unreadable.reports += 1;
  }
  const drafts: StatementDraftSummary[] = [];
  for (const doc of draftsSnap.docs) {
    const draft = readStatementDraft(doc.id, doc.data());
    if (draft) drafts.push({ id: draft.id, propertyId: draft.propertyId, month: draft.month, revision: draft.revision, updatedAt: draft.updatedAt, finishedAs: draft.finishedAs, superseding: draft.supersedes !== null });
    else unreadable.drafts += 1;
  }
  const downloads: ReportDownloadView[] = [];
  for (const doc of downloadsSnap.docs) {
    const download = readReportDownload(doc.id, doc.data());
    if (download) downloads.push(download);
    else unreadable.downloads += 1;
  }
  if (costs.properties === null) throw new Error('The property names could not be read');
  return { reports, drafts, downloads, management, properties: costs.properties, entries: costs.entries, unreadable };
}
