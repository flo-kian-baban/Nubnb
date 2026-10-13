/**
 * POST /api/admin/income/lines/reject — Reject a property's proposed lines together (admin-only, dispatch 37C, N2).
 *
 * Kian's ruling of 2026-10-04 lists accept, edit and reject "one at a time or a property's together".
 *
 * Request: `{ ids: string[] }` — every one still proposed. Response: 200 `{ lines }`, the lines as rejected. Refusals,
 * nothing rejected: 409 LINES_CHANGED; 502 DECISION_FAILED (may or may not have landed). Every response is no-store.
 */

import { NextRequest } from 'next/server';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { REJECT_ALL_REFUSALS, rejectLines } from '@/app/lib/firebase/server-income';
import { RejectInputSchema } from '@/app/lib/income/schemas';

export const POST = adminRoute(async function POST(request: NextRequest, _context: unknown, { actor }) {
  const crossSite = refuseCrossSite(request);
  if (crossSite) return crossSite;
  const wrongType = requireMediaType(request, 'application/json');
  if (wrongType) return wrongType;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return noStore(apiError('Invalid JSON body', 400));
  }
  const parsed = RejectInputSchema.safeParse(body);
  if (!parsed.success) return noStore(apiValidationError(parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))));
  const outcome = await rejectLines(actor, parsed.data.ids);
  if (outcome.kind === 'rejected') return noStore(apiSuccess({ lines: outcome.lines }));
  return noStore(apiFailure(REJECT_ALL_REFUSALS[outcome.kind]));
});
