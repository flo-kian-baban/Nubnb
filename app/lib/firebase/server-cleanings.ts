/**
 * Server-side reads and writes of cleanings (dispatch 37B; the model is app/lib/cleanings/model.ts).
 *
 * `cleanings` is reached only through the Admin SDK, from the admin routes under /api/admin/cleanings, after the
 * admin session check; firestore.rules' catch-all denies every browser. Admins log cleanings: the cleaner app never
 * reads or writes one, and nothing here reaches a cleaner.
 *
 * ── Writes ──
 * A cleaning is created whole (`create()`), changed or removed in a transaction that refuses unless its history is
 * the length the page saw (409, as a cost entry's review), and deleted only when no finished statement prints it.
 * Every change appends to its history, read and written back inside the transaction. The amount the form started
 * from is worked out here again when a cleaning is logged and kept with it (`suggested`), as evidence only, and
 * `amountFrom` says where the amount came from: the preset, or typed.
 *
 * ── Kian's rulings of 2026-10-13, and of 2026-10-19 (cleaning prices) ──
 * The amount starts from the property's preset (app/lib/cleanings/prices.ts): the long-term one when the property has a
 * job that day whose stay is 28 nights or more, else the short-term one; the admin changes it freely. (37B's "last paid
 * for the property, else the cleaner's default rate" is replaced; the default rate is no longer read.) Logged by hand.
 * A cleaning logged after its month's statement is finished goes on the next open statement; one changed or removed
 * after printing is adjusted on the next month's. The statements do that (reports/statement.ts): a change here is all
 * it takes.
 *
 * ── The cleaning schedule (Kian's rulings of 2026-10-14) ──
 * A job's cleaning (schema version 2, `jobId`) is made by the cleaner's Mark cleaned (server-cleaning-jobs.ts), and
 * changed, removed or deleted here under 37B's rules. Its cleaner stays its cleaner: the job's assignment points at
 * it (Kian's ruling of the night, accepting the developer's choice). Deleting one keeps the mark on the job as
 * "removed by the office", in the same transaction, and that cleaner cannot mark it again until an admin reopens it
 * on the Schedule (Kian's ruling of the night); removing one does the same. The job's history keeps who did it, the
 * cleaning's ID and its amount.
 *
 * Failure contract: the reads throw when a read fails; the writes return a result naming what happened, "may or
 * may not have landed" included, and never throw.
 */

import type { DocumentReference, Transaction } from 'firebase-admin/firestore';
import { getAdminDb } from './admin';
import { isDocumentId } from './server-leads';
import { cleanerFacingNamesOf, internalNameOf } from './server-property-names';
import { CLEANERS_COLLECTION, fieldText, roleOf, type Actor, type Refusal } from '@/app/lib/cleaners/model';
import {
  CLEANINGS_COLLECTION,
  CLEANING_LIMITS,
  CLEANING_SCHEMA_VERSION,
  readCleaning,
  type Cleaning,
  type CleaningEvent,
  type CleaningFieldsChanged,
  type CleaningView,
  type TeamChoice,
} from '@/app/lib/cleanings/model';
import { PROPERTY_CLEANING_PRICES_COLLECTION, amountSourceOf, handLogSuggestion, readCleaningPrices, stayNights, type CleaningPrices } from '@/app/lib/cleanings/prices';
import { pricesInTx } from './server-cleaning-prices';
import { torontoDayOf } from '@/app/lib/costs/report';
import { CLEANING_JOBS_COLLECTION, jobEvent, jobIdOf, readJob, type StoredJob } from '@/app/lib/schedule/model';
import { paymentOnOrAfter } from './server-pay';
import type { PaymentView } from '@/app/lib/pay/model';
import { MONTHLY_REPORTS_COLLECTION, addMonths, currentReports, monthOfDay, readMonthlyReport } from '@/app/lib/reports/model';
import { statementMonthFor } from '@/app/lib/reports/statement';

function grpcCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? String(code) : typeof code === 'string' ? code : 'unknown';
}

// ─── Reads ─────────────────────────────────────────────────────

type CleanerNow = { name: string | null; status: string | null; role: string };

export type PropertyNow = { name: string | null; internalName: string | null };

/**
 * The cleaners and the properties that exist, by ID, with their current names — a property's public title and the name
 * the admin shows, its cleaner-facing name else that title (Kian's rulings of 2026-10-15, evening); a failed lookup
 * leaves names unknown, never wrong.
 */
