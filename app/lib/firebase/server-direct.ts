/**
 * Direct payments on the server (part B of PROPERTY-LIST-COLUMNS-PLAN.md; Kian's rulings of 2026-10-15): arrangements
 * started and changed, payments recorded, re-applied and removed, by any admin, and the recorded payments every
 * statement reads where they are stored.
 *
 * `direct_arrangements` and `direct_payments` are reached only through the Admin SDK, behind the admin session (the
 * routes under /api/admin/direct); firestore.rules denies every browser.
 *
 * ── Writes ──
 * Each in one transaction that refuses unless the document's history is the length the page saw (409), never
 * erasing anything: an arrangement is changed by a step in its history (paused, resumed, amount changed, ended); a
 * payment is recorded whole with `create()`, re-applied to other months, or removed (kept, struck through, out of
 * totals). A payment printed on a current finished statement is locked: removing it is refused, naming the
 * statement, until that statement is being corrected (Kian's ruling: it changes only by correcting that statement).
 * Re-applying it changes no statement, which prints it by the day received, so it is never locked.
 *
 * Failure contract: the reads throw when a read fails; the writes return a result naming what happened, "may or may
 * not have landed" included, and never throw.
 */

import { randomBytes } from 'crypto';
import type { Transaction } from 'firebase-admin/firestore';
import { getAdminDb } from './admin';
import { CURRENCY, fieldText, type Actor, type Refusal } from '@/app/lib/cleaners/model';
import { addDays, torontoDay } from '@/app/lib/availability/days';
import {
  DIRECT_ARRANGEMENTS_COLLECTION,
  DIRECT_LIMITS,
  DIRECT_PAYMENTS_COLLECTION,
  DIRECT_SCHEMA_VERSION,
  arrangementMonthRange,
  directLinesOf,
  readArrangement,
  readDirectPayment,
  receivedDayProblem,
  shortStayProblem,
  type AppliesTo,
  type ArrangementView,
  type DirectArrangement,
  type DirectMethod,
  type DirectPayment,
  type DirectPaymentView,
  type OneOffPurpose,
} from '@/app/lib/direct/model';
import { isExpectedMonth } from '@/app/lib/direct/periods';
import { changedArrangement, type ArrangementChange } from '@/app/lib/direct/changes';
import { DIRECT_PAYMENT_ID } from '@/app/lib/direct/model';
import { MONTHLY_REPORTS_COLLECTION, MONTHLY_REPORT_DRAFTS_COLLECTION, currentReports, displayRef, monthLabel, readMonthlyReport, readStatementDraft } from '@/app/lib/reports/model';
import { printedPlatformLines, type PlatformLineInput } from '@/app/lib/reports/statement';

function grpcCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? String(code) : typeof code === 'string' ? code : 'unknown';
}

type Docs = { id: string; data: () => Record<string, unknown> }[];

function readAll<T>(docs: Docs, read: (id: string, fields: Record<string, unknown>) => T | null, what: string): { items: T[]; unreadable: number } {
  const items: T[] = [];
  let unreadable = 0;
  for (const doc of docs) {
    const item = read(doc.id, doc.data());
    if (item) items.push(item);
    else {
      unreadable += 1;
      console.error(`[direct] ${what}/${doc.id} is not in the written shape; left out`);
    }
  }
  return { items, unreadable };
}

// ─── Reads ─────────────────────────────────────────────────────

export interface DirectRead {
  arrangements: ArrangementView[];
  payments: DirectPaymentView[];
  unreadable: number;
}

