"use client";

/**
 * A date range for the admin's filter bars (2026-09-30): one field that
 * reads "Sep 1 – Sep 30, 2026" (or "All time"), and opens a calendar under
 * it — the react-day-picker the public site's "When" filter uses, drawn the
 * same way — with the quick ranges down its left and a note at its foot.
 * Two months side by side; one on a narrow screen. Days after `max` cannot
 * be chosen, nor days before `min` when one is given (the Availability
 * page looks forward from today). A quick range applies and closes; days picked on the calendar
 * apply as they are picked, and the field stays open until a click outside
 * or Escape.
 *
 * The calendar's code (react-day-picker and date-fns) is fetched when the
 * field is first pointed at or opened, through the on-demand loader the
 * public site uses, so no admin page carries it until a date is wanted. The
 * picker's own stylesheet is imported statically here, as the public
 * components do, so the overrides below it in the cascade win.
 */

import "react-day-picker/style.css";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { CalendarDays, ChevronDown, X } from "lucide-react";
import { onDemand, useOnDemand } from "@/app/lib/on-demand";
import styles from "./DateRangeField.module.css";

const calendarCode = onDemand(() => import("./AdminCalendar"));

/** Enough room for two months, so the popover does not jump when the calendar arrives. */
const CALENDAR_PENDING_HEIGHT = 300;

export interface DayRange {
  /** yyyy-mm-dd, or '' for none. */
  from: string;
  to: string;
}

export interface DatePreset extends DayRange {
  key: string;
  label: string;
}

interface DateRangeFieldProps {
  /** What the field is, for a screen reader. */
  label: string;
  from: string;
  to: string;
  onChange: (range: DayRange) => void;
  presets?: DatePreset[];
  /** The last day that can be chosen (yyyy-mm-dd). */
  max?: string;
  /** The first day that can be chosen (yyyy-mm-dd); the field then looks forward. */
  min?: string;
  /** What the field reads with no dates chosen: "All time" unless told otherwise ("Any dates"). */
  emptyText?: string;
  /** A line at the foot of the calendar: what the days mean. */
  note?: string;
  className?: string;
}

const dayText = (day: string, withYear: boolean) =>
  new Intl.DateTimeFormat("en-CA", { month: "short", day: "numeric", ...(withYear ? { year: "numeric" } : {}) }).format(
    new Date(`${day}T12:00:00`),
  );

/** "Sep 1 – Sep 30, 2026"; "From Sep 1, 2026"; "Up to Sep 30, 2026"; "All time" (or the empty text given). */
export function rangeText(from: string, to: string, emptyText = "All time"): string {
  if (!from && !to) return emptyText;
  if (from && !to) return `From ${dayText(from, true)}`;
  if (!from && to) return `Up to ${dayText(to, true)}`;
  return `${dayText(from, from.slice(0, 4) !== to.slice(0, 4))} – ${dayText(to, true)}`;
}

export function DateRangeField({ label, from, to, onChange, presets = [], max, min, emptyText, note, className }: DateRangeFieldProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [months, setMonths] = useState(2);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const calendar = useOnDemand(calendarCode, open);

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  // A press outside closes it without taking the focus back; Escape closes it and does.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  // One month on a narrow screen.
  useEffect(() => {
    const narrow = window.matchMedia("(max-width: 760px)");
    const apply = () => setMonths(narrow.matches ? 1 : 2);
    apply();
    narrow.addEventListener("change", apply);
    return () => narrow.removeEventListener("change", apply);
  }, []);

  const active = presets.find((preset) => preset.from === from && preset.to === to)?.key;
  const set = (range: DayRange) => onChange(range);
  const text = rangeText(from, to, emptyText);

  return (
    <div ref={rootRef} className={`${styles.root} ${className ?? ""}`}>
      <button
        ref={triggerRef}
        type="button"
        className={`${styles.trigger} ${open ? styles.triggerOpen : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={`${id}-popover`}
        aria-label={`${label}: ${text}`}
        title={text}
        onClick={() => (open ? close() : setOpen(true))}
        onPointerEnter={() => calendarCode.preload()}
        onFocus={() => calendarCode.preload()}
      >
        <CalendarDays size={15} className={styles.icon} aria-hidden />
        <span className={styles.value}>{text}</span>
        <ChevronDown size={15} className={styles.chevron} aria-hidden />
      </button>

      {open && (
        <div id={`${id}-popover`} role="dialog" aria-label={label} className={styles.popover}>
          {presets.length > 0 && (
            <div className={styles.presets} role="group" aria-label="Quick ranges">
              {presets.map((preset) => (
                <button
                  key={preset.key}
                  type="button"
                  className={`${styles.preset} ${active === preset.key ? styles.presetActive : ""}`}
                  aria-pressed={active === preset.key}
                  onClick={() => {
                    set({ from: preset.from, to: preset.to });
                    close();
                  }}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          )}
          <div className={styles.calendar} aria-busy={calendar.status === "pending" || undefined}>
            {calendar.status === "loaded" ? (
              <calendar.value.AdminRangeCalendar from={from} to={to} max={max} min={min} months={months} className={styles.dayPicker} onChange={set} />
            ) : calendar.status === "failed" ? (
              // A failed chunk cannot be fetched again in the same page (app/lib/on-demand.ts).
              <button type="button" className={styles.preset} onClick={() => window.location.reload()}>
                The calendar could not be loaded. Reload the page
              </button>
            ) : (
              <div style={{ height: CALENDAR_PENDING_HEIGHT }} />
            )}
            <div className={styles.foot}>
              {note && <span className={styles.note}>{note}</span>}
              {(from || to) && (
                <button type="button" className={styles.clear} onClick={() => set({ from: "", to: "" })}>
                  <X size={13} aria-hidden />
                  <span>Clear dates</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
