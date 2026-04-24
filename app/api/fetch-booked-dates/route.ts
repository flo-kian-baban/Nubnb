import { addYears, startOfDay } from 'date-fns';
import { createRateLimiter } from '@/app/lib/api/rate-limit';
import { validateIcalUrl } from '@/app/lib/api/validate';
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

    const { icalUrl } = body;

    // ── Validate inputs ────────────────────────────────────
    const urlCheck = validateIcalUrl(icalUrl);
    if (!urlCheck.valid) return apiError(urlCheck.error!, 400);

    // ── Fetch iCal (SSRF-safe) ─────────────────────────────
    let icalData: string;
    try {
      const response = await guardedFetch(urlCheck.value!, {
        maxResponseBytes: 5 * 1024 * 1024,
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

    // ── Parse events & collect booked ranges ───────────────
    const today = startOfDay(new Date());
    const maxDate = addYears(today, 1);
    const events = parseIcalEvents(icalData);

    const bookedRanges: { start: string; end: string }[] = [];
    for (const event of events) {
      // Only include events that overlap with our window (today → 1 year out)
      if (event.end > today && event.start < maxDate) {
        const clampedStart = event.start < today ? today : event.start;
        const clampedEnd = event.end > maxDate ? maxDate : event.end;

        bookedRanges.push({
          start: clampedStart.toISOString().split('T')[0],
          end: clampedEnd.toISOString().split('T')[0],
        });
      }
    }

    return apiSuccess({ bookedRanges });

  } catch (error) {
    return apiError('Failed to parse calendar data', 500, error);
  }
}
