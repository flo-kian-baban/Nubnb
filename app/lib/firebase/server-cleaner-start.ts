/**
 * What the cleaner app needs when it opens, read in one go for the signed-in
 * cleaner: the properties they can log against, the ones they logged against
 * most recently, and the item names already in use.
 *
 * ── What a cleaner sees ──
 * Property names and cities, which the public site shows anyway; their own
 * recent properties, from their own entries; and item names from everyone's
 * newest entries — the words only, never who typed them, for which property,
 * when, or for how much. No other cleaner's entry reaches a cleaner.
 *
 * ── Item names ──
 * Names that differ only in capitals, accents or spacing are one name,
 * offered in the spelling used most, so that the same thing is picked rather
 * than typed a new way. The most used come first.
 *
 * ── Reads ──
 * One per property (name and address only), one per entry of this cleaner's
 * (property and date only), and at most ITEM_SOURCE_ENTRIES of everyone's
 * newest entries (lines only) — so the cost of opening the app stops growing
 * once there are that many entries. Every query uses Firestore's automatic
 * single-field indexes.
 *
 * Failure contract, as in server-leads.ts: a failed read THROWS. It never
 * returns an empty list.
 */

import { getAdminDb } from './admin';
import { listCleanerFacingNames } from './server-property-names';
import { isDocumentId } from './server-leads';
import { COST_ENTRIES_COLLECTION, type CleanerProperty, type CleanerStart } from '@/app/lib/cleaners/model';
import { fold } from '@/app/lib/cleaners/text';

/** How many of the newest entries item names are drawn from. */
const ITEM_SOURCE_ENTRIES = 300;

/** How many item names are offered at most. */
const ITEM_NAMES_MAX = 500;

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** The cleaner-facing name when an admin has set one (dispatch 21), else the real name. */
function toProperty(id: string, fields: Record<string, unknown>, cleanerFacing: Map<string, string>): CleanerProperty {
  const address = fields.addressDetails;
  const city =
    address && typeof address === 'object' ? text((address as Record<string, unknown>).city) : null;
  return { id, name: cleanerFacing.get(id) ?? text(fields.name), city };
}

/** Distinct property IDs from this cleaner's entries, the one logged against last first. */
function recentFirst(entries: Record<string, unknown>[]): string[] {
  const latest = new Map<string, string>();
  for (const entry of entries) {
    const { propertyId, createdAt } = entry;
    if (typeof propertyId !== 'string' || !isDocumentId(propertyId)) continue;
    // ISO-8601 UTC strings sort as time does. A missing date sorts oldest.
    const at = typeof createdAt === 'string' ? createdAt : '';
    if (!latest.has(propertyId) || at > latest.get(propertyId)!) latest.set(propertyId, at);
  }
  return [...latest.entries()]
    .sort((a, b) => (a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] < b[1] ? 1 : -1))
    .map(([id]) => id);
}

/**
 * The item names on these entries, one per folded name, in the spelling used
 * most (on a tie, the one seen first — the newest), most used first.
 */
function itemNames(entries: Record<string, unknown>[]): string[] {
  const byKey = new Map<string, { count: number; spellings: Map<string, number> }>();
  for (const entry of entries) {
    if (!Array.isArray(entry.lines)) continue;
    for (const line of entry.lines) {
      const name = line && typeof line === 'object' ? (line as Record<string, unknown>).name : null;
      if (typeof name !== 'string') continue;
      const spelling = name.trim().replace(/\s+/g, ' ');
      const key = fold(spelling);
      if (key === '') continue;

      const seen = byKey.get(key) ?? { count: 0, spellings: new Map<string, number>() };
      seen.count += 1;
      seen.spellings.set(spelling, (seen.spellings.get(spelling) ?? 0) + 1);
      byKey.set(key, seen);
    }
  }

  return [...byKey.values()]
    .map(({ count, spellings }) => {
      // Map order is insertion order, so on a tie the first seen is kept.
      let best = '';
      let bestCount = 0;
      for (const [spelling, n] of spellings) {
        if (n > bestCount) {
          best = spelling;
          bestCount = n;
        }
      }
      return { name: best, count };
    })
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'en-CA'))
    .slice(0, ITEM_NAMES_MAX)
    .map(({ name }) => name);
}

/**
 * Everything the cleaner app shows before the first entry is typed.
 *
 * @throws if any of the three reads fails.
 */
export async function readCleanerStart(cleanerId: string): Promise<Omit<CleanerStart, 'cleaner'>> {
  const db = getAdminDb();
  const entries = db.collection(COST_ENTRIES_COLLECTION);

  const [properties, cleanerFacing, own, newest] = await Promise.all([
    db.collection('properties').select('name', 'addressDetails').get(),
    listCleanerFacingNames(),
    entries.where('cleanerId', '==', cleanerId).select('propertyId', 'createdAt').get(),
    // `createdAt` is on every entry, so ordering by it drops none of them.
    entries.orderBy('createdAt', 'desc').limit(ITEM_SOURCE_ENTRIES).select('lines').get(),
  ]);

  return {
    properties: properties.docs
      .map((doc) => toProperty(doc.id, doc.data(), cleanerFacing))
      .sort((a, b) => fold(a.name ?? '').localeCompare(fold(b.name ?? ''), 'en-CA') || a.id.localeCompare(b.id)),
    recentPropertyIds: recentFirst(own.docs.map((doc) => doc.data())),
    itemNames: itemNames(newest.docs.map((doc) => doc.data())),
  };
}