async function lookUps(cleanerIds: string[], propertyIds: string[]): Promise<{ cleaners: Map<string, CleanerNow> | null; properties: Map<string, PropertyNow> | null }> {
  const db = getAdminDb();
  const cleaners = cleanerIds.length === 0
    ? new Map<string, CleanerNow>()
    : await db
        .getAll(...cleanerIds.map((id) => db.collection(CLEANERS_COLLECTION).doc(id)), { fieldMask: ['name', 'status', 'role'] })
        .then((docs) => new Map(docs.filter((doc) => doc.exists).map((doc): [string, CleanerNow] => [doc.id, { name: fieldText(doc.get('name')), status: fieldText(doc.get('status')), role: roleOf({ role: doc.get('role') }) }])))
        .catch((err) => {
          console.error(`[cleanings] could not look up cleaners: grpc code ${grpcCode(err)}`);
          return null;
        });
  const properties = propertyIds.length === 0
    ? new Map<string, PropertyNow>()
    : await Promise.all([db.getAll(...propertyIds.map((id) => db.collection('properties').doc(id)), { fieldMask: ['name'] }), cleanerFacingNamesOf(propertyIds)])
        .then(([docs, facing]) =>
          new Map(
            docs
              .filter((doc) => doc.exists)
              .map((doc): [string, PropertyNow] => [doc.id, { name: fieldText(doc.get('name')), internalName: internalNameOf(facing, doc.id, fieldText(doc.get('name'))) }]),
          ),
        )
        .catch((err) => {
          console.error(`[cleanings] could not look up properties: grpc code ${grpcCode(err)}`);
          return null;
        });
  return { cleaners, properties };
}

/** A stored cleaning with its lookups: `missing` when its cleaner or property no longer exists — a deleted cleaner's cleanings still read, by the name they were logged with. */
function toView(c: Cleaning & { id: string }, cleaners: Map<string, CleanerNow> | null, properties: Map<string, PropertyNow> | null): CleaningView {
  const cleaner = cleaners === null ? null : (cleaners.get(c.cleanerId) ?? undefined);
  const property = properties === null ? null : properties.has(c.propertyId) ? (properties.get(c.propertyId) ?? null) : undefined;
  return {
    ...c,
    cleaner: cleaner === null ? { state: 'unreadable', name: null, status: null } : cleaner === undefined ? { state: 'missing', name: null, status: null } : { state: 'found', name: cleaner.name, status: cleaner.status },
    property: property === undefined ? { state: 'missing', name: null } : properties === null || property === null ? { state: 'unreadable', name: null } : { state: 'found', name: property.name, internalName: property.internalName },
  };
}

const distinct = (ids: string[]) => [...new Set(ids.filter((id) => isDocumentId(id)))];

/** Documents read strictly; one not in the written shape is logged by ID and left out. */
export function readDocs(docs: { id: string; data: () => Record<string, unknown> }[]): (Cleaning & { id: string })[] {
  const out: (Cleaning & { id: string })[] = [];
  for (const doc of docs) {
    const read = readCleaning(doc.id, doc.data());
    if (read) out.push(read);
    else console.error(`[cleanings] cleanings/${doc.id} is not in the written shape; left out`);
  }
  return out;
}

/**
 * Every cleaning, newest day first, with its cleaner's and property's current names. Read whole: no orderBy, no
 * limit, so none can silently drop out. `known`: properties the caller has already looked up (the whole costs read
 * reads every property first), so none is read a second time here (the Team page audit of 2026-10-19 counted 54
 * repeated lookups); null when that lookup failed, which leaves every property's name unknown here too.
 *
 * @throws if the read fails.
 */
export async function listCleanings(known?: ReadonlyMap<string, PropertyNow> | null): Promise<CleaningView[]> {
  const snapshot = await getAdminDb().collection(CLEANINGS_COLLECTION).get();
  const cleanings = readDocs(snapshot.docs);
  const propertyIds = distinct(cleanings.map((c) => c.propertyId));
  const { cleaners, properties } = await lookUps(distinct(cleanings.map((c) => c.cleanerId)), known === undefined ? propertyIds : known === null ? [] : propertyIds.filter((id) => !known.has(id)));
  const merged = known === null ? null : known === undefined ? properties : properties === null ? null : new Map([...known, ...properties]);
  return cleanings.map((c) => toView(c, cleaners, merged)).sort(byDay);
}

/**
 * What a team member's missing amounts start from (the Team page's pay view, 2026-10-19; the rule is prices.ts
 * `missingAmountStart`, the same the Cleanings tab applies): each named property's presets, and each named job's stay
 * in nights and cleaner count. The page names the properties of the person's cleanings with no amount and the jobs of
 * those and of the typed job cleanings there; it already holds every cleaning. One read per property and per job; a
 * property with no record or a job that cannot be read is absent from the answer.
 *
 * @throws if a read fails.
 */
