/**
 * POST /api/admin/cleaning-jobs/[id]/record — Record as cleaned (Kian's ruling E of 2026-11-01): "an admin action on
 * any job whose day has come. It counts exactly as if the assigned cleaner marked it (same amount logic, statement
 * line and pay). The audit log notes the admin."
 *
 * Body: `{ cleanerIds: string[], seen: number }` — the assigned cleaners to record it for (those already marked are
 * left as they are), and the job's history length when the page loaded it. Each gets the cleaning their own Mark
 * cleaned would make, through the same function; the job's history and each cleaning name the admin. The mark's rules
 * hold: on the job, not removed by the office, the booking unchanged, from the checkout day on. Recorded in the
 * activity log.
 *
 * Response: 200 `{ success: true, data: { job, cleanings: [{ cleanerId, cleaningId, amountCents }], statementMonth } }`;
 * 403 CLEANER_NOT_ON_JOB; 404; 409 (changed since, removed by the office, booking changed, too early, nothing to
 * record); 422 BAD_DAY, NOT_A_CLEANER; 502 (outcome unknown; recording again never counts a cleaning twice).
 */

import { NextRequest } from 'next/server';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { dayText } from '@/app/lib/availability/days';
import { RECORD_REFUSALS, recordCleaned } from '@/app/lib/firebase/server-cleaning-jobs';
import { RecordJobSchema } from '@/app/lib/cleanings/schemas';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const JOB_ID = /^[A-Za-z0-9]{1,64}_\d{4}-\d{2}-\d{2}$/;

export const POST = adminRoute(async function POST(request: NextRequest, context: RouteContext, { actor }) {
  const crossSite = refuseCrossSite(request);
  if (crossSite) return crossSite;
  const wrongType = requireMediaType(request, 'application/json');
  if (wrongType) return wrongType;
  const { id } = await context.params;
  if (!JOB_ID.test(id)) return noStore(apiError('Invalid job ID', 400));
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return noStore(apiError('Invalid JSON body', 400));
  }
  const parsed = RecordJobSchema.safeParse(body);
  if (!parsed.success) return noStore(apiValidationError(parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))));

  const outcome = await recordCleaned(actor, id, parsed.data.cleanerIds, parsed.data.seen);
  switch (outcome.kind) {
    case 'recorded':
      return noStore(apiSuccess({ job: outcome.job, cleanings: outcome.cleanings, statementMonth: outcome.statementMonth }));
    case 'not-assigned':
      return noStore(apiFailure({ status: 403, code: 'CLEANER_NOT_ON_JOB', message: 'That cleaner is not on this job.', hint: 'Nothing was recorded. Assign them first.' }));
    case 'removed':
      return noStore(apiFailure({ status: 409, code: 'JOB_MARK_REMOVED', message: `The office removed ${outcome.name ?? 'this cleaner'}’s cleaning of this job.`, hint: 'Nothing was recorded. Reopen the job for them first.' }));
    case 'too-early':
      return noStore(apiFailure({ status: 409, code: 'JOB_NOT_YET', message: `This job’s day has not come: it opens on ${dayText(outcome.opensOn)}.`, hint: 'Nothing was recorded.' }));
    case 'bad-day':
      return noStore(apiFailure({ status: 422, code: 'BAD_DAY', message: outcome.problem, hint: 'Nothing was recorded.' }));
    case 'not-a-cleaner':
      return noStore(apiFailure({ status: 422, code: 'NOT_A_CLEANER', message: `${outcome.name ?? 'That team member'} is not an active cleaner.`, hint: 'Nothing was recorded.' }));
    default:
      return noStore(apiFailure(RECORD_REFUSALS[outcome.kind]));
  }
});
