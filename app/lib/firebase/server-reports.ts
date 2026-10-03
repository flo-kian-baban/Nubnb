/**
 * Server-side reads and writes of monthly statements (dispatch 23B; the
 * Payment Summary of dispatch 23E): the working draft, the finished report
 * with its PDF in Storage, the download records, and the tracker's one
 * read. All four collections are reached only through the Admin SDK;
 * firestore.rules denies every browser.
 *
 * ── What the server computes ──
 * A line's amount is its quantity times its rate, computed here from the
 * two the page sends (Kian's ruling of 2026-10-01); the fee's computed
 * amount is its base times its rate, and whether the admin overwrote it is
 * whether the amount sent differs; nothing else is multiplied. The draft
 * is written in schema version 3; one of version 1 or 2 is read as lines.
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
 * ── Deleting a finished statement: the one exception ──
 * `deleteFinishedStatement`, below, is the only code that deletes a finished
 * report, a statement's PDF or a download record (Kian's ruling of
 * 2026-10-02, dispatch 23G, against the earlier rule that a finished
 * statement is never changed). The one other delete in the statements and
 * costs records is a cost entry's (deleteCostEntry in
 * server-cost-entries.ts, dispatch 23H), refused while a finished statement
 * prints the entry. It removes the month's current statement, its stored PDF and
 * every download record of it, and reopens the month's draft holding
 * everything the statement held. Once deleted, there is no record of what
 * an owner received. Correcting by superseding is unchanged and keeps both.
 *
 * ── What is never done ──
 * A finished report is never updated, and deleted only as above; a draft is
 * never deleted; no entry is written. The stored money figures are what was
 * printed and are never read back into a total.
 */

import { createHash } from 'crypto';
import { z } from 'zod';
import type { Transaction } from 'firebase-admin/firestore';
import { getAdminBucket, getAdminDb } from './admin';
import { createdMonthOf } from './created-month';
import { isDocumentId } from './server-leads';
import { listCosts, listPropertyEntries, propertyEntriesInTransaction, toCents } from './server-cost-entries';
import { getManagement, listManagement, toBasisPoints } from './server-management';
import { ADMIN_ACTOR, type CostEntryView, type Refusal } from '@/app/lib/cleaners/model';
import { torontoDayOf } from '@/app/lib/costs/report';
import {
  MONTHLY_REPORTS_COLLECTION,
  MONTHLY_REPORTS_PREFIX,
  MONTHLY_REPORT_DRAFTS_COLLECTION,
  MONTHLY_REPORT_DRAFT_SCHEMA_VERSION,
  MONTHLY_REPORT_SCHEMA_VERSION,
  PROPERTY_MANAGEMENT_COLLECTION,
  PROPERTY_MANAGEMENT_SCHEMA_VERSION,
  REPORT_DOWNLOADS_COLLECTION,
  REPORT_DOWNLOAD_SCHEMA_VERSION,
  INCOME_SOURCES,
  STATEMENTS_FROM_DEFAULT,
  STATEMENT_LIMITS,
  feeComputed,
  isDayText,
  isMonth,
  lineAmount,
  lineFromIncomeRow,
  readMonthlyReport,
  readPropertyManagement,
  readReportDownload,
  readStatementDraft,
  reportRef,
  type Carried,
  type Fee,
  type Line,
  type MonthlyReport,
  type MonthlyReportSummary,
  type MonthlyReportView,
  type PropertyManagement,
  type PropertyManagementView,
  type ReportDownloadView,
  type StatementDraft,
  type StatementDraftSummary,
  type StatementDraftView,
} from '@/app/lib/reports/model';
import { buildStatement, printedBy, sameClaim, type FinishClaim, type Statement } from '@/app/lib/reports/statement';
import { statementPdf } from '@/app/lib/reports/statement-pdf';

const CONTROL_CHARACTER = /\p{Cc}/u;
const SIGNED_AMOUNT = /^-?(0|[1-9][0-9]{0,5})\.[0-9]{2}$/;
const AMOUNT = /^(0|[1-9][0-9]{0,5})\.[0-9]{2}$/;
/** A rate as typed, "20" or "12.5", at most two decimals, 0–100. */
const RATE = /^(100(\.0{1,2})?|[0-9]{1,2}(\.[0-9]{1,2})?)$/;

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

