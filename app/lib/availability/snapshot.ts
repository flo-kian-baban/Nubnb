/**
 * Building the stored copy from fetched feeds, and reading nights out of it.
 *
 * A refresh never starts from nothing: it takes the previous snapshot and
 * the results of this run's fetches, and every property whose fetch failed
 * keeps what was last read, marked failed. A property whose feed URL
 * changed since the last read drops the old events: they were another
 * calendar's.
 */

import { addDays, dayFromIndex, dayIndex, nightsBetween } from './days';
import { parseIcalEvents } from './ical';
import type {
  AirbnbPageCheck,
  AvailabilityEvent,
  AvailabilitySnapshot,
  NightState,
  PropertyAvailability,
  RefreshRun,
} from './types';

export const SNAPSHOT_VERSION = 1 as const;
/** How far ahead any Airbnb feed speaks: twelve months. */
export const HORIZON_DAYS = 365;

/** What the refresh reads off each property document. */
export interface FeedSource {
  id: string;
  name: string;
  icalUrl: string;
  airbnbUrl: string;
}

export type FetchResult = { ok: true; text: string } | { ok: false; error: string };

const RESERVED_SUMMARY = 'Reserved';

/** Airbnb's SUMMARY values: "Reserved" is a booking; anything else ("Airbnb (Not available)") is a block. */
export function kindOf(summary: string): AvailabilityEvent['kind'] {
  return summary === RESERVED_SUMMARY ? 'reserved' : 'blocked';
}

const dayOf = (date: Date): string => date.toISOString().slice(0, 10);

/**
 * The events of one feed, as stored: kind, UID and whole days only. Events
 * that ended before `today` are dropped; an event with no UID gets one made
 * of its dates, so a refresh can still compare it.
 */
export function eventsFromFeed(text: string, today: string): AvailabilityEvent[] {
  const events: AvailabilityEvent[] = [];
  for (const event of parseIcalEvents(text)) {
    const start = dayOf(event.start);
    const end = dayOf(event.end);
    if (end <= today) continue;
    events.push({ uid: event.uid || `${start}/${end}`, kind: kindOf(event.summary), start, end });
  }
  events.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.end < b.end ? -1 : a.end > b.end ? 1 : 0));
  return events;
}

const emptyEntry = (source: FeedSource): PropertyAvailability => ({
  name: source.name,
  icalUrl: source.icalUrl,
  status: source.icalUrl ? 'failed' : 'no-feed',
  fetchedAt: null,
  bytes: 0,
  eventCount: 0,
  events: [],
});

/**
 * One property after this run: the new events on a successful read; what
 * was last read, marked failed, otherwise. `previous` is what the last
 * snapshot held for it, if anything.
 */
export function applyFetch(
  previous: PropertyAvailability | undefined,
  source: FeedSource,
  result: FetchResult | undefined,
  nowIso: string,
  today: string,
): PropertyAvailability {
  const base = previous && previous.icalUrl === source.icalUrl ? { ...previous, name: source.name } : emptyEntry(source);
  // Keep a page check across runs that did not repeat it.
  const airbnbPage = previous?.airbnbPage;

  if (!source.icalUrl) {
    return { ...emptyEntry(source), ...(airbnbPage ? { airbnbPage } : {}) };
  }

  if (result?.ok) {
    const events = eventsFromFeed(result.text, today);
    return {
      name: source.name,
      icalUrl: source.icalUrl,
      status: 'ok',
      fetchedAt: nowIso,
      bytes: result.text.length,
      eventCount: events.length,
      events,
      ...(airbnbPage ? { airbnbPage } : {}),
    };
  }

  const error = result && !result.ok ? result.error : 'Not fetched';
  return {
    ...base,
    status: 'failed',
    failedSince: base.status === 'failed' && base.failedSince ? base.failedSince : nowIso,
    failures: (base.status === 'failed' ? base.failures ?? 0 : 0) + 1,
    error,
    ...(airbnbPage ? { airbnbPage } : {}),
  };
}

export interface BuildInput {
  previous: AvailabilitySnapshot | null;
  sources: FeedSource[];
  results: Map<string, FetchResult>;
  /** Listing-page checks made this run, by property ID; empty when the check did not run. */
  pageChecks: Map<string, AirbnbPageCheck>;
  source: RefreshRun['source'];
  startedAt: string;
  finishedAt: string;
  today: string;
}

