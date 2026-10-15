/**
 * Team pay: the one function that works out what a team member is owed and has been paid (Kian's rulings of
 * 2026-10-15, in CLAUDE.md under *Team pay*; TEAM-PAY-PLAN.md §2). The Team page runs it over the cleanings and cost
 * entries it already loads, and every payment; the cleaner app's start call runs it on the server over that person's
 * own, and sends only their figures (ruling 6); deleting a team member runs it inside the delete. Pure and
 * client-safe: nothing here reads or writes.
 *
 * ── What is owed (ruling 1) ──
 *   a cleaning       theirs, logged (not removed), with an amount: its amount
 *   a receipt        theirs, approved, not paid with Nubnb's card: its total now — items plus tax, every correction
 *                    applied (readLinesNow)
 *   work             theirs, approved: its total now
 * Paid: their payments not deleted. Balance = owed − paid, over all time: no pay periods (ruling 3). Below zero it is
 * overpaid. An entry whose lines cannot be read counts nowhere and is counted apart (`cannotAddUp`), so a balance is
 * never shown as if it were whole.
 *
 * ── Listed, counted or not ──
 * Every cleaning, receipt, work entry and payment of theirs, by date — a cleaning's day, the day a receipt or work
 * was sent (as the Costs page and the statements date it), the day a payment was made — with its state now in words:
 * no amount yet, waiting for review, rejected, removed, paid with Nubnb's card, given to another cleaner, deleted.
 *
 * ── Changes (TEAM-PAY-PLAN.md §3) ──
 * No payment is tied to items, so a change after paying moves the running balance. Each item carries the changes
 * that moved what it adds, replayed from its own history: removed, rejected, an amount changed or corrected, marked
 * paid with Nubnb's card, given to another cleaner. A change is shown in amber when the item counted before it and a
 * payment recorded before the change is dated on or after the item: that payment may have included it.
 */

import { formatCents, readLinesNow, type CostEntryView, type HistoryEventView } from '@/app/lib/cleaners/model';
import type { CleaningEvent } from '@/app/lib/cleanings/model';
import { ledgerDay } from '@/app/lib/costs/report';
import { PAYMENT_METHOD_LABELS, type PaymentView } from './model';

/** A cleaning as pay reads it: the admin page's CleaningView, or the server's own read. */
export interface PayCleaning {
  id: string;
  cleanerId: string;
  cleanerNameAtEntry: string | null;
  day: string;
  amountCents: number | null;
  status: string;
  history: CleaningEvent[];
  propertyNameAtEntry: string | null;
  /** The property now: its public title, and the name the admin shows (Kian's rulings of 2026-10-15, evening). */
  property?: { name: string | null; internalName?: string | null } | null;
  createdAt: string;
}

/** A cost entry as pay reads it: the fields of a CostEntryView it needs. */
export type PayEntry = Pick<CostEntryView, 'id' | 'kind' | 'status' | 'statusReason' | 'createdAt' | 'month' | 'paidWith' | 'lines' | 'history' | 'linesNow' | 'taxShape'> & {
  cleaner: { id: string | null };
  property: { nameAtEntry: string | null; name: string | null; internalName?: string | null };
};

export interface PaySources {
  cleanings: readonly PayCleaning[];
  entries: readonly PayEntry[];
  payments: readonly PaymentView[];
}

export type PayRowState = 'counts' | 'waiting' | 'no-amount' | 'rejected' | 'removed' | 'nubnb-card' | 'moved' | 'cannot-add-up' | 'unknown' | 'recorded' | 'deleted';

/** One change that moved what an item adds. */
export interface PayChange {
  at: string;
  /** Who made it: an admin's name, or null when the record has none. */
  by: string | null;
  /** What it did: "Removed", "Changed: $60.00 → $55.00", "Marked paid with Nubnb's card". */
  words: string;
  owedBefore: number;
  owedAfter: number;
  /** The payment it came after, which may have included the item: shown in amber. */
  afterPayment: { id: string; day: string; amountCents: number } | null;
}

export interface PayRow {
  kind: 'cleaning' | 'receipt' | 'work' | 'payment';
  id: string;
  /** The day it is listed by; null when it cannot be read. */
  day: string | null;
  /** When it was made or recorded: the order within a day. */
  at: string | null;
  property: string | null;
  /** "3 items" on a receipt, a work entry's description, a payment's note. */
  detail: string | null;
  /** What it adds to Earned now; null when it counts nowhere. */
  earnedCents: number | null;
  /** What it adds to Paid now. */
  paidCents: number | null;
  /** The amount on it, counted or not: shown struck through when it does not count. */
  amountCents: number | null;
  state: PayRowState;
  /** Its state now in words; null when it simply counts. */
  note: string | null;
  changes: PayChange[];
  /** A change came after a payment that may have included it. */
  amber: boolean;
  payment: PaymentView | null;
}