export async function amountStarts(propertyIds: readonly string[], jobIds: readonly string[]): Promise<{ prices: Record<string, CleaningPrices>; jobs: Record<string, { nights: number; cleaners: number }> }> {
  const db = getAdminDb();
  // A property ID as Nubnb issues them (a Firestore auto ID, or a test's letters and digits); never a path.
  const properties = [...new Set(propertyIds.filter((id) => /^[A-Za-z0-9_-]{1,64}$/.test(id)))];
  const jobs = [...new Set(jobIds.filter((id) => /^[A-Za-z0-9]{1,64}_\d{4}-\d{2}-\d{2}$/.test(id)))];
  const [priceDocs, jobDocs] = await Promise.all([
    properties.length ? db.getAll(...properties.map((id) => db.collection(PROPERTY_CLEANING_PRICES_COLLECTION).doc(id))) : Promise.resolve([]),
    jobs.length ? db.getAll(...jobs.map((id) => db.collection(CLEANING_JOBS_COLLECTION).doc(id)), { fieldMask: ['reservation', 'checkout', 'cleanerIds'] }) : Promise.resolve([]),
  ]);
  const prices: Record<string, CleaningPrices> = {};
  for (const doc of priceDocs) {
    if (!doc.exists) continue;
    const record = readCleaningPrices(doc.id, doc.data() ?? {});
    if (record) prices[doc.id] = { shortTermCents: record.shortTermCents, longTermCents: record.longTermCents };
  }
  const out: Record<string, { nights: number; cleaners: number }> = {};
  for (const doc of jobDocs) {
    if (!doc.exists) continue;
    const reservation: unknown = doc.get('reservation');
    const checkout: unknown = doc.get('checkout');
    const cleanerIds: unknown = doc.get('cleanerIds');
    const start = reservation && typeof reservation === 'object' ? (reservation as { start?: unknown }).start : undefined;
    if (typeof start !== 'string' || typeof checkout !== 'string' || !Array.isArray(cleanerIds)) continue;
    out[doc.id] = { nights: stayNights(start, checkout), cleaners: cleanerIds.length };
  }
  return { prices, jobs: out };
}

/** One property's cleanings, for its statements; inside a transaction when one is given (names then unknown: display only). @throws if the read fails. */
export async function propertyCleanings(propertyId: string, tx?: Transaction): Promise<CleaningView[]> {
  if (!isDocumentId(propertyId)) return [];
  const query = getAdminDb().collection(CLEANINGS_COLLECTION).where('propertyId', '==', propertyId);
  const snapshot = tx ? await tx.get(query) : await query.get();
  const cleanings = readDocs(snapshot.docs);
  if (tx) return cleanings.map((c) => toView(c, new Map(), new Map())).sort(byDay);
  const { cleaners, properties } = await lookUps(distinct(cleanings.map((c) => c.cleanerId)), [propertyId]);
  return cleanings.map((c) => toView(c, cleaners, properties)).sort(byDay);
}

/**
 * Every team member with their role and status, for the cleaning form's cleaner choice. Reads only those fields (the
 * default rate is no longer read: Kian's ruling of 2026-10-19).
 *
 * @throws if the read fails.
 */
export async function listTeamChoices(): Promise<TeamChoice[]> {
  const snapshot = await getAdminDb().collection(CLEANERS_COLLECTION).select('name', 'role', 'status').get();
  return snapshot.docs
    .map((doc) => ({ id: doc.id, name: fieldText(doc.get('name')), role: roleOf({ role: doc.get('role') }), status: fieldText(doc.get('status')) }))
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', 'en-CA') || a.id.localeCompare(b.id));
}

/**
 * The stay behind each job the Cleanings tab needs (Kian's rulings of 2026-10-19): its nights and how many cleaners
 * were on it, by job ID — for the cleanings waiting for an amount (the hint under each, and the tier the
 * recommendation is for) and for the cleanings whose amount an admin typed (the recommendation counts a job's
 * cleaning only when the job had exactly one cleaner). One read per such job; a job that cannot be read is left out.
 *
 * @throws if the read fails.
 */
export async function waitingJobsOf(cleanings: readonly Pick<Cleaning, 'amountCents' | 'amountFrom' | 'status' | 'jobId'>[]): Promise<Record<string, { nights: number; cleaners: number }>> {
  const ids = [...new Set(cleanings.filter((c) => c.status === 'logged' && c.jobId !== null && (c.amountCents === null || c.amountFrom === 'typed')).map((c) => c.jobId as string))].filter((id) => /^[A-Za-z0-9]{1,64}_\d{4}-\d{2}-\d{2}$/.test(id));
  if (ids.length === 0) return {};
  const db = getAdminDb();
  const docs = await db.getAll(...ids.map((id) => db.collection(CLEANING_JOBS_COLLECTION).doc(id)), { fieldMask: ['reservation', 'checkout', 'cleanerIds'] });
  const out: Record<string, { nights: number; cleaners: number }> = {};
  for (const doc of docs) {
    if (!doc.exists) continue;
    const reservation: unknown = doc.get('reservation');
    const checkout: unknown = doc.get('checkout');
    const cleanerIds: unknown = doc.get('cleanerIds');
    const start = reservation && typeof reservation === 'object' ? (reservation as { start?: unknown }).start : undefined;
    if (typeof start !== 'string' || typeof checkout !== 'string' || !Array.isArray(cleanerIds)) continue;
    out[doc.id] = { nights: stayNights(start, checkout), cleaners: cleanerIds.length };
  }
  return out;
}

