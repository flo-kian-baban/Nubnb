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
 * page does everything else itself. Nothing here fetches a feed before the
 * answer: `refresh` (Kian's ruling K2 of 2026-10-19, extending R1 to this
 * page) says when the copy is more than three hours old and the same
 * background refresh the Schedule starts is starting after this answer, or one
 * holds the lease now — `{ state: 'starting' | 'running', lastFinishedAt }`,
 * null otherwise — so the page watches the run and shows its result when it
 * ends. One more read for the refresh's state.
 */

import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiFailure, apiSuccess, noStore } from '@/app/lib/api/safe-response';
import { failedNamedInternally } from '@/app/lib/firebase/server-property-names';
import { getAdminDb } from '@/app/lib/firebase/admin';
import { addDays, torontoDay } from '@/app/lib/availability/days';
import { historyView } from '@/app/lib/availability/attention';
import { readCurrent, readHistoryFrom } from '@/app/lib/availability/store';
import { HISTORY_DAYS } from '@/app/lib/availability/attention';
import { refreshIfStale } from '@/app/lib/availability/daily';

/** A refresh on open may run after the answer (Kian's ruling K2): it has this long, as the Schedule's read does. */
export const maxDuration = 300;

const grpcCode = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? String(code) : 'unknown';
};

export const GET = adminRoute(async function GET() {
  try {
    const db = getAdminDb();
    const today = torontoDay();
    const [snapshot, kept, refresh] = await Promise.all([readCurrent(db), readHistoryFrom(db, addDays(today, -HISTORY_DAYS), today), refreshIfStale('admin-page')]);
    const history = kept ? historyView(kept.snapshot, kept.day) : null;
    // The calendars that could not be read, named as the admin names them (Kian's rulings of 2026-10-15, evening).
    return noStore(apiSuccess({ snapshot: await failedNamedInternally(snapshot), history, today, now: new Date().toISOString(), refresh }));
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
});