/** Every arrangement and payment, or one property's. One read per document. @throws if a read fails. */
export async function readDirect(propertyId?: string): Promise<DirectRead> {
  const db = getAdminDb();
  const arrangementsQuery = propertyId ? db.collection(DIRECT_ARRANGEMENTS_COLLECTION).where('propertyId', '==', propertyId) : db.collection(DIRECT_ARRANGEMENTS_COLLECTION);
  const paymentsQuery = propertyId ? db.collection(DIRECT_PAYMENTS_COLLECTION).where('propertyId', '==', propertyId) : db.collection(DIRECT_PAYMENTS_COLLECTION);
  const [arrangementsSnap, paymentsSnap] = await Promise.all([arrangementsQuery.get(), paymentsQuery.get()]);
  const arrangements = readAll(arrangementsSnap.docs, readArrangement, DIRECT_ARRANGEMENTS_COLLECTION);
  const payments = readAll(paymentsSnap.docs, readDirectPayment, DIRECT_PAYMENTS_COLLECTION);
  arrangements.items.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  payments.items.sort((a, b) => b.day.localeCompare(a.day) || b.recordedAt.localeCompare(a.recordedAt) || a.id.localeCompare(b.id));
  return { arrangements: arrangements.items, payments: payments.items, unreadable: arrangements.unreadable + payments.unreadable };
}

/**
 * The recorded payments as statement lines (a platform line each, `direct`), every property's or one's, inside a
 * transaction when given one: Finish reads them there with the property's other platform lines. One read per payment.
 */
export async function directPlatformLines(propertyId?: string, tx?: Transaction): Promise<PlatformLineInput[]> {
  const db = getAdminDb();
  const query = propertyId ? db.collection(DIRECT_PAYMENTS_COLLECTION).where('propertyId', '==', propertyId) : db.collection(DIRECT_PAYMENTS_COLLECTION);
  const snap = tx ? await tx.get(query) : await query.get();
  return directLinesOf(readAll(snap.docs, readDirectPayment, DIRECT_PAYMENTS_COLLECTION).items);
}

// ─── Arrangements ──────────────────────────────────────────────

export interface NewArrangement {
  propertyId: string;
  payerName: string;
  wording: string;
  cents: number;
  dueDay: number;
  fromMonth: string;
}

export type ArrangementResult =
  | { kind: 'saved'; arrangement: ArrangementView }
  | { kind: 'no-such-property' }
  | { kind: 'not-found' }
  | { kind: 'changed-since' }
  | { kind: 'unreadable' }
  | { kind: 'refused'; problem: string }
  | { kind: 'failed' };

export const ARRANGEMENT_REFUSALS: Record<Exclude<ArrangementResult['kind'], 'saved' | 'refused'>, Refusal> = {
  'no-such-property': { status: 404, code: 'PROPERTY_NOT_FOUND', message: 'Property not found.', hint: 'Nothing was saved.' },
  'not-found': { status: 404, code: 'ARRANGEMENT_NOT_FOUND', message: 'No such arrangement.', hint: 'Reload the page.' },
  'changed-since': { status: 409, code: 'ARRANGEMENT_CHANGED', message: 'This arrangement changed since the page loaded.', hint: 'Nothing was saved. Reload, check what changed, and try again.' },
  unreadable: { status: 500, code: 'ARRANGEMENT_UNREADABLE', message: 'This arrangement is not in the shape a change needs.', hint: 'Nothing was saved.' },
  failed: { status: 502, code: 'ARRANGEMENT_SAVE_FAILED', message: 'Could not save the arrangement.', hint: 'It may or may not have been saved. Reload to see.' },
};

const inRange = (month: string, today: string) => {
  const { first, last } = arrangementMonthRange(today);
  return month >= first && month <= last;
};

/** Start an arrangement, by the admin `actor`. */
export async function startArrangement(actor: Actor, input: NewArrangement, now: Date = new Date()): Promise<ArrangementResult> {
  const today = torontoDay(now);
  if (!inRange(input.fromMonth, today)) return { kind: 'refused', problem: 'An arrangement starts within 12 months of this one.' };
  const db = getAdminDb();
  const ref = db.collection(DIRECT_ARRANGEMENTS_COLLECTION).doc();
  try {
    return await db.runTransaction(async (tx): Promise<ArrangementResult> => {
      const [property] = await tx.getAll(db.collection('properties').doc(input.propertyId), { fieldMask: ['name'] });
      if (!property.exists) return { kind: 'no-such-property' };
      const at = now.toISOString();
      const arrangement: DirectArrangement = {
        schemaVersion: DIRECT_SCHEMA_VERSION,
        propertyId: input.propertyId,
        propertyNameAtStart: fieldText(property.get('name')),
        payerName: input.payerName,
        wording: input.wording,
        dueDay: input.dueDay,
        fromMonth: input.fromMonth,
        untilMonth: null,
        amounts: [{ from: input.fromMonth, cents: input.cents }],
        pauses: [],
        createdAt: at,
        createdBy: actor,
        history: [{ at, action: 'started', actor, month: input.fromMonth, cents: input.cents }],
      };
      tx.create(ref, arrangement);
      return { kind: 'saved', arrangement: { ...arrangement, id: ref.id } };
    });
  } catch (err) {
    console.error(`[direct] starting an arrangement failed: grpc code ${grpcCode(err)}`);
    return { kind: 'failed' };
  }
}

