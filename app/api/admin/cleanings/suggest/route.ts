/**
 * GET /api/admin/cleanings/suggest?propertyId=&day= — what a cleaning logged by hand for that property and day starts
 * from (admin-only; Kian's ruling of 2026-10-19): the property's long-term preset when it has a job that day whose stay
 * is 28 nights or more, else its short-term preset; none when the property has no such preset. The admin can change it.
 *
 * Response: 200 `{ success: true, data: { from: 'short' | 'long', cents: number | null, nights, job: boolean } }` —
 *           `nights` the stay's length behind the job that day (0 without one); 422 VALIDATION_ERROR; 503 when the
 *           reads fail. Two reads: the prices record and the job (`cleaning_jobs/{propertyId}_{day}`). No-store.
 */

import { NextRequest } from 'next/server';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiFailure, apiSuccess, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { SuggestQuerySchema } from '@/app/lib/cleanings/schemas';
import { handLogSuggestion } from '@/app/lib/cleanings/prices';
import { getAdminDb } from '@/app/lib/firebase/admin';
import { pricesOf, getCleaningPrices } from '@/app/lib/firebase/server-cleaning-prices';
import { CLEANING_JOBS_COLLECTION, jobIdOf, readJob } from '@/app/lib/schedule/model';

export const GET = adminRoute(async function GET(request: NextRequest) {
  const params = new URL(request.url).searchParams;
  const parsed = SuggestQuerySchema.safeParse({ propertyId: params.get('propertyId') ?? '', day: params.get('day') ?? '' });
  if (!parsed.success) return noStore(apiValidationError(parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))));
  const { propertyId, day } = parsed.data;
  try {
    const [prices, jobSnap] = await Promise.all([getCleaningPrices(propertyId), getAdminDb().collection(CLEANING_JOBS_COLLECTION).doc(jobIdOf(propertyId, day)).get()]);
    const job = jobSnap.exists ? readJob(jobSnap.id, jobSnap.data() ?? {}) : null;
    const suggestion = handLogSuggestion(pricesOf(prices.record), job);
    return noStore(apiSuccess({ ...suggestion, job: job !== null }));
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    console.error(`[cleanings] suggest for ${propertyId} ${day} failed: grpc code ${typeof code === 'number' ? code : 'unknown'}`);
    return noStore(apiFailure({ status: 503, code: 'SUGGEST_UNAVAILABLE', message: 'Could not read what the amount starts from.', hint: 'Type the amount.' }));
  }
});
