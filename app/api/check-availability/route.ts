import { startOfDay, endOfDay, parseISO } from 'date-fns';
import { createRateLimiter } from '@/app/lib/api/rate-limit';
import { validateIcalUrl, validateDateString } from '@/app/lib/api/validate';
import { getIcalFeed, IcalFetchError } from '@/app/lib/api/ical-cache';
import { apiSuccess, apiError, apiRateLimited } from '@/app/lib/api/safe-response';
import { parseIcalEvents } from '@/app/lib/api/ical-parser';

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

    const { icalUrl, startDate, endDate } = body;

    // ── Validate inputs ────────────────────────────────────
    const urlCheck = validateIcalUrl(icalUrl);
    if (!urlCheck.valid) return apiError(urlCheck.error!, 400);

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

    // ── Fetch iCal (SSRF-safe, cached for 10 minutes) ──────
    let icalData: string;
    try {
      icalData = await getIcalFeed(urlCheck.value!);
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
