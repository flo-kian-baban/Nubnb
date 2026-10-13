/**
 * PUT /api/admin/cleaners/[id]/rate — Set a cleaner's one default rate for a cleaning (admin-only, dispatch 37B).
 *
 * Kian's ruling of 2026-10-13: each cleaner has one default rate. A cleaning's amount starts from what the cleaner
 * was last paid for the property, or this rate if none, and the admin changes it freely. No per-property rate, no
 * dated rates: setting it changes no cleaning already logged.
 *
 * Request:  `{ defaultRate: "60.00" }`, or `{ defaultRate: null }` for none
 * Response: 200 `{ cleaner, changed }`
 *
 * Refusals, nothing written: 404 CLEANER_NOT_FOUND; 422 NOT_A_CLEANER (a handyman logs work, not cleanings).
 * 502: may or may not have been saved. The rate is read by admin routes only; the cleaner app never reads it.
 */

import { NextRequest } from 'next/server';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { DefaultRateSchema } from '@/app/lib/cleanings/schemas';
import { RATE_REFUSALS, setCleanerDefaultRate } from '@/app/lib/firebase/server-cleaners';
import { isDocumentId } from '@/app/lib/firebase/server-leads';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const PUT = adminRoute(async function PUT(request: NextRequest, context: RouteContext, { actor }) {
  const crossSite = refuseCrossSite(request);
  if (crossSite) return crossSite;
  const wrongType = requireMediaType(request, 'application/json');
  if (wrongType) return wrongType;
  const { id } = await context.params;
  if (!isDocumentId(id)) return noStore(apiError('Invalid cleaner ID', 400));
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return noStore(apiError('Invalid JSON body', 400));
  }
  const parsed = DefaultRateSchema.safeParse(body);
  if (!parsed.success) return noStore(apiValidationError(parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))));
  const outcome = await setCleanerDefaultRate(actor, id, parsed.data.defaultRate);
  return outcome.kind === 'done' ? noStore(apiSuccess({ cleaner: outcome.cleaner, changed: outcome.changed })) : noStore(apiFailure(RATE_REFUSALS[outcome.kind]));
});