export type { ArrangementChange };

/** Change an arrangement as the admin saw it (`seen`: its history's length). */
export async function changeArrangement(actor: Actor, id: string, seen: number, change: ArrangementChange, now: Date = new Date()): Promise<ArrangementResult> {
  const db = getAdminDb();
  const ref = db.collection(DIRECT_ARRANGEMENTS_COLLECTION).doc(id);
  try {
    return await db.runTransaction(async (tx): Promise<ArrangementResult> => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { kind: 'not-found' };
      const arrangement = readArrangement(snap.id, snap.data() ?? {});
      if (!arrangement) return { kind: 'unreadable' };
      if (arrangement.history.length !== seen) return { kind: 'changed-since' };
      const at = now.toISOString();
      const outcome = changedArrangement(arrangement, change, actor, at, torontoDay(now));
      if ('problem' in outcome) return { kind: 'refused', problem: outcome.problem };
      tx.update(ref, outcome.next);
      return { kind: 'saved', arrangement: { ...arrangement, ...outcome.next } };
    });
  } catch (err) {
    console.error(`[direct] changing arrangement ${id} failed: grpc code ${grpcCode(err)}`);
    return { kind: 'failed' };
  }
}

// ─── Payments ──────────────────────────────────────────────────

export interface NewDirectPayment {
  propertyId: string;
  arrangementId: string | null;
  purpose: OneOffPurpose | null;
  payerName: string | null;
  /** A one-off stay's dates (Kian's rulings: 30 nights or more). */
  stay: { from: string; to: string } | null;
  day: string;
  cents: number;
  method: DirectMethod;
  wording: string;
  note: string | null;
  appliesTo: AppliesTo;
}

export type PaymentResult =
  | { kind: 'saved'; payment: DirectPaymentView }
  | { kind: 'no-such-property' }
  | { kind: 'no-such-arrangement' }
  | { kind: 'not-found' }
  | { kind: 'changed-since' }
  | { kind: 'unreadable' }
  | { kind: 'already-removed' }
  | { kind: 'locked'; reference: string; month: string }
  | { kind: 'refused'; problem: string }
  | { kind: 'failed' };

export const PAYMENT_REFUSALS: Record<Exclude<PaymentResult['kind'], 'saved' | 'refused' | 'locked'>, Refusal> = {
  'no-such-property': { status: 404, code: 'PROPERTY_NOT_FOUND', message: 'Property not found.', hint: 'Nothing was recorded.' },
  'no-such-arrangement': { status: 404, code: 'ARRANGEMENT_NOT_FOUND', message: 'That arrangement is not this property\'s, or does not exist.', hint: 'Nothing was recorded. Reload the page.' },
  'not-found': { status: 404, code: 'DIRECT_PAYMENT_NOT_FOUND', message: 'No such payment.', hint: 'Reload the page.' },
  'changed-since': { status: 409, code: 'DIRECT_PAYMENT_CHANGED', message: 'This payment changed since the page loaded.', hint: 'Nothing was changed. Reload, check what changed, and try again.' },
  unreadable: { status: 500, code: 'DIRECT_PAYMENT_UNREADABLE', message: 'This payment, or a record it needs, is not in the written shape.', hint: 'Nothing was changed.' },
  'already-removed': { status: 409, code: 'DIRECT_PAYMENT_REMOVED', message: 'This payment is already removed.', hint: 'Nothing was changed.' },
  failed: { status: 502, code: 'DIRECT_PAYMENT_SAVE_FAILED', message: 'Could not save the payment.', hint: 'It may or may not have been saved. Reload to see before recording it again.' },
};

