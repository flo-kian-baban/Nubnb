/**
 * GET /api/admin/properties/[id]/management — A property's co-owners, statement months and default fee (admin-only, dispatch 23B).
 * PUT /api/admin/properties/[id]/management — Set the record whole, or clear it with `null`.
 *
 * Request (PUT):  `{ owners: [{ name, email? }], statementsFrom, statementsUntil, defaultFee: { label, amount } | null } | null`
 * Response:       200 `{ success: true, data: { record: PropertyManagementView | null } }`
 *                 404 PROPERTY_NOT_FOUND when no property has that ID
 *
 * The record lives in `property_management/{propertyId}`, server-only, and
 * never on the world-readable property document. Nothing sends email: the
 * addresses are kept for a later decision. Every response is no-store.
 */

import { NextRequest } from 'next/server';
import { verifyAdminSession } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { isDocumentId } from '@/app/lib/firebase/server-leads';
import { ManagementInputSchema, getManagement, setManagement } from '@/app/lib/firebase/server-management';

interface RouteContext {
  params: Promise<{ id: string }>;
}

function grpcCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? String(code) : 'unknown';
}

const NOT_FOUND = { message: 'That property does not exist.', status: 404, code: 'PROPERTY_NOT_FOUND' } as const;

export async function GET(request: NextRequest, context: RouteContext) {
  const auth = verifyAdminSession(request);
  if (!auth.valid) return noStore(apiError(auth.error!, auth.status!));
  const { id } = await context.params;
  if (!isDocumentId(id)) return noStore(apiError('Invalid property ID', 400));
  try {
    return noStore(apiSuccess({ record: await getManagement(id) }));
  } catch (err) {
    console.error(`[management] read of ${id} failed: grpc code ${grpcCode(err)}`);
    return noStore(apiFailure({ message: 'Could not read the co-owners record.', status: 503, code: 'MANAGEMENT_UNAVAILABLE' }));
  }
}

export async function PUT(request: NextRequest, context: RouteContext) {
  const auth = verifyAdminSession(request);
  if (!auth.valid) return noStore(apiError(auth.error!, auth.status!));
  const crossSite = refuseCrossSite(request);
  if (crossSite) return crossSite;
  const wrongType = requireMediaType(request, 'application/json');
  if (wrongType) return wrongType;
  const { id } = await context.params;
  if (!isDocumentId(id)) return noStore(apiError('Invalid property ID', 400));

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return noStore(apiError('Invalid JSON body', 400));
  }
  let input = null;
  if (body !== null) {
    const result = ManagementInputSchema.safeParse(body);
    if (!result.success) {
      return noStore(apiValidationError(result.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))));
    }
    input = result.data;
  }
  try {
    const outcome = await setManagement(id, input);
    if (outcome.kind === 'no-such-property') return noStore(apiFailure(NOT_FOUND));
    console.log(`[management] ${outcome.kind} for property ${id}`);
    return noStore(apiSuccess({ record: outcome.kind === 'set' ? outcome.record : null }));
  } catch (err) {
    console.error(`[management] write for ${id} failed: grpc code ${grpcCode(err)}`);
    return noStore(apiFailure({ message: 'Could not save the co-owners record.', status: 502, code: 'MANAGEMENT_WRITE_FAILED', hint: 'It may or may not have been saved. Open the property again to see what is stored.' }));
  }
}
