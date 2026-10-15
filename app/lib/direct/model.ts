/**
 * Direct payments (part B of PROPERTY-LIST-COLUMNS-PLAN.md; Kian's rulings of 2026-10-15 in CLAUDE.md under
 * *Property list columns and direct payments*): money paid to Nubnb outside Airbnb — cash, e-transfer, cheque —
 * received by an admin and recorded by them. Nubnb takes no payment: this records money already received.
 * Client-safe: no server imports.
 *
 * Two root collections, server-only (firestore.rules denies every browser):
 *   direct_arrangements/{autoId}    a property's expected monthly payment: who pays (a name as typed), how much, the
 *                                   day of the month it is due, from which month, its pauses, the months its amount
 *                                   changed from, its last month once ended, and its history
 *   direct_payments/{64 hex}        one payment received: the day, the amount, how, what the statement prints, the
 *                                   months it pays, the admin who received and recorded it; recorded or removed,
 *                                   never deleted. The ID has the shape of an earnings line's, so a finished
 *                                   statement keeps it on its line as it keeps a platform line's (`platformLineId`).
 *
 * ── Kian's rulings (2026-10-15) ──
 * - Any admin can receive a direct payment and record it; direct payments are anything paid outside Airbnb.
 * - A payment prints with its method's word: "Cash - Monthly stay - received Oct 3". The payer is never printed.
 * - Only received money is income, in the month it was received; a month already finished sends it to the next open
 *   statement, with its day printed (it always is).
 * - Monthly periods only. A part payment goes to the oldest unpaid month first, changeable; an overpayment waits for
 *   the next month (periods.ts).
 * - A payment printed on a finished statement is locked and changes only by correcting that statement. An unprinted
 *   one is removed (kept, struck through, out of totals), never deleted.
 * - No direct short stay is recorded until Kian confirms its tax treatment with his accountant. The threshold is 30
 *   nights, not 28, until his accountant confirms otherwise (his ruling, after the part B report): an arrangement is a
 *   monthly stay of at least 30 nights, and a one-off payment is a stay of 30 nights or more, its stay's dates kept
 *   with it, or not a stay.
 *
 * Every document keeps the shape it was written with: the readers are strict, and a document not in shape is
 * reported, never guessed at.
 */

import { formatCents, type Actor } from '@/app/lib/cleaners/model';
import type { PlatformLineInput } from '@/app/lib/reports/statement';
import { addMonths, isMonth, monthLabel, monthOfDay } from '@/app/lib/reports/model';
import { isDay, nightsBetween, rangeText } from '@/app/lib/availability/days';
import { earliestPaymentDay } from '@/app/lib/pay/model';

export const DIRECT_ARRANGEMENTS_COLLECTION = 'direct_arrangements';
export const DIRECT_PAYMENTS_COLLECTION = 'direct_payments';
export const DIRECT_SCHEMA_VERSION = 1;

/** How the money came (Kian's answer: anything outside Airbnb). */
export const DIRECT_METHODS = ['cash', 'e-transfer', 'cheque', 'other'] as const;
export type DirectMethod = (typeof DIRECT_METHODS)[number];
export const DIRECT_METHOD_LABELS: Record<DirectMethod, string> = { cash: 'Cash', 'e-transfer': 'E-transfer', cheque: 'Cheque', other: 'Other' };
/** The word the owner's statement prints first (Kian's ruling: the method's word). */
export const DIRECT_METHOD_WORDS: Record<DirectMethod, string> = { cash: 'Cash', 'e-transfer': 'E-transfer', cheque: 'Cheque', other: 'Payment' };

/**
 * What a payment is for. An arrangement's payments are a monthly stay. A one-off payment is a stay of 30 nights or
 * more, or not a stay: no direct short stay is recorded until Kian confirms its tax treatment (his rulings).
 */
export const DIRECT_PURPOSES = ['monthly-stay', 'long-stay', 'not-a-stay'] as const;
export type DirectPurpose = (typeof DIRECT_PURPOSES)[number];
export const ONE_OFF_PURPOSES = ['long-stay', 'not-a-stay'] as const;
export type OneOffPurpose = (typeof ONE_OFF_PURPOSES)[number];
export const DIRECT_PURPOSE_LABELS: Record<DirectPurpose, string> = { 'monthly-stay': 'Monthly stay', 'long-stay': 'A stay of 30 nights or more', 'not-a-stay': 'Not a stay: a fee, parking, other' };
/** Said where a one-off payment is recorded: why there is no short stay to pick. */
export const SHORT_STAY_WORDS = 'Short stays (under 30 nights) are not recorded until their tax treatment is confirmed.';

