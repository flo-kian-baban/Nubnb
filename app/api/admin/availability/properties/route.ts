/**
 * GET /api/admin/availability/properties — the slice of every property the Availability page works from (the
 * Availability page, round 1, 2026-10-19), in place of the whole admin property list (1.66 MB, of which the page used a
 * few fields).
 *
 * Response: 200 `{ success: true, data: { properties: AvailabilityProperty[] } }` — each property as
 * app/lib/availability/property.ts builds it: the name the admin shows (its cleaner-facing name, else its title), the
 * public title, slug, city, area, location, type, guests, bedrooms, bathrooms, the nightly price and the cleaning fee
 * as admins set them (priceInfo), the minimum nights, the cover image, the Airbnb link, the names of the offers marked
 * available (for text search), and whether it is unlisted (Kian's ruling K5: marked "Not on the site").
 *
 * Reads: every property (one read each, the fields above by a field mask; `offers` is read whole and reduced to its
 * names here), the unlisted marks (one query) and every cleaner-facing name (one query): the same reads as the whole
 * list, a small fraction of its bytes. Other pages keep GET /api/admin/properties as it is. Every response is no-store.
 */

import { getAdminDb } from '@/app/lib/firebase/admin';
import { unlistedPropertyIds } from '@/app/lib/firebase/server-visibility';
import { internalNameOf, listCleanerFacingNames } from '@/app/lib/firebase/server-property-names';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiFailure, apiSuccess, noStore } from '@/app/lib/api/safe-response';
import { toAvailabilityProperty } from '@/app/lib/availability/property';
import type { Property } from '@/app/types/property';

/** The fields the slice is built from. */
const FIELDS = ['name', 'slug', 'addressDetails', 'location', 'type', 'guests', 'bedrooms', 'bathrooms', 'price', 'priceInfo', 'coverImage', 'airbnbUrl', 'offers'] as const;

const grpcCode = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? String(code) : 'unknown';
};

export const GET = adminRoute(async function GET() {
  try {
    const [snapshot, unlisted, facing] = await Promise.all([getAdminDb().collection('properties').select(...FIELDS).get(), unlistedPropertyIds(), listCleanerFacingNames()]);
    const properties = snapshot.docs.map((doc) => {
      const data = { id: doc.id, ...doc.data() } as unknown as Property;
      return toAvailabilityProperty(data, internalNameOf(facing, doc.id, typeof data.name === 'string' ? data.name : null) ?? undefined, unlisted.has(doc.id));
    });
    return noStore(apiSuccess({ properties }));
  } catch (err) {
    console.error(`[availability] the property slice could not be read: grpc code ${grpcCode(err)}`);
    return noStore(apiFailure({ message: 'Could not load the properties.', status: 503, code: 'PROPERTIES_UNAVAILABLE' }));
  }
});
