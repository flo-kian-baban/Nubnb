/**
 * PATCH /api/admin/cleaning-jobs/[id] — set who is on a job (Kian's ruling 2 of 2026-10-14: admins assign one or
 * more active cleaners to a job), change its cleaner in one step (ruling D of 2026-11-01), or set its own amount
 * (ruling B), each as the admin saw it.
 *
 * Body: `{ cleanerIds: string[], seen: number }` — everyone who should be on it, and the job's history length when
 *       the page loaded it. Cleaners added must be active cleaners, never handymen, and nobody is added to a job whose
 *       booking changed; a cleaner who has marked it stays on it.
 *       `{ action: 'swap', from, to, seen }` — `from` comes off (never once they marked it), `to`, an active cleaner,
 *       goes on in their place; the history says who was replaced by whom. The old cleaner's app drops the job, the
 *       new one's shows it.
 *       `{ action: 'amount', amount: "75.00" | null, seen }` — the job's own amount, which a mark takes instead of the
 *       base price; locked once a mark's cleaning counts its money (409 JOB_AMOUNT_LOCKED: the Cleanings tab).
 * Recorded in the activity log.
 *
 * Response: 200 `{ success: true, data: { job, changed } }` (the job as stored); 404, 409 (changed since, booking
 * changed, marked, locked), 422 (not assignable), 502 (outcome unknown).
 */

import { NextRequest } from 'next/server';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { JOB_AMOUNT_REFUSALS, ASSIGN_REFUSALS, SWAP_REFUSALS, setAssignees, setJobAmount, swapCleaner } from '@/app/lib/firebase/server-cleaning-jobs';
import { JobPatchSchema } from '@/app/lib/cleanings/schemas';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** A job's ID: a property's auto ID and its checkout day. */
const JOB_ID = /^[A-Za-z0-9]{1,64}_\d{4}-\d{2}-\d{2}$/;

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
  const parsed = JobPatchSchema.safeParse(body);
  if (!parsed.success) return noStore(apiValidationError(parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))));

  if ('action' in parsed.data && parsed.data.action === 'swap') {
    const swapped = await swapCleaner(actor, id, parsed.data.from, parsed.data.to, parsed.data.seen);
    switch (swapped.kind) {
      case 'swapped':
        return noStore(apiSuccess({ job: swapped.job, changed: true, from: swapped.from, to: swapped.to }));
      case 'marked':
        return noStore(apiFailure({ status: 409, code: 'JOB_ALREADY_MARKED', message: `${swapped.name ?? 'That cleaner'} has marked this job cleaned, so they stay on it.`, hint: 'Nothing was saved. Their cleaning is changed or removed in the Cleanings tab.' }));
      case 'already-on':
        return noStore(apiFailure({ status: 409, code: 'JOB_CLEANER_ALREADY_ON', message: `${swapped.name ?? 'That cleaner'} is on this job already.`, hint: 'Nothing was saved.' }));
      case 'not-assignable':
        return noStore(apiFailure({ status: 422, code: 'CLEANER_NOT_ASSIGNABLE', message: `${swapped.name ?? 'That team member'} ${NOT_ASSIGNABLE[swapped.why]}.`, hint: 'Nothing was saved. Only an active cleaner is put on a job.' }));
      default:
        return noStore(apiFailure(SWAP_REFUSALS[swapped.kind]));
    }
  }
  if ('action' in parsed.data && parsed.data.action === 'amount') {
    const set = await setJobAmount(actor, id, parsed.data.amount, parsed.data.seen);
    return set.kind === 'set' ? noStore(apiSuccess({ job: set.job, changed: set.changed, cleaningsChanged: set.cleaningsChanged })) : noStore(apiFailure(JOB_AMOUNT_REFUSALS[set.kind]));
  }

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
