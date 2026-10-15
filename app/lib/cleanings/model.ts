/**
 * Cleanings (dispatch 37B): each cleaning an admin logs by hand — cleaner,
 * property, the day cleaned, the amount, an optional note. Client-safe: no
 * server imports.
 *
 * Kian's rulings of 2026-10-13 (in CLAUDE.md under *Cleanings*):
 *   - Each cleaner has one default rate. A cleaning's amount starts from the
 *     amount that cleaner was last paid for that property, or their default
 *     if none, and the admin can change it freely. No per-property rate
 *     table, no dated rates.
 *   - Admins log every cleaning by hand. No list of bookings or checkouts to
 *     tick; no link between cleanings and bookings.
 *   - On the owner's statement a month's cleanings print as one line,
 *     "Expense - Cleaning", with the total. The ledger lists each cleaning.
 *   - The cleaner is never named on anything an owner receives.
 *   - A cleaning logged after its month's statement is finished goes on the
 *     next open statement, labelled with its month; one changed or removed
 *     after printing is adjusted on the next month's statement: the rules
 *     costs follow.
 *   - A cleaning is also the cleaner's earnings record.
 *
 * One root collection, server-only (firestore.rules' catch-all denies every
 * browser):
 *   cleanings/{autoId}   one per cleaning logged
 *
 * ── Schema version 2: the cleaning schedule (Kian's rulings of 2026-10-14) ──
 * A cleaning is also made by a cleaner's Mark cleaned on a job, at once, with
 * no admin confirmation; its day is the job's checkout day, and `jobId` names
 * the job (jobs link cleanings to bookings, replacing 37B's "no link"). Its
 * amount is 37B's rule — what the cleaner was last paid for the property,
 * else their default rate — and with neither it is null: the cleaning waits
 * for an admin to type it, and reads as pending until then (not charged;
 * Finish's pending warning counts it). Only a job's cleaning may have a null
 * amount. Version 1 has no `jobId` and always an amount; readers take both.
 *
 * ── How a cleaning reaches a statement ──
 * As a cost: `cleaningEntryView` reads a cleaning as an entry of kind
 * `cleaning`, dated the day it was cleaned and belonging to that day's
 * month, so the statement's arithmetic (reports/statement.ts) charges it,
 * carries it to the next open statement when its month is finished, and
 * adjusts it when it changes after printing, exactly as it does a cost
 * entry. The statement prints a month's cleanings as one line.
 *
 * ── Money ──
 * Integer cents. The amount is what Nubnb pays the cleaner for the cleaning
 * and charges the owner. Code fills it in from the cleaner's last amount for
 * the property, or their default rate (Kian's ruling); it never works one
 * out.
 */

import type { Actor, CostEntryView, HistoryEventView, LookupState } from '@/app/lib/cleaners/model';

export const CLEANINGS_COLLECTION = 'cleanings';
export const CLEANING_SCHEMA_VERSION = 2;

export const CLEANING_LIMITS = {
  /** An amount: $0.01 to $9,999.99. */
  AMOUNT_MAX_CENTS: 999_999,
  NOTE_MAX: 300,
  REASON_MAX: 300,
  /** How far back a cleaning's day may be: twelve months, as a purchase date (Kian's ruling of 2026-09-30, for receipts). */
  MONTHS_BACK: 12,
} as const;

export type CleaningStatus = 'logged' | 'removed';

/** Where the amount the form started from came from: the cleaner's last amount for the property, their default rate, or nothing. */
export type SuggestedFrom = 'last' | 'default' | 'none';

/** One event of a cleaning's history, append-only. */
export interface CleaningEvent {
  /** ISO-8601 UTC. */
  at: string;
  action: 'logged' | 'changed' | 'removed';
  actor: Actor;
  reason: string | null;
  /** On `changed`: the fields before and after, only those that changed. */
  before?: CleaningFieldsChanged;
  after?: CleaningFieldsChanged;
}

export interface CleaningFieldsChanged {
  day?: string;
  /** Null only before: a job's cleaning that waited for its amount. */
  amountCents?: number | null;
  cleanerId?: string;
  cleanerName?: string | null;
  note?: string | null;
}

