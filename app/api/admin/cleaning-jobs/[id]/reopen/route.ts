/**
 * POST /api/admin/cleaning-jobs/[id]/reopen — reopen a job for a cleaner whose mark the office removed (Kian's ruling
 * of 2026-10-14, night: when an admin deletes a job's cleaning, the job keeps the mark as "removed by the office" and
 * that cleaner cannot mark it again; an admin can reopen it for them from the Schedule page, recorded in the job's
 * history).
 *
 * Body: `{ cleanerId: string, seen: number }` — the cleaner, and the job's history length when the page loaded it.
 * Their mark comes off, so they can mark the job cleaned again, which makes a new cleaning at once. Refused for a
 * cleaner who is not active, on a job whose booking changed, and on a job older than their list reaches. Recorded in
 * the activity log.
 *
 * Response: 200 `{ success: true, data: { job } }` (the job as stored); 404, 409 (changed since, not removed, booking
 * changed, too far back, not active), 502 (outcome unknown).
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { REOPEN_REFUSALS, reopenMark } from '@/app/lib/firebase/server-cleaning-jobs';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** A job's ID: a property's auto ID and its checkout day. */
const JOB_ID = /^[A-Za-z0-9]{1,64}_\d{4}-\d{2}-\d{2}$/;

const ReopenSchema = z.strictObject({
  cleanerId: z.string().regex(/^[A-Za-z0-9]{1,64}$/, 'Not an ID'),
  seen: z.number().int().min(0).max(1_000_000),
});

const NOT_ACTIVE = { missing: 'no longer exists', 'not-a-cleaner': 'is a handyman, not a cleaner', inactive: 'is deactivated' } as const;

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
  const parsed = ReopenSchema.safeParse(body);
  if (!parsed.success) return noStore(apiValidationError(parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))));

  const outcome = await reopenMark(actor, id, parsed.data.cleanerId, parsed.data.seen);
  switch (outcome.kind) {
    case 'reopened':
      return noStore(apiSuccess({ job: outcome.job }));
    case 'not-removed':
      return noStore(apiFailure({ status: 409, code: 'JOB_MARK_NOT_REMOVED', message: `${outcome.name ?? 'That cleaner'} has no mark removed by the office on this job.`, hint: 'Nothing was saved. Reload the Schedule.' }));
    case 'not-active':
      return noStore(apiFailure({ status: 409, code: 'CLEANER_NOT_ACTIVE', message: `${outcome.name ?? 'That team member'} ${NOT_ACTIVE[outcome.why]}.`, hint: 'Nothing was saved. Only an active cleaner can mark a job cleaned.' }));
    default:
      return noStore(apiFailure(REOPEN_REFUSALS[outcome.kind]));
  }
});
