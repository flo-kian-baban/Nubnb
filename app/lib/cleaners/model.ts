/**
 * Cleaner cost logging: the names, limits and shapes every side shares.
 *
 * Client-safe: no server imports. The server data layer writes documents in
 * these shapes and builds API responses with the readers below; the admin
 * pages render those responses. Both sides read a stored document the same
 * way.
 *
 * Three root collections and one Storage prefix, all server-only:
 *   cleaners/{cleanerId}             a cleaner: name, status, current code,
 *                                    session epoch
 *   cleaner_codes/{code}             one issued code, keyed by the code
 *                                    itself: the index that keeps codes
 *                                    unique, kept for ever so that a replaced
 *                                    code is never issued again
 *   cost_entries/{entryId}           one receipt's lines, attributed to a
 *                                    cleaner and a property
 *   receipts/<entryId>/<uuid>.<ext>  the receipt image, with no public URL
 *
 * Codes are stored readably, by Kian's ruling of 2026-09-28: an admin can
 * read and change them at any time. Schema version 1 of `cleaners` and
 * `cleaner_codes` stored a keyed digest instead (`codeDigest`, and the
 * digest as the code document's ID); documents in that shape are read as
 * "no code on record" and never open the cleaner door.
 *
 * There are no backfills, so every document keeps the shape it was written
 * with for ever and readers must handle every shape ever written. The
 * readers here are defensive: a field that is not on the document is
 * reported as absent (null), never filled in, and a value this module does
 * not expect is passed through as stored, so that it can be shown.
 *
 * Money is integer cents. `lineTotalCents` is the amount printed on the
 * receipt line; quantity is informational and never multiplied. No total is
 * stored. Nothing here computes, adjusts or corrects an amount — formatCents
 * only writes one out, and readLinesNow only adds up what is stored.
 *
 * ── Review (dispatch 19) ──
 * An entry's `lines` stay exactly as the cleaner sent them. When an admin
 * corrects a line or adds one, the change is a history event that carries
 * the line before and after, and the lines that count are the sent lines
 * with those events applied in order (readLinesNow). So the cleaner's own
 * claim is never overwritten, every earlier version stays readable, and an
 * entry nobody corrected reads exactly as it was written.
 *
 * ── After approval (Kian's ruling of 2026-09-30) ──
 * An approved entry stays correctable and removable: the same events, on the
 * same history, whatever its status. An approved entry may already be in a
 * PDF a co-owner holds, so each PDF exported is recorded in
 * `cost_report_exports` with, for every entry in it, the length of that
 * entry's history and the amounts the PDF printed. The ledger compares those
 * with the entry as it now stands (costs/report.ts) and says when a PDF that
 * went out no longer matches.
 */

// ─── Collections ───────────────────────────────────────────────
// Permanent: renaming one would mean moving documents, which is a backfill.

export const CLEANERS_COLLECTION = 'cleaners';
export const CLEANER_CODES_COLLECTION = 'cleaner_codes';
export const COST_ENTRIES_COLLECTION = 'cost_entries';

/**
 * One document per receipt a cleaner has sent, keyed by the cleaner and the
 * one-time key their phone gave that receipt: `<cleanerId>_<submissionKey>`.
 * Written in the same transaction as the entry it names, so sending the same
 * receipt again — after a dropped connection hid the answer — finds it and
 * writes nothing.
 */
export const COST_ENTRY_SUBMISSIONS_COLLECTION = 'cost_entry_submissions';

/**
 * One document per PDF report an admin exported: the property, the period,
 * and for each entry in it how long that entry's history was and what the
 * PDF printed for it. A PDF goes to a property's co-owners, and by Kian's
 * ruling of 2026-09-30 an approved entry can still be corrected or removed
 * afterwards, and the ledger must then show that the PDF no longer matches;
 * this record is what lets it. Written once, with `create()`, and never
 * changed or deleted.
 */
export const COST_REPORT_EXPORTS_COLLECTION = 'cost_report_exports';

/** Storage prefix of receipt images. Readers use the stored path and never rebuild it. */
export const RECEIPTS_PREFIX = 'receipts';

/**
 * On every new document, per collection. A hint to readers, never an auth
 * gate. Version 2 of a cleaner and of a code document is the readable code;
 * version 1 was the digest.
 */
export const CLEANER_SCHEMA_VERSION = 2;
export const CLEANER_CODE_SCHEMA_VERSION = 2;
/**
 * Version 1 entries (dispatches 17–20) held the tax, when the cleaner typed
 * it, as a line among the items. Version 2 (dispatch 21) carries `taxCents`,
 * its own field, and no tax line. Readers tell the two apart by the field,
 * never by the version number or a line's name: `taxShape` below.
 */
export const COST_ENTRY_SCHEMA_VERSION = 2;
export const COST_ENTRY_SUBMISSION_SCHEMA_VERSION = 1;
export const COST_REPORT_EXPORT_SCHEMA_VERSION = 1;

/** The currency of every amount, set by the server, never by the client. */
export const CURRENCY = 'CAD';

// ─── Limits ────────────────────────────────────────────────────

/** The receipt image types accepted. HEIC is not: the cleaner's phone is asked for a JPEG. */
export const RECEIPT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type ReceiptType = (typeof RECEIPT_TYPES)[number];

export function isReceiptType(value: unknown): value is ReceiptType {
  return typeof value === 'string' && (RECEIPT_TYPES as readonly string[]).includes(value);
}

