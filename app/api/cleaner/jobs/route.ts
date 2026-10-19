/**
 * GET /api/cleaner/jobs?since=<ISO> — a cleaner's jobs, read again once the calendar refresh their app was told of has
 * ended (Kian's ruling R1 of 2026-10-19: when a cleaner's app opens on a copy more than three hours old, the calendars
 * are read again, and the app re-reads its jobs once when that run finishes). The start call's `refresh` says a run is
 * coming and when the last one finished; the app asks here every few seconds, with that time as `since`.
 *
 * Response: 200 `{ success: true, data: { state: 'running' } }` while a run holds the lease;
 *           `{ state: 'done', jobs, today, finishedAt }` once a run finished after `since` (any finished run when
 *           `since` is absent): the jobs as the start call sends them;
 *           `{ state: 'none' }` when no run holds the lease and none finished since: nothing is coming, the app stops.
 *           401 without a session; 403 for a handyman (they have no jobs). Every response is no-store.
 *
 * Reads: the refresh's state (one document); once done, the cleaner's jobs of the 45 days their list reaches, the
 * properties those jobs name, the finished statements of the properties whose cleanings they marked, and the latest
 * day a payment to them was made. Nothing is written.
 */

import { apiError, apiFailure, apiSuccess, noStore } from '@/app/lib/api/safe-response';
import { verifyCleanerSession } from '@/app/lib/cleaners/session';
import { getAdminDb } from '@/app/lib/firebase/admin';
import { readRefreshStateDoc } from '@/app/lib/availability/run-state';
import { torontoDay } from '@/app/lib/availability/days';
import { cleanerJobsRead } from '@/app/lib/firebase/server-cleaning-jobs';

const grpcCode = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? String(code) : 'unknown';
};

export async function GET(request: Request) {
  const session = await verifyCleanerSession(request);
  if (!session.ok) return noStore(apiFailure(session.refusal));
  const { id, role } = session.cleaner;
  if (role !== 'cleaner') return noStore(apiFailure({ status: 403, code: 'NOT_A_CLEANER', message: 'Only a cleaner has jobs.', hint: 'Nothing was read.' }));
  const since = new URL(request.url).searchParams.get('since');
  if (since !== null && !Number.isFinite(Date.parse(since))) return noStore(apiError('Invalid since', 400));

  try {
    const now = new Date();
    const state = await readRefreshStateDoc(getAdminDb());
    if (state === 'unreadable') return noStore(apiSuccess({ state: 'none' }));
    if (state.running && Date.parse(state.running.leaseUntil) > now.getTime()) return noStore(apiSuccess({ state: 'running' }));
    const finishedAt = state.lastDone?.finishedAt ?? null;
    if (finishedAt === null || (since !== null && Date.parse(finishedAt) <= Date.parse(since))) return noStore(apiSuccess({ state: 'none' }));
    const today = torontoDay(now);
    return noStore(apiSuccess({ state: 'done', jobs: await cleanerJobsRead(id, today), today, finishedAt }));
  } catch (err) {
    console.error(`[cleaner-jobs] read failed: grpc code ${grpcCode(err)}`);
    return noStore(apiFailure({ message: 'Could not load. Try again.', status: 503, code: 'CLEANER_JOBS_UNAVAILABLE' }));
  }
}
