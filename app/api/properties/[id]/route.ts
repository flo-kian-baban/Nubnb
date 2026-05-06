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
import { apiSuccess, apiError } from '@/app/lib/api/safe-response';

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
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { id: _id, ...updateData } = body;

    // Reject empty updates
    if (Object.keys(updateData).length === 0) {
      return apiError('No fields to update', 400);
    }

    const db = getAdminDb();
    const docRef = db.collection(COLLECTION).doc(id);

    // Verify the document exists
    const docSnap = await docRef.get();
    if (!docSnap.exists) {
      return apiError('Property not found', 404);
    }

    await docRef.update(updateData);

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
