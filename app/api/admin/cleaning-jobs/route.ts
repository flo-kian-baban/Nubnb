/**
 * GET /api/admin/cleaning-jobs?from=yyyy-mm-dd&to=yyyy-mm-dd — the admin's Schedule (the cleaning schedule, phase 1,
 * Kian's rulings of 2026-10-14): the jobs whose checkout falls in those Toronto days, with their properties' names and
 * listed times, who is on each and what each mark's cleaning is now, the team for the picker, and the calendar copy's
 * age and the calendars it could not read.
 *
 * Without dates: from seven days back to two days ahead, the furthest a job is made. At most 92 days.
 *
 * Response: 200 `{ success: true, data: { jobs, team, calendar, unreadable, from, to, today, now, refresh } }`; 400 for
 * days not written yyyy-mm-dd, or from after to, or too long a range. `refresh` (Kian's ruling R1 of 2026-10-19):
 * `{ state: 'starting' | 'running', lastFinishedAt }` when the calendars are being read again because the copy was
 * more than three hours old (or from another day), so the page shows the run's result when it ends; null otherwise.
 *
 * Reads: the jobs in the range, their properties (name and times), the team (name, role, status), the cleanings marked
 * on them (status and amount), the copy (one document), and the refresh's state (one document, beside the rest). Nothing
 * here fetches a calendar: a refresh on open runs after the response (app/lib/availability/daily.ts), and Refresh
 * calendars is POST /api/admin/availability/refresh; each makes and watches the jobs after writing the copy.
 */

import { NextRequest } from 'next/server';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, noStore } from '@/app/lib/api/safe-response';
import { addDays, isDay, nightsBetween, torontoDay } from '@/app/lib/availability/days';
import { CREATE_DAYS_AHEAD } from '@/app/lib/schedule/model';
import { readSchedule } from '@/app/lib/firebase/server-cleaning-jobs';
import { refreshIfStale } from '@/app/lib/availability/daily';

/** A refresh on open may run after the answer (Kian's ruling R1): it has this long, as the first-visit routes do. */
export const maxDuration = 300;

const MAX_DAYS = 92;

export const GET = adminRoute(async function GET(request: NextRequest) {
  const params = new URL(request.url).searchParams;
  const today = torontoDay();
  const from = params.get('from') ?? addDays(today, -7);
  const to = params.get('to') ?? addDays(today, CREATE_DAYS_AHEAD);
  if (!isDay(from) || !isDay(to)) return noStore(apiError('Write the days as yyyy-mm-dd', 400));
  if (from > to) return noStore(apiError('The first day is after the last', 400));
  if (nightsBetween(from, to) > MAX_DAYS) return noStore(apiError(`At most ${MAX_DAYS} days at a time`, 400));
  try {
    const [schedule, refresh] = await Promise.all([readSchedule(from, to), refreshIfStale('admin-page')]);
    return noStore(apiSuccess({ ...schedule, from, to, today, now: new Date().toISOString(), refresh }));
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    console.error(`[jobs] the schedule could not be read: grpc code ${typeof code === 'number' ? code : 'unknown'}`);
    return noStore(apiFailure({ message: 'Could not load the schedule.', status: 500, code: 'SCHEDULE_READ_FAILED' }));
  }
});
