"use client";

/**
 * Choose the property: a search box, then one big row per property. The ones
 * this cleaner logged against come first, most recent first; then the rest,
 * A to Z. Search matches the name or the city, ignoring capitals and accents.
 */

import { useMemo, useState } from "react";
import { Check, ChevronRight, Clock, Search, X } from "lucide-react";
import type { CleanerProperty } from "@/app/lib/cleaners/model";
import { matchRank } from "@/app/lib/cleaners/text";
import styles from "./cleaner.module.css";

interface PropertyScreenProps {
  cleanerName: string | null;
  properties: CleanerProperty[];
  recentPropertyIds: string[];
  selectedId: string | null;
  onChoose: (property: CleanerProperty) => void;
  onMyReceipts: () => void;
  onSignOut: () => void;
}

/** How well a property matches the search: its name first, then its city. */
function rankOf(property: CleanerProperty, query: string): number | null {
  const byName = property.name ? matchRank(property.name, query) : null;
  if (byName !== null) return byName;
  const byCity = property.city ? matchRank(property.city, query) : null;
  return byCity === null ? null : 3;
}

export function PropertyScreen({
  cleanerName,
  properties,
  recentPropertyIds,
  selectedId,
  onChoose,
  onMyReceipts,
  onSignOut,
}: PropertyScreenProps) {
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

  const firstName = cleanerName?.trim().split(/\s+/)[0];

  const row = (property: CleanerProperty, isRecent: boolean) => (
    <li key={property.id}>
      <button
        type="button"
        className={`${styles.propertyRow} ${property.id === selectedId ? styles.propertyRowSelected : ""}`}
        onClick={() => onChoose(property)}
      >
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
    <main className={styles.screen}>
      <header className={styles.topBar}>
        <p className={styles.greeting}>{firstName ? `Hi ${firstName}` : "Hi"}</p>
        <div className={styles.topBarActions}>
          <button type="button" className={styles.textButton} onClick={onMyReceipts}>
            My receipts
          </button>
          <button type="button" className={styles.textButton} onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </header>

      <h1 className={styles.title}>Which property?</h1>

      <div className={styles.searchField}>
        <Search className={styles.searchIcon} aria-hidden />
        <input
          type="search"
          className={styles.searchInput}
          placeholder="Search"
          aria-label="Search properties"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="search"
        />
        {query && (
          <button
            type="button"
            className={styles.searchClear}
            aria-label="Clear search"
            onClick={() => setQuery("")}
          >
            <X aria-hidden />
          </button>
        )}
      </div>

      {recent.length === 0 && others.length === 0 ? (
        <div className={styles.emptyState}>
          <p>{properties.length === 0 ? "No properties yet." : "No property found."}</p>
          {query && (
            <button type="button" className={styles.secondary} onClick={() => setQuery("")}>
              Clear search
            </button>
          )}
        </div>
      ) : (
        <>
          {recent.length > 0 && (
            <section aria-labelledby="recent-heading">
              <h2 id="recent-heading" className={styles.sectionLabel}>
                Recent
              </h2>
              <ul className={styles.propertyList}>{recent.map((property) => row(property, true))}</ul>
            </section>
          )}
          {others.length > 0 && (
            <section aria-labelledby={recent.length > 0 ? "all-heading" : undefined}>
              {recent.length > 0 && (
                <h2 id="all-heading" className={styles.sectionLabel}>
                  All properties
                </h2>
              )}
              <ul className={styles.propertyList}>{others.map((property) => row(property, false))}</ul>
            </section>
          )}
        </>
      )}
    </main>
  );
}
