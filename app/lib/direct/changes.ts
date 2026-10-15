/**
 * An arrangement's changes (part B of PROPERTY-LIST-COLUMNS-PLAN.md, Kian's rulings of 2026-10-15): pause, resume,
 * change the amount, end — each from a month on, each a step in its history with its admin, nothing erased. Earlier
 * months keep their amount. Pure and client-safe: the server's transaction runs it, and the tests do.
 */

import type { Actor } from '@/app/lib/cleaners/model';
import { addMonths, monthLabel, monthRange } from '@/app/lib/reports/model';
import { addDays, nightsBetween } from '@/app/lib/availability/days';
import { DIRECT_LIMITS, arrangementMonthRange, type ArrangementView, type DirectArrangement } from './model';
import { amountFor, isPausedIn } from './periods';

const inRange = (month: string, today: string) => {
  const { first, last } = arrangementMonthRange(today);
  return month >= first && month <= last;
};

export type ArrangementChange =
  | { action: 'pause'; month: string }
  | { action: 'resume'; month: string }
  | { action: 'amount'; month: string; cents: number }
  | { action: 'end'; month: string };

/** Why a change cannot be made to the arrangement as it stands, or the arrangement as it would be. */
export function changedArrangement(a: ArrangementView, change: ArrangementChange, actor: Actor, at: string, today: string): { problem: string } | { next: Pick<DirectArrangement, 'untilMonth' | 'amounts' | 'pauses' | 'history'> } {
  const { month } = change;
  if (!inRange(month, today)) return { problem: 'Pick a month within 12 months of this one.' };
  if (month < a.fromMonth) return { problem: `It starts in ${monthLabel(a.fromMonth)}: pick that month or a later one.` };
  if (a.untilMonth !== null && change.action !== 'end' && month > a.untilMonth) return { problem: `It ended with ${monthLabel(a.untilMonth)}.` };
  const open = a.pauses.length > 0 && a.pauses[a.pauses.length - 1].until === null ? a.pauses[a.pauses.length - 1] : null;
  switch (change.action) {
    case 'pause': {
      if (open) return { problem: `It is paused since ${monthLabel(open.from)}: resume it first.` };
      if (isPausedIn(a, month)) return { problem: `${monthLabel(month)} is already paused.` };
      const later = a.pauses.find((p) => p.from > month);
      if (later) return { problem: `It is paused again from ${monthLabel(later.from)}: pick a month after that pause.` };
      return { next: { untilMonth: a.untilMonth, amounts: a.amounts, pauses: [...a.pauses, { from: month, until: null }], history: [...a.history, { at, action: 'paused', actor, month, cents: null }] } };
    }
    case 'resume': {
      if (!open) return { problem: 'It is not paused.' };
      if (month <= open.from) return { problem: `It is paused from ${monthLabel(open.from)}: resume it from a later month.` };
      const pauses = [...a.pauses.slice(0, -1), { from: open.from, until: addMonths(month, -1) }];
      return { next: { untilMonth: a.untilMonth, amounts: a.amounts, pauses, history: [...a.history, { at, action: 'resumed', actor, month, cents: null }] } };
    }
    case 'amount': {
      const lastChange = a.amounts[a.amounts.length - 1];
      if (month <= lastChange.from) return { problem: `Its amount was set from ${monthLabel(lastChange.from)}: change it from a later month.` };
      if (amountFor(a, month) === change.cents) return { problem: 'That is already its amount.' };
      return { next: { untilMonth: a.untilMonth, amounts: [...a.amounts, { from: month, cents: change.cents }], pauses: a.pauses, history: [...a.history, { at, action: 'amount-changed', actor, month, cents: change.cents }] } };
    }
    case 'end': {
      if (a.untilMonth !== null) return { problem: `It ended with ${monthLabel(a.untilMonth)}.` };
      // An arrangement is a monthly stay of at least 30 nights (Kian's rulings): one ended within a month of fewer days
      // (a February alone) would be a short stay, which is not recorded until its tax treatment is confirmed.
      const nights = nightsBetween(monthRange(a.fromMonth).from, addDays(monthRange(month).to, 1));
      if (nights < DIRECT_LIMITS.STAY_NIGHTS_MIN) return { problem: `Ended with ${monthLabel(month)}, it would cover ${nights} nights: a stay under ${DIRECT_LIMITS.STAY_NIGHTS_MIN} nights is a short stay, not recorded until its tax treatment is confirmed.` };
      return { next: { untilMonth: month, amounts: a.amounts, pauses: a.pauses, history: [...a.history, { at, action: 'ended', actor, month, cents: null }] } };
    }
  }
}

