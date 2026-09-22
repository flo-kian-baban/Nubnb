/**
 * GET /api/booked-dates/[id] — a property's booked ranges, cached at the edge.
 *
 * ── What this replaces ──
 * `POST /api/fetch-booked-dates` took an `icalUrl` in a JSON body. A POST is
 * uncacheable by definition, so every property a visitor opened ran a Vercel
 * function, and the availability filter ran one per property with a calendar.
 * The answer is the same for everybody and changes at the pace a calendar
 * changes, so it has no business being computed per request.
 *
 * Keyed by property ID rather than by iCal URL: the URL is a detail of how we
 * get the answer, it is not something a caller should be able to choose. A
 * GET that fetched an arbitrary attacker-supplied URL would be an open proxy,
 * so the URL is now read from the document and never taken from the request.
 * That also removes the SSRF surface the POST route had to guard.
 *
 * ── Caching ──
 * `s-maxage=600` puts the answer in Vercel's CDN for ten minutes; a repeat
 * request inside that window is a `x-vercel-cache: HIT` and runs no function.
 * `stale-while-revalidate` lets an expired entry be served while one request
 * refreshes it, so a visitor never waits on Airbnb.
 *
 * Underneath, `getIcalFeed` holds the feed itself for ten minutes as well, so
 * even a cache miss usually does not reach Airbnb.
 *
 * ── Failures are never cached ──
 * Every non-200 carries `Cache-Control: no-store`. A calendar that timed out
 * or 502'd must not be able to pin "unavailable" in front of a property for
 * ten minutes; the next request retries. This is the reason the route sets
 * its headers by hand rather than using `export const revalidate`, which
 * would cache whatever the handler returned, including an error.
 */

import { getAdminDb } from '@/app/lib/firebase/admin';
import { getIcalFeed, IcalFetchError } from '@/app/lib/api/ical-cache';
import { parseIcalEvents } from '@/app/lib/api/ical-parser';
import { addYears, startOfDay } from 'date-fns';

const COLLECTION = 'properties';

/** Ten minutes at the edge, then a day of serving stale while it refreshes. */
const EDGE_CACHE = 'public, s-maxage=600, stale-while-revalidate=86400';
const NO_CACHE = 'no-store';

interface RouteContext {
  params: Promise<{ id: string }>;
}

function json(body: unknown, status: number, cacheControl: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': cacheControl },
  });
}

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;

  let icalUrl: string;
  try {
    const snap = await getAdminDb().collection(COLLECTION).doc(id).get();
    if (!snap.exists) {
      return json({ success: false, error: 'Property not found' }, 404, NO_CACHE);
    }
    const raw = snap.data()?.icalUrl;
    icalUrl = typeof raw === 'string' ? raw.trim() : '';
  } catch (err) {
    console.error(`[booked-dates/${id}] property read failed:`, err);
    return json({ success: false, error: 'Could not read this property' }, 502, NO_CACHE);
  }

  // No calendar is a real, stable answer — nothing is booked as far as we
  // know — so it is cached like any other success.
  if (!icalUrl) {
    return json({ success: true, data: { bookedRanges: [] } }, 200, EDGE_CACHE);
  }

  let icalData: string;
  try {
    icalData = await getIcalFeed(icalUrl);
  } catch (err) {
    const status = err instanceof IcalFetchError ? err.status : 502;
    console.warn(`[booked-dates/${id}] calendar fetch failed:`, err);
    return json({ success: false, error: 'Failed to fetch the calendar feed' }, status, NO_CACHE);
  }

  try {
    const today = startOfDay(new Date());
    const maxDate = addYears(today, 1);
    const bookedRanges: { start: string; end: string }[] = [];

    for (const event of parseIcalEvents(icalData)) {
      if (event.end > today && event.start < maxDate) {
        const clampedStart = event.start < today ? today : event.start;
        const clampedEnd = event.end > maxDate ? maxDate : event.end;
        bookedRanges.push({
          start: clampedStart.toISOString().split('T')[0],
          end: clampedEnd.toISOString().split('T')[0],
        });
      }
    }

    return json({ success: true, data: { bookedRanges } }, 200, EDGE_CACHE);
  } catch (err) {
    console.error(`[booked-dates/${id}] parse failed:`, err);
    return json({ success: false, error: 'Failed to parse calendar data' }, 500, NO_CACHE);
  }
}
