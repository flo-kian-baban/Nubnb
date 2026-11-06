/**
 * GET /api/admin/cleaning-jobs/amount-start?property=<id> — what the Schedule's "Add a job" fills its amount from once a
 * property is picked (the UX pass, Kian's instruction of 2026-11-06): the property's cleaning prices, and for each tier
 * with no price, the amount an admin last typed there (the "Last typed" placeholder of Build 2, shown in grey, never a
 * value).
 *
 * Response: 200 `{ success: true, data: { prices: { shortTermCents, midTermCents, longTermCents } | null, lastTyped:
 * { short, mid, long } } }` (cents, or null); 400 for a property ID not in shape; 503 AMOUNT_START_UNAVAILABLE when a
 * read fails. Reads: the prices record (one), and only when a tier has no price, the property's cleanings by a field
 * mask and the jobs of those an admin typed. A read: not recorded in the activity log. Every response is no-store.
 */

import { NextRequest } from 'next/server';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, noStore } from '@/app/lib/api/safe-response';
import { addedJobStart } from '@/app/lib/firebase/server-cleanings';

const PROPERTY_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const GET = adminRoute(async function GET(request: NextRequest) {
  const propertyId = new URL(request.url).searchParams.get('property') ?? '';
  if (!PROPERTY_ID.test(propertyId)) return noStore(apiError('Invalid property ID', 400));
  try {
    return noStore(apiSuccess(await addedJobStart(propertyId)));
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    console.error(`[jobs] what an added job's amount starts from could not be read: grpc code ${typeof code === 'number' ? code : 'unknown'}`);
    return noStore(apiFailure({ status: 503, code: 'AMOUNT_START_UNAVAILABLE', message: 'Could not read the property’s cleaning price.', hint: 'Type the amount, or leave it empty.' }));
  }
});