/** The snapshot after one run. Pure: nothing is fetched or written here. */
export function buildSnapshot(input: BuildInput): AvailabilitySnapshot {
  const properties: Record<string, PropertyAvailability> = {};
  const failed: RefreshRun['failed'] = [];
  let fetched = 0;

  for (const source of input.sources) {
    const entry = applyFetch(input.previous?.properties[source.id], source, input.results.get(source.id), input.finishedAt, input.today);
    const check = input.pageChecks.get(source.id);
    if (check) entry.airbnbPage = check;
    properties[source.id] = entry;
    if (entry.status === 'ok' && input.results.get(source.id)?.ok) fetched++;
    if (entry.status === 'failed') failed.push({ propertyId: source.id, name: source.name, error: entry.error ?? 'Not fetched' });
  }

  return {
    version: SNAPSHOT_VERSION,
    refreshedAt: input.finishedAt,
    today: input.today,
    horizonEnd: addDays(input.today, HORIZON_DAYS),
    run: {
      source: input.source,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      durationMs: Math.max(0, Date.parse(input.finishedAt) - Date.parse(input.startedAt)),
      fetched,
      failed,
      pagesChecked: input.pageChecks.size,
    },
    properties,
  };
}

// ─── Reading nights ─────────────────────────────────────────────

/** True when this entry has ever been read: its events mean something. */
export function isReadable(feed: PropertyAvailability | null | undefined): feed is PropertyAvailability {
  return !!feed && feed.status !== 'no-feed' && feed.fetchedAt !== null;
}

/**
 * The state of each night from `from` (inclusive) to `to` (exclusive). A
 * reserved night wins over a blocked one where both are claimed.
 */
export function nightStates(feed: PropertyAvailability, from: string, to: string): NightState[] {
  const count = Math.max(0, nightsBetween(from, to));
  const states: NightState[] = new Array(count).fill('open');
  const first = dayIndex(from);
  for (const event of feed.events) {
    const start = Math.max(dayIndex(event.start), first);
    const end = Math.min(dayIndex(event.end), first + count);
    for (let n = start; n < end; n++) {
      const i = n - first;
      if (event.kind === 'reserved' || states[i] === 'open') states[i] = event.kind;
    }
  }
  return states;
}

/** The days of those nights, parallel to `nightStates`. */
export function nightDays(from: string, to: string): string[] {
  const count = Math.max(0, nightsBetween(from, to));
  const first = dayIndex(from);
  return Array.from({ length: count }, (_, i) => dayFromIndex(first + i));
}

/** Lengths of the runs of open nights, in order. */
export function openRuns(states: NightState[]): number[] {
  const runs: number[] = [];
  let run = 0;
  for (const state of states) {
    if (state === 'open') run++;
    else {
      if (run) runs.push(run);
      run = 0;
    }
  }
  if (run) runs.push(run);
  return runs;
}

/** Open nights that sit in a run at least `minNights` long: the nights sellable at the listed minimum. */
export function sellableNights(states: NightState[], minNights: number): number {
  const min = Math.max(1, minNights);
  return openRuns(states).filter((run) => run >= min).reduce((sum, run) => sum + run, 0);
}

export function count(states: NightState[], state: NightState): number {
  return states.reduce((n, s) => (s === state ? n + 1 : n), 0);
}

/** Blocked for the whole year ahead: not one open or reserved night in the horizon. */
export function isYearBlocked(feed: PropertyAvailability, today: string): boolean {
  return nightStates(feed, today, addDays(today, HORIZON_DAYS)).every((state) => state === 'blocked');
}

/**
 * The first day the host's booking window closes, when the feed shows one:
 * a block that runs to the edge of the feed's twelve months and starts
 * after tomorrow. Null when the calendar is open (or closed) to the edge.
 */
export function bookingWindowEnd(feed: PropertyAvailability, today: string): string | null {
  const edge = dayIndex(today) + HORIZON_DAYS - 1;
  const tomorrow = addDays(today, 1);
  let earliest: string | null = null;
  for (const event of feed.events) {
    if (event.kind !== 'blocked') continue;
    if (dayIndex(event.end) < edge) continue;
    if (event.start <= tomorrow) continue;
    if (earliest === null || event.start < earliest) earliest = event.start;
  }
  return earliest;
}

/** The UIDs of the reservations in an entry. */
export function reservedUids(feed: PropertyAvailability | undefined): Set<string> {
  const uids = new Set<string>();
  for (const event of feed?.events ?? []) if (event.kind === 'reserved') uids.add(event.uid);
  return uids;
}
