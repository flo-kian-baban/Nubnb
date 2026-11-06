/**
 * Add a job, the UX pass (Kian's instruction of 2026-11-06, after recording a Nov 1 cleaning at a property with no
 * calendar): what the Schedule's "Add a job" form starts from and sends, the same for the page and the server. Pure:
 * nothing here imports Next, Firebase or anything that reads.
 *
 *   - The property is found by typing (`unitMatches`, `unitOrder`): any part of its name — the address the admin
 *     shows, or the public title — recent first.
 *   - There is no Tier control. The amount fills with the property's short-term cleaning price, with its mid- and
 *     long-term prices one tap away where it has them (`priceChoices`); a property with no price starts empty, with the
 *     "Last typed" placeholder of Build 2 (prices.ts `fieldStart`). The tier stored is the one the chosen price came
 *     from, as before, so the job's history and its cleaning read as they did with the Tier control: an amount left at
 *     the tier's price is stored as that price (`addedJobAmount`: no amount on the job), an amount changed is the job's
 *     own (ruling B).
 *   - Days go back to the statements floor, November 1, 2026, and no further (`addedJobDayProblem`).
 *   - "Already cleaned", on a day that has come, records the job cleaned as it is added (`canRecordOnAdd`).
 */

import { addDays, isDay } from '../availability/days';
import { STATEMENTS_FROM_DEFAULT, beforeStatementsLine, monthLabel, monthOfDay } from '../reports/model';
import { PRESET_KINDS, TIER_WORDS, fieldStart, presetCents, type CleaningPrices, type PresetKind } from '../cleanings/prices';

// ─── The day ───────────────────────────────────────────────────

/** The first day a job can be added for: the statements floor (Kian's instruction of 2026-11-06). */
export const ADDED_JOB_FROM_DAY = `${STATEMENTS_FROM_DEFAULT}-01`;

/** Why an earlier day is refused, in the floor's own words (reports/model.ts `beforeStatementsLine`): "Statements start in November 2026". */
export const FLOOR_WORDS = `Statements start in ${monthLabel(STATEMENTS_FROM_DEFAULT)}`;

/** How far ahead the form's calendar reaches. The server takes any later day too (ruling C: any date). */
export const ADDED_JOB_DAYS_AHEAD = 366;

/** Why a day cannot be an added job's: not a day, or before the floor ("Statements start in November 2026"). Null when it can. */
export function addedJobDayProblem(day: string): string | null {
  if (!isDay(day)) return 'Pick the day.';
  if (day < ADDED_JOB_FROM_DAY) return beforeStatementsLine(monthOfDay(day));
  return null;
}

/** Whether "Already cleaned" is offered: the day has come (today or earlier, Toronto), as Record as cleaned requires. */
export function canRecordOnAdd(day: string, today: string): boolean {
  return isDay(day) && isDay(today) && day <= today;
}

/** The last day the form's calendar offers. */
export function addedJobLastDay(today: string): string {
  return addDays(today, ADDED_JOB_DAYS_AHEAD);
}

// ─── The label ─────────────────────────────────────────────────

/** The quick labels, in order; "Other" opens a text field. */
export const JOB_LABEL_CHOICES = ['Turnover', 'Deep clean', 'Extra visit', 'Move-out'] as const;
export const OTHER_LABEL = 'Other';

/** The label a choice sends: the choice itself, or the words typed under Other (trimmed); null when Other has none. */
export function chosenLabel(choice: string, other: string): string | null {
  if (choice !== OTHER_LABEL) return choice;
  const typed = other.trim();
  return typed === '' ? null : typed;
}

// ─── The amount ────────────────────────────────────────────────

/** The amount an admin last typed at the property, per tier (prices.ts `recommendedAmount`): the "Last typed" placeholder. */
export type LastTyped = Record<PresetKind, number | null>;
export const NOTHING_TYPED: LastTyped = { short: null, mid: null, long: null };

/** What the form's amount opens with once a property is picked: the short-term tier, and its field (`fieldStart`). */
export function amountStart(prices: CleaningPrices | null, lastTyped: LastTyped): { tier: PresetKind; field: ReturnType<typeof fieldStart> } {
  return { tier: 'short', field: tierField(prices, lastTyped, 'short') };
}

/**
 * A tier's field: its cleaning price fills the value; with none, the amount last typed there is a grey placeholder,
 * never a value (Build 2, "Never save a suggestion"); with neither, the field is empty.
 */
