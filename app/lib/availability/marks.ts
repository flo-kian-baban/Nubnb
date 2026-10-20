/**
 * The marks a result row carries beside its reasons (the Availability page, round 1, 2026-10-19), the same on a search
 * row and on a ranking row, each in the caller's words:
 *
 *   "Not on Airbnb · checked Sep 30"   the property's Airbnb page answered gone when it was last checked (Kian's ruling
 *                                      K3: the mark shows its check date; the check itself is not revived)
 *   "Not on the site"                  the property is unlisted (Kian's ruling K5); excluded-from-reporting is not marked
 *   "calendar read Oct 18, 12:13"      the row's calendar copy is older than the run that wrote the copy, or its last
 *                                      read failed: what the row shows is from that earlier read
 *
 * Pure and dependency-free, like types.ts.
 */

import type { AvailabilityProperty, PropertyAvailability } from './types';

export type MarkTone = 'gone' | 'site' | 'stale';

export interface RowMark {
  text: string;
  tone: MarkTone;
}

/** "Sep 30": the Toronto day of an instant. */
const dayOf = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', month: 'short', day: 'numeric' }).format(new Date(iso));
/** "Oct 18, 12:13": the Toronto day and time of an instant. */
const whenOf = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));

/**
 * Whether the row's copy is behind the run: its last good read is older than the copy's own time (`runAt`), or the last
 * read failed. A calendar read by the run that wrote the copy carries no mark.
 */
export function readBehindRun(feed: PropertyAvailability | null | undefined, runAt: string | null): string | null {
  if (!feed || feed.fetchedAt === null) return null;
  if (feed.status === 'failed') return feed.fetchedAt;
  if (runAt !== null && Date.parse(feed.fetchedAt) < Date.parse(runAt)) return feed.fetchedAt;
  return null;
}

/** The marks for one row, in a fixed order: the site, Airbnb, then the calendar's read. */
export function rowMarks(property: Pick<AvailabilityProperty, 'unlisted'>, feed: PropertyAvailability | null | undefined, runAt: string | null): RowMark[] {
  const marks: RowMark[] = [];
  if (property.unlisted) marks.push({ text: 'Not on the site', tone: 'site' });
  if (feed?.airbnbPage?.verdict === 'gone') marks.push({ text: `Not on Airbnb · checked ${dayOf(feed.airbnbPage.checkedAt)}`, tone: 'gone' });
  const behind = readBehindRun(feed, runAt);
  if (behind !== null) marks.push({ text: `calendar read ${whenOf(behind)}`, tone: 'stale' });
  return marks;
}
