/**
 * Server-side reads and writes of income from the platforms (dispatch 27):
 * the upload, the Income page's read, a title's link, and an admin's
 * decision on a line. Everything through the Admin SDK; firestore.rules'
 * catch-all denies every browser, and storage.rules denies the kept files.
 *
 * ── The upload ──
 * The file is read exactly, by its platform's reader (income/platforms.ts).
 * The rows paid in the month the admin uploads for become `earnings_lines`,
 * each under the SHA-256 of the four fields that make it the same line
 * (Kian's ruling): a row already stored, by this file or an earlier one, is a
 * duplicate and changes nothing. Two identical rows in one file are two
 * payments (Kian's ruling of 2026-10-13): the second is keyed apart. A row of
 * a type Nubnb does not recognise is a line like the others, and needs a
 * decision.
 * Rows paid in another month are counted, never stored, so that month's own
 * file proposes them. The file is kept with its Guest and Details columns
 * blanked, create-only and private like a receipt, before anything is
 * recorded; the same file twice (by its SHA-256) is refused and nothing is
 * stored.
 *
 * ── A line reaches a statement only when an admin accepts it ──
 * Since dispatch 37C (Kian's ruling M10) an accepted line is read where it is
 * stored, never copied into the month's draft: accepting records the
 * decision on the line, and the statements place it (M11: its month's while
 * open, else the next open one, with its date printed). It prints as an
 * ordinary line. An edit after acceptance changes the line itself, with its
 * history (I10); a line a current finished statement prints is locked unless
 * that statement is being corrected. A finished statement is never touched.
 * A line accepted before 37C was copied into its draft; it is read there.
 *
 * ── Titles ──
 * Each property holds one active title per platform, set on its edit page or
 * by the Income page's Link (Kian's rulings of 2026-10-13); its previous
 * titles stay linked to it so older files still match. A title linked to the
 * wrong property moves while none of its lines is on a finished statement,
 * its unfinished accepted lines going back for review (M13).
 *
 * ── What is never done ──
 * No price, nightly rate or fee is read or computed here; no guest's name and
 * no payout destination is stored; a property document is never written.
 */

import { createHash, randomUUID } from 'crypto';
import { FieldPath, type Transaction } from 'firebase-admin/firestore';
import { getAdminBucket, getAdminDb } from './admin';
import { isDocumentId } from './server-leads';
import { type Actor, type Refusal } from '@/app/lib/cleaners/model';
import { torontoDayOf } from '@/app/lib/costs/report';
import { addDays } from '@/app/lib/availability/days';
import { DAYS_COLLECTION, isSnapshot } from '@/app/lib/availability/store';
import { readerFor, type PlatformRow } from '@/app/lib/income/platforms';
import {
  EARNINGS_LINES_COLLECTION,
  EARNINGS_SCHEMA_VERSION,
  EARNINGS_TITLE_LINKS_COLLECTION,
  EARNINGS_UPLOADS_COLLECTION,
  EARNINGS_UPLOADS_PREFIX,
  INCOME_LIMITS,
  draftIdOf,
  isActiveTitle,
  isCopied,
  lineInDraft,
  lineKeyText,
  normaliseTitle,
  platformLinesOf,
  proposedLabel,
  readEarningsLine,
  readEarningsUpload,
  isSetAside,
  linkState,
  readTitleLink,
  titleKeyText,
  type EarningsLine,
  type EarningsLineView,
  type EarningsUpload,
  type EarningsUploadView,
  type IncomeChannel,
  type TitleLink,
  type TitleLinkView,
} from '@/app/lib/income/model';
import {
  MONTHLY_REPORTS_COLLECTION,
  MONTHLY_REPORT_DRAFTS_COLLECTION,
  PROPERTY_MANAGEMENT_COLLECTION,
  STATEMENT_LIMITS,
  currentReports,
  displayRef,
  isExcludedFromReporting,
  monthLabel,
  monthOfDay,
  monthRange,
  readMonthlyReport,
  readPropertyManagement,
  readStatementDraft,
  statementMonths,
  type Line,
  type MonthlyReportView,
  type PropertyManagementView,
  type StatementDraftView,
} from '@/app/lib/reports/model';
import { platformLinesOn, printedPlatformLines, statementMonthFor, type PlatformLineInput } from '@/app/lib/reports/statement';
import { frozenStatement } from '@/app/lib/money/month';
import { renameSuggestions, type RenameSuggestion } from '@/app/lib/income/month';

const LINE_ID = /^[0-9a-f]{64}$/;

function grpcCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? String(code) : typeof code === 'string' ? code : 'unknown';
}

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export const lineIdOf = (platform: IncomeChannel, row: Pick<EarningsLine, 'confirmationCode' | 'payoutDate' | 'type' | 'amountCents'>, occurrence = 1) => sha256(lineKeyText(platform, row, occurrence));
export const linkIdOf = (platform: IncomeChannel, title: string) => sha256(titleKeyText(platform, title));
export const isEarningsLineId = (id: unknown): id is string => typeof id === 'string' && LINE_ID.test(id);

/** The browser's file name, kept for the admin: letters, digits and . _ - only. */
function cleanFileName(name: string): string {
  const cleaned = (name || 'upload.csv').replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned.slice(-INCOME_LIMITS.FILE_NAME_MAX) || 'upload.csv';
}

// ─── The upload ─────────────────────────────────────────────────

export type UploadResult =
  | { kind: 'uploaded'; upload: EarningsUploadView }
  | { kind: 'unreadable'; problems: string[] }
  | { kind: 'nothing-in-month'; months: string[] }
  | { kind: 'too-many'; lines: number }
  | { kind: 'already-uploaded'; uploadId: string; uploadedAt: string; month: string }
  | { kind: 'storage-failed' }
  | { kind: 'failed' };

export const UPLOAD_REFUSALS: Record<Exclude<UploadResult['kind'], 'uploaded'>, Refusal> = {
  unreadable: { status: 422, code: 'FILE_UNREADABLE', message: 'This file cannot be read as Airbnb\'s transaction report.', hint: 'Nothing was stored. Export the CSV from Airbnb again and upload it as it comes.' },
  'nothing-in-month': { status: 422, code: 'NOTHING_IN_MONTH', message: 'No row of this file was paid out in the month chosen.', hint: 'Nothing was stored. Choose the month the file covers.' },
  'too-many': { status: 422, code: 'FILE_TOO_LONG', message: `One upload can hold at most ${INCOME_LIMITS.LINES_PER_UPLOAD_MAX} rows for the month.`, hint: 'Nothing was stored. Export the month in two parts.' },
  'already-uploaded': { status: 409, code: 'FILE_ALREADY_UPLOADED', message: 'This exact file was uploaded before.', hint: 'Nothing was stored: its lines are already on the Income page.' },
  'storage-failed': { status: 502, code: 'FILE_NOT_STORED', message: 'The file could not be kept.', hint: 'Nothing was recorded. Try again.' },
  failed: { status: 502, code: 'UPLOAD_RECORD_FAILED', message: 'Could not record the upload.', hint: 'It may or may not have been recorded. Reload the Income page to see.' },
};

/**
 * Read a platform's file for `month`, keep it blanked, and store its new
 * lines. One transaction records the upload and every new line; the kept
 * file is written first, and removed again (by its exact path) when the
 * record is not.
 */
