"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import styles from "../page.module.css";
import { getProperties } from "../lib/firebase/properties";
import { Property } from "@/app/types/property";
import { MapView } from "./MapView";
import { PropertyList } from "./PropertyList";
import { TopFilters } from "./TopFilters";
import { MapFilters } from "./MapFilters";
import { PropertyDetailPanel } from "./PropertyDetailPanel";
import { ChevronRight, Map, LayoutList, WifiOff, RefreshCw } from "lucide-react";
import Link from "next/link";

/** Convert a property name to a URL-safe slug */
export function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[&]/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

interface HomePageProps {
  initialSlug?: string;
}

/** Debounce delay for availability filter (ms) */
const AVAIL_DEBOUNCE_MS = 600;

export default function HomePage({ initialSlug }: HomePageProps) {
  const [properties, setProperties] = useState<Property[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Mobile view toggle: 'list' or 'map'
  const [mobileView, setMobileView] = useState<'list' | 'map'>('list');
  const [isMobile, setIsMobile] = useState(false);

  // Track whether a URL change was triggered internally (to avoid re-entrancy)
  const isInternalNav = useRef(false);
  // Track whether the initial slug has been consumed
  const initialSlugConsumed = useRef(false);

  // Detect mobile breakpoint
  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth <= 768);
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  // ── Auto-open property from initialSlug once data loads ──
  useEffect(() => {
    if (properties.length === 0 || initialSlugConsumed.current) return;

    if (initialSlug) {
      const match = properties.find((p) => toSlug(p.name) === initialSlug);
      if (match) {
        isInternalNav.current = true;
        initialSlugConsumed.current = true;
        setSelectedId(match.id);
      }
    }
  }, [properties, initialSlug]);

  // ── Sync selectedId → URL (pushState, no reload) ──
  useEffect(() => {
    if (isInternalNav.current) {
      isInternalNav.current = false;
      return;
    }

    if (properties.length === 0) return;

    if (selectedId) {
      const prop = properties.find((p) => p.id === selectedId);
      if (prop) {
        const slug = toSlug(prop.name);
        const targetPath = `/property/${slug}`;
        if (window.location.pathname !== targetPath) {
          window.history.pushState({ propertySlug: slug }, "", targetPath);
        }
      }
    } else {
      if (window.location.pathname !== "/") {
        window.history.pushState({}, "", "/");
      }
    }
  }, [selectedId, properties]);

  // ── Listen for browser back/forward ──
  useEffect(() => {
    const handlePopState = () => {
      const match = window.location.pathname.match(/^\/property\/(.+)$/);
      const slug = match ? match[1] : null;

      if (slug) {
        const prop = properties.find((p) => toSlug(p.name) === slug);
        if (prop) {
          isInternalNav.current = true;
          setSelectedId(prop.id);
          return;
        }
      }
      isInternalNav.current = true;
      setSelectedId(null);
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [properties]);

  const handleCloseDetail = useCallback(() => {
    setSelectedId(null);
  }, []);

  const handleSelectProperty = useCallback((id: string | null) => {
    setSelectedId(id);
  }, []);

  // Filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCity, setSelectedCity] = useState("All Cities");
  const [minGuests, setMinGuests] = useState(0);
  const [availStart, setAvailStart] = useState("");
  const [availEnd, setAvailEnd] = useState("");

  // Availability cache: propertyId → Set<"YYYY-MM-DD"> of booked dates
  const [bookedCache, setBookedCache] = useState<Record<string, Set<string>>>({});
  const [checkingAvail, setCheckingAvail] = useState(false);

  // ── Fetch properties — surface real errors, no silent fallback ──
  useEffect(() => {
    let cancelled = false;

    async function fetchListings() {
      setIsLoading(true);
      setFetchError(null);

      try {
        const data = await getProperties();
        if (!cancelled) {
          if (data.length === 0) {
            setFetchError("No properties found. Please check back later.");
          }
          setProperties(data);
        }
      } catch (err) {
        if (!cancelled) {
          console.error("[HomePage] Failed to fetch properties:", err);
          setFetchError(
            "We couldn't load our properties right now. Please try again in a moment."
          );
          setProperties([]);
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    fetchListings();
    return () => { cancelled = true; };
  }, []);

  // ── Debounced availability fetch ──
  // Uses a ref-based debounce so rapid date changes don't flood the API.
  const availTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Clear any pending debounce
    if (availTimerRef.current) {
      clearTimeout(availTimerRef.current);
      availTimerRef.current = null;
    }

    if (!availStart || !availEnd) return;

    const propsWithICal = properties.filter(p => p.icalUrl && !bookedCache[p.id]);
    if (propsWithICal.length === 0) return;

    // Debounce: wait for user to stop changing dates
    availTimerRef.current = setTimeout(() => {
      setCheckingAvail(true);

      Promise.all(
        propsWithICal.map(async (p) => {
          try {
            const res = await fetch("/api/fetch-booked-dates", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ icalUrl: p.icalUrl }),
            });
            if (!res.ok) return { id: p.id, dates: new Set<string>() };
            const result = await res.json();
            const dateSet = new Set<string>();
            for (const range of result.data.bookedRanges) {
              const start = new Date(range.start);
              const end = new Date(range.end);
              const current = new Date(start);
              while (current < end) {
                dateSet.add(current.toISOString().split("T")[0]);
                current.setDate(current.getDate() + 1);
              }
            }
            return { id: p.id, dates: dateSet };
          } catch {
            return { id: p.id, dates: new Set<string>() };
          }
        })
      ).then((results) => {
        setBookedCache((prev) => {
          const next = { ...prev };
          for (const r of results) {
            next[r.id] = r.dates;
          }
          return next;
        });
        setCheckingAvail(false);
      });
    }, AVAIL_DEBOUNCE_MS);

    return () => {
      if (availTimerRef.current) {
        clearTimeout(availTimerRef.current);
        availTimerRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availStart, availEnd, properties]);

  const filteredProperties = properties.filter((p) => {
    // 1. Text Search
    const matchesSearch =
      p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.location.toLowerCase().includes(searchQuery.toLowerCase());

    // 2. City Filter
    const matchesCity =
      selectedCity === "All Cities" || p.location.includes(selectedCity);

    // 3. Guests Filter
    const matchesGuests = minGuests <= 0 || p.guests >= minGuests;

    // 4. Availability Filter
    let matchesAvail = true;
    if (availStart && availEnd) {
      const booked = bookedCache[p.id];
      if (booked && booked.size > 0) {
        // Check if any day in [availStart, availEnd) is booked
        const start = new Date(availStart);
        const end = new Date(availEnd);
        const d = new Date(start);
        while (d < end) {
          if (booked.has(d.toISOString().split("T")[0])) {
            matchesAvail = false;
            break;
          }
          d.setDate(d.getDate() + 1);
        }
      }
      // Properties without iCal are assumed available (no data to check against)
    }

    return matchesSearch && matchesCity && matchesGuests && matchesAvail;
  });

  const selectedProperty = properties.find((p) => p.id === selectedId);

  // Retry handler for error state
  const handleRetry = useCallback(() => {
    setFetchError(null);
    setIsLoading(true);
    getProperties()
      .then((data) => {
        if (data.length === 0) {
          setFetchError("No properties found. Please check back later.");
        }
        setProperties(data);
      })
      .catch(() => {
        setFetchError(
          "We couldn't load our properties right now. Please try again in a moment."
        );
        setProperties([]);
      })
      .finally(() => setIsLoading(false));
  }, []);

  // Build container class
  const containerClass = [
    styles.container,
    selectedId ? styles.detailActive : "",
    isMobile ? styles.isMobile : "",
    isMobile && mobileView === 'map' ? styles.mobileMapView : "",
    isMobile && mobileView === 'list' ? styles.mobileListView : "",
  ].filter(Boolean).join(' ');

  return (
    <main className={containerClass}>
      {isLoading && (
        <div className={styles.loadingOverlay}>
          <div className={styles.loadingSpinner} />
        </div>
      )}
      {checkingAvail && (
        <div className={styles.availOverlay}>Checking availability...</div>
      )}

      {/* ── Error State ─────────────────────────────── */}
      {fetchError && !isLoading && (
        <div className={styles.errorState}>
          <div className={styles.errorCard}>
            <div className={styles.errorIconWrap}>
              <WifiOff size={32} strokeWidth={1.5} />
            </div>
            <h2 className={styles.errorTitle}>Something went wrong</h2>
            <p className={styles.errorMessage}>{fetchError}</p>
            <button className={styles.errorRetry} onClick={handleRetry}>
              <RefreshCw size={16} />
              Try Again
            </button>
          </div>
        </div>
      )}

      {/* BACK HANDLE — desktop only */}
      <button
        className={styles.backHandle}
        onClick={handleCloseDetail}
        aria-label="Back to List"
      >
        <ChevronRight size={20} />
      </button>

      {/* LEFT PANEL (Browsing List) */}
      <div className={styles.leftPanel}>
        <div className={styles.header}>
          <TopFilters
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
          />
          {/* Mobile only: show WHERE/WHO/WHEN below search */}
          <div className={styles.mobileFiltersInList}>
            <MapFilters
              selectedCity={selectedCity}
              setSelectedCity={setSelectedCity}
              minGuests={minGuests}
              setMinGuests={setMinGuests}
              availStart={availStart}
              setAvailStart={setAvailStart}
              availEnd={availEnd}
              setAvailEnd={setAvailEnd}
              properties={properties}
            />
          </div>
        </div>

        <div className={styles.scrollArea}>
          <PropertyList
            properties={filteredProperties}
            hoveredId={hoveredId}
            selectedId={selectedId}
            onHover={setHoveredId}
            onSelect={handleSelectProperty}
          />
        </div>
      </div>

      {/* RIGHT PANEL (MAP + FILTERS) */}
      <div className={styles.rightPanel}>
        <MapFilters
          selectedCity={selectedCity}
          setSelectedCity={setSelectedCity}
          minGuests={minGuests}
          setMinGuests={setMinGuests}
          availStart={availStart}
          setAvailStart={setAvailStart}
          availEnd={availEnd}
          setAvailEnd={setAvailEnd}
          properties={properties}
        />
        <Link href="/about" className={styles.aboutBtn}>
          About Us
        </Link>
        <MapView
          properties={filteredProperties}
          hoveredId={hoveredId}
          selectedId={selectedId}
          onHover={setHoveredId}
          onSelect={handleSelectProperty}
        />
      </div>

      {/* DETAIL PANEL (Right Slide-In / Mobile Fullscreen) */}
      <div className={styles.detailPanel}>
        <PropertyDetailPanel
          property={selectedProperty}
          onClose={handleCloseDetail}
        />
      </div>

      {/* MOBILE VIEW TOGGLE FAB */}
      {isMobile && !selectedId && (
        <button
          className={styles.mobileViewToggle}
          onClick={() => setMobileView(mobileView === 'list' ? 'map' : 'list')}
          aria-label={mobileView === 'list' ? 'Show map' : 'Show listings'}
        >
          {mobileView === 'list' ? (
            <>
              <Map size={18} />
              <span>Map</span>
            </>
          ) : (
            <>
              <LayoutList size={18} />
              <span>List</span>
            </>
          )}
        </button>
      )}
    </main>
  );
}
