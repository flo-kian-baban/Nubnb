/**
 * POST /api/admin/cleanings — Log one cleaning (admin-only, dispatch 37B).
 *
 * Kian's rulings of 2026-10-13: admins log every cleaning by hand — cleaner, property, the day cleaned, the amount,
 * an optional note. The amount the form started from (the cleaner's last amount for the property, else their
 * default rate) is worked out again on the server and kept beside it; the amount stored is the one the admin left.
 *
 * Request:  `{ propertyId, cleanerId, day: "yyyy-mm-dd", amount: "60.00", note?: string | null }`
 * Response: 201 `{ cleaning, statementMonth }` — the month whose statement it goes on: its own month's, or the next
 *           open one's once that is finished.
 *
 * Refusals, nothing logged: 422 BAD_DAY (a day that has not come, or more than twelve months back); 404
 * PROPERTY_NOT_FOUND, CLEANER_NOT_FOUND; 422 NOT_A_CLEANER (a handyman), CLEANER_INACTIVE. 502 CLEANING_LOG_FAILED:
 * may or may not have been logged.
 *
 * Order: the admin session, then the cross-site and media-type refusals, then the JSON and the schema, then the
 * work. Every response is no-store. The list is GET /api/admin/cost-entries: one read for the costs page.
 */

import { NextRequest } from 'next/server';
import { verifyAdminSession } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { LogCleaningSchema } from '@/app/lib/cleanings/schemas';
import { LOG_REFUSALS, logCleaning } from '@/app/lib/firebase/server-cleanings';

export async function POST(request: NextRequest) {
  const auth = verifyAdminSession(request);
  if (!auth.valid) return noStore(apiError(auth.error!, auth.status!));
  const crossSite = refuseCrossSite(request);
  if (crossSite) return crossSite;
  const wrongType = requireMediaType(request, 'application/json');
  if (wrongType) return wrongType;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return noStore(apiError('Invalid JSON body', 400));
  }
  const parsed = LogCleaningSchema.safeParse(body);
  if (!parsed.success) return noStore(apiValidationError(parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))));

  const { propertyId, cleanerId, day, amount, note } = parsed.data;
  const outcome = await logCleaning({ propertyId, cleanerId, day, amountCents: amount, note });
  switch (outcome.kind) {
    case 'logged':
      return noStore(apiSuccess({ cleaning: outcome.cleaning, statementMonth: outcome.statementMonth }, 201));
    case 'bad-day':
      return noStore(apiFailure({ status: 422, code: 'BAD_DAY', message: outcome.problem, hint: 'Nothing was logged.' }));
    default:
      return noStore(apiFailure(LOG_REFUSALS[outcome.kind]));
  }
}