export async function uploadEarnings(actor: Actor, input: { platform: IncomeChannel; month: string; fileName: string; bytes: Buffer; text: string }): Promise<UploadResult> {
  const { platform, month } = input;
  const read = readerFor(platform).read(input.text);
  if (!read.ok) return { kind: 'unreadable', problems: read.problems };

  const inMonth = read.lines.filter((line) => monthOfDay(line.payoutDate) === month);
  const notReadInMonth = read.notRead.filter((row) => monthOfDay(row.payoutDate) === month);
  const outside = new Map<string, { rows: number; amountCents: number }>();
  for (const row of [...read.lines, ...read.notRead]) {
    const rowMonth = monthOfDay(row.payoutDate);
    if (rowMonth === month) continue;
    const was = outside.get(rowMonth) ?? { rows: 0, amountCents: 0 };
    outside.set(rowMonth, { rows: was.rows + 1, amountCents: was.amountCents + row.amountCents });
  }
  if (inMonth.length === 0 && notReadInMonth.length === 0) return { kind: 'nothing-in-month', months: [...outside.keys()].sort() };
  if (inMonth.length > INCOME_LIMITS.LINES_PER_UPLOAD_MAX) return { kind: 'too-many', lines: inMonth.length };

  // The month's rows, each under its key. Two identical rows in one file are two payments (Kian's ruling of
  // 2026-10-13): the second is keyed "|2", the third "|3", in the file's order.
  const byId = new Map<string, PlatformRow>();
  const seenInFile = new Map<string, number>();
  for (const row of inMonth) {
    const key = lineKeyText(platform, row);
    const occurrence = (seenInFile.get(key) ?? 0) + 1;
    seenInFile.set(key, occurrence);
    byId.set(lineIdOf(platform, row, occurrence), row);
  }
  const titles = new Map<string, { rows: number; amountCents: number }>();
  for (const row of inMonth) {
    const was = titles.get(row.listingTitle) ?? { rows: 0, amountCents: 0 };
    titles.set(row.listingTitle, { rows: was.rows + 1, amountCents: was.amountCents + row.amountCents });
  }

  const db = getAdminDb();
  const fileSha = sha256(input.bytes);
  const sameFile = db.collection(EARNINGS_UPLOADS_COLLECTION).where('file.sha256', '==', fileSha).limit(1);
  const earlier = await sameFile.get();
  if (!earlier.empty) {
    const was = readEarningsUpload(earlier.docs[0].id, earlier.docs[0].data());
    return { kind: 'already-uploaded', uploadId: earlier.docs[0].id, uploadedAt: was?.uploadedAt ?? '', month: was?.month ?? '' };
  }

  // ── The file, blanked, kept before anything is recorded ──
  const uploadRef = db.collection(EARNINGS_UPLOADS_COLLECTION).doc();
  const stored = Buffer.from(read.blanked, 'utf8');
  const storedSha = sha256(stored);
  const path = `${EARNINGS_UPLOADS_PREFIX}/${uploadRef.id}/${randomUUID()}.csv`;
  const name = cleanFileName(input.fileName);
  const uploadedAt = new Date().toISOString();
  try {
    await getAdminBucket()
      .file(path)
      .save(stored, {
        resumable: false,
        contentType: 'text/csv; charset=utf-8',
        preconditionOpts: { ifGenerationMatch: 0 },
        metadata: {
          contentType: 'text/csv; charset=utf-8',
          contentDisposition: 'attachment',
          cacheControl: 'private, max-age=0, no-store',
          metadata: { uploadId: uploadRef.id, platform, month, originalName: name, sha256: fileSha, storedSha256: storedSha, blanked: read.blankedColumns.join(','), uploadedAt },
        },
      });
  } catch (err) {
    console.error(`[income] the file for upload ${uploadRef.id} was not stored: code ${grpcCode(err)}`);
    return { kind: 'storage-failed' };
  }

  const record: EarningsUpload = {
    schemaVersion: EARNINGS_SCHEMA_VERSION,
    platform,
    month,
    file: { name, kind: 'csv', bytes: input.bytes.length, sha256: fileSha, storagePath: path, storedBytes: stored.length, storedSha256: storedSha, blanked: read.blankedColumns },
    read: { by: 'csv', rows: read.rows, payoutRows: read.payouts.length, lineRows: read.lines.length, amountCents: read.amountCents, paidOutCents: read.paidOutCents, balanced: read.balanced, unbalanced: read.unbalanced, ...(read.checkedBy === 'day' ? { checkedBy: 'day' as const } : {}) },
    titles: [...titles.entries()].map(([title, t]) => ({ title, rows: t.rows, amountCents: t.amountCents })).sort((a, b) => a.title.localeCompare(b.title)),
    added: 0,
    duplicates: 0,
    outsideMonth: [...outside.entries()].map(([m, o]) => ({ month: m, rows: o.rows, amountCents: o.amountCents })).sort((a, b) => a.month.localeCompare(b.month)),
    notRead: notReadInMonth.map((row) => ({ row: row.row, type: row.type, amountCents: row.amountCents, why: row.why })),
    uploadedAt,
    actor,
  };

  const lineRefs = [...byId.keys()].map((id) => db.collection(EARNINGS_LINES_COLLECTION).doc(id));
  try {
    const outcome = await db.runTransaction(async (tx): Promise<UploadResult> => {
      const again = await tx.get(sameFile);
      if (!again.empty) {
        const was = readEarningsUpload(again.docs[0].id, again.docs[0].data());
        return { kind: 'already-uploaded', uploadId: again.docs[0].id, uploadedAt: was?.uploadedAt ?? '', month: was?.month ?? '' };
      }
      const existing = lineRefs.length > 0 ? await tx.getAll(...lineRefs) : [];
      const fresh = existing.filter((snap) => !snap.exists);
      // A title set aside as not a Nubnb property (dispatch 36, Kian's ruling of 2026-10-12): its lines are rejected.
      const titlesHere = [...new Set(fresh.map((snap) => byId.get(snap.id)!.listingTitle))];
      const linkSnaps = titlesHere.length > 0 ? await tx.getAll(...titlesHere.map((title) => db.collection(EARNINGS_TITLE_LINKS_COLLECTION).doc(linkIdOf(platform, title)))) : [];
      const setAside = new Set(titlesHere.filter((_, i) => linkSnaps[i].exists && isSetAside(readTitleLink(linkSnaps[i].id, linkSnaps[i].data() ?? {}))));
      const next: EarningsUpload = { ...record, added: fresh.length, duplicates: existing.length - fresh.length };
      tx.create(uploadRef, next);
      for (const snap of fresh) {
        const row = byId.get(snap.id)!;
        const aside = setAside.has(row.listingTitle);
        const line: EarningsLine = {
          schemaVersion: EARNINGS_SCHEMA_VERSION,
          platform,
          uploadId: uploadRef.id,
          fileRow: row.row,
          payoutDate: row.payoutDate,
          month,
          type: row.type,
          confirmationCode: row.confirmationCode,
          listingTitle: row.listingTitle,
          stay: row.stay,
          amountCents: row.amountCents,
          currency: row.currency,
          evidence: row.evidence,
          remittedTaxCents: row.remittedTaxCents,
          status: aside ? 'rejected' : 'proposed',
          decided: aside ? { status: 'rejected', at: uploadedAt, actor } : null,
          history: aside ? [{ at: uploadedAt, actor, action: 'rejected' }] : [],
        };
        tx.create(snap.ref, line);
      }
      return { kind: 'uploaded', upload: { id: uploadRef.id, ...next } };
    });
    if (outcome.kind !== 'uploaded') await removeKeptFile(path, uploadRef.id);
    return outcome;
  } catch (err) {
    console.error(`[income] recording upload ${uploadRef.id} failed: grpc code ${grpcCode(err)}`);
    // The commit's outcome is not known from the error: look before removing the file.
    try {
      const landed = await uploadRef.get();
      if (landed.exists) {
        const upload = readEarningsUpload(landed.id, landed.data() ?? {});
        if (upload) return { kind: 'uploaded', upload };
      } else {
        await removeKeptFile(path, uploadRef.id);
      }
    } catch (again) {
      console.error(`[income] could not check upload ${uploadRef.id} after the failure; its file ${path} may be left: grpc code ${grpcCode(again)}`);
    }
    return { kind: 'failed' };
  }
}

/** Remove a kept file whose upload was not recorded, by its exact path. Logged, never thrown. */
async function removeKeptFile(path: string, uploadId: string): Promise<void> {
  try {
    await getAdminBucket().file(path).delete();
  } catch (err) {
    console.error(`[income] orphaned file ${path} (upload ${uploadId} not recorded): code ${grpcCode(err)}`);
  }
}

// ─── The Income page's read ─────────────────────────────────────

/** One property-month's statement, as the Income page needs it: its lines, and whether it is finished. */
export interface MonthStatement {
  propertyId: string;
  /** null when the month has no draft. */
  draftId: string | null;
  revision: number | null;
  finished: boolean;
  /**
   * The statement's lines: a finished one's as printed; otherwise the accepted lines from the files it places (read
   * where they are stored, dispatch 37C) and then the lines typed on its draft. What the property page shows and the
   * statement prints.
   */
  lines: Line[];
  /**
   * While a correction is written (the draft replaces the month's finished statement): that statement's lines, as
   * sent. The month's figures are the statement the owner holds; the correction's are said beside (dispatch 37A, T2).
   */
  sent: Line[] | null;
}

export interface IncomeMonth {
  month: string;
  /** The Toronto day the read was made. */
  today: string;
  /** The month's uploads, newest first. */
  uploads: EarningsUploadView[];
  /** The month's lines, whatever their status. */
  lines: EarningsLineView[];
  /** Every title link. */
  links: TitleLinkView[];
  /** The last month each linked title was in a file, by link ID. */
  lastSeen: Record<string, string>;
  /** Every property, A to Z. */
  properties: { id: string; name: string }[];
  /** Every property-month with a draft, a finished statement, or accepted lines placed in the month. */
  statements: MonthStatement[];
  /** Check-ins in the month on the stored calendars, and which daily copies they were read from. */
  calendar: { days: string[]; checkIns: { propertyId: string; days: string[] }[] };
  /** Properties that owe no statement for the month, and why (I5). */
  noStatement: { propertyId: string; why: string }[];
  /** Titles that may be a linked title renamed (M14): offered, never applied. */
  renames: RenameSuggestion[];
  /** The month's accepted lines a finished statement prints, by line ID (M10: locked), unless that statement is being corrected. */
  locked: Record<string, { month: string; reference: string }>;
  /** Stored documents left out because they are not in the written shape. */
  unreadable: number;
}

