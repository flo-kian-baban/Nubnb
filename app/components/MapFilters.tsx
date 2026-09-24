"use client";

import { X } from "lucide-react";
// Static, although the calendar's code is not: see the note in Calendars.tsx.
import "react-day-picker/style.css";
import styles from "./MapFilters.module.css";
import { useState, useRef, useEffect, useMemo, useId, useCallback } from "react";
import { PropertySummary } from "@/app/types/property";
import { calendarCode, useOnDemand } from "@/app/lib/on-demand";

interface MapFiltersProps {
  selectedCity: string;
  setSelectedCity: (city: string) => void;
  minGuests: number;
  setMinGuests: (n: number) => void;
  availStart: string;
  setAvailStart: (d: string) => void;
  availEnd: string;
  setAvailEnd: (d: string) => void;
  /** Live property data — cities are derived dynamically */
  properties?: PropertySummary[];
}

/** The three panels the pill can show. Exactly one is open at a time. */
type Section = "where" | "who" | "when";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * `yyyy-MM-dd` → `MM/dd`, for the pill.
 *
 * This was `format(new Date(iso + "T00:00:00"), "MM/dd")`, which kept
 * date-fns on the homepage's critical path for two digits and a slash. The
 * strings only ever come from `format(date, "yyyy-MM-dd")` in the calendar,
 * so the zero-padded month and day are already in them: reading them out
 * gives the same answer without the library.
 */
function monthDay(iso: string): string {
  return `${iso.slice(5, 7)}/${iso.slice(8, 10)}`;
}

/**
 * The height of the calendar in a five-week month, which is most of them.
 * Held by the popover while the calendar's code is on its way, so the panel
 * opens at close to its final size rather than growing into it.
 */
const CALENDAR_PENDING_HEIGHT = 291;

