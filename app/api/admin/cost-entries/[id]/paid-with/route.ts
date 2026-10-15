/**
 * POST /api/admin/cost-entries/[id]/paid-with — Who paid for a receipt (admin-only; Team pay, Kian's ruling 1 of
 * 2026-10-15): the team member, or Nubnb's card. A receipt paid with Nubnb's card is not owed to them; its statement
 * line is unchanged (ruling 7).
 *
 * Request:  `{ paidWith: "team-member" | "nubnb-card", seen }` — `seen` the length of the entry's history as the
 *           page shows it.
 * Response: 200 `{ entry, changed }`. A `paid_with_changed` history event by the admin carries the before and after.
 * Refusals, nothing written: 404 ENTRY_NOT_FOUND; 409 ENTRY_CHANGED; 422 ENTRY_NOT_A_RECEIPT (work and office costs
 * have no card). 502 ENTRY_REVIEW_FAILED: may or may not have been saved. Every response is no-store.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiSuccess, apiError, apiFailure, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { PAID_WITH } from '@/app/lib/cleaners/model';
import { REVIEW_REFUSALS, setEntryPaidWith } from '@/app/lib/firebase/server-cost-entries';
import { isDocumentId } from '@/app/lib/firebase/server-leads';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Strict: a body that carries anything else is refused, not trimmed. */
const PaidWithSchema = z.strictObject({
  paidWith: z.enum(PAID_WITH),
  seen: z.number().int().min(0).max(1_000_000),
});

export const POST = adminRoute(async function POST(request: NextRequest, context: RouteContext, { actor }) {
  const crossSite = refuseCrossSite(request);
  if (crossSite) return crossSite;
  const wrongType = requireMediaType(request, 'application/json');
  if (wrongType) return wrongType;
  const { id } = await context.params;
  if (!isDocumentId(id)) return noStore(apiError('Invalid entry ID', 400));
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return noStore(apiError('Invalid JSON body', 400));
  }
  const parsed = PaidWithSchema.safeParse(body);
  if (!parsed.success) return noStore(apiValidationError(parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))));
  const outcome = await setEntryPaidWith(actor, id, parsed.data.paidWith, parsed.data.seen);
  if (outcome.kind !== 'done') return noStore(apiFailure(REVIEW_REFUSALS[outcome.kind]));
  return noStore(apiSuccess({ entry: outcome.entry, changed: outcome.changed }));
});
