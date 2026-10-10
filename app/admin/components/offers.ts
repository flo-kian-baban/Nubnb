/**
 * "What this place offers" — the rules the admin form edits offers by
 * (dispatch 29). Pure functions over the stored shape: nothing here reads or
 * writes Firestore, and nothing reorders, renames or recategorises an offer
 * unless the admin asked for exactly that.
 *
 * Kian's rulings of 2026-10-10 (CLAUDE.md, "Property form"):
 *  - The editor lists the property's own stored categories plus the standard
 *    ones. "Home safety" replaces "Safety" in the standard list.
 *  - "Not included" is not picked; it follows availability. Unticking an item
 *    moves it there; ticking moves it back.
 *  - Counts such as parking spaces stay in the item's name.
 *
 * Stars (`amenities`) name their offer exactly, so they follow it here: a
 * rename carries the star; a delete drops it, and so does unticking (Kian,
 * 2026-10-10): a top amenity is something the place offers.
 */

import type { Offer } from "@/app/types/property";

/** Where every offer that is not offered sits, as Airbnb lists it. Never picked: it follows availability. */
export const NOT_INCLUDED = "Not included";

/** The standard categories: Airbnb's own headings, "Home safety" in place of the form's old "Safety". */
export const STANDARD_OFFER_CATEGORIES: readonly string[] = [
  "Scenic views", "Bathroom", "Bedroom and laundry", "Entertainment",
  "Heating and cooling", "Kitchen and dining", "Parking and facilities",
  "Internet and office", "Location features", "Outdoor", "Services", "Home safety",
];

/** An offer list and the stars that point into it, changed together. */
export interface OffersAndStars {
  offers: Offer[];
  amenities: string[];
}

/**
 * The categories an admin can pick: the property's own, as stored and in the
 * order they first appear, then each standard one it does not use yet.
 * "Not included" is never among them.
 */
export function offerCategoryOptions(...lists: (readonly Offer[] | undefined)[]): string[] {
  const out: string[] = [];
  for (const list of lists) {
    for (const offer of list ?? []) {
      if (offer.category && offer.category !== NOT_INCLUDED && !out.includes(offer.category)) out.push(offer.category);
    }
  }
  for (const category of STANDARD_OFFER_CATEGORIES) if (!out.includes(category)) out.push(category);
  return out;
}

/** Two names for the same item: surrounding spaces and letter case do not count. */
export function sameOfferName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Whether another offer already has this name. `except` is the offer being renamed. */
export function offerNameTaken(offers: readonly Offer[], name: string, except?: Offer): boolean {
  return offers.some((offer) => offer !== except && sameOfferName(offer.name, name));
}

/**
 * `offers` with `offer` added at the end of its category, so groups keep the
 * order they show in. A category the property does not have yet goes before
 * "Not included", which stays last, as Airbnb lists it.
 */
export function placeInCategory(offers: readonly Offer[], offer: Offer): Offer[] {
  let at = -1;
  for (let i = offers.length - 1; i >= 0; i--) {
    if (offers[i].category === offer.category) {
      at = i + 1;
      break;
    }
  }
  if (at === -1) {
    const notIncluded = offers.findIndex((o) => o.category === NOT_INCLUDED);
    at = offer.category === NOT_INCLUDED || notIncluded === -1 ? offers.length : notIncluded;
  }
  return [...offers.slice(0, at), offer, ...offers.slice(at)];
}

/** A new item, offered, at the end of its category. Stars are untouched. */
export function addOffer(state: OffersAndStars, name: string, category: string): OffersAndStars {
  return { offers: placeInCategory(state.offers, { name, category, available: true }), amenities: state.amenities };
}

/**
 * Change one offer's name, category or availability, keeping everything else
 * it carries — its icon above all.
 *
 * Same category: it stays exactly where it is. Another category, including
 * the move to or from "Not included": it goes to the end of that category.
 * A rename carries its star.
 *
 * Returns `state` itself when nothing changes, so an unchanged offer is never
 * rewritten.
 */
export function editOffer(
  state: OffersAndStars,
  target: Offer,
  change: { name: string; category: string; available: boolean },
): OffersAndStars {
  const index = state.offers.indexOf(target);
  if (index === -1) return state;
  if (change.name === target.name && change.category === target.category && change.available === target.available) return state;

  // Spread first, so the stored key order is kept and an absent `icon` stays absent.
  const edited: Offer = { ...target, name: change.name, category: change.category, available: change.available };
  let offers: Offer[];
  if (change.category === target.category) {
    offers = state.offers.slice();
    offers[index] = edited;
  } else {
    offers = placeInCategory(state.offers.filter((_, i) => i !== index), edited);
  }
  const amenities = change.name === target.name ? state.amenities : state.amenities.map((a) => (a === target.name ? change.name : a));
  return { offers, amenities };
}

/**
 * Untick: not offered, so it moves to "Not included" (Kian's ruling) and its
 * star is dropped, as a delete drops it — unless another item still has the
 * name. Ticking it back does not restore the star.
 */
export function excludeOffer(state: OffersAndStars, target: Offer): OffersAndStars {
  const moved = editOffer(state, target, { name: target.name, category: NOT_INCLUDED, available: false });
  if (moved === state || !moved.amenities.includes(target.name)) return moved;
  const stillOffered = moved.offers.some((offer) => offer.available && offer.name === target.name);
  return stillOffered ? moved : { offers: moved.offers, amenities: moved.amenities.filter((a) => a !== target.name) };
}

/**
 * Tick: offered again. An item in "Not included" goes back to `category`;
 * one stored elsewhere (no such item is stored today) is ticked where it is.
 * Without a category for an item in "Not included", nothing changes: the
 * caller asks the admin where it goes.
 */
export function includeOffer(state: OffersAndStars, target: Offer, category?: string): OffersAndStars {
  if (target.category !== NOT_INCLUDED) return editOffer(state, target, { name: target.name, category: target.category, available: true });
  if (!category || category === NOT_INCLUDED) return state;
  return editOffer(state, target, { name: target.name, category, available: true });
}

/** Delete an item. Its star goes with it, unless another item still has the name. */
export function removeOffer(state: OffersAndStars, target: Offer): OffersAndStars {
  const offers = state.offers.filter((offer) => offer !== target);
  if (offers.length === state.offers.length) return state;
  const stillNamed = offers.some((offer) => offer.name === target.name);
  return { offers, amenities: stillNamed ? state.amenities : state.amenities.filter((a) => a !== target.name) };
}
