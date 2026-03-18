"use client";

import { useState, useEffect } from "react";
import styles from "./page.module.css";
import { properties as staticProperties } from "./data/properties";
import { getProperties } from "./lib/firebase/properties";
import { Property } from "./data/properties";
import { MapView } from "./components/MapView";
import { PropertyList } from "./components/PropertyList";
import { TopFilters } from "./components/TopFilters";
import { PropertyDetailPanel } from "./components/PropertyDetailPanel";
import { ChevronRight } from "lucide-react";

export default function Home() {
  const [properties, setProperties] = useState<Property[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Simple filter state (can be expanded later)
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCity, setSelectedCity] = useState("All Cities");
  const [selectedGuests, setSelectedGuests] = useState("Any");

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

  const filteredProperties = properties.filter((p) => {
    // 1. Text Search
    const matchesSearch = p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                          p.location.toLowerCase().includes(searchQuery.toLowerCase());
    
    // 2. City Filter
    const matchesCity = selectedCity === "All Cities" || p.location.includes(selectedCity);
    
    // 3. Guests Filter
    let matchesGuests = true;
    if (selectedGuests !== "Any") {
       if (selectedGuests === "6+") {
          matchesGuests = p.guests >= 6;
       } else {
          matchesGuests = p.guests >= parseInt(selectedGuests);
       }
    }

    return matchesSearch && matchesCity && matchesGuests;
  });

  // Reverted auto-sort; we will now scroll to the item instead of reordering the DOM

  const selectedProperty = properties.find(p => p.id === selectedId);

  return (
    <main className={`${styles.container} ${selectedId ? styles.detailActive : ""}`}>
      {isLoading && (
        <div className={styles.loadingOverlay}>Loading properties...</div>
      )}
      {/* 
        BACK HANDLE 
        Appears from the left screen edge when detail mode is active, 
        giving the user a hardware-like handle to pull the list back.
      */}
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
            selectedCity={selectedCity}
            setSelectedCity={setSelectedCity}
            selectedGuests={selectedGuests}
            setSelectedGuests={setSelectedGuests}
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

      {/* RIGHT PANEL (MAP) */}
      <div className={styles.rightPanel}>
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
