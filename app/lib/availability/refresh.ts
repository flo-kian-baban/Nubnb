/**
 * One refresh: read the feed URLs, fetch every feed, build the snapshot
 * from the previous one, write it. Run by the scheduled Cloud Function
 * every hour and by POST /api/admin/availability/refresh on demand.
 *
 * Fetches go through the SSRF guard the public routes use: a feed URL is
 * admin-set, and inside a Cloud Function a private address would be the
 * metadata server. Eight feeds at a time, ten seconds each, one retry after
 * two seconds. A failure is recorded on the property and never stops the
 * run; the run itself fails only if Firestore does.
 *
 * The listing-page check (Kian, 2026-09-30: build it, subject to the
 * datacenter test) requests each property's Airbnb page and keeps only the
 * status: 200 is "live", 404 or 410 is "gone", anything else is "unknown".
 * The page asked for is the canonical one, https://www.airbnb.ca/rooms/<id>,
 * not the stored URL: two stored airbnb.com links with tracking parameters
 * answer 200 for listings that the canonical page answers 410 (verified
 * 2026-09-30). A stored URL that is not an Airbnb room is not checked. The
 * check runs when the newest check in the previous snapshot is older than
 * PAGE_CHECK_EVERY_HOURS, so about once a day; never on a manual refresh.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { guardedFetch, GuardedFetchError } from '../api/url-guard';
import { torontoDay } from './days';
import { buildSnapshot, type FeedSource, type FetchResult } from './snapshot';
import { readCurrent, readFeedSources, writeSnapshot } from './store';
import type { AirbnbPageCheck, AvailabilitySnapshot } from './types';

export const FEED_TIMEOUT_MS = 10_000;
export const FEED_MAX_BYTES = 5 * 1024 * 1024;
export const FEED_CONCURRENCY = 8;
export const FEED_RETRY_AFTER_MS = 2_000;
export const PAGE_TIMEOUT_MS = 10_000;
export const PAGE_CONCURRENCY = 4;
export const PAGE_CHECK_EVERY_HOURS = 20;

export type FetchText = (url: string) => Promise<FetchResult>;
export type CheckPage = (url: string) => Promise<{ status: number }>;

const describe = (err: unknown): string => (err instanceof Error ? err.message : 'Failed to fetch the calendar feed');

/** One feed, guarded, with one retry. Never throws. */
export async function fetchFeedText(url: string): Promise<FetchResult> {
  let lastError = 'Failed to fetch the calendar feed';
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, FEED_RETRY_AFTER_MS));
    try {
      const response = await guardedFetch(url, { maxResponseBytes: FEED_MAX_BYTES, timeoutMs: FEED_TIMEOUT_MS });
      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
        // A 4xx will not change on retry.
        if (response.status >= 400 && response.status < 500) break;
        continue;
      }
      const text = await response.text();
      if (!/BEGIN:VCALENDAR/.test(text)) {
        lastError = 'The answer was not a calendar';
        continue;
      }
      return { ok: true, text };
    } catch (err) {
      lastError = describe(err);
      // A blocked URL is a configuration fault, not a blip.
      if (err instanceof GuardedFetchError && /not allowed|Invalid URL|blocked/.test(err.message)) break;
    }
  }
  return { ok: false, error: lastError };
}

