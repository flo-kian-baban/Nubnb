import { startOfDay, endOfDay, parseISO } from 'date-fns';
import { createRateLimiter } from '@/app/lib/api/rate-limit';
import { validateIcalUrl, validateDateString } from '@/app/lib/api/validate';
import { guardedFetch, GuardedFetchError } from '@/app/lib/api/url-guard';
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

    // ── Fetch iCal (SSRF-safe) ─────────────────────────────
    let icalData: string;
    try {
      const response = await guardedFetch(urlCheck.value!, {
        maxResponseBytes: 5 * 1024 * 1024, // 5 MB max for iCal
        timeoutMs: 10_000,
      });
      if (!response.ok) {
        return apiError('Failed to fetch the calendar feed', 502);
      }
      icalData = await response.text();
    } catch (err) {
      if (err instanceof GuardedFetchError) {
        return apiError(err.message, 400);
      }
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
