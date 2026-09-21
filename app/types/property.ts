/** Shared type definitions for property data. */

export interface Offer {
  name: string;       // e.g. "Hair dryer", "Free parking (1 space)"
  category: string;   // e.g. "Bathroom", "Kitchen and dining", "Parking"
  available: boolean;  // true = offered, false = shown as "Unavailable"
  icon?: string;       // SVG markup string for the amenity icon
}

export interface Review {
  reviewer: string;       // reviewer first name
  date: string;           // "March 2025"
  rating: number;         // individual star rating (4 or 5)
  text: string;           // review text
  avatar?: string;        // reviewer profile image URL
}

export interface PriceInfo {
  nightly: number;
  weekly: number;
  monthly: number;
  weekend: number;
  cleaningFee: number;
  minNights: number;
}

export interface AddressDetails {
  city: string;
  state: string;
  area: string;
  country: string;
}

/**
 * The slice of a property the homepage needs in the page payload.
 *
 * The 43 stored documents total 1.43 MB, and 1.05 MB of that is `offers` —
 * every amenity carries an inline SVG icon. `images`, `imagesStored`,
 * `reviews` and `description` account for most of the rest. None of it is
 * rendered until a visitor opens a property, so none of it belongs in the
 * HTML of a page that shows a list and a map.
 *
 * These are exactly the fields four consumers read:
 *   - the card    — name, coverImage, addressDetails, location, guests,
 *                   bedrooms, bathrooms, priceInfo.nightly, price
 *   - the map     — id, coordinates, price
 *   - the filters — name, location, addressDetails.city, guests, icalUrl
 *   - slug resolution — name, slug
 *
 * Everything else arrives with the full document when a property is opened.
 * See `getPropertySummaries` in lib/firebase/server-properties.ts.
 */
export interface PropertySummary {
  id: string;
  slug: string;
  name: string;
  location: string;
  coordinates: [number, number];
  price: number;
  currency: string;
  bedrooms: number;
  beds: number;
  bathrooms: number;
  guests: number;
  coverImage: string;
  type: string;
  propertyTypeTag: string;    // "Entire home", "Private room", "Guest suite"
  icalUrl?: string;
  priceInfo: PriceInfo;
  addressDetails: AddressDetails;
}

/** A complete stored property document. */
export interface Property extends PropertySummary {
  images?: string[];

  // External links
  airbnbUrl?: string;
  googleMapsUrl?: string;

  // Reviews
  reviews?: Review[];
  averageRating?: number;
  totalReviewCount?: number;

  // Airbnb-aligned fields
  highlights: string[];       // Top 2-3 standout badges, e.g. ["City View", "Free Parking", "Self check-in"]
  amenities: string[];        // Quick top-level amenity names for cards/badges
  offers: Offer[];            // Full "What this place offers" list

  description: string;
  details: {
    checkIn: string;
    checkOut: string;
  };
  terms: {
    smokingAllowed: boolean;
    petsAllowed: boolean;
    partyAllowed: boolean;
    childrenAllowed: boolean;
    cancellationPolicy: string;
    rules: string[];
  };
}
