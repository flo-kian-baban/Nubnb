/**
 * POST /api/cleaner/jobs/[id] — Mark cleaned, or Undo it (cleaner-only; the cleaning schedule, Kian's rulings of
 * 2026-10-14).
 *
 * Body: `{ action: 'mark' }` or `{ action: 'undo' }`.
 *   mark — by a cleaner on the job, from its checkout day on, never on a job whose booking changed: a 37B cleaning is
 *          made at once, at the amount 37B's rule gives (never typed by the cleaner, and never shown to them). Sent
 *          again after a lost answer, it makes nothing twice.
 *   undo — their own mark, until a finished statement prints the cleaning, within the 45 days their list reaches,
 *          and never once a payment to them is dated on or after it (Kian's ruling of 2026-10-15: such a cleaning is
 *          not deleted; 409 CLEANING_BEFORE_PAYMENT, in words with no amount: the app shows no pay, Kian's ruling of
 *          2026-10-16): the cleaning is deleted; the job keeps the trail.
 * A mark whose cleaning the office deleted or removed is "removed by the office": neither is allowed (409
 * JOB_MARK_REMOVED, CLEANING_REMOVED) until an admin reopens the job for them (Kian's ruling of 2026-10-14, night).
 *
 * Response: 200 `{ success: true, data: { job } }`, the job as their app shows it; 401 without a session; 403/404/409
 * with what stands in the way; 502 when the outcome is unknown. Every response is no-store.
 */

import { z } from 'zod';
import { apiError, apiFailure, apiSuccess, noStore } from '@/app/lib/api/safe-response';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { verifyCleanerSession } from '@/app/lib/cleaners/session';
import { dayText } from '@/app/lib/availability/days';
import { MARK_REFUSALS, UNDO_REFUSALS, markCleaned, oneCleanerJob, undoMark } from '@/app/lib/firebase/server-cleaning-jobs';
import { monthLabel } from '@/app/lib/reports/model';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const JOB_ID = /^[A-Za-z0-9]{1,64}_\d{4}-\d{2}-\d{2}$/;
const ActionSchema = z.strictObject({ action: z.enum(['mark', 'undo']) });

export async function POST(request: Request, context: RouteContext) {
  const crossSite = refuseCrossSite(request);
  if (crossSite) return crossSite;
  const wrongType = requireMediaType(request, 'application/json');
  if (wrongType) return wrongType;
  const session = await verifyCleanerSession(request);
  if (!session.ok) return noStore(apiFailure(session.refusal));
  const { id: cleanerId, name, role } = session.cleaner;
  if (role !== 'cleaner') return noStore(apiFailure(MARK_REFUSALS['not-a-cleaner']));

  const { id } = await context.params;
  if (!JOB_ID.test(id)) return noStore(apiError('Invalid job', 400));
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return noStore(apiError('Invalid request', 400));
  }
  const parsed = ActionSchema.safeParse(body);
  if (!parsed.success) return noStore(apiError('Invalid request', 400));

  const cleaner = { id: cleanerId, name };
  if (parsed.data.action === 'mark') {
    const outcome = await markCleaned(cleaner, id);
    if (outcome.kind === 'too-early') return noStore(apiFailure({ status: 409, code: 'JOB_NOT_YET', message: `Mark cleaned opens on ${dayText(outcome.opensOn)}.`, hint: 'Nothing was recorded.' }));
    if (outcome.kind === 'bad-day') return noStore(apiFailure({ status: 409, code: 'BAD_DAY', message: outcome.problem, hint: 'Nothing was recorded. Ask the office.' }));
    if (outcome.kind !== 'marked' && outcome.kind !== 'already') return noStore(apiFailure(MARK_REFUSALS[outcome.kind]));
    return answer(outcome.job, cleanerId, true);
  }
  const outcome = await undoMark(cleaner, id);
  if (outcome.kind === 'printed') {
    return noStore(apiFailure({ status: 409, code: 'CLEANING_PRINTED', message: `This cleaning is on the finished ${outcome.months.map(monthLabel).join(' and ')} statement.`, hint: 'Nothing was changed. Ask the office.' }));
  }
  if (outcome.kind === 'paid') {
    // Words only: the cleaner app shows no pay figure (Kian's ruling of 2026-10-16), so the payment is not named by its amount.
    return noStore(apiFailure({ status: 409, code: 'CLEANING_BEFORE_PAYMENT', message: 'This cleaning is already settled with you.', hint: 'Nothing was changed. Ask the office.' }));
  }
  if (outcome.kind !== 'undone') return noStore(apiFailure(UNDO_REFUSALS[outcome.kind]));
  return answer(outcome.job, cleanerId, false);
}

/** The job as their app shows it; if its property cannot be read now, the change still stands and the app reloads. */
async function answer(job: Parameters<typeof oneCleanerJob>[0], cleanerId: string, canUndo: boolean) {
  try {
    return noStore(apiSuccess({ job: await oneCleanerJob(job, cleanerId, canUndo) }));
  } catch {
    return noStore(apiSuccess({ job: null }));
  }
}
