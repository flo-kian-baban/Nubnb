/**
 * Reading and writing the stored copy in Firestore, through the Admin SDK.
 * The Vercel routes and the Cloud Function both call these with their own
 * `Firestore` instance; nothing here initialises an app.
 *
 * Two server-only collections, denied to browsers in firestore.rules:
 *   availability_snapshots/current   the copy the page reads
 *   availability_days/{yyyy-mm-dd}   the first snapshot of each Toronto day
 */

import { FieldPath, type Firestore } from 'firebase-admin/firestore';
import type { FeedSource } from './snapshot';
import type { AvailabilitySnapshot } from './types';

export const SNAPSHOTS_COLLECTION = 'availability_snapshots';
export const CURRENT_DOC = 'current';
export const DAYS_COLLECTION = 'availability_days';
const PROPERTIES_COLLECTION = 'properties';

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Every property's ID, name and feed URL: the only fields the refresh reads. */
export async function readFeedSources(db: Firestore): Promise<FeedSource[]> {
  const snapshot = await db.collection(PROPERTIES_COLLECTION).select('name', 'icalUrl', 'airbnbUrl').get();
  return snapshot.docs
    .map((doc) => {
      const data = doc.data();
      return { id: doc.id, name: str(data.name), icalUrl: str(data.icalUrl).trim(), airbnbUrl: str(data.airbnbUrl).trim() };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** A light shape check: enough to refuse a document this code did not write. */
export function isSnapshot(data: unknown): data is AvailabilitySnapshot {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  return (
    d.version === 1 &&
    typeof d.refreshedAt === 'string' &&
    typeof d.today === 'string' &&
    typeof d.horizonEnd === 'string' &&
    !!d.run &&
    typeof d.run === 'object' &&
    !!d.properties &&
    typeof d.properties === 'object'
  );
}

export async function readCurrent(db: Firestore): Promise<AvailabilitySnapshot | null> {
  const doc = await db.collection(SNAPSHOTS_COLLECTION).doc(CURRENT_DOC).get();
  const data = doc.exists ? doc.data() : null;
  return isSnapshot(data) ? data : null;
}

/**
 * The oldest daily snapshot kept on or after `fromDay` and before
 * `beforeDay`: what "booked since" is compared against. Null when no day in
 * that range was kept.
 */
export async function readHistoryFrom(
  db: Firestore,
  fromDay: string,
  beforeDay: string,
): Promise<{ snapshot: AvailabilitySnapshot; day: string } | null> {
  const query = await db
    .collection(DAYS_COLLECTION)
    .where(FieldPath.documentId(), '>=', fromDay)
    .where(FieldPath.documentId(), '<', beforeDay)
    .orderBy(FieldPath.documentId())
    .limit(1)
    .get();
  const doc = query.docs[0];
  if (!doc) return null;
  const data = doc.data();
  return isSnapshot(data) ? { snapshot: data, day: doc.id } : null;
}

/**
 * Write the current document, and the day's document if none exists yet.
 * The day document is created, never overwritten: the first snapshot of a
 * day is the one kept.
 */
export async function writeSnapshot(db: Firestore, snapshot: AvailabilitySnapshot): Promise<{ dayWritten: boolean }> {
  await db.collection(SNAPSHOTS_COLLECTION).doc(CURRENT_DOC).set(snapshot);
  try {
    await db.collection(DAYS_COLLECTION).doc(snapshot.today).create(snapshot);
    return { dayWritten: true };
  } catch (err) {
    // ALREADY_EXISTS (gRPC code 6): the day already has its snapshot.
    if ((err as { code?: unknown } | null)?.code === 6) return { dayWritten: false };
    throw err;
  }
}
