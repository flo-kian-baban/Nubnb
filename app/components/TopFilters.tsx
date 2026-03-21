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
        <input
          type="text"
          className={styles.searchInput}
          placeholder="Search by location or name..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>
    </div>
  );
}
