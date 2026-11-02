/**
 * A row of a platform's file that became no line, decided (Kian's ruling of 2026-11-01): `earnings_unread/{id}` is a
 * gap of its month — at the top of the Income page, and in Finish's warnings for that month's statements — until an
 * admin either
 *   - places it with a typed line: the admin types the line on the property's statement as any line is typed (the
 *     property page's Income tab, its draft's own save and revision), then names that line here. The line must be on
 *     the property's statement draft for the row's month, typed (not a line read from a file). The decision keeps the
 *     property, the month, the line's ID, and its description and amount as they stood; or
 *   - marks it "not Nubnb's money", with a reason.
 * Either decision is logged in the row's history with who and when, and is not undone here: a placing is undone only
 * by the draft save, when the typed line it names is deleted from the property's draft for that month (saveDraft in
 * server-reports.ts sets the decision back to null and logs 'reopened', and the row is a gap again); "not Nubnb's
 * money" is never undone. Nothing else is written here: no draft, no line, no statement. The typed line is what reaches
 * the owner, exactly as typed.
 *
 * Reached only through the Admin SDK (the admin route under /api/admin/income/unread); firestore.rules' catch-all
 * denies every browser.
 */

import type { Transaction } from 'firebase-admin/firestore';
import { getAdminDb } from './admin';
import { type Actor, type Refusal } from '@/app/lib/cleaners/model';
import { EARNINGS_UNREAD_COLLECTION, draftIdOf, readEarningsUnread, type EarningsUnreadView, type UnreadDecision } from '@/app/lib/income/model';
import { MONTHLY_REPORT_DRAFTS_COLLECTION, monthLabel, readStatementDraft } from '@/app/lib/reports/model';

const UNREAD_ID = /^[0-9a-f]{64}$/;

function grpcCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? String(code) : typeof code === 'string' ? code : 'unknown';
}

export type UnreadDecisionResult =
  | { kind: 'decided'; unread: EarningsUnreadView }
  | { kind: 'not-found' }
  /** Its history is not the length the page saw: decided or changed since. */
  | { kind: 'changed-since' }
  | { kind: 'already-decided' }
  /** The property's statement for the row's month has no draft, or the draft holds no typed line with that ID. */
  | { kind: 'no-such-line'; month: string }
  | { kind: 'unreadable' }
  | { kind: 'failed' };

export const UNREAD_REFUSALS: Record<Exclude<UnreadDecisionResult['kind'], 'decided' | 'no-such-line'>, Refusal> = {
  'not-found': { status: 404, code: 'UNREAD_NOT_FOUND', message: 'No such row.', hint: 'Nothing was written. Reload the Income page.' },
  'changed-since': { status: 409, code: 'UNREAD_CHANGED', message: 'This row changed since the page loaded.', hint: 'Nothing was written. Reload, and decide it again if it still waits.' },
  'already-decided': { status: 409, code: 'UNREAD_DECIDED', message: 'This row is already decided.', hint: 'Nothing was written. Reload the Income page.' },
  unreadable: { status: 500, code: 'UNREAD_UNREADABLE', message: 'This row, or the statement draft it names, is not in the shape a decision needs.', hint: 'Nothing was written.' },
  failed: { status: 502, code: 'UNREAD_DECISION_FAILED', message: 'Could not record the decision.', hint: 'It may or may not have been recorded. Reload the Income page to see.' },
};

/** The refusal for a line that is not on the statement, naming the month. */
export function noSuchLineRefusal(month: string): Refusal {
  return { status: 422, code: 'UNREAD_LINE_NOT_FOUND', message: `That line is not a typed line on the property's ${monthLabel(month)} statement.`, hint: 'Nothing was written. Type the line on the property\'s page first, then place the row with it.' };
}

/** One decision, in a transaction that refuses unless the row is still undecided and its history is as the page saw it. */
async function decide(id: string, seen: number, make: (tx: Transaction, row: EarningsUnreadView) => Promise<UnreadDecision | { kind: 'no-such-line'; month: string } | { kind: 'unreadable' }>, action: 'placed' | 'not-ours', actor: Actor): Promise<UnreadDecisionResult> {
  if (!UNREAD_ID.test(id)) return { kind: 'not-found' };
  const db = getAdminDb();
  const ref = db.collection(EARNINGS_UNREAD_COLLECTION).doc(id);
  try {
    return await db.runTransaction(async (tx): Promise<UnreadDecisionResult> => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { kind: 'not-found' };
      const row = readEarningsUnread(snap.id, snap.data() ?? {});
      if (!row) return { kind: 'unreadable' };
      if (row.history.length !== seen) return { kind: 'changed-since' };
      if (row.decision !== null) return { kind: 'already-decided' };
      const decision = await make(tx, row);
      if (decision.kind === 'no-such-line' || decision.kind === 'unreadable') return decision;
      const history = [...row.history, { at: decision.at, actor, action }];
      tx.update(ref, { decision, history });
      return { kind: 'decided', unread: { ...row, decision, history } };
    });
  } catch (err) {
    console.error(`[income] deciding unread row ${id} failed: grpc code ${grpcCode(err)}`);
    return { kind: 'failed' };
  }
}

/**
 * Place a row with a typed line already on the property's statement for the row's month (its draft, open, finished
 * or being corrected: the line is on that statement either way). The decision copies the line as it stands.
 */
export function placeUnread(actor: Actor, id: string, input: { seen: number; propertyId: string; lineId: string }, now: Date = new Date()): Promise<UnreadDecisionResult> {
  return decide(
    id,
    input.seen,
    async (tx, row) => {
      const db = getAdminDb();
      const draftSnap = await tx.get(db.collection(MONTHLY_REPORT_DRAFTS_COLLECTION).doc(draftIdOf(input.propertyId, row.month)));
      if (!draftSnap.exists) return { kind: 'no-such-line', month: row.month };
      const draft = readStatementDraft(draftSnap.id, draftSnap.data() ?? {});
      if (!draft) return { kind: 'unreadable' };
      // A typed line: one the admin typed, never a line read from a file or a direct payment (those are not in a draft).
      const line = draft.lines.find((l) => l.id === input.lineId && l.platformLineId === undefined);
      if (!line) return { kind: 'no-such-line', month: row.month };
      return { kind: 'placed', propertyId: input.propertyId, month: row.month, lineId: line.id, description: line.description, amountCents: line.amountCents, at: now.toISOString(), actor };
    },
    'placed',
    actor,
  );
}

/** Mark a row "not Nubnb's money", with the admin's reason. */
export function markUnreadNotOurs(actor: Actor, id: string, input: { seen: number; reason: string }, now: Date = new Date()): Promise<UnreadDecisionResult> {
  return decide(id, input.seen, async () => ({ kind: 'not-ours', reason: input.reason, at: now.toISOString(), actor }), 'not-ours', actor);
}
