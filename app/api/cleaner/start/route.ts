/**
 * GET /api/cleaner/start — What the cleaner app needs when it opens (cleaner-only).
 *
 * Response: 200 `{ success: true, data: { cleaner: { id, name, role },
 *             properties: [{ id, name, city }], recentPropertyIds, itemNames } }`
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
 * cleaner's, and at most 300 of everyone's newest entries. Every response,
 * refusals included, is no-store.
 */

import { apiSuccess, apiFailure, noStore } from '@/app/lib/api/safe-response';
import { verifyCleanerSession } from '@/app/lib/cleaners/session';
import { readCleanerStart } from '@/app/lib/firebase/server-cleaner-start';

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

  try {
    const start = await readCleanerStart(id);
    return noStore(apiSuccess({ cleaner: { id, name, role }, ...start }));
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
