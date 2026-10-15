/**
 * POST /api/admin/availability/refresh — fetch every feed now and write the
 * stored copy: Refresh calendars on the Schedule and Refresh now on the
 * Availability page (Kian's ruling of 2026-10-14, night: the copy and the
 * cleaning jobs refresh when an admin presses it, as now, and on the day's
 * first admin page or cleaner app; no scheduled job).
 *
 * Only one refresh runs at a time: this claims the same lease as the
 * first-visit refresh (app/lib/availability/run-state.ts). While another run
 * holds it, nothing starts: 409 REFRESH_RUNNING, saying when that run began.
 * This waits for no pause after a failed try, only for a lease.
 *
 * Response: 200 `{ success: true, data: { snapshot, history, today, now, jobs } }`,
 * the same answer GET /api/admin/availability gives, so the page replaces
 * what it holds in one step, plus `jobs`: what the cleaning schedule's sync
 * made and changed from the copy just written.
 *
 * Runs app/lib/availability/refresh.ts: one guarded fetch per feed, the
 * snapshot built on the previous one, one write, a day document if the day
 * has none, then the job sync. The listing-page check never runs. One Vercel
 * invocation per press, by an admin, on purpose.
 */

import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiFailure, apiSuccess, noStore } from '@/app/lib/api/safe-response';
import { getAdminDb } from '@/app/lib/firebase/admin';
import { addDays, torontoDay } from '@/app/lib/availability/days';
import { HISTORY_DAYS, historyView } from '@/app/lib/availability/attention';
import { runWithLease } from '@/app/lib/availability/daily';
import { claimRefresh } from '@/app/lib/availability/run-state';
import { readHistoryFrom } from '@/app/lib/availability/store';

/** 52 feeds take a few seconds; every one timing out twice, about 154. */
export const maxDuration = 300;

const grpcCode = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? String(code) : 'unknown';
};

/** "21:13", Toronto. */
const clock = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));

export const POST = adminRoute(async function POST() {
  const db = getAdminDb();
  let claim;
  try {
    claim = await claimRefresh(db, 'manual', 'refresh-button');
  } catch (err) {
    console.error(`[availability] could not start a refresh: grpc code ${grpcCode(err)}`);
    return noStore(apiFailure({ message: 'The refresh could not be started; the last copy is unchanged', status: 502, code: 'AVAILABILITY_REFRESH_FAILED' }));
  }
  if (claim.kind === 'running') {
    return noStore(
      apiFailure({
        status: 409,
        code: 'REFRESH_RUNNING',
        message: `The calendars are being read now (started ${clock(claim.run.startedAt)}).`,
        hint: 'Nothing else was started. Reload in a minute to see them.',
      }),
    );
  }
  if (claim.kind !== 'claimed') {
    // Only the first-visit refresh is ever answered "done today", "paused" or "unreadable".
    return noStore(apiFailure({ message: 'The refresh could not be started; the last copy is unchanged', status: 500, code: 'AVAILABILITY_REFRESH_FAILED' }));
  }
  try {
    const outcome = await runWithLease(db, claim.run);
    const today = torontoDay();
    const kept = await readHistoryFrom(db, addDays(today, -HISTORY_DAYS), today);
    const history = kept ? historyView(kept.snapshot, kept.day) : null;
    return noStore(apiSuccess({ snapshot: outcome.snapshot, history, today, now: new Date().toISOString(), jobs: outcome.jobs }));
  } catch (err) {
    // A refresh that failed wrote nothing: the copy the page holds is still the last good one.
    console.error(`[availability] refresh failed: grpc code ${grpcCode(err)}`);
    return noStore(
      apiFailure({
        message: 'The refresh could not be completed; the last copy is unchanged',
        status: 500,
        code: 'AVAILABILITY_REFRESH_FAILED',
      }),
    );
  }
});
