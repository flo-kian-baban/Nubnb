/**
 * The name cleaners see for a property (dispatch 21, Kian's ruling of
 * 2026-09-30): `property_cleaner_names/{propertyId}`, one document per
 * property that has one, reached only through the Admin SDK.
 *
 * It is a separate collection, never a field on the property document,
 * because `properties` is world-readable through the client SDK and these
 * names will sometimes be street addresses. firestore.rules denies every
 * browser read and write; admins set a name through their route and
 * cleaners read the names through theirs, and nothing on a public page
 * reads this collection.
 *
 * A property without a document here has no cleaner-facing name, and the
 * cleaner app shows its real name. Clearing a name deletes the document,
 * so "absent" stays the one way of saying "none".
 */

import { getAdminDb } from './admin';
import { isDocumentId } from './server-leads';
import {
  CLEANER_FACING_NAME_MAX,
  PROPERTY_CLEANER_NAMES_COLLECTION,
  PROPERTY_CLEANER_NAME_SCHEMA_VERSION,
} from '@/app/lib/cleaners/model';

const CONTROL_CHARACTER = /\p{Cc}/u;

/** The stored name of one document, or null when it is not a usable string. */
function storedName(fields: Record<string, unknown> | undefined): string | null {
  const name = fields?.name;
  return typeof name === 'string' && name.trim() !== '' ? name : null;
}

/**
 * The name as an admin typed it, in the stored form: NFC, trimmed, at most
 * CLEANER_FACING_NAME_MAX characters, no control characters. Null for an
 * empty name (which means "none"); a string reason when it cannot be stored.
 */
export function normaliseCleanerFacingName(typed: string): { name: string | null } | { problem: string } {
  const name = typed.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (name === '') return { name: null };
  if (name.length > CLEANER_FACING_NAME_MAX) return { problem: `At most ${CLEANER_FACING_NAME_MAX} characters` };
  if (CONTROL_CHARACTER.test(name)) return { problem: 'No control characters' };
  return { name };
}

/**
 * Every cleaner-facing name, by property ID. One read per document in the
 * collection: only properties that have a name are in it.
 *
 * @throws if the read fails.
 */
export async function listCleanerFacingNames(): Promise<Map<string, string>> {
  const snapshot = await getAdminDb().collection(PROPERTY_CLEANER_NAMES_COLLECTION).get();
  const names = new Map<string, string>();
  for (const doc of snapshot.docs) {
    const name = storedName(doc.data());
    if (name !== null) names.set(doc.id, name);
  }
  return names;
}

/** One property's cleaner-facing name, or null when it has none. @throws if the read fails. */
export async function getCleanerFacingName(propertyId: string): Promise<string | null> {
  if (!isDocumentId(propertyId)) return null;
  const doc = await getAdminDb().collection(PROPERTY_CLEANER_NAMES_COLLECTION).doc(propertyId).get();
  return doc.exists ? storedName(doc.data()) : null;
}

export type SetCleanerFacingNameResult =
  | { kind: 'set'; name: string }
  | { kind: 'cleared' }
  /** Nothing to change: the name already said that, or there was none to clear. */
  | { kind: 'unchanged'; name: string | null }
  | { kind: 'no-such-property' };

/**
 * Set a property's cleaner-facing name, or clear it (`null`). The property
 * must exist. Writes one document, or deletes it; the property document is
 * never touched.
 *
 * @throws if a read or write fails.
 */
export async function setCleanerFacingName(propertyId: string, name: string | null): Promise<SetCleanerFacingNameResult> {
  if (!isDocumentId(propertyId)) return { kind: 'no-such-property' };
  const db = getAdminDb();
  const [property] = await db.getAll(db.collection('properties').doc(propertyId), { fieldMask: ['name'] });
  if (!property.exists) return { kind: 'no-such-property' };

  const ref = db.collection(PROPERTY_CLEANER_NAMES_COLLECTION).doc(propertyId);
  const current = await ref.get();
  const was = current.exists ? storedName(current.data()) : null;

  if (name === null) {
    if (!current.exists) return { kind: 'unchanged', name: null };
    await ref.delete();
    return { kind: 'cleared' };
  }
  if (was === name) return { kind: 'unchanged', name };
  await ref.set({
    schemaVersion: PROPERTY_CLEANER_NAME_SCHEMA_VERSION,
    propertyId,
    name,
    setAt: new Date().toISOString(),
  });
  return { kind: 'set', name };
}
