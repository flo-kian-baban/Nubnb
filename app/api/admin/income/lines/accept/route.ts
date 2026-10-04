/**
 * POST /api/admin/income/lines/accept — Accept proposed lines into a property's statement draft (admin-only, dispatch 27).
 *
 * Request: `{ propertyId, month, lines: [{ id, description?, amount? }] }` —
 * one line, edited or not, or a property's lines together. `description` and
 * `amount` ("2599.37", "-397.40") are sent only when the admin changed them.
 *
 * Response: 200 `{ draft, lines }` — the draft as stored now and the lines
 * as decided. Refusals, each with nothing accepted:
 *   409 LINES_CHANGED, LINK_CHANGED, STATEMENT_FINISHED (Kian's ruling: a
 *       finished statement is never touched), DRAFT_UNREADABLE
 *   404 PROPERTY_NOT_FOUND
 *   422 STATEMENT_FULL, AMOUNT_TOO_LARGE, or a field that is not one
 *   502 ACCEPT_FAILED (may or may not be accepted)
 *
 * Nothing reaches an owner's statement until an admin accepts it (Kian's
 * ruling); this is that step. Every response is no-store.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { verifyAdminSession } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { isDocumentId } from '@/app/lib/firebase/server-leads';
import { toCents } from '@/app/lib/firebase/server-cost-entries';
import { ACCEPT_REFUSALS, acceptLines, cleanDescription, isEarningsLineId } from '@/app/lib/firebase/server-income';
import { STATEMENT_LIMITS, isMonth } from '@/app/lib/reports/model';

/** The statement's own form for an amount: "60.00" or "-60.00", at most $999,999.99. */
const SIGNED_AMOUNT = /^-?(0|[1-9][0-9]{0,5})\.[0-9]{2}$/;

const AcceptInputSchema = z.strictObject({
  propertyId: z.string().refine((id) => isDocumentId(id), 'Not a property ID'),
  month: z.string().refine(isMonth, 'A month, like 2026-09'),
  lines: z
    .array(
      z.strictObject({
        id: z.string().refine(isEarningsLineId, 'Not a line ID'),
        description: z
          .string()
          .transform((s, ctx) => {
            const clean = cleanDescription(s);
            if (clean === null) ctx.addIssue({ code: 'custom', message: `1 to ${STATEMENT_LIMITS.LINE_DESCRIPTION_MAX} characters, no control characters` });
            return clean ?? '';
          })
          .optional(),
        amount: z
          .string()
          .regex(SIGNED_AMOUNT, 'An amount with two decimals, like 1205.90 or -397.40')
          .transform(toCents)
          .pipe(z.number().refine((cents) => cents !== 0, 'An amount is never $0.00'))
          .optional(),
      }),
    )
    .min(1, 'At least one line')
    .max(STATEMENT_LIMITS.LINES_MAX)
    .refine((lines) => new Set(lines.map((line) => line.id)).size === lines.length, 'A line is listed twice'),
});

export async function POST(request: NextRequest) {
  const auth = verifyAdminSession(request);
  if (!auth.valid) return noStore(apiError(auth.error!, auth.status!));
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
  const parsed = AcceptInputSchema.safeParse(body);
  if (!parsed.success) return noStore(apiValidationError(parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))));
  const { propertyId, month, lines } = parsed.data;
  const outcome = await acceptLines({ propertyId, month, items: lines.map((line) => ({ id: line.id, ...(line.description === undefined ? {} : { description: line.description }), ...(line.amount === undefined ? {} : { amountCents: line.amount }) })) });
  if (outcome.kind === 'accepted') return noStore(apiSuccess({ draft: outcome.draft, lines: outcome.lines }));
  return noStore(apiFailure(ACCEPT_REFUSALS[outcome.kind]));
}
