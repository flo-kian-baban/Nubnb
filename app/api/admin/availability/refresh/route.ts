/**
 * POST /api/admin/availability/refresh — fetch every feed now and write the
 * stored copy: the Refresh now button, and the fallback if the hourly
 * function ever stops.
 *
 * Response: 200 `{ success: true, data: { snapshot, history, today, now } }`,
 * the same answer GET /api/admin/availability gives, so the page replaces
 * what it holds in one step.
 *
 * Runs the same code the Cloud Function runs (app/lib/availability/refresh.ts):
 * 46 guarded fetches, the snapshot built on the previous one, one write, a
 * day document if the day has none. The listing-page check never runs
 * here; it is the schedule's, about once a day. One Vercel invocation per
 * press, by an admin, on purpose.
 */

import { NextRequest } from 'next/server';
import { verifyAdminSession } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, noStore } from '@/app/lib/api/safe-response';
import { getAdminDb } from '@/app/lib/firebase/admin';
import { addDays, torontoDay } from '@/app/lib/availability/days';
import { HISTORY_DAYS, historyView } from '@/app/lib/availability/attention';
import { runRefresh } from '@/app/lib/availability/refresh';
import { readHistoryFrom } from '@/app/lib/availability/store';

/** 46 feeds at eight a time with one retry each fits well inside this. */
export const maxDuration = 60;

const grpcCode = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? String(code) : 'unknown';
};

export async function POST(request: NextRequest) {
  const auth = verifyAdminSession(request);
  if (!auth.valid) return noStore(apiError(auth.error!, auth.status!));

  try {
    const db = getAdminDb();
    const outcome = await runRefresh({ db, source: 'manual', checkPages: false, log: (line) => console.log(`[availability] ${line}`) });
    const today = torontoDay();
    const kept = await readHistoryFrom(db, addDays(today, -HISTORY_DAYS), today);
    const history = kept ? historyView(kept.snapshot, kept.day) : null;
    return noStore(apiSuccess({ snapshot: outcome.snapshot, history, today, now: new Date().toISOString() }));
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
}