/** `cleanings/{id}`, as written. */
export interface Cleaning {
  schemaVersion: number;
  propertyId: string;
  propertyNameAtEntry: string | null;
  cleanerId: string;
  /** The cleaner's name when logged, or when the cleaner was last changed: a deleted cleaner's cleanings still read by it. */
  cleanerNameAtEntry: string | null;
  /** The day cleaned, yyyy-mm-dd, Toronto. Its month is the month the cleaning belongs to. A job's cleaning: its checkout day. */
  day: string;
  /** Null only on a job's cleaning with no amount to start from: it waits for an admin to type one. */
  amountCents: number | null;
  note: string | null;
  status: CleaningStatus;
  /** What the form started from, worked out by the server when the cleaning was logged: evidence, never read back into money. */
  suggested: { from: SuggestedFrom; cents: number | null };
  createdAt: string;
  actor: Actor;
  history: CleaningEvent[];
  /** The job whose Mark cleaned made it (schema version 2); null when an admin logged it by hand, and on every version 1 cleaning. */
  jobId: string | null;
}

/** A cleaning as the admin reads it, with the current names of its cleaner and property. */
export interface CleaningView extends Cleaning {
  id: string;
  cleaner: { state: LookupState; name: string | null; status: string | null };
  property: {
    state: LookupState;
    name: string | null;
    /** The name the admin shows and owners receive: its cleaner-facing name, usually the street address, else its public title (Kian's rulings of 2026-10-15, evening); null unless found. */
    internalName?: string | null;
  };
}

/** A team member as the cleaning form needs them: who can be picked, and their default rate. */
export interface TeamRate {
  id: string;
  name: string | null;
  /** `cleaner` or `handyman`: only a cleaner is picked for a cleaning. */
  role: string;
  status: string | null;
  /** The one default rate (Kian's ruling); null when none is set. */
  defaultRateCents: number | null;
}

// ─── Reading strictly ──────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string';
const isTextOrNull = (value: unknown): value is string | null => value === null || typeof value === 'string';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isAmount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= CLEANING_LIMITS.AMOUNT_MAX_CENTS;
const isActor = (value: unknown): value is Actor => isRecord(value) && isText(value.role) && isTextOrNull(value.id) && isTextOrNull(value.name);

function readChanged(value: unknown): CleaningFieldsChanged | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const out: CleaningFieldsChanged = {};
  if ('day' in value) {
    if (!isText(value.day) || !DAY.test(value.day)) return null;
    out.day = value.day;
  }
  if ('amountCents' in value) {
    if (!(value.amountCents === null || isAmount(value.amountCents))) return null;
    out.amountCents = value.amountCents;
  }
  if ('cleanerId' in value) {
    if (!isText(value.cleanerId)) return null;
    out.cleanerId = value.cleanerId;
  }
  if ('cleanerName' in value) {
    if (!isTextOrNull(value.cleanerName)) return null;
    out.cleanerName = value.cleanerName;
  }
  if ('note' in value) {
    if (!isTextOrNull(value.note)) return null;
    out.note = value.note;
  }
  return out;
}

function readEvent(value: unknown): CleaningEvent | null {
  if (!isRecord(value) || !isText(value.at) || !isActor(value.actor) || !isTextOrNull(value.reason)) return null;
  if (value.action !== 'logged' && value.action !== 'changed' && value.action !== 'removed') return null;
  const before = readChanged(value.before);
  const after = readChanged(value.after);
  if (before === null || after === null) return null;
  return { at: value.at, action: value.action, actor: value.actor, reason: value.reason, ...(before ? { before } : {}), ...(after ? { after } : {}) };
}

/**
 * A stored cleaning, read strictly: null when any field is not in the written shape. These documents are written
 * only by this code, so one not in shape is reported, never guessed at.
 */
