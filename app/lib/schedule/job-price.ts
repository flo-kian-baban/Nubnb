/**
 * The price in Assign and Change cleaner, and on the Schedule's row (Kian's instruction of 2026-11-06): "when assigning
 * a cleaner, the admin must see the unit's price for this job and be able to change it before sending, smoothly, with
 * the base prices shown as presets." Pure: the same for the page and the tests; nothing here reads or writes.
 *
 *   - The dialog's price opens on the job's own amount when it has one, else the unit's cleaning price for the job's
 *     tier (short 1–6 nights, mid 7–27, long 28+), else empty with the "Last typed" placeholder (Build 2: nothing is
 *     saved untyped). The unit's other cleaning prices stand beside it, one tap each.
 *   - It is sent only when the admin changed it (`jobPriceToSend`); the server stores exactly the tier's cleaning price
 *     as no amount on the job and anything else as the job's own amount, as the row's Amount… does.
 *   - Once the job's cleaning counts its money, the price is read-only: "Locked: already counted" (`jobMoneyCounts`).
 *   - The row shows the job's price beside the cleaner chip: "$80.00 · short", "$95.00 · set on the job" (`jobPriceTag`).
 */

import { TIER_WORDS, jobNights, jobTier, presetCents, priceField, type AmountSource, type CleaningPrices, type PresetKind } from '../cleanings/prices';
import { fieldStart } from '../cleanings/prices';
import type { LastTyped } from './add-job';