const DaySchema = z.string().refine(isDayText, 'Write the date as yyyy-mm-dd');

/**
 * A line as the page sends it (dispatch 23E): a description, its dates, a
 * quantity and a rate; the amount is computed here, never taken from the
 * page. The two fields a row written before dispatch 23D carried —
 * `source`, `reference` — are taken when sent, so a line loaded with them is
 * saved back as it was loaded, and are never added to a line that does not
 * carry them.
 */
export const LineInputSchema = z
  .strictObject({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, 'Not a line ID'),
    description: line(STATEMENT_LIMITS.LINE_DESCRIPTION_MAX, 'Describe the line'),
    from: DaySchema.nullable(),
    to: DaySchema.nullable(),
    quantity: z.number().int().min(1, 'At least 1').max(STATEMENT_LIMITS.QUANTITY_MAX, `At most ${STATEMENT_LIMITS.QUANTITY_MAX}`),
    /** "60.00" or "-60.00": not zero. */
    rate: z
      .string()
      .regex(SIGNED_AMOUNT, 'A rate with two decimals, like 60.00 or -60.00')
      .transform(toCents)
      .pipe(z.number().refine((cents) => cents !== 0, 'A rate is never $0.00')),
    source: z.enum(INCOME_SOURCES).optional(),
    reference: z
      .string()
      .transform((s) => s.normalize('NFC').replace(/\s+/g, ' ').trim())
      .pipe(z.string().max(STATEMENT_LIMITS.INCOME_REFERENCE_MAX, `At most ${STATEMENT_LIMITS.INCOME_REFERENCE_MAX} characters`).refine((s) => !CONTROL_CHARACTER.test(s), 'No control characters'))
      .nullable()
      .transform((value) => (value ? value : null))
      .optional(),
  })
  .superRefine((row, ctx) => {
    if (row.from && row.to && row.to < row.from) ctx.addIssue({ code: 'custom', path: ['to'], message: 'The range ends before it starts' });
    if (Math.abs(lineAmount(row.quantity, row.rate)) > STATEMENT_LIMITS.LINE_AMOUNT_MAX_CENTS) ctx.addIssue({ code: 'custom', path: ['rate'], message: 'The amount is too large' });
  })
  .transform((row): Line => {
    const out: Line = { id: row.id, description: row.description, from: row.from, to: row.to, quantity: row.quantity, rateCents: row.rate, amountCents: lineAmount(row.quantity, row.rate) };
    if (row.source !== undefined) out.source = row.source;
    if (row.reference !== undefined) out.reference = row.reference;
    return out;
  });

/**
 * The fee as the page sends it: a label, a rate in percent or null, the
 * base, and the amount or null to take the computed one. The computed
 * amount and whether it was overwritten are worked out here.
 */
export const StatementFeeInputSchema = z
  .strictObject({
    label: line(STATEMENT_LIMITS.FEE_LABEL_MAX, 'Label the fee'),
    rate: z.string().regex(RATE, 'A rate in percent, like 20 or 12.5').transform(toBasisPoints).nullable(),
    base: z.string().regex(AMOUNT, 'A base with two decimals, like 9539.78').transform(toCents),
    amount: z.string().regex(AMOUNT, 'An amount with two decimals, like 1907.96').transform(toCents).nullable(),
  })
  .superRefine((fee, ctx) => {
    if (fee.rate === null && fee.amount === null) ctx.addIssue({ code: 'custom', path: ['amount'], message: 'A fee needs a rate or an amount' });
  })
  .transform((fee): Fee => {
    const computedCents = feeComputed(fee.base, fee.rate);
    const amountCents = fee.amount ?? computedCents ?? 0;
    return { label: fee.label, rateBasisPoints: fee.rate, baseCents: fee.base, computedCents, amountCents, overwritten: amountCents !== computedCents };
  });

/** The carried balance as the page sends it: a label, a signed amount, and the statement the suggestion came from or null. */
export const CarriedInputSchema = z
  .strictObject({
    label: line(STATEMENT_LIMITS.CARRIED_LABEL_MAX, 'Label the balance'),
    amount: z.string().regex(SIGNED_AMOUNT, 'An amount with two decimals, like 359.96').transform(toCents),
    fromReportId: z.string().refine((id) => isDocumentId(id), 'Not a report ID').nullable(),
  })
  .transform((value): Carried => ({ label: value.label, amountCents: value.amount, fromReportId: value.fromReportId }));