export function readCleaning(id: string, fields: Record<string, unknown>): (Cleaning & { id: string }) | null {
  const { propertyId, propertyNameAtEntry, cleanerId, cleanerNameAtEntry, day, amountCents, note, status, suggested, createdAt, actor, history } = fields;
  if (typeof fields.schemaVersion !== 'number') return null;
  // Version 1 has no `jobId`: absent reads as none.
  const jobId = fields.jobId === undefined ? null : fields.jobId;
  if (!isTextOrNull(jobId)) return null;
  if (!isText(propertyId) || !isTextOrNull(propertyNameAtEntry) || !isText(cleanerId) || !isTextOrNull(cleanerNameAtEntry)) return null;
  // Only a job's cleaning waits for its amount.
  if (!isText(day) || !DAY.test(day) || !(isAmount(amountCents) || (amountCents === null && jobId !== null)) || !isTextOrNull(note)) return null;
  if (status !== 'logged' && status !== 'removed') return null;
  if (!isRecord(suggested) || (suggested.from !== 'last' && suggested.from !== 'default' && suggested.from !== 'none') || !(suggested.cents === null || isAmount(suggested.cents))) return null;
  if (!isText(createdAt) || !isActor(actor) || !Array.isArray(history)) return null;
  const events = history.map(readEvent);
  if (events.some((event) => event === null)) return null;
  return {
    id,
    schemaVersion: fields.schemaVersion,
    propertyId,
    propertyNameAtEntry,
    cleanerId,
    cleanerNameAtEntry,
    day,
    amountCents,
    note,
    status,
    suggested: { from: suggested.from, cents: suggested.cents as number | null },
    createdAt,
    actor,
    history: events as CleaningEvent[],
    jobId,
  };
}

// ─── The amount a cleaning starts from ─────────────────────────

/**
 * The amount the form starts from (Kian's ruling of 2026-10-13): what the cleaner was last paid for the property —
 * their latest cleaning of it, by the day cleaned, not removed — else their default rate, else nothing to start
 * from. The admin can change it freely. Nothing is worked out: an amount is taken as it was paid or set.
 */
export function suggestedAmount(cleanings: readonly Pick<Cleaning, 'propertyId' | 'cleanerId' | 'day' | 'amountCents' | 'status' | 'createdAt'>[], cleanerId: string, propertyId: string, defaultRateCents: number | null): { from: SuggestedFrom; cents: number | null } {
  // A cleaning still waiting for its amount was paid nothing yet: it is not "last paid".
  const last = cleanings
    .filter((c): c is typeof c & { amountCents: number } => c.cleanerId === cleanerId && c.propertyId === propertyId && c.status === 'logged' && c.amountCents !== null)
    .sort((a, b) => b.day.localeCompare(a.day) || b.createdAt.localeCompare(a.createdAt))[0];
  if (last) return { from: 'last', cents: last.amountCents };
  if (defaultRateCents !== null) return { from: 'default', cents: defaultRateCents };
  return { from: 'none', cents: null };
}

/** Whoever cleaned the property last, for the form to start from when no cleaner is chosen yet. */
export function lastCleanerOf(cleanings: readonly Pick<Cleaning, 'propertyId' | 'cleanerId' | 'day' | 'status' | 'createdAt'>[], propertyId: string): string | null {
  return (
    cleanings
      .filter((c) => c.propertyId === propertyId && c.status === 'logged')
      .sort((a, b) => b.day.localeCompare(a.day) || b.createdAt.localeCompare(a.createdAt))[0]?.cleanerId ?? null
  );
}

/** The name a cleaning shows its cleaner by: the current name, else the one it was logged with. Admins only: never on what an owner receives. */
export function cleanerNameOf(cleaning: Pick<CleaningView, 'cleaner' | 'cleanerNameAtEntry'>): string {
  return cleaning.cleaner.name?.trim() || cleaning.cleanerNameAtEntry?.trim() || 'Unknown cleaner';
}

// ─── A cleaning as the statements read it ──────────────────────

/**
 * The instant a cleaning is dated by in the statements and the ledger: its day, at a time that is that day in
 * Toronto all year (17:00 UTC is 12:00 or 13:00 there). The moment it was logged stays on the cleaning.
 */
export function cleaningInstant(day: string): string {
  return `${day}T17:00:00.000Z`;
}