const byDay = (a: Pick<Cleaning, 'day' | 'createdAt'> & { id: string }, b: Pick<Cleaning, 'day' | 'createdAt'> & { id: string }) => b.day.localeCompare(a.day) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);

// ─── Checks shared by the writes ───────────────────────────────

/** Whether a day may be a cleaning's: a real day, not after today in Toronto, and within the last twelve months. */
export function cleaningDayProblem(day: string, now: Date = new Date()): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return 'Write the day as yyyy-mm-dd.';
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (date.getUTCFullYear() !== Number(match[1]) || date.getUTCMonth() !== Number(match[2]) - 1 || date.getUTCDate() !== Number(match[3])) return 'That day does not exist.';
  const today = torontoDayOf(now);
  if (day > today) return 'A cleaning cannot be logged for a day that has not come.';
  if (day.slice(0, 7) < addMonths(today.slice(0, 7), -CLEANING_LIMITS.MONTHS_BACK)) return `A cleaning more than ${CLEANING_LIMITS.MONTHS_BACK} months back cannot be logged.`;
  return null;
}

/** The statement a cleaning of `month` goes on (Kian's ruling): that month's, or, once it is finished, the next open one's. */
export async function statementMonthOf(propertyId: string, month: string, tx: Transaction): Promise<string> {
  const db = getAdminDb();
  const snap = await tx.get(db.collection(MONTHLY_REPORTS_COLLECTION).where('propertyId', '==', propertyId));
  const reports = snap.docs.map((doc) => readMonthlyReport(doc.id, doc.data())).filter((report) => report !== null);
  return statementMonthFor(month, new Set(currentReports(reports).map((report) => report.month)));
}

/** The finished statements of a property, current or since replaced, that print the cleaning: a cost row, `entryIds` or an adjustment. Read from raw fields, so one not in shape still counts. */
export async function statementsPrinting(propertyId: string, cleaningId: string, tx: Transaction): Promise<{ id: string; month: string; reference: string }[]> {
  const db = getAdminDb();
  const snap = await tx.get(db.collection(MONTHLY_REPORTS_COLLECTION).where('propertyId', '==', propertyId));
  const names = (rows: unknown) => Array.isArray(rows) && rows.some((row) => !!row && typeof row === 'object' && (row as Record<string, unknown>).entryId === cleaningId);
  return snap.docs
    .filter((doc) => {
      const fields = doc.data();
      return (Array.isArray(fields.entryIds) && fields.entryIds.includes(cleaningId)) || names(fields.costs) || names(fields.adjustments);
    })
    .map((doc) => ({ id: doc.id, month: typeof doc.get('month') === 'string' ? (doc.get('month') as string) : '', reference: typeof doc.get('reference') === 'string' ? (doc.get('reference') as string) : '' }));
}

/** A cleaner who may be picked for a cleaning: exists, and is a cleaner, not a handyman. A deactivated one may be, for a cleaning done before. */
async function pickableCleaner(cleanerId: string, tx: Transaction, mustBeActive: boolean): Promise<{ name: string | null } | 'missing' | 'not-a-cleaner' | 'inactive'> {
  const db = getAdminDb();
  const [doc] = await tx.getAll(db.collection(CLEANERS_COLLECTION).doc(cleanerId), { fieldMask: ['name', 'role', 'status'] });
  if (!doc.exists) return 'missing';
  if (roleOf({ role: doc.get('role') }) !== 'cleaner') return 'not-a-cleaner';
  if (mustBeActive && doc.get('status') !== 'active') return 'inactive';
  return { name: fieldText(doc.get('name')) };
}

/**
 * What a cleaning logged by hand for this property and day starts from (Kian's ruling of 2026-10-19): the property's
 * preset by the stay of its job that day, else the short-term preset. Two reads inside the transaction (the prices,
 * the job), so the stored `suggested` is what the form offered.
 */
async function handLogStart(tx: Transaction, propertyId: string, day: string): Promise<{ prices: CleaningPrices | null; suggestion: ReturnType<typeof handLogSuggestion> }> {
  const [prices, jobSnap] = await Promise.all([pricesInTx(tx, propertyId), tx.get(getAdminDb().collection(CLEANING_JOBS_COLLECTION).doc(jobIdOf(propertyId, day)))]);
  const job = jobSnap.exists ? readJob(jobSnap.id, jobSnap.data() ?? {}) : null;
  return { prices, suggestion: handLogSuggestion(prices, job) };
}

// ─── Log ───────────────────────────────────────────────────────

export interface CleaningInput {
  propertyId: string;
  cleanerId: string;
  day: string;
  amountCents: number;
  note: string | null;
}

