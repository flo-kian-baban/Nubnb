/**
 * Income from the platforms (dispatch 27): an admin uploads a platform's
 * earnings file for a month on the Income page; each row a line can come
 * from is kept, proposed under the property its listing title is linked to,
 * and accepted (as it is, or edited) into that property's statement draft,
 * or rejected. Client-safe: no server imports.
 *
 * Three root collections and one Storage prefix, all server-only:
 * firestore.rules' catch-all and storage.rules deny every browser.
 *   earnings_uploads/{autoId}            one per file uploaded: what it was,
 *                                        what was read, what it added
 *   earnings_lines/{sha256 of the key}   one per row a line can come from;
 *                                        the ID is the duplicate rule
 *   earnings_title_links/{sha256}        a listing title, linked by an admin
 *                                        to one property
 *   earnings-uploads/<uploadId>/<uuid>.csv   the file as uploaded, with the
 *                                        Guest and Details columns blanked
 *
 * ── Kian's rulings (2026-10-04) ──
 * - The reading proposes; an admin confirms. Nothing reaches an owner's
 *   statement until an admin accepts it. A finished statement is never
 *   touched.
 * - Income belongs to the month the platform paid it out: the row's Date,
 *   Toronto calendar. Not the stay's start.
 * - The amount on a line is what the platform paid (Airbnb's Amount column).
 *   Gross, service fee and cleaning fee are stored as evidence, never printed.
 * - A reservation reads "Revenue - Sep 9–13, 2026". A line whose stay runs
 *   outside the upload's month shows its payout date: "Revenue - Apr 29–Dec
 *   31, 2026 (paid Sep 30)". Adjustment, Resolution Adjustment and Resolution
 *   Payout are their own lines, signed, labelled with their type and the
 *   stay's dates.
 * - Payout rows are never lines: they only check that the file adds up, and
 *   the destination in their Details is never stored.
 * - Each listing title is linked to one property by an admin, once, and
 *   remembered. An unlinked title is listed with its rows and total, never
 *   dropped; a linked title missing from a month's file is shown.
 * - A booking's confirmation code is not unique (instalments share it): a
 *   line is the same line only if confirmation code, payout date, type and
 *   amount all match.
 * - Stored: dates, amount, type, confirmation code, listing title, the file
 *   it came from. Never the guest's name, never a payout destination. The
 *   remitted tax is stored per row for a later tax rule; it is not a line.
 * - The uploaded CSV is kept with its Guest and Details columns blanked, with
 *   the original file's SHA-256. CSV only: no PDF, image or AI path.
 *
 * ── Readers ──
 * These collections are written only by this code, so a document is read
 * strictly: one not in a written shape is left out and counted, never
 * guessed at.
 */

import type { Actor } from '@/app/lib/cleaners/model';
import { monthRange, rangeText, type Line } from '@/app/lib/reports/model';

export const EARNINGS_UPLOADS_COLLECTION = 'earnings_uploads';
export const EARNINGS_LINES_COLLECTION = 'earnings_lines';
export const EARNINGS_TITLE_LINKS_COLLECTION = 'earnings_title_links';
/** Storage prefix of the kept files. Readers use the stored path and never rebuild it. */
export const EARNINGS_UPLOADS_PREFIX = 'earnings-uploads';
export const EARNINGS_SCHEMA_VERSION = 1;

/**
 * The upload types the Income page offers. One today; another channel is
 * another entry here and another reader beside airbnb.ts.
 */
export const INCOME_CHANNELS = ['airbnb'] as const;
export type IncomeChannel = (typeof INCOME_CHANNELS)[number];
export const INCOME_CHANNEL_LABELS: Record<IncomeChannel, string> = { airbnb: 'Airbnb' };
export function isIncomeChannel(value: unknown): value is IncomeChannel {
  return typeof value === 'string' && (INCOME_CHANNELS as readonly string[]).includes(value);
}