/**
 * A cleaning as an entry the statements, the ledger and the month's money read (dispatch 37B): kind `cleaning`,
 * dated the day it was cleaned and belonging to its month, one line "Cleaning" at its amount, approved while
 * logged and removed once removed, its history the cleaning's. Its cleaner is the one who cleaned; what an owner
 * receives names nobody (reports/statement.ts, costs/report.ts).
 */
export function cleaningEntryView(c: CleaningView): CostEntryView {
  // A job's cleaning with no amount yet (schema version 2) reads as a pending cost: nothing to charge, counted by
  // Finish's pending warning (Kian's answer of 2026-10-14, evening), and no lines to add up.
  if (c.amountCents === null) return entryView(c, c.status === 'logged' ? 'pending' : 'removed', [], { kind: 'unreadable', reason: NO_AMOUNT_YET });
  const amount = c.amountCents;
  const typed = c.history.find((event) => event.action === 'changed' && event.before?.amountCents !== undefined)?.before?.amountCents;
  // The first amount it had: the one logged, or the one an admin typed into a cleaning that waited for it.
  const firstAmount = typed === undefined ? amount : typed === null ? (c.history.find((event) => event.action === 'changed' && event.before?.amountCents === null)?.after?.amountCents ?? amount) : typed;
  return entryView(c, c.status === 'logged' ? 'approved' : 'removed', [{ name: 'Cleaning', quantity: 1, lineTotalCents: amount }], {
    kind: 'ok',
    lines: [{ index: 0, name: 'Cleaning', quantity: 1, lineTotalCents: amount, origin: 'sent', earlier: [] }],
    itemsCents: amount,
    taxCents: null,
    taxShape: 'field',
    totalCents: amount,
    sentTotalCents: firstAmount,
    sentTaxCents: null,
    corrected: firstAmount !== amount,
  });
}

/** What a cleaning's own amount column says while it waits for one (schema version 2). */
export const NO_AMOUNT_YET = 'No amount yet: an admin types it in the Cleanings tab.';

/** A cleaning as an entry, its fields in the order 37B wrote them. */
function entryView(c: CleaningView, status: string, lines: CostEntryView['lines'], linesNow: CostEntryView['linesNow']): CostEntryView {
  const first = c.history.find((event) => event.action === 'logged');
  const history: HistoryEventView[] = c.history.map((event) => ({
    at: event.at,
    action: event.action,
    from: null,
    to: null,
    actor: { role: event.actor.role, id: event.actor.id, name: event.actor.name },
    reason: event.reason,
    line: null,
    tax: null,
  }));
  return {
    id: c.id,
    createdAt: cleaningInstant(c.day),
    status,
    statusChangedAt: [...c.history].reverse().find((event) => event.action === 'removed')?.at ?? first?.at ?? c.createdAt,
    statusReason: null,
    history,
    cleaner: { id: c.cleanerId, nameAtEntry: c.cleanerNameAtEntry, state: c.cleaner.state, name: c.cleaner.name, status: c.cleaner.status },
    property: { id: c.propertyId, nameAtEntry: c.propertyNameAtEntry, state: c.property.state, name: c.property.name },
    purchasedOn: c.day,
    note: null,
    currency: 'CAD',
    lines,
    linesNow,
    receipts: [],
    taxShape: 'field',
    kind: 'cleaning',
    autoApproved: null,
    month: c.day.slice(0, 7),
    paidWith: 'team-member',
  };
}

/** Whether an entry the statements read is a cleaning. */
export function isCleaning(entry: { kind: string }): boolean {
  return entry.kind === 'cleaning';
}

/** "$60.00": a cents amount as an input field holds it, no sign or comma ("60.00"). */
export function amountField(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** A typed amount, "60", "60.5" or "60.50", as cents; null when it is not one, or not above zero, or too large. */
export function readAmountCents(text: string): number | null {
  const match = /^\s*\$?\s*(\d{1,4})(?:\.(\d{1,2}))?\s*$/.exec(text);
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '0').padEnd(2, '0'));
  return cents > 0 && cents <= CLEANING_LIMITS.AMOUNT_MAX_CENTS ? cents : null;
}
