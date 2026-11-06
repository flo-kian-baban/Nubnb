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
 * on them (status, amount and the extra's state), the copy (one document), and the refresh's state (one document, beside
 * the rest). Nothing here fetches a calendar: a refresh on open runs after the response (app/lib/availability/daily.ts),
 * and Refresh calendars is POST /api/admin/availability/refresh; each makes and watches the jobs after writing the copy.
 *
 * POST /api/admin/cleaning-jobs — add a job by hand (Kian's ruling C of 2026-11-01): for any property, with or without
 * a calendar, any active cleaner or nobody yet, its label (Build 2: "Deep clean"; none typed reads "Extra visit"), the
 * tier its amount's price came from, and the amount. Any number of jobs may share a property and a day (Build 2: no
 * JOB_EXISTS). Body: `{ propertyId, checkout, cleanerId: string | null, tier: 'short' | 'mid' | 'long', amount?: "75.00"
 * | null, label?: string | null, alreadyCleaned?: boolean }`.
 *
 * The UX pass (Kian's instruction of 2026-11-06):
 *   - `checkout` from November 1, 2026 (the statements floor) on; earlier is 422 JOB_DAY_REFUSED, "Statements start in
 *     November 2026".
 *   - `amount` is what the form's field held: exactly the tier's cleaning price is stored as that price (no amount on
 *     the job, so it reads as the tier's price), anything else as the job's own amount (ruling B); null for none.
 *   - `alreadyCleaned`: the job is recorded cleaned for its cleaner as it is added, in the same transaction, exactly as
 *     POST …/[id]/record does (the same cleaning, amount and history), and the activity log gets that route's line
 *     ("Recorded a cleaning job as cleaned") after this one's. 422 JOB_NEEDS_CLEANER with nobody on it; 409 JOB_NOT_YET
 *     on a day that has not come; 422 BAD_DAY when a cleaning cannot be logged for the day. Nothing is added then.
 *
 * Response: 201 `{ job, propertyName, recorded: { cleanings: [{ cleanerId, cleaningId, amountCents }], statementMonth }
 * | null }` (the job as stored); 404 PROPERTY_NOT_FOUND; 422 CLEANER_NOT_ASSIGNABLE; 502 when the outcome is unknown.
 * Recorded in the activity log.
 */

import { NextRequest } from 'next/server';
import { adminRoute, recordAlso } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, noStore } from '@/app/lib/api/safe-response';
import { addDays, dayText, isDay, nightsBetween, torontoDay } from '@/app/lib/availability/days';
import { CREATE_DAYS_AHEAD } from '@/app/lib/schedule/model';
import { ADD_JOB_REFUSALS, addJob, readSchedule } from '@/app/lib/firebase/server-cleaning-jobs';
import { refreshIfStale } from '@/app/lib/availability/daily';
import { apiValidationError } from '@/app/lib/api/safe-response';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { AddJobSchema } from '@/app/lib/cleanings/schemas';

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

const NOT_ASSIGNABLE = { missing: 'no longer exists', 'not-a-cleaner': 'is a handyman, not a cleaner', inactive: 'is deactivated' } as const;

export const POST = adminRoute(async function POST(request: NextRequest, _context: unknown, { actor }) {
  const crossSite = refuseCrossSite(request);
  if (crossSite) return crossSite;
  const wrongType = requireMediaType(request, 'application/json');
  if (wrongType) return wrongType;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return noStore(apiError('Invalid JSON body', 400));
  }
  const parsed = AddJobSchema.safeParse(body);
  if (!parsed.success) return noStore(apiValidationError(parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))));
  const { propertyId, checkout, cleanerId, tier, amount, label, alreadyCleaned } = parsed.data;
  const outcome = await addJob(actor, { propertyId, checkout, cleanerId, tier, amountCents: amount, label, alreadyCleaned });
  switch (outcome.kind) {
    case 'added':
      // "Already cleaned": Record as cleaned's own line in the activity log, after this request's.
      if (outcome.recorded) recordAlso(request, 'POST', `/api/admin/cleaning-jobs/${outcome.job.id}/record`, 200);
      return noStore(apiSuccess({ job: outcome.job, propertyName: outcome.propertyName, recorded: outcome.recorded }, 201));
    case 'not-assignable':
      return noStore(apiFailure({ status: 422, code: 'CLEANER_NOT_ASSIGNABLE', message: `${outcome.name ?? 'That team member'} ${NOT_ASSIGNABLE[outcome.why]}.`, hint: 'Nothing was added. Only an active cleaner is put on a job.' }));
    case 'before-floor':
      return noStore(apiFailure({ status: 422, code: 'JOB_DAY_REFUSED', message: outcome.problem, hint: 'Nothing was added.' }));
    case 'too-early':
      return noStore(apiFailure({ status: 409, code: 'JOB_NOT_YET', message: `This job’s day has not come: it opens on ${dayText(outcome.opensOn)}.`, hint: 'Nothing was added. Untick Already cleaned, or pick a day that has come.' }));
    case 'bad-day':
      return noStore(apiFailure({ status: 422, code: 'BAD_DAY', message: outcome.problem, hint: 'Nothing was added.' }));
    default:
      return noStore(apiFailure(ADD_JOB_REFUSALS[outcome.kind]));
  }
});