export const DIRECT_LIMITS = {
  /** One amount: more than $0.00, at most $999,999.99. */
  AMOUNT_MAX_CENTS: 99_999_999,
  WORDING_MAX: 60,
  PAYER_MAX: 80,
  NOTE_MAX: 500,
  /** A due day is 1 to 28, so every month has it. */
  DUE_DAY_MAX: 28,
  /** The shortest stay recorded (Kian's ruling: 30 nights until his accountant confirms otherwise); shorter is a short stay. */
  STAY_NIGHTS_MIN: 30,
  /** A stay's dates: its first night at most this many days before today, its checkout at most this many after. */
  STAY_DAYS_RANGE: 730,
  /** An arrangement starts at most this many months back, as a day received may (the purchase dates' rule). */
  MONTHS_BACK: 12,
  /** And at most this many months ahead. */
  MONTHS_AHEAD: 12,
} as const;

// ─── Shapes ─────────────────────────────────────────────────────

export type ArrangementAction = 'started' | 'paused' | 'resumed' | 'amount-changed' | 'ended';
export const ARRANGEMENT_ACTIONS: readonly ArrangementAction[] = ['started', 'paused', 'resumed', 'amount-changed', 'ended'];

/** One step of an arrangement's life, with its admin. `month` is the month it takes effect from (ended: the last month). */
export interface ArrangementEvent {
  at: string;
  action: ArrangementAction;
  actor: Actor;
  month: string;
  /** On started and amount-changed: the amount per month from `month`. */
  cents: number | null;
}

/** `direct_arrangements/{id}`, as written. */
export interface DirectArrangement {
  schemaVersion: number;
  propertyId: string;
  propertyNameAtStart: string | null;
  /** Who pays: a name as typed, nothing else about them. Never printed. */
  payerName: string;
  /** What the statement prints between the method's word and the day: "Monthly stay". */
  wording: string;
  /** 1–28: the day of each month it is due. Overdue from the day after. */
  dueDay: number;
  /** The first month expected. */
  fromMonth: string;
  /** The last month expected, once ended; null while it runs. */
  untilMonth: string | null;
  /** The amount per month, from a month on, oldest first; the first is from `fromMonth`. Earlier months keep theirs. */
  amounts: { from: string; cents: number }[];
  /** The months nothing is expected: from a month, until a month (null while paused), oldest first. */
  pauses: { from: string; until: string | null }[];
  createdAt: string;
  createdBy: Actor;
  history: ArrangementEvent[];
}
export type ArrangementView = DirectArrangement & { id: string };

export type PaymentAction = 'recorded' | 'applied' | 'removed';
export const PAYMENT_ACTIONS: readonly PaymentAction[] = ['recorded', 'applied', 'removed'];

/** The months a payment pays, as the admin set them; null pays the oldest unpaid month first (periods.ts). */
export type AppliesTo = { month: string; cents: number }[] | null;

export interface DirectPaymentEvent {
  at: string;
  action: PaymentAction;
  actor: Actor;
  /** On applied: the months it pays now (null: the oldest unpaid first). */
  appliesTo: AppliesTo;
}

/** `direct_payments/{64 hex}`, as written. */
export interface DirectPayment {
  schemaVersion: number;
  propertyId: string;
  propertyNameAtRecord: string | null;
  /** The arrangement it pays; null for a one-off payment. */
  arrangementId: string | null;
  purpose: DirectPurpose;
  /** Who paid, as typed; never printed. */
  payerName: string | null;
  /**
   * A one-off stay's dates: its first night and its checkout day (yyyy-mm-dd), 30 nights or more apart (Kian's
   * ruling). Kept as evidence of what the payment was for; never printed. null on every other payment.
   */
  stay: { from: string; to: string } | null;
  /** The day received, yyyy-mm-dd, Toronto: its month is the income month. */
  day: string;
  amountCents: number;
  currency: string;
  method: DirectMethod;
  /** The statement's middle words: "Monthly stay". */
  wording: string;
  note: string | null;
  appliesTo: AppliesTo;
  status: 'recorded' | 'removed';
  recordedAt: string;
  /** The admin who received it and recorded it (Kian's answer). */
  recordedBy: Actor;
  removedAt: string | null;
  removedBy: Actor | null;
  history: DirectPaymentEvent[];
}
export type DirectPaymentView = DirectPayment & { id: string };

