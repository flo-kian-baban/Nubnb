/**
 * PUT  /api/properties/[id] — Update a property (admin-only).
 * DELETE /api/properties/[id] — Delete a property (admin-only).
 *
 * Authenticated via HTTP-only session cookie.
 * PUT validates via Zod partial schema before any Firestore write.
 * All Firestore writes go through the Admin SDK.
 */

import { NextRequest } from 'next/server';
import { getAdminDb } from '@/app/lib/firebase/admin';
import { verifyAdminSession } from '@/app/lib/api/verify-admin';
import { UpdatePropertySchema } from '@/app/lib/api/schemas';
import { apiSuccess, apiError, apiValidationError } from '@/app/lib/api/safe-response';

const COLLECTION = 'properties';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function PUT(request: NextRequest, context: RouteContext) {
  // ── Auth ──
  const auth = verifyAdminSession(request);
  if (!auth.valid) return apiError(auth.error!, auth.status!);

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
    const { id: _id, ...raw } = body;

    // ── Validate ──
    const result = UpdatePropertySchema.safeParse(raw);
    if (!result.success) {
      return apiValidationError(
        result.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        }))
      );
    }

    // Reject empty updates
    if (Object.keys(result.data).length === 0) {
      return apiError('No fields to update', 400);
    }

    const db = getAdminDb();
    const docRef = db.collection(COLLECTION).doc(id);

    // Verify the document exists
    const docSnap = await docRef.get();
    if (!docSnap.exists) {
      return apiError('Property not found', 404);
    }

    await docRef.update(result.data);

    return apiSuccess({ id });
  } catch (err) {
    return apiError('Failed to update property', 500, err);
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
