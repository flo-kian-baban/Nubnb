/**
 * GET /api/admin/property-status — the property list's Income and Cleaning columns (admin-only; Kian's rulings of
 * 2026-10-15, part A of PROPERTY-LIST-COLUMNS-PLAN.md).
 *
 * Response: 200 `{ success: true, data: { today, income: { month, uploaded, properties, direct }, cleaning: { from, to,
 * jobs }, calendar: { refreshedAt, properties }, unreadable } }`: for the last closed month, each property's lines
 * waiting for review, accepted, and whether its active title is missing from the month's file; the cleaning jobs with
 * a checkout from 14 days back to 2 days ahead, each with its cleaners' names when assigned, their marks, and whether
 * a mark's cleaning waits for an amount; and, from the last calendar copy (Kian's rulings of 2026-10-17, admin home),
 * whether each property's calendar was read and its next checkout. What each property's cells and its Next step say,
 * app/lib/income/standing.ts, app/lib/schedule/standing.ts and app/lib/home/next-step.ts decide in the page.
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
