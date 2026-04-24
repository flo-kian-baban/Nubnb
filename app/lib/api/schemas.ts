/**
 * Zod schemas for Firestore document validation.
 *
 * These schemas are the single source of truth for property document shape.
 * Used by server-side API routes to reject malformed data before any
 * Firestore write operation.
 */

import { z } from 'zod';

// ─── Sub-schemas ───────────────────────────────────────────────

export const OfferSchema = z.object({
  name: z.string().min(1),
  category: z.string().min(1),
  available: z.boolean(),
  icon: z.string().optional(),
});

export const ReviewSchema = z.object({
  reviewer: z.string().min(1),
  date: z.string().min(1),
  rating: z.number().min(1).max(5),
  text: z.string().min(1),
  avatar: z.string().url().optional(),
});

export const PriceInfoSchema = z.object({
  nightly: z.number().nonnegative(),
  weekly: z.number().nonnegative(),
  monthly: z.number().nonnegative(),
  weekend: z.number().nonnegative(),
  cleaningFee: z.number().nonnegative(),
  minNights: z.number().int().positive(),
});

export const AddressDetailsSchema = z.object({
  city: z.string().min(1),
  state: z.string().min(1),
  area: z.string().min(1),
  country: z.string().min(1),
});

export const DetailsSchema = z.object({
  checkIn: z.string().min(1),
  checkOut: z.string().min(1),
});

export const TermsSchema = z.object({
  smokingAllowed: z.boolean(),
  petsAllowed: z.boolean(),
  partyAllowed: z.boolean(),
  childrenAllowed: z.boolean(),
  cancellationPolicy: z.string().min(1),
  rules: z.array(z.string().min(1)),
});

// ─── Full property schema (for creation) ───────────────────────

/**
 * Schema for creating a new property. `id` is excluded because
 * Firestore generates it. All required fields must be present.
 */
export const CreatePropertySchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1).max(200),
  location: z.string().min(1),
  coordinates: z.tuple([z.number(), z.number()]),
  price: z.number().nonnegative(),
  currency: z.string().length(3),
  bedrooms: z.number().int().nonnegative(),
  beds: z.number().int().nonnegative(),
  bathrooms: z.number().nonnegative(),
  guests: z.number().int().positive(),
  coverImage: z.string().url(),
  images: z.array(z.string().url()).optional(),
  type: z.string().min(1),
  icalUrl: z.string().url().optional(),

  // External links
  airbnbUrl: z.string().url().optional(),
  googleMapsUrl: z.string().url().optional(),

  // Reviews
  reviews: z.array(ReviewSchema).optional(),
  averageRating: z.number().min(0).max(5).optional(),
  totalReviewCount: z.number().int().nonnegative().optional(),

  // Airbnb-aligned fields
  propertyTypeTag: z.string().min(1),
  highlights: z.array(z.string().min(1)),
  amenities: z.array(z.string().min(1)),
  offers: z.array(OfferSchema),

  description: z.string().min(1),
  priceInfo: PriceInfoSchema,
  addressDetails: AddressDetailsSchema,
  details: DetailsSchema,
  terms: TermsSchema,
});

// ─── Partial schema (for updates) ─────────────────────────────

/**
 * Schema for updating a property. All fields are optional so partial
 * updates are valid, but each field that IS provided must pass validation.
 */
export const UpdatePropertySchema = CreatePropertySchema.partial();

// ─── Types derived from schemas ────────────────────────────────

export type CreatePropertyInput = z.infer<typeof CreatePropertySchema>;
export type UpdatePropertyInput = z.infer<typeof UpdatePropertySchema>;
