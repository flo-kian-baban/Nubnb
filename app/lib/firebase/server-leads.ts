/**
 * Server-side reads, and the one write, for the admin lead inbox.
 *
 * `contact_submissions` holds renters' names, emails and messages.
 * firestore.rules denies every browser read and write of it, so the inbox
 * reaches it only through the admin API routes, which call these functions
 * after checking the admin session.
 *
 * Failure contract, as in server-properties.ts: a failed read THROWS. It never
 * returns an empty list, because an inbox that failed to load must not look
 * like an empty one.
 */

import { DocumentReference, GeoPoint, Timestamp } from 'firebase-admin/firestore';
import { getAdminDb } from './admin';
import { toSlug } from '@/app/lib/slug';
import {
  stayOf,
  toLeadSummary,
  type LeadDetail,
  type LeadFields,
  type LeadStatus,
  type LeadStatusChange,
  type LeadSummary,
  type PropertyLink,
} from '@/app/lib/leads';

const COLLECTION = 'contact_submissions';

/** gRPC status code Firestore reports when `update()` targets a missing document. */
const NOT_FOUND = 5;

/** One Firestore document ID: no slash, not `.` or `..`, not a reserved `__…__` name. */
export function isDocumentId(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= 1500 &&
    !id.includes('/') &&
    id !== '.' &&
    id !== '..' &&
    !/^__.*__$/.test(id)
  );
}

/**
 * A JSON-safe copy of a stored value. Firestore-native types become what JSON
 * can carry — a Timestamp its ISO string, a reference its path — and
 * everything else is returned exactly as stored. The form writes only
 * strings, numbers and one map; this is for a field an admin may have added
 * by hand in the console.
 */
function toPlain(value: unknown): unknown {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (value instanceof DocumentReference) return value.path;
  if (value instanceof GeoPoint) return { latitude: value.latitude, longitude: value.longitude };
  if (Array.isArray(value)) return value.map(toPlain);
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, toPlain(inner)]));
  }
  return value;
}

/** Newest first. A lead with no readable date goes last rather than being dropped. */
function newestFirst(a: LeadSummary, b: LeadSummary): number {
  const ta = Date.parse(a.createdAt ?? '');
  const tb = Date.parse(b.createdAt ?? '');
  const aDated = Number.isFinite(ta);
  const bDated = Number.isFinite(tb);

  if (aDated && bDated && ta !== tb) return tb - ta;
  if (aDated !== bDated) return aDated ? -1 : 1;
  return a.id.localeCompare(b.id);
}

/**
 * Every lead, as inbox rows, newest first.
 *
 * Deliberately no `orderBy('createdAt')`: Firestore leaves out every document
 * that lacks the ordered field, so a lead without one would silently vanish.
 * The collection is read whole and sorted here instead. No pagination: one
 * response carries the whole collection.
 *
 * @throws if the read fails.
 */
export async function listLeads(): Promise<LeadSummary[]> {
  const snapshot = await getAdminDb().collection(COLLECTION).get();
  return snapshot.docs
    .map((doc) => toLeadSummary(doc.id, toPlain(doc.data()) as LeadFields))
    .sort(newestFirst);
}

/**
 * The live listing a stay request names.
 *
 * Looked up by ID rather than by the stored name, so the link still resolves
 * after the listing is renamed. Only `name` and `slug` are read. A failed
 * lookup does not fail the lead — the operator still needs the message.
 */
async function findProperty(propertyId: string): Promise<PropertyLink> {
  if (!isDocumentId(propertyId)) return { state: 'missing' };

  try {
    const db = getAdminDb();
    const [doc] = await db.getAll(db.collection('properties').doc(propertyId), {
      fieldMask: ['name', 'slug'],
    });
    if (!doc.exists) return { state: 'missing' };

    const name = typeof doc.get('name') === 'string' ? (doc.get('name') as string) : '';
    const storedSlug = typeof doc.get('slug') === 'string' ? (doc.get('slug') as string) : '';
    // The canonical slug first, as resolvePropertySlug does; the stored one
    // also resolves there, so it is a valid fallback.
    const slug = toSlug(name) || storedSlug;
    return { state: 'found', name, href: slug ? `/property/${slug}` : null };
  } catch (err) {
    console.error(`[leads] Could not look up property ${propertyId}:`, err);
    return { state: 'unreadable' };
  }
}

/**
 * One lead in full, or null when no document has this ID.
 *
 * @throws if the read fails.
 */
export async function getLead(id: string): Promise<LeadDetail | null> {
  const doc = await getAdminDb().collection(COLLECTION).doc(id).get();
  if (!doc.exists) return null;

  const fields = toPlain(doc.data()) as LeadFields;
  const propertyId = stayOf(fields)?.propertyId;

  return {
    id: doc.id,
    fields,
    property: typeof propertyId === 'string' && propertyId ? await findProperty(propertyId) : null,
  };
}

/**
 * Set a lead's status. Writes exactly two fields, `status` and
 * `statusChangedAt`; nothing else on the document is touched.
 *
 * `update()` never creates a document: on an ID that does not exist it fails
 * with NOT_FOUND, returned here as null.
 *
 * @throws if the write fails for any other reason.
 */
export async function setLeadStatus(
  id: string,
  status: LeadStatus,
): Promise<LeadStatusChange | null> {
  const statusChangedAt = new Date().toISOString();
  try {
    await getAdminDb().collection(COLLECTION).doc(id).update({ status, statusChangedAt });
  } catch (err) {
    if ((err as { code?: unknown }).code === NOT_FOUND) return null;
    throw err;
  }
  return { id, status, statusChangedAt };
}