export const LIMITS = {
  /** A cleaner's name: UTF-16 units, after NFC normalisation and trimming. */
  NAME_MAX: 80,
  /** One receipt line's name, likewise. */
  LINE_NAME_MAX: 120,
  /** Lines on one entry. At least one. */
  LINES_MAX: 100,
  /** An entry's optional note, after trimming. */
  NOTE_MAX: 500,
  /** One line's amount, either sign: $999,999.99. */
  LINE_TOTAL_MAX_CENTS: 99_999_999,
  /** An entry's tax, never negative: $999,999.99. */
  TAX_MAX_CENTS: 99_999_999,
  /** One line's quantity: more than 0, at most three decimals. Informational only. */
  QUANTITY_MAX: 99_999.999,
  /**
   * Lines on one entry once an admin has added some: the 100 a cleaner can
   * send, and room for the discounts and returns the phone cannot enter.
   */
  LINES_MAX_AFTER_REVIEW: 120,
  /** A rejection's reason, after trimming. The cleaner sees it. */
  REASON_MAX: 500,
  /**
   * Entries in one recorded PDF. Each takes about 110 bytes of the record,
   * which keeps the document far under Firestore's 1 MiB limit.
   */
  REPORT_ENTRIES_MAX: 5_000,
  /**
   * A purchase date must be within this many months before today, and never
   * after today, both on the Toronto calendar (ENTRY_TIME_ZONE). Kian's
   * ruling of 2026-09-30: the reading measurement saw two-digit years
   * misread by six years at a time, and the form took anything from 2020.
   */
  PURCHASED_ON_MONTHS_BACK: 12,
  /** The `entry` part of an entry submission: a JSON string. */
  ENTRY_JSON_MAX_CHARS: 32_768,
  /**
   * 4 MiB per receipt, one receipt per entry. With the entry part and the
   * multipart framing, a request stays under Vercel's 4.5 MB body limit,
   * which rejects anything larger before the route runs.
   */
  RECEIPT_MAX_BYTES: 4_194_304,
  /** A whole entry request, checked on Content-Length before the body is read. */
  REQUEST_MAX_BYTES: 4_300_000,
  RECEIPT_TYPES,
} as const;

/**
 * A cleaner code as typed and as stored: exactly four digits, the same length
 * as the admin PIN. The admin PIN is never a code (reservedReason in
 * codes.ts), so at the cleaner door it is refused like any code nobody holds.
 */
export const CODE_PATTERN = /^[0-9]{4}$/;

/**
 * The one-time key a cleaner's phone gives each receipt: a random UUID, as
 * `crypto.randomUUID()` writes it (version 4, lowercase).
 */
export const SUBMISSION_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// ─── Status ────────────────────────────────────────────────────

/** A cleaner's two states. A deactivated cleaner's code and sessions stop working. */
export const CLEANER_STATUSES = ['active', 'deactivated'] as const;
export type CleanerStatus = (typeof CLEANER_STATUSES)[number];

export const CLEANER_STATUS_LABELS: Record<CleanerStatus, string> = {
  active: 'Active',
  deactivated: 'Deactivated',
};

export function isCleanerStatus(value: unknown): value is CleanerStatus {
  return typeof value === 'string' && (CLEANER_STATUSES as readonly string[]).includes(value);
}

/**
 * An entry's review states. Every entry is written "pending". An admin moves
 * it to approved, rejected or removed, from any other of those, whenever they
 * choose; nothing goes back to pending. Removed means left out of totals and
 * reports, never erased: the entry stays, marked.
 */
export const ENTRY_STATUSES = ['pending', 'approved', 'rejected', 'removed'] as const;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];

export const ENTRY_STATUS_LABELS: Record<EntryStatus, string> = {
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
  removed: 'Removed',
};

/** The same states in the cleaner app's words. */
export const ENTRY_STATUS_CLEANER_LABELS: Record<EntryStatus, string> = {
  pending: 'Waiting for review',
  approved: 'Approved',
  rejected: 'Rejected',
  removed: 'Removed',
};

export function isEntryStatus(value: unknown): value is EntryStatus {
  return typeof value === 'string' && (ENTRY_STATUSES as readonly string[]).includes(value);
}

