/**
 * GET /api/admin/cleaners/schedule — the Team page's schedule read (2026-10-19, the Team page, round 1): for every team
 * member, the properties they are the regular cleaner for (Kian's ruling R5) and how many open jobs they are on whose
 * checkout is today or later, so the page says both beside each person and links the count to the Schedule filtered to
 * them (`/admin/schedule?cleaner=`).
 *
 * Response: 200 `{ success: true, data: { today, regular: { [cleanerId]: [{ propertyId, name }] }, upcoming:
 *           { [cleanerId]: n } } }` — a member with neither is absent from both. Names are the ones the admin knows the
 *           properties by (the cleaner-facing name, else the title). 500 TEAM_SCHEDULE_READ_FAILED: not "nothing".
 * Reads: every regular-cleaner record (one query), the names of the properties named, and the jobs from today on
 * (one query; jobs are made two days ahead). Admin-only; a read, not recorded in the activity log.
 */

import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiFailure, apiSuccess, noStore } from '@/app/lib/api/safe-response';
import { teamSchedule } from '@/app/lib/firebase/server-regular-cleaners';

export const GET = adminRoute(async function GET() {
  try {
    return noStore(apiSuccess(await teamSchedule()));
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    console.error(`[cleaners] the team's schedule could not be read: grpc code ${typeof code === 'number' ? code : 'unknown'}`);
    return noStore(apiFailure({ message: "Could not read the team's regular properties and jobs.", status: 500, code: 'TEAM_SCHEDULE_READ_FAILED' }));
  }
});
