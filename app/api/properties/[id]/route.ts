/**
 * GET    /api/properties/[id] — Read one complete property (public; an
 *                               unlisted one only with an admin session).
 * PUT    /api/properties/[id] — Update a property (admin-only).
 * DELETE /api/properties/[id] — Delete a property that holds no money records, with the records that only
 *                               describe it (admin-only; dispatch 34, Kian's ruling of 2026-10-12).
 *
 * Writes are authenticated via HTTP-only session cookie and go through the
 * Admin SDK. The GET answers anyone, but the public gets a listed property
 * without its calendar link; an admin session gets the whole document,
 * unlisted or not, link included (dispatch 26: the link carries a secret key
 * and its feed carries guests' details). Browsers cannot read the collection
 * directly at all: firestore.rules refuses every read.
 *
 * Both write handlers revalidate the renter-facing pages after a successful
 * write, so an edit is visible without waiting for the ISR timer.
 *
 * A save whose Airbnb listing or calendar another property already holds is
 * saved and warned about (Kian's ruling of 2026-10-12, dispatch 34): the
 * answer's `warnings` name the other property at the field, as they do a
 * calendar link for another Airbnb room than the listing.
 */

import { NextRequest } from 'next/server';
import { getAdminDb } from '@/app/lib/firebase/admin';
import { getPropertyById } from '@/app/lib/firebase/server-properties';
import { verifyAdminSession } from '@/app/lib/api/verify-admin';
import { createRateLimiter } from '@/app/lib/api/rate-limit';
import { apiSuccess, apiError, apiFailure, apiValidationError, apiRateLimited } from '@/app/lib/api/safe-response';
import { UpdatePropertySchema } from '@/app/lib/api/schemas';
import { revalidateListingPages } from '@/app/lib/revalidate-listings';
import { deletePropertyUnlessItHoldsRecords, holdingsText } from '@/app/lib/firebase/server-property-delete';
import { listingIssues, type LinkIssue } from '@/app/lib/firebase/server-listing-clashes';

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
    // An unlisted property (Kian's ruling of 2026-10-03) is 404 to the public, exactly like one that does not
    // exist; the admin form reads through this route too, and with its session it gets the document.
    const admin = verifyAdminSession(request).valid;
    const property = await getPropertyById(id, { includeUnlisted: admin, includeCalendarLink: admin });
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

    // The listing and calendar as they will stand after the update (an update keeps what it does not name):
    // another property holding either is warned about, never refused, on a save. A failed check never fails the save.
    const stored = docSnap.data() ?? {};
    const linkOf = (key: 'airbnbUrl' | 'icalUrl') => (typeof updateData[key] === 'string' ? updateData[key] : typeof stored[key] === 'string' ? stored[key] : null);
    let warnings: LinkIssue[] | { path: string; message: string }[];
    try {
      const links = await listingIssues({ airbnbUrl: linkOf('airbnbUrl'), icalUrl: linkOf('icalUrl') }, id);
      warnings = [...links.duplicates, ...links.mismatch];
    } catch (err) {
      console.error(`[PUT /api/properties/${id}] the duplicate check could not read the properties:`, err instanceof Error ? err.message : err);
      warnings = [{ path: '', message: 'The check for the same listing or calendar on another property could not run.' }];
    }

    await docRef.update(updateData);
    revalidateListingPages(`update ${id}`, id);

    console.log(`[PUT /api/properties/${id}] Updated successfully (${Object.keys(updateData).length} fields)`);
    return apiSuccess({ id, warnings });
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

  // A property with drafts, statements, accepted income, title links or cost entries is never deleted (Kian's
  // ruling of 2026-10-12, dispatch 34): 409 PROPERTY_HOLDS_RECORDS names what it holds and points to Unlisted and
  // Exclude from reporting. One holding none of them goes with its unlisted mark (dispatch 29), its owner record
  // and its cleaner-facing name, in one transaction (server-property-delete.ts).
  try {
    const outcome = await deletePropertyUnlessItHoldsRecords(id);
    if (outcome.kind === 'not-found') return apiError('Property not found', 404);
    if (outcome.kind === 'holds-records') {
      const { holdings } = outcome;
      return apiFailure({
        status: 409,
        code: 'PROPERTY_HOLDS_RECORDS',
        message: `It holds ${holdingsText(holdings)}, so it cannot be deleted.`,
        hint: 'Mark it Unlisted and Exclude it from reporting instead, under Status on its edit page. Nothing was deleted.',
        evidence: { ...holdings },
      });
    }
    revalidateListingPages(`delete ${id}`, id);
    return apiSuccess({ id, deleted: true });
  } catch (err) {
    return apiError('Failed to delete property', 500, err);
  }
}

