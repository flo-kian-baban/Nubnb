/**
 * The search: what an admin on a call types, and what comes back, with the
 * reason for every row. Pure; the page calls it on every keystroke against
 * the one snapshot it holds.
 *
 * Fits first, then near misses, then the year-blocked apart. "Near" means
 * at most two conditions missed, each within a tolerance: dates, free if
 * the stay moves by up to three days or at least half its nights are open;
 * guests, short by at most two; price, at most a quarter over; bedrooms, one
 * off; city and type, any other. The listed minimum stay is a note, never a
 * wall: it is the admin's own number to bend.
 */

import { addDays, dayText, nightsBetween } from './days';
import { bookingWindowEnd, count, isReadable, isYearBlocked, nightDays, nightStates } from './snapshot';
import type {
  AvailabilityProperty,
  AvailabilitySnapshot,
  BedroomsFilter,
  NightState,
  Reason,
  SearchQuery,
  SearchResult,
  SearchRow,
} from './types';

export const NEAR = {
  /** Days the stay may move, either way, and still be offered. */
  SHIFT_DAYS: 3,
  /** Guests the property may be short by. */
  GUESTS_SHORT: 2,
  /** How far over the budget a nightly price may be: 25 %. */
  PRICE_OVER: 0.25,
  /** Conditions a property may miss and still be listed. */
  MISSES: 2,
  /** How far a "closest" window is looked for when nothing fits or is near. */
  CLOSEST_DAYS: 14,
} as const;

export const BEDROOM_OPTIONS: { value: BedroomsFilter; label: string; match: (bedrooms: number) => boolean }[] = [
  { value: 'any', label: 'Any bedrooms', match: () => true },
  { value: '0', label: 'Studio', match: (n) => n === 0 },
  { value: '1', label: '1 bedroom', match: (n) => n === 1 },
  { value: '2', label: '2 bedrooms', match: (n) => n === 2 },
  { value: '3', label: '3 bedrooms', match: (n) => n === 3 },
  { value: '4+', label: '4+ bedrooms', match: (n) => n >= 4 },
];

export const isBedroomsFilter = (value: unknown): value is BedroomsFilter =>
  BEDROOM_OPTIONS.some((option) => option.value === value);

const bedroomsAsked = (filter: BedroomsFilter): number => (filter === '4+' ? 4 : Number(filter));

/** Lower-case, accents set aside, for matching what an admin typed. */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/**
 * Every word typed starts some word of the name, area, city, type, slug or
 * an offer: "basement markham" finds a basement in Markham, "hot tub" finds
 * a hot tub and not hot water beside a bathtub, "park" finds free parking.
 */