/** The canonical page of an Airbnb room URL, or null when the URL is not one. */
export function listingPageUrl(url: string): string | null {
  const match = url.match(/^https?:\/\/(?:www\.)?airbnb\.[a-z.]+\/rooms\/(\d+)(?:[/?#]|$)/i);
  return match ? `https://www.airbnb.ca/rooms/${match[1]}` : null;
}

/** One listing page, guarded, status only; the body is not read. Never throws. */
export async function checkListingPage(url: string): Promise<{ status: number }> {
  try {
    const response = await guardedFetch(url, { timeoutMs: PAGE_TIMEOUT_MS, headers: { accept: 'text/html' } });
    await response.body?.cancel().catch(() => undefined);
    return { status: response.status };
  } catch {
    return { status: 0 };
  }
}

export function pageVerdict(status: number): AirbnbPageCheck['verdict'] {
  if (status === 200) return 'live';
  if (status === 404 || status === 410) return 'gone';
  return 'unknown';
}

/** Run `task` over `items`, at most `limit` at a time, keeping order. */
async function inBatches<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await task(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** True when the previous snapshot's newest page check is older than PAGE_CHECK_EVERY_HOURS, or there is none. */
export function pageCheckDue(previous: AvailabilitySnapshot | null, now: Date): boolean {
  if (!previous) return true;
  let newest = 0;
  for (const entry of Object.values(previous.properties)) {
    const at = Date.parse(entry.airbnbPage?.checkedAt ?? '');
    if (Number.isFinite(at) && at > newest) newest = at;
  }
  return now.getTime() - newest > PAGE_CHECK_EVERY_HOURS * 3_600_000;
}

export interface RefreshOptions {
  db: Firestore;
  source: 'schedule' | 'manual';
  now?: Date;
  /** "auto" checks when due (the schedule); true and false force it. */
  checkPages?: 'auto' | boolean;
  fetchText?: FetchText;
  checkPage?: CheckPage;
  log?: (line: string) => void;
}

export interface RefreshOutcome {
  snapshot: AvailabilitySnapshot;
  dayWritten: boolean;
  pagesChecked: number;
}

export async function runRefresh(options: RefreshOptions): Promise<RefreshOutcome> {
  const { db, source } = options;
  const fetchText = options.fetchText ?? fetchFeedText;
  const checkPage = options.checkPage ?? checkListingPage;
  const log = options.log ?? (() => undefined);
  const startedAt = (options.now ?? new Date()).toISOString();
  const today = torontoDay(options.now ?? new Date());

  const [sources, previous] = await Promise.all([readFeedSources(db), readCurrent(db)]);
  log(`refresh (${source}): ${sources.length} properties, ${sources.filter((s) => s.icalUrl).length} with a feed, previous ${previous?.refreshedAt ?? 'none'}`);

  const withFeed = sources.filter((s) => s.icalUrl);
  const fetched = await inBatches(withFeed, FEED_CONCURRENCY, async (s) => [s.id, await fetchText(s.icalUrl)] as const);
  const results = new Map<string, FetchResult>(fetched);

  const wantPages = options.checkPages === true || (options.checkPages === 'auto' && source === 'schedule' && pageCheckDue(previous, new Date(startedAt)));
  const pageChecks = new Map<string, AirbnbPageCheck>();
  if (wantPages) {
    const withPage = sources
      .map((s: FeedSource) => ({ id: s.id, page: listingPageUrl(s.airbnbUrl) }))
      .filter((s): s is { id: string; page: string } => s.page !== null);
    const checks = await inBatches(withPage, PAGE_CONCURRENCY, async (s) => [s.id, await checkPage(s.page)] as const);
    const checkedAt = new Date().toISOString();
    for (const [id, { status }] of checks) pageChecks.set(id, { checkedAt, status, verdict: pageVerdict(status) });
  }

  const finishedAt = new Date().toISOString();
  const snapshot = buildSnapshot({ previous, sources, results, pageChecks, source, startedAt, finishedAt, today });
  const { dayWritten } = await writeSnapshot(db, snapshot);

  const failed = snapshot.run.failed;
  log(
    `refresh done in ${snapshot.run.durationMs} ms: ${snapshot.run.fetched} feeds read, ${failed.length} failed${failed.length ? ` (${failed.map((f) => f.name).join(', ')})` : ''}, ${pageChecks.size} pages checked, day ${snapshot.today} ${dayWritten ? 'written' : 'already kept'}`,
  );
  return { snapshot, dayWritten, pagesChecked: pageChecks.size };
}