/** The statuses an admin's review can set. */
export const REVIEW_STATUSES = ['approved', 'rejected', 'removed'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/**
 * Whether an entry's amount counts in totals: approved and pending entries
 * do; rejected and removed ones do not, and neither does a status this
 * module does not know, which is shown as stored instead.
 */
export function countsInTotals(status: string | null): boolean {
  return status === 'approved' || status === 'pending';
}

/**
 * The events a history records. Words once written are permanent. A later
 * dispatch adds `renamed` to cleaners.
 *
 * On `code_changed`, `from` and `to` are the old and new codes rather than
 * statuses; `from` is null when the old code was never on record (a
 * version 1 cleaner, whose code was stored only as a digest).
 *
 * An entry's review (dispatch 19): `approved`, `rejected` and `removed` carry
 * the status before and after in `from` and `to`, and a rejection its reason.
 * `line_corrected` and `line_added` leave `from` and `to` null and carry the
 * line instead, in `line`.
 */
export const HISTORY_ACTIONS = [
  'created',
  'deactivated',
  'reactivated',
  'code_changed',
  'submitted',
  'approved',
  'rejected',
  'removed',
  'line_corrected',
  'line_added',
  'tax_corrected',
] as const;
export type HistoryAction = (typeof HISTORY_ACTIONS)[number];

export const HISTORY_ACTION_LABELS: Record<HistoryAction, string> = {
  created: 'Created',
  deactivated: 'Deactivated',
  reactivated: 'Reactivated',
  code_changed: 'Code changed',
  submitted: 'Submitted',
  approved: 'Approved',
  rejected: 'Rejected',
  removed: 'Removed',
  line_corrected: 'Line corrected',
  line_added: 'Line added',
  tax_corrected: 'Tax corrected',
};

// ─── Stored shapes ─────────────────────────────────────────────
// What the server writes. Reading goes through the views further down,
// because a stored document is not guaranteed to match.

/** Who did something. */
export interface Actor {
  role: 'admin' | 'cleaner';
  id: string | null;
  name: string | null;
}

/**
 * Every admin action today. There is one shared PIN and no admin identity,
 * and the record says so rather than inventing one.
 */
export const ADMIN_ACTOR: Actor = { role: 'admin', id: null, name: null };

/**
 * One event in a document's `history`, which is append-only. Events are
 * appended inside a transaction by reading the array and writing it back —
 * never with arrayUnion, which drops an event identical to one already there.
 */
export interface HistoryEvent {
  /** ISO-8601 UTC. */
  at: string;
  action: HistoryAction;
  /** The status before, or null when there was none. */
  from: string | null;
  to: string | null;
  actor: Actor;
  reason: string | null;
  /** On `line_corrected` and `line_added` only: which line, and what it said before and after. */
  line?: LineChange;
  /** On `tax_corrected` only (dispatch 21): the tax before and after, in cents; null is no tax given. */
  tax?: { before: number | null; after: number | null };
}

/** One receipt line, as stored. */
export interface Line {
  /** NFC, trimmed, 1–120 characters, no control characters. */
  name: string;
  /** Informational: more than 0, at most 99999.999. Never multiplied into money. */
  quantity: number;
  /** The amount printed on the line, in cents. Negative is money back; 0 is allowed. */
  lineTotalCents: number;
}

/**
 * A line as it stood before a correction: taken from the stored entry, so
 * its name and quantity are whatever was stored; its amount is whole cents,
 * or the correction would have been refused.
 */
export interface LineBefore {
  name: string | null;
  quantity: number | string | null;
  lineTotalCents: number;
}

/**
 * What a line event changed. `index` is the line's place on the entry from 0;
 * lines an admin adds come after the ones the cleaner sent. An added line has
 * no `before`.
 */
export interface LineChange {
  index: number;
  before: LineBefore | null;
  after: Line;
}

/** One stored receipt image. Every value is taken from the bytes the server stored. */
export interface ReceiptRef {
  /** The Storage object. Never returned by the API. */
  path: string;
  /** Sniffed from the bytes, never the type the browser declared. */
  contentType: ReceiptType;
  bytes: number;
  /** Hex SHA-256 of the stored bytes. */
  sha256: string;
  uploadedAt: string;
}

/** One entry as an exported PDF printed it. */
export interface ReportExportEntry {
  entryId: string;
  /** How long the entry's history was when the PDF was made: every later event came after it. */
  historyLength: number;
  /** What the PDF printed for the entry, in cents. The tax is null where it printed "none" or "in items". */
  itemsCents: number;
  taxCents: number | null;
  totalCents: number;
}

/**
 * A `cost_report_exports` document: one PDF, as it was made. The amounts are
 * the ones the PDF printed, added up by the server from the stored entries
 * at that moment; they are a record of a document handed out, and nothing
 * reads them back into an entry, a total or a report.
 */
export interface ReportExport {
  schemaVersion: number;
  kind: 'pdf';
  propertyId: string;
  /** The property's name when the PDF was made, which the PDF prints. */
  propertyNameAtExport: string | null;
  /** The period the PDF prints, yyyy-mm-dd, both days included. */
  from: string;
  to: string;
  /** ISO-8601 UTC, by the server's clock: the PDF's "Generated" time. */
  createdAt: string;
  actor: Actor;
  /** The entries in the PDF, oldest first. */
  entries: ReportExportEntry[];
  /** The period total as printed. */
  itemsCents: number;
  taxCents: number;
  totalCents: number;
}

// ─── Views ─────────────────────────────────────────────────────
// What the API returns. Strings are as stored; null means the field is not
// on the document. A value of an unexpected type is written out as text.

export interface ActorView {
  /** As stored: possibly outside 'admin' | 'cleaner'. */
  role: string | null;
  id: string | null;
  name: string | null;
}

export interface HistoryEventView {
  at: string | null;
  /** As stored: possibly outside HISTORY_ACTIONS. An event that is not a map is written out here whole. */
  action: string | null;
  from: string | null;
  to: string | null;
  actor: ActorView | null;
  reason: string | null;
  /** The line a line event changed; null on every other event. */
  line: LineChangeView | null;
  /** The tax a tax event changed; null on every other event. */
  tax: TaxChangeView | null;
}

/** A tax event's change, as stored: cents as numbers, anything else as text. */
export interface TaxChangeView {
  before: number | string | null;
  after: number | string | null;
}

/**
 * Where an entry's tax is (dispatch 21). An entry written with the field
 * `taxCents` — a number, or null when the cleaner gave none — keeps its tax
 * apart from its items: `field`. An entry written before the field existed
 * has no such field, and whatever tax the cleaner typed is a line among the
 * items, as sent: `in-lines`. Nothing is backfilled and no line's name is
 * read to guess; the field's presence on the document is the whole test.
 */
export type TaxShape = 'field' | 'in-lines';

/** A line event's change, as stored. */
export interface LineChangeView {
  /** A number as stored; any other stored value as text. */
  index: number | string | null;
  before: LineView | null;
  after: LineView | null;
}

/** One cleaner as the admin list shows it, code included. Never carries the session epoch. */
export interface CleanerSummary {
  id: string;
  name: string | null;
  /**
   * The cleaner's current code, as stored. null when none is on record — a
   * version 1 cleaner, whose code was kept only as a digest.
   */
  code: string | null;
  /** As stored: possibly outside CLEANER_STATUSES. */
  status: string | null;
  statusChangedAt: string | null;
  createdAt: string | null;
  /** null when the document has no history array. */
  history: HistoryEventView[] | null;
}

export interface LineView {
  name: string | null;
  /** A number as stored; any other stored value as text. */
  quantity: number | string | null;
  /** Cents as stored; any other stored value as text. */
  lineTotalCents: number | string | null;
}

/** A stored receipt, without its object path: paths are never returned. */
export interface ReceiptView {
  contentType: string | null;
  bytes: number | string | null;
  sha256: string | null;
  uploadedAt: string | null;
}

/**
 * The live document an entry names, looked up by ID when the list is read:
 *   found       it exists; its current values are shown
 *   missing     no document has that ID now, or the entry names none
 *   unreadable  the lookup failed — the entry itself still loaded
 */
export type LookupState = 'found' | 'missing' | 'unreadable';

/** An entry's own fields, as stored. The server adds the lookups to make a CostEntryView. */
export interface CostEntryFields {
  id: string;
  createdAt: string | null;
  /** As stored: possibly outside ENTRY_STATUSES. */
  status: string | null;
  statusChangedAt: string | null;
  statusReason: string | null;
  history: HistoryEventView[] | null;
  cleanerId: string | null;
  cleanerNameAtEntry: string | null;
  propertyId: string | null;
  propertyNameAtEntry: string | null;
  purchasedOn: string | null;
  note: string | null;
  currency: string | null;
  /** null when the document has no lines array. */
  lines: LineView[] | null;
  /** null when the document has no receipts array. */
  receipts: ReceiptView[] | null;
  /** The stored tax in cents; null when none was given or the entry predates the field (see `taxShape`). */
  taxCents: number | string | null;
  taxShape: TaxShape;
}

/**
 * One entry as the admin list shows it. Display prefers the live name and
 * falls back to the name recorded with the entry.
 */
export interface CostEntryView {
  id: string;
  createdAt: string | null;
  status: string | null;
  statusChangedAt: string | null;
  statusReason: string | null;
  history: HistoryEventView[] | null;
  cleaner: {
    id: string | null;
    nameAtEntry: string | null;
    state: LookupState;
    /** The cleaner's current name; null unless found. */
    name: string | null;
    /** The cleaner's current status, as stored; null unless found. */
    status: string | null;
  };
  property: {
    id: string | null;
    nameAtEntry: string | null;
    state: LookupState;
    /** The property's current name; null unless found. */
    name: string | null;
  };
  purchasedOn: string | null;
  note: string | null;
  currency: string | null;
  /** The lines as the cleaner sent them. */
  lines: LineView[] | null;
  /** The lines that count: the sent lines with every correction applied, and the tax as it now stands. */
  linesNow: LinesNow;
  receipts: ReceiptView[] | null;
  taxShape: TaxShape;
}

/** One line as it now counts. */
export interface LineNow {
  /** Its place on the entry, from 0. Lines an admin added come after the ones the cleaner sent. */
  index: number;
  name: string | null;
  quantity: number | string | null;
  /** Whole cents: the amount printed on the receipt line. */
  lineTotalCents: number;
  /** Sent by the cleaner, or added by an admin. */
  origin: 'sent' | 'added';
  /** What the line said before each correction, oldest first; empty when it was never corrected. */
  earlier: LineVersion[];
}

/** An earlier version of a corrected line. */
export interface LineVersion {
  name: string | null;
  quantity: number | string | null;
  lineTotalCents: number;
  /** When a correction replaced it. */
  replacedAt: string | null;
}

/**
 * An entry's lines as they now count. 'unreadable' when a stored amount is not
 * whole cents or a recorded line change cannot be applied: such an entry is
 * shown, and flagged, but never added into a total.
 */
export type LinesNow =
  | {
      kind: 'ok';
      lines: LineNow[];
      /** The lines' amounts added up, in cents: the items. Worked out to show; never stored. */
      itemsCents: number;
      /** The tax as it now stands (dispatch 21): null when the entry gave none, or keeps its tax among its lines. */
      taxCents: number | null;
      taxShape: TaxShape;
      /** Items plus tax, in cents. On an `in-lines` entry the tax, if any, is already inside the items. */
      totalCents: number;
      /** The lines as the cleaner sent them, added up, plus the tax they sent. */
      sentTotalCents: number;
      /** The tax the cleaner sent; null when none, or when the entry keeps it among its lines. */
      sentTaxCents: number | null;
      /** True once an admin has corrected a line, added one, or corrected the tax. */
      corrected: boolean;
    }
  | { kind: 'unreadable'; reason: string };

/** One entry of a recorded PDF, as stored: numbers as numbers, anything else as text. */
export interface ReportExportEntryView {
  entryId: string | null;
  historyLength: number | string | null;
  itemsCents: number | string | null;
  taxCents: number | string | null;
  totalCents: number | string | null;
}

/** One recorded PDF as the costs page reads it. */
export interface ReportExportView {
  id: string;
  createdAt: string | null;
  /** As stored: 'pdf' on every record written so far. */
  kind: string | null;
  propertyId: string | null;
  propertyNameAtExport: string | null;
  from: string | null;
  to: string | null;
  /** null when the document has no entries array. */
  entries: ReportExportEntryView[] | null;
  itemsCents: number | string | null;
  taxCents: number | string | null;
  totalCents: number | string | null;
}

/** A property's current name, so a ledger can name a property that has no entries yet. */
export interface PropertyNameView {
  id: string;
  name: string | null;
}

/** What GET /api/admin/cost-entries answers: everything the costs page works from. */
export interface CostsView {
  /** Every cost entry, newest first. */
  entries: CostEntryView[];
  /** Every recorded PDF, newest first. */
  exports: ReportExportView[];
  /** Every property's current name, A to Z; null when they could not be read. */
  properties: PropertyNameView[] | null;
}

/**
 * One of a cleaner's own entries, as the cleaner app lists it. Nothing of
 * anyone else's, and nothing of the review but its outcome: no receipt, no
 * history, no admin note.
 */
export interface CleanerEntry {
  id: string;
  createdAt: string | null;
  propertyId: string | null;
  propertyNameAtEntry: string | null;
  /** How many lines the cleaner sent; null when the entry has no lines array. */
  lineCount: number | null;
  /** What the entry now adds up to, tax included; null when its lines cannot be read. */
  totalCents: number | null;
  /** What the cleaner sent, added up, tax included; null when the lines cannot be read. */
  sentTotalCents: number | null;
  /** The tax as it now stands; null when none was given or the entry keeps it among its lines. */
  taxCents: number | null;
  taxShape: TaxShape;
  /** True once an admin has corrected a line, added one, or corrected the tax. */
  corrected: boolean;
  status: string | null;
  /** Why it was rejected, when it is; null otherwise. */
  statusReason: string | null;
}

/** A property as the cleaner app lists it. */
export interface CleanerProperty {
  id: string;
  /**
   * The name cleaners see (dispatch 21): the cleaner-facing name from
   * `property_cleaner_names` when an admin has set one, else the property's
   * real name; null when there is neither.
   */
  name: string | null;
  city: string | null;
}

/** What GET /api/cleaner/start answers: everything the cleaner app shows before the first entry is typed. */
export interface CleanerStart {
  cleaner: { id: string; name: string | null };
  /** Every property, delisted ones included, by name. */
  properties: CleanerProperty[];
  /** The properties this cleaner has logged against, most recent first. */
  recentPropertyIds: string[];
  /** Item names in use across all cleaners, most used first. Words only: no cleaner, property, date or amount. */
  itemNames: string[];
}

// ─── Reading fields ────────────────────────────────────────────

/** A stored value written out as text. Never throws, whatever the value. */
function shown(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch {
    // A value JSON cannot carry (a cycle, a bigint): fall through.
  }
  try {
    return String(value);
  } catch {
    return '[unreadable value]';
  }
}

/**
 * A field as text. null when it is absent. A value that is not a string is
 * written out rather than dropped, so a malformed field is still visible.
 */
export function fieldText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : shown(value);
}