export type LogCleaningResult =
  | { kind: 'logged'; cleaning: CleaningView; statementMonth: string }
  | { kind: 'bad-day'; problem: string }
  | { kind: 'no-such-property' }
  | { kind: 'no-such-cleaner' }
  | { kind: 'not-a-cleaner' }
  | { kind: 'inactive' }
  | { kind: 'failed' };

export const LOG_REFUSALS: Record<Exclude<LogCleaningResult['kind'], 'logged' | 'bad-day'>, Refusal> = {
  'no-such-property': { status: 404, code: 'PROPERTY_NOT_FOUND', message: 'That property does not exist.', hint: 'Nothing was logged.' },
  'no-such-cleaner': { status: 404, code: 'CLEANER_NOT_FOUND', message: 'That cleaner does not exist.', hint: 'Nothing was logged. Reload the page.' },
  'not-a-cleaner': { status: 422, code: 'NOT_A_CLEANER', message: 'A cleaning is logged for a cleaner, not a handyman.', hint: 'Nothing was logged.' },
  inactive: { status: 422, code: 'CLEANER_INACTIVE', message: 'That cleaner is deactivated.', hint: 'Nothing was logged. Reactivate them on the Team page, or pick another cleaner.' },
  failed: { status: 502, code: 'CLEANING_LOG_FAILED', message: 'Could not log the cleaning.', hint: 'It may or may not have been logged. Reload to see what is on record.' },
};

/**
 * Log one cleaning: its property and cleaner as they are named now, the day, the amount the admin left, the note,
 * the amount the form started from (the property's preset, worked out again here from what is stored) and where the
 * amount came from — that preset, or typed. Answers the statement it goes on: its month's, or the next open one's once
 * that is finished.
 */
export async function logCleaning(actor: Actor, input: CleaningInput): Promise<LogCleaningResult> {
  const problem = cleaningDayProblem(input.day);
  if (problem) return { kind: 'bad-day', problem };
  const db = getAdminDb();
  const ref = db.collection(CLEANINGS_COLLECTION).doc();
  try {
    return await db.runTransaction(async (tx): Promise<LogCleaningResult> => {
      const [property] = await tx.getAll(db.collection('properties').doc(input.propertyId), { fieldMask: ['name'] });
      if (!property.exists) return { kind: 'no-such-property' };
      const cleaner = await pickableCleaner(input.cleanerId, tx, true);
      if (cleaner === 'missing') return { kind: 'no-such-cleaner' };
      if (cleaner === 'not-a-cleaner') return { kind: 'not-a-cleaner' };
      if (cleaner === 'inactive') return { kind: 'inactive' };
      const { suggestion } = await handLogStart(tx, input.propertyId, input.day);
      const suggested = { from: suggestion.from, cents: suggestion.cents };
      const statementMonth = await statementMonthOf(input.propertyId, monthOfDay(input.day), tx);
      const now = new Date().toISOString();
      const stored: Cleaning = {
        schemaVersion: CLEANING_SCHEMA_VERSION,
        propertyId: input.propertyId,
        propertyNameAtEntry: fieldText(property.get('name')),
        cleanerId: input.cleanerId,
        cleanerNameAtEntry: cleaner.name,
        day: input.day,
        amountCents: input.amountCents,
        note: input.note,
        status: 'logged',
        suggested,
        amountFrom: amountSourceOf(suggestion, input.amountCents),
        createdAt: now,
        actor,
        history: [{ at: now, action: 'logged', actor, reason: null }],
        // Logged by hand: no job (schema version 2).
        jobId: null,
      };
      tx.create(ref, stored);
      return {
        kind: 'logged',
        statementMonth,
        cleaning: { id: ref.id, ...stored, cleaner: { state: 'found', name: cleaner.name, status: 'active' }, property: { state: 'found', name: fieldText(property.get('name')) } },
      };
    });
  } catch (err) {
    console.error(`[cleanings] logging ${ref.id} failed: grpc code ${grpcCode(err)}`);
    return { kind: 'failed' };
  }
}

// ─── Change, remove ────────────────────────────────────────────

export interface CleaningChange {
  day?: string;
  amountCents?: number;
  cleanerId?: string;
  note?: string | null;
}

export type ChangeCleaningResult =
  | { kind: 'changed'; cleaning: CleaningView; changed: boolean; statementMonth: string }
  | { kind: 'not-found' }
  | { kind: 'changed-since' }
  | { kind: 'removed' }
  | { kind: 'bad-day'; problem: string }
  /** It is printed in a finished statement, and the day asked for is in another month. */
  | { kind: 'printed-month'; statements: { id: string; month: string; reference: string }[] }
  | { kind: 'no-such-cleaner' }
  | { kind: 'not-a-cleaner' }
  /** A job's cleaning keeps its cleaner: their mark on the job points at it. */
  | { kind: 'job-cleaner' }
  | { kind: 'unreadable' }
  | { kind: 'failed' };