/** Why the months set for a payment cannot be: each must be one the arrangement expects (now or later). */
function appliesToProblem(arrangement: ArrangementView, appliesTo: AppliesTo): string | null {
  if (appliesTo === null) return null;
  const bad = appliesTo.find((part) => !isExpectedMonth(arrangement, part.month));
  return bad ? `${monthLabel(bad.month)} is not a month this arrangement expects.` : null;
}

/** Record a payment received, by the admin `actor`, who received it (Kian's answer). */
export async function recordDirectPayment(actor: Actor, input: NewDirectPayment, now: Date = new Date()): Promise<PaymentResult> {
  const problem = receivedDayProblem(input.day, torontoDay(now));
  if (problem) return { kind: 'refused', problem };
  // No direct short stay is recorded (Kian's rulings): a one-off stay is 30 nights or more, its dates near today.
  if (input.arrangementId === null && input.purpose === 'long-stay') {
    const short = shortStayProblem(input.stay);
    if (short) return { kind: 'refused', problem: short };
    const today = torontoDay(now);
    if (input.stay && (input.stay.from < addDays(today, -DIRECT_LIMITS.STAY_DAYS_RANGE) || input.stay.to > addDays(today, DIRECT_LIMITS.STAY_DAYS_RANGE))) return { kind: 'refused', problem: 'The stay\'s days must be within two years of today.' };
  }
  const db = getAdminDb();
  const ref = db.collection(DIRECT_PAYMENTS_COLLECTION).doc(randomBytes(32).toString('hex'));
  try {
    return await db.runTransaction(async (tx): Promise<PaymentResult> => {
      const [property] = await tx.getAll(db.collection('properties').doc(input.propertyId), { fieldMask: ['name'] });
      if (!property.exists) return { kind: 'no-such-property' };
      let arrangement: ArrangementView | null = null;
      if (input.arrangementId !== null) {
        const snap = await tx.get(db.collection(DIRECT_ARRANGEMENTS_COLLECTION).doc(input.arrangementId));
        if (!snap.exists) return { kind: 'no-such-arrangement' };
        arrangement = readArrangement(snap.id, snap.data() ?? {});
        if (!arrangement) return { kind: 'unreadable' };
        if (arrangement.propertyId !== input.propertyId) return { kind: 'no-such-arrangement' };
        const bad = appliesToProblem(arrangement, input.appliesTo);
        if (bad) return { kind: 'refused', problem: bad };
      }
      const at = now.toISOString();
      const payment: DirectPayment = {
        schemaVersion: DIRECT_SCHEMA_VERSION,
        propertyId: input.propertyId,
        propertyNameAtRecord: fieldText(property.get('name')),
        arrangementId: input.arrangementId,
        purpose: arrangement ? 'monthly-stay' : (input.purpose as OneOffPurpose),
        payerName: arrangement ? arrangement.payerName : input.payerName,
        stay: !arrangement && input.purpose === 'long-stay' ? input.stay : null,
        day: input.day,
        amountCents: input.cents,
        currency: CURRENCY,
        method: input.method,
        wording: input.wording,
        note: input.note,
        appliesTo: input.appliesTo,
        status: 'recorded',
        recordedAt: at,
        recordedBy: actor,
        removedAt: null,
        removedBy: null,
        history: [{ at, action: 'recorded', actor, appliesTo: input.appliesTo }],
      };
      tx.create(ref, payment);
      return { kind: 'saved', payment: { ...payment, id: ref.id } };
    });
  } catch (err) {
    console.error(`[direct] recording a payment failed: grpc code ${grpcCode(err)}`);
    return { kind: 'failed' };
  }
}

/**
 * Which current finished statement locks a payment: one that prints it and is not being corrected. Read in the
 * transaction: the property's statements and drafts. null when none does.
 */
