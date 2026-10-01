/**
 * POST /api/admin/cost-entries/[id]/seen — Mark an entry approved automatically as seen (admin-only, dispatch 24).
 *
 * Request:  `{ seen }` — the length of the entry's history as the page shows it
 * Response: 200 `{ success: true, data: { entry: CostEntryView, changed } }`
 *
 * An entry approved automatically stays in the review queue until an admin
 * has looked at it. This appends a `seen` event by the admin and changes no
 * status; the entry then leaves the queue. Correcting, removing or rejecting
 * such an entry counts as seen too, so an entry an admin already acted on
 * answers `changed: false`. An entry that was not approved automatically is
 * refused with 409 ENTRY_NOT_AUTO_APPROVED. `seen` works as on the status
 * route: a changed entry is refused with 409 ENTRY_CHANGED.
 *
 * Order: the admin session, then the cross-site and media-type refusals, then
 * the ID, the JSON and the schema, then the work. Every response is no-store.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { verifyAdminSession } from '@/app/lib/api/verify-admin';
import { apiSuccess, apiError, apiFailure, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { REVIEW_REFUSALS, markEntrySeen } from '@/app/lib/firebase/server-cost-entries';
import { isDocumentId } from '@/app/lib/firebase/server-leads';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Strict: a body that carries anything else is refused, not trimmed. */
const SeenSchema = z.strictObject({
  seen: z.number().int().min(0).max(1_000_000),
});

export async function POST(request: NextRequest, context: RouteContext) {
  // ── Auth ──
  const auth = verifyAdminSession(request);
  if (!auth.valid) return noStore(apiError(auth.error!, auth.status!));

  // ── Cross-site and media type ──
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

  // ── Validate ──
  const result = SeenSchema.safeParse(body);
  if (!result.success) {
    return noStore(
      apiValidationError(result.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))),
    );
  }

  const outcome = await markEntrySeen(id, result.data.seen);
  if (outcome.kind !== 'done') return noStore(apiFailure(REVIEW_REFUSALS[outcome.kind]));

  return noStore(apiSuccess({ entry: outcome.entry, changed: outcome.changed }));
}
