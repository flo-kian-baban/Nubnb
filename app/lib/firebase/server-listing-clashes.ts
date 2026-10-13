/**
 * The duplicate check on a property's Airbnb listing and calendar (dispatch 34, P3; Kian's ruling of
 * 2026-10-12: refused on create, warned about on save). The comparison is listing-identity.ts's; this reads
 * every other property's name and two links to compare with — three fields of each document, nothing else.
 */

import { getAdminDb } from './admin';
import { CALENDAR_MISMATCH_TEXT, calendarRoomMismatch, clashText, listingClashes, type ListingLinks } from '@/app/lib/listing-identity';

/** A link to name in the editor, at its field. */
export interface LinkIssue {
  path: 'airbnbUrl' | 'icalUrl';
  message: string;
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * The other properties holding the same listing or calendar (`duplicates`), and a calendar link whose Airbnb
 * room is not the listing's (`mismatch`). `excludeId` is the property being saved.
 *
 * @throws if the read fails.
 */
export async function listingIssues(candidate: ListingLinks, excludeId: string | null): Promise<{ duplicates: LinkIssue[]; mismatch: LinkIssue[] }> {
  const snapshot = await getAdminDb().collection('properties').select('name', 'airbnbUrl', 'icalUrl').get();
  const others = snapshot.docs
    .filter((doc) => doc.id !== excludeId)
    .map((doc) => ({ id: doc.id, name: text(doc.get('name')), airbnbUrl: text(doc.get('airbnbUrl')), icalUrl: text(doc.get('icalUrl')) }));
  const duplicates = listingClashes(candidate, others).map((clash): LinkIssue => ({ path: clash.field, message: clashText(clash) }));
  const mismatch: LinkIssue[] = calendarRoomMismatch(candidate) ? [{ path: 'icalUrl', message: CALENDAR_MISMATCH_TEXT }] : [];
  return { duplicates, mismatch };
}
