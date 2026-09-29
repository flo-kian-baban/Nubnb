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
 * only writes one out.
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

/** Storage prefix of receipt images. Readers use the stored path and never rebuild it. */
export const RECEIPTS_PREFIX = 'receipts';

/**
 * On every new document, per collection. A hint to readers, never an auth
 * gate. Version 2 of a cleaner and of a code document is the readable code;
 * version 1 was the digest.
 */
export const CLEANER_SCHEMA_VERSION = 2;
export const CLEANER_CODE_SCHEMA_VERSION = 2;
export const COST_ENTRY_SCHEMA_VERSION = 1;
export const COST_ENTRY_SUBMISSION_SCHEMA_VERSION = 1;

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
  /** One line's quantity: more than 0, at most three decimals. Informational only. */
  QUANTITY_MAX: 99_999.999,
  /** The earliest purchase date accepted. The latest is tomorrow, in UTC. */
  PURCHASED_ON_MIN: '2020-01-01',
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

/** An entry's review states. Every entry is written "pending"; review comes later. */
export const ENTRY_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];

export const ENTRY_STATUS_LABELS: Record<EntryStatus, string> = {
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
};

export function isEntryStatus(value: unknown): value is EntryStatus {
  return typeof value === 'string' && (ENTRY_STATUSES as readonly string[]).includes(value);
}

/**
 * The events a history records. Words once written are permanent. A later
 * dispatch adds `renamed` to cleaners, and review events to entries.
 *
 * On `code_changed`, `from` and `to` are the old and new codes rather than
 * statuses; `from` is null when the old code was never on record (a
 * version 1 cleaner, whose code was stored only as a digest).
 */
export const HISTORY_ACTIONS = ['created', 'deactivated', 'reactivated', 'code_changed', 'submitted'] as const;
export type HistoryAction = (typeof HISTORY_ACTIONS)[number];

export const HISTORY_ACTION_LABELS: Record<HistoryAction, string> = {
  created: 'Created',
  deactivated: 'Deactivated',
  reactivated: 'Reactivated',
  code_changed: 'Code changed',
  submitted: 'Submitted',
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
  lines: LineView[] | null;
  receipts: ReceiptView[] | null;
}

/** A property as the cleaner app lists it. */
export interface CleanerProperty {
  id: string;
  /** null when the document has no name. */
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
    return { at: null, action: shown(value), from: null, to: null, actor: null, reason: null };
  }
  return {
    at: fieldText(event.at),
    action: fieldText(event.action),
    from: fieldText(event.from),
    to: fieldText(event.to),
    actor: readActor(event.actor),
    reason: fieldText(event.reason),
  };
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
