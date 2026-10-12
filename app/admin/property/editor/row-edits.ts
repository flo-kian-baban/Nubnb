"use client";

/**
 * Rows edited in place (dispatch 29, moved here from the form): one offer,
 * highlight or house rule at a time, with the rules in offers.ts deciding
 * what a change to an offer does to the list and the stars. The editor owns
 * this state because Save has to apply or refuse an open edit before it
 * writes anything.
 */

import { useCallback, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Offer, Property } from "@/app/types/property";
import { NOT_INCLUDED, addOffer as addOfferRule, editOffer, excludeOffer, includeOffer, offerCategoryOptions, offerNameTaken, removeOffer, type OffersAndStars } from "../../components/offers";
import { HIGHLIGHTS_MAX, STARS_MAX } from "./model";
import type { RowEdit, RowEdits } from "./shared";

type SetProperty = (update: (prev: Partial<Property>) => Partial<Property>) => void;

/** `data` with the row edit applied, or what is wrong with the edit. */
function applyRowEdit(data: Partial<Property>, edit: RowEdit): { data: Partial<Property> } | { problem: string } {
  if (edit.kind === "offer") {
    const name = edit.name.trim();
    if (!name) return { problem: "Give it a name." };
    const offers = data.offers || [];
    if (offerNameTaken(offers, name, edit.target)) return { problem: `"${name}" is already in the list.` };
    // An item in "Not included" keeps that category unless it is being included: it follows availability.
    const offered = edit.include || edit.target.category !== NOT_INCLUDED;
    if (offered && (!edit.category || edit.category === NOT_INCLUDED)) return { problem: "Pick a category." };
    const before: OffersAndStars = { offers, amenities: data.amenities || [] };
    const after = editOffer(before, edit.target, {
      name,
      category: offered ? edit.category : edit.target.category,
      available: edit.include ? true : edit.target.available,
    });
    if (after === before) return { data };
    return { data: { ...data, offers: after.offers, ...(after.amenities !== before.amenities ? { amenities: after.amenities } : {}) } };
  }
  const value = edit.value.trim();
  if (!value) return { problem: "Empty — delete it instead." };
  if (edit.kind === "highlight") {
    const highlights = data.highlights || [];
    if (highlights[edit.index] === value) return { data };
    return { data: { ...data, highlights: highlights.map((h, i) => (i === edit.index ? value : h)) } };
  }
  const rules = data.terms?.rules || [];
  if (rules[edit.index] === value) return { data };
  return { data: { ...data, terms: { ...(data.terms as Property["terms"]), rules: rules.map((r, i) => (i === edit.index ? value : r)) } } };
}

export interface RowEditsForSave extends RowEdits {
  /** Apply the open edit to `property` for a save: the data to send, or the problem; the row state is updated either way. */
  commitForSave: (property: Partial<Property>) => { data: Partial<Property> } | { problem: string };
}