/** A numeric field. null when absent; a finite number as is; anything else as text. */
function fieldNumber(value: unknown): number | string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return typeof value === 'string' ? value : shown(value);
}

function asMap(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readActor(value: unknown): ActorView | null {
  const actor = asMap(value);
  if (!actor) return null;
  return { role: fieldText(actor.role), id: fieldText(actor.id), name: fieldText(actor.name) };
}

function readEvent(value: unknown): HistoryEventView {
  const event = asMap(value);
  if (!event) {
    return { at: null, action: shown(value), from: null, to: null, actor: null, reason: null, line: null, tax: null };
  }
  return {
    at: fieldText(event.at),
    action: fieldText(event.action),
    from: fieldText(event.from),
    to: fieldText(event.to),
    actor: readActor(event.actor),
    reason: fieldText(event.reason),
    line: readLineChange(event.line),
    tax: readTaxChange(event.tax),
  };
}

/** A tax event's `tax`. null when the event has none. */
function readTaxChange(value: unknown): TaxChangeView | null {
  if (value === undefined || value === null) return null;
  const change = asMap(value);
  if (!change) return { before: null, after: fieldNumber(value) };
  return { before: fieldNumber(change.before), after: fieldNumber(change.after) };
}

function readHistory(value: unknown): HistoryEventView[] | null {
  return Array.isArray(value) ? value.map(readEvent) : null;
}

function readLine(value: unknown): LineView {
  const line = asMap(value);
  if (!line) return { name: shown(value), quantity: null, lineTotalCents: null };
  return {
    name: fieldText(line.name),
    quantity: fieldNumber(line.quantity),
    lineTotalCents: fieldNumber(line.lineTotalCents),
  };
}

/** A line event's `line`. null when the event has none; a value that is not a map is kept, written out, as `after`. */
function readLineChange(value: unknown): LineChangeView | null {
  if (value === undefined || value === null) return null;
  const change = asMap(value);
  if (!change) return { index: null, before: null, after: readLine(value) };
  return {
    index: fieldNumber(change.index),
    before: change.before === undefined || change.before === null ? null : readLine(change.before),
    after: change.after === undefined || change.after === null ? null : readLine(change.after),
  };
}

const isWholeCents = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);

