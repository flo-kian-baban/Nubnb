/**
 * Which listing a property's links point at (dispatch 34, P3).
 *
 * Kian's ruling of 2026-10-12: a duplicate Airbnb listing or calendar link
 * is refused on create and warned about on save. Two properties hold the
 * same Airbnb listing when their listing links name the same room
 * (`/rooms/<id>`, whatever the domain or the query); the same calendar when
 * their calendar links name the same room (`/calendar/ical/<id>.ics`), or,
 * for a calendar that is not Airbnb's, when the links are the same address.
 * Beside that, a calendar link whose room is not the property's own listing
 * is warned about (Bright Walkout carried CN Tower's calendar).
 *
 * A calendar link carries a secret key: nothing here prints or returns one,
 * only the room ID and the other property's name.
 *
 * Pure and client-safe.
 */

/** An Airbnb host: airbnb.ca, www.airbnb.com, airbnb.co.uk. */
const AIRBNB_HOST = /(^|\.)airbnb\.[a-z]{2,3}(\.[a-z]{2})?$/i;

function parse(url: string | null | undefined): URL | null {
  if (typeof url !== 'string' || url.trim() === '') return null;
  try {
    return new URL(url.trim());
  } catch {
    return null;
  }
}

/** The Airbnb room a listing link names: "https://www.airbnb.ca/rooms/12345?…" → "12345"; null when it names none. */
export function airbnbRoomId(url: string | null | undefined): string | null {
  const parsed = parse(url);
  if (!parsed || !AIRBNB_HOST.test(parsed.hostname)) return null;
  return /\/rooms\/(?:plus\/|luxury\/)?(\d+)/.exec(parsed.pathname)?.[1] ?? null;
}

/** The Airbnb room a calendar link names: "https://www.airbnb.ca/calendar/ical/12345.ics?s=…" → "12345"; null when it names none. */
export function calendarRoomId(url: string | null | undefined): string | null {
  const parsed = parse(url);
  if (!parsed || !AIRBNB_HOST.test(parsed.hostname)) return null;
  return /\/calendar\/ical\/(\d+)\.ics$/i.exec(parsed.pathname)?.[1] ?? null;
}

/** A calendar link as compared when it names no Airbnb room: host without "www.", path, and query. */
function calendarAddress(url: string | null | undefined): string | null {
  const parsed = parse(url);
  return parsed ? `${parsed.hostname.toLowerCase().replace(/^www\./, '')}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}` : null;
}

/** The links a property is compared by. */
export interface ListingLinks {
  airbnbUrl?: string | null;
  icalUrl?: string | null;
}

/** Another property that already holds the listing or the calendar. */
export interface ListingClash {
  field: 'airbnbUrl' | 'icalUrl';
  propertyId: string;
  propertyName: string;
}

/** The other properties that hold the same Airbnb listing or the same calendar as `candidate`. */
export function listingClashes(candidate: ListingLinks, others: (ListingLinks & { id: string; name?: string | null })[]): ListingClash[] {
  const room = airbnbRoomId(candidate.airbnbUrl);
  const calendarRoom = calendarRoomId(candidate.icalUrl);
  const calendar = calendarRoom === null ? calendarAddress(candidate.icalUrl) : null;
  const clashes: ListingClash[] = [];
  for (const other of others) {
    const name = other.name?.trim() || 'Unnamed property';
    if (room !== null && airbnbRoomId(other.airbnbUrl) === room) clashes.push({ field: 'airbnbUrl', propertyId: other.id, propertyName: name });
    const sameCalendar = calendarRoom !== null ? calendarRoomId(other.icalUrl) === calendarRoom : calendar !== null && calendarAddress(other.icalUrl) === calendar;
    if (sameCalendar) clashes.push({ field: 'icalUrl', propertyId: other.id, propertyName: name });
  }
  return clashes;
}

/** Whether the calendar link names another Airbnb room than the listing link: both name one, and they differ. */
export function calendarRoomMismatch(candidate: ListingLinks): boolean {
  const room = airbnbRoomId(candidate.airbnbUrl);
  const calendarRoom = calendarRoomId(candidate.icalUrl);
  return room !== null && calendarRoom !== null && room !== calendarRoom;
}

/** One line for a clash: "This Airbnb listing is already “Cozy Basement In Family Home”." */
export function clashText(clash: ListingClash): string {
  return clash.field === 'airbnbUrl' ? `This Airbnb listing is already “${clash.propertyName}”.` : `This calendar link is already “${clash.propertyName}”'s.`;
}

export const CALENDAR_MISMATCH_TEXT = 'This calendar link is for another Airbnb room than the listing link.';
