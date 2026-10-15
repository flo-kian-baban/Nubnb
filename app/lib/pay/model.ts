/**
 * Team pay, the payment (Kian's rulings of 2026-10-15, in CLAUDE.md under *Team pay*; the design is
 * TEAM-PAY-PLAN.md): as stored, and as pages read it. Client-safe: no server imports.
 *
 * `team_payments/{paymentId}`, server-only (firestore.rules denies every browser): one payment an admin recorded to a
 * team member — a cleaner or a handyman — with the amount, the day paid, how (e-transfer, cash, other), an optional
 * note, and the admin who recorded it (ruling 2). There are no pay periods: each person has a running balance
 * (balance.ts, ruling 3).
 *
 * A payment is never edited: a wrong one is deleted and recorded again. Deleting marks it `deleted` with who and
 * when; it is never erased, and the person's history keeps it (ruling 4). Every document keeps the shape it was
 * written with: the reader is strict, and a payment not in shape is reported, never guessed at.
 */

import { formatCents, type Actor } from '@/app/lib/cleaners/model';

export const TEAM_PAYMENTS_COLLECTION = 'team_payments';
export const PAYMENT_SCHEMA_VERSION = 1;

/** How a payment went out (ruling 2). */
export const PAYMENT_METHODS = ['e-transfer', 'cash', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = { 'e-transfer': 'E-transfer', cash: 'Cash', other: 'Other' };

export const PAYMENT_LIMITS = {
  /** One payment: more than $0.00, at most $999,999.99. */
  AMOUNT_MAX_CENTS: 99_999_999,
  NOTE_MAX: 500,
  /** The day paid is never after today, and at most this many months before it (Toronto): the purchase dates' rule. */
  MONTHS_BACK: 12,
} as const;

export interface PaymentEvent {
  at: string;
  action: 'recorded' | 'deleted';
  actor: Actor;
}

/** `team_payments/{paymentId}`, as written. */
export interface Payment {
  schemaVersion: number;
  /** The cleaners/{id} paid: a cleaner or a handyman, active or deactivated. */
  memberId: string;
  /** Their name then, so a payment still reads by it once the account is gone. */
  memberNameAtPayment: string | null;
  amountCents: number;
  currency: string;
  /** The day paid, yyyy-mm-dd, Toronto, as the admin typed it. */
  day: string;
  method: PaymentMethod;
  note: string | null;
  status: 'recorded' | 'deleted';
  recordedAt: string;
  recordedBy: Actor;
  deletedAt: string | null;
  deletedBy: Actor | null;
  history: PaymentEvent[];
}

export type PaymentView = Payment & { id: string };

// ─── Reading strictly ──────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';
const isTextOrNull = (value: unknown): value is string | null => value === null || typeof value === 'string';
const isTime = (value: unknown): value is string => isText(value) && Number.isFinite(Date.parse(value));
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isActor = (value: unknown): value is Actor => isRecord(value) && ['admin', 'cleaner', 'handyman', 'system'].includes(value.role as string) && isTextOrNull(value.id) && isTextOrNull(value.name);
const isCents = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= PAYMENT_LIMITS.AMOUNT_MAX_CENTS;
const isMethod = (value: unknown): value is PaymentMethod => typeof value === 'string' && (PAYMENT_METHODS as readonly string[]).includes(value);

function readEvent(value: unknown): PaymentEvent | null {
  if (!isRecord(value) || !isTime(value.at) || (value.action !== 'recorded' && value.action !== 'deleted') || !isActor(value.actor)) return null;
  return { at: value.at, action: value.action, actor: value.actor };
}

/** A stored payment, read strictly: null when any field is not in the written shape. */
export function readPayment(id: string, fields: Record<string, unknown>): PaymentView | null {
  const { schemaVersion, memberId, memberNameAtPayment, amountCents, currency, day, method, note, status, recordedAt, recordedBy, deletedAt, deletedBy, history } = fields;
  if (typeof schemaVersion !== 'number' || !isText(memberId) || !isTextOrNull(memberNameAtPayment) || !isCents(amountCents) || !isText(currency)) return null;
  if (typeof day !== 'string' || !DAY.test(day) || !isMethod(method) || !isTextOrNull(note)) return null;
  if ((status !== 'recorded' && status !== 'deleted') || !isTime(recordedAt) || !isActor(recordedBy)) return null;
  // Deleted: always with when and who; recorded: never.
  if (status === 'deleted' ? !isTime(deletedAt) || !isActor(deletedBy) : deletedAt !== null || deletedBy !== null) return null;
  if (!Array.isArray(history)) return null;
  const events = history.map(readEvent);
  if (events.length === 0 || events.some((event) => event === null)) return null;
  return {
    id,
    schemaVersion,
    memberId,
    memberNameAtPayment,
    amountCents,
    currency,
    day,
    method,
    note,
    status,
    recordedAt,
    recordedBy,
    deletedAt: (deletedAt as string | null) ?? null,
    deletedBy: (deletedBy as Actor | null) ?? null,
    history: events as PaymentEvent[],
  };
}

// ─── The day paid ──────────────────────────────────────────────

/** `day` moved `months` back, the day of the month kept where it can be: the purchase dates' arithmetic. */
function monthsBefore(day: string, months: number): string {
  const [year, month, date] = day.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 - months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(date, lastDay));
  return target.toISOString().slice(0, 10);
}

/** The earliest day a payment can be dated, given today: 12 months back, as purchase dates. */
export function earliestPaymentDay(today: string): string {
  return monthsBefore(today, PAYMENT_LIMITS.MONTHS_BACK);
}

/** Why a day paid is refused, or null: a real day, never after `today`, at most 12 months before it (Toronto days). */
export function paymentDayProblem(day: string, today: string): string | null {
  if (!DAY.test(day)) return 'Write the date as yyyy-mm-dd.';
  const [year, month, date] = day.split('-').map(Number);
  if (new Date(Date.UTC(year, month - 1, date)).toISOString().slice(0, 10) !== day) return 'Not a real calendar date.';
  if (day > today) return 'The day paid cannot be in the future.';
  if (day < monthsBefore(today, PAYMENT_LIMITS.MONTHS_BACK)) return `The day paid must be within the last ${PAYMENT_LIMITS.MONTHS_BACK} months.`;
  return null;
}

// ─── In words ──────────────────────────────────────────────────

/** "Oct 20", Toronto day as written. */
const dayWords = (day: string) => new Intl.DateTimeFormat('en-CA', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`));

/** "the payment of $300.00 on Oct 20 (e-transfer)": how a refusal names a payment (Kian's ruling of 2026-10-15). */
export function paymentWords(payment: Pick<Payment, 'amountCents' | 'day' | 'method'>): string {
  return `the payment of ${formatCents(payment.amountCents)} on ${dayWords(payment.day)} (${PAYMENT_METHOD_LABELS[payment.method].toLowerCase()})`;
}

