/**
 * Server-side reads and writes of income from the platforms (dispatch 27):
 * the upload, the Income page's read, a title's link, and an admin's
 * decision on a line. Everything through the Admin SDK; firestore.rules'
 * catch-all denies every browser, and storage.rules denies the kept files.
 *
 * ── The upload ──
 * The file is read exactly (income/airbnb.ts). The rows paid in the month the
 * admin uploads for become `earnings_lines`, each under the SHA-256 of the
 * four fields that make it the same line (Kian's ruling): a row already
 * stored, by this file or an earlier one, is a duplicate and changes nothing.
 * Rows paid in another month are counted, never stored, so that month's own
 * file proposes them. The file is kept with its Guest and Details columns
 * blanked, create-only and private like a receipt, before anything is
 * recorded; the same file twice (by its SHA-256) is refused and nothing is
 * stored.
 *
 * ── A line becomes a statement line only when an admin accepts it ──
 * Accepting appends it to the property's draft for the line's month, in the
 * draft's own revision-checked shape: a property page open on the draft gets
 * DRAFT_CHANGED on its next save and reloads, as with a second tab. A month
 * with no draft gets one started as the property page starts one: the
 * reference and fee rate it would offer, today's date. A finished month is
 * never touched: accepting into it is refused. The accepted line is an
 * ordinary line; the earnings line records where it went.
 *
 * ── What is never done ──
 * No price, nightly rate or fee is read or computed here; no guest's name and
 * no payout destination is stored; a property document is never written.
 */

import { createHash, randomUUID } from 'crypto';
import { FieldPath } from 'firebase-admin/firestore';
import { getAdminBucket, getAdminDb } from './admin';
import { isDocumentId } from './server-leads';
import { ADMIN_ACTOR, type Refusal } from '@/app/lib/cleaners/model';
import { torontoDayOf } from '@/app/lib/costs/report';
import { addDays } from '@/app/lib/availability/days';
import { DAYS_COLLECTION, isSnapshot } from '@/app/lib/availability/store';
import { readAirbnbCsv, type AirbnbLineRow } from '@/app/lib/income/airbnb';
import {
  EARNINGS_LINES_COLLECTION,
  EARNINGS_SCHEMA_VERSION,
  EARNINGS_TITLE_LINKS_COLLECTION,
  EARNINGS_UPLOADS_COLLECTION,
  EARNINGS_UPLOADS_PREFIX,
  INCOME_LIMITS,
  draftIdOf,
  lineInDraft,
  lineKeyText,
  normaliseTitle,
  proposedLabel,
  readEarningsLine,
  readEarningsUpload,
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
  MONTHLY_REPORT_DRAFT_SCHEMA_VERSION,
  PROPERTY_MANAGEMENT_COLLECTION,
  STATEMENT_LIMITS,
  currentReports,
  isDayText,
  monthOfDay,
  monthRange,
  readMonthlyReport,
  readPropertyManagement,
  readStatementDraft,
  type Line,
  type MonthlyReportView,
  type StatementDraft,
  type StatementDraftView,
} from '@/app/lib/reports/model';
import { feeLabelFor, feeRateSuggestion, previousStatement, referenceSuggestion } from '@/app/lib/reports/statement';

const CONTROL_CHARACTER = /\p{Cc}/u;
const LINE_ID = /^[0-9a-f]{64}$/;

function grpcCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? String(code) : typeof code === 'string' ? code : 'unknown';
}

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export const lineIdOf = (platform: IncomeChannel, row: Pick<EarningsLine, 'confirmationCode' | 'payoutDate' | 'type' | 'amountCents'>) => sha256(lineKeyText(platform, row));
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
export async function uploadEarnings(input: { platform: IncomeChannel; month: string; fileName: string; bytes: Buffer; text: string }): Promise<UploadResult> {
  const { platform, month } = input;
  const read = readAirbnbCsv(input.text);
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

  // The month's rows, each under its key; a row repeated in the file itself is one line.
  const byId = new Map<string, AirbnbLineRow>();
  let repeatedInFile = 0;
  for (const row of inMonth) {
    const id = lineIdOf(platform, row);
    if (byId.has(id)) repeatedInFile += 1;
    else byId.set(id, row);
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
    read: { by: 'csv', rows: read.rows, payoutRows: read.payouts.length, lineRows: read.lines.length, amountCents: read.amountCents, paidOutCents: read.paidOutCents, balanced: read.balanced, unbalanced: read.unbalanced },
    titles: [...titles.entries()].map(([title, t]) => ({ title, rows: t.rows, amountCents: t.amountCents })).sort((a, b) => a.title.localeCompare(b.title)),
    added: 0,
    duplicates: repeatedInFile,
    outsideMonth: [...outside.entries()].map(([m, o]) => ({ month: m, rows: o.rows, amountCents: o.amountCents })).sort((a, b) => a.month.localeCompare(b.month)),
    notRead: notReadInMonth.map((row) => ({ row: row.row, type: row.type, amountCents: row.amountCents, why: row.why })),
    uploadedAt,
    actor: ADMIN_ACTOR,
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
      const next: EarningsUpload = { ...record, added: fresh.length, duplicates: repeatedInFile + (existing.length - fresh.length) };
      tx.create(uploadRef, next);
      for (const snap of fresh) {
        const row = byId.get(snap.id)!;
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
          status: 'proposed',
          decided: null,
          history: [],
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
  /** The draft's lines: what the property page's Income tab shows and the statement prints. */
  lines: Line[];
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
  /** Every property-month with a draft or a finished statement for the month. */
  statements: MonthStatement[];
  /** Check-ins in the month on the stored calendars, and which daily copies they were read from. */
  calendar: { days: string[]; checkIns: { propertyId: string; days: string[] }[] };
  /** Stored documents left out because they are not in the written shape. */
  unreadable: number;
}

/**
 * Everything the Income page shows for a month, in one answer. Read whole,
 * no limit: a failed read is an error, never an empty month.
 *
 * Reads: every upload (a few a month), the month's lines, every link, every
 * property's name, the month's drafts and finished statements, and the
 * daily calendar copies of the month and the week after it.
 *
 * @throws if any read fails.
 */
export async function readIncomeMonth(month: string): Promise<IncomeMonth> {
  const db = getAdminDb();
  const { from, to } = monthRange(month);
  const [uploadsSnap, linesSnap, linksSnap, propertiesSnap, draftsSnap, reportsSnap, daysSnap] = await Promise.all([
    db.collection(EARNINGS_UPLOADS_COLLECTION).get(),
    db.collection(EARNINGS_LINES_COLLECTION).where('month', '==', month).get(),
    db.collection(EARNINGS_TITLE_LINKS_COLLECTION).get(),
    db.collection('properties').select('name').get(),
    db.collection(MONTHLY_REPORT_DRAFTS_COLLECTION).where('month', '==', month).get(),
    db.collection(MONTHLY_REPORTS_COLLECTION).where('month', '==', month).get(),
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

  const reports: MonthlyReportView[] = [];
  for (const doc of reportsSnap.docs) {
    const report = readMonthlyReport(doc.id, doc.data());
    if (report) reports.push(report);
  }
  const current = currentReports(reports);
  const statements: MonthStatement[] = [];
  const withDraft = new Set<string>();
  for (const doc of draftsSnap.docs) {
    const draft = readStatementDraft(doc.id, doc.data());
    if (!draft) {
      unreadable += 1;
      continue;
    }
    withDraft.add(draft.propertyId);
    statements.push({ propertyId: draft.propertyId, draftId: draft.id, revision: draft.revision, finished: draft.finishedAs !== null, lines: draft.lines });
  }
  for (const report of current) {
    if (withDraft.has(report.propertyId)) continue;
    withDraft.add(report.propertyId);
    statements.push({ propertyId: report.propertyId, draftId: null, revision: null, finished: true, lines: report.lines });
  }

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

  return {
    month,
    today: torontoDayOf(new Date()),
    uploads: allUploads.filter((u) => u.month === month).sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt)),
    lines: lines.sort((a, b) => a.payoutDate.localeCompare(b.payoutDate) || a.fileRow - b.fileRow),
    links: links.sort((a, b) => a.title.localeCompare(b.title)),
    lastSeen,
    properties: propertiesSnap.docs
      .map((doc) => {
        const name: unknown = doc.get('name');
        return { id: doc.id, name: typeof name === 'string' && name.trim() !== '' ? name : 'Unnamed property' };
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
    statements,
    calendar: { days: days.sort(), checkIns: [...checkIns.entries()].map(([propertyId, set]) => ({ propertyId, days: [...set].sort() })) },
    unreadable,
  };
}

/** One property's lines from the files, for its page: those linked to it now and those decided for it. @throws if a read fails. */
export async function readPropertyIncome(propertyId: string): Promise<{ lines: EarningsLineView[]; uploads: { id: string; name: string; month: string }[] }> {
  const db = getAdminDb();
  const linksSnap = await db.collection(EARNINGS_TITLE_LINKS_COLLECTION).where('propertyId', '==', propertyId).get();
  const titles = linksSnap.docs.map((doc) => readTitleLink(doc.id, doc.data())).filter((link): link is TitleLinkView => link !== null).map((link) => link.title);
  const queries = [db.collection(EARNINGS_LINES_COLLECTION).where('decided.propertyId', '==', propertyId).get()];
  for (let i = 0; i < titles.length; i += 30) queries.push(db.collection(EARNINGS_LINES_COLLECTION).where('listingTitle', 'in', titles.slice(i, i + 30)).get());
  const snaps = await Promise.all(queries);
  const byId = new Map<string, EarningsLineView>();
  for (const snap of snaps) {
    for (const doc of snap.docs) {
      const line = readEarningsLine(doc.id, doc.data());
      if (!line) continue;
      // A line decided for another property, under a title now linked here, is not this property's.
      if (line.decided?.status === 'accepted' && line.decided.propertyId !== propertyId) continue;
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
  return { lines: [...byId.values()].sort((a, b) => a.payoutDate.localeCompare(b.payoutDate) || a.fileRow - b.fileRow), uploads };
}

// ─── A title's link ─────────────────────────────────────────────

export type LinkResult = { kind: 'linked'; link: TitleLinkView } | { kind: 'no-such-property' } | { kind: 'changed-since'; propertyId: string | null } | { kind: 'failed' };

export const LINK_REFUSALS: Record<Exclude<LinkResult['kind'], 'linked'>, Refusal> = {
  'no-such-property': { status: 404, code: 'PROPERTY_NOT_FOUND', message: 'That property does not exist.' },
  'changed-since': { status: 409, code: 'LINK_CHANGED', message: 'This title\'s link changed since the page loaded.', hint: 'Nothing was changed. Reload the page.' },
  failed: { status: 502, code: 'LINK_WRITE_FAILED', message: 'Could not save the link.', hint: 'It may or may not have been saved. Reload to see.' },
};

/**
 * Link a listing title to a property (Kian's ruling: an admin links each
 * title once, and it is remembered), or move its link. `expected` is the
 * property the page showed it linked to, or null for none: anything else
 * stored is 409 and nothing changes. Lines already accepted stay where they
 * went; lines still proposed follow the link.
 */
export async function linkTitle(input: { platform: IncomeChannel; title: string; propertyId: string; expected: string | null }): Promise<LinkResult> {
  const db = getAdminDb();
  const title = normaliseTitle(input.title);
  const [property] = await db.getAll(db.collection('properties').doc(input.propertyId), { fieldMask: ['name'] });
  if (!property.exists) return { kind: 'no-such-property' };
  const ref = db.collection(EARNINGS_TITLE_LINKS_COLLECTION).doc(linkIdOf(input.platform, title));
  try {
    return await db.runTransaction(async (tx): Promise<LinkResult> => {
      const snap = await tx.get(ref);
      const stored = snap.exists ? readTitleLink(snap.id, snap.data() ?? {}) : null;
      if (snap.exists && stored === null) return { kind: 'failed' };
      if ((stored?.propertyId ?? null) !== input.expected) return { kind: 'changed-since', propertyId: stored?.propertyId ?? null };
      if (stored && stored.propertyId === input.propertyId) return { kind: 'linked', link: stored };
      const next: TitleLink = {
        schemaVersion: EARNINGS_SCHEMA_VERSION,
        platform: input.platform,
        title,
        propertyId: input.propertyId,
        linkedAt: new Date().toISOString(),
        actor: ADMIN_ACTOR,
        history: stored ? [...stored.history, { propertyId: stored.propertyId, linkedAt: stored.linkedAt, actor: stored.actor }] : [],
      };
      tx.set(ref, next);
      return { kind: 'linked', link: { id: ref.id, ...next } };
    });
  } catch (err) {
    console.error(`[income] link ${ref.id} failed: grpc code ${grpcCode(err)}`);
    return { kind: 'failed' };
  }
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
  | { kind: 'accepted'; draft: StatementDraftView; lines: EarningsLineView[] }
  | { kind: 'changed-since'; ids: string[] }
  | { kind: 'link-changed'; titles: string[] }
  | { kind: 'no-such-property' }
  | { kind: 'finished' }
  | { kind: 'draft-unreadable' }
  | { kind: 'full' }
  | { kind: 'too-large'; ids: string[] }
  | { kind: 'failed' };

export const ACCEPT_REFUSALS: Record<Exclude<AcceptResult['kind'], 'accepted'>, Refusal> = {
  'changed-since': { status: 409, code: 'LINES_CHANGED', message: 'A line was decided or changed since the page loaded.', hint: 'Nothing was accepted. Reload the page.' },
  'link-changed': { status: 409, code: 'LINK_CHANGED', message: 'A title\'s link changed since the page loaded.', hint: 'Nothing was accepted. Reload the page.' },
  'no-such-property': { status: 404, code: 'PROPERTY_NOT_FOUND', message: 'That property does not exist.' },
  finished: { status: 409, code: 'STATEMENT_FINISHED', message: 'This month\'s statement for the property is finished, and a finished statement is never touched.', hint: 'Nothing was accepted. Correct or delete the statement on the property\'s page first.' },
  'draft-unreadable': { status: 409, code: 'DRAFT_UNREADABLE', message: 'This month\'s draft is not in a shape this page can add to.', hint: 'Nothing was accepted. Open the property\'s page to see it.' },
  full: { status: 422, code: 'STATEMENT_FULL', message: `A statement holds at most ${STATEMENT_LIMITS.LINES_MAX} lines.`, hint: 'Nothing was accepted.' },
  'too-large': { status: 422, code: 'AMOUNT_TOO_LARGE', message: 'A statement line can be at most $999,999.99 either way.', hint: 'Nothing was accepted.' },
  failed: { status: 502, code: 'ACCEPT_FAILED', message: 'Could not accept the lines.', hint: 'They may or may not have been accepted. Reload the page to see.' },
};

/** The description as it will be stored on the statement line: NFC, spaces collapsed, 1–160 characters, no control characters. Null when it cannot be. */
export function cleanDescription(text: string): string | null {
  const description = text.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (description === '' || description.length > STATEMENT_LIMITS.LINE_DESCRIPTION_MAX || CONTROL_CHARACTER.test(description)) return null;
  return description;
}

/**
 * Accept lines into one property's draft for one month, in one transaction:
 * every line still proposed and in the month, every title still linked to
 * the property, the month not finished. The new statement lines go after
 * the draft's own, in payout order, each "description, quantity 1, rate =
 * amount", as the property page writes a line.
 */
export async function acceptLines(input: { propertyId: string; month: string; items: AcceptItem[] }): Promise<AcceptResult> {
  const { propertyId, month } = input;
  // One statement line per earnings line: an ID sent twice would print twice.
  if (input.items.length === 0 || new Set(input.items.map((item) => item.id)).size !== input.items.length) return { kind: 'changed-since', ids: [] };
  const db = getAdminDb();
  const lineRefs = input.items.map((item) => db.collection(EARNINGS_LINES_COLLECTION).doc(item.id));
  const draftRef = db.collection(MONTHLY_REPORT_DRAFTS_COLLECTION).doc(draftIdOf(propertyId, month));
  try {
    return await db.runTransaction(async (tx): Promise<AcceptResult> => {
      const lineSnaps = await tx.getAll(...lineRefs);
      const lines = lineSnaps.map((snap) => (snap.exists ? readEarningsLine(snap.id, snap.data() ?? {}) : null));
      const changed = lineSnaps.filter((snap, i) => lines[i] === null || lines[i]!.status !== 'proposed' || lines[i]!.month !== month).map((snap) => snap.id);
      if (changed.length > 0) return { kind: 'changed-since', ids: changed };
      const ok = lines as EarningsLineView[];
      const tooLarge = ok.filter((line, i) => Math.abs(input.items[i].amountCents ?? line.amountCents) > STATEMENT_LIMITS.AMOUNT_MAX_CENTS).map((line) => line.id);
      if (tooLarge.length > 0) return { kind: 'too-large', ids: tooLarge };

      const titles = [...new Set(ok.map((line) => line.listingTitle))];
      const linkSnaps = await tx.getAll(...titles.map((title) => db.collection(EARNINGS_TITLE_LINKS_COLLECTION).doc(linkIdOf(ok[0].platform, title))));
      const unlinked = linkSnaps.filter((snap) => (snap.exists ? readTitleLink(snap.id, snap.data() ?? {})?.propertyId : null) !== propertyId);
      if (unlinked.length > 0) return { kind: 'link-changed', titles: unlinked.map((snap) => titles[linkSnaps.indexOf(snap)]) };

      const [property] = await tx.getAll(db.collection('properties').doc(propertyId), { fieldMask: ['name'] });
      if (!property.exists) return { kind: 'no-such-property' };
      const [draftSnap, reportsSnap, managementSnap] = await Promise.all([
        tx.get(draftRef),
        tx.get(db.collection(MONTHLY_REPORTS_COLLECTION).where('propertyId', '==', propertyId)),
        tx.get(db.collection(PROPERTY_MANAGEMENT_COLLECTION).doc(propertyId)),
      ]);
      const stored = draftSnap.exists ? readStatementDraft(draftSnap.id, draftSnap.data() ?? {}) : null;
      if (draftSnap.exists && stored === null) return { kind: 'draft-unreadable' };
      const reports = reportsSnap.docs.map((doc) => readMonthlyReport(doc.id, doc.data())).filter((report): report is MonthlyReportView => report !== null);
      // Finished: the draft was finished, or (no draft) the month has a current statement — the property page's own test.
      const finished = stored ? stored.finishedAs !== null : currentReports(reports).some((report) => report.month === month);
      if (finished) return { kind: 'finished' };
      if ((stored?.lines.length ?? 0) + ok.length > STATEMENT_LIMITS.LINES_MAX) return { kind: 'full' };

      const now = new Date().toISOString();
      const today = torontoDayOf(new Date());
      const ordered = ok.map((line, i) => ({ line, item: input.items[i] })).sort((a, b) => a.line.payoutDate.localeCompare(b.line.payoutDate) || a.line.fileRow - b.line.fileRow);
      const added = ordered.map(({ line, item }) => {
        const description = item.description ?? proposedLabel(line);
        const amountCents = item.amountCents ?? line.amountCents;
        const statementLine: Line = { id: randomUUID(), description, from: null, to: null, quantity: 1, rateCents: amountCents, amountCents };
        return { line, statementLine, edited: description !== proposedLabel(line) || amountCents !== line.amountCents };
      });

      let next: StatementDraft;
      if (stored) {
        next = {
          schemaVersion: MONTHLY_REPORT_DRAFT_SCHEMA_VERSION,
          propertyId,
          month,
          reference: stored.reference,
          reportDate: isDayText(stored.reportDate) ? stored.reportDate : today,
          lines: [...stored.lines, ...added.map((a) => a.statementLine)],
          fee: stored.fee,
          carried: stored.carried,
          notes: stored.notes,
          supersedes: stored.supersedes,
          revision: stored.revision + 1,
          createdAt: stored.createdAt,
          updatedAt: now,
          finishedAs: null,
          finishedRevision: null,
        };
      } else {
        // A month with nothing stored starts as the property page starts it (statement-form.ts, suggestedTyped).
        const management = managementSnap.exists ? readPropertyManagement(managementSnap.id, managementSnap.data() ?? {}) : null;
        const previous = previousStatement(reports, month);
        const rate = feeRateSuggestion(previous, management);
        next = {
          schemaVersion: MONTHLY_REPORT_DRAFT_SCHEMA_VERSION,
          propertyId,
          month,
          reference: referenceSuggestion(previous, month) ?? '',
          reportDate: today,
          lines: added.map((a) => a.statementLine),
          fee: rate === null ? null : { label: feeLabelFor(rate, null), rateBasisPoints: rate, baseCents: null, computedCents: null, amountCents: 0, overwritten: false },
          carried: null,
          notes: null,
          supersedes: null,
          revision: 1,
          createdAt: now,
          updatedAt: now,
          finishedAs: null,
          finishedRevision: null,
        };
      }
      if (stored) tx.set(draftRef, next);
      else tx.create(draftRef, next);

      const updated: EarningsLineView[] = [];
      for (const { line, statementLine, edited } of added) {
        const decided = { status: 'accepted' as const, at: now, actor: ADMIN_ACTOR, propertyId, draftId: draftRef.id, lineId: statementLine.id, description: statementLine.description, amountCents: statementLine.amountCents, edited };
        const history = [...line.history, { at: now, actor: ADMIN_ACTOR, action: 'accepted' as const, propertyId }];
        tx.update(db.collection(EARNINGS_LINES_COLLECTION).doc(line.id), { status: 'accepted', decided, history });
        updated.push({ ...line, status: 'accepted', decided, history });
      }
      return { kind: 'accepted', draft: { id: draftRef.id, ...next }, lines: updated };
    });
  } catch (err) {
    console.error(`[income] accepting ${input.items.length} line(s) into ${draftRef.id} failed: grpc code ${grpcCode(err)}`);
    return { kind: 'failed' };
  }
}

// ─── Rejecting, and proposing again ─────────────────────────────

export type DecideResult = { kind: 'decided'; line: EarningsLineView } | { kind: 'no-such-line' } | { kind: 'changed-since'; status: string } | { kind: 'still-in-statement' } | { kind: 'failed' };

export const DECIDE_REFUSALS: Record<Exclude<DecideResult['kind'], 'decided'>, Refusal> = {
  'no-such-line': { status: 404, code: 'LINE_NOT_FOUND', message: 'No such line.' },
  'changed-since': { status: 409, code: 'LINES_CHANGED', message: 'This line was decided or changed since the page loaded.', hint: 'Nothing was changed. Reload the page.' },
  'still-in-statement': { status: 409, code: 'STILL_IN_STATEMENT', message: 'This line is still in its property\'s statement.', hint: 'Nothing was changed. Remove it on the property\'s page first; then it can be proposed again.' },
  failed: { status: 502, code: 'DECISION_FAILED', message: 'Could not record the decision.', hint: 'It may or may not have been recorded. Reload the page to see.' },
};

/**
 * Reject a proposed line, or propose a line again: one rejected, or one
 * accepted whose statement line has since been removed from its draft. A
 * line still in its draft is never proposed again, so it cannot reach a
 * statement twice.
 */
export async function decideLine(id: string, action: 'reject' | 'propose-again'): Promise<DecideResult> {
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
        const decided = { status: 'rejected' as const, at: now, actor: ADMIN_ACTOR };
        const history = [...line.history, { at: now, actor: ADMIN_ACTOR, action: 'rejected' as const }];
        tx.update(ref, { status: 'rejected', decided, history });
        return { kind: 'decided', line: { ...line, status: 'rejected', decided, history } };
      }
      if (line.status === 'proposed' || line.decided === null) return { kind: 'changed-since', status: line.status };
      if (line.decided.status === 'accepted') {
        const draftSnap = await tx.get(db.collection(MONTHLY_REPORT_DRAFTS_COLLECTION).doc(line.decided.draftId));
        const draft = draftSnap.exists ? readStatementDraft(draftSnap.id, draftSnap.data() ?? {}) : null;
        if (draftSnap.exists && draft === null) return { kind: 'failed' };
        if (draft && lineInDraft(draft.lines, line.decided.lineId)) return { kind: 'still-in-statement' };
      }
      const history = [...line.history, { at: now, actor: ADMIN_ACTOR, action: 'proposed-again' as const }];
      tx.update(ref, { status: 'proposed', decided: null, history });
      return { kind: 'decided', line: { ...line, status: 'proposed', decided: null, history } };
    });
  } catch (err) {
    console.error(`[income] ${action} on line ${id} failed: grpc code ${grpcCode(err)}`);
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

