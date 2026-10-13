/**
 * Deleting a property (dispatch 34, P1).
 *
 * Kian's ruling of 2026-10-12: a property with drafts, statements, accepted
 * income, title links or cost entries cannot be deleted; the page points to
 * Unlisted and Exclude from reporting instead, which take it off the public
 * site and out of reporting with nothing erased.
 *
 * A property holding none of these is deleted together with the records
 * that only describe it, so none is left pointing at nothing: its unlisted
 * mark (dispatch 29), its owner record (`property_management`: Report For,
 * owners, statement months, default fee rate — no money) and its
 * cleaner-facing name.
 *
 * One transaction: the five reads that say what the property holds, then
 * the four deletes. A draft, an entry or a link written meanwhile makes the
 * transaction retry and the delete refuse. The reads are counted and named
 * in the refusal; nothing is read but the documents' IDs and what decides
 * whether a line was accepted.
 */

import { getAdminDb } from './admin';
import { PROPERTY_VISIBILITY_COLLECTION } from './server-visibility';
import { COST_ENTRIES_COLLECTION, PROPERTY_CLEANER_NAMES_COLLECTION } from '@/app/lib/cleaners/model';
import { EARNINGS_LINES_COLLECTION, EARNINGS_TITLE_LINKS_COLLECTION } from '@/app/lib/income/model';
import { MONTHLY_REPORTS_COLLECTION, MONTHLY_REPORT_DRAFTS_COLLECTION, PROPERTY_MANAGEMENT_COLLECTION } from '@/app/lib/reports/model';

/** What stops a property from being deleted: how many of each it holds. */
export interface PropertyHoldings {
  drafts: number;
  statements: number;
  acceptedIncome: number;
  titleLinks: number;
  costEntries: number;
}

export type DeletePropertyResult = { kind: 'deleted' } | { kind: 'not-found' } | { kind: 'holds-records'; holdings: PropertyHoldings };

/** Whether a property holds anything that stops its delete. */
export function holdsRecords(holdings: PropertyHoldings): boolean {
  return Object.values(holdings).some((count) => count > 0);
}

/** "2 statement drafts and 1 title link": what a property holds, in words. */
export function holdingsText(holdings: PropertyHoldings): string {
  const parts = [
    [holdings.drafts, 'statement draft', 'statement drafts'],
    [holdings.statements, 'finished statement', 'finished statements'],
    [holdings.acceptedIncome, 'accepted income line', 'accepted income lines'],
    [holdings.titleLinks, 'Airbnb title link', 'Airbnb title links'],
    [holdings.costEntries, 'cost entry', 'cost entries'],
  ]
    .filter(([count]) => (count as number) > 0)
    .map(([count, one, many]) => `${count} ${count === 1 ? one : many}`);
  return parts.length <= 1 ? (parts[0] ?? 'nothing') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * Delete the property and the records that only describe it, unless it holds drafts, statements, accepted
 * income, title links or cost entries — then nothing is deleted and what it holds is answered.
 *
 * @throws if the transaction fails: it may or may not have deleted.
 */
export async function deletePropertyUnlessItHoldsRecords(propertyId: string): Promise<DeletePropertyResult> {
  const db = getAdminDb();
  const property = db.collection('properties').doc(propertyId);
  return db.runTransaction(async (tx): Promise<DeletePropertyResult> => {
    const [doc, drafts, statements, lines, links, entries] = await Promise.all([
      tx.get(property),
      tx.get(db.collection(MONTHLY_REPORT_DRAFTS_COLLECTION).where('propertyId', '==', propertyId).select()),
      tx.get(db.collection(MONTHLY_REPORTS_COLLECTION).where('propertyId', '==', propertyId).select()),
      tx.get(db.collection(EARNINGS_LINES_COLLECTION).where('decided.propertyId', '==', propertyId).select('status')),
      tx.get(db.collection(EARNINGS_TITLE_LINKS_COLLECTION).where('propertyId', '==', propertyId).select()),
      tx.get(db.collection(COST_ENTRIES_COLLECTION).where('propertyId', '==', propertyId).select()),
    ]);
    if (!doc.exists) return { kind: 'not-found' };
    const holdings: PropertyHoldings = {
      drafts: drafts.size,
      statements: statements.size,
      acceptedIncome: lines.docs.filter((line) => line.get('status') === 'accepted').length,
      titleLinks: links.size,
      costEntries: entries.size,
    };
    if (holdsRecords(holdings)) return { kind: 'holds-records', holdings };
    // Deleting a document that does not exist is a no-op: each of the three may never have been written.
    tx.delete(property);
    tx.delete(db.collection(PROPERTY_VISIBILITY_COLLECTION).doc(propertyId));
    tx.delete(db.collection(PROPERTY_MANAGEMENT_COLLECTION).doc(propertyId));
    tx.delete(db.collection(PROPERTY_CLEANER_NAMES_COLLECTION).doc(propertyId));
    return { kind: 'deleted' };
  });
}
