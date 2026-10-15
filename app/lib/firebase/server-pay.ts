/**
 * Team pay on the server (Kian's rulings of 2026-10-15, in CLAUDE.md under *Team pay*; TEAM-PAY-PLAN.md): payments
 * recorded and deleted by any admin, the payment an item's delete is refused for, and one person's own pay.
 *
 * `team_payments` is reached only through the Admin SDK: the admin routes under /api/admin/payments, behind the admin
 * session, and the cleaner app's start call, which reads only that person's own. firestore.rules denies every browser.
 *
 * ── Writes ──
 * A payment is recorded whole with `create()`, inside a transaction that first reads the team member it is for: a
 * cleaner or a handyman, active or deactivated. It is never edited. Deleting one marks it `deleted` with who and when,
 * in a transaction that refuses unless its history is the length the page saw (409); it is never erased, and the
 * person's history keeps it (ruling 4).
 *
 * ── Items dated on or before a payment (Kian's ruling of 2026-10-15) ──
 * A cleaning, receipt or work entry dated on or before a payment to its person cannot be deleted; it can be removed.
 * `paymentOnOrAfter` finds, inside the delete's transaction, the earliest payment to them dated on or after the item:
 * the one the refusal names. Deleted payments do not count. A payment of theirs not in the written shape refuses the
 * delete too: its day cannot be read.
 *
 * Failure contract: the reads throw when a read fails; the writes return a result naming what happened, "may or may
 * not have landed" included, and never throw.
 */

import type { Transaction } from 'firebase-admin/firestore';
import { getAdminDb } from './admin';
import { isDocumentId } from './server-leads';
import { CLEANERS_COLLECTION, COST_ENTRIES_COLLECTION, CURRENCY, fieldText, readCostEntryFields, readLinesNow, type Actor, type Refusal } from '@/app/lib/cleaners/model';
import { CLEANINGS_COLLECTION, readCleaning } from '@/app/lib/cleanings/model';
import { torontoDay } from '@/app/lib/availability/days';
import { memberPay, type MemberPay, type PayCleaning, type PayEntry, type PaySources } from '@/app/lib/pay/balance';
import { PAYMENT_SCHEMA_VERSION, TEAM_PAYMENTS_COLLECTION, paymentDayProblem, readPayment, type Payment, type PaymentMethod, type PaymentView } from '@/app/lib/pay/model';

function grpcCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? String(code) : typeof code === 'string' ? code : 'unknown';
}

/** Payments read strictly; one not in the written shape is logged by ID and counted. */
function readPayments(docs: { id: string; data: () => Record<string, unknown> }[]): { payments: PaymentView[]; unreadable: number } {
  const payments: PaymentView[] = [];
  let unreadable = 0;
  for (const doc of docs) {
    const payment = readPayment(doc.id, doc.data());
    if (payment) payments.push(payment);
    else {
      unreadable += 1;
      console.error(`[pay] ${TEAM_PAYMENTS_COLLECTION}/${doc.id} is not in the written shape; left out`);
    }
  }
  return { payments, unreadable };
}

// ─── Reads ─────────────────────────────────────────────────────

/** Every payment, recorded or deleted, newest first (the Team page). One read per payment. @throws if the read fails. */
export async function listPayments(): Promise<{ payments: PaymentView[]; unreadable: number }> {
  const snap = await getAdminDb().collection(TEAM_PAYMENTS_COLLECTION).get();
  const read = readPayments(snap.docs);
  read.payments.sort((a, b) => b.day.localeCompare(a.day) || b.recordedAt.localeCompare(a.recordedAt) || a.id.localeCompare(b.id));
  return read;
}

/** A stored cost entry as pay reads it, with no name lookups. */
function payEntryOf(id: string, fields: Record<string, unknown>): PayEntry {
  const entry = readCostEntryFields(id, fields);
  return {
    id,
    kind: entry.kind,
    status: entry.status,
    statusReason: entry.statusReason,
    createdAt: entry.createdAt,
    month: entry.month,
    paidWith: entry.paidWith,
    lines: entry.lines,
    history: entry.history,
    linesNow: readLinesNow(entry.lines, entry.history, { shape: entry.taxShape, cents: entry.taxCents }),
    taxShape: entry.taxShape,
    cleaner: { id: entry.cleanerId },
    property: { nameAtEntry: entry.propertyNameAtEntry, name: null },
  };
}