/**
 * The lines that count: the lines as sent, with each `line_corrected` and
 * `line_added` event in the history applied in the order recorded. Every
 * earlier version of a corrected line is kept, oldest first, beside the line.
 *
 * Refuses rather than guesses: a stored amount that is not whole cents, or a
 * line event that names no line or carries no readable amount, makes the
 * whole entry 'unreadable', so a total is never built from part of it.
 *
 * The one arithmetic is adding the amounts up, for display. Nothing is
 * multiplied, and nothing is stored.
 */
export function readLinesNow(
  lines: LineView[] | null,
  history: HistoryEventView[] | null,
  tax: { shape: TaxShape; cents: number | string | null } = { shape: 'in-lines', cents: null },
): LinesNow {
  if (lines === null) return { kind: 'unreadable', reason: 'The entry has no list of lines.' };
  if (tax.shape === 'field' && tax.cents !== null && !isWholeCents(tax.cents)) {
    return { kind: 'unreadable', reason: 'The tax is not stored in whole cents.' };
  }
  const sentTaxCents = tax.shape === 'field' && isWholeCents(tax.cents) ? tax.cents : null;
  let taxCents = sentTaxCents;

  const now: LineNow[] = [];
  for (const [index, line] of lines.entries()) {
    if (!isWholeCents(line.lineTotalCents)) {
      return { kind: 'unreadable', reason: `Line ${index + 1}'s amount is not stored in whole cents.` };
    }
    now.push({
      index,
      name: line.name,
      quantity: line.quantity,
      lineTotalCents: line.lineTotalCents,
      origin: 'sent',
      earlier: [],
    });
  }
  const sentTotalCents = now.reduce((sum, line) => sum + line.lineTotalCents, 0);

  let corrected = false;
  for (const event of history ?? []) {
    if (event.action === 'tax_corrected') {
      // Only an entry with the tax field takes a tax correction; on any other it cannot be applied.
      const after = event.tax?.after;
      if (tax.shape !== 'field' || (after !== null && !isWholeCents(after))) {
        return { kind: 'unreadable', reason: `A tax change recorded ${event.at ?? 'at an unknown time'} cannot be applied.` };
      }
      taxCents = after ?? null;
      corrected = true;
      continue;
    }
    if (event.action !== 'line_corrected' && event.action !== 'line_added') continue;
    const index = event.line?.index;
    const after = event.line?.after ?? null;
    const unreadable: LinesNow = {
      kind: 'unreadable',
      reason: `A line change recorded ${event.at ?? 'at an unknown time'} cannot be applied.`,
    };
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || !after || !isWholeCents(after.lineTotalCents)) {
      return unreadable;
    }

    if (event.action === 'line_corrected') {
      const line = now[index];
      if (index < 0 || !line) return unreadable;
      line.earlier.push({
        name: line.name,
        quantity: line.quantity,
        lineTotalCents: line.lineTotalCents,
        replacedAt: event.at,
      });
      line.name = after.name;
      line.quantity = after.quantity;
      line.lineTotalCents = after.lineTotalCents;
    } else {
      // An added line goes on the end, so the index it was given is the next one.
      if (index !== now.length) return unreadable;
      now.push({
        index,
        name: after.name,
        quantity: after.quantity,
        lineTotalCents: after.lineTotalCents,
        origin: 'added',
        earlier: [],
      });
    }
    corrected = true;
  }

  const itemsCents = now.reduce((sum, line) => sum + line.lineTotalCents, 0);
  return {
    kind: 'ok',
    lines: now,
    itemsCents,
    taxCents,
    taxShape: tax.shape,
    totalCents: itemsCents + (taxCents ?? 0),
    sentTotalCents: sentTotalCents + (sentTaxCents ?? 0),
    sentTaxCents,
    corrected,
  };
}

