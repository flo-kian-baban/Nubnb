/**
 * The property list's Income and Cleaning columns (Kian's rulings of 2026-10-15, part A of
 * PROPERTY-LIST-COLUMNS-PLAN.md): what both read, in one answer, for GET /api/admin/property-status.
 *
 * Reads, and nothing else: the month's uploads and lines, every title link, every direct arrangement and payment
 * (part B), the jobs with a checkout from 14 days back to 2 days ahead, the cleanings their marks made (status and
 * amount only), and the stored calendar copy (Kian's rulings of 2026-10-17, admin home: "Calendar not read" and the
 * Next checkout sort), of which only each property's read state and next checkout are sent. No property and no
 * cleaner is read: the page has the properties, and a job keeps its cleaners' names. No feed is fetched.
 *
 * Read whole, no limit: a failed read throws, and the page shows the two columns as not known, never as empty.
 */

import { getAdminDb } from './admin';
import { addDays, torontoDay } from '@/app/lib/availability/days';
import { CLEANINGS_COLLECTION } from '@/app/lib/cleanings/model';
import { EARNINGS_LINES_COLLECTION, EARNINGS_TITLE_LINKS_COLLECTION, EARNINGS_UPLOADS_COLLECTION, readEarningsLine, readEarningsUpload, readTitleLink, type EarningsLineView, type EarningsUploadView, type TitleLinkView } from '@/app/lib/income/model';
import { incomeReadOf, type IncomeRead } from '@/app/lib/income/standing';
import { DIRECT_ARRANGEMENTS_COLLECTION, DIRECT_PAYMENTS_COLLECTION, readArrangement, readDirectPayment, type ArrangementView, type DirectPaymentView } from '@/app/lib/direct/model';
import { directStanding, type DirectStanding } from '@/app/lib/direct/periods';
import { lastClosedMonth, monthOfDay, openingMonth } from '@/app/lib/reports/model';
import { CLEANING_JOBS_COLLECTION, readJob, type StoredJob } from '@/app/lib/schedule/model';
import { COLUMN_DAYS_AHEAD, COLUMN_DAYS_BACK, homeJobOf, type HomeJob } from '@/app/lib/schedule/standing';
import { readCurrent } from '@/app/lib/availability/store';
import type { AvailabilitySnapshot, FeedStatus } from '@/app/lib/availability/types';
import { readUntracked } from '@/app/lib/schedule/tracking';

/** One property in the last calendar copy: whether its calendar was read, and its next checkout from today on. */
export interface CalendarFacts {
  status: FeedStatus;
  /** The end of the soonest reservation ending today or later, from the last good read; null when none. */
  nextCheckout: string | null;
}

/** Every property the last copy holds, by property ID; a property not here is not in the copy (added since). */
export function calendarFactsOf(snapshot: AvailabilitySnapshot | null, today: string): { refreshedAt: string | null; properties: Record<string, CalendarFacts> } {
  const properties: Record<string, CalendarFacts> = {};
  for (const [id, entry] of Object.entries(snapshot?.properties ?? {})) {
    const ends = (entry.events ?? []).filter((event) => event.kind === 'reserved' && event.end >= today).map((event) => event.end).sort();
    properties[id] = { status: entry.status, nextCheckout: ends[0] ?? null };
  }
  return { refreshedAt: snapshot?.refreshedAt ?? null, properties };
}

/** A cleaning whose extra ask waits for the office (Kian's ruling F of 2026-11-01), however long ago it was cleaned. */
export interface ExtraAsked {
  cleaningId: string;
  propertyId: string;
  /** The day cleaned. */
  day: string;
  cleanerName: string | null;
}

export interface PropertyStatusRead {
  /** Toronto. */
  today: string;
  income: IncomeRead;
  /** `extras`: every extra asked not yet decided, read on its own (not by the jobs' 14-day window), so an ask from early in the month is still on the home at its end. */
  cleaning: { from: string; to: string; jobs: HomeJob[]; extras: ExtraAsked[] };
  /** The last calendar copy, as the list needs it. */
  calendar: { refreshedAt: string | null; properties: Record<string, CalendarFacts> };
  /**
   * The units not tracked by Nubnb (Kian's ruling of 2026-11-10): their row reads "Not tracked by Nubnb" in place of its
   * cells, and none of their jobs or extras is sent, so no chip, Next step or tile counts them.
   */
  untracked: string[];
  /** Documents not in a written shape: left out, never guessed at. */
  unreadable: number;
}

