/**
 * GET /api/property/[id] — one complete property, as a static file.
 *
 * ── Why this exists next to /api/properties/[id] ──
 * Opening a property used to call the GET on that route. It is a real
 * function: it reads a cookie-less request for rate limiting, hits Firestore,
 * and bills a Vercel function invocation and an edge request on every panel a
 * visitor opens. Nothing about the answer is per-request — it is the same
 * document for everybody — so it has no business being computed per request.
 *
 * This route is `force-static` with `generateStaticParams`, so Next
 * prerenders all 44 documents at build time and Vercel serves them off the
 * CDN as plain files. Opening a property now costs zero function invocations.
 *
 * The write handlers stay on /api/properties/[id]: PUT and DELETE are
 * genuinely dynamic and admin-authenticated, and a route module can only have
 * one caching mode. That route keeps its GET too — the admin form reads
 * through it and wants the uncached truth after a save.
 *
 * ── Freshness ──
 * Same contract as the pages: an hour on the timer, plus on-demand
 * invalidation from every admin write through `revalidateListingPages()`.
 *
 * ── dynamicParams ──
 * Left at its default of `true`, so an ID created after the last build is
 * rendered on demand and then cached, rather than 404ing. That first request
 * is the only one that runs a function.
 */

import { getAdminDb } from '@/app/lib/firebase/admin';
import { getPropertyById } from '@/app/lib/firebase/server-properties';
import { apiSuccess, apiError } from '@/app/lib/api/safe-response';

export const dynamic = 'force-static';
export const revalidate = 3600;

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Prerender one file per property.
 *
 * Reads IDs only — this runs at build time and there is no reason to pull
 * 1.64 MB of documents to list 44 keys.
 */
export async function generateStaticParams() {
  const snapshot = await getAdminDb().collection('properties').select().get();
  return snapshot.docs.map((doc) => ({ id: doc.id }));
}

/**
 * No `request` parameter, deliberately: touching it would opt the route out
 * of static generation and put the function back.
 */
export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;

  try {
    const property = await getPropertyById(id);
    if (!property) return apiError('Property not found', 404);
    return apiSuccess(property);
  } catch (err) {
    console.error(`[api/property/${id}] read failed:`, err);
    return apiError('Could not load this property', 502);
  }
}