const NotesSchema = z
  .string()
  .transform((s) => s.normalize('NFC').replace(/\r\n/g, '\n').trim())
  .pipe(z.string().max(STATEMENT_LIMITS.NOTES_MAX, `At most ${STATEMENT_LIMITS.NOTES_MAX} characters`).refine((s) => !CONTROL_CHARACTER.test(s.replace(/\n/g, '')), 'No control characters other than line breaks'))
  .nullable()
  .transform((value) => (value ? value : null));

const ReferenceSchema = z
  .string()
  .transform((s) => s.normalize('NFC').replace(/\s+/g, ' ').trim())
  .pipe(z.string().max(STATEMENT_LIMITS.REFERENCE_MAX, `At most ${STATEMENT_LIMITS.REFERENCE_MAX} characters`).refine((s) => !CONTROL_CHARACTER.test(s), 'No control characters'));

/** The draft as the page saves it, whole (version 3). Strict: anything else is refused. */
export const DraftInputSchema = z.strictObject({
  propertyId: z.string().refine((id) => isDocumentId(id), 'Not a property ID'),
  month: z.string().refine(isMonth, 'A month, like 2026-09'),
  /** The revision the page loaded; 0 when there was no draft yet. */
  revision: z.number().int().min(0).max(1_000_000),
  reference: ReferenceSchema,
  reportDate: DaySchema,
  lines: z.array(LineInputSchema).max(STATEMENT_LIMITS.LINES_MAX, `At most ${STATEMENT_LIMITS.LINES_MAX} lines`),
  fee: StatementFeeInputSchema.nullable(),
  carried: CarriedInputSchema.nullable(),
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

/** A property's name, and the Toronto month its document was created (Firestore's own create time); null when it does not exist. */
async function propertyFacts(propertyId: string): Promise<{ name: string; createdMonth: string | null } | null> {
  const db = getAdminDb();
  const [doc] = await db.getAll(db.collection('properties').doc(propertyId), { fieldMask: ['name'] });
  if (!doc.exists) return null;
  const name: unknown = doc.get('name');
  return { name: typeof name === 'string' && name.trim() !== '' ? name : 'Unnamed property', createdMonth: createdMonthOf(doc.createTime) };
}

async function propertyName(propertyId: string): Promise<string | null> {
  return (await propertyFacts(propertyId))?.name ?? null;
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

/** Everything a property's page shows about its statements (dispatch 23D). */
export interface PropertyStatements {
  propertyName: string;
  /** The Toronto month the property's document was created: no month before it is owed (Kian's ruling of 2026-10-03). */
  createdMonth: string | null;
  /** Every finished report of the property, whole, newest first. */
  reports: MonthlyReportView[];
  /** Every draft of the property, whole. */
  drafts: StatementDraftView[];
  downloads: ReportDownloadView[];
  management: PropertyManagementView | null;
  /** Documents of the property left out because they are not in the written shape. */
  unreadable: { reports: number; drafts: number; downloads: number };
}

/**
 * One property's statements, for its page: its reports, its drafts (each
 * with the revision an income row is saved against), its download records
 * and its management record. null when no property has the ID.
 *
 * @throws if a read fails: a failed read is never an empty list.
 */
export async function readPropertyStatements(propertyId: string): Promise<PropertyStatements | null> {
  if (!isDocumentId(propertyId)) return null;
  const facts = await propertyFacts(propertyId);
  if (facts === null) return null;
  const name = facts.name;
  const db = getAdminDb();
  const [reportsSnap, draftsSnap, downloadsSnap, management] = await Promise.all([
    db.collection(MONTHLY_REPORTS_COLLECTION).where('propertyId', '==', propertyId).get(),
    db.collection(MONTHLY_REPORT_DRAFTS_COLLECTION).where('propertyId', '==', propertyId).get(),
    db.collection(REPORT_DOWNLOADS_COLLECTION).where('propertyId', '==', propertyId).get(),
    getManagement(propertyId),
  ]);
  const unreadable = { reports: 0, drafts: 0, downloads: 0 };
  const reports: MonthlyReportView[] = [];
  for (const doc of reportsSnap.docs) {
    const report = readMonthlyReport(doc.id, doc.data());
    if (report) reports.push(report);
    else unreadable.reports += 1;
  }
  const drafts: StatementDraftView[] = [];
  for (const doc of draftsSnap.docs) {
    const draft = readStatementDraft(doc.id, doc.data());
    if (draft) drafts.push(draft);
    else unreadable.drafts += 1;
  }
  const downloads: ReportDownloadView[] = [];
  for (const doc of downloadsSnap.docs) {
    const download = readReportDownload(doc.id, doc.data());
    if (download) downloads.push(download);
    else unreadable.downloads += 1;
  }
  reports.sort((a, b) => b.finishedAt.localeCompare(a.finishedAt) || a.id.localeCompare(b.id));
  return { propertyName: name, createdMonth: facts.createdMonth, reports, drafts, downloads, management, unreadable };
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
        reference: input.reference,
        reportDate: input.reportDate,
        lines: input.lines,
        fee: input.fee,
        carried: input.carried,
        notes: input.notes,
        supersedes: input.supersedes,
        revision: revision + 1,
        createdAt: stored?.createdAt ?? now,
        updatedAt: now,
        finishedAs: null,
        finishedRevision: null,
      };
      if (stored) tx.set(ref, next);
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
  /** The draft has no reference or no date yet. Nothing written. */
  | { kind: 'incomplete'; missing: string[] }
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
  incomplete: { status: 422, code: 'STATEMENT_INCOMPLETE', message: 'The statement needs a reference and a date before it is finished.', hint: 'Nothing was written. Fill them in and finish again.' },
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
  const statement: Statement = { ...built.statement, draft: false };
  const bytes = statementPdf(statement);
  const report: MonthlyReport = {
    schemaVersion: MONTHLY_REPORT_SCHEMA_VERSION,
    propertyId,
    propertyNameAtFinish: bundle.propertyName,
    month,
    reference: statement.reference,
    reportDate: statement.reportDate,
    reportFor: statement.reportFor,
    lines: statement.lines,
    costs: statement.costs,
    adjustments: statement.adjustments,
    fee: statement.fee,
    carried: statement.carried,
    incomeCents: statement.incomeCents,
    expensesCents: statement.expensesCents,
    recordedCents: statement.recordedCents,
    costsCents: statement.costsCents,
    feeCents: statement.feeCents,
    totalCents: statement.totalCents,
    carriedCents: statement.carriedCents,
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
  const missing = [...(draft.reference.trim() === '' ? ['reference'] : []), ...(isDayText(draft.reportDate) ? [] : ['reportDate'])];
  if (missing.length > 0) return { kind: 'incomplete', missing };

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
      return { kind: 'finished', report: { id: reportRefDoc.id, legacy: false, income: [], ownersAtFinish: [], ...frozen.report } };
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

// ─── Deleting a finished statement ─────────────────────────────

export const DeleteStatementInputSchema = z.strictObject({
  /** How many download records the page showed the admin when they confirmed. */
  downloadsSeen: z.number().int().min(0).max(1_000_000),
});

export type DeleteStatementResult =
  | {
      kind: 'deleted';
      reportId: string;
      /** How many download records went with it. */
      downloads: number;
      /** The stored PDF: deleted, already gone, or left in Storage after a failure (logged by path). */
      pdf: 'deleted' | 'missing' | 'left';
      /** The month's draft, reopened holding everything the statement held. */
      draft: StatementDraftView;
      /** The property's record when its Report For was set back to what the statement printed; null when it was left as it was. */
      management: PropertyManagementView | null;
    }
  | { kind: 'no-such-report' }
  /** Another statement replaces it: only a month's current statement is deleted. */
  | { kind: 'replaced'; by: string }
  /** A correction of it is in progress: the draft names it. */
  | { kind: 'correction-in-progress' }
  /** The month's draft is not the one this statement was finished from. */
  | { kind: 'draft-changed' }
  /** A download link was made since the page showed the count the admin confirmed. */
  | { kind: 'downloaded-since'; downloads: number }
  /** The transaction failed: it may or may not have been deleted. */
  | { kind: 'failed' };

export const DELETE_REFUSALS: Record<Exclude<DeleteStatementResult['kind'], 'deleted'>, Refusal> = {
  'no-such-report': { status: 404, code: 'REPORT_NOT_FOUND', message: 'Statement not found', hint: 'It may already have been deleted. Reload the page.' },
  replaced: { status: 409, code: 'REPORT_REPLACED', message: 'This statement was replaced by a newer one.', hint: 'Only the month\'s current statement can be deleted. Nothing was deleted.' },
  'correction-in-progress': { status: 409, code: 'CORRECTION_IN_PROGRESS', message: 'A correction of this statement is in progress.', hint: 'Nothing was deleted. The month\'s page shows the correction; finishing it replaces this statement.' },
  'draft-changed': { status: 409, code: 'DRAFT_CHANGED', message: 'The month\'s draft changed since the page loaded.', hint: 'Nothing was deleted. Reload the page.' },
  'downloaded-since': { status: 409, code: 'DOWNLOADED_SINCE', message: 'This statement was downloaded again since the page loaded.', hint: 'Nothing was deleted. Reload the page to see when, and delete again if you still mean to.' },
  failed: { status: 502, code: 'STATEMENT_DELETE_FAILED', message: 'Could not delete the statement.', hint: 'It may or may not have been deleted. Reload to see what is on record.' },
};

const sameReportFor = (a: { name: string; address: string } | null, b: { name: string; address: string } | null) => (a === null || b === null ? a === b : a.name === b.name && a.address === b.address);

/**
 * Delete a finished statement and reopen its month as a draft — THE ONE
 * PLACE A FINISHED STATEMENT IS DELETED (Kian's ruling of 2026-10-02,
 * dispatch 23G; see the head of this file). Elsewhere in the statements and
 * costs records only a cost entry is deleted (deleteCostEntry, dispatch 23H).
 *
 * Only the month's current statement — the one its draft was finished as,
 * which no other statement replaces — and only when the page's count of
 * its downloads is still the count stored, so the admin confirmed against
 * what is lost. In one transaction: the report document and every download
 * record of it are deleted, and the draft is written back holding what the
 * statement held — its lines, fee, carried balance, notes, reference, date,
 * and the statement it replaced, when it was a correction (the replaced one
 * becomes current again and the draft continues the correction). Report
 * For lives on the property's record; when the record no longer says what
 * the statement printed, it is set back to it. After the transaction the
 * PDF object at the report's stored path is deleted; if that fails the
 * object is left and logged by path, as an orphaned receipt is.
 */
export async function deleteFinishedStatement(reportId: string, input: { downloadsSeen: number }): Promise<DeleteStatementResult> {
  if (!isDocumentId(reportId)) return { kind: 'no-such-report' };
  const db = getAdminDb();
  const reportRefDoc = db.collection(MONTHLY_REPORTS_COLLECTION).doc(reportId);
  let pdfPath: string | null = null;
  let outcome: DeleteStatementResult;
  try {
    outcome = await db.runTransaction(async (tx): Promise<DeleteStatementResult> => {
      const snap = await tx.get(reportRefDoc);
      const report = snap.exists ? readMonthlyReport(snap.id, snap.data() ?? {}) : null;
      if (!report) return { kind: 'no-such-report' };
      const draftRef = db.collection(MONTHLY_REPORT_DRAFTS_COLLECTION).doc(draftId(report.propertyId, report.month));
      const managementRef = db.collection(PROPERTY_MANAGEMENT_COLLECTION).doc(report.propertyId);
      const [reports, draftSnap, downloadsSnap, managementSnap] = await Promise.all([
        propertyReports(report.propertyId, tx),
        tx.get(draftRef),
        tx.get(db.collection(REPORT_DOWNLOADS_COLLECTION).where('reportId', '==', reportId)),
        tx.get(managementRef),
      ]);

      const newer = reports.find((other) => other.supersedes?.reportId === reportId);
      if (newer) return { kind: 'replaced', by: newer.id };
      const draft = draftSnap.exists ? readStatementDraft(draftSnap.id, draftSnap.data() ?? {}) : null;
      if (!draft) return { kind: 'draft-changed' };
      if (draft.finishedAs !== reportId) return draft.finishedAs === null && draft.supersedes?.reportId === reportId ? { kind: 'correction-in-progress' } : { kind: 'draft-changed' };
      const downloads = downloadsSnap.docs.filter((doc) => readReportDownload(doc.id, doc.data()) !== null).length;
      if (downloads !== input.downloadsSeen) return { kind: 'downloaded-since', downloads };

      const now = new Date().toISOString();
      const reopened: StatementDraft = {
        schemaVersion: MONTHLY_REPORT_DRAFT_SCHEMA_VERSION,
        propertyId: report.propertyId,
        month: report.month,
        reference: report.reference,
        // A statement finished before the Payment Summary has no date of its own: the day it was finished.
        reportDate: isDayText(report.reportDate) ? report.reportDate : torontoDayOf(new Date(report.finishedAt)),
        lines: report.legacy ? report.income.map(lineFromIncomeRow) : report.lines,
        fee: report.fee,
        carried: report.carried,
        notes: report.notes,
        supersedes: report.supersedes,
        revision: draft.revision + 1,
        createdAt: draft.createdAt,
        updatedAt: now,
        finishedAs: null,
        finishedRevision: null,
      };

      // Report For, as the statement printed it (a statement of version 3 froze it; an earlier one did not).
      let management: PropertyManagementView | null = null;
      if (!report.legacy) {
        const was = managementSnap.exists ? readPropertyManagement(managementSnap.id, managementSnap.data() ?? {}) : null;
        if (managementSnap.exists && was === null) throw new Error(`property_management/${report.propertyId} is not in the written shape`);
        if (!sameReportFor(was?.reportFor ?? null, report.reportFor)) {
          const next: PropertyManagement = was
            ? { ...was, reportFor: report.reportFor, setAt: now }
            : { schemaVersion: PROPERTY_MANAGEMENT_SCHEMA_VERSION, propertyId: report.propertyId, reportFor: report.reportFor, owners: [], statementsFrom: STATEMENTS_FROM_DEFAULT, statementsUntil: null, defaultFeeRateBasisPoints: null, defaultFee: null, setAt: now };
          const { id: _id, ...fields } = next as PropertyManagement & { id?: string };
          void _id;
          tx.set(managementRef, fields);
          management = { id: report.propertyId, ...fields };
        }
      }

      tx.delete(reportRefDoc);
      for (const doc of downloadsSnap.docs) tx.delete(doc.ref);
      tx.set(draftRef, reopened);
      pdfPath = report.pdf.path;
      return { kind: 'deleted', reportId, downloads: downloadsSnap.size, pdf: 'left', draft: { id: draftRef.id, ...reopened }, management };
    });
  } catch (err) {
    console.error(`[reports] deleting statement ${reportId} failed: grpc code ${grpcCode(err)}`);
    return { kind: 'failed' };
  }
  if (outcome.kind !== 'deleted') return outcome;

  // ── The PDF, after the record is gone; the path is the one the report stored, never the request's ──
  const path = pdfPath as string | null;
  if (path === null || !path.startsWith(`${MONTHLY_REPORTS_PREFIX}/`) || path.includes('..')) {
    console.error(`[reports] statement ${reportId} deleted; its stored PDF path is not a statement's and was left alone`);
    return outcome;
  }
  try {
    const file = getAdminBucket().file(path);
    const [exists] = await file.exists();
    if (exists) await file.delete();
    console.log(`[reports] statement ${reportId} deleted with ${outcome.downloads} download record(s); PDF ${exists ? 'deleted' : 'already missing'}`);
    return { ...outcome, pdf: exists ? 'deleted' : 'missing' };
  } catch (err) {
    console.error(`[reports] orphaned statement PDF ${path} (statement ${reportId} deleted): code ${grpcCode(err)}`);
    return outcome;
  }
}

// ─── The tracker ───────────────────────────────────────────────

export interface TrackerData {
  reports: MonthlyReportSummary[];
  drafts: StatementDraftSummary[];
  downloads: ReportDownloadView[];
  management: PropertyManagementView[];
  /** Every property, with the Toronto month its document was created (the owed-months rule needs it). */
  properties: { id: string; name: string | null; createdMonth?: string | null }[];
  entries: CostEntryView[];
  /** Documents left out because they are not in the written shape. */
  unreadable: { reports: number; drafts: number; downloads: number };
}

export function summarise(report: MonthlyReportView): MonthlyReportSummary {
  const { income, lines, costs, adjustments, notes, ...rest } = report;
  void notes;
  return { ...rest, lineRows: income.length + lines.length, costRows: costs.length, adjustmentRows: adjustments.length, printed: printedBy(report) };
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
