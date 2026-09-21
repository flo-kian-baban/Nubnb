"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import styles from "../page.module.css";
import { Property, PropertySummary } from "@/app/types/property";
import { MapView } from "./MapView";
import { PropertyList } from "./PropertyList";
import { TopFilters } from "./TopFilters";
import { MapFilters } from "./MapFilters";
import { PropertyDetailPanel } from "./PropertyDetailPanel";
import { ChevronRight, Map, LayoutList, MapPinOff } from "lucide-react";
import Link from "next/link";
import { toSlug, resolvePropertySlug } from "../lib/slug";

export { toSlug };

interface HomePageProps {
  /**
   * The catalogue, read on the server and rendered into the HTML. Not state,
   * not fetched here — the browser no longer talks to Firestore at all.
   */
  properties: PropertySummary[];
  initialSlug?: string;
  /**
   * The complete document for `initialSlug`, when the server resolved it.
   * Lets a /property/<slug> arrival render the panel with no round trip.
   */
  initialProperty?: Property;
}

/** Debounce delay for availability filter (ms) */
const AVAIL_DEBOUNCE_MS = 600;

/**
 * How long to wait for a property's full document before calling it failed.
 *
 * A healthy response lands in well under a second. The number is set by the
 * failure case instead: with Firestore unreachable the Admin SDK spends its
 * own retry budget before answering, measured at 45s against a refused
 * connection, and a visitor watching a spinner for 45 seconds has not been
 * told anything. Fifteen seconds is far above any real latency and turns that
 * wait into an error they can act on.
 */
const DETAIL_FETCH_TIMEOUT_MS = 15_000;