export function tierField(prices: CleaningPrices | null, lastTyped: LastTyped, tier: PresetKind): ReturnType<typeof fieldStart> {
  const cents = presetCents(prices, tier);
  if (cents !== null) return fieldStart({ kind: 'preset', tier, cents });
  const typed = lastTyped[tier];
  if (typed !== null) return fieldStart({ kind: 'recommendation', tier, cents: typed, day: '' });
  return fieldStart({ kind: 'none', tier });
}

/** The one-tap prices beside the amount: every other tier the property has a price for ("Mid $Y", "Long $Z"), in tier order. */
export function priceChoices(prices: CleaningPrices | null, tier: PresetKind): { tier: PresetKind; cents: number; words: string }[] {
  return PRESET_KINDS.filter((kind) => kind !== tier)
    .map((kind) => ({ kind, cents: presetCents(prices, kind) }))
    .filter((c): c is { kind: PresetKind; cents: number } => c.cents !== null)
    .map(({ kind, cents }) => ({ tier: kind, cents, words: `${TIER_SHORT[kind]} $${(cents / 100).toFixed(2)}` }));
}

/** "Short", "Mid", "Long": a tier on a one-tap price. */
export const TIER_SHORT: Record<PresetKind, string> = { short: 'Short', mid: 'Mid', long: 'Long' };

/**
 * What an added job stores of the amount the admin left in the field (Kian's instruction: "Store the tier the chosen
 * price came from, as today"): the tier always; no amount on the job when the field is empty or holds exactly that
 * tier's cleaning price — the job then reads as that tier's price, as it did with the Tier control and no amount — and
 * the job's own amount (ruling B) when it holds anything else. The server applies it with the prices it reads in the
 * same transaction, so a recorded cleaning counts exactly the amount the field showed.
 */
export function addedJobAmount(prices: CleaningPrices | null, tier: PresetKind, cents: number | null): { tier: PresetKind; amountCents: number | null } {
  if (cents === null) return { tier, amountCents: null };
  return { tier, amountCents: cents === presetCents(prices, tier) ? null : cents };
}

/** The words under the amount: where it comes from, as the job will read it. */
export function amountWords(prices: CleaningPrices | null, lastTyped: LastTyped, tier: PresetKind, cents: number | null, empty: boolean): string {
  const price = presetCents(prices, tier);
  const tierWords = `${TIER_WORDS[tier][0].toUpperCase()}${TIER_WORDS[tier].slice(1)} cleaning price`;
  // Empty with a price: the job takes that price, as with the Tier control and no amount (the placeholder shows it in grey).
  if (empty) return price !== null ? `${tierWords}: $${(price / 100).toFixed(2)}` : tierField(prices, lastTyped, tier).words;
  if (cents === null) return 'Dollars and cents, like 75.00';
  if (cents === price) return tierWords;
  return 'Set on the job';
}

// ─── The property ──────────────────────────────────────────────

/** A unit the search offers: its ID, the name the admin shows (the address), and its public title. */
export interface UnitChoice {
  id: string;
  name: string;
  publicName: string;
}

/** Folded for matching: no accents, no case, spaces collapsed. */
export const foldText = (text: string): string => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Whether a unit matches what was typed: any part of its name or its public title; everything matches nothing typed. */
export function unitMatches(unit: UnitChoice, query: string): boolean {
  const q = foldText(query);
  if (q === '') return true;
  return foldText(unit.name).includes(q) || foldText(unit.publicName).includes(q);
}

/** How many recent units the search keeps. */
export const RECENT_UNITS = 6;

/**
 * The recent units, most recent first, at most RECENT_UNITS: those this browser picked in the form before (`picked`,
 * newest first), then the properties of the jobs added by hand that the Schedule holds, newest added first.
 */
export function recentUnitIds(picked: readonly string[], added: readonly { propertyId: string; createdAt: string }[]): string[] {
  const out: string[] = [];
  const push = (id: string) => {
    if (out.length < RECENT_UNITS && !out.includes(id)) out.push(id);
  };
  for (const id of picked) push(id);
  for (const job of [...added].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) push(job.propertyId);
  return out;
}

/** The search's list: the matching units, recent first (in their recent order), then the rest by name. */
export function unitOrder(units: readonly UnitChoice[], query: string, recent: readonly string[]): { recent: UnitChoice[]; rest: UnitChoice[] } {
  const matching = units.filter((unit) => unitMatches(unit, query));
  const byId = new Map(matching.map((unit) => [unit.id, unit]));
  const first = recent.map((id) => byId.get(id)).filter((unit): unit is UnitChoice => unit !== undefined);
  const firstIds = new Set(first.map((unit) => unit.id));
  const rest = matching.filter((unit) => !firstIds.has(unit.id)).sort((a, b) => a.name.localeCompare(b.name, 'en-CA') || a.id.localeCompare(b.id));
  return { recent: first, rest };
}
