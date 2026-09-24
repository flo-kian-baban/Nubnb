"use client";

import { useMemo } from "react";
import { DayPicker, type DateRange } from "react-day-picker";
import { format, differenceInDays, addDays, addYears, eachDayOfInterval, parseISO, isAfter, isBefore, startOfDay } from "date-fns";

/**
 * The two date-range calendars, and the date arithmetic behind them.
 *
 * Never imported statically — only through `calendarCode` in
 * app/lib/on-demand.ts. react-day-picker and date-fns do nothing until a
 * visitor opens a property or the "When" filter, so they are downloaded then
 * rather than with the page. Everything here was moved out of
 * PropertyDetailPanel and MapFilters unchanged; only its home is new.
 *
 * The stylesheet is deliberately not imported here. `react-day-picker/
 * style.css` stays a static import of both of those components, so it keeps
 * its place in the cascade ahead of the module CSS that overrides it. A
 * stylesheet injected when this chunk arrives would land after those
 * overrides and win every tie.
 */

// ─── Booking calendar (detail panel) ──────────────────────────

/** A range picked on the booking calendar, with what the panel needs from it. */
export interface StaySelection {
  /** What the calendar shows as selected. */
  range: DateRange;
  /** `yyyy-MM-dd`, once a check-in is chosen. */
  checkIn?: string;
  /** `yyyy-MM-dd`, once a check-out is chosen. */
  checkOut?: string;
  /** Nights from check-in to check-out, once both are chosen. */
  nights?: number;
}

/**
 * Computed here, when a range is picked, rather than in the panel when it is
 * read: the panel would otherwise need date-fns to do it. Same functions,
 * same inputs, same results.
 */
function describeStay(range: DateRange): StaySelection {
  return {
    range,
    checkIn: range.from ? format(range.from, "yyyy-MM-dd") : undefined,
    checkOut: range.to ? format(range.to, "yyyy-MM-dd") : undefined,
    nights: range.from && range.to ? differenceInDays(range.to, range.from) : undefined,
  };
}

/**
 * The booked ranges from /api/booked-dates, as the individual nights the
 * calendar disables.
 */
export function expandBookedRanges(bookedRanges: { start: string; end: string }[]): Date[] {
  const dates: Date[] = [];

  // Expand each booked range into individual Date objects
  for (const range of bookedRanges) {
    const start = parseISO(range.start);
    const end = parseISO(range.end);
    if (start >= end) continue;
    // eachDayOfInterval is inclusive of start, exclusive-ish — we use addDays to stop before end (checkout day is available)
    const days = eachDayOfInterval({ start, end: addDays(end, -1) });
    dates.push(...days);
  }

  return dates;
}

interface BookingCalendarProps {
  selected: DateRange | undefined;
  /** Nights the iCal feed reports as taken. No range may span one. */
  bookedDates: Date[];
  onSelect: (selection: StaySelection | undefined) => void;
  className: string;
}

export function BookingCalendar({ selected, bookedDates, onSelect, className }: BookingCalendarProps) {
  const oneYearFromNow = addYears(new Date(), 1);

  return (
    <DayPicker
      mode="range"
      selected={selected}
      onSelect={(range) => {
        // If a full range is selected, check for booked days in between
        if (range?.from && range?.to && bookedDates.length > 0) {
          const from = startOfDay(range.from);
          const to = startOfDay(range.to);
          const hasBookedInBetween = bookedDates.some(d => {
            const day = startOfDay(d);
            return (isAfter(day, from) || day.getTime() === from.getTime()) &&
                   isBefore(day, to);
          });
          if (hasBookedInBetween) {
            // Reset selection — don't allow ranges spanning booked days
            onSelect(undefined);
            return;
          }
        }
        onSelect(range ? describeStay(range) : undefined);
      }}
      disabled={[
        { before: new Date() },
        { after: oneYearFromNow },
        ...bookedDates,
      ]}
      startMonth={new Date()}
      endMonth={oneYearFromNow}
      className={className}
    />
  );
}

// ─── "When" filter calendar (map filters) ─────────────────────

interface FilterCalendarProps {
  /** `yyyy-MM-dd`, or empty. */
  availStart: string;
  /** `yyyy-MM-dd`, or empty. */
  availEnd: string;
  setAvailStart: (d: string) => void;
  setAvailEnd: (d: string) => void;
  className: string;
}

export function FilterCalendar({ availStart, availEnd, setAvailStart, setAvailEnd, className }: FilterCalendarProps) {
  const dateRange: DateRange | undefined = useMemo(() => {
    if (!availStart) return undefined;
    const from = new Date(availStart + "T00:00:00");
    const to = availEnd ? new Date(availEnd + "T00:00:00") : undefined;
    return { from, to };
  }, [availStart, availEnd]);

  const today = new Date();
  const oneYearFromNow = addYears(today, 1);

  return (
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
      className={className}
    />
  );
}
