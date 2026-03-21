"use client";

import { useState, useEffect } from "react";
import styles from "./page.module.css";
import { properties as staticProperties } from "./data/properties";
import { getProperties } from "./lib/firebase/properties";
import { Property } from "./data/properties";
import { MapView } from "./components/MapView";
import { PropertyList } from "./components/PropertyList";
import { TopFilters } from "./components/TopFilters";
import { MapFilters } from "./components/MapFilters";
import { PropertyDetailPanel } from "./components/PropertyDetailPanel";
import { ChevronRight } from "lucide-react";

export default function Home() {
  const [properties, setProperties] = useState<Property[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCity, setSelectedCity] = useState("All Cities");
  const [minGuests, setMinGuests] = useState(0);
  const [availStart, setAvailStart] = useState("");
  const [availEnd, setAvailEnd] = useState("");

  // Availability cache: propertyId → Set<"YYYY-MM-DD"> of booked dates
  const [bookedCache, setBookedCache] = useState<Record<string, Set<string>>>({});
  const [checkingAvail, setCheckingAvail] = useState(false);

  useEffect(() => {
    async function fetchListings() {
      setIsLoading(true);
      const data = await getProperties();
      // Fall back to static mock data if Firebase returns nothing
      setProperties(data.length > 0 ? data : staticProperties);
      setIsLoading(false);
    }
    fetchListings();
  }, []);

  // Fetch booked dates when availability filter is set
  useEffect(() => {
    if (!availStart || !availEnd) return;

    const propsWithICal = properties.filter(p => p.icalUrl && !bookedCache[p.id]);
    if (propsWithICal.length === 0) return;

    setCheckingAvail(true);

    // Batch fetch booked dates for all properties with iCal URLs
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
            // Expand range to individual dates
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

  return (
    <main
      className={`${styles.container} ${selectedId ? styles.detailActive : ""}`}
    >
      {isLoading && (
        <div className={styles.loadingOverlay}>Loading properties...</div>
      )}
      {checkingAvail && (
        <div className={styles.availOverlay}>Checking availability...</div>
      )}

      {/* BACK HANDLE */}
      <button
        className={styles.backHandle}
        onClick={() => setSelectedId(null)}
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
        </div>

        <div className={styles.scrollArea}>
          <PropertyList
            properties={filteredProperties}
            hoveredId={hoveredId}
            selectedId={selectedId}
            onHover={setHoveredId}
            onSelect={setSelectedId}
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
        />
        <MapView
          properties={filteredProperties}
          hoveredId={hoveredId}
          selectedId={selectedId}
          onHover={setHoveredId}
          onSelect={setSelectedId}
        />
      </div>

      {/* DETAIL PANEL (Right Slide-In) */}
      <div className={styles.detailPanel}>
        <PropertyDetailPanel
          property={selectedProperty}
          onClose={() => setSelectedId(null)}
        />
      </div>
    </main>
  );
}