/** Why a property owes no statement for a month (I5), or null when it owes one: excluded from reporting, or outside its record's months. */
function noStatementWhy(record: PropertyManagementView | null, month: string): string | null {
  if (isExcludedFromReporting(record)) return 'It is excluded from reporting: no statement is asked for.';
  if (!record) return null;
  if (record.statementsUntil !== null && month > record.statementsUntil) return `Its statements ended with ${monthLabel(record.statementsUntil)}: no statement is asked for.`;
  if (month < record.statementsFrom) return `Its statements start in ${monthLabel(record.statementsFrom)}: no statement is asked for ${monthLabel(month)}.`;
  return null;
}

/** The reserved stays each property's calendar copies hold that run into the month: what renames and I15 compare lines with. */
function calendarStays(days: { id: string; data: Record<string, unknown> }[], from: string, to: string, only?: string): Map<string, { start: string; end: string }[]> {
  const stays = new Map<string, Map<string, { start: string; end: string }>>();
  for (const { data } of days) {
    if (!isSnapshot(data)) continue;
    for (const [propertyId, feed] of Object.entries(data.properties)) {
      if (only !== undefined && propertyId !== only) continue;
      for (const event of feed.events ?? []) {
        if (event.kind !== 'reserved' || event.start > to || event.end < from) continue;
        const mine = stays.get(propertyId) ?? new Map<string, { start: string; end: string }>();
        mine.set(`${event.start}|${event.end}`, { start: event.start, end: event.end });
        stays.set(propertyId, mine);
      }
    }
  }
  return new Map([...stays].map(([propertyId, map]) => [propertyId, [...map.values()].sort((a, b) => a.start.localeCompare(b.start))]));
}

/** The month's statement lines for one property, with the accepted lines read where they are stored placed on it (dispatch 37C). */
function monthStatementOf(input: { propertyId: string; month: string; reports: MonthlyReportView[]; draft: StatementDraftView | null; record: PropertyManagementView | null; platformLines: PlatformLineInput[] }): MonthStatement | null {
  const { propertyId, month, reports, draft, record } = input;
  const frozen = frozenStatement(reports, month, draft);
  if (frozen) return { propertyId, draftId: draft?.id ?? null, revision: draft?.revision ?? null, finished: true, lines: frozen.lines, sent: null };
  const superseding = draft?.supersedes?.reportId ?? null;
  const current = currentReports(reports).filter((report) => report.id !== superseding);
  const placed = platformLinesOn({ propertyId, month, firstMonth: statementMonths(record).from, platformLines: input.platformLines, current }).map((row) => row.line);
  if (!draft && placed.length === 0) return null;
  // A correction in progress: the statement it replaces, as sent (dispatch 37A, T2).
  const replaced = draft && superseding !== null ? (reports.find((report) => report.id === superseding) ?? null) : null;
  return { propertyId, draftId: draft?.id ?? null, revision: draft?.revision ?? null, finished: false, lines: [...placed, ...(draft?.lines ?? [])], sent: replaced ? replaced.lines : null };
}

/**
 * Everything the Income page shows for a month, in one answer. Read whole,
 * no limit: a failed read is an error, never an empty month.
 *
 * Reads: every upload (a few a month), the month's lines, every accepted
 * line (the statements place them, dispatch 37C), every link, every
 * property's name, every owner record, the month's drafts, every finished
 * statement, the daily calendar copies of the month and the week after it,
 * and the lines that share a confirmation code with the month's unlinked
 * titles (renames, M14).
 *
 * @throws if any read fails.
 */
export async function readIncomeMonth(month: string): Promise<IncomeMonth> {
  const db = getAdminDb();
  const { from, to } = monthRange(month);
  const [uploadsSnap, linesSnap, acceptedSnap, linksSnap, propertiesSnap, draftsSnap, reportsSnap, managementSnap, daysSnap] = await Promise.all([
    db.collection(EARNINGS_UPLOADS_COLLECTION).get(),
    db.collection(EARNINGS_LINES_COLLECTION).where('month', '==', month).get(),
    db.collection(EARNINGS_LINES_COLLECTION).where('status', '==', 'accepted').get(),
    db.collection(EARNINGS_TITLE_LINKS_COLLECTION).get(),
    db.collection('properties').select('name').get(),
    db.collection(MONTHLY_REPORT_DRAFTS_COLLECTION).where('month', '==', month).get(),
    db.collection(MONTHLY_REPORTS_COLLECTION).get(),
    db.collection(PROPERTY_MANAGEMENT_COLLECTION).get(),
    db.collection(DAYS_COLLECTION).where(FieldPath.documentId(), '>=', from).where(FieldPath.documentId(), '<=', addDays(to, 7)).get(),
  ]);
  let unreadable = 0;

  const allUploads: EarningsUploadView[] = [];
  for (const doc of uploadsSnap.docs) {
    const upload = readEarningsUpload(doc.id, doc.data());
    if (upload) allUploads.push(upload);
    else unreadable += 1;
  }
  const lines: EarningsLineView[] = [];
  for (const doc of linesSnap.docs) {
    const line = readEarningsLine(doc.id, doc.data());
    if (line) lines.push(line);
    else unreadable += 1;
  }
  const accepted = acceptedSnap.docs.map((doc) => readEarningsLine(doc.id, doc.data())).filter((line): line is EarningsLineView => line !== null);
  const platformLines = platformLinesOf(accepted);
  const links: TitleLinkView[] = [];
  for (const doc of linksSnap.docs) {
    const link = readTitleLink(doc.id, doc.data());
    if (link) links.push(link);
    else unreadable += 1;
  }
  const lastSeen: Record<string, string> = {};
  for (const link of links) {
    const months = allUploads.filter((u) => u.platform === link.platform && u.titles.some((t) => t.title === link.title)).map((u) => u.month);
    if (months.length > 0) lastSeen[link.id] = months.sort()[months.length - 1];
  }
  const properties = propertiesSnap.docs
    .map((doc) => {
      const name: unknown = doc.get('name');
      return { id: doc.id, name: typeof name === 'string' && name.trim() !== '' ? name : 'Unnamed property' };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const reportsByProperty = new Map<string, MonthlyReportView[]>();
  for (const doc of reportsSnap.docs) {
    const report = readMonthlyReport(doc.id, doc.data());
    if (report) reportsByProperty.set(report.propertyId, [...(reportsByProperty.get(report.propertyId) ?? []), report]);
  }
  const records = new Map<string, PropertyManagementView>();
  for (const doc of managementSnap.docs) {
    const record = readPropertyManagement(doc.id, doc.data());
    if (record) records.set(record.propertyId, record);
  }
  const drafts = new Map<string, StatementDraftView>();
  for (const doc of draftsSnap.docs) {
    const draft = readStatementDraft(doc.id, doc.data());
    if (draft) drafts.set(draft.propertyId, draft);
    else unreadable += 1;
  }

  // ── Each property's statement for the month: finished, or as it stands with the accepted lines it places ──
  const statements: MonthStatement[] = [];
  const withStatement = new Set<string>([...drafts.keys(), ...platformLines.map((line) => line.propertyId)]);
  for (const [propertyId, reports] of reportsByProperty) if (currentReports(reports).some((report) => report.month === month)) withStatement.add(propertyId);
  for (const propertyId of withStatement) {
    const statement = monthStatementOf({ propertyId, month, reports: reportsByProperty.get(propertyId) ?? [], draft: drafts.get(propertyId) ?? null, record: records.get(propertyId) ?? null, platformLines });
    if (statement) statements.push(statement);
  }

  // ── The calendar: check-ins in the month (the gaps), and stays (renames) ──
  const days: string[] = [];
  const checkIns = new Map<string, Set<string>>();
  for (const doc of daysSnap.docs) {
    const data = doc.data();
    if (!isSnapshot(data)) continue;
    days.push(doc.id);
    for (const [propertyId, feed] of Object.entries(data.properties)) {
      for (const event of feed.events ?? []) {
        if (event.kind !== 'reserved' || event.start < from || event.start > to) continue;
        const set = checkIns.get(propertyId) ?? new Set<string>();
        set.add(event.start);
        checkIns.set(propertyId, set);
      }
    }
  }
  const stays = calendarStays(daysSnap.docs.map((doc) => ({ id: doc.id, data: doc.data() })), from, to);

  // ── Renames (M14): the codes of the month's unlinked lines, looked up in every other file ──
  const linked = new Set(links.map((link) => `${link.platform}|${link.title}`));
  const codes = [...new Set(lines.filter((line) => !linked.has(`${line.platform}|${line.listingTitle}`)).map((line) => line.confirmationCode))];
  const earlierSnaps = await Promise.all(Array.from({ length: Math.ceil(codes.length / 30) }, (_, i) => db.collection(EARNINGS_LINES_COLLECTION).where('confirmationCode', 'in', codes.slice(i * 30, i * 30 + 30)).get()));
  const earlier = earlierSnaps.flatMap((snap) => snap.docs.map((doc) => readEarningsLine(doc.id, doc.data())).filter((line): line is EarningsLineView => line !== null));
  const renames = renameSuggestions({ lines, earlier, links, properties, calendar: [...stays].map(([propertyId, list]) => ({ propertyId, stays: list })) });

  const noStatement = properties.map((p) => ({ propertyId: p.id, why: noStatementWhy(records.get(p.id) ?? null, month) })).filter((row): row is { propertyId: string; why: string } => row.why !== null);

  // ── Locked (M10): the month's accepted lines a current finished statement prints, unless a correction of it is written ──
  const locked: Record<string, { month: string; reference: string }> = {};
  const correctionDrafts = await linesLockedBy(lines, reportsByProperty);
  for (const [id, lock] of correctionDrafts) locked[id] = lock;

  return {
    month,
    today: torontoDayOf(new Date()),
    uploads: allUploads.filter((u) => u.month === month).sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt)),
    lines: lines.sort((a, b) => a.payoutDate.localeCompare(b.payoutDate) || a.fileRow - b.fileRow),
    links: links.sort((a, b) => a.title.localeCompare(b.title)),
    lastSeen,
    properties,
    statements,
    calendar: { days: days.sort(), checkIns: [...checkIns.entries()].map(([propertyId, set]) => ({ propertyId, days: [...set].sort() })) },
    noStatement,
    renames,
    locked,
    unreadable,
  };
}

