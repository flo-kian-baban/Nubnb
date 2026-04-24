"use client";
import { useState, useRef, useEffect, useMemo } from "react";
import DOMPurify from "dompurify";
import { AMENITY_ICONS, findBestIcons, getIconCategories, AmenityIcon } from "../../data/amenityIcons";
import styles from "./IconPicker.module.css";

interface IconPickerProps {
  /** The current SVG markup (or empty string) */
  currentIcon: string;
  /** The amenity name — used for auto-suggestion on open */
  amenityName: string;
  /** Called with the selected SVG string */
  onSelect: (svg: string) => void;
}

export function IconPicker({ currentIcon, amenityName, onSelect }: IconPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const categories = useMemo(() => getIconCategories(), []);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isOpen]);

  // Auto-suggest on open
  useEffect(() => {
    if (isOpen) {
      setSearch(amenityName);
      setActiveCategory(null);
      setTimeout(() => searchRef.current?.select(), 50);
    }
  }, [isOpen, amenityName]);

  // Compute displayed icons
  const displayedIcons = useMemo(() => {
    if (search.trim()) {
      return findBestIcons(search, 60);
    }
    if (activeCategory) {
      return AMENITY_ICONS.filter(i => i.category === activeCategory);
    }
    return AMENITY_ICONS;
  }, [search, activeCategory]);

  // Group by category for display
  const grouped = useMemo(() => {
    if (search.trim() || activeCategory) return null; // flat display when searching or filtered
    const map = new Map<string, AmenityIcon[]>();
    for (const icon of displayedIcons) {
      const list = map.get(icon.category) || [];
      list.push(icon);
      map.set(icon.category, list);
    }
    return map;
  }, [displayedIcons, search, activeCategory]);

  const handleSelect = (icon: AmenityIcon) => {
    onSelect(icon.svg);
    setIsOpen(false);
  };

  const handleRemove = () => {
    onSelect("");
    setIsOpen(false);
  };

  return (
    <div className={styles.container} ref={containerRef}>
      {/* Trigger — the current icon or empty placeholder */}
      <button
        type="button"
        className={`${styles.trigger} ${currentIcon ? styles.triggerHasIcon : ''}`}
        onClick={() => setIsOpen(!isOpen)}
        title="Change icon"
      >
        {currentIcon ? (
          <span className={styles.triggerIcon} dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(currentIcon, { USE_PROFILES: { svg: true, svgFilters: true } }) }} />
        ) : (
          <span className={styles.triggerEmpty}>+</span>
        )}
      </button>

      {/* Popover */}
      {isOpen && (
        <div className={styles.popover}>
          {/* Search */}
          <div className={styles.searchWrap}>
            <input
              ref={searchRef}
              type="text"
              className={styles.searchInput}
              placeholder="Search icons..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setActiveCategory(null); }}
            />
          </div>

          {/* Category tabs */}
          <div className={styles.categoryBar}>
            <button
              type="button"
              className={`${styles.categoryTab} ${!activeCategory && !search.trim() ? styles.categoryTabActive : ''}`}
              onClick={() => { setActiveCategory(null); setSearch(""); }}
            >
              All
            </button>
            {categories.map(cat => (
              <button
                key={cat}
                type="button"
                className={`${styles.categoryTab} ${activeCategory === cat ? styles.categoryTabActive : ''}`}
                onClick={() => { setActiveCategory(cat); setSearch(""); }}
              >
                {cat}
              </button>
            ))}
          </div>

          {/* Icon grid */}
          <div className={styles.iconGrid}>
            {/* Remove icon option */}
            <button
              type="button"
              className={styles.iconCell}
              onClick={handleRemove}
              title="Remove icon"
            >
              <span className={styles.removeIcon}>✕</span>
              <span className={styles.iconLabel}>None</span>
            </button>

            {grouped
              ? /* Grouped by category */
                Array.from(grouped.entries()).map(([cat, icons]) => (
                  <div key={cat} className={styles.categoryGroup}>
                    <div className={styles.categoryHeader}>{cat}</div>
                    <div className={styles.categoryIcons}>
                      {icons.map(icon => (
                        <button
                          key={icon.id}
                          type="button"
                          className={styles.iconCell}
                          onClick={() => handleSelect(icon)}
                          title={icon.name}
                        >
                          <span className={styles.iconSvg} dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(icon.svg, { USE_PROFILES: { svg: true, svgFilters: true } }) }} />
                          <span className={styles.iconLabel}>{icon.name}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))
              : /* Flat results (search or single category) */
                displayedIcons.map(icon => (
                  <button
                    key={icon.id}
                    type="button"
                    className={styles.iconCell}
                    onClick={() => handleSelect(icon)}
                    title={icon.name}
                  >
                    <span className={styles.iconSvg} dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(icon.svg, { USE_PROFILES: { svg: true, svgFilters: true } }) }} />
                    <span className={styles.iconLabel}>{icon.name}</span>
                  </button>
                ))
            }

            {displayedIcons.length === 0 && (
              <div className={styles.emptyState}>No icons match "{search}"</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