/**
 * One team member's cleanings, cost entries and payments, as pay reads them — inside a transaction when one is given
 * (deleting the member). Their entries can come from the caller, already read (the cleaner app's start call reads
 * them whole for its own use). `unreadable` counts the cleanings and payments of theirs not in the written shape: a
 * balance with any is never shown as whole.
 *
 * Reads: one per cleaning and payment of theirs, and one per entry unless given. @throws if a read fails.
 */
export async function memberPaySources(memberId: string, tx?: Transaction, entries?: { id: string; data: () => Record<string, unknown> }[]): Promise<{ sources: PaySources; unreadable: number }> {
  const db = getAdminDb();
  const cleaningsQuery = db.collection(CLEANINGS_COLLECTION).where('cleanerId', '==', memberId);
  const paymentsQuery = db.collection(TEAM_PAYMENTS_COLLECTION).where('memberId', '==', memberId);
  const entriesQuery = db.collection(COST_ENTRIES_COLLECTION).where('cleanerId', '==', memberId);
  const [cleaningsSnap, paymentsSnap, entriesSnap] = await Promise.all([
    tx ? tx.get(cleaningsQuery) : cleaningsQuery.get(),
    tx ? tx.get(paymentsQuery) : paymentsQuery.get(),
    entries ? null : tx ? tx.get(entriesQuery) : entriesQuery.get(),
  ]);
  let unreadable = 0;
  const cleanings: PayCleaning[] = [];
  for (const doc of cleaningsSnap.docs) {
    const cleaning = readCleaning(doc.id, doc.data());
    if (cleaning && cleaning.cleanerId === memberId) cleanings.push(cleaning);
    else if (!cleaning) {
      unreadable += 1;
      console.error(`[pay] cleanings/${doc.id} is not in the written shape; left out of a balance`);
    }
  }
  const payments = readPayments(paymentsSnap.docs);
  const entryDocs = entries ?? entriesSnap?.docs ?? [];
  return {
    sources: { cleanings, entries: entryDocs.map((doc) => payEntryOf(doc.id, doc.data())).filter((entry) => entry.cleaner.id === memberId), payments: payments.payments.filter((p) => p.memberId === memberId) },
    unreadable: unreadable + payments.unreadable,
  };
}

/** One person's pay, worked out by the one function (the cleaner app: their own figures only). @throws if a read fails. */
export async function memberPayNow(memberId: string, entries?: { id: string; data: () => Record<string, unknown> }[]): Promise<{ pay: MemberPay; unreadable: number }> {
  const { sources, unreadable } = await memberPaySources(memberId, undefined, entries);
  return { pay: memberPay(memberId, sources), unreadable };
}

// ─── Items dated on or before a payment ────────────────────────

export type PaymentOnOrAfter = { kind: 'none' } | { kind: 'payment'; payment: PaymentView } | { kind: 'unreadable' };

/**
 * Inside an item's delete (Kian's ruling of 2026-10-15): the earliest payment to `memberId`, not deleted, dated on or
 * after `day` — the one the refusal names. A read, so it runs before the transaction's first write. One read per
 * payment of theirs.
 */
export async function paymentOnOrAfter(tx: Transaction, memberId: string, day: string): Promise<PaymentOnOrAfter> {
  if (!isDocumentId(memberId)) return { kind: 'none' };
  const snap = await tx.get(getAdminDb().collection(TEAM_PAYMENTS_COLLECTION).where('memberId', '==', memberId));
  const { payments, unreadable } = readPayments(snap.docs);
  if (unreadable > 0) return { kind: 'unreadable' };
  const first = payments
    .filter((p) => p.memberId === memberId && p.status === 'recorded' && p.day >= day)
    .sort((a, b) => a.day.localeCompare(b.day) || a.recordedAt.localeCompare(b.recordedAt))[0];
  return first ? { kind: 'payment', payment: first } : { kind: 'none' };
}

// ─── Record ────────────────────────────────────────────────────

export interface NewPayment {
  memberId: string;
  amountCents: number;
  day: string;
  method: PaymentMethod;
  note: string | null;
}

export type RecordPaymentResult =
  | { kind: 'recorded'; payment: PaymentView }
  | { kind: 'no-such-member' }
  | { kind: 'bad-day'; problem: string }
  /** The transaction failed: it may or may not have been recorded. */
  | { kind: 'failed' };

export const RECORD_REFUSALS: Record<'no-such-member' | 'failed', Refusal> = {
  'no-such-member': { status: 404, code: 'MEMBER_NOT_FOUND', message: 'That team member does not exist.', hint: 'Nothing was recorded. Reload the Team page.' },
  failed: { status: 502, code: 'PAYMENT_RECORD_FAILED', message: 'Could not record the payment.', hint: 'It may or may not have been recorded. Reload their pay before recording it again.' },
};