/**
 * Which of these lines a current finished statement prints, and is not being corrected: locked (Kian's ruling M10).
 * Reads the drafts of the months those statements are for, to see whether a correction of one is written.
 */
async function linesLockedBy(lines: EarningsLineView[], reportsByProperty: Map<string, MonthlyReportView[]>): Promise<Map<string, { month: string; reference: string }>> {
  const out = new Map<string, { month: string; reference: string }>();
  const candidates: { line: EarningsLineView; report: MonthlyReportView }[] = [];
  for (const line of lines) {
    if (line.decided?.status !== 'accepted' || isCopied(line.decided)) continue;
    const current = currentReports(reportsByProperty.get(line.decided.propertyId) ?? []);
    const printed = printedPlatformLines(current).get(line.id);
    const report = printed ? current.find((r) => r.id === printed.reportId) : undefined;
    if (report) candidates.push({ line, report });
  }
  if (candidates.length === 0) return out;
  const db = getAdminDb();
  const draftIds = [...new Set(candidates.map(({ report }) => draftIdOf(report.propertyId, report.month)))];
  const drafts = await db.getAll(...draftIds.map((id) => db.collection(MONTHLY_REPORT_DRAFTS_COLLECTION).doc(id)));
  const correcting = new Set(
    drafts
      .map((doc) => (doc.exists ? readStatementDraft(doc.id, doc.data() ?? {}) : null))
      .filter((draft): draft is StatementDraftView => draft !== null && draft.finishedAs === null && draft.supersedes !== null)
      .map((draft) => draft.supersedes!.reportId),
  );
  for (const { line, report } of candidates) if (!correcting.has(report.id)) out.set(line.id, { month: report.month, reference: displayRef(report) });
  return out;
}

/** One property's lines from the files, its titles, the titles no link names, and, for a month, its calendar's stays. */
export interface PropertyIncome {
  lines: EarningsLineView[];
  uploads: { id: string; name: string; month: string }[];
  unlinked: UnlinkedTitle[];
  /** Its titles: the active one per platform and the previous ones (dispatch 37C). */
  titles: TitleLinkView[];
  /** For the month asked: the daily calendar copies kept, and the reserved stays they hold for the property (I8, I15). */
  calendar: { month: string; days: string[]; stays: { start: string; end: string }[] } | null;
}

/**
 * One property's lines from the files, for its page: those under its titles (active or previous, each on its own
 * platform) and those decided for it. With a month: the calendar copies of the month and the week after it, and the
 * property's stays in them. @throws if a read fails.
 */
export async function readPropertyIncome(propertyId: string, month: string | null = null): Promise<PropertyIncome> {
  const db = getAdminDb();
  // Every link and every upload, both small (one link per title, one upload per file): the property's titles,
  // and the titles in each month's files that no link names (dispatch 34, I1).
  const range = month ? monthRange(month) : null;
  const [linksSnap, uploadsSnap, daysSnap] = await Promise.all([
    db.collection(EARNINGS_TITLE_LINKS_COLLECTION).get(),
    db.collection(EARNINGS_UPLOADS_COLLECTION).get(),
    range ? db.collection(DAYS_COLLECTION).where(FieldPath.documentId(), '>=', range.from).where(FieldPath.documentId(), '<=', addDays(range.to, 7)).get() : Promise.resolve(null),
  ]);
  const links = linksSnap.docs.map((doc) => readTitleLink(doc.id, doc.data())).filter((link): link is TitleLinkView => link !== null);
  const titles = links.filter((link) => link.propertyId === propertyId);
  // Their rows and totals from the stored lines, each row once (dispatch 37A, T3), as the Income page counts them.
  const unlinked = await readUnlinkedTitles(
    uploadsSnap.docs.map((doc) => readEarningsUpload(doc.id, doc.data())).filter((upload): upload is EarningsUploadView => upload !== null),
    links,
  );
  const names = [...new Set(titles.map((link) => link.title))];
  const queries = [db.collection(EARNINGS_LINES_COLLECTION).where('decided.propertyId', '==', propertyId).get()];
  for (let i = 0; i < names.length; i += 30) queries.push(db.collection(EARNINGS_LINES_COLLECTION).where('listingTitle', 'in', names.slice(i, i + 30)).get());
  const snaps = await Promise.all(queries);
  const mine = new Set(titles.map((link) => `${link.platform}|${link.title}`));
  const byId = new Map<string, EarningsLineView>();
  for (const snap of snaps) {
    for (const doc of snap.docs) {
      const line = readEarningsLine(doc.id, doc.data());
      if (!line) continue;
      const decidedHere = line.decided?.status === 'accepted' && line.decided.propertyId === propertyId;
      // A line decided for another property, under a title now linked here, is not this property's; nor a line of another platform's title of the same words.
      if (line.decided?.status === 'accepted' && !decidedHere) continue;
      if (!decidedHere && !mine.has(`${line.platform}|${line.listingTitle}`)) continue;
      byId.set(line.id, line);
    }
  }
  const uploadIds = [...new Set([...byId.values()].map((line) => line.uploadId))];
  const uploads: { id: string; name: string; month: string }[] = [];
  if (uploadIds.length > 0) {
    const docs = await db.getAll(...uploadIds.map((id) => db.collection(EARNINGS_UPLOADS_COLLECTION).doc(id)));
    for (const doc of docs) {
      const upload = doc.exists ? readEarningsUpload(doc.id, doc.data() ?? {}) : null;
      if (upload) uploads.push({ id: upload.id, name: upload.file.name, month: upload.month });
    }
  }
  const calendar =
    month && range && daysSnap
      ? {
          month,
          days: daysSnap.docs.filter((doc) => isSnapshot(doc.data())).map((doc) => doc.id).sort(),
          stays: calendarStays(daysSnap.docs.map((doc) => ({ id: doc.id, data: doc.data() })), range.from, range.to, propertyId).get(propertyId) ?? [],
        }
      : null;
  return {
    lines: [...byId.values()].sort((a, b) => a.payoutDate.localeCompare(b.payoutDate) || a.fileRow - b.fileRow),
    uploads,
    unlinked,
    titles: titles.sort((a, b) => Number(isActiveTitle(b)) - Number(isActiveTitle(a)) || b.linkedAt.localeCompare(a.linkedAt)),
    calendar,
  };
}

/** A title in a month's files that no link names, with its rows and total across that month's files (dispatch 34, I1). */
export interface UnlinkedTitle {
  month: string;
  title: string;
  rows: number;
  amountCents: number;
}

/**
 * The titles in each month's files that no link names (dispatch 34, I1): a property's money may be under one,
 * so Finish warns while any is left. A title in two files of the same month is counted once, its rows and
 * totals added.
 */