export interface MemberPay {
  memberId: string;
  earnedCents: number;
  paidCents: number;
  balanceCents: number;
  parts: { cleaningsCents: number; receiptsCents: number; workCents: number };
  /** Listed, not yet counted: a cleaning with no amount yet, a receipt or work waiting for review. */
  waiting: number;
  /** Entries whose lines cannot be read: left out of the balance, which is then never shown as whole. */
  cannotAddUp: number;
  /** Newest first. */
  rows: PayRow[];
  /** With a date range: what fell in it, and the balance before it and at its end. */
  range: { from: string; to: string; earnedCents: number; paidCents: number; balanceBeforeCents: number; balanceAtEndCents: number } | null;
}

// ─── Words ─────────────────────────────────────────────────────

/** "Oct 22": the Toronto day of an instant. */
export function whenWords(at: string | null): string {
  const time = Date.parse(at ?? '');
  if (!Number.isFinite(time)) return 'at an unknown time';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', month: 'short', day: 'numeric' }).format(new Date(time));
}

/** "Oct 20": a yyyy-mm-dd day as written. */
export function dayWords(day: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(`${day}T12:00:00Z`));
}

const who = (actor: { role?: string | null; name?: string | null } | null | undefined): string | null => actor?.name ?? (actor?.role === 'system' ? 'automatic approval' : null);
const byWords = (at: string, by: string | null) => `${whenWords(at)}${by ? ` by ${by}` : ''}`;

/** A balance in words, and its tone: owed to them, overpaid, or settled (ruling 3). */
export function balanceWords(balanceCents: number): { words: string; tone: 'owed' | 'overpaid' | 'settled' } {
  if (balanceCents > 0) return { words: `${formatCents(balanceCents)} owed`, tone: 'owed' };
  if (balanceCents < 0) return { words: `${formatCents(-balanceCents)} overpaid`, tone: 'overpaid' };
  return { words: 'Settled', tone: 'settled' };
}

// ─── The function ──────────────────────────────────────────────

type Covering = (day: string | null, changeAt: string) => PayChange['afterPayment'];

/** A cleaning's states along its history, replayed backwards from what is stored: states[i] is the state before event i. */
function cleaningStates(c: PayCleaning): { cleanerId: string | null; amount: number | null; status: string }[] {
  const states = new Array<{ cleanerId: string | null; amount: number | null; status: string }>(c.history.length + 1);
  states[c.history.length] = { cleanerId: c.cleanerId, amount: c.amountCents, status: c.status };
  for (let i = c.history.length - 1; i >= 0; i--) {
    const event = c.history[i];
    const after = states[i + 1];
    if (event.action === 'logged') {
      states[i] = { cleanerId: null, amount: null, status: 'none' };
      continue;
    }
    const before = { ...after };
    if (event.action === 'removed') before.status = 'logged';
    if (event.action === 'changed') {
      if (event.before && 'amountCents' in event.before && event.before.amountCents !== undefined) before.amount = event.before.amountCents;
      if (event.before?.cleanerId !== undefined) before.cleanerId = event.before.cleanerId;
    }
    states[i] = before;
  }
  return states;
}

