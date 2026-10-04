/**
 * GET /api/admin/income/uploads/[id]/file — A 60-second link to an upload's kept file (admin-only, dispatch 27).
 *
 * The file kept is the CSV as uploaded with its Guest and Details columns
 * blanked (Kian's ruling); the record holds the original's SHA-256. The path
 * comes from the record, never from the request; Google serves the bytes.
 *
 * Response: 200 `{ url, expiresAt, seconds }`; 404 UPLOAD_NOT_FOUND;
 * 410 FILE_MISSING when the record names an object that is not there.
 */

import { NextRequest } from 'next/server';
import { verifyAdminSession } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, noStore } from '@/app/lib/api/safe-response';
import { isDocumentId } from '@/app/lib/firebase/server-leads';
import { uploadFileLink } from '@/app/lib/firebase/server-income';

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
  if (!isDocumentId(id)) return noStore(apiError('Invalid upload ID', 400));
  try {
    const link = await uploadFileLink(id);
    if (link.kind === 'no-such-upload') return noStore(apiFailure({ message: 'No such upload.', status: 404, code: 'UPLOAD_NOT_FOUND' }));
    if (link.kind === 'object-missing') return noStore(apiFailure({ message: 'The kept file is not in storage.', status: 410, code: 'FILE_MISSING' }));
    return noStore(apiSuccess({ url: link.url, expiresAt: link.expiresAt, seconds: link.seconds }));
  } catch (err) {
    console.error(`[income] file link for upload ${id} failed: code ${grpcCode(err)}`);
    return noStore(apiFailure({ message: 'Could not open the file.', status: 502, code: 'FILE_LINK_FAILED' }));
  }
}
