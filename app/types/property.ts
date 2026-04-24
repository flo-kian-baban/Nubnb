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

export interface Property {
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
  images?: string[];
  type: string;
  icalUrl?: string;

  // External links
  airbnbUrl?: string;
  googleMapsUrl?: string;

  // Reviews
  reviews?: Review[];
  averageRating?: number;
  totalReviewCount?: number;

  // Airbnb-aligned fields
  propertyTypeTag: string;    // "Entire home", "Private room", "Guest suite"
  highlights: string[];       // Top 2-3 standout badges, e.g. ["City View", "Free Parking", "Self check-in"]
  amenities: string[];        // Quick top-level amenity names for cards/badges
  offers: Offer[];            // Full "What this place offers" list

  description: string;
  priceInfo: {
    nightly: number;
    weekly: number;
    monthly: number;
    weekend: number;
    cleaningFee: number;
    minNights: number;
  };
  addressDetails: {
    city: string;
    state: string;
    area: string;
    country: string;
  };
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