// ─── Reading strictly ──────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';
const isTextOrNull = (value: unknown): value is string | null => value === null || typeof value === 'string';
const isTime = (value: unknown): value is string => isText(value) && Number.isFinite(Date.parse(value));
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isActor = (value: unknown): value is Actor => isRecord(value) && ['admin', 'cleaner', 'handyman', 'system'].includes(value.role as string) && isTextOrNull(value.id) && isTextOrNull(value.name);
const isCents = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= DIRECT_LIMITS.AMOUNT_MAX_CENTS;
const isMonthText = (value: unknown): value is string => isMonth(value);
const isMethod = (value: unknown): value is DirectMethod => typeof value === 'string' && (DIRECT_METHODS as readonly string[]).includes(value);
const isPurpose = (value: unknown): value is DirectPurpose => typeof value === 'string' && (DIRECT_PURPOSES as readonly string[]).includes(value);
/** A direct payment's ID: 64 lowercase hex, the shape a statement line keeps (`platformLineId`). */
export const DIRECT_PAYMENT_ID = /^[0-9a-f]{64}$/;

function readAppliesTo(value: unknown): AppliesTo | undefined {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const out: { month: string; cents: number }[] = [];
  for (const part of value) {
    if (!isRecord(part) || !isMonthText(part.month) || !isCents(part.cents)) return undefined;
    out.push({ month: part.month, cents: part.cents });
  }
  return out;
}

function readArrangementEvent(value: unknown): ArrangementEvent | null {
  if (!isRecord(value) || !isTime(value.at) || !ARRANGEMENT_ACTIONS.includes(value.action as ArrangementAction) || !isActor(value.actor) || !isMonthText(value.month)) return null;
  if (!(value.cents === null || isCents(value.cents))) return null;
  return { at: value.at, action: value.action as ArrangementAction, actor: value.actor, month: value.month, cents: value.cents as number | null };
}

/** A stored arrangement, read strictly: null when any field is not in the written shape. */
export function readArrangement(id: string, fields: Record<string, unknown>): ArrangementView | null {
  const { schemaVersion, propertyId, propertyNameAtStart, payerName, wording, dueDay, fromMonth, untilMonth, amounts, pauses, createdAt, createdBy, history } = fields;
  if (typeof schemaVersion !== 'number' || !isText(propertyId) || !isTextOrNull(propertyNameAtStart) || !isText(payerName) || !isText(wording)) return null;
  if (typeof dueDay !== 'number' || !Number.isInteger(dueDay) || dueDay < 1 || dueDay > DIRECT_LIMITS.DUE_DAY_MAX || !isMonthText(fromMonth) || !(untilMonth === null || isMonthText(untilMonth))) return null;
  if (!Array.isArray(amounts) || amounts.length === 0 || !Array.isArray(pauses) || !isTime(createdAt) || !isActor(createdBy) || !Array.isArray(history) || history.length === 0) return null;
  const readAmounts: { from: string; cents: number }[] = [];
  for (const a of amounts) {
    if (!isRecord(a) || !isMonthText(a.from) || !isCents(a.cents)) return null;
    readAmounts.push({ from: a.from, cents: a.cents });
  }
  if (readAmounts[0].from !== fromMonth || readAmounts.some((a, i) => i > 0 && a.from <= readAmounts[i - 1].from)) return null;
  const readPauses: { from: string; until: string | null }[] = [];
  for (const p of pauses) {
    if (!isRecord(p) || !isMonthText(p.from) || !(p.until === null || isMonthText(p.until))) return null;
    readPauses.push({ from: p.from, until: p.until as string | null });
  }
  // Only the last pause may still run, and pauses never overlap.
  if (readPauses.some((p, i) => (p.until === null && i !== readPauses.length - 1) || (p.until !== null && p.until < p.from) || (i > 0 && p.from <= (readPauses[i - 1].until ?? '')))) return null;
  const events = history.map(readArrangementEvent);
  if (events.some((e) => e === null)) return null;
  return {
    id,
    schemaVersion,
    propertyId,
    propertyNameAtStart,
    payerName,
    wording,
    dueDay,
    fromMonth,
    untilMonth: untilMonth as string | null,
    amounts: readAmounts,
    pauses: readPauses,
    createdAt,
    createdBy,
    history: events as ArrangementEvent[],
  };
}

