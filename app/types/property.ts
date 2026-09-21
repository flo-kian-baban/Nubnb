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
  /**
   * `weekly` and `monthly` are STORED BUT DELIBERATELY UNUSED. Do not wire
   * them into a quote without re-establishing what they mean first.
   *
   * The seed data this schema came from (app/data/properties.ts) reads
   * `nightly 3500, weekly 3200, monthly 3000, weekend 3800` on every entry —
   * i.e. discounted per-night rates. The live values do not behave that way:
   * against the nightly rate they run 2x-25x, so read as per-night rates they
   * imply discounts of -100% to -2400%. Read instead as totals for the
   * period, the implied discount ranges from 0% (3BR Ideal Location: weekly
   * 1400 = 7 x 200 exactly) to 73% (Cozy 3BR Yonge & Finch: monthly 4000 on a
   * 500 nightly), and one property prices a month at twice its week
   * (Ajax: weekly 2000, monthly 4000). Neither reading is coherent.
   *
   * `weekend` in this same object IS a per-night rate — 16 of 17 stored
   * values sit at 1.25x-2.50x nightly, a weekend premium — so the four fields
   * do not even share a unit.
   *
   * Set on 5 and 7 of 43 properties respectively, hand-entered (the Airbnb
   * scraper never writes them) through a form that labels them bare "Weekly
   * Price"/"Monthly Price" and marks them `required`, which pressures an
   * operator into typing a number whether or not they have one.
   *
   * Guessing is expensive: a 30-night stay at Cozy 3BR quotes $15,200 as it
   * stands, $4,200 if `monthly` is a total, or $120,200 if it is per-night.
   * Ruled on 2026-09-21: leave them out of the calculation until the fields
   * have a defined meaning and the values have been re-entered against it.
   */
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
