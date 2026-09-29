/**
 * PATCH /api/admin/cleaners/[id] — Deactivate or reactivate a cleaner (admin-only).
 *
 * Accepts `{ status }` and nothing else. A change is one transaction: it sets
 * the status, appends a history event with the admin as its actor, and bumps
 * the cleaner's session epoch, so every session they hold ends on its next
 * request — and stays ended after a reactivation, which covers a lost phone.
 * Their code is untouched: deactivation stops it working, reactivation makes
 * it work again (a new code is POST /api/admin/cleaners/[id]/code). Setting the status a cleaner already has writes nothing and
 * answers `changed: false`. See setCleanerStatus.
 *
 * Entries are not touched either way; each keeps the name it was logged
 * under. The page changes a row only from the cleaner this returns: status
 * changes are not optimistic.
 *
 * Order: the admin session, then the cross-site and media-type refusals, then
 * the ID, the JSON and the schema, then the work. Every response is no-store,
 * the refusals included.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { verifyAdminSession } from '@/app/lib/api/verify-admin';
import {
  apiSuccess,
  apiError,
  apiFailure,
  apiValidationError,
  noStore,
} from '@/app/lib/api/safe-response';
import { CLEANER_STATUSES, type Refusal } from '@/app/lib/cleaners/model';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { setCleanerStatus, type SetCleanerStatusResult } from '@/app/lib/firebase/server-cleaners';
import { isDocumentId } from '@/app/lib/firebase/server-leads';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Strict: a body that carries anything besides `status` is refused, not trimmed. */
const StatusChangeSchema = z.strictObject({
  status: z.enum(CLEANER_STATUSES),
});

/** What the PATCH answers for every outcome but `done`. */
const STATUS_REFUSALS: Record<Exclude<SetCleanerStatusResult['kind'], 'done'>, Refusal> = {
  'not-found': {
    status: 404,
    code: 'CLEANER_NOT_FOUND',
    message: 'Cleaner not found',
  },
  unreadable: {
    status: 500,
    code: 'CLEANER_RECORD_UNREADABLE',
    message: 'This cleaner’s stored record is not in the shape a status change needs.',
    hint: 'Nothing was changed.',
  },
  // The transaction failed. A failure can come after the commit landed, so
  // this does not claim that nothing was saved.
  failed: {
    status: 502,
    code: 'CLEANER_UPDATE_FAILED',
    message: 'Could not save the status change.',
    hint: 'It may or may not have been saved. Reload to see the stored status.',
  },
};

export async function PATCH(request: NextRequest, context: RouteContext) {
  // ── Auth ──
  const auth = verifyAdminSession(request);
  if (!auth.valid) return noStore(apiError(auth.error!, auth.status!));

  // ── Cross-site and media type ──
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

  // ── Validate ──
  const result = StatusChangeSchema.safeParse(body);
  if (!result.success) {
    return noStore(
      apiValidationError(
        result.error.issues.map((i) => ({
          path: i.path.map(String).join('.'),
          message: i.message,
        })),
      ),
    );
  }

  const outcome = await setCleanerStatus(id, result.data.status);
  if (outcome.kind !== 'done') return noStore(apiFailure(STATUS_REFUSALS[outcome.kind]));

  return noStore(apiSuccess({ cleaner: outcome.cleaner, changed: outcome.changed }));
}