export default function HomePage({ properties, initialSlug, initialProperty }: HomePageProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(
    initialProperty ? initialProperty.id : null,
  );

  // Mobile view toggle: 'list' or 'map'
  const [mobileView, setMobileView] = useState<'list' | 'map'>('list');
  const [isMobile, setIsMobile] = useState(false);

  // Track whether a URL change was triggered internally (to avoid re-entrancy)
  const isInternalNav = useRef(false);
  // Track whether the initial slug has been consumed
  const initialSlugConsumed = useRef(false);
  /**
   * Set when a /property/<slug> request matched nothing. Distinct from
   * `selectedId === null`, which just means "browsing the map".
   *
   * Mirrored into a ref because the URL-sync effect below reads it in the
   * same commit in which it is set. State updates are not visible to an
   * effect that already has its closure, so a state-only guard let the
   * "no match" case fall through and rewrite the URL to "/" before the
   * re-render ever happened — the exact bounce this removes.
   */
  const [unavailableSlug, setUnavailableSlug] = useState<string | null>(
    initialSlug && !initialProperty ? initialSlug : null,
  );
  const unavailableRef = useRef(Boolean(initialSlug && !initialProperty));

  // Detect mobile breakpoint
  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth <= 768);
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  // ── Canonicalise the address bar for a legacy slug ──
  //
  // Resolution accepts the canonical slug or the one stored on the document.
  // 27 of 43 properties were renamed after creation without their stored slug
  // being regenerated, so every link shared before a rename carries the old
  // one.
  //
  // The resolve itself now happens on the server, which is why `selectedId`
  // is already correct on first paint and this effect only has the address
  // bar left to tidy. It re-runs the resolve purely to learn whether the
  // incoming slug was the canonical one.
  useEffect(() => {
    if (initialSlugConsumed.current || !initialSlug) return;
    initialSlugConsumed.current = true;

    const resolved = resolvePropertySlug(properties, initialSlug);
    if (!resolved) return; // server said the same — the unavailable card is showing

    if (resolved.isLegacy) {
      isInternalNav.current = true;
      // Put the canonical URL in the address bar without reloading, so the
      // link the visitor copies from here is the one that keeps working.
      window.history.replaceState(
        { propertySlug: resolved.canonical },
        "",
        `/property/${resolved.canonical}`,
      );
    }
  }, [properties, initialSlug]);

  // ── Sync selectedId → URL (pushState, no reload) ──
  useEffect(() => {
    if (isInternalNav.current) {
      isInternalNav.current = false;
      return;
    }

    if (properties.length === 0) return;

    // While the unavailable state is showing, leave the URL alone. Rewriting
    // it to "/" here is exactly the silent bounce dispatch 7 removed: the
    // visitor loses the address they came in on and never learns why.
    if (unavailableRef.current) return;

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
  }, [selectedId, properties, unavailableSlug]);

  // ── Listen for browser back/forward ──
  useEffect(() => {
    const handlePopState = () => {
      const match = window.location.pathname.match(/^\/property\/(.+)$/);
      const slug = match ? match[1] : null;

      if (slug) {
        const resolved = resolvePropertySlug(properties, slug);
        if (resolved) {
          isInternalNav.current = true;
          unavailableRef.current = false;
          setUnavailableSlug(null);
          setSelectedId(resolved.property.id);
          return;
        }
        // Navigated back onto a slug that resolves to nothing — say so rather
        // than dropping the visitor on the map with no explanation.
        isInternalNav.current = true;
        unavailableRef.current = true;
        setSelectedId(null);
        setUnavailableSlug(slug);
        return;
      }
      isInternalNav.current = true;
      unavailableRef.current = false;
      setUnavailableSlug(null);
      setSelectedId(null);
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [properties]);

  /**
   * The card the open panel came from, kept so focus can go back to it.
   *
   * Read from a ref rather than state because the close handler needs it
   * after `selectedId` has already been cleared.
   */
  const lastSelectedRef = useRef<string | null>(null);
  useEffect(() => {
    if (selectedId) lastSelectedRef.current = selectedId;
  }, [selectedId]);

  /**
   * True once the visitor has opened a panel themselves.
   *
   * A panel that is open because someone followed a /property/<slug> link
   * should not yank focus on page load — there is nothing to return it to and
   * it would move the visitor off the top of a page they just arrived at.
   * Focus only follows a panel the visitor opened.
   */
  const [openedByUser, setOpenedByUser] = useState(false);

  const handleCloseDetail = useCallback(() => {
    const returnTo = lastSelectedRef.current;
    setSelectedId(null);
    if (!returnTo) return;
    // After React has committed the close, so the card is back in the layout.
    requestAnimationFrame(() => {
      document
        .getElementById(`property-card-${returnTo}`)
        ?.querySelector<HTMLElement>("button")
        ?.focus({ preventScroll: false });
    });
  }, []);

  /** Leave the unavailable state deliberately, via the visitor's own click. */
  const handleDismissUnavailable = useCallback(() => {
    unavailableRef.current = false;
    setUnavailableSlug(null);
    if (window.location.pathname !== "/") {
      window.history.pushState({}, "", "/");
    }
  }, []);

  const handleSelectProperty = useCallback((id: string | null) => {
    if (id) setOpenedByUser(true);
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

  // ── Full documents, loaded on demand ──
  //
  // The page carries a slim projection of each property — enough for the
  // card, the map and the filters. `offers` alone is 1.05 MB across the 43
  // documents and nothing outside the detail panel reads it, so the rest of
  // the document is fetched only when a visitor actually opens a property.
  // A /property/<slug> arrival already has its document from the server.
  const [detailCache, setDetailCache] = useState<Record<string, Property>>(
    initialProperty ? { [initialProperty.id]: initialProperty } : {},
  );
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailAttempt, setDetailAttempt] = useState(0);

  useEffect(() => {
    if (!selectedId || detailCache[selectedId]) {
      setDetailLoading(false);
      setDetailError(null);
      return;
    }

    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);

    (async () => {
      try {
        const res = await fetch(`/api/properties/${selectedId}`, {
          signal: AbortSignal.timeout(DETAIL_FETCH_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`Request failed with ${res.status}`);

        const body = await res.json();
        const data = body?.data as Property | undefined;
        if (!data || typeof data.id !== "string") {
          throw new Error("Malformed property response");
        }
        if (cancelled) return;
        setDetailCache((prev) => ({ ...prev, [data.id]: data }));
      } catch (err) {
        if (cancelled) return;
        console.error("[HomePage] Failed to load property details:", err);
        setDetailError(
          "We couldn't load the details for this property. Please try again in a moment.",
        );
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [selectedId, detailCache, detailAttempt]);

  const handleDetailRetry = useCallback(() => setDetailAttempt((n) => n + 1), []);

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

  /**
   * Resets everything that narrows the list, including the text search.
   * Offered by PropertyList when filtering is what emptied it — which is the
   * only way that branch can be reached, since with nothing filtering, the
   * filtered list is the catalogue.
   */
  const clearAllFilters = useCallback(() => {
    setSearchQuery("");
    setSelectedCity("All Cities");
    setMinGuests(0);
    setAvailStart("");
    setAvailEnd("");
  }, []);

  const filteredProperties = useMemo(() => properties.filter((p) => {
    // 1. Text Search
    const matchesSearch =
      p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.location.toLowerCase().includes(searchQuery.toLowerCase());

    // 2. City Filter
    //
    // Matched against `addressDetails.city`, which is where the dropdown's
    // options come from. It used to test `location.includes(selectedCity)` —
    // a substring test against a different, free-text field. The two agree on
    // today's 43 documents only because every `location` happens to read
    // "<city>, ON"; any listing whose location mentions a second place ("in
    // the Greater Toronto Area") would have been returned under the wrong
    // city, and any whose location omits the city under none at all.
    const matchesCity =
      selectedCity === "All Cities" || p.addressDetails?.city === selectedCity;

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
  }), [properties, searchQuery, selectedCity, minGuests, availStart, availEnd, bookedCache]);

  const selectedSummary = properties.find((p) => p.id === selectedId);
  const selectedProperty = selectedId ? detailCache[selectedId] : undefined;

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
      {/* Availability is the one thing still checked live, against third-party
          iCal feeds. It gets a bottom-anchored status line, not an overlay —
          the listings it is filtering stay visible and usable while it runs. */}
      {checkingAvail && (
        <div className={styles.availOverlay} role="status" aria-live="polite">
          Checking availability...
        </div>
      )}

      {/* ── Property Unavailable ────────────────────
          A /property/<slug> that matches neither the canonical nor the stored
          slug. Previously this silently rewrote the URL to "/" and showed the
          map, so a dead link was indistinguishable from a normal visit. */}
      {unavailableSlug && (
        <div className={styles.errorState}>
          <div className={styles.errorCard}>
            <div className={styles.errorIconWrap}>
              <MapPinOff size={32} strokeWidth={1.5} />
            </div>
            <h2 className={styles.errorTitle}>This property is no longer available</h2>
            <p className={styles.errorMessage}>
              The link you followed points to a listing we no longer have. It may have been
              removed, or the address may have changed.
            </p>
            <button className={styles.errorRetry} onClick={handleDismissUnavailable}>
              <Map size={16} />
              Back to the map
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
            catalogueIsEmpty={properties.length === 0}
            onClearFilters={clearAllFilters}
            hoveredId={hoveredId}
            selectedId={selectedId}
            onHover={setHoveredId}
            onSelect={handleSelectProperty}
          />
        </div>
        <Link href="/about" className={styles.aboutBtnSidebar}>
          About Us
        </Link>
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
          summary={selectedSummary}
          isLoading={detailLoading}
          error={detailError}
          onRetry={handleDetailRetry}
          onClose={handleCloseDetail}
          moveFocusOnOpen={openedByUser}
          guests={minGuests > 0 ? minGuests : undefined}
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