export async function readPropertyStatus(now: Date = new Date()): Promise<PropertyStatusRead> {
  const db = getAdminDb();
  const today = torontoDay(now);
  // The month the Income column describes: the last closed one, never one before the first statement month (Kian's
  // rule of 2026-11-01): on and after 1 November 2026 it describes November, never October.
  const month = openingMonth(lastClosedMonth(today), monthOfDay(today));
  const from = addDays(today, -COLUMN_DAYS_BACK);
  const to = addDays(today, COLUMN_DAYS_AHEAD);
  const [uploadsSnap, linesSnap, linksSnap, jobsSnap, arrangementsSnap, paymentsSnap, snapshot, extrasSnap, untracked] = await Promise.all([
    db.collection(EARNINGS_UPLOADS_COLLECTION).where('month', '==', month).get(),
    db.collection(EARNINGS_LINES_COLLECTION).where('month', '==', month).get(),
    db.collection(EARNINGS_TITLE_LINKS_COLLECTION).get(),
    db.collection(CLEANING_JOBS_COLLECTION).where('checkout', '>=', from).where('checkout', '<=', to).get(),
    db.collection(DIRECT_ARRANGEMENTS_COLLECTION).get(),
    db.collection(DIRECT_PAYMENTS_COLLECTION).get(),
    readCurrent(db),
    // Only the extras still asked: one read each (one when there are none), the four fields the home needs.
    db.collection(CLEANINGS_COLLECTION).where('extra.status', '==', 'asked').select('propertyId', 'day', 'status', 'cleanerNameAtEntry').get(),
    // The units not tracked by Nubnb (Kian's ruling of 2026-11-10; one query).
    readUntracked(db),
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
  // A unit that is not tracked sends no job and no extra: its row shows no cells, and nothing of it is counted.
  const jobs = strictly<StoredJob>(jobsSnap.docs, readJob, CLEANING_JOBS_COLLECTION).filter((job) => !untracked.has(job.propertyId));
  const arrangements = strictly<ArrangementView>(arrangementsSnap.docs, readArrangement, DIRECT_ARRANGEMENTS_COLLECTION);
  const payments = strictly<DirectPaymentView>(paymentsSnap.docs, readDirectPayment, DIRECT_PAYMENTS_COLLECTION);
  // Each property's direct payments in one word (part B): the worst of its arrangements, by the one function.
  const direct: Record<string, DirectStanding> = {};
  for (const propertyId of new Set(arrangements.map((a) => a.propertyId))) {
    const standing = directStanding(arrangements.filter((a) => a.propertyId === propertyId), payments, today);
    if (standing) direct[propertyId] = standing;
  }

  // The cleanings the marks made, for the ones waiting for an amount: a mark the office removed has none to read.
  const cleaningIds = [...new Set(jobs.flatMap((job) => job.cleanerIds.map((cid) => job.assignments[cid]).filter((a) => a.cleaningId !== null && a.removedAt === null).map((a) => a.cleaningId as string)))];
  const cleaningDocs = cleaningIds.length ? await db.getAll(...cleaningIds.map((id) => db.collection(CLEANINGS_COLLECTION).doc(id)), { fieldMask: ['status', 'amountCents', 'extra'] }) : [];
  const cleanings = new Map(
    cleaningDocs
      .filter((doc) => doc.exists)
      .map((doc) => {
        const status: unknown = doc.get('status');
        const amount: unknown = doc.get('amountCents');
        const extra: unknown = doc.get('extra.status');
        return [doc.id, { status: typeof status === 'string' ? status : null, amountCents: typeof amount === 'number' ? amount : null, extra: typeof extra === 'string' ? extra : null }];
      }),
  );

  // An extra waits only on a cleaning still logged: one removed has no money to decide.
  const extras: ExtraAsked[] = [];
  for (const doc of extrasSnap.docs) {
    const propertyId: unknown = doc.get('propertyId');
    const day: unknown = doc.get('day');
    const name: unknown = doc.get('cleanerNameAtEntry');
    if (doc.get('status') !== 'logged') continue;
    if (typeof propertyId === 'string' && untracked.has(propertyId)) continue;
    if (typeof propertyId !== 'string' || typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      unreadable += 1;
      console.error(`[property-status] ${CLEANINGS_COLLECTION}/${doc.id} is not in the written shape; left out`);
      continue;
    }
    extras.push({ cleaningId: doc.id, propertyId, day, cleanerName: typeof name === 'string' ? name : null });
  }
  extras.sort((a, b) => a.day.localeCompare(b.day) || a.cleaningId.localeCompare(b.cleaningId));

  return { today, income: { ...incomeReadOf({ month, uploads, lines, links }), direct }, cleaning: { from, to, jobs: jobs.map((job) => homeJobOf(job, cleanings)), extras }, calendar: calendarFactsOf(snapshot, today), untracked: [...untracked].sort(), unreadable };
}
