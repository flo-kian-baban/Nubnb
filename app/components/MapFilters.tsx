"use client";

import { X } from "lucide-react";
import { DayPicker, DateRange } from "react-day-picker";
import "react-day-picker/style.css";
import styles from "./MapFilters.module.css";
import { useState, useRef, useEffect, useMemo } from "react";
import { format, addYears } from "date-fns";

interface MapFiltersProps {
  selectedCity: string;
  setSelectedCity: (city: string) => void;
  minGuests: number;
  setMinGuests: (n: number) => void;
  availStart: string;
  setAvailStart: (d: string) => void;
  availEnd: string;
  setAvailEnd: (d: string) => void;
}

const CITIES = ['All Cities', 'Toronto', 'Richmond Hill', 'Aurora', 'Markham', 'Vaughan', 'North York', 'King City'];
const GUEST_OPTIONS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16];

export function MapFilters({
  selectedCity,
  setSelectedCity,
  minGuests,
  setMinGuests,
  availStart,
  setAvailStart,
  availEnd,
  setAvailEnd,
}: MapFiltersProps) {
  const [cityOpen, setCityOpen] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [guestsOpen, setGuestsOpen] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);

  const closeAll = () => { setCityOpen(false); setCalendarOpen(false); setGuestsOpen(false); };

  // Only close when clicking outside the pill
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (barRef.current && !barRef.current.contains(event.target as Node)) {
        closeAll();
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const dateRange: DateRange | undefined = useMemo(() => {
    if (!availStart) return undefined;
    const from = new Date(availStart + "T00:00:00");
    const to = availEnd ? new Date(availEnd + "T00:00:00") : undefined;
    return { from, to };
  }, [availStart, availEnd]);

  const today = new Date();
  const oneYearFromNow = addYears(today, 1);

  const hasActiveFilters =
    selectedCity !== "All Cities" ||
    minGuests > 0 ||
    availStart !== "" ||
    availEnd !== "";

  const clearAll = () => {
    setSelectedCity("All Cities");
    setMinGuests(0);
    setAvailStart("");
    setAvailEnd("");
  };

  const datesValue = useMemo(() => {
    if (!availStart) return "Add dates";
    const from = format(new Date(availStart + "T00:00:00"), "MM/dd");
    if (!availEnd) return `${from} → MM/DD`;
    const to = format(new Date(availEnd + "T00:00:00"), "MM/dd");
    return `${from} → ${to}`;
  }, [availStart, availEnd]);

  const guestsValue = minGuests > 0 ? `${minGuests} guest${minGuests > 1 ? "s" : ""}` : "Add guests";
  const cityValue = selectedCity !== "All Cities" ? selectedCity : "Search destinations";

  return (
    <div className={`${styles.bar} mapFiltersBar`} ref={barRef}>
      <div className={styles.pill}>
        {/* ── Where ── hover opens, hovering another section replaces */}
        <div
          className={styles.section}
          onMouseEnter={() => { setCityOpen(true); setCalendarOpen(false); setGuestsOpen(false); }}
        >
          <span className={styles.sectionLabel}>Where</span>
          <span className={`${styles.sectionValue} ${selectedCity !== "All Cities" ? styles.filled : ""}`}>
            {cityValue}
          </span>
        </div>

        <div className={styles.divider} />

        {/* ── Who ── */}
        <div
          className={styles.section}
          onMouseEnter={() => { setGuestsOpen(true); setCityOpen(false); setCalendarOpen(false); }}
        >
          <span className={styles.sectionLabel}>Who</span>
          <span className={`${styles.sectionValue} ${minGuests > 0 ? styles.filled : ""}`}>
            {guestsValue}
          </span>
        </div>

        <div className={styles.divider} />

        {/* ── When ── */}
        <div
          className={`${styles.section} ${styles.sectionLast}`}
          onMouseEnter={() => { setCalendarOpen(true); setCityOpen(false); setGuestsOpen(false); }}
        >
          <span className={styles.sectionLabel}>When</span>
          <span className={`${styles.sectionValue} ${availStart ? styles.filled : ""}`}>
            {datesValue}
          </span>
        </div>

        {hasActiveFilters && (
          <button className={styles.clearBtn} onClick={clearAll} title="Clear all filters">
            <X size={14} />
          </button>
        )}
      </div>

      {/* Dropdowns rendered outside sections so they stay open */}
      {cityOpen && (
        <div className={styles.dropdown} style={{ left: 0, right: 'auto', minWidth: '180px' }}>
          {CITIES.map((city) => (
            <button
              key={city}
              className={`${styles.dropdownOption} ${selectedCity === city ? styles.selected : ""}`}
              onClick={() => setSelectedCity(city)}
            >
              {city}
            </button>
          ))}
        </div>
      )}

      {calendarOpen && (
        <div className={styles.calendarPopover}>
          <DayPicker
            mode="range"
            selected={dateRange}
            onSelect={(range) => {
              if (range?.from) {
                setAvailStart(format(range.from, "yyyy-MM-dd"));
              } else {
                setAvailStart("");
              }
              if (range?.to) {
                setAvailEnd(format(range.to, "yyyy-MM-dd"));
              } else {
                setAvailEnd("");
              }
            }}
            disabled={[{ before: today }]}
            startMonth={today}
            endMonth={oneYearFromNow}
            className={styles.calendarDayPicker}
          />
        </div>
      )}

      {guestsOpen && (
        <div className={styles.guestsPanel}>
          <span className={styles.guestsPanelLabel}>Guests</span>
          <div className={styles.stepperControls}>
            <button
              type="button"
              className={styles.stepperBtn}
              onClick={() => setMinGuests(Math.max(0, minGuests - 1))}
              disabled={minGuests <= 0}
            >−</button>
            <span className={styles.stepperCount}>{minGuests}</span>
            <button
              type="button"
              className={styles.stepperBtn}
              onClick={() => setMinGuests(Math.min(20, minGuests + 1))}
            >+</button>
          </div>
        </div>
      )}
    </div>
  );
}