function cleaningRow(c: PayCleaning, memberId: string, covering: Covering): PayRow | null {
  const states = cleaningStates(c);
  if (!states.some((state) => state.cleanerId === memberId)) return null;
  const owed = (state: { cleanerId: string | null; amount: number | null; status: string }) => (state.cleanerId === memberId && state.status === 'logged' && typeof state.amount === 'number' ? state.amount : 0);

  const changes: PayChange[] = [];
  let lastRemoved: PayChange | null = null;
  let lastMoved: PayChange | null = null;
  c.history.forEach((event, i) => {
    if (event.action === 'logged') return;
    const owedBefore = owed(states[i]);
    const owedAfter = owed(states[i + 1]);
    if (owedBefore === owedAfter && !(event.action === 'changed' && event.before?.cleanerId !== undefined)) return;
    let words = 'Changed';
    if (event.action === 'removed') words = 'Removed';
    else if (event.before?.cleanerId !== undefined && states[i].cleanerId === memberId) words = `Given to ${event.after?.cleanerName ?? 'another cleaner'}`;
    else if (event.before?.cleanerId !== undefined) words = 'Given to them';
    else if (event.before?.amountCents === null) words = `Amount typed: ${formatCents(owedAfter)}`;
    else if (event.before?.amountCents !== undefined && typeof event.after?.amountCents === 'number') words = `Changed: ${formatCents(event.before.amountCents)} → ${formatCents(event.after.amountCents)}`;
    const change: PayChange = { at: event.at, by: who(event.actor), words, owedBefore, owedAfter, afterPayment: owedBefore > 0 ? covering(c.day, event.at) : null };
    changes.push(change);
    if (event.action === 'removed') lastRemoved = change;
    if (words.startsWith('Given to ') && words !== 'Given to them') lastMoved = change;
  });

  const was = (change: PayChange | null) => (change && change.owedBefore > 0 ? ` · was ${formatCents(change.owedBefore)}` : '');
  const base = { kind: 'cleaning' as const, id: c.id, day: c.day, at: c.createdAt, property: c.property?.internalName ?? c.property?.name ?? c.propertyNameAtEntry, detail: null, paidCents: null, amountCents: c.amountCents, changes, amber: changes.some((change) => change.afterPayment !== null), payment: null };
  if (c.cleanerId !== memberId) {
    const moved = lastMoved as PayChange | null;
    return { ...base, earnedCents: null, state: 'moved', note: `${moved ? `${moved.words} ${byWords(moved.at, moved.by)}` : 'Given to another cleaner'}${was(moved)}` };
  }
  if (c.status === 'removed') {
    const removed = lastRemoved as PayChange | null;
    return { ...base, earnedCents: null, state: 'removed', note: `Removed${removed ? ` ${byWords(removed.at, removed.by)}` : ''}${was(removed)}` };
  }
  if (c.status !== 'logged') return { ...base, earnedCents: null, state: 'unknown', note: `Status as stored: ${c.status}` };
  if (c.amountCents === null) return { ...base, earnedCents: null, state: 'no-amount', note: 'No amount yet' };
  return { ...base, earnedCents: c.amountCents, state: 'counts', note: null };
}