export const CHANGE_REFUSALS: Record<Exclude<ChangeCleaningResult['kind'], 'changed' | 'bad-day' | 'printed-month'>, Refusal> = {
  'not-found': { status: 404, code: 'CLEANING_NOT_FOUND', message: 'No such cleaning.', hint: 'It may have been deleted. Reload the page.' },
  'changed-since': { status: 409, code: 'CLEANING_CHANGED', message: 'This cleaning changed since the page loaded.', hint: 'Nothing was saved. Reload, check what changed, and try again.' },
  removed: { status: 409, code: 'CLEANING_REMOVED', message: 'This cleaning is removed.', hint: 'Nothing was saved. Log it again if it was done.' },
  'no-such-cleaner': { status: 404, code: 'CLEANER_NOT_FOUND', message: 'That cleaner does not exist.', hint: 'Nothing was saved. Reload the page.' },
  'not-a-cleaner': { status: 422, code: 'NOT_A_CLEANER', message: 'A cleaning is logged for a cleaner, not a handyman.', hint: 'Nothing was saved.' },
  'job-cleaner': { status: 409, code: 'CLEANING_FROM_JOB', message: 'This cleaning came from its cleaner’s Mark cleaned on a job, so it keeps its cleaner.', hint: 'Nothing was saved. Remove it, and log one by hand for the other cleaner.' },
  unreadable: { status: 500, code: 'CLEANING_UNREADABLE', message: 'This cleaning is not in the shape a change needs.', hint: 'Nothing was saved.' },
  failed: { status: 502, code: 'CLEANING_SAVE_FAILED', message: 'Could not save the cleaning.', hint: 'It may or may not have been saved. Reload to see what is on record.' },
};

/**
 * Change a cleaning's day, amount, cleaner or note, as the admin saw it (`seen`: its history's length). Only what
 * differs is written, with one history event holding each field before and after; nothing differs, nothing is
 * written. A cleaning a finished statement prints keeps its month: its day may move within it, never out of it (a
 * statement already sent printed it for that month). A changed amount after printing is the statements' to adjust.
 */
export async function changeCleaning(actor: Actor, id: string, change: CleaningChange, seen: number, reason: string | null): Promise<ChangeCleaningResult> {
  if (!isDocumentId(id)) return { kind: 'not-found' };
  if (change.day !== undefined) {
    const problem = cleaningDayProblem(change.day);
    if (problem) return { kind: 'bad-day', problem };
  }
  const db = getAdminDb();
  const ref = db.collection(CLEANINGS_COLLECTION).doc(id);
  try {
    return await db.runTransaction(async (tx): Promise<ChangeCleaningResult> => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { kind: 'not-found' };
      const stored = readCleaning(snap.id, snap.data() ?? {});
      if (!stored) return { kind: 'unreadable' };
      if (stored.history.length !== seen) return { kind: 'changed-since' };
      if (stored.status === 'removed') return { kind: 'removed' };
      const before: CleaningFieldsChanged = {};
      const after: CleaningFieldsChanged = {};
      if (change.day !== undefined && change.day !== stored.day) {
        if (change.day.slice(0, 7) !== stored.day.slice(0, 7)) {
          const printing = await statementsPrinting(stored.propertyId, id, tx);
          if (printing.length > 0) return { kind: 'printed-month', statements: printing };
        }
        before.day = stored.day;
        after.day = change.day;
      }
      if (change.amountCents !== undefined && change.amountCents !== stored.amountCents) {
        before.amountCents = stored.amountCents;
        after.amountCents = change.amountCents;
      }
      let cleanerName = stored.cleanerNameAtEntry;
      if (change.cleanerId !== undefined && change.cleanerId !== stored.cleanerId) {
        if (stored.jobId !== null) return { kind: 'job-cleaner' };
        const cleaner = await pickableCleaner(change.cleanerId, tx, false);
        if (cleaner === 'missing') return { kind: 'no-such-cleaner' };
        if (cleaner === 'not-a-cleaner' || cleaner === 'inactive') return { kind: 'not-a-cleaner' };
        before.cleanerId = stored.cleanerId;
        before.cleanerName = stored.cleanerNameAtEntry;
        after.cleanerId = change.cleanerId;
        after.cleanerName = cleaner.name;
        cleanerName = cleaner.name;
      }
      if (change.note !== undefined && change.note !== stored.note) {
        before.note = stored.note;
        after.note = change.note;
      }
      const month = (after.day ?? stored.day).slice(0, 7);
      const statementMonth = await statementMonthOf(stored.propertyId, month, tx);
      const view = (c: Cleaning & { id: string }): CleaningView => ({ ...c, cleaner: { state: 'found', name: c.cleanerNameAtEntry, status: null }, property: { state: 'found', name: c.propertyNameAtEntry } });
      if (Object.keys(after).length === 0) return { kind: 'changed', cleaning: view(stored), changed: false, statementMonth };
      const event: CleaningEvent = { at: new Date().toISOString(), action: 'changed', actor, reason, before, after };
      const next = {
        day: after.day ?? stored.day,
        amountCents: after.amountCents ?? stored.amountCents,
        // An amount an admin typed or changed came from them (Kian's ruling of 2026-10-19), whatever it started from.
        amountFrom: after.amountCents !== undefined ? ('typed' as const) : stored.amountFrom,
        cleanerId: after.cleanerId ?? stored.cleanerId,
        cleanerNameAtEntry: cleanerName,
        note: 'note' in after ? (after.note ?? null) : stored.note,
        history: [...stored.history, event],
      };
      tx.update(ref, next);
      return { kind: 'changed', cleaning: view({ ...stored, ...next }), changed: true, statementMonth };
    });
  } catch (err) {
    console.error(`[cleanings] changing ${id} failed: grpc code ${grpcCode(err)}`);
    return { kind: 'failed' };
  }
}

