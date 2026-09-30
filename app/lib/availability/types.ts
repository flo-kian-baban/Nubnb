/**
 * Availability: the stored copy of every property's calendar, and the shapes
 * the admin page works from (dispatch 22, 2026-09-30).
 *
 * Everything in this module is pure and dependency-free, so the scheduled
 * Cloud Function in functions/ can run the same code the admin page and the
 * Vercel routes run. Nothing here imports Next, Firebase or date-fns. Days
 * are `yyyy-mm-dd` strings on the Toronto calendar; a night is the day it
 * starts; a range's `end` is the checkout day, exclusive, as Airbnb's feeds
 * have it.
 */

/** What one calendar event means. Airbnb exports exactly two kinds (see AVAILABILITY-SEARCH-PLAN.md §1.1). */
export type EventKind = 'reserved' | 'blocked';

/**
 * One event as stored. The feed's DESCRIPTION (a reservation URL and a
 * guest's phone digits) is never kept; the UID is Airbnb's opaque event ID
 * and is what tells a new reservation from an old one across refreshes.
 */
export interface AvailabilityEvent {
  uid: string;
  kind: EventKind;
  /** yyyy-mm-dd, the first night. */
  start: string;
  /** yyyy-mm-dd, the checkout day, exclusive. */
  end: string;
}

export type FeedStatus = 'ok' | 'failed' | 'no-feed';

/** What the refresh recorded about a property's Airbnb listing page, when it checked. */
export interface AirbnbPageCheck {
  checkedAt: string;
  /** The HTTP status Airbnb answered, 0 when the request itself failed. */
  status: number;
  /** "gone" only on a clean 410 or 404; "live" only on a clean 200; anything else is "unknown". */
  verdict: 'live' | 'gone' | 'unknown';
}

export interface PropertyAvailability {
  name: string;
  /** The feed the events came from, as read at refresh time. */
  icalUrl: string;
  status: FeedStatus;
  /** ISO time of the last successful read; null when this feed has never been read. */
  fetchedAt: string | null;
  /** Present while `status` is "failed": since when, how many runs, and the last error. */
  failedSince?: string;
  failures?: number;
  error?: string;
  bytes: number;
  eventCount: number;
  /** Every event that ends after the day before the refresh; past events are dropped. */
  events: AvailabilityEvent[];
  airbnbPage?: AirbnbPageCheck;
}

export interface RefreshRun {
  source: 'schedule' | 'manual';
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** Feeds that answered this run. */
  fetched: number;
  failed: { propertyId: string; name: string; error: string }[];
  /** Listing pages checked this run; 0 when the check did not run. */
  pagesChecked: number;
}

/** The document at availability_snapshots/current, and each availability_days/{day}. */
export interface AvailabilitySnapshot {
  version: 1;
  /** ISO time of the run that wrote this document. */
  refreshedAt: string;
  /** The Toronto day of that run. Nights before it are not in the document. */
  today: string;
  /** The last day any feed can speak for: today + 365. */
  horizonEnd: string;
  run: RefreshRun;
  properties: Record<string, PropertyAvailability>;
}

/** The slice of a property document the search and the ranking read. Built by the page from `Property`. */
export interface AvailabilityProperty {
  id: string;
  name: string;
  slug: string;
  city: string;
  area: string;
  location: string;
  type: string;
  guests: number;
  bedrooms: number;
  bathrooms: number;
  nightly: number;
  minNights: number;
  cleaningFee: number;
  coverImage: string;
  airbnbUrl: string;
  /** Names of the offers marked available, for text search ("hot tub", "parking"). */
  offerNames: string[];
}

export type NightState = 'open' | 'reserved' | 'blocked';

export type BedroomsFilter = 'any' | '0' | '1' | '2' | '3' | '4+';

export interface SearchQuery {
  /** yyyy-mm-dd; both empty means "no dates". */
  checkIn: string;
  checkOut: string;
  guests: number | null;
  city: string | null;
  bedrooms: BedroomsFilter;
  type: string | null;
  maxNightly: number | null;
  text: string;
}

/** Why a property is where it is in the answer, in the caller's terms. */
export interface Reason {
  kind: 'fits' | 'dates' | 'guests' | 'city' | 'bedrooms' | 'type' | 'price' | 'minNights' | 'feed';
  text: string;
  /** True when this reason is a miss (counts towards "near"), false when it is a note on a fit. */
  miss: boolean;
}

export interface SearchRow {
  property: AvailabilityProperty;
  /** One state per requested night, in order; empty when no dates were asked. */
  nights: NightState[];
  /** yyyy-mm-dd of each requested night, parallel to `nights`. */
  nightDays: string[];
  openNights: number;
  reasons: Reason[];
  /** How many conditions this property missed; 0 on a fit. */
  missed: number;
  /** Nights × nightly for the stay asked, plus the cleaning fee, in dollars. Null without dates. */
  stayTotal: number | null;
  /** Open nights in the next 30 when no dates were asked. */
  openNext30: number | null;
  feed: PropertyAvailability | null;
}

export interface SearchResult {
  fits: SearchRow[];
  near: SearchRow[];
  /** Properties blocked for the whole year ahead, listed apart so the count is visible. */
  yearBlocked: SearchRow[];
  /** Properties whose booking window closes before the checkout asked; they cannot answer. */
  beyondWindow: AvailabilityProperty[];
  /** Properties whose feed has failed and have never been read: they cannot answer. */
  unread: AvailabilityProperty[];
  /** The three properties closest to answering when nothing fits and nothing is near. */
  closest: { property: AvailabilityProperty; text: string }[];
  nights: number;
}

/**
 * What "booked in the last 7 days" is counted against: the reservation UIDs
 * each property held in the oldest daily snapshot of the last week. A
 * property absent from `reserved` had no readable calendar that day.
 */
export interface HistoryView {
  day: string;
  reserved: Record<string, string[]>;
}

export type AttentionGroup = 'ranked' | 'fullyBooked' | 'blockedAll';

export interface AttentionRow {
  property: AvailabilityProperty;
  group: AttentionGroup;
  /** Nights with no event in the horizon. */
  empty: number;
  /** Empty nights in runs at least the property's minimum stay long: the nights it could sell as listed. */
  sellable: number;
  longestRun: number;
  booked: number;
  blocked: number;
  /** sellable × nightly, dollars: what the ranking sorts by. */
  value: number;
  /** empty × nightly, dollars: shown beside it. */
  rawValue: number;
  airbnbGone: boolean;
  feed: PropertyAvailability | null;
  /** Reservations present now that were not in the snapshot `sinceDay` days ago; null without history. */
  recentBookings: number | null;
}

export interface AttentionResult {
  horizon: number;
  ranked: AttentionRow[];
  fullyBooked: AttentionRow[];
  blockedAll: AttentionRow[];
  /** Properties with no readable calendar: listed, never ranked. */
  unread: AttentionRow[];
  totals: { value: number; rawValue: number; withSellable: number };
  /** The day the "recent bookings" comparison is against, when history exists. */
  sinceDay: string | null;
}

/** The two home tiles, and the staleness every screen shows. */
export interface HomeFigures {
  value30: number;
  rawValue30: number;
  withSellable30: number;
  fullyBooked30: number;
  blockedAll30: number;
  weekend: { checkIn: string; checkOut: string; free: number; of: number };
  refreshedAt: string;
  ageMinutes: number;
  stale: boolean;
  failed: number;
}
