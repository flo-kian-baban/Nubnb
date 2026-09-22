/**
 * Server-side property reads, via the Firebase Admin SDK.
 *
 * The public pages used to read Firestore from the browser, which meant the
 * prerendered HTML was built against an empty array and every visitor — and
 * every crawler — was served a page that said "No properties found". These
 * functions run on the server so the listings are in the HTML.
 *
 * ── Failure contract ──
 * A failed read THROWS. It never returns an empty array, and it never
 * degrades to a partial result.
 *
 * That is deliberate and it is the whole point: `/` and `/property/[slug]`
 * are cached with ISR, and Next only replaces a cached page when the render
 * succeeds. A throw therefore leaves the last good page in place and the
 * regeneration is retried on the next request. Had this returned `[]` on
 * failure, Next would have happily cached "this site has no properties" and
 * kept serving it until something else invalidated it.
 *
 * An empty array is still a legitimate result — it means the collection is
 * genuinely empty, and the UI says so in its own words. See PropertyList.
 */

import { getAdminDb } from './admin';
import type { Property, PropertySummary } from '@/app/types/property';

const COLLECTION = 'properties';

/**
 * The only fields that leave the server for the list, map and filters.
 *
 * Deliberately omitted, with their share of the 1.43 MB collection:
 *   offers 1.05 MB · imagesStored 173 KB · images 117 KB · reviews 56 KB ·
 *   description 36 KB · terms, details, highlights, amenities, airbnbUrl,
 *   googleMapsUrl, averageRating, totalReviewCount
 *
 * `coverImageStored` (9 KB) IS read, but it does not widen the payload: it is
 * collapsed into `coverImage` by `toSummary`, so exactly one URL per property
 * still reaches the browser.
 *
 * None of those is read by anything on the homepage. They arrive with
 * `getPropertyById` when a visitor opens a property.
 */
const SUMMARY_FIELDS = [
  'slug',
  'name',
  'location',
  'coordinates',
  'price',
  'currency',
  'bedrooms',
  'beds',
  'bathrooms',
  'guests',
  'coverImage',
  'coverImageStored',
  'type',
  'propertyTypeTag',
  'icalUrl',
  'priceInfo',
  'addressDetails',
] as const;

// ─── Normalisation ─────────────────────────────────────────────
// Firestore has no schema, so a field can be missing on any document. These
// coerce to the type the components expect rather than letting `undefined`
// reach a `.toLowerCase()` or a `coordinates[0]`. Nothing here drops or
// reorders a document: every property that exists is returned.

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function coordinates(value: unknown): [number, number] {
  return Array.isArray(value) && value.length >= 2
    ? [num(value[0]), num(value[1])]
    : [0, 0];
}

/**
 * Exported so the stored-URL fallback can be exercised against a real
 * Firestore *projection* — a `.select()` that omits `coverImageStored`
 * produces exactly the shape of a property that was never mirrored, without
 * editing a document to manufacture the case.
 */
export function toSummary(id: string, data: Record<string, unknown>): PropertySummary {
  const price = (data.priceInfo ?? {}) as Record<string, unknown>;
  const address = (data.addressDetails ?? {}) as Record<string, unknown>;
  const icalUrl = str(data.icalUrl);

  return {
    id,
    slug: str(data.slug),
    name: str(data.name),
    location: str(data.location),
    coordinates: coordinates(data.coordinates),
    price: num(data.price),
    currency: str(data.currency, 'CAD'),
    bedrooms: num(data.bedrooms),
    beds: num(data.beds),
    bathrooms: num(data.bathrooms),
    guests: num(data.guests),
    // The stored mirror wins, and the original is the fallback — resolved
    // here, on the server, so the browser is handed one URL rather than two
    // and never has to decide. A property with no mirror keeps its
    // a0.muscache.com URL, which the image loader passes through untouched.
    coverImage: str(data.coverImageStored) || str(data.coverImage),
    type: str(data.type),
    propertyTypeTag: str(data.propertyTypeTag),
    // Omitted rather than empty-stringed: the availability filter and the
    // detail calendar both branch on its presence.
    ...(icalUrl ? { icalUrl } : {}),
    priceInfo: {
      nightly: num(price.nightly),
      weekly: num(price.weekly),
      monthly: num(price.monthly),
      weekend: num(price.weekend),
      cleaningFee: num(price.cleaningFee),
      minNights: num(price.minNights, 1),
    },
    addressDetails: {
      city: str(address.city),
      state: str(address.state),
      area: str(address.area),
      country: str(address.country),
    },
  };
}

// ─── Reads ─────────────────────────────────────────────────────

/**
 * Every property, projected down to what the homepage renders.
 *
 * `.select()` is a Firestore projection, so the omitted fields are not read
 * out of Firestore either — this is cheaper on the wire in both directions,
 * not just smaller in the page.
 *
 * @throws if the read fails. See the failure contract at the top of the file.
 */
export async function getPropertySummaries(): Promise<PropertySummary[]> {
  const snapshot = await getAdminDb()
    .collection(COLLECTION)
    .select(...SUMMARY_FIELDS)
    .get();

  return snapshot.docs.map((doc) => toSummary(doc.id, doc.data() as Record<string, unknown>));
}

/**
 * One complete property document, for the detail panel.
 *
 * `null` means the document does not exist — a real answer, and a different
 * thing from a read that failed, which throws.
 *
 * @throws if the read fails.
 */
export async function getPropertyById(id: string): Promise<Property | null> {
  const doc = await getAdminDb().collection(COLLECTION).doc(id).get();
  if (!doc.exists) return null;

  const data = doc.data() as Record<string, unknown>;

  // Raw document first, normalised summary second: the summary's values win
  // for the fields it owns, so `id` is always the document ID and the shared
  // fields are the same shape here as they are in the list.
  //
  // `images` is resolved to the mirror the same way `coverImage` is, and for
  // the same reason — one URL per image reaches the browser, already pointing
  // at whichever source exists. `imagesStored` is index-for-index with
  // `images` by the mirror's own contract, so a per-index fallback is exact
  // rather than positional guesswork.
  const images = Array.isArray(data.images) ? data.images : [];
  const stored = Array.isArray(data.imagesStored) ? data.imagesStored : [];
  const resolvedImages = images.map((original, i) => str(stored[i]) || str(original));

  // Both stored fields are dropped once they have been folded in. Leaving
  // them would put a second copy of every image URL in the page payload —
  // 173 KB of `imagesStored` across the catalogue — for no reader: nothing
  // downstream consults them, and the resolution has already happened.
  const { imagesStored: _stored, coverImageStored: _cover, ...rest } = data;
  void _stored;
  void _cover;

  return { ...rest, ...toSummary(doc.id, data), images: resolvedImages } as Property;
}