// ─── A job's cleaning, removed or deleted by the office ────────

/** A job whose cleaner's mark made this cleaning, found inside the transaction: a read, so it runs before any write. */
interface MarkOnJob {
  ref: DocumentReference;
  job: StoredJob;
  cleanerId: string;
}

async function markOnJob(tx: Transaction, jobId: unknown, cleanerId: unknown, cleaningId: string): Promise<MarkOnJob | null> {
  if (typeof jobId !== 'string' || jobId === '' || typeof cleanerId !== 'string') return null;
  const ref = getAdminDb().collection(CLEANING_JOBS_COLLECTION).doc(jobId);
  const snap = await tx.get(ref);
  const job = snap.exists ? readJob(snap.id, snap.data() ?? {}) : null;
  return job && job.assignments[cleanerId]?.cleaningId === cleaningId ? { ref, job, cleanerId } : null;
}

/**
 * The office removed or deleted the cleaning a cleaner's mark made: the job keeps the mark as "removed by the office"
 * (its first removal's time and admin, when it is deleted after being removed), and that cleaner cannot mark it again
 * until an admin reopens it on the Schedule (Kian's ruling of 2026-10-14, night). The job's history names the admin,
 * the cleaning and its amount.
 */
function keepMarkRemoved(tx: Transaction, found: MarkOnJob, action: 'cleaning-removed' | 'cleaning-deleted', actor: Actor, cleaningId: string, amountCents: number | null, at: string): void {
  const { ref, job, cleanerId } = found;
  const mark = job.assignments[cleanerId];
  tx.update(ref, {
    assignments: { ...job.assignments, [cleanerId]: { ...mark, removedAt: mark.removedAt ?? at, removedBy: mark.removedBy ?? actor } },
    history: [...job.history, jobEvent(at, action, actor, { cleanerId, cleanerName: mark.nameAtAssignment, cleaningId, amountCents })],
  });
}

export type RemoveCleaningResult = { kind: 'removed'; cleaning: CleaningView } | { kind: 'not-found' } | { kind: 'changed-since' } | { kind: 'already-removed' } | { kind: 'unreadable' } | { kind: 'failed' };

/**
 * Remove a cleaning: it stays, marked, and counts nowhere; a statement that printed it is given it back on the next
 * open one (Kian's ruling: the rules costs follow). As the admin saw it (`seen`). A job's cleaning leaves its mark on
 * the job, removed by the office.
 */
export async function removeCleaning(actor: Actor, id: string, seen: number, reason: string | null): Promise<RemoveCleaningResult> {
  if (!isDocumentId(id)) return { kind: 'not-found' };
  const db = getAdminDb();
  const ref = db.collection(CLEANINGS_COLLECTION).doc(id);
  try {
    return await db.runTransaction(async (tx): Promise<RemoveCleaningResult> => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { kind: 'not-found' };
      const stored = readCleaning(snap.id, snap.data() ?? {});
      if (!stored) return { kind: 'unreadable' };
      if (stored.history.length !== seen) return { kind: 'changed-since' };
      if (stored.status === 'removed') return { kind: 'already-removed' };
      const onJob = await markOnJob(tx, stored.jobId, stored.cleanerId, id);
      const at = new Date().toISOString();
      const history = [...stored.history, { at, action: 'removed' as const, actor, reason }];
      tx.update(ref, { status: 'removed', history });
      if (onJob) keepMarkRemoved(tx, onJob, 'cleaning-removed', actor, id, stored.amountCents, at);
      return { kind: 'removed', cleaning: { ...stored, status: 'removed', history, cleaner: { state: 'found', name: stored.cleanerNameAtEntry, status: null }, property: { state: 'found', name: stored.propertyNameAtEntry } } };
    });
  } catch (err) {
    console.error(`[cleanings] removing ${id} failed: grpc code ${grpcCode(err)}`);
    return { kind: 'failed' };
  }
}

// ─── Delete ────────────────────────────────────────────────────

