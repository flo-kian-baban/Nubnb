/**
 * POST /api/mirror-property-images — bring one property's mirrored images up
 * to date (admin-only).
 *
 * Called by the admin form after a property is created or updated. It is
 * deliberately a separate request from the save: the save must succeed or
 * fail on its own terms, and mirroring 20-40 images takes far longer than
 * writing a document. Coupling them would mean a slow CDN could fail a save.
 *
 * On any failure the document is left exactly as it was — `coverImageStored`
 * and `imagesStored` keep whatever they held, including nothing at all. The
 * caller surfaces the reason to the operator, and
 * `scripts/mirror-images.mjs` remains the catch-up tool.
 *
 * Request:  `{ id: string }`
 * Response: `{ success: true, data: { mirrored, reused, alreadyStored, variants, imageCount } }`
 *
 * An image counts as stored only once its original *and* all three WebP
 * variants exist, because the public surfaces derive a variant's URL from the
 * stored URL and a missing variant would render a 403.
 */

import { NextRequest } from 'next/server';
import { getAdminDb } from '@/app/lib/firebase/admin';
import { verifyAdminSession } from '@/app/lib/api/verify-admin';
import { apiSuccess, apiError, apiFailure } from '@/app/lib/api/safe-response';
import { mirrorPropertyImages } from '@/app/lib/mirror-images';
import { revalidateListingPages } from '@/app/lib/revalidate-listings';

const COLLECTION = 'properties';

/**
 * Longer than the scrape route: this fetches every image of a property.
 * The internal deadline below stops the work with room to spare, so the
 * function returns a reasoned failure rather than being killed mid-flight.
 */
export const maxDuration = 300;

const MIRROR_BUDGET_MS = 240_000;

export async function POST(request: NextRequest) {
  const auth = verifyAdminSession(request);
  if (!auth.valid) return apiError(auth.error!, auth.status!);

  let body: { id?: unknown };
  try {
    body = await request.json();
  } catch {
    return apiError('Invalid JSON body', 400);
  }

  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!id) return apiError('Property ID is required', 400);

  try {
    const db = getAdminDb();
    const docRef = db.collection(COLLECTION).doc(id);
    const snap = await docRef.get();
    if (!snap.exists) return apiError('Property not found', 404);

    const data = snap.data() || {};
    const coverImage = typeof data.coverImage === 'string' ? data.coverImage : '';
    const images = Array.isArray(data.images)
      ? data.images.filter((u): u is string => typeof u === 'string' && !!u)
      : [];

    const result = await mirrorPropertyImages({
      propertyId: id,
      coverImage,
      images,
      deadlineMs: MIRROR_BUDGET_MS,
    });

    if (!result.ok) {
      console.warn(`[mirror-property-images] ${id}: ${result.reason}`);
      return apiFailure({
        message: 'The property was saved, but its images could not be mirrored.',
        status: 502,
        code: 'MIRROR_FAILED',
        hint: 'The saved property is unaffected and its existing mirrored images are untouched. Re-save, or run scripts/mirror-images.mjs to catch up.',
        evidence: {
          reason: result.reason || 'unknown',
          mirrored: result.mirrored,
          reused: result.reused,
          variants: result.variants,
          failed: result.failed,
        },
      });
    }

    // Only ever these two fields, and only once every image has landed.
    // `.update()` rather than `.set()`, so nothing else on the document can
    // be touched from this path.
    await docRef.update({
      coverImageStored: result.coverImageStored,
      imagesStored: result.imagesStored,
    });

    // The public pages read `coverImageStored`/`imagesStored` now, so this
    // route changes what renters see and has to invalidate like any other
    // write. Without it a newly mirrored image waits out the hour-long ISR
    // window before appearing. The create/update/delete routes already do
    // this; until these fields were read by anything, this one had no reason
    // to.
    revalidateListingPages(`mirror ${id}`);

    console.log(
      `[mirror-property-images] ${id}: mirrored=${result.mirrored} reused=${result.reused} ` +
        `alreadyStored=${result.alreadyStored} variants=${result.variants} ` +
        `total=${(result.imagesStored?.length ?? 0) + 1}`,
    );

    return apiSuccess({
      mirrored: result.mirrored,
      reused: result.reused,
      alreadyStored: result.alreadyStored,
      variants: result.variants,
      imageCount: (result.imagesStored?.length ?? 0) + 1,
    });
  } catch (err) {
    console.error('[mirror-property-images] error:', err);
    return apiFailure({
      message: 'The property was saved, but its images could not be mirrored.',
      status: 500,
      code: 'MIRROR_FAILED',
      hint: 'The saved property is unaffected. Re-save, or run scripts/mirror-images.mjs to catch up.',
      internalError: err,
    });
  }
}
