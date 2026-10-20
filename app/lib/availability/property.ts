/**
 * The slice of a property document the availability module reads, built
 * from a `Property` as the admin pages load it. Client-safe.
 */

import { nightlyPrice } from '../price';
import type { Property } from '../../types/property';
import type { AvailabilityProperty } from './types';

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown, fallback = 0): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

/**
 * `internalName` is the name the admin shows (its cleaner-facing name, Kian's rulings of 2026-10-15, evening); absent,
 * the public title. `unlisted` (Kian's ruling K5 of 2026-10-19): the property is not on the public site, said on every
 * result as "Not on the site".
 */
export function toAvailabilityProperty(property: Property, internalName?: string, unlisted = false): AvailabilityProperty {
  const address = property.addressDetails ?? { city: '', area: '', state: '', country: '' };
  return {
    id: property.id,
    name: internalName ?? str(property.name),
    publicName: str(property.name),
    slug: str(property.slug),
    city: str(address.city),
    area: str(address.area),
    location: str(property.location),
    type: str(property.type),
    guests: num(property.guests),
    bedrooms: num(property.bedrooms),
    bathrooms: num(property.bathrooms),
    nightly: nightlyPrice(property),
    minNights: Math.max(1, Math.round(num(property.priceInfo?.minNights, 1)) || 1),
    cleaningFee: num(property.priceInfo?.cleaningFee),
    coverImage: str(property.coverImage),
    airbnbUrl: str(property.airbnbUrl),
    offerNames: (property.offers ?? []).filter((offer) => offer && offer.available !== false).map((offer) => str(offer.name)),
    unlisted,
  };
}

/** The slice as the server answers it (GET /api/admin/availability/properties), read strictly enough to refuse another shape. */
export function isAvailabilityProperty(value: unknown): value is AvailabilityProperty {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  const text = (v: unknown) => typeof v === 'string';
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  return text(p.id) && text(p.name) && text(p.publicName) && text(p.slug) && text(p.city) && text(p.area) && text(p.location) && text(p.type) && num(p.guests) && num(p.bedrooms) && num(p.bathrooms) && num(p.nightly) && num(p.minNights) && num(p.cleaningFee) && text(p.coverImage) && text(p.airbnbUrl) && Array.isArray(p.offerNames) && p.offerNames.every(text) && typeof p.unlisted === 'boolean';
}
