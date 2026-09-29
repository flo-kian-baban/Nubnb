/**
 * POST /api/admin/cost-entries/[id]/lines — Correct a line of an entry, or add one (admin-only).
 *
 * Request:  `{ index: number | null, line: { name, quantity, lineTotal }, seen }`
 *           `index` is the line's place, from 0; null adds a line at the end
 * Response: 200 `{ success: true, data: { entry: CostEntryView, changed } }`
 *
 * The amount is the line's total as printed on the receipt, "7.98" or
 * "-5.00", in the same form the cleaner app sends; the quantity is for
 * reference and is never multiplied. A negative amount is money back: a
 * discount or a return, which a phone's number pad cannot enter.
 *
 * The entry's `lines` are never rewritten. The change is a history event
 * carrying the line before and after, so what the cleaner sent and every
 * earlier correction stay readable. No reason is asked for. `seen` works as
 * on the status route: a changed entry is refused with 409, and a correction
 * that changes nothing writes nothing (`changed: false`). See changeEntryLine.
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
import { LIMITS } from '@/app/lib/cleaners/model';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import {
  LineInputSchema,
  REVIEW_REFUSALS,
  changeEntryLine,
} from '@/app/lib/firebase/server-cost-entries';
import { isDocumentId } from '@/app/lib/firebase/server-leads';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Strict: a body that carries anything else is refused, not trimmed. */
const LineChangeSchema = z.strictObject({
  index: z.number().int().min(0).max(LIMITS.LINES_MAX_AFTER_REVIEW - 1).nullable(),
  line: LineInputSchema,
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
  const result = LineChangeSchema.safeParse(body);
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

  const { index, line, seen } = result.data;
  const outcome = await changeEntryLine(id, index, line, seen);
  if (outcome.kind !== 'done') return noStore(apiFailure(REVIEW_REFUSALS[outcome.kind]));

  return noStore(apiSuccess({ entry: outcome.entry, changed: outcome.changed }));
}