export function unlinkedTitles(uploads: Pick<EarningsUploadView, 'platform' | 'month' | 'titles'>[], links: Pick<TitleLinkView, 'platform' | 'title'>[]): UnlinkedTitle[] {
  const linked = new Set(links.map((link) => titleKeyText(link.platform, link.title)));
  const byKey = new Map<string, UnlinkedTitle>();
  for (const upload of uploads) {
    for (const title of upload.titles) {
      const key = titleKeyText(upload.platform, title.title);
      if (linked.has(key)) continue;
      const was = byKey.get(`${upload.month}|${key}`);
      byKey.set(`${upload.month}|${key}`, { month: upload.month, title: normaliseTitle(title.title), rows: (was?.rows ?? 0) + title.rows, amountCents: (was?.amountCents ?? 0) + title.amountCents });
    }
  }
  return [...byKey.values()].sort((a, b) => a.month.localeCompare(b.month) || a.title.localeCompare(b.title));
}

/**
 * The titles no link names, their rows and totals counted from the stored lines (dispatch 37A, T3): each row once,
 * however many of the month's files held it, as the Income page counts them. A file's own summary counts a row
 * again in every file that repeats it.
 */
export function unlinkedTitlesFromLines(lines: Pick<EarningsLineView, 'platform' | 'month' | 'listingTitle' | 'amountCents'>[], links: Pick<TitleLinkView, 'platform' | 'title'>[]): UnlinkedTitle[] {
  const linked = new Set(links.map((link) => titleKeyText(link.platform, link.title)));
  const byKey = new Map<string, UnlinkedTitle>();
  for (const line of lines) {
    const key = titleKeyText(line.platform, line.listingTitle);
    if (linked.has(key)) continue;
    const was = byKey.get(`${line.month}|${key}`);
    byKey.set(`${line.month}|${key}`, { month: line.month, title: normaliseTitle(line.listingTitle), rows: (was?.rows ?? 0) + 1, amountCents: (was?.amountCents ?? 0) + line.amountCents });
  }
  return [...byKey.values()].sort((a, b) => a.month.localeCompare(b.month) || a.title.localeCompare(b.title));
}

/** The titles in the files that no link names, their totals from the stored lines: the files say which titles, the lines how much. @throws if a read fails. */
async function readUnlinkedTitles(uploads: EarningsUploadView[], links: TitleLinkView[]): Promise<UnlinkedTitle[]> {
  const candidates = [...new Set(unlinkedTitles(uploads, links).map((title) => title.title))];
  if (candidates.length === 0) return [];
  const db = getAdminDb();
  const snaps = await Promise.all(Array.from({ length: Math.ceil(candidates.length / 30) }, (_, i) => db.collection(EARNINGS_LINES_COLLECTION).where('listingTitle', 'in', candidates.slice(i * 30, i * 30 + 30)).get()));
  const lines = snaps.flatMap((snap) => snap.docs.map((doc) => readEarningsLine(doc.id, doc.data())).filter((line): line is EarningsLineView => line !== null));
  return unlinkedTitlesFromLines(lines, links);
}

export type SetAsideResult = { kind: 'set-aside'; link: TitleLinkView; rejected: number } | { kind: 'changed-since'; propertyId: string | null } | { kind: 'failed' };

/**
 * Set a title aside as "not a Nubnb property" (dispatch 36, Kian's ruling of 2026-10-12, amending "never dropped" and
 * "stays unlinked until an admin links it"): it stays listed and marked, leaves the gaps count, and its lines are
 * rejected. In one transaction, refused unless the link is what the page showed (`expected`, as `linkState`): the
 * link is written set aside, its history kept, and every proposed line under the title is rejected with an event in
 * its history. Lines already accepted stay where they went; a finished statement is never touched. Linking the title
 * to a property later is an ordinary link; its rejected lines can be proposed again one by one.
 */
export async function setTitleAside(actor: Actor, input: { platform: IncomeChannel; title: string; expected: string | null }): Promise<SetAsideResult> {
  const db = getAdminDb();
  const title = normaliseTitle(input.title);
  const ref = db.collection(EARNINGS_TITLE_LINKS_COLLECTION).doc(linkIdOf(input.platform, title));
  try {
    return await db.runTransaction(async (tx): Promise<SetAsideResult> => {
      const [snap, linesSnap] = await Promise.all([tx.get(ref), tx.get(db.collection(EARNINGS_LINES_COLLECTION).where('listingTitle', '==', title))]);
      const stored = snap.exists ? readTitleLink(snap.id, snap.data() ?? {}) : null;
      if (snap.exists && stored === null) return { kind: 'failed' };
      if (linkState(stored) !== input.expected) return { kind: 'changed-since', propertyId: linkState(stored) };
      const now = new Date().toISOString();
      let rejected = 0;
      for (const doc of linesSnap.docs) {
        const line = readEarningsLine(doc.id, doc.data());
        if (!line || line.platform !== input.platform || line.status !== 'proposed') continue;
        tx.update(doc.ref, { status: 'rejected', decided: { status: 'rejected', at: now, actor }, history: [...line.history, { at: now, actor, action: 'rejected' }] });
        rejected += 1;
      }
      if (stored && isSetAside(stored)) return { kind: 'set-aside', link: stored, rejected };
      const next: TitleLink = {
        schemaVersion: EARNINGS_SCHEMA_VERSION,
        platform: input.platform,
        title,
        propertyId: null,
        notNubnb: true,
        linkedAt: now,
        actor,
        history: stored ? [...stored.history, pastLink(stored)] : [],
      };
      tx.set(ref, next);
      return { kind: 'set-aside', link: { id: ref.id, ...next }, rejected };
    });
  } catch (err) {
    console.error(`[income] setting ${ref.id} aside failed: grpc code ${grpcCode(err)}`);
    return { kind: 'failed' };
  }
}

// ─── Titles: one active per property, previous ones kept (dispatch 37C) ──

export type LinkResult =
  | { kind: 'linked'; link: TitleLinkView; previous: string | null; sentBack: number }
  | { kind: 'no-such-property' }
  | { kind: 'changed-since'; propertyId: string | null }
  | { kind: 'printed'; statements: { month: string; reference: string }[] }
  | { kind: 'copied' }
  | { kind: 'failed' };

export const LINK_REFUSALS: Record<Exclude<LinkResult['kind'], 'linked'>, Refusal> = {
  'no-such-property': { status: 404, code: 'PROPERTY_NOT_FOUND', message: 'That property does not exist.' },
  'changed-since': { status: 409, code: 'LINK_CHANGED', message: 'This title\'s link changed since the page loaded.', hint: 'Nothing was changed. Reload the page.' },
  printed: { status: 409, code: 'TITLE_LINES_PRINTED', message: 'A line under this title is on a finished statement, so the title stays where it is.', hint: 'Nothing was changed. A title moves only while none of its lines is on a finished statement (Kian\'s ruling M13).' },
  copied: { status: 409, code: 'TITLE_LINES_IN_DRAFT', message: 'A line under this title was accepted before dispatch 37C and copied into a draft.', hint: 'Nothing was changed. Remove that line from the statement on its property\'s page first.' },
  failed: { status: 502, code: 'LINK_WRITE_FAILED', message: 'Could not save the link.', hint: 'It may or may not have been saved. Reload to see.' },
};

/** A link as its history keeps it. */
const pastLink = (link: TitleLink) => ({ propertyId: link.propertyId, ...(link.notNubnb ? { notNubnb: true as const } : {}), linkedAt: link.linkedAt, actor: link.actor, ...(link.active !== undefined ? { active: link.active } : {}) });

/**
 * Make a title a property's active title (Kian's rulings of 2026-10-13): from its edit page, or the Income page's
 * Link, the second door to the same record (M12), or a rename accepted (M14). In one transaction, refused unless the
 * title's link is what the page showed (`expected`, as `linkState`):
 *   - the property's active title on the platform, if another, becomes a previous title, still its own, so older
 *     files still match;
 *   - a title linked to another property moves (M13) only while none of its lines is on a finished statement; its
 *     lines accepted for another property and not printed go back for review, each with an event saying why. A line
 *     accepted before dispatch 37C, copied into a draft, stops the move: it is removed on its property's page first.
 * Lines still proposed follow the link: a line carries no property until accepted.
 */
