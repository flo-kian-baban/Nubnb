/**
 * GET /api/admin/properties/[id]/statements — One property's statements, for its page (admin-only, dispatch 23D).
 *
 * Response: 200 `{ success: true, data: { propertyName, reports, drafts, downloads, management, unreadable } }`
 *           404 PROPERTY_NOT_FOUND when no property has that ID
 *
 * Every finished report of the property, whole; every draft, whole, so the
 * page can add an income row against the draft's revision through
 * PUT /api/admin/monthly-reports/draft; every download record; and the
 * management record. Read whole, no limit: a failed read is a 500, never an
 * empty page. Every response is no-store.
 */

import { NextRequest } from 'next/server';
import { verifyAdminSession } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, noStore } from '@/app/lib/api/safe-response';
import { isDocumentId } from '@/app/lib/firebase/server-leads';
import { readPropertyStatements } from '@/app/lib/firebase/server-reports';

interface RouteContext {
  params: Promise<{ id: string }>;
}

function grpcCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? String(code) : 'unknown';
}

export async function GET(request: NextRequest, context: RouteContext) {
  const auth = verifyAdminSession(request);
  if (!auth.valid) return noStore(apiError(auth.error!, auth.status!));
  const { id } = await context.params;
  if (!isDocumentId(id)) return noStore(apiError('Invalid property ID', 400));
  try {
    const statements = await readPropertyStatements(id);
    if (statements === null) return noStore(apiFailure({ message: 'That property does not exist.', status: 404, code: 'PROPERTY_NOT_FOUND' }));
    return noStore(apiSuccess(statements));
  } catch (err) {
    console.error(`[reports] statements read for ${id} failed: grpc code ${grpcCode(err)}`);
    return noStore(apiFailure({ message: 'Failed to load the statements.', status: 500, code: 'REPORTS_READ_FAILED' }));
  }
}
