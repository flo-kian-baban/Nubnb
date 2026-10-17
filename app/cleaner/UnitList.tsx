"use client";

/**
 * Every unit, searchable, the cleaner's recent ones first (Kian's rulings of 2026-10-17): on the home screen under
 * "All units", where a tap starts a receipt for that unit (a handyman's work), and behind Change on a receipt, where it
 * chooses the unit. One row per unit: its cover photo, rounded as the public site's cards, then its name for cleaners
 * and its city. Search matches the name or the city, ignoring capitals and accents. The ones this cleaner logged
 * against come first, most recent first; then the rest, A to Z.
 *
 * Photos are the stored 200-pixel copies (UnitPhoto), fetched only once their row comes within 400 pixels of the
 * screen — the public site's own gate (useNearViewport), as the browser's lazy loading reaches far past the screen —
 * so a screen costs only the photos on it and just below. A unit with no stored photo, or one that fails to load, gets
 * a plain tile with a house. The full image is never asked for.
 */

import { useMemo, useState } from "react";
import { Check, ChevronRight, Clock, House, Search, X } from "lucide-react";
import type { CleanerProperty } from "@/app/lib/cleaners/model";
import { matchRank } from "@/app/lib/cleaners/text";
import { useNearViewport } from "@/app/lib/useNearViewport";
import styles from "./cleaner.module.css";

/** How far ahead of the screen a photo is asked for: the public cards' figure (PropertyCard.tsx). */
const PHOTO_MARGIN = "400px";

interface UnitListProps {
  properties: CleanerProperty[];
  recentPropertyIds: string[];
  /** The unit already chosen, ticked (behind Change). */
  selectedId?: string | null;
  onChoose: (property: CleanerProperty) => void;
  /** What the rest are called under the recent ones: "All properties" behind Change, "Other units" on the home. */
  restLabel: string;
}

/** How well a unit matches the search: its name first, then its city. */
function rankOf(property: CleanerProperty, query: string): number | null {
  const byName = property.name ? matchRank(property.name, query) : null;
  if (byName !== null) return byName;
  const byCity = property.city ? matchRank(property.city, query) : null;
  return byCity === null ? null : 3;
}

/**
 * A unit's cover, a stored small copy, in a rounded box that keeps its size whatever happens: empty until the box
 * nears the screen, then the photo; a house when there is no stored photo or it cannot be loaded.
 */
export function UnitPhoto({ src, className }: { src: string | null; className: string }) {
  const [failed, setFailed] = useState(false);
  const [ref, near] = useNearViewport<HTMLSpanElement>(PHOTO_MARGIN);
  const none = !src || failed;
  return (
    <span ref={ref} className={`${className} ${none ? styles.photoNone : ""}`} aria-hidden>
      {none ? (
        <House />
      ) : near ? (
        // A stored copy at the size shown: nothing for next/image to resize.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" className={styles.photoImg} decoding="async" onError={() => setFailed(true)} />
      ) : null}
    </span>
  );
}

export function UnitList({ properties, recentPropertyIds, selectedId = null, onChoose, restLabel }: UnitListProps) {
  const [query, setQuery] = useState("");

  const { recent, others } = useMemo(() => {
    const recency = new Map(recentPropertyIds.map((id, i) => [id, i]));
    const found = properties
      .map((property) => ({ property, rank: rankOf(property, query) }))
      .filter((match): match is { property: CleanerProperty; rank: number } => match.rank !== null);

    // `properties` arrives A to Z, and sort is stable: equal ranks keep that order.
    const recentMatches = found
      .filter(({ property }) => recency.has(property.id))
      .sort((a, b) => recency.get(a.property.id)! - recency.get(b.property.id)!);
    const otherMatches = found
      .filter(({ property }) => !recency.has(property.id))
      .sort((a, b) => a.rank - b.rank);
    return {
      recent: recentMatches.map(({ property }) => property),
      others: otherMatches.map(({ property }) => property),
    };
  }, [properties, recentPropertyIds, query]);

  const row = (property: CleanerProperty, isRecent: boolean) => (
    <li key={property.id}>
      <button
        type="button"
        className={`${styles.unitRow} ${property.id === selectedId ? styles.unitRowSelected : ""}`}
        onClick={() => onChoose(property)}
      >
        <UnitPhoto src={property.photo?.thumb ?? null} className={styles.unitPhoto} />
        <span className={styles.propertyText}>
          <span className={styles.propertyName}>{property.name ?? "Unnamed property"}</span>
          {property.city && <span className={styles.propertyCity}>{property.city}</span>}
        </span>
        {property.id === selectedId ? (
          <Check className={styles.rowIcon} aria-label="Chosen" />
        ) : isRecent ? (
          <Clock className={styles.rowIconMuted} aria-label="Recent" />
        ) : (
          <ChevronRight className={styles.rowIconMuted} aria-hidden />
        )}
      </button>
    </li>
  );

  return (
    <>
      <div className={styles.searchField}>
        <Search className={styles.searchIcon} aria-hidden />
        <input
          type="search"
          className={styles.searchInput}
          placeholder="Search"
          aria-label="Search units"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="search"
        />
        {query && (
          <button type="button" className={styles.searchClear} aria-label="Clear search" onClick={() => setQuery("")}>
            <X aria-hidden />
          </button>
        )}
      </div>

      {recent.length === 0 && others.length === 0 ? (
        <div className={styles.emptyState}>
          <p>{properties.length === 0 ? "No units yet." : "No unit found."}</p>
          {query && (
            <button type="button" className={styles.secondary} onClick={() => setQuery("")}>
              Clear search
            </button>
          )}
        </div>
      ) : (
        <>
          {recent.length > 0 && (
            <div>
              <h3 className={styles.listLabel}>Recent</h3>
              <ul className={styles.propertyList}>{recent.map((property) => row(property, true))}</ul>
            </div>
          )}
          {others.length > 0 && (
            <div>
              {recent.length > 0 && <h3 className={styles.listLabel}>{restLabel}</h3>}
              <ul className={styles.propertyList}>{others.map((property) => row(property, false))}</ul>
            </div>
          )}
        </>
      )}
    </>
  );
}
