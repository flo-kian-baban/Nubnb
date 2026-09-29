/**
 * GET /api/admin/cost-entries — Every cost entry, newest first (admin-only).
 *
 * What cleaners spent, one receipt at a time. Each entry comes with the
 * current name and status of its cleaner and the current name of its
 * property, beside the names recorded when it was logged: display prefers
 * the live name and falls back to the recorded one. A lookup that failed
 * shows as 'unreadable' on that entry and never fails the list.
 *
 * The collection is read whole — no orderBy, no limit — so an entry can never
 * silently drop out of the list; see listCostEntries. There is no pagination
 * yet: it comes with the approval screen, which will read this same route.
 * Receipt object paths are never returned.
 *
 * No page calls this yet, and no public page ever will, so it adds no
 * function call to a renter's page view.
 */

import { NextRequest } from 'next/server';
import { verifyAdminSession } from '@/app/lib/api/verify-admin';
import { apiSuccess, apiError, apiFailure, noStore } from '@/app/lib/api/safe-response';
import { listCostEntries } from '@/app/lib/firebase/server-cost-entries';

/**
 * The one thing logged about a failed read: its gRPC code, as on every other
 * cleaner path. The error's message is not logged.
 */
function grpcCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? String(code) : 'unknown';
}

export async function GET(request: NextRequest) {
  // ── Auth ──
  const auth = verifyAdminSession(request);
  if (!auth.valid) return noStore(apiError(auth.error!, auth.status!));

  try {
    return noStore(apiSuccess(await listCostEntries()));
  } catch (err) {
    // A read that failed is not an empty list: the 500 says "could not load",
    // never "no entries".
    console.error(`[cost-entries] list failed: grpc code ${grpcCode(err)}`);
    return noStore(
      apiFailure({
        message: 'Failed to load cost entries',
        status: 500,
        code: 'COST_ENTRIES_READ_FAILED',
      }),
    );
  }
}
