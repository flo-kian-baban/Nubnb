/**
 * GET    /api/properties/[id] — Read one complete property (public).
 * PUT    /api/properties/[id] — Update a property (admin-only).
 * DELETE /api/properties/[id] — Delete a property (admin-only).
 *
 * Writes are authenticated via HTTP-only session cookie and go through the
 * Admin SDK. The GET is public because the documents are: firestore.rules
 * grants `allow read: if true` on this collection, so every field here was
 * already readable by any browser. Serving it from a route handler instead
 * means the homepage no longer has to ship the Firestore client SDK.
 *
 * Both write handlers revalidate the renter-facing pages after a successful
 * write, so an edit is visible without waiting for the ISR timer.
 */

import { NextRequest } from 'next/server';
import { getAdminDb } from '@/app/lib/firebase/admin';
import { getPropertyById } from '@/app/lib/firebase/server-properties';
import { verifyAdminSession } from '@/app/lib/api/verify-admin';
import { createRateLimiter } from '@/app/lib/api/rate-limit';
import { apiSuccess, apiError, apiValidationError, apiRateLimited } from '@/app/lib/api/safe-response';
import { UpdatePropertySchema } from '@/app/lib/api/schemas';
import { revalidateListingPages } from '@/app/lib/revalidate-listings';

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

/**
 * Public reads are rate limited only to keep the endpoint from being used to
 * hammer Firestore; 60/min is far above what opening property panels costs.
 */
const readLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 60, prefix: 'property-read' });

export async function GET(request: NextRequest, context: RouteContext) {
  const limit = await readLimiter.check(request);
  if (limit.limited) return apiRateLimited(limit.retryAfterMs);

  const { id } = await context.params;
  if (!id || typeof id !== 'string') {
    return apiError('Property ID is required', 400);
  }

  try {
    const property = await getPropertyById(id);
    if (!property) return apiError('Property not found', 404);
    return apiSuccess(property);
  } catch (err) {
    // A read that failed is not a property that does not exist. 500 lets the
    // caller offer a retry instead of telling the visitor the listing is gone.
    return apiError('Failed to load property', 500, err);
  }
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
    revalidateListingPages(`update ${id}`);

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
    revalidateListingPages(`delete ${id}`);

    return apiSuccess({ id, deleted: true });
  } catch (err) {
    return apiError('Failed to delete property', 500, err);
  }
}

