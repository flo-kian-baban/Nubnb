/**
 * POST /api/admin/cost-entries/[id]/tax — Correct an entry's tax (admin-only, dispatch 21).
 *
 * Request:  `{ tax: string | null, seen }` — the tax as printed, "12.71", or
 *           null for none
 * Response: 200 `{ success: true, data: { entry: CostEntryView, changed } }`
 *
 * Tax is its own field on the entry, never a line. The entry's `taxCents` is
 * never rewritten: the change is a history event carrying the tax before and
 * after, and the tax that counts is read from the history (readLinesNow).
 * An entry sent before tax became its own field keeps its tax among its
 * lines, and is refused here with 409 ENTRY_TAX_IN_LINES: correct the line
 * instead. `seen` works as on the status route.
 *
 * Order: the admin session, then the cross-site and media-type refusals, then
 * the ID, the JSON and the schema, then the work. Every response is no-store.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { verifyAdminSession } from '@/app/lib/api/verify-admin';
import { apiSuccess, apiError, apiFailure, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { REVIEW_REFUSALS, TaxInputSchema, changeEntryTax } from '@/app/lib/firebase/server-cost-entries';
import { isDocumentId } from '@/app/lib/firebase/server-leads';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Strict: a body that carries anything else is refused, not trimmed. */
const TaxChangeSchema = z.strictObject({
  tax: TaxInputSchema,
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
  const result = TaxChangeSchema.safeParse(body);
  if (!result.success) {
    return noStore(
      apiValidationError(result.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))),
    );
  }

  const { tax, seen } = result.data;
  const outcome = await changeEntryTax(id, tax, seen);
  if (outcome.kind !== 'done') return noStore(apiFailure(REVIEW_REFUSALS[outcome.kind]));

  return noStore(apiSuccess({ entry: outcome.entry, changed: outcome.changed }));
}
