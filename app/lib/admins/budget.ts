/**
 * The daily wrong-try budget across all connections (Kian's rulings of 2026-11-06, the security round, item 2):
 *
 *   - Cleaner door: after 15 wrong codes in total in a Toronto day, from any connections, every connection gets one
 *     wrong try before being locked for the rest of the day. Right codes are unaffected.
 *   - Admin door: the same, at 10 wrong PINs.
 *   - At each threshold, one email to the office through the contact form's transport ("Many wrong codes at the
 *     cleaner door today: n so far"), never a code or PIN in it.
 *   - The per-connection rules stay as they are (model.ts, afterTry): five in a row, fifteen minutes; twenty in a
 *     Toronto day, until lifted.
 *   - The Team page shows when the cleaner door's budget is spent, the Admins page the admin door's, each with Lift.
 *
 * What the budget is: one document per door per Toronto day, `signin_budgets/{door}-{yyyy-mm-dd}`, counting every
 * wrong try checked at that door that day (a try refused by a holding lock is not checked and not counted). It is
 * spent when `wrong - base` reaches the door's threshold; `base` is the count at the last Lift, so lifting starts the
 * budget over without losing the day's total, and the next time it is spent another email goes ("30 so far"). The
 * document's ID carries the day, so a new day starts from nothing by itself.
 *
 * What spending it does: a wrong try at a spent door locks that connection until Toronto midnight (the per-connection
 * rules still count the try: the day's twentieth still caps it until lifted, which outranks the day lock). The lock is
 * the ordinary timed lock (`lockedUntil`) with `budgetLocked: <day>` beside it on the lock document, so the pages can
 * say why, and Lift can find and unlock exactly the connections the budget locked, their counts kept.
 *
 * Pure: the same for both doors, the pages and the tests; nothing here reads or writes. The server side is
 * app/lib/firebase/server-signin-budget.ts.
 */

import { afterTry, torontoDayOf, type LockState, type TryOutcome } from './model';

/** The two doors a four-digit value opens. */
export type Door = 'cleaner' | 'admin';
export const DOORS: readonly Door[] = ['cleaner', 'admin'];

/** Wrong tries across every connection in a Toronto day before the door hardens (Kian: 15 at the cleaner door, 10 at the admin door). */
export const DAILY_BUDGET: Record<Door, number> = { cleaner: 15, admin: 10 };

/** One document per door per Toronto day: `signin_budgets/{door}-{yyyy-mm-dd}`. Server-only (firestore.rules' catch-all deny). */
export const SIGNIN_BUDGETS_COLLECTION = 'signin_budgets';
export const BUDGET_SCHEMA_VERSION = 1;
export const budgetDocId = (door: Door, dayKey: string): string => `${door}-${dayKey}`;

/** What the day's budget document holds that the rules read. */
export interface BudgetState {
  /** The Toronto day counted, yyyy-mm-dd; null before any wrong try. */
  dayKey: string | null;
  /** Wrong tries checked at this door that day, every connection together. */
  wrong: number;
  /** The count at the last Lift (0 before any): the budget is spent when `wrong - base` reaches the threshold. */
  base: number;
  /** When the budget was spent; null when it is not, or was lifted since. */
  spentAt: string | null;
}

export const NO_BUDGET: BudgetState = { dayKey: null, wrong: 0, base: 0, spentAt: null };

/** The state as it stands for `today`: a document of another day (never, by its ID; a safety net) counts as nothing. */
export function budgetFor(state: BudgetState, today: string): BudgetState {
  return state.dayKey === today ? state : { dayKey: today, wrong: 0, base: 0, spentAt: null };
}

const count = (n: number): number => Math.max(0, Math.floor(Number.isFinite(n) ? n : 0));

/** Whether the door's budget is spent at `nowMs`: the wrong tries since the last Lift reach the threshold. */
export function budgetSpent(state: BudgetState, door: Door, nowMs: number): boolean {
  const today = budgetFor(state, torontoDayOf(nowMs));
  return count(today.wrong) - count(today.base) >= DAILY_BUDGET[door];
}

/**
 * One more wrong try on the day's budget. `spentBefore`: the budget was already spent when this try came, so the
 * connection is locked for the rest of the day (afterWrongHardened). `reachedNow`: this try spent it, so the one
 * email goes.
 */
export function afterWrongOnBudget(state: BudgetState, door: Door, nowMs: number): { next: BudgetState; spentBefore: boolean; reachedNow: boolean } {
  const today = budgetFor(state, torontoDayOf(nowMs));
  const base = count(today.base);
  const spentBefore = count(today.wrong) - base >= DAILY_BUDGET[door];
  const wrong = count(today.wrong) + 1;
  const reachedNow = !spentBefore && wrong - base >= DAILY_BUDGET[door];
  return { next: { dayKey: today.dayKey, wrong, base, spentAt: reachedNow ? new Date(nowMs).toISOString() : today.spentAt }, spentBefore, reachedNow };
}

/** The budget after an admin lifts it: it starts over from the day's count; the total stays for the next email's "n so far". */
export function liftedBudget(state: BudgetState, nowMs: number): BudgetState {
  const today = budgetFor(state, torontoDayOf(nowMs));
  return { dayKey: today.dayKey, wrong: count(today.wrong), base: count(today.wrong), spentAt: null };
}

