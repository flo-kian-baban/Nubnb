/**
 * GET /api/cleaner/start — What the cleaner app needs when it opens (cleaner-only).
 *
 * Response: 200 `{ success: true, data: { cleaner: { id, name, role },
 *             properties: [{ id, name, city, photo }], recentPropertyIds,
 *             itemNames, jobs, today } }`
 *           `photo` (Kian's ruling of 2026-10-17): the property's cover as its
 *           stored small copies, `{ thumb, card }` (200 and 400 pixels), or
 *           null; never the full image.
 *           `jobs` (the cleaning schedule, 2026-10-14): the jobs this cleaner
 *           is on, as their app shows them; `today` the Toronto day.
 *           `role` (dispatch 24) is `cleaner` or `handyman`, as the account
 *           reads now: the app shows the receipt flow or the work flow by it.
 *
 * The app's one call on opening: it says who is signed in, and brings the
 * property list, the properties this cleaner logged against most recently,
 * and the item names in use, which the app suggests as they type. A 401 is
 * the app's cue to show the code screen.
 *
 * A cleaner sees no other cleaner's work here: item names come as words
 * only, with no cleaner, property, date or amount (readCleanerStart).
 *
 * Reads: the session check, then one per property, one per entry of this
 * cleaner's, and at most 300 of everyone's newest entries; for a cleaner, the
 * jobs of the 45 days their list reaches, the cleanings they marked, those
 * properties' finished statements, and the payments to them, for the day of
 * the latest only: the app shows no pay (Kian's ruling of 2026-10-16), and no
 * pay is sent. Every response, refusals included, is no-store.
 *
 * The day's first cleaner app refreshes the calendars (Kian's ruling of
 * 2026-10-14, night): a signed-in call starts the refresh after the
 * response, when today has none yet (app/lib/availability/daily.ts). For a
 * cleaner it also starts when the last run finished more than three hours
 * ago (Kian's ruling R1 of 2026-10-19), and the answer's `refresh` says a run
 * is coming (`{ state, lastFinishedAt }`, else null): the app then asks
 * GET /api/cleaner/jobs until it ends and reads its jobs again, once. The
 * refresh's state is one read, made beside the rest; it never delays the
 * answer, and maxDuration gives the run its 300 seconds.
 */

import { apiSuccess, apiFailure, noStore } from '@/app/lib/api/safe-response';
import { verifyCleanerSession } from '@/app/lib/cleaners/session';
import { readCleanerStart } from '@/app/lib/firebase/server-cleaner-start';
import { refreshIfFirstToday, refreshIfStale } from '@/app/lib/availability/daily';

/** The day's first cleaner app may run the calendar refresh after its answer: it has this long. */
export const maxDuration = 300;

/** The one thing logged about a failed read: its gRPC code. */
function grpcCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? String(code) : 'unknown';
}

export async function GET(request: Request) {
  // ── Auth ──
  const session = await verifyCleanerSession(request);
  if (!session.ok) return noStore(apiFailure(session.refusal));
  const { id, name, role } = session.cleaner;
  // A cleaner's app reads the calendars again on a copy more than three hours old (R1); a handyman's, as before, on
  // the day's first visit only.
  if (role !== 'cleaner') refreshIfFirstToday('cleaner-app');

  try {
    const [start, refresh] = await Promise.all([readCleanerStart(id, role), role === 'cleaner' ? refreshIfStale('cleaner-app') : Promise.resolve(null)]);
    return noStore(apiSuccess({ cleaner: { id, name, role }, ...start, refresh }));
  } catch (err) {
    console.error(`[cleaner-start] read failed: grpc code ${grpcCode(err)}`);
    return noStore(
      apiFailure({
        message: 'Could not load. Try again.',
        status: 503,
        code: 'CLEANER_START_UNAVAILABLE',
      }),
    );
  }
}
