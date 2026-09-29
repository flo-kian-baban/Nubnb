/**
 * POST /api/admin/cost-entries/[id]/status — Approve, reject or remove an entry (admin-only).
 *
 * Request:  `{ status: 'approved' | 'rejected' | 'removed', reason?, seen }`
 * Response: 200 `{ success: true, data: { entry: CostEntryView, changed } }`
 *
 * A rejection needs a reason, which the cleaner sees in their app; approving
 * and removing take none. Any of the three can follow any other, so a removal
 * made by mistake is undone by approving. Nothing goes back to pending.
 *
 * `seen` is the length of the entry's history as the page last showed it. If
 * the entry has changed since — another admin acted on it — nothing is
 * written and the answer is 409 ENTRY_CHANGED. Setting the status an entry
 * already has writes nothing and answers `changed: false`.
 *
 * Nothing is deleted: the status before goes into the history event, and a
 * removed entry stays, marked, out of totals and reports. See setEntryStatus.
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
import { LIMITS, REVIEW_STATUSES } from '@/app/lib/cleaners/model';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { REVIEW_REFUSALS, setEntryStatus } from '@/app/lib/firebase/server-cost-entries';
import { isDocumentId } from '@/app/lib/firebase/server-leads';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const CONTROL_CHARACTER = /\p{Cc}/u;

/** A reason as typed: trimmed, at most 500 characters, line breaks allowed. Empty is none. */
const ReasonSchema = z
  .string()
  .transform((s) => s.normalize('NFC').trim())
  .pipe(
    z
      .string()
      .max(LIMITS.REASON_MAX, `At most ${LIMITS.REASON_MAX} characters`)
      .refine((s) => !CONTROL_CHARACTER.test(s.replace(/\n/g, '')), 'No control characters other than line breaks'),
  )
  .nullable()
  .optional()
  .transform((value) => (value ? value : null));

/** Strict: a body that carries anything else is refused, not trimmed. */
const StatusChangeSchema = z
  .strictObject({
    status: z.enum(REVIEW_STATUSES),
    reason: ReasonSchema,
    seen: z.number().int().min(0).max(1_000_000),
  })
  .superRefine((body, ctx) => {
    if (body.status === 'rejected' && body.reason === null) {
      ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Say why it is rejected: the cleaner sees this' });
    }
    if (body.status !== 'rejected' && body.reason !== null) {
      ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Only a rejection records a reason' });
    }
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

  const { status, reason, seen } = result.data;
  const outcome = await setEntryStatus(id, status, reason, seen);
  if (outcome.kind !== 'done') return noStore(apiFailure(REVIEW_REFUSALS[outcome.kind]));

  return noStore(apiSuccess({ entry: outcome.entry, changed: outcome.changed }));
}
