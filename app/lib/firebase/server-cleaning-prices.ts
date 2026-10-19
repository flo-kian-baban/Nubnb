/**
 * Cleaning prices per property, on the server (Kian's ruling of 2026-10-19; the rule and the record's shape are
 * app/lib/cleanings/prices.ts).
 *
 * `property_cleaning_prices/{propertyId}`, one document per property that has prices, reached only through the Admin
 * SDK: firestore.rules' catch-all denies every browser, and the world-readable property document never holds a price
 * (the property save refuses it). Admins set them on the Report For sheet and the property's edit page, through
 * GET/PUT /api/admin/properties/[id]/cleaning-prices, and the sheet's CSV import saves many at once through
 * POST /api/admin/cleaning-prices, one transaction. Every change appends to the record's history (who, when, before,
 * after). Nothing here reaches a cleaner, an owner's file or a public page.
 *
 * Changing a preset never changes an existing cleaning: the cleanings read the record only when one is made (a Mark
 * cleaned, server-cleaning-jobs.ts; a cleaning logged by hand, server-cleanings.ts). Deleting a property deletes its
 * record (server-property-delete.ts).
 *
 * Failure contract: the reads throw when a read fails; the writes return a result naming what happened, "may or may
 * not have landed" included, and never throw.
 */

import type { Transaction } from 'firebase-admin/firestore';
import { getAdminDb } from './admin';
import { isDocumentId } from './server-leads';
import type { Actor } from '@/app/lib/cleaners/model';
import { CLEANING_PRICES_SCHEMA_VERSION, PROPERTY_CLEANING_PRICES_COLLECTION, readCleaningPrices, samePrices, type CleaningPrices, type CleaningPricesRecord } from '@/app/lib/cleanings/prices';

function grpcCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? String(code) : typeof code === 'string' ? code : 'unknown';
}

// ─── Reads ─────────────────────────────────────────────────────

/** A property's prices record, or null when it has none; `unreadable` when the stored document is not in shape. @throws if the read fails. */
export async function getCleaningPrices(propertyId: string): Promise<{ record: CleaningPricesRecord | null; unreadable: boolean }> {
  if (!isDocumentId(propertyId)) return { record: null, unreadable: false };
  const doc = await getAdminDb().collection(PROPERTY_CLEANING_PRICES_COLLECTION).doc(propertyId).get();
  if (!doc.exists) return { record: null, unreadable: false };
  const record = readCleaningPrices(doc.id, doc.data() ?? {});
  if (!record) console.error(`[cleaning-prices] ${PROPERTY_CLEANING_PRICES_COLLECTION}/${propertyId} is not in the written shape`);
  return { record, unreadable: record === null };
}

/** Every property's prices, by property ID (one query); a document not in shape is logged and left out. @throws if the read fails. */
export async function listCleaningPrices(): Promise<Map<string, CleaningPricesRecord>> {
  const snapshot = await getAdminDb().collection(PROPERTY_CLEANING_PRICES_COLLECTION).get();
  const out = new Map<string, CleaningPricesRecord>();
  for (const doc of snapshot.docs) {
    const record = readCleaningPrices(doc.id, doc.data());
    if (record) out.set(doc.id, record);
    else console.error(`[cleaning-prices] ${PROPERTY_CLEANING_PRICES_COLLECTION}/${doc.id} is not in the written shape; left out`);
  }
  return out;
}

/** The two presets alone, for the pages: null where a property has no record. */
export function pricesOf(record: CleaningPricesRecord | null | undefined): CleaningPrices | null {
  return record ? { shortTermCents: record.shortTermCents, longTermCents: record.longTermCents } : null;
}

/**
 * A property's presets inside a transaction (one read), for the cleaning being made: null when it has none, or its
 * record is not in shape (logged; the cleaning then waits for an amount rather than taking a doubtful one).
 */
export async function pricesInTx(tx: Transaction, propertyId: string): Promise<CleaningPrices | null> {
  const snap = await tx.get(getAdminDb().collection(PROPERTY_CLEANING_PRICES_COLLECTION).doc(propertyId));
  if (!snap.exists) return null;
  const record = readCleaningPrices(snap.id, snap.data() ?? {});
  if (!record) {
    console.error(`[cleaning-prices] ${PROPERTY_CLEANING_PRICES_COLLECTION}/${propertyId} is not in the written shape; no preset applied`);
    return null;
  }
  return pricesOf(record);
}

// ─── Writes ────────────────────────────────────────────────────

export type SetCleaningPricesResult = { kind: 'set'; record: CleaningPricesRecord; changed: boolean } | { kind: 'no-such-property' } | { kind: 'failed' };