async function lockOf(tx: Transaction, propertyId: string, paymentId: string): Promise<{ reference: string; month: string } | 'unreadable' | null> {
  const db = getAdminDb();
  const [reportsSnap, draftsSnap] = await Promise.all([tx.get(db.collection(MONTHLY_REPORTS_COLLECTION).where('propertyId', '==', propertyId)), tx.get(db.collection(MONTHLY_REPORT_DRAFTS_COLLECTION).where('propertyId', '==', propertyId))]);
  const reports = readAll(reportsSnap.docs, readMonthlyReport, MONTHLY_REPORTS_COLLECTION);
  const drafts = readAll(draftsSnap.docs, readStatementDraft, MONTHLY_REPORT_DRAFTS_COLLECTION);
  if (reports.unreadable > 0) return 'unreadable';
  const current = currentReports(reports.items);
  const printed = printedPlatformLines(current).get(paymentId);
  if (!printed) return null;
  const correcting = drafts.items.some((d) => d.finishedAs === null && d.supersedes?.reportId === printed.reportId);
  if (correcting) return null;
  const report = current.find((r) => r.id === printed.reportId);
  return { reference: report ? displayRef(report) : printed.reportId, month: printed.month };
}

export type PaymentChange = { action: 'remove' } | { action: 'apply'; appliesTo: AppliesTo };

/** Remove a payment, or set the months it pays, as the admin saw it (`seen`: its history's length). */
export async function changeDirectPayment(actor: Actor, id: string, seen: number, change: PaymentChange, now: Date = new Date()): Promise<PaymentResult> {
  if (!DIRECT_PAYMENT_ID.test(id)) return { kind: 'not-found' };
  const db = getAdminDb();
  const ref = db.collection(DIRECT_PAYMENTS_COLLECTION).doc(id);
  try {
    return await db.runTransaction(async (tx): Promise<PaymentResult> => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { kind: 'not-found' };
      const payment = readDirectPayment(snap.id, snap.data() ?? {});
      if (!payment) return { kind: 'unreadable' };
      if (payment.history.length !== seen) return { kind: 'changed-since' };
      if (payment.status === 'removed') return { kind: 'already-removed' };
      const at = now.toISOString();
      if (change.action === 'remove') {
        const lock = await lockOf(tx, payment.propertyId, payment.id);
        if (lock === 'unreadable') return { kind: 'unreadable' };
        if (lock) return { kind: 'locked', ...lock };
        const next = { status: 'removed' as const, removedAt: at, removedBy: actor, history: [...payment.history, { at, action: 'removed' as const, actor, appliesTo: payment.appliesTo }] };
        tx.update(ref, next);
        return { kind: 'saved', payment: { ...payment, ...next } };
      }
      if (payment.arrangementId === null) return { kind: 'refused', problem: 'A one-off payment pays no months.' };
      if (change.appliesTo !== null && change.appliesTo.reduce((sum, p) => sum + p.cents, 0) !== payment.amountCents) return { kind: 'refused', problem: 'The months add up to the whole amount.' };
      const arrangementSnap = await tx.get(db.collection(DIRECT_ARRANGEMENTS_COLLECTION).doc(payment.arrangementId));
      const arrangement = arrangementSnap.exists ? readArrangement(arrangementSnap.id, arrangementSnap.data() ?? {}) : null;
      if (!arrangement) return { kind: 'unreadable' };
      const bad = appliesToProblem(arrangement, change.appliesTo);
      if (bad) return { kind: 'refused', problem: bad };
      const next = { appliesTo: change.appliesTo, history: [...payment.history, { at, action: 'applied' as const, actor, appliesTo: change.appliesTo }] };
      tx.update(ref, next);
      return { kind: 'saved', payment: { ...payment, ...next } };
    });
  } catch (err) {
    console.error(`[direct] changing payment ${id.slice(0, 8)}… failed: grpc code ${grpcCode(err)}`);
    return { kind: 'failed' };
  }
}

/** The refusal for a locked payment: it names the statement (Kian's ruling: changed only by correcting it). */
export function lockedRefusal(lock: { reference: string; month: string }): Refusal {
  return { status: 409, code: 'DIRECT_PAYMENT_LOCKED', message: `It is printed on ${lock.reference}, ${monthLabel(lock.month)}'s finished statement, so it is locked.`, hint: 'Nothing was changed. Correct that statement to change it.' };
}
