/**
 * GET /api/admin/cost-entries — Everything the costs page works from (admin-only).
 *
 * Response: 200 `{ success: true, data: { entries, exports, properties } }`
 *
 * `entries`: what cleaners spent, one receipt at a time, newest first. Each
 * entry comes with the current name and status of its cleaner and the
 * current name of its property, beside the names recorded when it was
 * logged: display prefers the live name and falls back to the recorded one.
 * A lookup that failed shows as 'unreadable' on that entry and never fails
 * the list. Each entry also carries `linesNow`, its lines with every
 * correction applied, which is what totals and reports add up. Receipt
 * object paths are never returned.
 *
 * `exports`: every PDF report recorded, newest first, with the history
 * length and the printed amounts of each entry in it, so the page can say
 * when a PDF that went out no longer matches the ledger.
 *
 * `properties`: every property's ID and current name, so a property's
 * ledger can be opened, and named, before it has any entry. null when the
 * names could not be read.
 *
 * Both collections are read whole — no orderBy, no limit — so nothing can
 * silently drop out; see listCosts.
 *
 * Read by the costs page, /admin/costs, once when it opens and on Refresh. No
 * public page calls it, so it adds no function call to a renter's page view.
 */

import { NextRequest } from 'next/server';
import { verifyAdminSession } from '@/app/lib/api/verify-admin';
import { apiSuccess, apiError, apiFailure, noStore } from '@/app/lib/api/safe-response';
import { listCosts } from '@/app/lib/firebase/server-cost-entries';

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
    return noStore(apiSuccess(await listCosts()));
  } catch (err) {
    // A read that failed is not an empty list: the 500 says "could not load",
    // never "no entries" and never "no PDF was exported".
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