/** The status, who paid, and the total an entry had after each event of its history, replayed forward. */
function entryRow(e: PayEntry, covering: Covering): PayRow {
  const kind: 'work' | 'receipt' = e.kind === 'work' ? 'work' : 'receipt';
  const day = ledgerDay({ createdAt: e.createdAt, month: e.month });
  const history: HistoryEventView[] = e.history ?? [];
  const sentTax = e.linesNow.kind === 'ok' ? e.linesNow.sentTaxCents : null;
  // An entry that cannot add up now has no total to replay either: none of its changes is said to move what it adds.
  const totalAfter = (count: number): number | null => {
    if (e.linesNow.kind !== 'ok') return null;
    const now = readLinesNow(e.lines, history.slice(0, count), { shape: e.taxShape, cents: sentTax });
    return now.kind === 'ok' ? now.totalCents : null;
  };
  const owedOf = (state: { status: string; paidWith: string; total: number | null }) => (state.status === 'approved' && (kind === 'work' || state.paidWith !== 'nubnb-card') && state.total !== null ? state.total : 0);

  const createdAt = history[0]?.at ?? e.createdAt;
  let state = { status: 'pending', paidWith: 'team-member', total: totalAfter(0) };
  const changes: PayChange[] = [];
  let lastStatus: { at: string; by: string | null; reason: string | null; owedBefore: number } | null = null;
  let lastCard: { at: string; by: string | null; owedBefore: number } | null = null;
  history.forEach((event, i) => {
    const before = state;
    const next = { ...before };
    const action = event.action ?? '';
    if (action === 'submitted' || action === 'approved' || action === 'rejected' || action === 'removed') next.status = event.to ?? (action === 'submitted' ? 'pending' : action);
    if (action === 'paid_with_changed') next.paidWith = event.to ?? next.paidWith;
    if (action === 'line_corrected' || action === 'line_added' || action === 'tax_corrected') next.total = totalAfter(i + 1);
    state = next;
    // What happened at the instant it was sent — submitted, and approved automatically — is the entry being made, not a change.
    if (event.at === null || event.at === createdAt) return;
    const owedBefore = owedOf(before);
    const owedAfter = owedOf(next);
    let words: string | null = null;
    if (action === 'approved') words = before.status === 'pending' ? 'Approved' : 'Approved again';
    else if (action === 'rejected') words = `Rejected${event.reason ? `: ${event.reason}` : ''}`;
    else if (action === 'removed') words = 'Removed';
    else if (action === 'paid_with_changed') words = next.paidWith === 'nubnb-card' ? "Marked paid with Nubnb's card" : 'Marked paid by them';
    else if (owedBefore !== owedAfter || before.total !== next.total) words = before.total !== null && next.total !== null ? `Corrected: ${formatCents(before.total)} → ${formatCents(next.total)}` : 'Corrected';
    if (action === 'approved' || action === 'rejected' || action === 'removed') lastStatus = { at: event.at, by: who(event.actor), reason: event.reason, owedBefore };
    if (action === 'paid_with_changed') lastCard = { at: event.at, by: who(event.actor), owedBefore };
    if (words === null || (owedBefore === owedAfter && action !== 'paid_with_changed' && action !== 'rejected' && action !== 'removed')) return;
    changes.push({ at: event.at, by: who(event.actor), words, owedBefore, owedAfter, afterPayment: owedBefore > 0 && owedBefore !== owedAfter ? covering(day, event.at) : null });
  });

  const total = e.linesNow.kind === 'ok' ? e.linesNow.totalCents : null;
  const lines = e.linesNow.kind === 'ok' ? e.linesNow.lines : [];
  const detail = kind === 'work' ? (lines[0]?.name ?? null) : e.linesNow.kind === 'ok' ? (lines.length === 1 ? '1 item' : `${lines.length} items`) : null;
  const base = { kind, id: e.id, day, at: e.createdAt, property: e.property.internalName ?? e.property.name ?? e.property.nameAtEntry, detail, paidCents: null, amountCents: total, changes, amber: changes.some((change) => change.afterPayment !== null), payment: null };
  const status = lastStatus as { at: string; by: string | null; reason: string | null; owedBefore: number } | null;
  const card = lastCard as { at: string; by: string | null; owedBefore: number } | null;
  const was = (owedBefore: number | undefined) => (owedBefore && owedBefore > 0 ? ` · was ${formatCents(owedBefore)}` : '');

  if (e.linesNow.kind !== 'ok') return { ...base, earnedCents: null, state: 'cannot-add-up', note: `Cannot add up: ${e.linesNow.reason}` };
  if (e.status === 'pending') return { ...base, earnedCents: null, state: 'waiting', note: 'Waiting for review' };
  if (e.status === 'rejected') return { ...base, earnedCents: null, state: 'rejected', note: `Rejected${status ? ` ${byWords(status.at, status.by)}` : ''}${e.statusReason ? `: ${e.statusReason}` : ''}${was(status?.owedBefore)}` };
  if (e.status === 'removed') return { ...base, earnedCents: null, state: 'removed', note: `Removed${status ? ` ${byWords(status.at, status.by)}` : ''}${was(status?.owedBefore)}` };
  if (e.status !== 'approved') return { ...base, earnedCents: null, state: 'unknown', note: `Status as stored: ${e.status ?? 'none'}` };
  if (kind === 'receipt' && e.paidWith === 'nubnb-card') return { ...base, earnedCents: null, state: 'nubnb-card', note: `Paid with Nubnb's card${card ? ` · ${card.by ?? 'an admin'}, ${whenWords(card.at)}` : ''}${card && card.owedBefore > 0 ? ` · was owed ${formatCents(card.owedBefore)}` : ''}` };
  return { ...base, earnedCents: total, state: 'counts', note: null };
}

function paymentRow(p: PaymentView): PayRow {
  const recorded = `${whenWords(p.recordedAt)} by ${p.recordedBy.name ?? 'an admin'}`;
  const note = p.status === 'deleted' ? `Deleted ${whenWords(p.deletedAt)} by ${p.deletedBy?.name ?? 'an admin'} · recorded ${recorded}` : `Recorded ${recorded}`;
  return { kind: 'payment', id: p.id, day: p.day, at: p.recordedAt, property: null, detail: p.note, earnedCents: null, paidCents: p.status === 'recorded' ? p.amountCents : null, amountCents: p.amountCents, state: p.status, note, changes: [], amber: false, payment: p };
}

