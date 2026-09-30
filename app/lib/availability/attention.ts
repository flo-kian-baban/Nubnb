/**
 * The attention list: which properties need pushing, ranked by the nights
 * they could actually sell (Kian, 2026-09-30: "empty nights in runs of at
 * least the property's minimum stay", with the raw empty count beside it),
 * and the two home-page figures.
 *
 * "Empty" is a night with no event. A blocked night is the owner's or
 * Airbnb's decision and is not counted as lost. A property blocked for the
 * whole horizon, or fully booked for it, is listed apart, never hidden.
 */

import { addDays, minutesBetween, weekendStay } from './days';
import { count, isReadable, nightStates, openRuns, reservedUids, sellableNights } from './snapshot';
import type { AttentionResult, AttentionRow, AvailabilityProperty, AvailabilitySnapshot, HistoryView, HomeFigures } from './types';

export const HORIZONS = [14, 30, 60, 90] as const;
export type Horizon = (typeof HORIZONS)[number];
export const isHorizon = (value: unknown): value is Horizon => HORIZONS.some((h) => String(h) === String(value));

/** How far back "booked in the last N days" looks. */
export const HISTORY_DAYS = 7;

/** The reservations a snapshot held, by property, for the history comparison. Unreadable properties are left out. */
export function historyView(snapshot: AvailabilitySnapshot, day: string): HistoryView {
  const reserved: Record<string, string[]> = {};
  for (const [id, entry] of Object.entries(snapshot.properties)) {
    if (isReadable(entry)) reserved[id] = [...reservedUids(entry)];
  }
  return { day, reserved };
}

/** A snapshot older than this is shown in the alert tone: the hourly refresh may have stopped. */
export const STALE_AFTER_MINUTES = 120;

/**
 * The list over the next `horizon` nights from `today`. `history` is what
 * the oldest daily snapshot of the last week held, for "booked in the last
 * 7 days"; null without.
 */
export function attentionList(
  snapshot: AvailabilitySnapshot | null,
  properties: AvailabilityProperty[],
  horizon: number,
  today: string,
  history: HistoryView | null = null,
): AttentionResult {
  const result: AttentionResult = {
    horizon,
    ranked: [],
    fullyBooked: [],
    blockedAll: [],
    unread: [],
    totals: { value: 0, rawValue: 0, withSellable: 0 },
    sinceDay: history?.day ?? null,
  };
  const end = addDays(today, horizon);

  for (const property of properties) {
    const feed = snapshot?.properties[property.id] ?? null;
    const airbnbGone = feed?.airbnbPage?.verdict === 'gone';
    if (!isReadable(feed)) {
      result.unread.push({
        property,
        group: 'ranked',
        empty: 0,
        sellable: 0,
        longestRun: 0,
        booked: 0,
        blocked: 0,
        value: 0,
        rawValue: 0,
        airbnbGone,
        feed,
        recentBookings: null,
      });
      continue;
    }
    const states = nightStates(feed, today, end);
    const empty = count(states, 'open');
    const booked = count(states, 'reserved');
    const blocked = count(states, 'blocked');
    const sellable = sellableNights(states, property.minNights);
    const longestRun = Math.max(0, ...openRuns(states));
    const group: AttentionRow['group'] = empty > 0 ? 'ranked' : booked > 0 ? 'fullyBooked' : 'blockedAll';

    let recentBookings: number | null = null;
    const earlier = history?.reserved[property.id];
    if (earlier) {
      const before = new Set(earlier);
      recentBookings = [...reservedUids(feed)].filter((uid) => !before.has(uid)).length;
    }

    const row: AttentionRow = {
      property,
      group,
      empty,
      sellable,
      longestRun,
      booked,
      blocked,
      value: sellable * property.nightly,
      rawValue: empty * property.nightly,
      airbnbGone,
      feed,
      recentBookings,
    };
    if (group === 'ranked') {
      result.ranked.push(row);
      result.totals.value += row.value;
      result.totals.rawValue += row.rawValue;
      if (sellable > 0) result.totals.withSellable++;
    } else if (group === 'fullyBooked') result.fullyBooked.push(row);
    else result.blockedAll.push(row);
  }

  const byValue = (a: AttentionRow, b: AttentionRow) =>
    b.value - a.value || b.rawValue - a.rawValue || b.empty - a.empty || a.property.name.localeCompare(b.property.name);
  result.ranked.sort(byValue);
  result.fullyBooked.sort((a, b) => b.property.nightly - a.property.nightly);
  result.blockedAll.sort((a, b) => a.property.name.localeCompare(b.property.name));
  result.unread.sort((a, b) => a.property.name.localeCompare(b.property.name));
  return result;
}

/** How old a snapshot is, and whether that is too old. */
export function freshness(snapshot: AvailabilitySnapshot, nowIso: string): { ageMinutes: number; stale: boolean; failed: number } {
  const ageMinutes = minutesBetween(snapshot.refreshedAt, nowIso);
  return {
    ageMinutes,
    stale: !Number.isFinite(ageMinutes) || ageMinutes > STALE_AFTER_MINUTES,
    failed: snapshot.run.failed.length,
  };
}

/** The two home tiles: empty nights next 30, and free this weekend. */
export function homeFigures(snapshot: AvailabilitySnapshot, properties: AvailabilityProperty[], today: string, nowIso: string): HomeFigures {
  const thirty = attentionList(snapshot, properties, 30, today);
  const weekend = weekendStay(today);
  let free = 0;
  let of = 0;
  for (const property of properties) {
    const feed = snapshot.properties[property.id];
    if (!isReadable(feed)) continue;
    of++;
    if (nightStates(feed, weekend.checkIn, weekend.checkOut).every((state) => state === 'open')) free++;
  }
  const fresh = freshness(snapshot, nowIso);
  return {
    value30: thirty.totals.value,
    rawValue30: thirty.totals.rawValue,
    withSellable30: thirty.totals.withSellable,
    fullyBooked30: thirty.fullyBooked.length,
    blockedAll30: thirty.blockedAll.length,
    weekend: { ...weekend, free, of },
    refreshedAt: snapshot.refreshedAt,
    ...fresh,
  };
}