export const INCOME_LIMITS = {
  /** A month's Airbnb CSV for Nubnb is about 11 KB; this is far beyond any real one. */
  FILE_MAX_BYTES: 2 * 1024 * 1024,
  /** The line rows one upload may write: everything an upload writes goes in one Firestore transaction (500 writes at most). */
  LINES_PER_UPLOAD_MAX: 400,
  FILE_NAME_MAX: 120,
  TITLE_MAX: 300,
  /** How long a link to a kept file works. */
  FILE_LINK_SECONDS: 60,
} as const;

// ─── Shapes ─────────────────────────────────────────────────────

/** A stay as the file gives it: the check-in day and the checkout day, yyyy-mm-dd, and its nights. */
export interface Stay {
  start: string | null;
  end: string | null;
  nights: number | null;
}

export type EarningsStatus = 'proposed' | 'accepted' | 'rejected';

/** An admin's decision on a line. Accepted: where it went and what it said, which may differ from the file's (edited). */
export type Decision =
  | {
      status: 'accepted';
      at: string;
      actor: Actor;
      propertyId: string;
      /** monthly_report_drafts/{propertyId}_{month} */
      draftId: string;
      /** The id of the line it became in that draft. */
      lineId: string;
      description: string;
      amountCents: number;
      edited: boolean;
    }
  | { status: 'rejected'; at: string; actor: Actor };

/** One step in a line's life, oldest first: accepted, rejected, or proposed again. */
export interface EarningsHistoryEvent {
  at: string;
  actor: Actor;
  action: 'accepted' | 'rejected' | 'proposed-again';
  /** On "accepted": the property it went to. */
  propertyId?: string;
}

/** `earnings_lines/{id}`: one row a line can come from. */
export interface EarningsLine {
  schemaVersion: number;
  platform: IncomeChannel;
  /** The upload that brought it; an identical row in a later file is a duplicate and changes nothing. */
  uploadId: string;
  /** The row in that file as a spreadsheet numbers it: the header is row 1. */
  fileRow: number;
  /** The day the platform paid it, yyyy-mm-dd. */
  payoutDate: string;
  /** The month it belongs to: the payout date's (Kian's ruling). */
  month: string;
  /** The platform's word: Reservation, Adjustment, Resolution Adjustment, Resolution Payout. */
  type: string;
  confirmationCode: string;
  /** Trimmed, spaces collapsed: the key its link is found by. */
  listingTitle: string;
  stay: Stay;
  /** What the platform paid, either sign. Never zero. */
  amountCents: number;
  currency: string;
  /** Kept, never printed. Null where the file has no value. */
  evidence: { grossCents: number | null; serviceFeeCents: number | null; cleaningFeeCents: number | null };
  /** The tax the platform remitted, per row, for a later tax rule. Not a line. */
  remittedTaxCents: number | null;
  status: EarningsStatus;
  decided: Decision | null;
  history: EarningsHistoryEvent[];
}

/** `earnings_uploads/{id}`: one file uploaded for a month. */
export interface EarningsUpload {
  schemaVersion: number;
  platform: IncomeChannel;
  month: string;
  file: {
    /** The browser's file name, sanitised. */
    name: string;
    kind: 'csv';
    /** The file as received. */
    bytes: number;
    sha256: string;
    /** The copy kept: the same rows with the `blanked` columns emptied. */
    storagePath: string;
    storedBytes: number;
    storedSha256: string;
    blanked: string[];
  };
  read: {
    by: 'csv';
    /** Data rows in the file. */
    rows: number;
    payoutRows: number;
    /** Rows of a type that becomes a line, in any month. */
    lineRows: number;
    /** Every non-payout row's amount, added up. */
    amountCents: number;
    /** Every payout row's amount, added up. */
    paidOutCents: number;
    /** Every payout equals the rows under it, every row is under a payout, and the two totals are equal. */
    balanced: boolean;
    /** The payouts that do not equal their rows; rows under no payout show as payout row 0. */
    unbalanced: { row: number; paidOutCents: number; rowsCents: number }[];
  };
  /** The listing titles of this month's rows, with their rows and total, whether new or duplicates. */
  titles: { title: string; rows: number; amountCents: number }[];
  /** This month's rows stored as new lines, and those already stored by an earlier file. */
  added: number;
  duplicates: number;
  /** Rows paid in another month: counted, never stored, so that month's own file proposes them. */
  outsideMonth: { month: string; rows: number; amountCents: number }[];
  /** Rows the reader does not turn into lines, and why: a type it does not read, no amount, another currency. */
  notRead: { row: number; type: string; amountCents: number; why: string }[];
  uploadedAt: string;
  actor: Actor;
}

