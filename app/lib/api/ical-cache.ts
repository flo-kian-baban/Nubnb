/**
 * One cached read of an iCal feed, shared by both availability routes.
 *
 * ── Why ──
 * A visitor picking dates triggers a check per change, and the availability
 * filter fans out across every property with an `icalUrl`. Each of those used
 * to be its own round trip to Airbnb: slow for the visitor, and a burst of
 * outbound requests that Airbnb has every reason to start throttling.
 *
 * A calendar does not change minute to minute. Ten minutes of staleness is
 * invisible to a renter and removes essentially all of the repeat traffic —
 * flipping between date ranges on one property now fetches Airbnb once.
 *
 * ── Two layers, on purpose ──
 *  1. `unstable_cache` — Vercel's Data Cache. Shared across function
 *     instances and survives a cold start, so the ten minutes is real rather
 *     than per-lambda.
 *  2. A module-level Map — covers the same warm instance handling a burst
 *     within one render, and is the entire cache when running locally where
 *     there is no Data Cache behind it.
 *
 * ── What is NOT cached ──
 * Failures. A feed that timed out or 502'd is not written to either layer, so
 * a transient Airbnb blip cannot pin "unavailable" in front of a property for
 * ten minutes. The next request retries.
 *
 * The SSRF guard still runs on every call, before anything is cached: the URL
 * is validated by `guardedFetch` itself, and the cache key is the validated
 * URL. A blocked URL throws and is never stored.
 */

import { unstable_cache } from 'next/cache';
import { guardedFetch, GuardedFetchError } from './url-guard';

/** How long a fetched calendar is reused. */
export const ICAL_TTL_SECONDS = 600;

const MAX_ICAL_BYTES = 5 * 1024 * 1024;
const ICAL_TIMEOUT_MS = 10_000;

/** Warm-instance layer. Bounded so a long-lived instance cannot grow forever. */
const MAX_MEMO_ENTRIES = 200;
const memo = new Map<string, { text: string; expires: number }>();

/** Raised when the feed could not be read. Never cached. */
export class IcalFetchError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'IcalFetchError';
    this.status = status;
  }
}

async function fetchIcal(url: string): Promise<string> {
  let response: Response;
  try {
    response = await guardedFetch(url, {
      maxResponseBytes: MAX_ICAL_BYTES,
      timeoutMs: ICAL_TIMEOUT_MS,
    });
  } catch (err) {
    // A blocked URL is the caller's fault (400); anything else is upstream.
    if (err instanceof GuardedFetchError) throw new IcalFetchError(err.message, 400);
    throw new IcalFetchError('Failed to fetch the calendar feed', 502);
  }

  if (!response.ok) throw new IcalFetchError('Failed to fetch the calendar feed', 502);
  return response.text();
}

/**
 * The text of `url`'s calendar, at most `ICAL_TTL_SECONDS` old.
 *
 * @throws IcalFetchError — carrying the status the route should return.
 */
export async function getIcalFeed(url: string): Promise<string> {
  const now = Date.now();

  const hit = memo.get(url);
  if (hit && hit.expires > now) return hit.text;

  // Keyed by URL in the cache key *and* the tag, so two properties sharing a
  // calendar share one cache entry and a third cannot evict them.
  const cached = unstable_cache(() => fetchIcal(url), ['ical-feed', url], {
    revalidate: ICAL_TTL_SECONDS,
    tags: ['ical-feed'],
  });

  const text = await cached();

  if (memo.size >= MAX_MEMO_ENTRIES) {
    // Cheapest possible eviction: drop the oldest insertion. The map is a
    // read-through cache, so losing an entry costs one extra fetch.
    const oldest = memo.keys().next();
    if (!oldest.done) memo.delete(oldest.value);
  }
  memo.set(url, { text, expires: now + ICAL_TTL_SECONDS * 1000 });

  return text;
}