/** Deliberately leaves out `path`: object paths are never returned. */
function readReceipt(value: unknown): ReceiptView {
  const receipt = asMap(value);
  if (!receipt) return { contentType: shown(value), bytes: null, sha256: null, uploadedAt: null };
  return {
    contentType: fieldText(receipt.contentType),
    bytes: fieldNumber(receipt.bytes),
    sha256: fieldText(receipt.sha256),
    uploadedAt: fieldText(receipt.uploadedAt),
  };
}

/**
 * A cleaner document as a list row. Reads only the summary fields, so a
 * document read whole still yields nothing about its session epoch or, on a
 * version 1 document, its code's digest.
 */
export function readCleanerSummary(id: string, fields: Record<string, unknown>): CleanerSummary {
  return {
    id,
    name: fieldText(fields.name),
    code: fieldText(fields.code),
    status: fieldText(fields.status),
    statusChangedAt: fieldText(fields.statusChangedAt),
    createdAt: fieldText(fields.createdAt),
    history: readHistory(fields.history),
  };
}

/** A cost entry document's own fields. Receipts are read without their object paths. */
export function readCostEntryFields(id: string, fields: Record<string, unknown>): CostEntryFields {
  return {
    id,
    createdAt: fieldText(fields.createdAt),
    status: fieldText(fields.status),
    statusChangedAt: fieldText(fields.statusChangedAt),
    statusReason: fieldText(fields.statusReason),
    history: readHistory(fields.history),
    cleanerId: fieldText(fields.cleanerId),
    cleanerNameAtEntry: fieldText(fields.cleanerNameAtEntry),
    propertyId: fieldText(fields.propertyId),
    propertyNameAtEntry: fieldText(fields.propertyNameAtEntry),
    purchasedOn: fieldText(fields.purchasedOn),
    note: fieldText(fields.note),
    currency: fieldText(fields.currency),
    lines: Array.isArray(fields.lines) ? fields.lines.map(readLine) : null,
    receipts: Array.isArray(fields.receipts) ? fields.receipts.map(readReceipt) : null,
    // The field's presence is the whole test: a document that has `taxCents`,
    // even as null, keeps its tax apart; one without it keeps it among its lines.
    taxCents: 'taxCents' in fields ? fieldNumber(fields.taxCents) : null,
    taxShape: 'taxCents' in fields ? 'field' : 'in-lines',
  };
}

function readReportExportEntry(value: unknown): ReportExportEntryView {
  const entry = asMap(value);
  if (!entry) return { entryId: shown(value), historyLength: null, itemsCents: null, taxCents: null, totalCents: null };
  return {
    entryId: fieldText(entry.entryId),
    historyLength: fieldNumber(entry.historyLength),
    itemsCents: fieldNumber(entry.itemsCents),
    taxCents: fieldNumber(entry.taxCents),
    totalCents: fieldNumber(entry.totalCents),
  };
}

/** A recorded PDF's own fields, as stored. */
export function readReportExport(id: string, fields: Record<string, unknown>): ReportExportView {
  return {
    id,
    createdAt: fieldText(fields.createdAt),
    kind: fieldText(fields.kind),
    propertyId: fieldText(fields.propertyId),
    propertyNameAtExport: fieldText(fields.propertyNameAtExport),
    from: fieldText(fields.from),
    to: fieldText(fields.to),
    entries: Array.isArray(fields.entries) ? fields.entries.map(readReportExportEntry) : null,
    itemsCents: fieldNumber(fields.itemsCents),
    taxCents: fieldNumber(fields.taxCents),
    totalCents: fieldNumber(fields.totalCents),
  };
}

/** Newest first. A row with no readable date goes last rather than being dropped. */
export function newestFirst<T extends { id: string; createdAt: string | null }>(a: T, b: T): number {
  const ta = Date.parse(a.createdAt ?? '');
  const tb = Date.parse(b.createdAt ?? '');
  const aDated = Number.isFinite(ta);
  const bDated = Number.isFinite(tb);

  if (aDated && bDated && ta !== tb) return tb - ta;
  if (aDated !== bDated) return aDated ? -1 : 1;
  return a.id.localeCompare(b.id);
}

// ─── Display ───────────────────────────────────────────────────

/**
 * Cents as dollars, for display only: 3798 → "$37.98", -500 → "-$5.00".
 * Integer arithmetic throughout, never a float. A value that is not a safe
 * integer is written out as it is rather than rounded into one.
 */
