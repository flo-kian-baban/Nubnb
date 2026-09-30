/**
 * GET /api/admin/availability — the stored copy of every property's
 * calendar, for the admin's Availability page and the home tiles.
 *
 * Response: 200 `{ success: true, data: { snapshot, history, today, now } }`
 *
 * `snapshot` is availability_snapshots/current as the last refresh wrote
 * it (see app/lib/availability/types.ts), or null when no refresh has ever
 * run. `history` is the reservations held seven days ago, by property,
 * from the oldest daily snapshot kept in the last week, or null before a
 * week of snapshots exists: it is what "booked in the last 7 days" is
 * counted against. `today` is the Toronto day; `now` the server's clock,
 * so the page can say how old the snapshot is without trusting the
 * browser's.
 *
 * One read of the current document and one query for the history: the
 * page does everything else itself. Nothing here fetches a feed.
 */

import { NextRequest } from 'next/server';
import { verifyAdminSession } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, noStore } from '@/app/lib/api/safe-response';
import { getAdminDb } from '@/app/lib/firebase/admin';
import { addDays, torontoDay } from '@/app/lib/availability/days';
import { historyView } from '@/app/lib/availability/attention';
import { readCurrent, readHistoryFrom } from '@/app/lib/availability/store';
import { HISTORY_DAYS } from '@/app/lib/availability/attention';

const grpcCode = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? String(code) : 'unknown';
};

export async function GET(request: NextRequest) {
  const auth = verifyAdminSession(request);
  if (!auth.valid) return noStore(apiError(auth.error!, auth.status!));

  try {
    const db = getAdminDb();
    const today = torontoDay();
    const [snapshot, kept] = await Promise.all([readCurrent(db), readHistoryFrom(db, addDays(today, -HISTORY_DAYS), today)]);
    const history = kept ? historyView(kept.snapshot, kept.day) : null;
    return noStore(apiSuccess({ snapshot, history, today, now: new Date().toISOString() }));
  } catch (err) {
    console.error(`[availability] read failed: grpc code ${grpcCode(err)}`);
    return noStore(
      apiFailure({
        message: 'The availability copy could not be read',
        status: 500,
        code: 'AVAILABILITY_READ_FAILED',
      }),
    );
  }
}
