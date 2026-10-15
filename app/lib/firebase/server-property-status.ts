/**
 * The property list's Income and Cleaning columns (Kian's rulings of 2026-10-15, part A of
 * PROPERTY-LIST-COLUMNS-PLAN.md): what both read, in one answer, for GET /api/admin/property-status.
 *
 * Reads, and nothing else: the month's uploads and lines, every title link, the jobs with a checkout from 14 days back
 * to 2 days ahead, and the cleanings their marks made (status and amount only). No property, no cleaner and no
 * calendar is read: the page has the properties, and a job keeps its cleaners' names.
 *
 * Read whole, no limit: a failed read throws, and the page shows the two columns as not known, never as empty.
 */

import { getAdminDb } from './admin';
import { addDays, torontoDay } from '@/app/lib/availability/days';
import { CLEANINGS_COLLECTION } from '@/app/lib/cleanings/model';
import { EARNINGS_LINES_COLLECTION, EARNINGS_TITLE_LINKS_COLLECTION, EARNINGS_UPLOADS_COLLECTION, readEarningsLine, readEarningsUpload, readTitleLink, type EarningsLineView, type EarningsUploadView, type TitleLinkView } from '@/app/lib/income/model';
import { incomeReadOf, type IncomeRead } from '@/app/lib/income/standing';
import { lastClosedMonth } from '@/app/lib/reports/model';
import { CLEANING_JOBS_COLLECTION, readJob, type StoredJob } from '@/app/lib/schedule/model';
import { COLUMN_DAYS_AHEAD, COLUMN_DAYS_BACK, homeJobOf, type HomeJob } from '@/app/lib/schedule/standing';

export interface PropertyStatusRead {
  /** Toronto. */
  today: string;
  income: IncomeRead;
  cleaning: { from: string; to: string; jobs: HomeJob[] };
  /** Documents not in a written shape: left out, never guessed at. */
  unreadable: number;
}

export async function readPropertyStatus(now: Date = new Date()): Promise<PropertyStatusRead> {
  const db = getAdminDb();
  const today = torontoDay(now);
  const month = lastClosedMonth(today);
  const from = addDays(today, -COLUMN_DAYS_BACK);
  const to = addDays(today, COLUMN_DAYS_AHEAD);
  const [uploadsSnap, linesSnap, linksSnap, jobsSnap] = await Promise.all([
    db.collection(EARNINGS_UPLOADS_COLLECTION).where('month', '==', month).get(),
    db.collection(EARNINGS_LINES_COLLECTION).where('month', '==', month).get(),
    db.collection(EARNINGS_TITLE_LINKS_COLLECTION).get(),
    db.collection(CLEANING_JOBS_COLLECTION).where('checkout', '>=', from).where('checkout', '<=', to).get(),
  ]);
  let unreadable = 0;
  const strictly = <T>(docs: { id: string; data: () => Record<string, unknown> }[], read: (id: string, fields: Record<string, unknown>) => T | null, what: string): T[] => {
    const out: T[] = [];
    for (const doc of docs) {
      const value = read(doc.id, doc.data());
      if (value !== null) out.push(value);
      else {
        unreadable += 1;
        console.error(`[property-status] ${what}/${doc.id} is not in the written shape; left out`);
      }
    }
    return out;
  };
  const uploads = strictly<EarningsUploadView>(uploadsSnap.docs, readEarningsUpload, EARNINGS_UPLOADS_COLLECTION);
  const lines = strictly<EarningsLineView>(linesSnap.docs, readEarningsLine, EARNINGS_LINES_COLLECTION);
  const links = strictly<TitleLinkView>(linksSnap.docs, readTitleLink, EARNINGS_TITLE_LINKS_COLLECTION);
  const jobs = strictly<StoredJob>(jobsSnap.docs, readJob, CLEANING_JOBS_COLLECTION);

  // The cleanings the marks made, for the ones waiting for an amount: a mark the office removed has none to read.
  const cleaningIds = [...new Set(jobs.flatMap((job) => job.cleanerIds.map((cid) => job.assignments[cid]).filter((a) => a.cleaningId !== null && a.removedAt === null).map((a) => a.cleaningId as string)))];
  const cleaningDocs = cleaningIds.length ? await db.getAll(...cleaningIds.map((id) => db.collection(CLEANINGS_COLLECTION).doc(id)), { fieldMask: ['status', 'amountCents'] }) : [];
  const cleanings = new Map(
    cleaningDocs
      .filter((doc) => doc.exists)
      .map((doc) => {
        const status: unknown = doc.get('status');
        const amount: unknown = doc.get('amountCents');
        return [doc.id, { status: typeof status === 'string' ? status : null, amountCents: typeof amount === 'number' ? amount : null }];
      }),
  );

  return { today, income: incomeReadOf({ month, uploads, lines, links }), cleaning: { from, to, jobs: jobs.map((job) => homeJobOf(job, cleanings)) }, unreadable };
}
