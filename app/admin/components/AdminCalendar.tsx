"use client";

/**
 * The calendar inside DateRangeField, loaded on demand (see there): a range
 * of past days, up to `max`, on react-day-picker — the same picker the
 * public site's "When" filter uses, drawn the same way by the field's
 * stylesheet. With `min` set (the Availability page: today onwards) the
 * range looks forward instead: days before `min` cannot be chosen, and the
 * chosen (or first) month sits on the left with the months after it to
 * its right.
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
  /** The first day that can be chosen; none when absent. */
  min?: string;
  /** Months side by side. */
  months: number;
  className?: string;
  onChange: (range: { from: string; to: string }) => void;
}

export function AdminRangeCalendar({ from, to, max, min, months, className, onChange }: AdminRangeCalendarProps) {
  const selected: DateRange | undefined = useMemo(
    () => (from ? { from: parseISO(from), to: to ? parseISO(to) : undefined } : undefined),
    [from, to],
  );
  const latest = max ? parseISO(max) : new Date();
  const earliest = min ? parseISO(min) : null;
  // Looking back: the chosen (or current) month on the right, the months before it to its left.
  // Looking forward (a min): the chosen (or first) month on the left, the months after it to its right.
  const anchor = startOfMonth(earliest ? (from ? parseISO(from) : earliest) : to ? parseISO(to) : from ? parseISO(from) : latest);
  const defaultMonth = earliest || months <= 1 ? anchor : subMonths(anchor, months - 1);

  return (
    <DayPicker
      mode="range"
      numberOfMonths={months}
      selected={selected}
      defaultMonth={defaultMonth}
      startMonth={earliest ? startOfMonth(earliest) : undefined}
      endMonth={startOfMonth(latest)}
      disabled={earliest ? [{ before: earliest }, { after: latest }] : [{ after: latest }]}
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
