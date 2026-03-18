"use client";

import { Search, MapPin, Users, ChevronDown } from "lucide-react";
import styles from "./TopFilters.module.css";
import { useState, useRef, useEffect } from "react";

interface TopFiltersProps {
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  selectedCity: string;
  setSelectedCity: (city: string) => void;
  selectedGuests: string;
  setSelectedGuests: (guests: string) => void;
}

export function TopFilters({
  searchQuery,
  setSearchQuery,
  selectedCity,
  setSelectedCity,
  selectedGuests,
  setSelectedGuests,
}: TopFiltersProps) {
  const [activeDropdown, setActiveDropdown] = useState<'cities' | 'guests' | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const CITIES = ['All Cities', 'Toronto', 'Richmond Hill', 'Aurora', 'Markham', 'Vaughan', 'North York', 'King City'];
  const GUESTS = ['Any', '1', '2', '3', '4', '5', '6+'];

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setActiveDropdown(null);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

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

      {/* Filter Row */}
      <div className={styles.controls} ref={dropdownRef}>
        <div className={styles.filtersRow}>
          
          {/* Custom City Dropdown */}
          <div className={styles.dropdownContainer}>
            <button 
              className={`${styles.filterButton} ${activeDropdown === 'cities' ? styles.active : ''} interactive`}
              onClick={() => setActiveDropdown(activeDropdown === 'cities' ? null : 'cities')}
            >
              <div className={styles.filterButtonLeft}>
                <MapPin size={16} />
                {selectedCity}
              </div>
              <ChevronDown size={14} className={activeDropdown === 'cities' ? styles.chevronOpen : ''} />
            </button>
            
            {activeDropdown === 'cities' && (
              <div className={styles.dropdownMenu}>
                {CITIES.map(city => (
                  <button 
                    key={city}
                    className={`${styles.dropdownOption} ${selectedCity === city ? styles.selectedOption : ''}`}
                    onClick={() => {
                      setSelectedCity(city);
                      setActiveDropdown(null);
                    }}
                  >
                    {city}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Custom Guests Dropdown */}
          <div className={styles.dropdownContainer}>
            <button 
              className={`${styles.filterButton} ${activeDropdown === 'guests' ? styles.active : ''} interactive`}
              onClick={() => setActiveDropdown(activeDropdown === 'guests' ? null : 'guests')}
            >
              <div className={styles.filterButtonLeft}>
                <Users size={16} />
                {selectedGuests === 'Any' ? 'Guests' : `${selectedGuests} Guests`}
              </div>
              <ChevronDown size={14} className={activeDropdown === 'guests' ? styles.chevronOpen : ''} />
            </button>

            {activeDropdown === 'guests' && (
              <div className={styles.dropdownMenu}>
                {GUESTS.map(guest => (
                  <button 
                    key={guest}
                    className={`${styles.dropdownOption} ${selectedGuests === guest ? styles.selectedOption : ''}`}
                    onClick={() => {
                      setSelectedGuests(guest);
                      setActiveDropdown(null);
                    }}
                  >
                    {guest === 'Any' ? 'Any number' : `${guest} Guests`}
                  </button>
                ))}
              </div>
            )}
          </div>

        </div>
      </div>
    </div>
  );
}
