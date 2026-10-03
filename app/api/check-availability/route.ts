/**
 * POST /api/check-availability — are these dates free for this property?
 *
 * Body: `{ propertyId, startDate, endDate }` (dates as yyyy-mm-dd).
 *
 * Dispatch 26: the browser used to send the property's calendar link here.
 * The link no longer reaches any public page (it carries a secret key, and
 * its feed carries guests' details), so the browser sends the property's ID
 * and the link is read on the server. A link sent by a browser is ignored,
 * which also means this route can no longer be pointed at a calendar of the
 * caller's choosing.
 */

import { startOfDay, endOfDay, parseISO } from 'date-fns';
import { createRateLimiter } from '@/app/lib/api/rate-limit';
import { validateDateString } from '@/app/lib/api/validate';
import { getIcalFeed, IcalFetchError } from '@/app/lib/api/ical-cache';
import { apiSuccess, apiError, apiFailure, apiRateLimited } from '@/app/lib/api/safe-response';
import { parseIcalEvents } from '@/app/lib/api/ical-parser';
import { isPropertyId, readCalendarLink, type CalendarLink } from '@/app/lib/firebase/server-calendar';

// 30 requests per minute per IP
const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 30 });

export async function POST(request: Request) {
  // ── Rate limit ───────────────────────────────────────────
  const limit = await limiter.check(request);
  if (limit.limited) return apiRateLimited(limit.retryAfterMs);

  try {
    // ── Parse body ─────────────────────────────────────────
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return apiError('Invalid JSON body', 400);
    }

    const { propertyId, startDate, endDate } = body;

    // ── Validate inputs ────────────────────────────────────
    if (!isPropertyId(propertyId)) return apiError('propertyId is required', 400);

    const startCheck = validateDateString(startDate, 'startDate');
    if (!startCheck.valid) return apiError(startCheck.error!, 400);

    const endCheck = validateDateString(endDate, 'endDate');
    if (!endCheck.valid) return apiError(endCheck.error!, 400);

    // Logical: start must be before end
    const requestedStart = startOfDay(parseISO(startCheck.value!));
    const requestedEnd = endOfDay(parseISO(endCheck.value!));
    if (requestedStart >= requestedEnd) {
      return apiError('startDate must be before endDate', 400);
    }

    // ── The property's calendar link, read on the server ───
    let link: CalendarLink;
    try {
      link = await readCalendarLink(propertyId);
    } catch (err) {
      return apiError('Could not read this property', 502, err);
    }
    if (link.kind === 'not-found') return apiError('Property not found', 404);
    if (link.kind === 'none') {
      return apiFailure({ message: 'No calendar is connected to this property', status: 422, code: 'NO_CALENDAR' });
    }

    // ── Fetch iCal (SSRF-safe, cached for 10 minutes) ──────
    let icalData: string;
    try {
      icalData = await getIcalFeed(link.url);
    } catch (err) {
      if (err instanceof IcalFetchError) return apiError(err.message, err.status);
      return apiError('Failed to fetch the calendar feed', 502, err);
    }

    // ── Parse & check availability ─────────────────────────
    const events = parseIcalEvents(icalData);

    let isAvailable = true;
    for (const event of events) {
      // Overlap: requestedStart < eventEnd AND requestedEnd > eventStart
      if (requestedStart < event.end && requestedEnd > event.start) {
        isAvailable = false;
        break;
      }
    }

    return apiSuccess({ available: isAvailable });

  } catch (error) {
    return apiError('Failed to verify availability against the calendar', 500, error);
  }
}
