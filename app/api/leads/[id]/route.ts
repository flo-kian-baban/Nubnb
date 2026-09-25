/**
 * GET   /api/leads/[id] — One contact submission in full (admin-only).
 * PATCH /api/leads/[id] — Set its status (admin-only).
 *
 * The PATCH is the only write the inbox makes. It accepts `{ status }` and
 * nothing else, and writes `status` and `statusChangedAt`; no other field on
 * the document is touched. See setLeadStatus.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { verifyAdminSession } from '@/app/lib/api/verify-admin';
import { apiSuccess, apiError, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { getLead, isDocumentId, setLeadStatus } from '@/app/lib/firebase/server-leads';
import { LEAD_STATUSES } from '@/app/lib/leads';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Strict: a body that carries anything besides `status` is refused, not trimmed. */
const StatusChangeSchema = z.strictObject({
  status: z.enum(LEAD_STATUSES),
});

export async function GET(request: NextRequest, context: RouteContext) {
  // ── Auth ──
  const auth = verifyAdminSession(request);
  if (!auth.valid) return apiError(auth.error!, auth.status!);

  const { id } = await context.params;
  if (!isDocumentId(id)) return apiError('Invalid lead ID', 400);

  try {
    const lead = await getLead(id);
    if (!lead) return noStore(apiError('Lead not found', 404));
    return noStore(apiSuccess(lead));
  } catch (err) {
    // Not a 404: a read that failed says nothing about whether the lead exists.
    return noStore(apiError('Failed to load lead', 500, err));
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  // ── Auth ──
  const auth = verifyAdminSession(request);
  if (!auth.valid) return apiError(auth.error!, auth.status!);

  const { id } = await context.params;
  if (!isDocumentId(id)) return apiError('Invalid lead ID', 400);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError('Invalid JSON body', 400);
  }

  // ── Validate ──
  const result = StatusChangeSchema.safeParse(body);
  if (!result.success) {
    return apiValidationError(
      result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    );
  }

  try {
    const written = await setLeadStatus(id, result.data.status);
    if (!written) return noStore(apiError('Lead not found', 404));
    return noStore(apiSuccess(written));
  } catch (err) {
    return noStore(apiError('Failed to change the lead status', 500, err));
  }
}
