"use client";

import { Search } from "lucide-react";
import styles from "./TopFilters.module.css";

interface TopFiltersProps {
  searchQuery: string;
  setSearchQuery: (query: string) => void;
}

export function TopFilters({
  searchQuery,
  setSearchQuery,
}: TopFiltersProps) {
  return (
    <div className={styles.container}>
      {/* Search Bar */}
      <div className={styles.searchWrapper}>
        <Search className={styles.searchIcon} size={20} strokeWidth={2} />
        {/* A placeholder is not a label: it disappears the moment there is a
            value, and it is not reliably exposed as an accessible name. The
            visible text is the icon only, so the name is given explicitly. */}
        <input
          type="text"
          id="property-search"
          className={styles.searchInput}
          placeholder="Search by location or name..."
          aria-label="Search properties by location or name"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>
    </div>
  );
}