export function formatCents(cents: number): string {
  if (!Number.isSafeInteger(cents)) return String(cents);
  const abs = Math.abs(cents);
  const dollars = (abs - (abs % 100)) / 100;
  const rest = String(abs % 100).padStart(2, '0');
  return `${cents < 0 ? '-' : ''}$${dollars.toLocaleString('en-CA')}.${rest}`;
}

// ─── Refusals ──────────────────────────────────────────────────

/**
 * A refusal a library function hands back for a route to send. Its fields are
 * those of `apiFailure`, so a route answers with
 * `noStore(apiFailure(refusal))`.
 */
export interface Refusal {
  status: number;
  code: string;
  message: string;
  hint?: string;
}

// ─── Receipt reading (dispatch 20) ─────────────────────────────
// Gemini reads the receipt photo and fills the items screen in; the cleaner
// confirms, corrects, adds and sends. What the cleaner sends is the entry,
// exactly as before. What the model said is kept beside the entry, in its
// own collection, as evidence about the model and never as a claim about
// the purchase.

/**
 * One document per entry that had a reading, keyed by the entry's ID. It is
 * created in the entry's own transaction. An entry sent with no reading (the
 * phone never asked, or the answer never came) has no document here.
 */
export const COST_ENTRY_READINGS_COLLECTION = 'cost_entry_readings';

/**
 * One document per Toronto calendar day, `YYYY-MM-DD`: how many readings
 * were taken that day, in all and per cleaner. The runaway-bill guard.
 */
export const RECEIPT_READING_QUOTA_COLLECTION = 'receipt_reading_quota';

export const COST_ENTRY_READING_SCHEMA_VERSION = 1;
export const RECEIPT_READING_QUOTA_SCHEMA_VERSION = 1;

/**
 * The name cleaners see for a property (dispatch 21, Kian's ruling of
 * 2026-09-30): one document per property that has one, keyed by the
 * property's ID, in its own server-only collection. It is never on the
 * property document, because `properties` is world-readable and these names
 * may be street addresses. Absent: the cleaner app shows the real name.
 */
export const PROPERTY_CLEANER_NAMES_COLLECTION = 'property_cleaner_names';
export const PROPERTY_CLEANER_NAME_SCHEMA_VERSION = 1;
/** A cleaner-facing name: NFC, trimmed, 1–120 characters, no control characters. */
export const CLEANER_FACING_NAME_MAX = 120;

/** Kian's ruling of 2026-09-30, from the measurement: this model, thinking pinned low. */
export const RECEIPT_READER_MODEL = 'gemini-3.8-flash';
export const RECEIPT_READER_THINKING = 'LOW';

/**
 * The calendar that "today" and "this day" mean for a purchase date and for
 * the reading quota. The cleaners and the properties are in Ontario. It is
 * the same zone the reports use (REPORT_TIME_ZONE in costs/report.ts).
 */
export const ENTRY_TIME_ZONE = 'America/Toronto';

export const READING_LIMITS = {
  /** Readings one cleaner can take in one Toronto day. */
  PER_CLEANER_PER_DAY: 40,
  /** Readings everyone together can take in one Toronto day. */
  PER_DAY: 300,
  /** How long the server waits for the model before giving the phone a failure. */
  TIMEOUT_MS: 20_000,
  /** The `reading` part of an entry submission: a JSON string. */
  JSON_MAX_CHARS: 65_536,
  /** Lines kept from one reading; a receipt has at most LINES_MAX lines anyway. */
  OUTPUT_LINES_MAX: 150,
  /** A name as the model wrote it, before the form cuts it to LINE_NAME_MAX. */
  OUTPUT_NAME_MAX: 300,
  /** The model's answer is capped here; a 100-line receipt needs about 5,000 tokens. */
  MAX_OUTPUT_TOKENS: 8192,
} as const;

/** One line as the model read it. `amount` is the string printed at the end of the line, e.g. "7.98" or "-5.00". */
export interface ReadingLine {
  name: string;
  quantity: number | null;
  amount: string | null;
  kind: 'item' | 'discount' | 'tax' | 'fee';
}

/** What the model returns for one photo, in the shape it was asked for. */
export interface ReadingOutput {
  store: string | null;
  /** Read but never used to fill the form (Kian's ruling of 2026-09-30: the date is the cleaner's). */
  purchasedOn: string | null;
  lines: ReadingLine[];
  subtotal: string | null;
  total: string | null;
  unreadable: boolean;
  notes: string | null;
}

/**
 * One reading, as the server records it and signs it for the phone to carry
 * until the entry is sent. The phone cannot alter it: the signature is
 * checked on the way back, and the cleaner ID inside must be the session's.
 */
export interface ReadingRecord {
  v: 1;
  /** A UUID for this reading. */
  id: string;
  cleanerId: string;
  requestedAt: string;
  model: string;
  modelVersion: string | null;
  thinkingLevel: string;
  /** Wall-clock milliseconds from request to answer, on the server. */
  ms: number;
  status: 'ok' | 'failed';
  /** On failure: `timeout`, `network`, `http_<status>`, `unparsable`, `no_output`, `blocked`, `over_limit_cleaner`, `over_limit_day`. */
  reason: string | null;
  usage: { promptTokens: number; outputTokens: number; thoughtsTokens: number } | null;
  output: ReadingOutput | null;
  /** The model's text when it could not be parsed as the shape above; else null. */
  rawText: string | null;
}

/**
 * What one reading did for the form, computed by the server when the entry
 * is written, from the model's lines and the cleaner's:
 *   unchanged   put on the form and sent exactly as read
 *   edited      put on the form; the cleaner changed the fields named
 *   left_out    never sent: the cleaner removed it, or the form could not
 *               take it (no amount, or one the phone cannot enter)
 */
export type ReadingLineOutcome = 'unchanged' | 'edited' | 'left_out' | 'tax';

const isRecordValue = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const READING_KINDS = new Set(['item', 'discount', 'tax', 'fee']);