/** `earnings_title_links/{sha256(platform|title)}`: a listing title an admin linked to one property. */
export interface TitleLink {
  schemaVersion: number;
  platform: IncomeChannel;
  title: string;
  propertyId: string;
  linkedAt: string;
  actor: Actor;
  /** The links it had before, oldest first. */
  history: { propertyId: string; linkedAt: string; actor: Actor }[];
}

export interface EarningsLineView extends EarningsLine {
  id: string;
}
export interface EarningsUploadView extends EarningsUpload {
  id: string;
}
export interface TitleLinkView extends TitleLink {
  id: string;
}

// ─── The words ──────────────────────────────────────────────────

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "Sep 30": a day without its year, as "(paid Sep 30)" prints it. */
export function shortDay(day: string): string {
  const match = DAY.exec(day);
  return match ? `${MONTHS_SHORT[Number(match[2]) - 1]} ${Number(match[3])}` : day;
}

/** Whether a stay runs outside `month`: either of its printed days falls before or after it. */
export function stayOutsideMonth(stay: Stay, month: string): boolean {
  const { from, to } = monthRange(month);
  return (stay.start !== null && stay.start < from) || (stay.end !== null && stay.end > to);
}

/**
 * The line a row proposes (Kian's ruling): "Revenue - Sep 9–13, 2026" for a
 * reservation, the type itself for the others ("Resolution Payout - Aug
 * 21–23, 2026"), and "(paid Sep 30)" after a stay that runs outside the
 * line's month. The whole label is the line's description: the statement
 * prints a description and then its dates, and the payout date comes after
 * the dates.
 */
export function proposedLabel(line: Pick<EarningsLine, 'type' | 'stay' | 'payoutDate' | 'month'>): string {
  const word = line.type === 'Reservation' ? 'Revenue' : line.type;
  const range = rangeText(line.stay.start, line.stay.end);
  const paid = stayOutsideMonth(line.stay, line.month) ? ` (paid ${shortDay(line.payoutDate)})` : '';
  return range ? `${word} - ${range}${paid}` : `${word} (paid ${shortDay(line.payoutDate)})`;
}

