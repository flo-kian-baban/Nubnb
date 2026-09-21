/**
 * PUT  /api/properties/[id] — Update a property (admin-only).
 * DELETE /api/properties/[id] — Delete a property (admin-only).
 *
 * Authenticated via HTTP-only session cookie.
 * All Firestore writes go through the Admin SDK.
 */

import { NextRequest } from 'next/server';
import { getAdminDb } from '@/app/lib/firebase/admin';
import { verifyAdminSession } from '@/app/lib/api/verify-admin';
import { apiSuccess, apiError, apiValidationError } from '@/app/lib/api/safe-response';
import { UpdatePropertySchema } from '@/app/lib/api/schemas';

const COLLECTION = 'properties';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Recursively strip `undefined` values from an object.
 * Firestore Admin SDK throws on undefined — this makes the payload safe.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stripUndefined(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(stripUndefined);
  if (typeof obj !== 'object') return obj;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const clean: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      clean[key] = typeof value === 'object' && value !== null ? stripUndefined(value) : value;
    }
  }
  return clean;
}

export async function PUT(request: NextRequest, context: RouteContext) {
  // ── Auth ──
  const auth = verifyAdminSession(request);
  if (!auth.valid) {
    console.error('[PUT /api/properties] Auth failed:', auth.error);
    return apiError(auth.error!, auth.status!);
  }

  const { id } = await context.params;

  if (!id || typeof id !== 'string') {
    return apiError('Property ID is required', 400);
  }

  try {
    const body = await request.json();

    if (!body || typeof body !== 'object') {
      return apiError('Invalid request body', 400);
    }

    // Strip `id` from the update payload — it's part of the URL, not the document
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { id: _id, ...rawData } = body;

    // Deep-clean undefined values (Firestore Admin throws on undefined)
    const updateData = stripUndefined(rawData);

    // Reject empty updates
    if (Object.keys(updateData).length === 0) {
      return apiError('No fields to update', 400);
    }

    // ── Validate ──
    // Re-enabled after confirming UpdatePropertySchema accepts all 43 stored
    // documents (it did not: `reviews[].avatar` is "" on all 142 reviews and
    // the strict URL rule rejected 35 of them — see StoredReviewSchema).
    //
    // The parse result is deliberately DISCARDED. Zod rebuilds objects in
    // schema-declaration order and strips unknown keys from nested objects,
    // so writing `result.data` could reorder `priceInfo` or silently drop a
    // nested field added later. Validation here is a gate, not a transform:
    // what gets written is exactly what the client sent.
    const result = UpdatePropertySchema.safeParse(updateData);
    if (!result.success) {
      return apiValidationError(
        result.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      );
    }

    const db = getAdminDb();
    const docRef = db.collection(COLLECTION).doc(id);

    // Verify the document exists
    const docSnap = await docRef.get();
    if (!docSnap.exists) {
      return apiError('Property not found', 404);
    }

    await docRef.update(updateData);

    console.log(`[PUT /api/properties/${id}] Updated successfully (${Object.keys(updateData).length} fields)`);
    return apiSuccess({ id });
  } catch (err) {
    console.error(`[PUT /api/properties/${id}] Firestore write error:`, err);
    const message = err instanceof Error ? err.message : 'Failed to update property';
    return apiError(message, 500, err);
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  // ── Auth ──
  const auth = verifyAdminSession(request);
  if (!auth.valid) return apiError(auth.error!, auth.status!);

  const { id } = await context.params;

  if (!id || typeof id !== 'string') {
    return apiError('Property ID is required', 400);
  }

  try {
    const db = getAdminDb();
    const docRef = db.collection(COLLECTION).doc(id);

    // Verify the document exists
    const docSnap = await docRef.get();
    if (!docSnap.exists) {
      return apiError('Property not found', 404);
    }

    await docRef.delete();

    return apiSuccess({ id, deleted: true });
  } catch (err) {
    return apiError('Failed to delete property', 500, err);
  }
}