/** Record a payment to a team member, by the admin `actor` (ruling 2). */
export async function recordPayment(actor: Actor, input: NewPayment, now: Date = new Date()): Promise<RecordPaymentResult> {
  if (!isDocumentId(input.memberId)) return { kind: 'no-such-member' };
  const problem = paymentDayProblem(input.day, torontoDay(now));
  if (problem) return { kind: 'bad-day', problem };
  const db = getAdminDb();
  const ref = db.collection(TEAM_PAYMENTS_COLLECTION).doc();
  try {
    return await db.runTransaction(async (tx): Promise<RecordPaymentResult> => {
      const member = await tx.get(db.collection(CLEANERS_COLLECTION).doc(input.memberId));
      if (!member.exists) return { kind: 'no-such-member' };
      const at = now.toISOString();
      const payment: Payment = {
        schemaVersion: PAYMENT_SCHEMA_VERSION,
        memberId: input.memberId,
        memberNameAtPayment: fieldText(member.get('name')),
        amountCents: input.amountCents,
        currency: CURRENCY,
        day: input.day,
        method: input.method,
        note: input.note,
        status: 'recorded',
        recordedAt: at,
        recordedBy: actor,
        deletedAt: null,
        deletedBy: null,
        history: [{ at, action: 'recorded', actor }],
      };
      tx.create(ref, payment);
      return { kind: 'recorded', payment: { ...payment, id: ref.id } };
    });
  } catch (err) {
    console.error(`[pay] recording a payment failed: grpc code ${grpcCode(err)}`);
    return { kind: 'failed' };
  }
}

// ─── Delete ────────────────────────────────────────────────────

export type DeletePaymentResult =
  | { kind: 'deleted'; payment: PaymentView }
  | { kind: 'not-found' }
  | { kind: 'changed-since' }
  | { kind: 'already-deleted' }
  | { kind: 'unreadable' }
  | { kind: 'failed' };

export const DELETE_PAYMENT_REFUSALS: Record<Exclude<DeletePaymentResult['kind'], 'deleted'>, Refusal> = {
  'not-found': { status: 404, code: 'PAYMENT_NOT_FOUND', message: 'No such payment.', hint: 'Reload their pay.' },
  'changed-since': { status: 409, code: 'PAYMENT_CHANGED', message: 'This payment changed since the page loaded.', hint: 'Nothing was deleted. Reload, check what changed, and delete again if you still mean to.' },
  'already-deleted': { status: 409, code: 'PAYMENT_ALREADY_DELETED', message: 'This payment is already deleted.', hint: 'Nothing was changed.' },
  unreadable: { status: 500, code: 'PAYMENT_UNREADABLE', message: 'This payment is not in the shape a delete needs.', hint: 'Nothing was changed.' },
  failed: { status: 502, code: 'PAYMENT_DELETE_FAILED', message: 'Could not delete the payment.', hint: 'It may or may not have been deleted. Reload their pay to see.' },
};

/**
 * Delete a payment, as the admin saw it (`seen`: its history's length): it is marked deleted with who and when, stops
 * counting as paid, and stays in the person's history (ruling 4). Never erased.
 */
export async function deletePayment(actor: Actor, id: string, seen: number, now: Date = new Date()): Promise<DeletePaymentResult> {
  if (!isDocumentId(id)) return { kind: 'not-found' };
  const db = getAdminDb();
  const ref = db.collection(TEAM_PAYMENTS_COLLECTION).doc(id);
  try {
    return await db.runTransaction(async (tx): Promise<DeletePaymentResult> => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { kind: 'not-found' };
      const payment = readPayment(snap.id, snap.data() ?? {});
      if (!payment) return { kind: 'unreadable' };
      if (payment.history.length !== seen) return { kind: 'changed-since' };
      if (payment.status === 'deleted') return { kind: 'already-deleted' };
      const at = now.toISOString();
      const next = { status: 'deleted' as const, deletedAt: at, deletedBy: actor, history: [...payment.history, { at, action: 'deleted' as const, actor }] };
      tx.update(ref, next);
      return { kind: 'deleted', payment: { ...payment, ...next } };
    });
  } catch (err) {
    console.error(`[pay] deleting payment ${id} failed: grpc code ${grpcCode(err)}`);
    return { kind: 'failed' };
  }
}