/** A listing title as it is keyed: NFC, spaces collapsed, trimmed. The file had two titles ending in a space. */
export function normaliseTitle(title: string): string {
  return title.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** The text a line's ID is the SHA-256 of: the four fields that make it the same line, and the platform. */
export function lineKeyText(platform: IncomeChannel, line: Pick<EarningsLine, 'confirmationCode' | 'payoutDate' | 'type' | 'amountCents'>): string {
  return [platform, line.confirmationCode, line.payoutDate, line.type, String(line.amountCents)].join('|');
}

/** The text a title link's ID is the SHA-256 of. */
export function titleKeyText(platform: IncomeChannel, title: string): string {
  return `${platform}|${normaliseTitle(title)}`;
}

/** The statement draft's ID for a property and month, as server-reports.ts writes it. */
export function draftIdOf(propertyId: string, month: string): string {
  return `${propertyId}_${month}`;
}

/** The lines an accepted earnings line can be found among: a draft's lines, by id. */
export function lineInDraft(lines: Pick<Line, 'id'>[], lineId: string): boolean {
  return lines.some((line) => line.id === lineId);
}

// ─── Reading strictly ───────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isCents = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);
const isCentsOrNull = (value: unknown): value is number | null => value === null || isCents(value);
const isText = (value: unknown): value is string => typeof value === 'string';
const isDay = (value: unknown): value is string => typeof value === 'string' && DAY.test(value);
const isDayOrNull = (value: unknown): value is string | null => value === null || isDay(value);
const isMonthText = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
const isActor = (value: unknown): value is Actor => isRecord(value) && isText(value.role) && (value.id === null || isText(value.id)) && (value.name === null || isText(value.name));
const isStatus = (value: unknown): value is EarningsStatus => value === 'proposed' || value === 'accepted' || value === 'rejected';

function readDecision(value: unknown): Decision | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !isText(value.at) || !isActor(value.actor)) return undefined;
  if (value.status === 'rejected') return { status: 'rejected', at: value.at, actor: value.actor };
  if (value.status !== 'accepted') return undefined;
  const { propertyId, draftId, lineId, description, amountCents, edited } = value;
  if (!isText(propertyId) || !isText(draftId) || !isText(lineId) || !isText(description) || !isCents(amountCents) || typeof edited !== 'boolean') return undefined;
  return { status: 'accepted', at: value.at, actor: value.actor, propertyId, draftId, lineId, description, amountCents, edited };
}

function readHistory(value: unknown): EarningsHistoryEvent[] | null {
  if (!Array.isArray(value)) return null;
  const events: EarningsHistoryEvent[] = [];
  for (const item of value) {
    if (!isRecord(item) || !isText(item.at) || !isActor(item.actor)) return null;
    if (item.action !== 'accepted' && item.action !== 'rejected' && item.action !== 'proposed-again') return null;
    const event: EarningsHistoryEvent = { at: item.at, actor: item.actor, action: item.action };
    if ('propertyId' in item) {
      if (!isText(item.propertyId)) return null;
      event.propertyId = item.propertyId;
    }
    events.push(event);
  }
  return events;
}

export function readEarningsLine(id: string, fields: Record<string, unknown>): EarningsLineView | null {
  const { schemaVersion, platform, uploadId, fileRow, payoutDate, month, type, confirmationCode, listingTitle, stay, amountCents, currency, evidence, remittedTaxCents, status } = fields;
  if (!isCents(schemaVersion) || !isIncomeChannel(platform) || !isText(uploadId) || !isCents(fileRow) || !isDay(payoutDate) || !isMonthText(month)) return null;
  if (!isText(type) || !isText(confirmationCode) || !isText(listingTitle) || !isCents(amountCents) || !isText(currency) || !isCentsOrNull(remittedTaxCents) || !isStatus(status)) return null;
  if (!isRecord(stay) || !isDayOrNull(stay.start) || !isDayOrNull(stay.end) || !isCentsOrNull(stay.nights)) return null;
  if (!isRecord(evidence) || !isCentsOrNull(evidence.grossCents) || !isCentsOrNull(evidence.serviceFeeCents) || !isCentsOrNull(evidence.cleaningFeeCents)) return null;
  const decided = readDecision(fields.decided);
  const history = readHistory(fields.history);
  if (decided === undefined || history === null) return null;
  if ((status === 'proposed') !== (decided === null) || (decided !== null && decided.status !== status)) return null;
  return {
    id,
    schemaVersion,
    platform,
    uploadId,
    fileRow,
    payoutDate,
    month,
    type,
    confirmationCode,
    listingTitle,
    stay: { start: stay.start, end: stay.end, nights: stay.nights },
    amountCents,
    currency,
    evidence: { grossCents: evidence.grossCents, serviceFeeCents: evidence.serviceFeeCents, cleaningFeeCents: evidence.cleaningFeeCents },
    remittedTaxCents,
    status,
    decided,
    history,
  };
}