export async function setActiveTitle(actor: Actor, input: { platform: IncomeChannel; title: string; propertyId: string; expected: string | null }): Promise<LinkResult> {
  const db = getAdminDb();
  const title = normaliseTitle(input.title);
  const [property] = await db.getAll(db.collection('properties').doc(input.propertyId), { fieldMask: ['name'] });
  if (!property.exists) return { kind: 'no-such-property' };
  const propertyName = typeof property.get('name') === 'string' && (property.get('name') as string).trim() !== '' ? (property.get('name') as string) : 'another property';
  const ref = db.collection(EARNINGS_TITLE_LINKS_COLLECTION).doc(linkIdOf(input.platform, title));
  try {
    return await db.runTransaction(async (tx): Promise<LinkResult> => {
      const [snap, ownSnap, linesSnap] = await Promise.all([
        tx.get(ref),
        tx.get(db.collection(EARNINGS_TITLE_LINKS_COLLECTION).where('propertyId', '==', input.propertyId)),
        tx.get(db.collection(EARNINGS_LINES_COLLECTION).where('listingTitle', '==', title)),
      ]);
      const stored = snap.exists ? readTitleLink(snap.id, snap.data() ?? {}) : null;
      if (snap.exists && stored === null) return { kind: 'failed' };
      if (linkState(stored) !== input.expected) return { kind: 'changed-since', propertyId: linkState(stored) };
      if (stored && stored.propertyId === input.propertyId && isActiveTitle(stored)) return { kind: 'linked', link: stored, previous: null, sentBack: 0 };

      // ── The title's lines accepted for another property (M13) ──
      const lines = linesSnap.docs.map((doc) => readEarningsLine(doc.id, doc.data())).filter((line): line is EarningsLineView => line !== null && line.platform === input.platform);
      const elsewhere = lines.filter((line) => line.decided?.status === 'accepted' && line.decided.propertyId !== input.propertyId);
      if (elsewhere.some((line) => isCopied(line.decided))) return { kind: 'copied' };
      const otherProperties = [...new Set(elsewhere.map((line) => (line.decided?.status === 'accepted' ? line.decided.propertyId : '')))];
      const reportSnaps = await Promise.all(otherProperties.map((id) => tx.get(db.collection(MONTHLY_REPORTS_COLLECTION).where('propertyId', '==', id))));
      const current = currentReports(reportSnaps.flatMap((s) => s.docs.map((doc) => readMonthlyReport(doc.id, doc.data())).filter((report): report is MonthlyReportView => report !== null)));
      const printed = printedPlatformLines(current);
      const onStatements = elsewhere.filter((line) => printed.has(line.id));
      if (onStatements.length > 0) {
        const named = [...new Map(onStatements.map((line) => printed.get(line.id)!).map((p) => [p.reportId, p])).values()];
        return { kind: 'printed', statements: named.map((p) => ({ month: p.month, reference: displayRef(current.find((report) => report.id === p.reportId) ?? { id: p.reportId, reference: '' }) })) };
      }

      // ── The property's active title, if another, becomes previous ──
      const own = ownSnap.docs.map((doc) => readTitleLink(doc.id, doc.data())).filter((link): link is TitleLinkView => link !== null);
      const was = own.find((link) => link.platform === input.platform && link.id !== ref.id && isActiveTitle(link)) ?? null;

      const now = new Date().toISOString();
      if (was) tx.update(db.collection(EARNINGS_TITLE_LINKS_COLLECTION).doc(was.id), { active: false });
      const next: TitleLink = {
        schemaVersion: EARNINGS_SCHEMA_VERSION,
        platform: input.platform,
        title,
        propertyId: input.propertyId,
        linkedAt: now,
        actor,
        history: stored ? [...stored.history, pastLink(stored)] : [],
        active: true,
      };
      tx.set(ref, next);
      for (const line of elsewhere) {
        const history = [...line.history, { at: now, actor, action: 'proposed-again' as const, reason: `Its title moved to ${propertyName}.` }];
        tx.update(db.collection(EARNINGS_LINES_COLLECTION).doc(line.id), { status: 'proposed', decided: null, history });
      }
      return { kind: 'linked', link: { id: ref.id, ...next }, previous: was?.title ?? null, sentBack: elsewhere.length };
    });
  } catch (err) {
    console.error(`[income] link ${ref.id} failed: grpc code ${grpcCode(err)}`);
    return { kind: 'failed' };
  }
}

/** What a property's edit page shows of its titles (dispatch 37C). */
export interface PropertyTitles {
  /** Its titles on each platform, active first, then previous ones newest first; each with the last month it was in a file. */
  titles: { link: TitleLinkView; lastSeen: string | null }[];
  /** Titles in the uploaded files that belong to no other property: unlinked, set aside, or one of its own previous ones. */
  candidates: { platform: IncomeChannel; title: string; months: string[]; setAside: boolean }[];
  /** Every other title with a link: a title typed that is one of these is that property's, and moves only by M13. */
  elsewhere: { platform: IncomeChannel; title: string; state: string | null; propertyName: string | null }[];
}

/** A property's titles and the titles it could take, for its edit page. null when no property has the ID. @throws if a read fails. */
export async function readPropertyTitles(propertyId: string): Promise<PropertyTitles | null> {
  const db = getAdminDb();
  const [property] = await db.getAll(db.collection('properties').doc(propertyId), { fieldMask: ['name'] });
  if (!property.exists) return null;
  const [linksSnap, uploadsSnap] = await Promise.all([db.collection(EARNINGS_TITLE_LINKS_COLLECTION).get(), db.collection(EARNINGS_UPLOADS_COLLECTION).get()]);
  const links = linksSnap.docs.map((doc) => readTitleLink(doc.id, doc.data())).filter((link): link is TitleLinkView => link !== null);
  const uploads = uploadsSnap.docs.map((doc) => readEarningsUpload(doc.id, doc.data())).filter((upload): upload is EarningsUploadView => upload !== null);
  const monthsOf = (platform: IncomeChannel, title: string) => [...new Set(uploads.filter((u) => u.platform === platform && u.titles.some((t) => normaliseTitle(t.title) === title)).map((u) => u.month))].sort();
  const mine = links.filter((link) => link.propertyId === propertyId).sort((a, b) => Number(isActiveTitle(b)) - Number(isActiveTitle(a)) || b.linkedAt.localeCompare(a.linkedAt));
  const byKey = new Map(links.map((link) => [`${link.platform}|${link.title}`, link]));
  const candidates = new Map<string, { platform: IncomeChannel; title: string; months: string[]; setAside: boolean }>();
  for (const upload of uploads) {
    for (const row of upload.titles) {
      const title = normaliseTitle(row.title);
      const key = `${upload.platform}|${title}`;
      const link = byKey.get(key) ?? null;
      const free = link === null || isSetAside(link) || (link.propertyId === propertyId && !isActiveTitle(link));
      if (!free || candidates.has(key)) continue;
      candidates.set(key, { platform: upload.platform, title, months: monthsOf(upload.platform, title), setAside: isSetAside(link) });
    }
  }
  const others = links.filter((link) => link.propertyId !== propertyId);
  const otherIds = [...new Set(others.map((link) => link.propertyId).filter((id): id is string => id !== null))];
  const otherDocs = otherIds.length > 0 ? await db.getAll(...otherIds.map((id) => db.collection('properties').doc(id)), { fieldMask: ['name'] }) : [];
  const otherNames = new Map(otherDocs.filter((doc) => doc.exists).map((doc) => [doc.id, typeof doc.get('name') === 'string' ? (doc.get('name') as string) : 'Unnamed property']));
  return {
    titles: mine.map((link) => ({ link, lastSeen: monthsOf(link.platform, link.title).at(-1) ?? null })),
    candidates: [...candidates.values()].sort((a, b) => a.title.localeCompare(b.title)),
    elsewhere: others.map((link) => ({ platform: link.platform, title: link.title, state: linkState(link), propertyName: link.propertyId ? (otherNames.get(link.propertyId) ?? null) : null })),
  };
}

// ─── Accepting ──────────────────────────────────────────────────

export interface AcceptItem {
  id: string;
  /** The label as the admin left it; absent for the proposed one. */
  description?: string;
  /** The amount as the admin left it, in cents; absent for the file's. */
  amountCents?: number;
}

export type AcceptResult =
  | { kind: 'accepted'; lines: EarningsLineView[]; statementMonth: string }
  | { kind: 'changed-since'; ids: string[] }
  | { kind: 'link-changed'; titles: string[] }
  | { kind: 'no-such-property' }
  | { kind: 'too-large'; ids: string[] }
  | { kind: 'failed' };

export const ACCEPT_REFUSALS: Record<Exclude<AcceptResult['kind'], 'accepted'>, Refusal> = {
  'changed-since': { status: 409, code: 'LINES_CHANGED', message: 'A line was decided or changed since the page loaded.', hint: 'Nothing was accepted. Reload the page.' },
  'link-changed': { status: 409, code: 'LINK_CHANGED', message: 'A title\'s link changed since the page loaded.', hint: 'Nothing was accepted. Reload the page.' },
  'no-such-property': { status: 404, code: 'PROPERTY_NOT_FOUND', message: 'That property does not exist.' },
  'too-large': { status: 422, code: 'AMOUNT_TOO_LARGE', message: 'A statement line can be at most $999,999.99 either way.', hint: 'Nothing was accepted.' },
  failed: { status: 502, code: 'ACCEPT_FAILED', message: 'Could not accept the lines.', hint: 'They may or may not have been accepted. Reload the page to see.' },
};