export function matchesText(property: AvailabilityProperty, text: string): boolean {
  const words = fold(text).split(/[^a-z0-9]+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = fold(
    [property.name, property.area, property.city, property.location, property.type, property.slug, ...property.offerNames].join(' '),
  )
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return words.every((word) => haystack.some((h) => h.startsWith(word)));
}

const plural = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

/** The earliest shift, within ±SHIFT_DAYS, that makes the stay free; null when none. */
function freeShift(states: (from: string, to: string) => NightState[], checkIn: string, checkOut: string, today: string): number | null {
  const nights = nightsBetween(checkIn, checkOut);
  for (let k = 1; k <= NEAR.SHIFT_DAYS; k++) {
    for (const shift of [k, -k]) {
      const from = addDays(checkIn, shift);
      if (from < today) continue;
      if (states(from, addDays(from, nights)).every((state) => state === 'open')) return shift;
    }
  }
  return null;
}

function shiftText(shift: number): string {
  const days = Math.abs(shift);
  return `free if moved ${plural(days, 'day', 'days')} ${shift > 0 ? 'later' : 'earlier'}`;
}

interface Judged {
  row: SearchRow;
  within: boolean;
}

function judge(property: AvailabilityProperty, snapshot: AvailabilitySnapshot | null, query: SearchQuery, today: string): Judged {
  const feed = snapshot?.properties[property.id] ?? null;
  const hasDates = !!(query.checkIn && query.checkOut);
  const nights = hasDates ? nightsBetween(query.checkIn, query.checkOut) : 0;
  const reasons: Reason[] = [];
  let within = true;
  let states: NightState[] = [];
  let days: string[] = [];
  let openNext30: number | null = null;

  if (feed && isReadable(feed)) {
    if (hasDates) {
      states = nightStates(feed, query.checkIn, query.checkOut);
      days = nightDays(query.checkIn, query.checkOut);
      const open = count(states, 'open');
      if (open < nights) {
        const shift = freeShift((from, to) => nightStates(feed, from, to), query.checkIn, query.checkOut, today);
        if (shift !== null) reasons.push({ kind: 'dates', text: shiftText(shift), miss: true });
        else if (open * 2 >= nights) {
          const taken = days.filter((_, i) => states[i] !== 'open');
          const first = taken[0];
          const how = states[days.indexOf(first)] === 'reserved' ? 'booked' : 'blocked';
          reasons.push({ kind: 'dates', text: `${open} of ${nights} nights open (${how} ${dayText(first)})`, miss: true });
        } else {
          reasons.push({ kind: 'dates', text: `${open} of ${nights} nights open`, miss: true });
          within = false;
        }
      }
      if (property.minNights > nights) {
        reasons.push({ kind: 'minNights', text: `listed minimum ${plural(property.minNights, 'night', 'nights')}`, miss: false });
      }
    } else {
      openNext30 = count(nightStates(feed, today, addDays(today, 30)), 'open');
    }
  }

  if (query.guests !== null && property.guests < query.guests) {
    reasons.push({ kind: 'guests', text: `sleeps ${property.guests}`, miss: true });
    if (query.guests - property.guests > NEAR.GUESTS_SHORT) within = false;
  }
  if (query.city !== null && property.city !== query.city) {
    reasons.push({ kind: 'city', text: property.city || 'city not set', miss: true });
  }
  if (query.bedrooms !== 'any') {
    const option = BEDROOM_OPTIONS.find((o) => o.value === query.bedrooms);
    if (option && !option.match(property.bedrooms)) {
      reasons.push({ kind: 'bedrooms', text: property.bedrooms === 0 ? 'studio' : plural(property.bedrooms, 'bedroom', 'bedrooms'), miss: true });
      const asked = bedroomsAsked(query.bedrooms);
      if (Math.abs(property.bedrooms - asked) > 1) within = false;
    }
  }
  if (query.type !== null && property.type !== query.type) {
    reasons.push({ kind: 'type', text: property.type ? property.type.toLowerCase() : 'type not set', miss: true });
  }
  if (query.maxNightly !== null && property.nightly > query.maxNightly) {
    reasons.push({ kind: 'price', text: `$${(property.nightly - query.maxNightly).toLocaleString('en-CA')} over`, miss: true });
    if (property.nightly > query.maxNightly * (1 + NEAR.PRICE_OVER)) within = false;
  }

  const missed = reasons.filter((reason) => reason.miss).length;
  if (missed > NEAR.MISSES) within = false;
  if (missed === 0) reasons.unshift({ kind: 'fits', text: 'Fits', miss: false });

  return {
    within,
    row: {
      property,
      nights: states,
      nightDays: days,
      openNights: count(states, 'open'),
      reasons,
      missed,
      stayTotal: hasDates ? nights * property.nightly : null,
      openNext30,
      feed,
    },
  };
}

const byPrice = (a: SearchRow, b: SearchRow) => a.property.nightly - b.property.nightly || a.property.name.localeCompare(b.property.name);

/**
 * The answer to a query. `today` is the Toronto day the page is looking
 * from; nights before it are not searchable.
 */
export function searchProperties(
  snapshot: AvailabilitySnapshot | null,
  properties: AvailabilityProperty[],
  query: SearchQuery,
  today: string,
): SearchResult {
  const hasDates = !!(query.checkIn && query.checkOut);
  const nights = hasDates ? nightsBetween(query.checkIn, query.checkOut) : 0;
  const result: SearchResult = { fits: [], near: [], yearBlocked: [], beyondWindow: [], unread: [], closest: [], nights };

  const candidates: { property: AvailabilityProperty; judged: Judged }[] = [];

  for (const property of properties) {
    if (!matchesText(property, query.text)) continue;
    const feed = snapshot?.properties[property.id];
    if (!isReadable(feed)) {
      result.unread.push(property);
      continue;
    }
    const judged = judge(property, snapshot, query, today);
    if (isYearBlocked(feed, today)) {
      // Its own group: the reason is the block, whatever else was asked.
      judged.row.reasons = [{ kind: 'dates', text: 'blocked for the whole year', miss: true }, ...judged.row.reasons.filter((r) => r.kind !== 'fits' && r.kind !== 'dates')];
      judged.row.missed = judged.row.reasons.filter((r) => r.miss).length;
      result.yearBlocked.push(judged.row);
      continue;
    }
    if (hasDates) {
      const windowEnd = bookingWindowEnd(feed, today);
      if (windowEnd !== null && query.checkOut > windowEnd) {
        result.beyondWindow.push(property);
        continue;
      }
    }
    candidates.push({ property, judged });
    if (judged.row.missed === 0) result.fits.push(judged.row);
    else if (judged.within) result.near.push(judged.row);
  }

  result.fits.sort(byPrice);
  result.near.sort((a, b) => a.missed - b.missed || byPrice(a, b));
  result.yearBlocked.sort(byPrice);

  // Nothing fits and nothing is near: say what came closest.
  if (hasDates && result.fits.length === 0 && result.near.length === 0 && snapshot) {
    const closest: { property: AvailabilityProperty; distance: number; text: string }[] = [];
    for (const { property } of candidates) {
      const feed = snapshot.properties[property.id];
      if (!isReadable(feed)) continue;
      if (query.guests !== null && property.guests < query.guests) continue;
      for (let k = 0; k <= NEAR.CLOSEST_DAYS; k++) {
        let found = false;
        for (const shift of k === 0 ? [0] : [k, -k]) {
          const from = addDays(query.checkIn, shift);
          if (from < today) continue;
          if (nightStates(feed, from, addDays(from, nights)).every((state) => state === 'open')) {
            closest.push({ property, distance: k, text: k === 0 ? 'free on those dates' : `free from ${dayText(from)}` });
            found = true;
            break;
          }
        }
        if (found) break;
      }
    }
    closest.sort((a, b) => a.distance - b.distance || a.property.nightly - b.property.nightly);
    if (closest.length === 0 && query.guests !== null) {
      // Nothing sleeps the party at all: the largest that is free.
      for (const { property } of candidates) {
        const feed = snapshot.properties[property.id];
        if (!isReadable(feed)) continue;
        if (nightStates(feed, query.checkIn, query.checkOut).every((state) => state === 'open')) {
          closest.push({ property, distance: 0, text: `free on those dates, sleeps ${property.guests}` });
        }
      }
      closest.sort((a, b) => b.property.guests - a.property.guests);
    }
    result.closest = closest.slice(0, 3).map(({ property, text }) => ({ property, text }));
  }

  return result;
}