export function readEarningsUpload(id: string, fields: Record<string, unknown>): EarningsUploadView | null {
  const { schemaVersion, platform, month, file, read, titles, added, duplicates, outsideMonth, notRead, uploadedAt, actor } = fields;
  if (!isCents(schemaVersion) || !isIncomeChannel(platform) || !isMonthText(month) || !isText(uploadedAt) || !isActor(actor) || !isCents(added) || !isCents(duplicates)) return null;
  if (!isRecord(file) || !isText(file.name) || file.kind !== 'csv' || !isCents(file.bytes) || !isText(file.sha256) || !isText(file.storagePath) || !isCents(file.storedBytes) || !isText(file.storedSha256)) return null;
  if (!Array.isArray(file.blanked) || !file.blanked.every(isText)) return null;
  if (!isRecord(read) || read.by !== 'csv' || !isCents(read.rows) || !isCents(read.payoutRows) || !isCents(read.lineRows) || !isCents(read.amountCents) || !isCents(read.paidOutCents) || typeof read.balanced !== 'boolean') return null;
  if (!Array.isArray(read.unbalanced) || !read.unbalanced.every((u) => isRecord(u) && isCents(u.row) && isCents(u.paidOutCents) && isCents(u.rowsCents))) return null;
  if (!Array.isArray(titles) || !titles.every((t) => isRecord(t) && isText(t.title) && isCents(t.rows) && isCents(t.amountCents))) return null;
  if (!Array.isArray(outsideMonth) || !outsideMonth.every((o) => isRecord(o) && isMonthText(o.month) && isCents(o.rows) && isCents(o.amountCents))) return null;
  if (!Array.isArray(notRead) || !notRead.every((n) => isRecord(n) && isCents(n.row) && isText(n.type) && isCents(n.amountCents) && isText(n.why))) return null;
  return {
    id,
    schemaVersion,
    platform,
    month,
    file: {
      name: file.name,
      kind: 'csv',
      bytes: file.bytes,
      sha256: file.sha256,
      storagePath: file.storagePath,
      storedBytes: file.storedBytes,
      storedSha256: file.storedSha256,
      blanked: file.blanked as string[],
    },
    read: {
      by: 'csv',
      rows: read.rows,
      payoutRows: read.payoutRows,
      lineRows: read.lineRows,
      amountCents: read.amountCents,
      paidOutCents: read.paidOutCents,
      balanced: read.balanced,
      unbalanced: (read.unbalanced as Record<string, number>[]).map((u) => ({ row: u.row, paidOutCents: u.paidOutCents, rowsCents: u.rowsCents })),
    },
    titles: (titles as Record<string, unknown>[]).map((t) => ({ title: t.title as string, rows: t.rows as number, amountCents: t.amountCents as number })),
    added,
    duplicates,
    outsideMonth: (outsideMonth as Record<string, unknown>[]).map((o) => ({ month: o.month as string, rows: o.rows as number, amountCents: o.amountCents as number })),
    notRead: (notRead as Record<string, unknown>[]).map((n) => ({ row: n.row as number, type: n.type as string, amountCents: n.amountCents as number, why: n.why as string })),
    uploadedAt,
    actor,
  };
}

export function readTitleLink(id: string, fields: Record<string, unknown>): TitleLinkView | null {
  const { schemaVersion, platform, title, propertyId, linkedAt, actor, history } = fields;
  if (!isCents(schemaVersion) || !isIncomeChannel(platform) || !isText(title) || !isText(propertyId) || !isText(linkedAt) || !isActor(actor)) return null;
  if (!Array.isArray(history) || !history.every((h) => isRecord(h) && isText(h.propertyId) && isText(h.linkedAt) && isActor(h.actor))) return null;
  return {
    id,
    schemaVersion,
    platform,
    title,
    propertyId,
    linkedAt,
    actor,
    history: (history as Record<string, unknown>[]).map((h) => ({ propertyId: h.propertyId as string, linkedAt: h.linkedAt as string, actor: h.actor as Actor })),
  };
}
