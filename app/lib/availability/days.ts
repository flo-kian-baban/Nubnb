/**
 * Day arithmetic on `yyyy-mm-dd` strings, without a date library, so the
 * module runs unchanged in the Cloud Function. A day index is days since
 * 1970-01-01 in UTC; strings never carry a time, so daylight saving cannot
 * move a night.
 */

export const TIME_ZONE = 'America/Toronto';

const DAY_MS = 86_400_000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function isDay(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DAY.test(value)) return false;
  return dayFromIndex(dayIndex(value)) === value;
}

export function dayIndex(day: string): number {
  return Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)) / DAY_MS;
}

export function dayFromIndex(index: number): string {
  return new Date(index * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  return dayFromIndex(dayIndex(day) + n);
}

/** Nights from check-in to check-out. */
export function nightsBetween(checkIn: string, checkOut: string): number {
  return dayIndex(checkOut) - dayIndex(checkIn);
}

/** The calendar day in Toronto at `at`. */
export function torontoDay(at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(day: string): number {
  return new Date(dayIndex(day) * DAY_MS).getUTCDay();
}

/**
 * The coming weekend as a stay: Friday to Sunday. On a Saturday it is
 * tonight to Sunday; on a Sunday it is the next Friday to Sunday.
 */
export function weekendStay(today: string): { checkIn: string; checkOut: string } {
  const d = weekday(today);
  if (d === 6) return { checkIn: today, checkOut: addDays(today, 1) };
  if (d === 0) return { checkIn: addDays(today, 5), checkOut: addDays(today, 7) };
  const checkIn = addDays(today, (5 - d + 7) % 7);
  return { checkIn, checkOut: addDays(checkIn, 2) };
}

/** "Oct 3" or "Oct 3, 2026". */
export function dayText(day: string, withYear = false): string {
  return new Intl.DateTimeFormat('en-CA', { month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}) }).format(
    new Date(`${day}T12:00:00`),
  );
}

/** "Oct 3 – Oct 5" or "Dec 30 – Jan 2, 2027". */
export function rangeText(checkIn: string, checkOut: string): string {
  const sameYear = checkIn.slice(0, 4) === checkOut.slice(0, 4);
  return `${dayText(checkIn, !sameYear)} – ${dayText(checkOut, true)}`;
}

/** Minutes between two ISO times, floored at 0; NaN when either is unreadable. */
export function minutesBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return NaN;
  return Math.max(0, Math.round((to - from) / 60_000));
}
