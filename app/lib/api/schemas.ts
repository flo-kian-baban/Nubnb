/**
 * Zod schemas for Firestore document validation.
 *
 * These schemas are the single source of truth for property document shape.
 * Used by server-side API routes to reject malformed data before any
 * Firestore write operation.
 */

import { z } from 'zod';
import { REGULAR_CLEANER_FIELDS } from '../schedule/regular';
import { CLEANING_PRICE_FIELDS } from '../cleanings/prices';

// ─── Helper: URL-or-empty (for optional URL fields on updates) ──
const urlOrEmpty = z.union([z.string().url(), z.literal('')]);

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

/**
 * Reviews as they exist on stored documents.
 *
 * Every one of the 142 reviews in the catalogue has `avatar: ""`. The scraper
 * writes `avatar: avatar || ''` on every path, so an unresolved avatar is
 * stored as an empty string rather than omitted. `z.string().url()` rejects
 * "", and `.optional()` only permits `undefined` — so validating a real
 * document with the strict schema fails on 35 of the 43, on a field that is
 * empty everywhere and read by nothing.
 *
 * Updates therefore validate reviews with `urlOrEmpty`. Creation keeps the
 * strict rule, so new imports are not encouraged to write "" going forward.
 */
export const StoredReviewSchema = ReviewSchema.extend({
  avatar: urlOrEmpty.optional(),
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

// ─── Lenient schema (for updates) ─────────────────────────────

/**
 * Schema for updating a property. All fields are optional. Nested objects
 * are deeply partial so individual sub-fields can be sent. URL fields
 * accept empty strings (the form sends "" for unset URLs).
 */
export const UpdatePropertySchema = z.object({
  slug: z.string().optional(),
  name: z.string().max(200).optional(),
  location: z.string().optional(),
  coordinates: z.tuple([z.number(), z.number()]).optional(),
  price: z.number().nonnegative().optional(),
  currency: z.string().optional(),
  bedrooms: z.number().int().nonnegative().optional(),
  beds: z.number().int().nonnegative().optional(),
  bathrooms: z.number().nonnegative().optional(),
  guests: z.number().int().nonnegative().optional(),
  coverImage: urlOrEmpty.optional(),
  images: z.array(z.string()).optional(),
  type: z.string().optional(),
  icalUrl: urlOrEmpty.optional(),

  // External links — accept empty strings
  airbnbUrl: urlOrEmpty.optional(),
  googleMapsUrl: urlOrEmpty.optional(),

  // Reviews — StoredReviewSchema, not ReviewSchema: see its comment above.
  reviews: z.array(StoredReviewSchema).optional(),
  averageRating: z.number().min(0).max(5).optional(),
  totalReviewCount: z.number().int().nonnegative().optional(),

  // Airbnb-aligned fields
  propertyTypeTag: z.string().optional(),
  highlights: z.array(z.string()).optional(),
  amenities: z.array(z.string()).optional(),
  offers: z.array(OfferSchema).optional(),

  description: z.string().optional(),
  priceInfo: PriceInfoSchema.partial().optional(),
  addressDetails: AddressDetailsSchema.partial().optional(),
  details: DetailsSchema.partial().optional(),
  terms: TermsSchema.partial().optional(),
})
  .passthrough()
  // The name cleaners see lives in its own server-only collection (dispatch
  // 21, Kian's ruling): it is never written onto the world-readable property
  // document, so a body that carries it is refused rather than passed through.
  .refine((body) => !('cleanerName' in body), {
    path: ['cleanerName'],
    message: 'Not a property field: the name cleaners see is set through /api/admin/properties/[id]/cleaner-name',
  })
  // The property's Airbnb title lives in its own server-only record (dispatch 37C, Kian's ruling of 2026-10-13: the
  // property save never writes it), so a body carrying it, under any of the names it might be sent as, is refused.
  .superRefine((body, ctx) => {
    for (const field of AIRBNB_TITLE_FIELDS) {
      if (field in body) ctx.addIssue({ code: 'custom', path: [field], message: 'Not a property field: the Airbnb title is set on the edit page\'s Airbnb title section, through /api/admin/properties/[id]/airbnb-title' });
    }
  })
  // The regular cleaner lives in its own server-only record (Kian's ruling R5 of 2026-10-19: never on the public
  // property document), so a body carrying it, under any of the names it might be sent as, is refused.
  .superRefine((body, ctx) => {
    for (const field of REGULAR_CLEANER_FIELDS) {
      if (field in body) ctx.addIssue({ code: 'custom', path: [field], message: 'Not a property field: the regular cleaner is set on the edit page\'s Cleaners section or on the Schedule, through /api/admin/properties/[id]/regular-cleaner' });
    }
  })
  // Cleaning prices live in their own server-only record (Kian's ruling of 2026-10-19: never on the public property
  // document), so a body carrying one, under any of the names it might be sent as, is refused.
  .superRefine((body, ctx) => {
    for (const field of CLEANING_PRICE_FIELDS) {
      if (field in body) ctx.addIssue({ code: 'custom', path: [field], message: 'Not a property field: cleaning prices are set on the Report For sheet or the edit page\'s Cleaners section, through /api/admin/properties/[id]/cleaning-prices' });
    }
  });

/** Names an Airbnb title could be sent under on a property body: none is ever a property field (dispatch 37C). */
export const AIRBNB_TITLE_FIELDS = ['airbnbTitle', 'airbnbTitles', 'listingTitle', 'titleLink', 'titleLinks', 'activeTitle'] as const;

// ─── Types derived from schemas ────────────────────────────────

export type CreatePropertyInput = z.infer<typeof CreatePropertySchema>;
export type UpdatePropertyInput = z.infer<typeof UpdatePropertySchema>;