/** What these rules need of a job: its stay, tier, own amount and marks (a JobView has it all). */
export interface PricedJob {
  status: string;
  checkout: string;
  reservation: { start: string } | null;
  tier?: PresetKind | null;
  amountCents: number | null;
  assignees: { cleaning: { status: string | null; amountCents: number | null; amountFrom: AmountSource | null; extra: string | null } | null }[];
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const capital = (text: string) => `${text[0].toUpperCase()}${text.slice(1)}`;
/** "3 nights", "1 night"; '' for a job added by hand (no stay behind it). */
export function nightsWords(job: Pick<PricedJob, 'reservation' | 'checkout'>): string {
  const nights = jobNights(job);
  return nights === 0 ? '' : nights === 1 ? '1 night' : `${nights} nights`;
}

/** A mark's cleaning that counts its money (not waiting on a note, not without an amount): the price is then locked, as the row's Amount… is. */
export function countedCleaning(job: PricedJob): { amountCents: number; amountFrom: AmountSource | null } | null {
  for (const a of job.assignees) {
    const c = a.cleaning;
    if (c && c.status === 'logged' && c.amountCents !== null && c.extra !== 'asked') return { amountCents: c.amountCents, amountFrom: c.amountFrom };
  }
  return null;
}
export const jobMoneyCounts = (job: PricedJob): boolean => countedCleaning(job) !== null;

/** The words of the row's price: the tier's short word, "set on the job", or "typed". */
const SOURCE_SHORT: Record<AmountSource, string> = { short: 'short', mid: 'mid', long: 'long', job: 'set on the job', typed: 'typed' };

/**
 * The row's price beside the cleaner chip (item 4): what a mark counts now — a counted or waiting cleaning's own
 * amount when the job was marked; else the job's own amount ("set on the job"); else the unit's cleaning price for the
 * job's tier ("short"); else "no cleaning price". Null when there is nothing to show: a marked cleaning with no amount
 * (its chip says "needs an amount"), or a booking that changed with no mark.
 */
export function jobPriceTag(job: PricedJob, prices: CleaningPrices | null): { cents: number | null; words: string } | null {
  const marked = job.assignees.find((a) => a.cleaning !== null)?.cleaning ?? null;
  if (marked) return marked.amountCents === null ? null : { cents: marked.amountCents, words: marked.amountFrom ? SOURCE_SHORT[marked.amountFrom] : '' };
  if (job.status !== 'open') return null;
  if (job.amountCents !== null) return { cents: job.amountCents, words: SOURCE_SHORT.job };
  const tier = jobTier(job);
  const cents = presetCents(prices, tier);
  return cents === null ? { cents: null, words: 'no cleaning price' } : { cents, words: SOURCE_SHORT[tier] };
}

/** The row's price as one line: "$80.00 · short". */
export function jobPriceTagText(tag: { cents: number | null; words: string }): string {
  return tag.cents === null ? tag.words : tag.words ? `${money(tag.cents)} · ${tag.words}` : money(tag.cents);
}

/** What the dialog's price opens with: the counted amount when locked; else the job's own amount; else the tier's cleaning price; else empty. */
export function jobPriceStart(job: PricedJob, prices: CleaningPrices | null): string {
  const counted = countedCleaning(job);
  if (counted) return priceField(counted.amountCents);
  if (job.amountCents !== null) return priceField(job.amountCents);
  return priceField(presetCents(prices, jobTier(job)));
}

/** The grey placeholder of the dialog's price: the tier's cleaning price, else the amount last typed there (never a value). */
export function jobPricePlaceholder(job: PricedJob, prices: CleaningPrices | null, lastTyped: LastTyped | null): string {
  const tier = jobTier(job);
  const cents = presetCents(prices, tier);
  if (cents !== null) return priceField(cents);
  const typed = lastTyped?.[tier] ?? null;
  return typed === null ? '' : fieldStart({ kind: 'recommendation', tier, cents: typed, day: '' }).placeholder;
}

/**
 * The note under the dialog's price (§69.2's words): "Short-term cleaning price · 3 nights" when it holds (or, emptied,
 * falls back to) the tier's cleaning price; "Set on the job · 3 nights" when it holds anything else; "Last typed for
 * short-term: $73.10 · 3 nights" or "No short-term cleaning price · 3 nights" when the unit has none for the tier and it
 * is empty; "Locked: already counted" once the job's money counts. With "Also save as this unit's <tier> cleaning price"
 * ticked (`saving`), what the field holds reads as that cleaning price, which it is about to become.
 */
export function jobPriceWords(job: PricedJob, prices: CleaningPrices | null, lastTyped: LastTyped | null, amount: string, cents: number | null, saving = false): string {
  if (jobMoneyCounts(job)) return 'Locked: already counted';
  const tier = jobTier(job);
  const nights = nightsWords(job);
  const tail = nights ? ` · ${nights}` : '';
  // "Also save as this unit's <tier> cleaning price" ticked: what the field holds becomes that price, so it reads as one.
  const base = presetCents(prices, tier) ?? (saving && cents !== null ? cents : null);
  const tierPrice = `${capital(TIER_WORDS[tier])} cleaning price`;
  if (amount.trim() === '') {
    if (base !== null) return `${tierPrice}${tail}`;
    const typed = lastTyped?.[tier] ?? null;
    return typed !== null ? `Last typed for ${TIER_WORDS[tier]}: ${money(typed)}${tail}` : `No ${TIER_WORDS[tier]} cleaning price${tail}`;
  }
  if (cents === null) return 'Dollars and cents, like 75.00';
  return cents === base ? `${tierPrice}${tail}` : `Set on the job${tail}`;
}

/** "Also save as this unit's short-term cleaning price": offered only when the unit has none for the job's tier, and the job's money does not count yet. */
export function canSaveCleaningPrice(job: PricedJob, prices: CleaningPrices | null): boolean {
  return presetCents(prices, jobTier(job)) === null && !jobMoneyCounts(job);
}
export const saveCleaningPriceWords = (tier: PresetKind): string => `Also save as this unit’s ${TIER_WORDS[tier]} cleaning price`;

/**
 * What the dialog sends with the cleaner: nothing when the price was left as it opened and nothing is to be saved;
 * else the amount ("75.00", or null for an emptied field) and the tick. Refused in words: an amount that is not one,
 * or the tick with no amount.
 */
export function jobPriceToSend(job: PricedJob, start: string, amount: string, cents: number | null, saveCleaningPrice: boolean): { kind: 'none' } | { kind: 'send'; price: string | null; saveCleaningPrice: boolean } | { kind: 'bad'; problem: string } {
  if (jobMoneyCounts(job)) return { kind: 'none' };
  const empty = amount.trim() === '';
  if (!empty && cents === null) return { kind: 'bad', problem: 'The price is dollars and cents above $0.00, like 75.00, or empty.' };
  if (saveCleaningPrice && empty) return { kind: 'bad', problem: `Type the price to save it as this unit’s ${TIER_WORDS[jobTier(job)]} cleaning price.` };
  const before = start.trim() === '' ? null : start;
  const now = cents === null ? null : priceField(cents);
  if (now === before && !saveCleaningPrice) return { kind: 'none' };
  return { kind: 'send', price: now, saveCleaningPrice };
}
