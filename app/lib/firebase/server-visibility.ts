/**
 * Unlisted properties (Kian's ruling of 2026-10-03, dispatch 24): an unlisted
 * property does not appear anywhere on the public site — the homepage, the
 * map, its own page, the property API, the sitemap — and stays fully usable
 * inside: the admin, the cleaner app, availability, reporting. It is
 * unreadable by the public, Firestore rules included.
 *
 * The mark is a server-only document, never a field on the world-readable
 * property document:
 *
 *   property_visibility/{propertyId}  { schemaVersion: 1, propertyId,
 *                                       unlisted: true, setAt }
 *
 * It exists only while the property is unlisted; listing the property again
 * deletes it, by its ID. A property with no document is listed, which is
 * every property written before this, so nothing is backfilled.
 *
 * Who asks it: every public read of a property (`server-properties.ts`, the
 * property and booked-dates routes) and `firestore.rules`, whose `get` of a
 * property refuses one that has this document. Admin and cleaner reads do not
 * ask, so an unlisted property works everywhere inside.
 *
 * Failure contract, as in server-properties.ts: a failed read THROWS. A public
 * page that cannot tell whether a property is unlisted fails its render, and
 * Next keeps serving the last good page, rather than risk showing it.
 */

import { getAdminDb } from './admin';
import { isDocumentId } from './server-leads';

export const PROPERTY_VISIBILITY_COLLECTION = 'property_visibility';
export const PROPERTY_VISIBILITY_SCHEMA_VERSION = 1;

/** Whether a stored visibility document marks its property unlisted. Anything else reads as listed. */
function marksUnlisted(fields: Record<string, unknown> | undefined): boolean {
  return fields?.unlisted === true;
}

/**
 * The IDs of every unlisted property. One read of a collection that holds a
 * document only per unlisted property.
 *
 * @throws if the read fails.
 */
export async function unlistedPropertyIds(): Promise<Set<string>> {
  const snapshot = await getAdminDb().collection(PROPERTY_VISIBILITY_COLLECTION).get();
  return new Set(snapshot.docs.filter((doc) => marksUnlisted(doc.data())).map((doc) => doc.id));
}

/**
 * Whether one property is unlisted.
 *
 * @throws if the read fails.
 */
export async function isUnlisted(propertyId: string): Promise<boolean> {
  if (!isDocumentId(propertyId)) return false;
  const doc = await getAdminDb().collection(PROPERTY_VISIBILITY_COLLECTION).doc(propertyId).get();
  return doc.exists && marksUnlisted(doc.data());
}

/** The document that marks a new property unlisted, for a create that writes both at once. */
export function unlistedDocument(propertyId: string, setAt: string) {
  return { schemaVersion: PROPERTY_VISIBILITY_SCHEMA_VERSION, propertyId, unlisted: true, setAt };
}

export type SetUnlistedResult = { kind: 'set'; unlisted: boolean; changed: boolean } | { kind: 'no-such-property' };

/**
 * Unlist a property, or list it again. The property must exist; its document
 * is never touched. Unlisting writes the mark; listing deletes it by the
 * property's ID.
 *
 * @throws if a read or write fails.
 */
export async function setUnlisted(propertyId: string, unlisted: boolean): Promise<SetUnlistedResult> {
  if (!isDocumentId(propertyId)) return { kind: 'no-such-property' };
  const db = getAdminDb();
  const ref = db.collection(PROPERTY_VISIBILITY_COLLECTION).doc(propertyId);
  return db.runTransaction(async (tx): Promise<SetUnlistedResult> => {
    // The property is read for its existence only: its name, not its 30-odd fields.
    const [[property], mark] = await Promise.all([tx.getAll(db.collection('properties').doc(propertyId), { fieldMask: ['name'] }), tx.get(ref)]);
    if (!property.exists) return { kind: 'no-such-property' };
    const was = mark.exists && marksUnlisted(mark.data());
    if (was === unlisted) return { kind: 'set', unlisted, changed: false };
    if (unlisted) tx.set(ref, unlistedDocument(propertyId, new Date().toISOString()));
    else tx.delete(ref);
    return { kind: 'set', unlisted, changed: true };
  });
}