/**
 * The first instant of the next Toronto day, in milliseconds: when a budget lock ends. Toronto is UTC−4 (EDT) or UTC−5
 * (EST), so its midnight is 04:00 or 05:00 UTC of the next date; the one that ends this Toronto day is the answer. The
 * clock changes happen at 2 a.m., never at midnight, so one of the two always fits.
 */
export function torontoDayEndMs(nowMs: number): number {
  const day = torontoDayOf(nowMs);
  const [y, m, d] = day.split('-').map(Number);
  const nextDateUtc = Date.UTC(y, m - 1, d + 1);
  for (const hours of [4, 5]) {
    const t = nextDateUtc + hours * 3_600_000;
    if (torontoDayOf(t - 1) === day && torontoDayOf(t) !== day) return t;
  }
  // Unreachable while Toronto keeps one of the two offsets at every midnight; a scan by the minute, in case.
  let t = nowMs - (nowMs % 60_000);
  while (torontoDayOf(t) === day) t += 60_000;
  return t;
}

/** What a wrong try does to a connection once the day's budget is spent: locked until the next Toronto day, unless the day's twentieth capped it. */
export type HardenedOutcome = Extract<TryOutcome, { kind: 'capped-now' }> | { kind: 'budget-locked'; next: LockState; lockedUntil: string };

/**
 * A wrong try at a door whose budget is spent (no lock holding at `nowMs`): the connection is locked until Toronto
 * midnight, the tries in a row starting again, the day's count kept. The per-connection rules still count the try:
 * the Toronto day's twentieth caps the connection until lifted, which outranks the day lock and stays as it is.
 */
export function afterWrongHardened(state: LockState, nowMs: number): HardenedOutcome {
  const base = afterTry(state, false, nowMs);
  if (base.kind === 'capped-now') return base;
  const lockedUntil = new Date(torontoDayEndMs(nowMs)).toISOString();
  return { kind: 'budget-locked', next: { ...base.next, failedTries: 0, lockedUntil }, lockedUntil };
}

/** What the budget's one email says: the count and the door, never a code or PIN. */
export function budgetEmail(door: Door, wrong: number, dayKey: string): { subject: string; text: string } {
  const what = door === 'cleaner' ? 'codes' : 'PINs';
  const one = door === 'cleaner' ? 'code' : 'PIN';
  const where = door === 'cleaner' ? 'the cleaner door' : 'the admin door';
  const line = `Many wrong ${what} at ${where} today: ${wrong} so far`;
  const page = door === 'cleaner' ? 'the Team page' : 'the Admins page';
  const url = door === 'cleaner' ? 'https://www.nubnb.ca/admin/cleaners' : 'https://www.nubnb.ca/admin/admins';
  return {
    subject: `[NuBnb] ${line}`,
    text: [
      `${line} (Toronto day ${dayKey}).`,
      '',
      `The day's budget of ${DAILY_BUDGET[door]} is spent. From now until midnight Toronto, one wrong ${one} locks a connection until tomorrow. Right ${what} still sign in.`,
      `Lift it on ${page}: ${url}`,
      '',
      `This email names no ${one}. Nubnb sends one each time the day's budget is spent.`,
    ].join('\n'),
  };
}

/** The day's budget as the Team page (cleaner door) and the Admins page (admin door) read it. */
export interface BudgetView {
  door: Door;
  dayKey: string;
  /** Wrong tries today, every connection together. */
  wrong: number;
  threshold: number;
  /** Spent now: one wrong try locks a connection until tomorrow. */
  spent: boolean;
  spentAt: string | null;
  /** The email sent when it was last spent, and whether the mail server took it. */
  email: { at: string | null; status: 'sent' | 'failed' } | null;
  /** How many times an admin lifted it today. */
  lifts: number;
}

/** Whether a value is a BudgetView, as a client reads one. */
export function isBudgetView(value: unknown): value is BudgetView {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const email = v.email;
  const emailOk = email === null || (!!email && typeof email === 'object' && !Array.isArray(email) && ((email as Record<string, unknown>).status === 'sent' || (email as Record<string, unknown>).status === 'failed'));
  return (v.door === 'cleaner' || v.door === 'admin') && typeof v.dayKey === 'string' && typeof v.wrong === 'number' && typeof v.threshold === 'number' && typeof v.spent === 'boolean' && (v.spentAt === null || typeof v.spentAt === 'string') && emailOk && typeof v.lifts === 'number';
}

/** The pages' one line for a spent budget: "Daily budget spent: 17 wrong codes at the cleaner door today (budget 15)." */
export function budgetSpentWords(view: BudgetView): string {
  const what = view.door === 'cleaner' ? 'codes' : 'PINs';
  const where = view.door === 'cleaner' ? 'the cleaner door' : 'the admin door';
  return `Daily budget spent: ${view.wrong} wrong ${what} at ${where} today (budget ${view.threshold}).`;
}

/** What a spent budget does, in the pages' words. */
export function budgetEffectWords(door: Door): string {
  const one = door === 'cleaner' ? 'code' : 'PIN';
  const what = door === 'cleaner' ? 'codes' : 'PINs';
  return `One wrong ${one} now locks a connection until tomorrow; right ${what} still sign in.`;
}

/** A budget lock on the pages' lock rows: "1 wrong code after today's budget was spent · until tomorrow". */
export function budgetLockWords(door: Door): string {
  return `1 wrong ${door === 'cleaner' ? 'code' : 'PIN'} after today’s budget was spent · until tomorrow`;
}
