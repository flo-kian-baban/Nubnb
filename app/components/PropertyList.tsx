import { useEffect } from "react";
import { PropertySummary } from "@/app/types/property";
import { PropertyCard } from "./PropertyCard";
import styles from "./PropertyList.module.css";
import { SearchX, Home } from "lucide-react";

/**
 * How many cards get their image preloaded rather than lazy-loaded. Two is
 * what fits above the fold on a phone, and the first of them is the page's
 * LCP element.
 */
const PRIORITY_CARDS = 2;

interface PropertyListProps {
  /** The properties left after filtering. */
  properties: PropertySummary[];
  /**
   * True when the catalogue itself holds nothing — not when filters have
   * excluded everything. The two say very different things to a visitor and
   * used to share one message.
   *
   * A third state, "the data could not be loaded", never reaches this
   * component: the server read throws rather than returning an empty list, so
   * a failure renders app/error.tsx with a retry instead of an empty list.
   * That is what keeps "No properties found" from ever standing in for an
   * outage.
   */
  catalogueIsEmpty: boolean;
  onClearFilters: () => void;
  hoveredId: string | null;
  selectedId: string | null;
  onHover: (id: string | null) => void;
  onSelect: (id: string | null) => void;
  /**
   * False while the whole list sits off-screen behind an open detail panel.
   * See `showImage` on PropertyCard for why lazy-loading is not enough.
   */
  showImages?: boolean;
}

export function PropertyList({
  properties,
  catalogueIsEmpty,
  onClearFilters,
  hoveredId,
  selectedId,
  onHover,
  onSelect,
  showImages = true,
}: PropertyListProps) {

  // Smoothly scroll the list to the selected property card when it changes
  useEffect(() => {
    if (selectedId) {
      const element = document.getElementById(`property-card-${selectedId}`);
      if (element) {
        element.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
  }, [selectedId]);

  if (properties.length === 0) {
    // ── The catalogue is genuinely empty ──
    if (catalogueIsEmpty) {
      return (
        <div className={styles.emptyState}>
          <Home size={32} opacity={0.5} />
          <div>
            <h3>No listings yet</h3>
            <p>We&apos;re still adding properties to this collection. Please check back soon.</p>
          </div>
        </div>
      );
    }

    // ── Filters excluded everything ──
    // The only case in which "adjusting your search" is useful advice, and
    // therefore the only case that offers it.
    return (
      <div className={styles.emptyState}>
        <SearchX size={32} opacity={0.5} />
        <div>
          <h3>No properties match your search</h3>
          <p>Try adjusting your search or filters to explore more locations.</p>
          <button type="button" className={styles.clearFiltersBtn} onClick={onClearFilters}>
            Clear all filters
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`${styles.list} ${selectedId ? styles.hasSelection : ""}`}>
      {properties.map((property, index) => (
        <div
          key={property.id}
          id={`property-card-${property.id}`}
          className={selectedId === property.id ? styles.selectedCard : ""}
        >
          <PropertyCard
            property={property}
            isHovered={hoveredId === property.id}
            isSelected={selectedId === property.id}
            onHover={() => onHover(property.id)}
            onLeave={() => onHover(null)}
            onClick={() => onSelect(property.id)}
            /* Only the cards that are actually above the fold. Preloading the
               whole list would put 43 images in front of everything else.
               A deferred list preloads nothing: there is no point putting an
               off-screen image at the front of the queue. */
            priority={showImages && index < PRIORITY_CARDS}
            showImage={showImages}
          />
        </div>
      ))}
    </div>
  );
}
