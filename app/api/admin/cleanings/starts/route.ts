/**
 * GET /api/admin/cleanings/starts?properties=<id,id>&jobs=<id,id> — what missing amounts start from (admin-only; the
 * Team page's pay view, 2026-10-19). The pay view types a person's cleanings with no amount in place, each field
 * opening as the Cleanings tab's does (Kian's ruling of 2026-10-19, the second round; prices.ts `missingAmountStart`):
 * the property's preset for the tier, else the most recent amount an admin typed there in that tier, else nothing;
 * never a share of a job with several cleaners. The page already holds every cleaning; it names here the properties of
 * the person's waiting cleanings and the jobs of those and of the typed job cleanings there.
 *
 * Response: 200 `{ success: true, data: { prices: { [propertyId]: { shortTermCents, longTermCents } }, jobs:
 *           { [jobId]: { nights, cleaners } } } }` — a property with no prices record, or a job that cannot be read, is
 *           absent. 400 for more than 40 properties or 200 jobs, or an ID not in shape. 503 STARTS_UNAVAILABLE when the
 *           reads fail. Reads: one per property and per job named. A read, not recorded in the activity log.
 */

import { NextRequest } from 'next/server';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, noStore } from '@/app/lib/api/safe-response';
import { amountStarts } from '@/app/lib/firebase/server-cleanings';

const MAX_PROPERTIES = 40;
const MAX_JOBS = 200;
const PROPERTY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const JOB_ID = /^[A-Za-z0-9]{1,64}_\d{4}-\d{2}-\d{2}$/;

const listOf = (value: string | null) => (value === null || value.trim() === '' ? [] : value.split(',').map((id) => id.trim()).filter((id) => id !== ''));

export const GET = adminRoute(async function GET(request: NextRequest) {
  const params = new URL(request.url).searchParams;
  const properties = listOf(params.get('properties'));
  const jobs = listOf(params.get('jobs'));
  if (properties.length > MAX_PROPERTIES) return noStore(apiError(`At most ${MAX_PROPERTIES} properties at a time`, 400));
  if (jobs.length > MAX_JOBS) return noStore(apiError(`At most ${MAX_JOBS} jobs at a time`, 400));
  if (properties.some((id) => !PROPERTY_ID.test(id)) || jobs.some((id) => !JOB_ID.test(id))) return noStore(apiError('An ID is not in shape', 400));
  try {
    return noStore(apiSuccess(await amountStarts(properties, jobs)));
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    console.error(`[cleanings] what the amounts start from could not be read: grpc code ${typeof code === 'number' ? code : 'unknown'}`);
    return noStore(apiFailure({ status: 503, code: 'STARTS_UNAVAILABLE', message: 'Could not read what the amounts start from.', hint: 'Type each amount.' }));
  }
});
