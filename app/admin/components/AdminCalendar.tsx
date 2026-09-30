"use client";

/**
 * The calendar inside DateRangeField, loaded on demand (see there): a range
 * of past days, up to `max`, on react-day-picker — the same picker the
 * public site's "When" filter uses, drawn the same way by the field's
 * stylesheet.
 */

import { useMemo } from "react";
import { DayPicker, type DateRange } from "react-day-picker";
import { format, parseISO, startOfMonth, subMonths } from "date-fns";

interface AdminRangeCalendarProps {
  /** yyyy-mm-dd, or '' for none. */
  from: string;
  to: string;
  /** The last day that can be chosen; today when absent. */
  max?: string;
  /** Months side by side. */
  months: number;
  className?: string;
  onChange: (range: { from: string; to: string }) => void;
}

export function AdminRangeCalendar({ from, to, max, months, className, onChange }: AdminRangeCalendarProps) {
  const selected: DateRange | undefined = useMemo(
    () => (from ? { from: parseISO(from), to: to ? parseISO(to) : undefined } : undefined),
    [from, to],
  );
  const latest = max ? parseISO(max) : new Date();
  // The chosen (or current) month on the right, the months before it to its left.
  const anchor = startOfMonth(to ? parseISO(to) : from ? parseISO(from) : latest);
  const defaultMonth = months > 1 ? subMonths(anchor, months - 1) : anchor;

  return (
    <DayPicker
      mode="range"
      numberOfMonths={months}
      selected={selected}
      defaultMonth={defaultMonth}
      endMonth={startOfMonth(latest)}
      disabled={[{ after: latest }]}
      showOutsideDays={false}
      className={className}
      onSelect={(range) =>
        onChange({
          from: range?.from ? format(range.from, "yyyy-MM-dd") : "",
          to: range?.to ? format(range.to, "yyyy-MM-dd") : "",
        })
      }
    />
  );
}
