/**
 * GET /api/admin/availability/status — when the calendars were last read, for the small tag on every admin page
 * (Kian's rulings of 2026-10-17, admin home: "Calendars read <time>", with a Refresh button; amber past 24 hours, red
 * past 48).
 *
 * Response: 200 `{ success: true, data: { refreshedAt, fetched, failed, running, now } }`: the last copy's time
 * (null when no refresh has ever run), how many calendars it read and how many it could not, the run holding the
 * lease when one is reading now (its start), and the server's clock, so the tag can age the copy without trusting the
 * browser's.
 *
 * Two reads: the refresh's state (run-state.ts) and the copy's time and run, by a field mask (none of its events).
 * Nothing is fetched or written; Refresh is POST /api/admin/availability/refresh, one run at a time.
 */

import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiFailure, apiSuccess, noStore } from '@/app/lib/api/safe-response';
import { getAdminDb } from '@/app/lib/firebase/admin';
import { readRefreshStateDoc } from '@/app/lib/availability/run-state';
import { CURRENT_DOC, SNAPSHOTS_COLLECTION } from '@/app/lib/availability/store';

const grpcCode = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? String(code) : 'unknown';
};

export const GET = adminRoute(async function GET() {
  try {
    const db = getAdminDb();
    const [state, [copy]] = await Promise.all([readRefreshStateDoc(db), db.getAll(db.collection(SNAPSHOTS_COLLECTION).doc(CURRENT_DOC), { fieldMask: ['refreshedAt', 'run.fetched', 'run.failed'] })]);
    const now = new Date();
    const refreshedAt: unknown = copy.exists ? copy.get('refreshedAt') : null;
    const fetched: unknown = copy.exists ? copy.get('run.fetched') : null;
    const failed: unknown = copy.exists ? copy.get('run.failed') : null;
    const running = state !== 'unreadable' && state.running && Date.parse(state.running.leaseUntil) > now.getTime() ? { startedAt: state.running.startedAt } : null;
    return noStore(
      apiSuccess({
        refreshedAt: typeof refreshedAt === 'string' ? refreshedAt : null,
        fetched: typeof fetched === 'number' ? fetched : 0,
        failed: Array.isArray(failed) ? failed.length : 0,
        running,
        now: now.toISOString(),
      }),
    );
  } catch (err) {
    console.error(`[availability] status read failed: grpc code ${grpcCode(err)}`);
    return noStore(apiFailure({ message: 'When the calendars were read could not be loaded', status: 500, code: 'AVAILABILITY_STATUS_READ_FAILED' }));
  }
});
