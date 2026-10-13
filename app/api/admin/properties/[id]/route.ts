/**
 * GET /api/admin/properties/[id] — one property exactly as stored, for the
 * edit page (dispatch 30).
 *
 * Response: 200 `{ success: true, data: { property: Property, unlisted: boolean, createdMonth: 'yyyy-mm' | null } }`
 *           404 PROPERTY_NOT_FOUND when no property has that ID
 *
 * The edit page sends back what it was given, so what it is given must be
 * the stored document itself — every field, in its stored order, the
 * calendar link and the stored image fields included. The public read
 * (`getPropertyById`) cannot serve it: it folds the mirrored URLs into
 * `coverImage` and `images`, drops `coverImageStored` and `imagesStored`,
 * and normalises the summary fields, so a save of what it returns would
 * rewrite the document. This route is the list's read (GET
 * /api/admin/properties) for one document: `{ id, ...doc.data() }`, with
 * whether the property is unlisted beside it, never inside it, and the
 * Toronto month it was created, which the owed-months rule needs.
 *
 * Admin-only. Every response is no-store.
 */

import { NextRequest } from 'next/server';
import { getAdminDb } from '@/app/lib/firebase/admin';
import { createdMonthOf } from '@/app/lib/firebase/created-month';
import { isDocumentId } from '@/app/lib/firebase/server-leads';
import { PROPERTY_VISIBILITY_COLLECTION } from '@/app/lib/firebase/server-visibility';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, noStore } from '@/app/lib/api/safe-response';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** The one thing logged about a Firestore error: its gRPC code. */
function grpcCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? String(code) : 'unknown';
}

export const GET = adminRoute(async function GET(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  if (!isDocumentId(id)) return noStore(apiError('Invalid property ID', 400));

  try {
    const db = getAdminDb();
    const [doc, mark] = await db.getAll(db.collection('properties').doc(id), db.collection(PROPERTY_VISIBILITY_COLLECTION).doc(id));
    if (!doc.exists) return noStore(apiFailure({ message: 'That property does not exist.', status: 404, code: 'PROPERTY_NOT_FOUND' }));
    return noStore(
      apiSuccess({
        property: { id: doc.id, ...doc.data() },
        unlisted: mark.exists && mark.data()?.unlisted === true,
        createdMonth: createdMonthOf(doc.createTime),
      }),
    );
  } catch (err) {
    console.error(`[admin/properties/${id}] read failed: grpc code ${grpcCode(err)}`);
    return noStore(apiFailure({ message: 'Could not load the property.', status: 503, code: 'PROPERTY_UNAVAILABLE' }));
  }
});
