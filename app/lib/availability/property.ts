/**
 * The slice of a property document the availability module reads, built
 * from a `Property` as the admin pages load it. Client-safe.
 */

import { nightlyPrice } from '../price';
import type { Property } from '../../types/property';
import type { AvailabilityProperty } from './types';

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown, fallback = 0): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

export function toAvailabilityProperty(property: Property): AvailabilityProperty {
  const address = property.addressDetails ?? { city: '', area: '', state: '', country: '' };
  return {
    id: property.id,
    name: str(property.name),
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
  };
}