/**
 * Accept lines for one property and month, in one transaction (Kian's ruling M10: read where they are stored, never
 * copied into the draft): every line still proposed and in the month, every title still linked to the property on
 * the line's own platform. The decision is recorded on each line: the property, the words and amount as the admin
 * left them. The statements place it: the month's own while open, else the next open one with its date printed
 * (M11), which the answer names. A finished statement is never touched.
 */
export async function acceptLines(actor: Actor, input: { propertyId: string; month: string; items: AcceptItem[] }): Promise<AcceptResult> {
  const { propertyId, month } = input;
  // One decision per line: an ID sent twice would be a mistake.
  if (input.items.length === 0 || new Set(input.items.map((item) => item.id)).size !== input.items.length) return { kind: 'changed-since', ids: [] };
  const db = getAdminDb();
  const lineRefs = input.items.map((item) => db.collection(EARNINGS_LINES_COLLECTION).doc(item.id));
  try {
    return await db.runTransaction(async (tx): Promise<AcceptResult> => {
      const lineSnaps = await tx.getAll(...lineRefs);
      const lines = lineSnaps.map((snap) => (snap.exists ? readEarningsLine(snap.id, snap.data() ?? {}) : null));
      const changed = lineSnaps.filter((snap, i) => lines[i] === null || lines[i]!.status !== 'proposed' || lines[i]!.month !== month).map((snap) => snap.id);
      if (changed.length > 0) return { kind: 'changed-since', ids: changed };
      const ok = lines as EarningsLineView[];
      const tooLarge = ok.filter((line, i) => Math.abs(input.items[i].amountCents ?? line.amountCents) > STATEMENT_LIMITS.AMOUNT_MAX_CENTS).map((line) => line.id);
      if (tooLarge.length > 0) return { kind: 'too-large', ids: tooLarge };

      // Each line's title, on its own platform, still linked to the property.
      const keys = [...new Map(ok.map((line) => [`${line.platform}|${line.listingTitle}`, line])).values()];
      const linkSnaps = await tx.getAll(...keys.map((line) => db.collection(EARNINGS_TITLE_LINKS_COLLECTION).doc(linkIdOf(line.platform, line.listingTitle))));
      const unlinked = keys.filter((_, i) => (linkSnaps[i].exists ? readTitleLink(linkSnaps[i].id, linkSnaps[i].data() ?? {})?.propertyId : null) !== propertyId);
      if (unlinked.length > 0) return { kind: 'link-changed', titles: unlinked.map((line) => line.listingTitle) };

      const [property] = await tx.getAll(db.collection('properties').doc(propertyId), { fieldMask: ['name'] });
      if (!property.exists) return { kind: 'no-such-property' };
      const reportsSnap = await tx.get(db.collection(MONTHLY_REPORTS_COLLECTION).where('propertyId', '==', propertyId));
      const current = currentReports(reportsSnap.docs.map((doc) => readMonthlyReport(doc.id, doc.data())).filter((report): report is MonthlyReportView => report !== null));
      const statementMonth = statementMonthFor(month, new Set(current.map((report) => report.month)));

      const now = new Date().toISOString();
      const updated: EarningsLineView[] = [];
      ok.forEach((line, i) => {
        const item = input.items[i];
        const description = item.description ?? proposedLabel(line);
        const amountCents = item.amountCents ?? line.amountCents;
        const decided = { status: 'accepted' as const, at: now, actor, propertyId, description, amountCents, edited: description !== proposedLabel(line) || amountCents !== line.amountCents };
        const history = [...line.history, { at: now, actor, action: 'accepted' as const, propertyId }];
        tx.update(db.collection(EARNINGS_LINES_COLLECTION).doc(line.id), { status: 'accepted', decided, history });
        updated.push({ ...line, status: 'accepted', decided, history });
      });
      return { kind: 'accepted', lines: updated, statementMonth };
    });
  } catch (err) {
    console.error(`[income] accepting ${input.items.length} line(s) for ${propertyId} ${month} failed: grpc code ${grpcCode(err)}`);
    return { kind: 'failed' };
  }
}

// ─── An accepted line: locked once printed (M10) ───────────────

/**
 * The finished statement that locks an accepted line, if any (Kian's ruling M10): the current statement that printed
 * it, unless that statement is being corrected (a draft of its month replaces it). Read in the transaction.
 */
async function lockOf(tx: Transaction, line: EarningsLineView): Promise<{ month: string; reference: string } | null> {
  if (line.decided?.status !== 'accepted') return null;
  const db = getAdminDb();
  const reportsSnap = await tx.get(db.collection(MONTHLY_REPORTS_COLLECTION).where('propertyId', '==', line.decided.propertyId));
  const current = currentReports(reportsSnap.docs.map((doc) => readMonthlyReport(doc.id, doc.data())).filter((report): report is MonthlyReportView => report !== null));
  const printed = printedPlatformLines(current).get(line.id);
  if (!printed) return null;
  const draftSnap = await tx.get(db.collection(MONTHLY_REPORT_DRAFTS_COLLECTION).doc(draftIdOf(line.decided.propertyId, printed.month)));
  const draft = draftSnap.exists ? readStatementDraft(draftSnap.id, draftSnap.data() ?? {}) : null;
  if (draft && draft.finishedAs === null && draft.supersedes?.reportId === printed.reportId) return null;
  const report = current.find((r) => r.id === printed.reportId);
  return { month: printed.month, reference: report ? displayRef(report) : `ref ${printed.reportId.slice(0, 6)}` };
}

export type EditResult =
  | { kind: 'edited'; line: EarningsLineView }
  | { kind: 'no-such-line' }
  | { kind: 'changed-since' }
  | { kind: 'not-accepted' }
  | { kind: 'copied' }
  | { kind: 'locked'; month: string; reference: string }
  | { kind: 'too-large' }
  | { kind: 'failed' };

export const EDIT_REFUSALS: Record<Exclude<EditResult['kind'], 'edited' | 'locked'>, Refusal> = {
  'no-such-line': { status: 404, code: 'LINE_NOT_FOUND', message: 'No such line.' },
  'changed-since': { status: 409, code: 'LINES_CHANGED', message: 'This line changed since the page loaded.', hint: 'Nothing was changed. Reload the page.' },
  'not-accepted': { status: 409, code: 'LINE_NOT_ACCEPTED', message: 'Only an accepted line is edited this way.', hint: 'Nothing was changed. A proposed line is edited as it is accepted.' },
  copied: { status: 409, code: 'LINE_IN_DRAFT', message: 'This line was accepted before dispatch 37C and copied into its draft.', hint: 'Nothing was changed. Edit it on the property\'s page, as a line of the draft.' },
  'too-large': { status: 422, code: 'AMOUNT_TOO_LARGE', message: 'A statement line can be at most $999,999.99 either way.', hint: 'Nothing was changed.' },
  failed: { status: 502, code: 'EDIT_FAILED', message: 'Could not save the line.', hint: 'It may or may not have been saved. Reload the page to see.' },
};

/**
 * Edit an accepted line (Kian's ruling M10: an edit changes the line itself), as the page saw it (`seen`, its
 * history's length): its words, its amount, or both. Recorded in its history with what it said before and after
 * (I10). Refused while a finished statement that is not being corrected prints it.
 */
export async function editAcceptedLine(actor: Actor, id: string, change: { description?: string; amountCents?: number }, seen: number): Promise<EditResult> {
  const db = getAdminDb();
  const ref = db.collection(EARNINGS_LINES_COLLECTION).doc(id);
  try {
    return await db.runTransaction(async (tx): Promise<EditResult> => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { kind: 'no-such-line' };
      const line = readEarningsLine(snap.id, snap.data() ?? {});
      if (!line) return { kind: 'failed' };
      if (line.history.length !== seen) return { kind: 'changed-since' };
      if (line.status !== 'accepted' || line.decided?.status !== 'accepted') return { kind: 'not-accepted' };
      if (isCopied(line.decided)) return { kind: 'copied' };
      const amountCents = change.amountCents ?? line.decided.amountCents;
      if (Math.abs(amountCents) > STATEMENT_LIMITS.AMOUNT_MAX_CENTS) return { kind: 'too-large' };
      const lock = await lockOf(tx, line);
      if (lock) return { kind: 'locked', ...lock };
      const description = change.description ?? line.decided.description;
      if (description === line.decided.description && amountCents === line.decided.amountCents) return { kind: 'edited', line };
      const now = new Date().toISOString();
      const before = { description: line.decided.description, amountCents: line.decided.amountCents };
      const after = { description, amountCents };
      const decided = { ...line.decided, description, amountCents, edited: description !== proposedLabel(line) || amountCents !== line.amountCents };
      const history = [...line.history, { at: now, actor, action: 'edited' as const, before, after }];
      tx.update(ref, { decided, history });
      return { kind: 'edited', line: { ...line, decided, history } };
    });
  } catch (err) {
    console.error(`[income] editing line ${id} failed: grpc code ${grpcCode(err)}`);
    return { kind: 'failed' };
  }
}

