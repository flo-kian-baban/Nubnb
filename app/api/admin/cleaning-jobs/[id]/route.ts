/**
 * PATCH /api/admin/cleaning-jobs/[id] — set who is on a job (Kian's ruling 2 of 2026-10-14: admins assign one or
 * more active cleaners to a job), as the admin saw it.
 *
 * Body: `{ cleanerIds: string[], seen: number }` — everyone who should be on it, and the job's history length when
 * the page loaded it. Cleaners added must be active cleaners, never handymen, and nobody is added to a job whose
 * booking changed; a cleaner who has marked it stays on it. Recorded in the activity log.
 *
 * Response: 200 `{ success: true, data: { job, changed } }` (the job as stored); 404, 409 (changed since, booking
 * changed, marked), 422 (not assignable), 502 (outcome unknown).
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { ASSIGN_REFUSALS, MAX_ASSIGNEES, setAssignees } from '@/app/lib/firebase/server-cleaning-jobs';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** A job's ID: a property's auto ID and its checkout day. */
const JOB_ID = /^[A-Za-z0-9]{1,64}_\d{4}-\d{2}-\d{2}$/;

const AssignSchema = z.strictObject({
  cleanerIds: z.array(z.string().regex(/^[A-Za-z0-9]{1,64}$/, 'Not an ID')).max(MAX_ASSIGNEES, `At most ${MAX_ASSIGNEES} cleaners on one job`),
  seen: z.number().int().min(0).max(1_000_000),
});

const NOT_ASSIGNABLE = { missing: 'no longer exists', 'not-a-cleaner': 'is a handyman, not a cleaner', inactive: 'is deactivated' } as const;

export const PATCH = adminRoute(async function PATCH(request: NextRequest, context: RouteContext, { actor }) {
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
  const parsed = AssignSchema.safeParse(body);
  if (!parsed.success) return noStore(apiValidationError(parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))));

  const outcome = await setAssignees(actor, id, parsed.data.cleanerIds, parsed.data.seen);
  switch (outcome.kind) {
    case 'saved':
      return noStore(apiSuccess({ job: outcome.job, changed: outcome.changed }));
    case 'marked':
      return noStore(apiFailure({ status: 409, code: 'JOB_ALREADY_MARKED', message: `${outcome.name ?? 'That cleaner'} has marked this job cleaned, so they stay on it.`, hint: 'Nothing was saved. Their cleaning is changed or removed in the Cleanings tab.' }));
    case 'not-assignable':
      return noStore(apiFailure({ status: 422, code: 'CLEANER_NOT_ASSIGNABLE', message: `${outcome.name ?? 'That team member'} ${NOT_ASSIGNABLE[outcome.why]}.`, hint: 'Nothing was saved. Only an active cleaner is put on a job.' }));
    default:
      return noStore(apiFailure(ASSIGN_REFUSALS[outcome.kind]));
  }
});
