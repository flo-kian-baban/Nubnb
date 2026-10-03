/**
 * A property's calendar link, read on the server for a public route.
 *
 * Dispatch 26: the link (`icalUrl`) never reaches a browser. It is Airbnb's
 * export link with its secret key, and the feed behind it carries each
 * reservation's link and the last digits of the guest's phone. A public route
 * that needs the calendar takes the property's ID and reads the link here,
 * through the Admin SDK.
 *
 * An unlisted property (Kian's ruling of 2026-10-03) answers like one that
 * does not exist.
 */

import { getAdminDb } from './admin';
import { PROPERTY_VISIBILITY_COLLECTION } from './server-visibility';

export type CalendarLink =
  | { kind: 'not-found' }
  | { kind: 'none' }
  | { kind: 'link'; url: string };

/** Property IDs are Firestore auto IDs; anything else is not one of ours. */
export function isPropertyId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9]{1,64}$/.test(value);
}

/** @throws if the read fails, which is not the same answer as "no such property". */
export async function readCalendarLink(id: string): Promise<CalendarLink> {
  const db = getAdminDb();
  const [snap, mark] = await db.getAll(
    db.collection('properties').doc(id),
    db.collection(PROPERTY_VISIBILITY_COLLECTION).doc(id),
    { fieldMask: ['icalUrl', 'unlisted'] },
  );
  if (!snap.exists) return { kind: 'not-found' };
  if (mark.exists && mark.data()?.unlisted === true) return { kind: 'not-found' };
  const raw = snap.data()?.icalUrl;
  const url = typeof raw === 'string' ? raw.trim() : '';
  return url ? { kind: 'link', url } : { kind: 'none' };
}
