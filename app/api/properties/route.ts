/**
 * POST /api/properties — Create a new property (admin-only).
 *
 * Authenticated via HTTP-only session cookie.
 * Validated via Zod schema before any Firestore write.
 * All Firestore writes go through the Admin SDK — the client SDK never writes.
 *
 * Revalidates the renter-facing pages after a successful create, so a new
 * property appears on "/" without waiting for the ISR timer.
 *
 * `?unlisted=1` (dispatch 24) creates it unlisted: the property and its
 * `property_visibility` mark are written in one batch, so it is never public,
 * not even between two writes. The flag rides on the URL, never in the body,
 * because the body is the property document.
 *
 * A property whose Airbnb listing or calendar another property already holds
 * is refused (Kian's ruling of 2026-10-12, dispatch 34): 409 DUPLICATE_LISTING
 * with `issues` at the field, nothing written. A calendar link for another
 * Airbnb room than the listing is created, with `warnings` in the answer.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '@/app/lib/firebase/admin';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { CreatePropertySchema } from '@/app/lib/api/schemas';
import { apiSuccess, apiError, apiValidationError } from '@/app/lib/api/safe-response';
import { revalidateListingPages } from '@/app/lib/revalidate-listings';
import { PROPERTY_VISIBILITY_COLLECTION, unlistedDocument } from '@/app/lib/firebase/server-visibility';
import { listingIssues } from '@/app/lib/firebase/server-listing-clashes';

const COLLECTION = 'properties';

export const POST = adminRoute(async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    if (!body || typeof body !== 'object') {
      return apiError('Invalid request body', 400);
    }

    // Strip any client-supplied `id` field — Firestore generates the ID
    const { id: _id, ...raw } = body;

    // ── Validate ──
    const result = CreatePropertySchema.safeParse(raw);
    if (!result.success) {
      return apiValidationError(
        result.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        }))
      );
    }

    // ── The same listing or calendar on another property: refused, nothing written ──
    const links = await listingIssues(result.data, null);
    if (links.duplicates.length > 0) {
      return NextResponse.json(
        { success: false, error: `Not created: ${[...new Set(links.duplicates.map((issue) => issue.message))].join(' ')}`, code: 'DUPLICATE_LISTING', issues: links.duplicates },
        { status: 409 },
      );
    }

    const db = getAdminDb();
    const docRef = db.collection(COLLECTION).doc();
    if (request.nextUrl.searchParams.get('unlisted') === '1') {
      const batch = db.batch();
      batch.create(docRef, result.data);
      batch.create(db.collection(PROPERTY_VISIBILITY_COLLECTION).doc(docRef.id), unlistedDocument(docRef.id, new Date().toISOString()));
      await batch.commit();
    } else {
      await docRef.create(result.data);
    }
    revalidateListingPages(`create ${docRef.id}`, docRef.id);

    return apiSuccess({ id: docRef.id, warnings: links.mismatch }, 201);
  } catch (err) {
    return apiError('Failed to create property', 500, err);
  }
});