function readPaymentEvent(value: unknown): DirectPaymentEvent | null {
  if (!isRecord(value) || !isTime(value.at) || !PAYMENT_ACTIONS.includes(value.action as PaymentAction) || !isActor(value.actor)) return null;
  const appliesTo = readAppliesTo(value.appliesTo);
  if (appliesTo === undefined) return null;
  return { at: value.at, action: value.action as PaymentAction, actor: value.actor, appliesTo };
}

/** A stored payment, read strictly: null when any field is not in the written shape. */
export function readDirectPayment(id: string, fields: Record<string, unknown>): DirectPaymentView | null {
  const { schemaVersion, propertyId, propertyNameAtRecord, arrangementId, purpose, payerName, day, amountCents, currency, method, wording, note, status, recordedAt, recordedBy, removedAt, removedBy, history } = fields;
  if (!DIRECT_PAYMENT_ID.test(id) || typeof schemaVersion !== 'number' || !isText(propertyId) || !isTextOrNull(propertyNameAtRecord) || !(arrangementId === null || isText(arrangementId))) return null;
  // An arrangement's payment is a monthly stay; a one-off payment never is.
  if (!isPurpose(purpose) || (arrangementId === null) === (purpose === 'monthly-stay') || !isTextOrNull(payerName)) return null;
  if (typeof day !== 'string' || !DAY.test(day) || !isCents(amountCents) || !isText(currency) || !isMethod(method) || !isText(wording) || !isTextOrNull(note)) return null;
  const appliesTo = readAppliesTo(fields.appliesTo);
  if (appliesTo === undefined || (appliesTo !== null && (arrangementId === null || appliesTo.reduce((sum, part) => sum + part.cents, 0) !== amountCents))) return null;
  // A one-off stay's payment keeps its stay, at least 30 nights; every other payment has none.
  const stay = fields.stay;
  if (purpose === 'long-stay' ? !isRecord(stay) || !isDay(stay.from) || !isDay(stay.to) || shortStayProblem({ from: stay.from, to: stay.to }) !== null : stay !== null) return null;
  if ((status !== 'recorded' && status !== 'removed') || !isTime(recordedAt) || !isActor(recordedBy)) return null;
  // Removed: always with when and who; recorded: never.
  if (status === 'removed' ? !isTime(removedAt) || !isActor(removedBy) : removedAt !== null || removedBy !== null) return null;
  if (!Array.isArray(history) || history.length === 0) return null;
  const events = history.map(readPaymentEvent);
  if (events.some((e) => e === null)) return null;
  return {
    id,
    schemaVersion,
    propertyId,
    propertyNameAtRecord,
    arrangementId: arrangementId as string | null,
    purpose,
    payerName,
    stay: isRecord(stay) ? { from: stay.from as string, to: stay.to as string } : null,
    day,
    amountCents,
    currency,
    method,
    wording,
    note,
    appliesTo,
    status,
    recordedAt,
    recordedBy,
    removedAt: (removedAt as string | null) ?? null,
    removedBy: (removedBy as Actor | null) ?? null,
    history: events as DirectPaymentEvent[],
  };
}

// ─── The statement's line ──────────────────────────────────────

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Oct 3". */
export function shortDay(day: string): string {
  const match = /^\d{4}-(\d{2})-(\d{2})$/.exec(day);
  return match ? `${SHORT_MONTHS[Number(match[1]) - 1]} ${Number(match[2])}` : day;
}

/** What the owner's statement prints for a payment (Kian's ruling): "Cash - Monthly stay - received Oct 3". Never the payer. */
export function directLineText(payment: Pick<DirectPayment, 'method' | 'wording' | 'day'>): string {
  return `${DIRECT_METHOD_WORDS[payment.method]} - ${payment.wording} - received ${shortDay(payment.day)}`;
}

