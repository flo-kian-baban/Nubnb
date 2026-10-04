/**
 * PATCH /api/admin/income/lines/[id] — Reject a proposed line, or propose a line again (admin-only, dispatch 27).
 *
 * Request: `{ action: "reject" }` or `{ action: "propose-again" }`. A line
 * is proposed again when it was rejected, or when it was accepted and its
 * statement line has since been removed from the draft; a line still in its
 * statement is never proposed again (409 STILL_IN_STATEMENT), so it cannot
 * print twice.
 *
 * Response: 200 `{ line }`; 404 LINE_NOT_FOUND; 409 LINES_CHANGED when the
 * line is not in the state the action needs. Every response is no-store.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { verifyAdminSession } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { DECIDE_REFUSALS, decideLine, isEarningsLineId } from '@/app/lib/firebase/server-income';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const DecideInputSchema = z.strictObject({ action: z.enum(['reject', 'propose-again']) });

export async function PATCH(request: NextRequest, context: RouteContext) {
  const auth = verifyAdminSession(request);
  if (!auth.valid) return noStore(apiError(auth.error!, auth.status!));
  const crossSite = refuseCrossSite(request);
  if (crossSite) return crossSite;
  const wrongType = requireMediaType(request, 'application/json');
  if (wrongType) return wrongType;
  const { id } = await context.params;
  if (!isEarningsLineId(id)) return noStore(apiError('Invalid line ID', 400));
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return noStore(apiError('Invalid JSON body', 400));
  }
  const parsed = DecideInputSchema.safeParse(body);
  if (!parsed.success) return noStore(apiValidationError(parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))));
  const outcome = await decideLine(id, parsed.data.action);
  if (outcome.kind === 'decided') return noStore(apiSuccess({ line: outcome.line }));
  return noStore(apiFailure(DECIDE_REFUSALS[outcome.kind]));
}