export function MapFilters({
  selectedCity,
  setSelectedCity,
  minGuests,
  setMinGuests,
  availStart,
  setAvailStart,
  availEnd,
  setAvailEnd,
  properties = [],
}: MapFiltersProps) {
  const [openSection, setOpenSection] = useState<Section | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  /**
   * Whether this device has a real pointer that can hover.
   *
   * The sections used to open on `onMouseEnter` alone, on non-focusable
   * `<div>`s. On a phone that is not a slow path to the filters, it is no path
   * at all — and a tap that synthesises a mouseenter would open and
   * immediately re-toggle the panel. Hover is now strictly an enhancement,
   * applied only where hover genuinely exists. Tap, click, Enter and Space
   * work everywhere.
   *
   * Starts false so the server render and the first client render agree; the
   * effect below corrects it before any pointer event can arrive.
   */
  const [canHover, setCanHover] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(hover: hover) and (pointer: fine)");
    const sync = () => setCanHover(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  // Stable ids — this component is rendered twice on the page (the map pill
  // and the mobile one inside the list), so hardcoded ids would collide.
  const baseId = useId();
  const panelId = (section: Section) => `${baseId}-${section}`;

  const triggerRefs = useRef<Record<Section, HTMLButtonElement | null>>({
    where: null,
    who: null,
    when: null,
  });
  const panelRefs = useRef<Record<Section, HTMLDivElement | null>>({
    where: null,
    who: null,
    when: null,
  });
  /**
   * The "When" calendar's code, downloaded on demand. It is asked for as soon
   * as the visitor points at or tabs into the pill (see the bar below), so it
   * is normally here before the popover opens; opening it asks regardless.
   */
  const calendar = useOnDemand(calendarCode, openSection === "when");
  const calendarSettled = calendar.status === "loaded" || calendar.status === "failed";

  /** Set when a panel was opened deliberately (click / Enter / Space), so
   *  focus follows it in. Hover-opened panels never steal focus. */
  const pendingFocus = useRef<Section | null>(null);

  useEffect(() => {
    const section = pendingFocus.current;
    // The calendar popover has nothing to focus until its code is here, so
    // the move waits for it rather than being dropped.
    if (section === "when" && openSection === "when" && !calendarSettled) return;
    pendingFocus.current = null;
    if (!section || openSection !== section) return;
    panelRefs.current[section]
      ?.querySelector<HTMLElement>(FOCUSABLE)
      ?.focus({ preventScroll: true });
  }, [openSection, calendarSettled]);

  const closeAll = useCallback(() => setOpenSection(null), []);

  /** Close and put focus back where the visitor left it. */
  const closeAndReturnFocus = useCallback((section: Section) => {
    setOpenSection(null);
    triggerRefs.current[section]?.focus({ preventScroll: true });
  }, []);

  // Only close when clicking outside the pill
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (barRef.current && !barRef.current.contains(event.target as Node)) {
        closeAll();
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [closeAll]);

  /** Pointer hover — an enhancement, never the only way in. */
  const handleHover = (section: Section) => {
    if (!canHover) return;
    setOpenSection(section);
  };

  /** Tap, click, Enter and Space all land here (Enter/Space fire click on a
   *  button, which is exactly why these are buttons now). */
  const handleActivate = (section: Section) => {
    const willOpen = openSection !== section;
    pendingFocus.current = willOpen ? section : null;
    setOpenSection(willOpen ? section : null);
  };

  /** Escape closes whatever is open, from anywhere inside the pill. */
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "Escape" || !openSection) return;
    event.stopPropagation();
    closeAndReturnFocus(openSection);
  };

  /** Tabbing out of the pill closes the panel behind you. A null
   *  relatedTarget means focus went nowhere focusable — a click on padding,
   *  say — which the outside-mousedown handler already covers, so leave it. */
  const handleBlur = (event: React.FocusEvent) => {
    const next = event.relatedTarget as Node | null;
    if (!next || !barRef.current || barRef.current.contains(next)) return;
    closeAll();
  };

  // Derive city list from live Firestore data — only cities with ≥1 listing appear
  const cities = useMemo(() => {
    const citySet = new Set<string>();
    for (const p of properties) {
      const city = p.addressDetails?.city;
      if (city) citySet.add(city);
    }
    const sorted = Array.from(citySet).sort((a, b) => a.localeCompare(b));
    return ["All Cities", ...sorted];
  }, [properties]);

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
    const from = monthDay(availStart);
    if (!availEnd) return `${from} → MM/DD`;
    const to = monthDay(availEnd);
    return `${from} → ${to}`;
  }, [availStart, availEnd]);

  const guestsValue = minGuests > 0 ? `${minGuests} guest${minGuests > 1 ? "s" : ""}` : "Add guests";
  const cityValue = selectedCity !== "All Cities" ? selectedCity : "Search destinations";

  return (
    <div
      className={`${styles.bar} mapFiltersBar`}
      ref={barRef}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      // Pointing at the pill or tabbing into it is the cue to start the
      // calendar's download, ahead of the "When" popover that needs it.
      onPointerEnter={calendarCode.preload}
      onFocus={calendarCode.preload}
    >
      <div className={styles.pill} role="group" aria-label="Filter properties">
        {/* Each trigger takes its accessible name from its own visible text —
            "Where Search destinations", "Who 2 guests" — so the name a screen
            reader announces and the name a speech-recognition user can say
            are the same string. An aria-label reading "Where: Search
            destinations" was nearly that, and failed axe's
            label-content-name-mismatch on the colon alone. */}
        {/* ── Where ── */}
        <button
          type="button"
          ref={(el) => { triggerRefs.current.where = el; }}
          className={`${styles.section} ${openSection === "where" ? styles.sectionActive : ""}`}
          aria-expanded={openSection === "where"}
          aria-controls={panelId("where")}
          onMouseEnter={() => handleHover("where")}
          onClick={() => handleActivate("where")}
        >
          <span className={styles.sectionLabel}>Where</span>
          <span className={`${styles.sectionValue} ${selectedCity !== "All Cities" ? styles.filled : ""}`}>
            {cityValue}
          </span>
        </button>

        <div className={styles.divider} />

        {/* ── Who ── */}
        <button
          type="button"
          ref={(el) => { triggerRefs.current.who = el; }}
          className={`${styles.section} ${openSection === "who" ? styles.sectionActive : ""}`}
          aria-expanded={openSection === "who"}
          aria-controls={panelId("who")}
          onMouseEnter={() => handleHover("who")}
          onClick={() => handleActivate("who")}
        >
          <span className={styles.sectionLabel}>Who</span>
          <span className={`${styles.sectionValue} ${minGuests > 0 ? styles.filled : ""}`}>
            {guestsValue}
          </span>
        </button>

        <div className={styles.divider} />

        {/* ── When ── */}
        <button
          type="button"
          ref={(el) => { triggerRefs.current.when = el; }}
          className={`${styles.section} ${styles.sectionLast} ${openSection === "when" ? styles.sectionActive : ""}`}
          aria-expanded={openSection === "when"}
          aria-controls={panelId("when")}
          onMouseEnter={() => handleHover("when")}
          onClick={() => handleActivate("when")}
        >
          <span className={styles.sectionLabel}>When</span>
          <span className={`${styles.sectionValue} ${availStart ? styles.filled : ""}`}>
            {datesValue}
          </span>
        </button>

        {hasActiveFilters && (
          <button
            type="button"
            className={styles.clearBtn}
            onClick={clearAll}
            title="Clear all filters"
            aria-label="Clear all filters"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {/* Panels are siblings of the pill, not children of a section: they stay
          open while the pointer travels from the trigger down into them. */}
      {openSection === "where" && (
        <div
          id={panelId("where")}
          ref={(el) => { panelRefs.current.where = el; }}
          className={styles.dropdown}
          role="group"
          aria-label="City"
          style={{ left: 0, right: 'auto', minWidth: '180px' }}
        >
          {cities.map((city) => (
            <button
              key={city}
              type="button"
              className={`${styles.dropdownOption} ${selectedCity === city ? styles.selected : ""}`}
              aria-pressed={selectedCity === city}
              onClick={() => {
                setSelectedCity(city);
                closeAndReturnFocus("where");
              }}
            >
              {city}
            </button>
          ))}
        </div>
      )}

      {openSection === "when" && (
        <div
          id={panelId("when")}
          ref={(el) => { panelRefs.current.when = el; }}
          className={styles.calendarPopover}
          role="group"
          aria-label="Check-in and check-out dates"
          aria-busy={calendarSettled ? undefined : true}
        >
          {calendar.status === "loaded" ? (
            <calendar.value.FilterCalendar
              availStart={availStart}
              availEnd={availEnd}
              setAvailStart={setAvailStart}
              setAvailEnd={setAvailEnd}
              className={styles.calendarDayPicker}
            />
          ) : calendar.status === "failed" ? (
            // A failed chunk cannot be fetched again in the same page (see
            // app/lib/on-demand.ts); a reload is the only retry that works.
            <button type="button" className={styles.dropdownOption} onClick={() => window.location.reload()}>
              The calendar could not be loaded. Reload the page
            </button>
          ) : (
            <div style={{ height: CALENDAR_PENDING_HEIGHT }} />
          )}
        </div>
      )}

      {openSection === "who" && (
        <div
          id={panelId("who")}
          ref={(el) => { panelRefs.current.who = el; }}
          className={styles.guestsPanel}
          role="group"
          aria-label="Number of guests"
        >
          <span className={styles.guestsPanelLabel} id={`${baseId}-guests-label`}>Guests</span>
          <div className={styles.stepperControls}>
            <button
              type="button"
              className={styles.stepperBtn}
              onClick={() => setMinGuests(Math.max(0, minGuests - 1))}
              disabled={minGuests <= 0}
              aria-label="One fewer guest"
            >−</button>
            <span
              className={styles.stepperCount}
              role="status"
              aria-live="polite"
              aria-labelledby={`${baseId}-guests-label`}
            >{minGuests}</span>
            <button
              type="button"
              className={styles.stepperBtn}
              onClick={() => setMinGuests(Math.min(20, minGuests + 1))}
              aria-label="One more guest"
            >+</button>
          </div>
        </div>
      )}
    </div>
  );
}