/** "This line is on September 2026's statement (# Sep-321-Ann): …". */
export function lockedRefusal(lock: { month: string; reference: string }, doing: string): Refusal {
  return {
    status: 409,
    code: 'LINE_LOCKED',
    message: `This line is on ${monthLabel(lock.month)}'s finished statement (${lock.reference}), so it is locked.`,
    hint: `Nothing was ${doing}. Correct that statement on the property's page first: while it is corrected, the line can change.`,
  };
}

// ─── Rejecting, and proposing again ─────────────────────────────

export type DecideResult =
  | { kind: 'decided'; line: EarningsLineView }
  | { kind: 'no-such-line' }
  | { kind: 'changed-since'; status: string }
  | { kind: 'still-in-statement' }
  | { kind: 'set-aside' }
  | { kind: 'locked'; month: string; reference: string }
  | { kind: 'failed' };

export const DECIDE_REFUSALS: Record<Exclude<DecideResult['kind'], 'decided' | 'locked'>, Refusal> = {
  'no-such-line': { status: 404, code: 'LINE_NOT_FOUND', message: 'No such line.' },
  'changed-since': { status: 409, code: 'LINES_CHANGED', message: 'This line was decided or changed since the page loaded.', hint: 'Nothing was changed. Reload the page.' },
  'still-in-statement': { status: 409, code: 'STILL_IN_STATEMENT', message: 'This line is still in its property\'s statement.', hint: 'Nothing was changed. Remove it on the property\'s page first; then it can be proposed again.' },
  'set-aside': { status: 409, code: 'TITLE_SET_ASIDE', message: 'This line\'s title is set aside as not a Nubnb property, so its lines stay rejected.', hint: 'Nothing was changed. Link the title to a property first; then the line can be proposed again.' },
  failed: { status: 502, code: 'DECISION_FAILED', message: 'Could not record the decision.', hint: 'It may or may not have been recorded. Reload the page to see.' },
};

/**
 * Reject a proposed line, or propose a line again: one rejected; one accepted and read where it is stored, sent back
 * for review while no finished statement locks it (dispatch 37C); or one accepted before 37C whose copy has since
 * been removed from its draft. A copy still in its draft is never proposed again, so it cannot reach a statement
 * twice; nor is a line whose title is set aside as not a Nubnb property (dispatch 36), whose lines are rejected.
 */
export async function decideLine(actor: Actor, id: string, action: 'reject' | 'propose-again'): Promise<DecideResult> {
  const db = getAdminDb();
  const ref = db.collection(EARNINGS_LINES_COLLECTION).doc(id);
  try {
    return await db.runTransaction(async (tx): Promise<DecideResult> => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { kind: 'no-such-line' };
      const line = readEarningsLine(snap.id, snap.data() ?? {});
      if (!line) return { kind: 'failed' };
      const now = new Date().toISOString();
      if (action === 'reject') {
        if (line.status !== 'proposed') return { kind: 'changed-since', status: line.status };
        const decided = { status: 'rejected' as const, at: now, actor };
        const history = [...line.history, { at: now, actor, action: 'rejected' as const }];
        tx.update(ref, { status: 'rejected', decided, history });
        return { kind: 'decided', line: { ...line, status: 'rejected', decided, history } };
      }
      if (line.status === 'proposed' || line.decided === null) return { kind: 'changed-since', status: line.status };
      const linkSnap = await tx.get(db.collection(EARNINGS_TITLE_LINKS_COLLECTION).doc(linkIdOf(line.platform, line.listingTitle)));
      if (linkSnap.exists && isSetAside(readTitleLink(linkSnap.id, linkSnap.data() ?? {}))) return { kind: 'set-aside' };
      if (isCopied(line.decided)) {
        const draftSnap = await tx.get(db.collection(MONTHLY_REPORT_DRAFTS_COLLECTION).doc(line.decided.draftId));
        const draft = draftSnap.exists ? readStatementDraft(draftSnap.id, draftSnap.data() ?? {}) : null;
        if (draftSnap.exists && draft === null) return { kind: 'failed' };
        if (draft && lineInDraft(draft.lines, line.decided.lineId)) return { kind: 'still-in-statement' };
      } else if (line.decided.status === 'accepted') {
        const lock = await lockOf(tx, line);
        if (lock) return { kind: 'locked', ...lock };
      }
      const history = [...line.history, { at: now, actor, action: 'proposed-again' as const }];
      tx.update(ref, { status: 'proposed', decided: null, history });
      return { kind: 'decided', line: { ...line, status: 'proposed', decided: null, history } };
    });
  } catch (err) {
    console.error(`[income] ${action} on line ${id} failed: grpc code ${grpcCode(err)}`);
    return { kind: 'failed' };
  }
}

export type RejectAllResult = { kind: 'rejected'; lines: EarningsLineView[] } | { kind: 'changed-since'; ids: string[] } | { kind: 'failed' };

export const REJECT_ALL_REFUSALS: Record<Exclude<RejectAllResult['kind'], 'rejected'>, Refusal> = {
  'changed-since': { status: 409, code: 'LINES_CHANGED', message: 'A line was decided or changed since the page loaded.', hint: 'Nothing was rejected. Reload the page.' },
  failed: { status: 502, code: 'DECISION_FAILED', message: 'Could not reject the lines.', hint: 'They may or may not have been rejected. Reload the page to see.' },
};

/** Reject a property's proposed lines together (N2), in one transaction: every one still proposed, or nothing changes. */
export async function rejectLines(actor: Actor, ids: string[]): Promise<RejectAllResult> {
  if (ids.length === 0 || new Set(ids).size !== ids.length) return { kind: 'changed-since', ids: [] };
  const db = getAdminDb();
  const refs = ids.map((id) => db.collection(EARNINGS_LINES_COLLECTION).doc(id));
  try {
    return await db.runTransaction(async (tx): Promise<RejectAllResult> => {
      const snaps = await tx.getAll(...refs);
      const lines = snaps.map((snap) => (snap.exists ? readEarningsLine(snap.id, snap.data() ?? {}) : null));
      const changed = snaps.filter((_, i) => lines[i] === null || lines[i]!.status !== 'proposed').map((snap) => snap.id);
      if (changed.length > 0) return { kind: 'changed-since', ids: changed };
      const now = new Date().toISOString();
      const updated = (lines as EarningsLineView[]).map((line) => {
        const decided = { status: 'rejected' as const, at: now, actor };
        const history = [...line.history, { at: now, actor, action: 'rejected' as const }];
        tx.update(db.collection(EARNINGS_LINES_COLLECTION).doc(line.id), { status: 'rejected', decided, history });
        return { ...line, status: 'rejected' as const, decided, history };
      });
      return { kind: 'rejected', lines: updated };
    });
  } catch (err) {
    console.error(`[income] rejecting ${ids.length} line(s) failed: grpc code ${grpcCode(err)}`);
    return { kind: 'failed' };
  }
}

// ─── The kept file ──────────────────────────────────────────────

export type FileLinkResult = { kind: 'ok'; url: string; expiresAt: string; seconds: number } | { kind: 'no-such-upload' } | { kind: 'object-missing' };

/** A 60-second link to an upload's kept (blanked) file. The path comes from the record, never from the request. @throws if a read or the signing fails. */
export async function uploadFileLink(uploadId: string): Promise<FileLinkResult> {
  if (!isDocumentId(uploadId)) return { kind: 'no-such-upload' };
  const doc = await getAdminDb().collection(EARNINGS_UPLOADS_COLLECTION).doc(uploadId).get();
  const upload = doc.exists ? readEarningsUpload(doc.id, doc.data() ?? {}) : null;
  if (!upload || !upload.file.storagePath.startsWith(`${EARNINGS_UPLOADS_PREFIX}/${uploadId}/`) || upload.file.storagePath.includes('..')) return { kind: 'no-such-upload' };
  const file = getAdminBucket().file(upload.file.storagePath);
  const [exists] = await file.exists();
  if (!exists) return { kind: 'object-missing' };
  const expires = Date.now() + INCOME_LIMITS.FILE_LINK_SECONDS * 1000;
  const [url] = await file.getSignedUrl({ version: 'v4', action: 'read', expires, responseDisposition: `attachment; filename="${upload.file.name.replace(/"/g, '')}"` });
  return { kind: 'ok', url, expiresAt: new Date(expires).toISOString(), seconds: INCOME_LIMITS.FILE_LINK_SECONDS };
}

