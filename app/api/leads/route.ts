/**
 * GET /api/leads — Every contact submission, newest first, as inbox rows (admin-only).
 *
 * contact_submissions holds renters' names, emails and messages, and
 * firestore.rules denies the browser any access to it. The admin dashboard and
 * the lead inbox read it here instead, behind the admin session, like every
 * other admin route. A row carries what the inbox lists, filters and
 * searches; GET /api/leads/[id] returns one lead in full.
 *
 * Only admin pages call this. No public page does, so it adds no function
 * call to a renter's page view.
 */

import { NextRequest } from 'next/server';
import { verifyAdminSession } from '@/app/lib/api/verify-admin';
import { apiSuccess, apiError, noStore } from '@/app/lib/api/safe-response';
import { listLeads } from '@/app/lib/firebase/server-leads';

export async function GET(request: NextRequest) {
  // ── Auth ──
  const auth = verifyAdminSession(request);
  if (!auth.valid) return apiError(auth.error!, auth.status!);

  try {
    return noStore(apiSuccess(await listLeads()));
  } catch (err) {
    // A read that failed is not an empty inbox. The 500 is what lets the
    // dashboard and the inbox say "could not load" instead of showing zero.
    return noStore(apiError('Failed to load leads', 500, err));
  }
}