/** "Cleaning · Loft", "Receipt · Cozy Pad · 3 items", "Work · Loft · Fixed the sink", "Payment · E-transfer · “Sept”". */
export function rowItemWords(row: PayRow): string {
  if (row.kind === 'payment') return `Payment · ${row.payment ? PAYMENT_METHOD_LABELS[row.payment.method] : 'unknown method'}${row.detail ? ` · “${row.detail}”` : ''}`;
  const kind = row.kind === 'cleaning' ? 'Cleaning' : row.kind === 'work' ? 'Work' : 'Receipt';
  return [kind, row.property ?? 'Unknown property', row.detail].filter((part) => part !== null && part !== '').join(' · ');
}

/** A change in words, with when and by whom: "Changed Oct 22 by Kian: $60.00 → $55.00", "Removed Oct 22 by Kian". */
export function changeWords(change: PayChange): string {
  const split = change.words.indexOf(': ');
  return split < 0 ? `${change.words} ${byWords(change.at, change.by)}` : `${change.words.slice(0, split)} ${byWords(change.at, change.by)}${change.words.slice(split)}`;
}

/** Newest first: by day, then by when it was made or recorded; a row with no day goes last. */
function newestFirst(a: PayRow, b: PayRow): number {
  if (a.day !== b.day) return a.day === null ? 1 : b.day === null ? -1 : b.day.localeCompare(a.day);
  return (b.at ?? '').localeCompare(a.at ?? '') || a.id.localeCompare(b.id);
}

/**
 * What one team member is owed and has been paid, every item and payment of theirs, and — with a range of days,
 * both included, either end open when '' (the date field's "All time") — what fell in it and the balance before it
 * and at its end.
 */
export function memberPay(memberId: string, sources: PaySources, range?: { from: string; to: string } | null): MemberPay {
  const payments = sources.payments.filter((p) => p.memberId === memberId);
  const recorded = payments.filter((p) => p.status === 'recorded');
  const covering: Covering = (day, changeAt) => {
    if (day === null) return null;
    const first = recorded.filter((p) => p.day >= day && p.recordedAt < changeAt).sort((a, b) => a.day.localeCompare(b.day) || a.recordedAt.localeCompare(b.recordedAt))[0];
    return first ? { id: first.id, day: first.day, amountCents: first.amountCents } : null;
  };

  const rows: PayRow[] = [];
  for (const c of sources.cleanings) {
    const row = cleaningRow(c, memberId, covering);
    if (row) rows.push(row);
  }
  for (const e of sources.entries) {
    if (e.cleaner.id !== memberId || (e.kind !== 'receipt' && e.kind !== 'work')) continue;
    rows.push(entryRow(e, covering));
  }
  for (const p of payments) rows.push(paymentRow(p));
  rows.sort(newestFirst);

  const sum = (list: PayRow[], pick: (row: PayRow) => number | null) => list.reduce((total, row) => total + (pick(row) ?? 0), 0);
  const earnedCents = sum(rows, (row) => row.earnedCents);
  const paidCents = sum(rows, (row) => row.paidCents);
  const balanceOn = (included: (day: string) => boolean) => sum(rows.filter((row) => row.day !== null && included(row.day)), (row) => row.earnedCents) - sum(rows.filter((row) => row.day !== null && included(row.day)), (row) => row.paidCents);
  return {
    memberId,
    earnedCents,
    paidCents,
    balanceCents: earnedCents - paidCents,
    parts: {
      cleaningsCents: sum(rows.filter((row) => row.kind === 'cleaning'), (row) => row.earnedCents),
      receiptsCents: sum(rows.filter((row) => row.kind === 'receipt'), (row) => row.earnedCents),
      workCents: sum(rows.filter((row) => row.kind === 'work'), (row) => row.earnedCents),
    },
    waiting: rows.filter((row) => row.state === 'waiting' || row.state === 'no-amount').length,
    cannotAddUp: rows.filter((row) => row.state === 'cannot-add-up').length,
    rows,
    range: range
      ? (() => {
          const afterStart = (day: string) => range.from === '' || day >= range.from;
          const beforeEnd = (day: string) => range.to === '' || day <= range.to;
          const inside = rows.filter((row) => row.day !== null && afterStart(row.day) && beforeEnd(row.day));
          return { from: range.from, to: range.to, earnedCents: sum(inside, (row) => row.earnedCents), paidCents: sum(inside, (row) => row.paidCents), balanceBeforeCents: balanceOn((day) => !afterStart(day)), balanceAtEndCents: balanceOn(beforeEnd) };
        })()
      : null,
  };
}