/** A model line in the shape asked for, with its strings capped; null for anything else. */
export function readReadingLine(value: unknown): ReadingLine | null {
  if (!isRecordValue(value) || typeof value.name !== 'string') return null;
  const quantity = typeof value.quantity === 'number' && Number.isFinite(value.quantity) ? value.quantity : null;
  const amount = typeof value.amount === 'string' ? value.amount.slice(0, 32) : null;
  const kind = typeof value.kind === 'string' && READING_KINDS.has(value.kind) ? (value.kind as ReadingLine['kind']) : 'item';
  return { name: value.name.slice(0, READING_LIMITS.OUTPUT_NAME_MAX), quantity, amount, kind };
}

const textOrNull = (value: unknown, max: number): string | null =>
  typeof value === 'string' ? value.slice(0, max) : null;

/** The model's answer in the shape asked for, or null when it is not one. Lines it cannot read are dropped. */
export function readReadingOutput(value: unknown): ReadingOutput | null {
  if (!isRecordValue(value) || !Array.isArray(value.lines)) return null;
  const lines = value.lines
    .slice(0, READING_LIMITS.OUTPUT_LINES_MAX)
    .map(readReadingLine)
    .filter((line): line is ReadingLine => line !== null);
  return {
    store: textOrNull(value.store, 200),
    purchasedOn: textOrNull(value.purchasedOn, 32),
    lines,
    subtotal: textOrNull(value.subtotal, 32),
    total: textOrNull(value.total, 32),
    unreadable: value.unreadable === true,
    notes: textOrNull(value.notes, 500),
  };
}

/** A record this server wrote, checked field by field; null for anything else. */
export function readReadingRecord(value: unknown): ReadingRecord | null {
  if (!isRecordValue(value) || value.v !== 1) return null;
  const { id, cleanerId, requestedAt, model, modelVersion, thinkingLevel, ms, status, reason, usage, output, rawText } = value;
  if (typeof id !== 'string' || typeof cleanerId !== 'string' || typeof requestedAt !== 'string') return null;
  if (typeof model !== 'string' || typeof thinkingLevel !== 'string' || typeof ms !== 'number') return null;
  if (status !== 'ok' && status !== 'failed') return null;
  const usageRead =
    isRecordValue(usage) &&
    typeof usage.promptTokens === 'number' &&
    typeof usage.outputTokens === 'number' &&
    typeof usage.thoughtsTokens === 'number'
      ? { promptTokens: usage.promptTokens, outputTokens: usage.outputTokens, thoughtsTokens: usage.thoughtsTokens }
      : null;
  return {
    v: 1,
    id,
    cleanerId,
    requestedAt,
    model,
    modelVersion: typeof modelVersion === 'string' ? modelVersion : null,
    thinkingLevel,
    ms,
    status,
    reason: typeof reason === 'string' ? reason : null,
    usage: usageRead,
    output: output === null ? null : readReadingOutput(output),
    rawText: typeof rawText === 'string' ? rawText : null,
  };
}

/**
 * A model line as the form would show it: the name tidied, the quantity as
 * typed ("1" when the receipt printed none), the amount as the phone's
 * number pad writes it. Null when the phone could not hold it — no amount,
 * a discount or return (negative), zero, or more than the form's maximum —
 * so the line is left for the admin, who has the photo. The server uses the
 * same function to tell an unchanged line from an edited one.
 */
export function prefillFromReading(line: ReadingLine): { name: string; quantity: string; price: string } | null {
  if (line.kind === 'tax') return null; // tax is its own field (dispatch 21), never an item line
  const amount = /^(\d{1,6})\.(\d{2})$/.exec((line.amount ?? '').trim());
  if (!amount) return null;
  const cents = Number(amount[1]) * 100 + Number(amount[2]);
  if (cents <= 0 || cents > LIMITS.LINE_TOTAL_MAX_CENTS) return null;
  const name = line.name === '?' ? '' : line.name.normalize('NFC').replace(/\p{Cc}/gu, '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.LINE_NAME_MAX);
  let quantity = '1';
  if (line.quantity !== null && line.quantity > 0 && line.quantity <= LIMITS.QUANTITY_MAX) {
    const text = String(Math.round(line.quantity * 1000) / 1000);
    if (/^(0|[1-9][0-9]{0,4})(\.[0-9]{1,3})?$/.test(text) && Number(text) > 0) quantity = text;
  }
  return { name, quantity, price: `${Number(amount[1])}.${amount[2]}` };
}

/** Lines the phone cannot take from a reading (prefillFromReading is null), with their cents where readable: shown so the cleaner knows the total here is not the receipt's. */
export function leftOutOfReading(output: ReadingOutput | null): { count: number; cents: number } {
  let count = 0;
  let cents = 0;
  for (const line of output?.lines ?? []) {
    if (line.kind === 'tax' || prefillFromReading(line)) continue;
    count++;
    const amount = /^(-?)(\d{1,6})\.(\d{2})$/.exec((line.amount ?? '').trim());
    if (amount) cents += (amount[1] ? -1 : 1) * (Number(amount[2]) * 100 + Number(amount[3]));
  }
  return { count, cents };
}

/** A calendar day, `YYYY-MM-DD`, in a time zone. */
export function dayIn(timeZone: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/**
 * The tax the model read, as the form's tax field shows it: the tax lines'
 * amounts added up, "12.71"; null when the receipt printed no readable tax
 * line. Never a negative, never more than the form's maximum.
 */
export function taxFromReading(output: ReadingOutput | null): string | null {
  let cents = 0;
  let found = false;
  for (const line of output?.lines ?? []) {
    if (line.kind !== 'tax') continue;
    const amount = /^(\d{1,6})\.(\d{2})$/.exec((line.amount ?? '').trim());
    if (!amount) continue;
    cents += Number(amount[1]) * 100 + Number(amount[2]);
    found = true;
  }
  if (!found || cents > LIMITS.TAX_MAX_CENTS) return null;
  return `${(cents - (cents % 100)) / 100}.${String(cents % 100).padStart(2, '0')}`;
}