/**
 * A recorded payment as the statements read it, where it is stored, as a platform line (dispatch 37C's way): its
 * month is the month it was received; on a later statement than that month's it keeps its words, which already
 * print its day. null for a payment removed.
 */
export function directLineOf(payment: DirectPaymentView): PlatformLineInput | null {
  if (payment.status !== 'recorded') return null;
  return {
    id: payment.id,
    platform: 'direct',
    propertyId: payment.propertyId,
    month: monthOfDay(payment.day),
    payoutDate: payment.day,
    stay: { start: null, end: null },
    fileRow: 0,
    description: directLineText(payment),
    amountCents: payment.amountCents,
    seen: payment.history.length,
  };
}

/** Every recorded payment as statement lines. */
export function directLinesOf(payments: readonly DirectPaymentView[]): PlatformLineInput[] {
  return payments.map(directLineOf).filter((line): line is PlatformLineInput => line !== null);
}

// ─── Days and months ───────────────────────────────────────────

/** Why a day received is refused, or null: a real day, never after `today`, at most 12 months before it (Toronto days). */
export function receivedDayProblem(day: string, today: string): string | null {
  if (!DAY.test(day)) return 'Write the day as yyyy-mm-dd.';
  const [year, month, date] = day.split('-').map(Number);
  if (new Date(Date.UTC(year, month - 1, date)).toISOString().slice(0, 10) !== day) return 'Not a real calendar date.';
  if (day > today) return 'The day received cannot be in the future.';
  if (day < earliestPaymentDay(today)) return 'The day received must be within the last 12 months.';
  return null;
}

/** The months an arrangement can start, pause, resume, change or end in: 12 back to 12 ahead of today's. */
export function arrangementMonthRange(today: string): { first: string; last: string } {
  const now = monthOfDay(today);
  return { first: addMonths(now, -DIRECT_LIMITS.MONTHS_BACK), last: addMonths(now, DIRECT_LIMITS.MONTHS_AHEAD) };
}

/** A stay's nights: from its first night to its checkout day. */
export function stayNights(stay: { from: string; to: string }): number {
  return nightsBetween(stay.from, stay.to);
}

/**
 * Why a stay cannot be recorded, or null (Kian's rulings: no direct short stay until his accountant confirms its tax
 * treatment; the threshold is 30 nights): real days, a checkout after the first night, and 30 nights or more.
 */
export function shortStayProblem(stay: { from: string; to: string } | null): string | null {
  if (stay === null) return 'Give the stay its first night and its checkout day.';
  if (!isDay(stay.from) || !isDay(stay.to)) return 'Write the stay\'s days as yyyy-mm-dd.';
  if (stay.to <= stay.from) return 'The checkout day comes after the first night.';
  const nights = stayNights(stay);
  if (nights < DIRECT_LIMITS.STAY_NIGHTS_MIN) return `${rangeText(stay.from, stay.to)} is ${nights} ${nights === 1 ? 'night' : 'nights'}: a stay under ${DIRECT_LIMITS.STAY_NIGHTS_MIN} nights is a short stay, not recorded until its tax treatment is confirmed.`;
  return null;
}

/** "the 20th". */
export function dueDayWords(day: number): string {
  const suffix = day % 10 === 1 && day !== 11 ? 'st' : day % 10 === 2 && day !== 12 ? 'nd' : day % 10 === 3 && day !== 13 ? 'rd' : 'th';
  return `the ${day}${suffix}`;
}

/** "the payment of $300.00 received Oct 3 (cash)": how a refusal names a payment. */
export function directPaymentWords(payment: Pick<DirectPayment, 'amountCents' | 'day' | 'method'>): string {
  return `the payment of ${formatCents(payment.amountCents)} received ${shortDay(payment.day)} (${DIRECT_METHOD_LABELS[payment.method].toLowerCase()})`;
}

/** "Sep $600.00, Oct $400.00". */
export function appliesToWords(parts: readonly { month: string; cents: number }[]): string {
  return parts.map((part) => `${monthLabel(part.month).slice(0, 3)} ${formatCents(part.cents)}`).join(', ');
}
