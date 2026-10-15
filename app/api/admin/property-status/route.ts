/**
 * GET /api/admin/property-status — the property list's Income and Cleaning columns (admin-only; Kian's rulings of
 * 2026-10-15, part A of PROPERTY-LIST-COLUMNS-PLAN.md).
 *
 * Response: 200 `{ success: true, data: { today, income: { month, uploaded, properties }, cleaning: { from, to, jobs },
 * unreadable } }`: for the last closed month, each property's lines waiting for review, accepted, and whether its
 * active title is missing from the month's file; and the cleaning jobs with a checkout from 14 days back to 2 days
 * ahead, each with its cleaners' names when assigned, their marks, and whether a mark's cleaning waits for an amount.
 * What each property's cells say, app/lib/income/standing.ts and app/lib/schedule/standing.ts decide in the page.
 *
 * Its own call, beside the properties and the statements: a failure here leaves those as they are, and the page shows
 * the two columns as not known (500 PROPERTY_STATUS_READ_FAILED), never as empty. Every response is no-store.
 */

import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiFailure, apiSuccess, noStore } from '@/app/lib/api/safe-response';
import { readPropertyStatus } from '@/app/lib/firebase/server-property-status';

export const GET = adminRoute(async function GET() {
  try {
    return noStore(apiSuccess(await readPropertyStatus()));
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    console.error(`[property-status] read failed: grpc code ${typeof code === 'number' ? code : 'unknown'}`);
    return noStore(apiFailure({ message: 'Could not load the income and cleaning status.', status: 500, code: 'PROPERTY_STATUS_READ_FAILED' }));
  }
});