export function useRowEdits(property: Partial<Property>, stored: Property | null, setProperty: SetProperty): RowEditsForSave {
  const [rowEdit, setRowEdit] = useState<RowEdit | null>(null);
  const [rowEditError, setRowEditError] = useState<string | null>(null);
  /** The category an item had before it was unticked, by name, for this editing session only. Never saved. */
  const formerCategories = useRef(new Map<string, string>());

  const offersNow = property.offers;
  const currentOffers = useMemo(() => offersNow || [], [offersNow]);
  const currentHighlights = property.highlights || [];
  const currentRules = property.terms?.rules || [];

  /** The property's own stored categories, then the standard ones — never "Not included" (Kian's ruling). */
  const categoryOptions = useMemo(() => offerCategoryOptions(stored?.offers, currentOffers), [stored, currentOffers]);

  /** A renamed item keeps the category it is remembered by. */
  const carryFormerCategory = (edit: RowEdit) => {
    if (edit.kind !== "offer") return;
    const former = formerCategories.current.get(edit.target.name);
    if (former === undefined || edit.name.trim() === edit.target.name) return;
    formerCategories.current.delete(edit.target.name);
    if (!edit.include) formerCategories.current.set(edit.name.trim(), former);
  };

  const cancel = useCallback(() => {
    setRowEdit(null);
    setRowEditError(null);
  }, []);

  const change = useCallback((edit: RowEdit) => {
    setRowEdit(edit);
    setRowEditError(null);
  }, []);

  const commitForSave = (data: Partial<Property>): { data: Partial<Property> } | { problem: string } => {
    if (!rowEdit) return { data };
    const result = applyRowEdit(data, rowEdit);
    if ("problem" in result) {
      setRowEditError(result.problem);
      return result;
    }
    carryFormerCategory(rowEdit);
    setRowEdit(null);
    setRowEditError(null);
    return result;
  };

  const commit = (): boolean => {
    if (!rowEdit) return true;
    const result = commitForSave(property);
    if ("problem" in result) return false;
    if (result.data !== property) setProperty(() => result.data);
    return true;
  };

  const startOfferEdit = (offer: Offer, include = false) => {
    if (!commit()) return;
    setRowEdit({ kind: "offer", target: offer, name: offer.name, category: include ? "" : offer.category, include });
  };

  const startListEdit = (kind: "highlight" | "rule", index: number) => {
    if (!commit()) return;
    setRowEdit({ kind, index, value: (kind === "highlight" ? currentHighlights : currentRules)[index] ?? "" });
  };

  /** A highlight or rule above the one being edited went: the edit follows its row. */
  const shiftAfterRemoval = (kind: "highlight" | "rule", removed: number) => {
    if (rowEdit?.kind !== kind) return;
    if (rowEdit.index === removed) cancel();
    else if (rowEdit.index > removed) setRowEdit({ ...rowEdit, index: rowEdit.index - 1 });
  };

  const keys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  };

  // ── Highlights and rules ──
  const addHighlight = (text: string): boolean => {
    const value = text.trim();
    if (!value || currentHighlights.length >= HIGHLIGHTS_MAX) return false;
    setProperty((prev) => ({ ...prev, highlights: [...(prev.highlights || []), value] }));
    return true;
  };
  const removeHighlight = (index: number) => {
    shiftAfterRemoval("highlight", index);
    setProperty((prev) => ({ ...prev, highlights: (prev.highlights || []).filter((_, i) => i !== index) }));
  };
  const addRule = (text: string): boolean => {
    const value = text.trim();
    if (!value) return false;
    setProperty((prev) => ({ ...prev, terms: { ...(prev.terms as Property["terms"]), rules: [...(prev.terms?.rules || []), value] } }));
    return true;
  };
  const removeRule = (index: number) => {
    shiftAfterRemoval("rule", index);
    setProperty((prev) => ({ ...prev, terms: { ...(prev.terms as Property["terms"]), rules: (prev.terms?.rules || []).filter((_, i) => i !== index) } }));
  };

  // ── Offers: offers and stars change together, through offers.ts ──
  const applyOffers = (update: (state: OffersAndStars) => OffersAndStars) =>
    setProperty((prev) => {
      const before: OffersAndStars = { offers: prev.offers || [], amenities: prev.amenities || [] };
      const after = update(before);
      if (after === before) return prev;
      return { ...prev, offers: after.offers, ...(after.amenities !== before.amenities ? { amenities: after.amenities } : {}) };
    });

  const addOffer = (rawName: string, category: string): string | null => {
    const name = rawName.trim();
    if (!name) return "Give it a name.";
    if (!category) return "Pick a category.";
    if (offerNameTaken(currentOffers, name)) return `"${name}" is already in the list.`;
    applyOffers((state) => addOfferRule(state, name, category));
    return null;
  };

  const deleteOffer = (offer: Offer) => {
    if (rowEdit?.kind === "offer" && rowEdit.target === offer) cancel();
    formerCategories.current.delete(offer.name);
    applyOffers((state) => removeOffer(state, offer));
  };

  /** Unticking moves an item to "Not included"; ticking moves it back (Kian's ruling of 2026-10-10). */
  const toggleOfferAvailable = (offer: Offer) => {
    if (offer.available) {
      if (offer.category !== NOT_INCLUDED) formerCategories.current.set(offer.name, offer.category);
      applyOffers((state) => excludeOffer(state, offer));
      return;
    }
    const former = formerCategories.current.get(offer.name);
    if (offer.category !== NOT_INCLUDED || former) {
      formerCategories.current.delete(offer.name);
      applyOffers((state) => includeOffer(state, offer, former));
      return;
    }
    // Where it goes back to is not known (it was imported as not included): the admin picks it.
    startOfferEdit(offer, true);
  };

  const toggleOfferStar = (offerName: string) => {
    setProperty((prev) => {
      const current: string[] = prev.amenities || [];
      if (current.includes(offerName)) return { ...prev, amenities: current.filter((a) => a !== offerName) };
      if (current.length < STARS_MAX) return { ...prev, amenities: [...current, offerName] };
      return prev;
    });
  };

  const updateOfferIcon = (offer: Offer, svg: string) => {
    const replaced: Offer = { ...offer, icon: svg };
    setProperty((prev) => {
      const offers = prev.offers || [];
      const index = offers.indexOf(offer);
      if (index === -1) return prev;
      const next = offers.slice();
      next[index] = replaced;
      return { ...prev, offers: next };
    });
    setRowEdit((edit) => (edit?.kind === "offer" && edit.target === offer ? { ...edit, target: replaced } : edit));
  };

  return {
    rowEdit,
    rowEditError,
    change,
    commit,
    commitForSave,
    cancel,
    startOfferEdit,
    startListEdit,
    keys,
    addHighlight,
    removeHighlight,
    addRule,
    removeRule,
    addOffer,
    deleteOffer,
    toggleOfferAvailable,
    toggleOfferStar,
    updateOfferIcon,
    categoryOptions,
  };
}