export type DeleteCleaningResult =
  | { kind: 'deleted'; id: string }
  | { kind: 'not-found' }
  | { kind: 'changed-since' }
  /** A finished statement prints it: a statement already sent cannot name a cleaning that no longer exists. */
  | { kind: 'in-statement'; statements: { id: string; month: string; reference: string }[] }
  /** Dated on or before a payment to its cleaner (Kian's ruling of 2026-10-15): removed instead. Nothing was deleted. */
  | { kind: 'before-payment'; payment: PaymentView; cleanerName: string | null }
  /** A payment to its cleaner cannot be read, so whether one is dated on or after it cannot be told. */
  | { kind: 'payments-unreadable' }
  | { kind: 'failed' };

/**
 * Delete a cleaning outright, as the admin saw it (`seen`), never while a finished statement — current or since
 * replaced — prints it. A deleted cleaning leaves no record of who cleaned or what they were paid; removing keeps it.
 * A job's cleaning leaves its mark on the job as "removed by the office", in the same transaction: that cleaner cannot
 * mark it again until an admin reopens it (Kian's ruling of 2026-10-14, night), and the job's history keeps who
 * marked it, the cleaning's ID and its amount. A cleaning dated on or before a payment to its cleaner is never
 * deleted (Kian's ruling of 2026-10-15): it is removed instead, and the refusal names the payment.
 */
export async function deleteCleaning(actor: Actor, id: string, seen: number): Promise<DeleteCleaningResult> {
  if (!isDocumentId(id)) return { kind: 'not-found' };
  const db = getAdminDb();
  const ref = db.collection(CLEANINGS_COLLECTION).doc(id);
  try {
    return await db.runTransaction(async (tx): Promise<DeleteCleaningResult> => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { kind: 'not-found' };
      const history: unknown = snap.get('history');
      if (!Array.isArray(history) || history.length !== seen) return { kind: 'changed-since' };
      const propertyId: unknown = snap.get('propertyId');
      if (typeof propertyId === 'string' && isDocumentId(propertyId)) {
        const printing = await statementsPrinting(propertyId, id, tx);
        if (printing.length > 0) return { kind: 'in-statement', statements: printing };
      }
      // Paid on or after its day (Kian's ruling of 2026-10-15): removed, never deleted.
      const cleanerOf: unknown = snap.get('cleanerId');
      const dayOf: unknown = snap.get('day');
      if (typeof cleanerOf === 'string' && typeof dayOf === 'string') {
        const paid = await paymentOnOrAfter(tx, cleanerOf, dayOf);
        if (paid.kind === 'unreadable') return { kind: 'payments-unreadable' };
        if (paid.kind === 'payment') return { kind: 'before-payment', payment: paid.payment, cleanerName: fieldText(snap.get('cleanerNameAtEntry')) };
      }
      // A job's cleaning: its cleaner's mark stays on the job, removed by the office.
      const onJob = await markOnJob(tx, snap.get('jobId'), snap.get('cleanerId'), id);
      tx.delete(ref);
      if (onJob) {
        const amount: unknown = snap.get('amountCents');
        keepMarkRemoved(tx, onJob, 'cleaning-deleted', actor, id, typeof amount === 'number' ? amount : null, new Date().toISOString());
      }
      return { kind: 'deleted', id };
    });
  } catch (err) {
    console.error(`[cleanings] deleting ${id} failed: grpc code ${grpcCode(err)}`);
    return { kind: 'failed' };
  }
}

export const DELETE_REFUSALS: Record<'not-found' | 'changed-since' | 'payments-unreadable' | 'failed', Refusal> = {
  'payments-unreadable': { status: 500, code: 'PAYMENTS_UNREADABLE', message: 'A payment to this cleaner cannot be read, so this cleaning cannot be deleted.', hint: 'Nothing was deleted. Remove it instead.' },
  'not-found': CHANGE_REFUSALS['not-found'],
  'changed-since': { status: 409, code: 'CLEANING_CHANGED', message: 'This cleaning changed since the page loaded.', hint: 'Nothing was deleted. Reload, check what changed, and delete again if you still mean to.' },
  failed: { status: 502, code: 'CLEANING_DELETE_FAILED', message: 'Could not delete the cleaning.', hint: 'It may or may not have been deleted. Reload to see what is on record.' },
};

export const REMOVE_REFUSALS: Record<Exclude<RemoveCleaningResult['kind'], 'removed'>, Refusal> = {
  'not-found': CHANGE_REFUSALS['not-found'],
  'changed-since': CHANGE_REFUSALS['changed-since'],
  'already-removed': { status: 409, code: 'CLEANING_REMOVED', message: 'This cleaning is already removed.', hint: 'Nothing was changed.' },
  unreadable: CHANGE_REFUSALS.unreadable,
  failed: { status: 502, code: 'CLEANING_REMOVE_FAILED', message: 'Could not remove the cleaning.', hint: 'It may or may not have been removed. Reload to see what is on record.' },
};
