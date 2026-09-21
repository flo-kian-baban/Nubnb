/**
 * On-demand revalidation for the renter-facing pages.
 *
 * `/` and `/property/[slug]` are cached and regenerated on a timer, which on
 * its own would mean an admin edit sat invisible until the timer expired.
 * Every write path that can change what a visitor sees calls this instead, so
 * a create, an edit or a delete is live on the next request.
 *
 * The timer (see LISTINGS_REVALIDATE_SECONDS) stays as a backstop for changes
 * that never pass through the API — a document edited straight in the
 * Firestore console, say.
 *
 * Revalidation is best-effort by design: if it throws, the write has already
 * landed and reporting the write as failed would be a lie. The page simply
 * refreshes on its timer instead, so the cost of a failure here is staleness,
 * not data loss.
 */

import { revalidatePath } from 'next/cache';

/**
 * Time-based fallback, in seconds. One hour.
 *
 * Every admin write revalidates on demand, so this only has to catch
 * out-of-band edits; an hour is short enough that those surface the same day
 * and long enough that essentially every request is served from cache rather
 * than from Firestore.
 *
 * Next reads `export const revalidate` statically and rejects an imported
 * constant, so app/page.tsx and app/property/[slug]/page.tsx each spell out
 * `3600` themselves. This is the documented value they must match.
 */
export const LISTINGS_REVALIDATE_SECONDS = 3600;

export function revalidateListingPages(reason: string): void {
  try {
    // The homepage carries the whole catalogue, so any write can change it.
    revalidatePath('/');
    // 'page' targets the dynamic route itself, which invalidates every slug
    // rendered from it — the right blast radius when a rename can move a
    // property from one slug to another.
    revalidatePath('/property/[slug]', 'page');
  } catch (err) {
    console.error(`[revalidate] ${reason}: failed to revalidate listing pages`, err);
  }
}