/** The record as written after a change: the presets, when and who, the history one event longer (or the first record, with its first event). */
function nextRecord(propertyId: string, stored: CleaningPricesRecord | null, prices: CleaningPrices, actor: Actor, at: string): CleaningPricesRecord {
  const before: CleaningPrices = stored ? { shortTermCents: stored.shortTermCents, longTermCents: stored.longTermCents } : { shortTermCents: null, longTermCents: null };
  return {
    schemaVersion: CLEANING_PRICES_SCHEMA_VERSION,
    propertyId,
    shortTermCents: prices.shortTermCents,
    longTermCents: prices.longTermCents,
    setAt: at,
    setBy: actor,
    history: [...(stored?.history ?? []), { at, actor, before, after: { ...prices } }],
  };
}

/**
 * Set a property's two presets, as `actor`. One transaction: the property and the record are read; when the record
 * already says this, nothing is written. Clearing both presets keeps the record (its history says who cleared them).
 */
export async function setCleaningPrices(actor: Actor, propertyId: string, prices: CleaningPrices): Promise<SetCleaningPricesResult> {
  if (!isDocumentId(propertyId)) return { kind: 'no-such-property' };
  const db = getAdminDb();
  const ref = db.collection(PROPERTY_CLEANING_PRICES_COLLECTION).doc(propertyId);
  try {
    return await db.runTransaction(async (tx): Promise<SetCleaningPricesResult> => {
      const [[property], current] = await Promise.all([tx.getAll(db.collection('properties').doc(propertyId), { fieldMask: ['name'] }), tx.get(ref)]);
      if (!property.exists) return { kind: 'no-such-property' };
      const stored = current.exists ? readCleaningPrices(current.id, current.data() ?? {}) : null;
      if (stored && samePrices(stored, prices)) return { kind: 'set', record: stored, changed: false };
      const record = nextRecord(propertyId, stored, prices, actor, new Date().toISOString());
      tx.set(ref, record);
      return { kind: 'set', record, changed: true };
    });
  } catch (err) {
    console.error(`[cleaning-prices] setting them for ${propertyId} failed: grpc code ${grpcCode(err)}`);
    return { kind: 'failed' };
  }
}

export interface ImportRow {
  propertyId: string;
  prices: CleaningPrices;
}

export type ImportCleaningPricesResult =
  | { kind: 'imported'; saved: { propertyId: string; record: CleaningPricesRecord; changed: boolean }[] }
  /** A row names a property that does not exist: nothing is saved. */
  | { kind: 'no-such-property'; propertyIds: string[] }
  /** A property is named twice: nothing is saved. */
  | { kind: 'duplicate'; propertyIds: string[] }
  | { kind: 'failed' };

/**
 * The sheet's import, saved on the admin's confirm (Kian's ruling): every matched row in one transaction, each
 * property's record read and written (or left as it is when it already says this), so either every row is saved or
 * none is. A row naming a property that does not exist refuses the whole import.
 */
export async function importCleaningPrices(actor: Actor, rows: readonly ImportRow[]): Promise<ImportCleaningPricesResult> {
  const ids = rows.map((row) => row.propertyId);
  const duplicates = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  if (duplicates.length > 0) return { kind: 'duplicate', propertyIds: duplicates };
  const bad = ids.filter((id) => !isDocumentId(id));
  if (bad.length > 0) return { kind: 'no-such-property', propertyIds: bad };
  const db = getAdminDb();
  try {
    return await db.runTransaction(async (tx): Promise<ImportCleaningPricesResult> => {
      const [properties, records] = await Promise.all([
        tx.getAll(...ids.map((id) => db.collection('properties').doc(id)), { fieldMask: ['name'] }),
        tx.getAll(...ids.map((id) => db.collection(PROPERTY_CLEANING_PRICES_COLLECTION).doc(id))),
      ]);
      const missing = properties.filter((doc) => !doc.exists).map((doc) => doc.id);
      if (missing.length > 0) return { kind: 'no-such-property', propertyIds: missing };
      const at = new Date().toISOString();
      const saved: { propertyId: string; record: CleaningPricesRecord; changed: boolean }[] = [];
      rows.forEach((row, i) => {
        const current = records[i];
        const stored = current.exists ? readCleaningPrices(current.id, current.data() ?? {}) : null;
        if (stored && samePrices(stored, row.prices)) {
          saved.push({ propertyId: row.propertyId, record: stored, changed: false });
          return;
        }
        const record = nextRecord(row.propertyId, stored, row.prices, actor, at);
        tx.set(db.collection(PROPERTY_CLEANING_PRICES_COLLECTION).doc(row.propertyId), record);
        saved.push({ propertyId: row.propertyId, record, changed: true });
      });
      return { kind: 'imported', saved };
    });
  } catch (err) {
    console.error(`[cleaning-prices] importing ${rows.length} rows failed: grpc code ${grpcCode(err)}`);
    return { kind: 'failed' };
  }
}
