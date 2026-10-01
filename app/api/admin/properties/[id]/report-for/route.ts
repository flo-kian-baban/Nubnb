/**
 * PUT /api/admin/properties/[id]/report-for — Set "Report For" on a property's record (admin-only, dispatch 23E).
 *
 * Request:  `{ name, address } | null` — the name and postal address the
 *           statement prints; null clears it, and the report then omits
 *           the block
 * Response: 200 `{ success: true, data: { record: PropertyManagementView } }`
 *           404 PROPERTY_NOT_FOUND when no property has that ID
 *
 * The one field is merged into `property_management/{propertyId}`, the
 * server-only record the property form sets whole, so what is typed while
 * writing a report is what the unit's info shows, and the reverse. It is
 * never written to the property document, which is world-readable. Every
 * response is no-store.
 */

import { NextRequest } from 'next/server';
import { verifyAdminSession } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { isDocumentId } from '@/app/lib/firebase/server-leads';
import { ReportForInputSchema, setReportFor } from '@/app/lib/firebase/server-management';

interface RouteContext {
  params: Promise<{ id: string }>;
}

function grpcCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? String(code) : 'unknown';
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
  let reportFor = null;
  if (body !== null) {
    const result = ReportForInputSchema.safeParse(body);
    if (!result.success) {
      return noStore(apiValidationError(result.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))));
    }
    reportFor = result.data;
  }
  try {
    const outcome = await setReportFor(id, reportFor);
    if (outcome.kind === 'no-such-property') return noStore(apiFailure({ message: 'That property does not exist.', status: 404, code: 'PROPERTY_NOT_FOUND' }));
    console.log(`[management] report-for ${reportFor ? 'set' : 'cleared'} for property ${id}`);
    return noStore(apiSuccess({ record: outcome.record }));
  } catch (err) {
    console.error(`[management] report-for write for ${id} failed: grpc code ${grpcCode(err)}`);
    return noStore(apiFailure({ message: 'Could not save who the report is for.', status: 502, code: 'REPORT_FOR_WRITE_FAILED', hint: 'It may or may not have been saved. Reload to see what is stored.' }));
  }
}
