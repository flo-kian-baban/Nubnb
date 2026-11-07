/**
 * The daily wrong-try budget across all connections, server side (Kian's rulings of 2026-11-06; the rules are in
 * app/lib/admins/budget.ts). One document per door per Toronto day, `signin_budgets/{door}-{yyyy-mm-dd}`:
 *
 *   schemaVersion, door, dayKey
 *   wrong          wrong tries checked at the door that day, every connection together
 *   base           the count at the last Lift: the budget is spent when wrong − base reaches the door's threshold
 *   spentAt        when it was spent; null when it is not, or was lifted since
 *   lastWrongAt
 *   email          the one email sent when it was last spent: { at, status, detail, wrong }
 *   lifts          [{ at, actor, atWrong }]: each Lift, who, and the count then
 *
 * The doors read the budget inside their sign-in transaction, only when the try is wrong and before any write, so a
 * right try costs no extra read; a wrong try reads one more document and writes it. The connection a spent budget
 * locks carries `budgetLocked: <day>` on its lock document beside the ordinary `lockedUntil` (Toronto midnight), so
 * the pages can say why and Lift can unlock exactly those, their counts kept.
 *
 * The email goes after the response (next/server's after(), from the routes), through the office transport
 * (app/lib/mail/office.ts); its outcome is recorded on the budget document. It names the count and the door, never a
 * code or PIN. Firestore errors are logged as a gRPC code only. Reached only through the Admin SDK: firestore.rules'
 * catch-all denies every browser read and write of the collection.
 */

import { FieldValue, type DocumentReference, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { getAdminDb } from './admin';
import { ADMIN_SIGNIN_LOCKS_COLLECTION, torontoDayOf } from '@/app/lib/admins/model';
import {
  BUDGET_SCHEMA_VERSION,
  DAILY_BUDGET,
  SIGNIN_BUDGETS_COLLECTION,
  afterWrongOnBudget,
  budgetDocId,
  budgetEmail,
  budgetSpent,
  liftedBudget,
  type BudgetState,
  type BudgetView,
  type Door,
} from '@/app/lib/admins/budget';
import { CLEANER_SIGNIN_LOCKS_COLLECTION, type Actor } from '@/app/lib/cleaners/model';
import { mailOffice } from '@/app/lib/mail/office';

const LOCKS: Record<Door, string> = { cleaner: CLEANER_SIGNIN_LOCKS_COLLECTION, admin: ADMIN_SIGNIN_LOCKS_COLLECTION };

const grpcCode = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? String(code) : 'unknown';
};
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** The stored document as the rules read it; a missing document is no budget spent. */
export function budgetStateOf(data: Record<string, unknown> | undefined): BudgetState {
  if (!data) return { dayKey: null, wrong: 0, base: 0, spentAt: null };
  return { dayKey: text(data.dayKey), wrong: num(data.wrong), base: num(data.base), spentAt: text(data.spentAt) };
}

/** The day's budget, read inside a door's transaction before its writes. */
export interface BudgetRead {
  ref: DocumentReference;
  state: BudgetState;
  /** Spent when this try came: the connection is locked until tomorrow. */
  spent: boolean;
}

export async function readBudget(tx: Transaction, db: Firestore, door: Door, nowMs: number): Promise<BudgetRead> {
  const ref = db.collection(SIGNIN_BUDGETS_COLLECTION).doc(budgetDocId(door, torontoDayOf(nowMs)));
  const snap = await tx.get(ref);
  const state = budgetStateOf(snap.data());
  return { ref, state, spent: budgetSpent(state, door, nowMs) };
}

/** This try spent the day's budget: the one email goes, after the response. */
export interface BudgetReached {
  door: Door;
  wrong: number;
  dayKey: string;
}

/** One more wrong try on the day's budget, inside the transaction after its reads. Returns the threshold crossing, when this try is it. */
export function countWrongOnBudget(tx: Transaction, read: BudgetRead, door: Door, nowMs: number): BudgetReached | undefined {
  const after = afterWrongOnBudget(read.state, door, nowMs);
  const dayKey = after.next.dayKey ?? torontoDayOf(nowMs);
  tx.set(
    read.ref,
    { schemaVersion: BUDGET_SCHEMA_VERSION, door, dayKey, wrong: after.next.wrong, base: after.next.base, spentAt: after.next.spentAt, lastWrongAt: new Date(nowMs).toISOString() },
    { merge: true },
  );
  if (!after.reachedNow) return undefined;
  console.log(`[sign-in] the ${door} door's daily budget of ${DAILY_BUDGET[door]} wrong tries is spent (${after.next.wrong} today): one wrong try now locks a connection until tomorrow`);
  return { door, wrong: after.next.wrong, dayKey };
}

