/**
 * The Costs page's Month tab, its one read (the Costs page, round 1): everything the month's money needs for every
 * property's statement of one month — every cost entry and cleaning (a late cost and an adjustment can come from any
 * earlier month), every finished statement, the month's drafts, every management record — and every property's
 * names. The rows are worked out by costsMonth (app/lib/costs/month-view.ts), the one calculation's way.
 *
 * Reads: one per entry, cleaning, finished statement, management record and draft of the month, and two per property
 * (its name and its cleaner-facing name).
 *
 * @throws if any read fails: a failed read is never an empty month.
 */

import { getAdminDb } from './admin';
import { COST_ENTRIES_COLLECTION } from '@/app/lib/cleaners/model';
import { CLEANINGS_COLLECTION, cleaningEntryView } from '@/app/lib/cleanings/model';
import { MONTHLY_REPORTS_COLLECTION, MONTHLY_REPORT_DRAFTS_COLLECTION, readMonthlyReport, readStatementDraft } from '@/app/lib/reports/model';
import { entryViewOf } from '@/app/lib/backup/data';
import { costsMonth, type CostsMonth } from '@/app/lib/costs/month-view';
import { readDocs } from './server-cleanings';
import { listManagement } from './server-management';
import { listPropertyNames } from './server-cost-entries';

export async function readCostsMonth(month: string): Promise<CostsMonth> {
  const db = getAdminDb();
  const [entries, cleanings, reports, drafts, management, properties] = await Promise.all([
    db.collection(COST_ENTRIES_COLLECTION).get(),
    db.collection(CLEANINGS_COLLECTION).get(),
    db.collection(MONTHLY_REPORTS_COLLECTION).get(),
    db.collection(MONTHLY_REPORT_DRAFTS_COLLECTION).where('month', '==', month).get(),
    listManagement(),
    listPropertyNames(),
  ]);
  if (properties === null) throw new Error('the property names could not be read');
  return costsMonth({
    month,
    properties,
    // As the statements read them: names are display only, and no row needs a cleaner's.
    entries: [
      ...entries.docs.map((doc) => entryViewOf(doc.id, doc.data())),
      ...readDocs(cleanings.docs).map((c) => cleaningEntryView({ ...c, cleaner: { state: 'found', name: c.cleanerNameAtEntry, status: null }, property: { state: 'found', name: c.propertyNameAtEntry } })),
    ],
    reports: reports.docs.map((doc) => readMonthlyReport(doc.id, doc.data())).filter((report) => report !== null),
    drafts: drafts.docs.map((doc) => readStatementDraft(doc.id, doc.data())).filter((draft) => draft !== null),
    management,
  });
}
