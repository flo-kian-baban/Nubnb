/**
 * GET /api/admin/monthly-reports/[id]/pdf — A 60-second link to a finished statement's PDF (admin-only, dispatch 23B).
 *
 * Response: 200 `{ success: true, data: { url, expiresAt, seconds, download } }`
 *
 * The PDF is private in Storage; this answers a V4 signed URL that reads it
 * for 60 seconds, and records one `report_downloads` document, so the
 * tracker can say "downloaded twice, last 3 Oct 11:44". The record says a
 * link was made, not that anything was sent. The link is a bearer link and
 * is never logged. Every response is no-store.
 */

import { NextRequest } from 'next/server';
import { verifyAdminSession } from '@/app/lib/api/verify-admin';
import { apiSuccess, apiError, apiFailure, noStore } from '@/app/lib/api/safe-response';
import { downloadLink } from '@/app/lib/firebase/server-reports';
import { isDocumentId } from '@/app/lib/firebase/server-leads';

interface RouteContext {
  params: Promise<{ id: string }>;
}

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' || typeof code === 'string' ? String(code) : 'unknown';
}

export async function GET(request: NextRequest, context: RouteContext) {
  const auth = verifyAdminSession(request);
  if (!auth.valid) return noStore(apiError(auth.error!, auth.status!));
  const { id } = await context.params;
  if (!isDocumentId(id)) return noStore(apiError('Invalid report ID', 400));
  try {
    const link = await downloadLink(id);
    if (link.kind === 'no-such-report') return noStore(apiFailure({ status: 404, code: 'REPORT_NOT_FOUND', message: 'Statement not found' }));
    if (link.kind === 'object-missing') {
      console.error(`[reports] statement PDF missing for report ${id}`);
      return noStore(apiFailure({ status: 404, code: 'STATEMENT_OBJECT_MISSING', message: 'The statement names a PDF that is not in storage.' }));
    }
    return noStore(apiSuccess({ url: link.url, expiresAt: link.expiresAt, seconds: link.seconds, download: link.download }));
  } catch (err) {
    console.error(`[reports] download link failed for report ${id}: code ${errorCode(err)}`);
    return noStore(apiFailure({ status: 502, code: 'STATEMENT_LINK_FAILED', message: 'Could not open the statement.', hint: 'Try again in a moment.' }));
  }
}