/** Whether a lock document was written by a spent budget: `budgetLocked` holds the day. */
export const isBudgetLock = (data: Record<string, unknown> | undefined): boolean => typeof data?.budgetLocked === 'string';

/** The day's budget for the Team page (cleaner door) or the Admins page (admin door): one read. THROWS when the read fails. */
export async function readBudgetView(door: Door, nowMs: number = Date.now()): Promise<BudgetView> {
  const dayKey = torontoDayOf(nowMs);
  const snap = await getAdminDb().collection(SIGNIN_BUDGETS_COLLECTION).doc(budgetDocId(door, dayKey)).get();
  const data = snap.data() ?? {};
  const state = budgetStateOf(data);
  const email = isRecord(data.email) ? { at: text(data.email.at), status: data.email.status === 'sent' ? ('sent' as const) : ('failed' as const) } : null;
  return { door, dayKey, wrong: state.wrong, threshold: DAILY_BUDGET[door], spent: budgetSpent(state, door, nowMs), spentAt: state.spentAt, email, lifts: Array.isArray(data.lifts) ? data.lifts.length : 0 };
}

export type LiftBudgetResult = { kind: 'lifted'; dayKey: string; unlocked: number } | { kind: 'not-spent' };

/**
 * Lift the day's budget (an admin, from the Team page; a main admin, from the Admins page): it starts over from the
 * day's count, so the next wrong try is an ordinary one again, and every connection the budget locked today is
 * unlocked, its counts kept (the per-connection rules go on as before). Recorded on the budget document. THROWS when
 * Firestore fails.
 */
export async function liftBudget(door: Door, actor: Actor, nowMs: number = Date.now()): Promise<LiftBudgetResult> {
  const db = getAdminDb();
  const dayKey = torontoDayOf(nowMs);
  const ref = db.collection(SIGNIN_BUDGETS_COLLECTION).doc(budgetDocId(door, dayKey));
  const nowIso = new Date(nowMs).toISOString();
  const lifted = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const state = budgetStateOf(snap.data());
    if (!budgetSpent(state, door, nowMs)) return false;
    const next = liftedBudget(state, nowMs);
    const lifts = snap.get('lifts');
    tx.set(ref, { base: next.base, spentAt: null, lifts: [...(Array.isArray(lifts) ? lifts : []), { at: nowIso, actor, atWrong: next.wrong }] }, { merge: true });
    return true;
  });
  if (!lifted) return { kind: 'not-spent' };
  // The connections the budget locked today: unlocked, their counts kept. One query; writes in batches.
  const locked = await db.collection(LOCKS[door]).where('budgetLocked', '==', dayKey).get();
  let unlocked = 0;
  for (let i = 0; i < locked.docs.length; i += 400) {
    const batch = db.batch();
    for (const doc of locked.docs.slice(i, i + 400)) {
      batch.update(doc.ref, { lockedUntil: null, budgetLocked: FieldValue.delete() });
      unlocked += 1;
    }
    await batch.commit();
  }
  console.log(`[sign-in] the ${door} door's daily budget was lifted; ${unlocked} connection(s) unlocked`);
  return { kind: 'lifted', dayKey, unlocked };
}

/**
 * The one email at the threshold, sent after the response through the office transport, its outcome recorded on the
 * budget document. Never throws, never names a code or PIN.
 */
export async function notifyBudgetSpent(reached: BudgetReached): Promise<void> {
  const outcome = await mailOffice(budgetEmail(reached.door, reached.wrong, reached.dayKey));
  console.log(`[sign-in] the ${reached.door} door's budget email: ${outcome.status}`);
  try {
    await getAdminDb()
      .collection(SIGNIN_BUDGETS_COLLECTION)
      .doc(budgetDocId(reached.door, reached.dayKey))
      .set({ email: { at: outcome.at, status: outcome.status, detail: outcome.status === 'sent' ? outcome.response : outcome.error, wrong: reached.wrong } }, { merge: true });
  } catch (err) {
    console.error(`[sign-in] the budget email's outcome was not recorded: grpc code ${grpcCode(err)}`);
  }
}
