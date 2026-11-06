/**
 * The cleaning schedule's jobs, on the server (phase 1, Kian's rulings of 2026-10-14; the model is
 * app/lib/schedule/model.ts, the sync that makes and watches jobs app/lib/schedule/sync.ts).
 *
 * `cleaning_jobs` is reached only through the Admin SDK: the admin's Schedule (assignments), the cleaner app (Mark
 * cleaned, Undo) and the Team page (a cleaner deactivated or deleted comes off their jobs). firestore.rules denies
 * every browser.
 *
 * ── Mark cleaned (Kian's rulings 4–7) ──
 * By a cleaner assigned to the job, from its checkout day on, never on a job whose booking changed (Kian's answer of
 * the evening): one transaction makes a 37B cleaning at once — at the property's preset (Kian's ruling of 2026-10-19,
 * app/lib/cleanings/prices.ts): with one cleaner on the job, the long-term preset for a stay of 28 nights or more, else
 * the short-term one, none when the property has no such preset; with two or more cleaners, none, and the admin types
 * the split — dated the checkout day (recommendation 2), and puts its ID on the cleaner's assignment. No proof is asked
 * for. Pressing it again after an answer was lost makes nothing twice. The cleaner's default rate is no longer read.
 *
 * ── Undo (ruling 6; recommendation 3; the evening's answers) ──
 * The cleaner's own mark, until a finished statement prints the cleaning, within the 45 days their list reaches:
 * the cleaning is deleted, never having reached an owner, and the job's history keeps who marked it, when, its ID and
 * its amount. A cleaning the office removed is the office's.
 *
 * ── Removed by the office, and reopened (Kian's ruling of 2026-10-14, night) ──
 * When an admin deletes or removes a job's cleaning (server-cleanings.ts), the job keeps the mark as "removed by the
 * office", and that cleaner can neither mark it again nor undo it. An admin can reopen it for them from the Schedule:
 * the mark comes off, recorded in the job's history, and their next Mark cleaned makes a new cleaning.
 *
 * ── Assignments (ruling 2; one cleaner per job since Build 2, Kian's ruling of 2026-11-03) ──
 * An admin sets who is on a job — one active cleaner, never a handyman, or nobody — never on a job whose booking
 * changed; a cleaner not yet marked can be taken off. Each change is a history event naming the admin. A second
 * cleaner is refused (409 JOB_ONE_CLEANER); an older job with two still reads.
 *
 * ── Build 2 (2026-11-03) ──
 * - `addJob` makes any number of jobs on one property and day, each with its own ID (addedJobIdOf), label, cleaner
 *   and amount; JOB_EXISTS is gone.
 * - `deleteJob`: an admin deletes a job and its cleaning in one transaction, unless the cleaning is dated on or
 *   before a payment to its cleaner or printed on a finished statement (refused, with the reason). A deleted calendar
 *   job leaves a marker the sync honours (deleted_cleaning_jobs), so the next calendar read does not make it again;
 *   a changed booking may.
 *
 * ── The cleaning flow (Kian's rulings of 2026-11-01) ──
 * - `addJob` (ruling C): a job by hand, for any property, any date, any active cleaner, a chosen tier; the calendar
 *   never touches it.
 * - `swapCleaner` (ruling D): one cleaner off, another on, in one transaction, both logged.
 * - `recordCleaned` (ruling E): an admin marks the job for its assigned cleaner, through the same `markOf` as the
 *   cleaner's own Mark cleaned, so the cleaning, its amount, the statement line and the pay are the same; the job's
 *   history and the cleaning's name the admin.
 * - `markCleaned` takes the cleaner's note and "Ask for extra" (ruling F): kept on the assignment, the history and the
 *   cleaning; an asked extra holds the cleaning's money until an admin decides (server-cleanings.ts, decideExtra).
 * - `setJobAmount` (ruling B): the job's own amount, which a mark takes instead of the base price; while a mark's
 *   cleaning still waits (extra asked, or no amount), that cleaning follows it; once a cleaning's money counts, the
 *   amount is locked here and the cleaning is edited on the Cleanings tab.
 *
 * Failure contract: the reads throw when a read fails; the writes return a result naming what happened, "may or
 * may not have landed" included, and never throw.
 */

import { randomInt } from 'node:crypto';
import type { DocumentReference, Transaction } from 'firebase-admin/firestore';
import { getAdminDb } from './admin';
import { isDocumentId } from './server-leads';
import { cleanerFacingNamesOf, getCleanerFacingName, internalNameOf } from './server-property-names';
import { cleaningDayProblem, statementMonthOf, statementsPrinting } from './server-cleanings';
import { latestPaymentDay, paymentOnOrAfter } from './server-pay';
import type { PaymentView } from '@/app/lib/pay/model';
import { monthBounds, type PersonJob } from '@/app/lib/pay/month';
import { CLEANERS_COLLECTION, fieldText, roleOf, type Actor, type Refusal } from '@/app/lib/cleaners/model';
import { CLEANINGS_COLLECTION, CLEANING_SCHEMA_VERSION, readCleaning, type Cleaning, type CleaningEvent } from '@/app/lib/cleanings/model';
import { TIER_WORDS, markAmount, type AmountSource, type PresetKind } from '@/app/lib/cleanings/prices';
import { pricesInTx } from './server-cleaning-prices';
import { addedJobAmount, addedJobDayProblem, canRecordOnAdd } from '@/app/lib/schedule/add-job';
import { readCurrent } from '@/app/lib/availability/store';
import { torontoDay } from '@/app/lib/availability/days';
import { MONTHLY_REPORTS_COLLECTION, monthOfDay } from '@/app/lib/reports/model';
import {
  CLEANER_LIST_DAYS,
  CLEANING_JOBS_COLLECTION,
  DELETED_JOBS_COLLECTION,
  DEFAULT_JOB_LABEL,
  DELETED_JOB_SCHEMA_VERSION,
  JOB_SCHEMA_VERSION,
  addedJobIdOf,
  cleanerListFrom,
  jobEvent,
  markRefusal,
  newAssignment,
  readJob,
  recordRefusal,
  reopenRefusal,
  type Assignment,
  type AssigneeView,
  type CleanerJobView,
  type CleaningJob,
  type ExtraState,
  type JobView,
  type ScheduleRead,
  type StoredJob,
  type TeamMember,
  type UnmarkedJob,
} from '@/app/lib/schedule/model';

function grpcCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? String(code) : typeof code === 'string' ? code : 'unknown';
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null);
const distinct = (ids: string[]) => [...new Set(ids.filter((id) => isDocumentId(id)))];

/** Stored jobs read strictly; one not in the written shape is logged by ID and left out. */
function readJobs(docs: { id: string; data: () => Record<string, unknown> }[]): { jobs: StoredJob[]; unreadable: number } {
  const jobs: StoredJob[] = [];
  let unreadable = 0;
  for (const doc of docs) {
    const job = readJob(doc.id, doc.data());
    if (job) jobs.push(job);
    else {
      unreadable += 1;
      console.error(`[jobs] cleaning_jobs/${doc.id} is not in the written shape; left out`);
    }
  }
  return { jobs, unreadable };
}

// ─── The Schedule (admin) ──────────────────────────────────────

/**
 * The jobs whose checkout falls from `from` to `to` (Toronto days, both included), with their properties' current
 * names and listed times, every assignee's name and status, each mark's cleaning as it stands, and the calendar
 * copy's state. Reads: the jobs, their properties (name and times only), the team, the cleanings marked, and the copy.
 *
 * @throws if a read fails.
 */
export async function readSchedule(from: string, to: string): Promise<ScheduleRead> {
  const db = getAdminDb();
  const [jobsSnap, teamSnap, copy] = await Promise.all([
    db.collection(CLEANING_JOBS_COLLECTION).where('checkout', '>=', from).where('checkout', '<=', to).get(),
    db.collection(CLEANERS_COLLECTION).select('name', 'role', 'status').get(),
    readCurrent(db),
  ]);
  const { jobs, unreadable } = readJobs(jobsSnap.docs);
  const team: TeamMember[] = teamSnap.docs
    .map((doc) => ({ id: doc.id, name: fieldText(doc.get('name')), role: roleOf({ role: doc.get('role') }), status: fieldText(doc.get('status')) }))
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', 'en-CA') || a.id.localeCompare(b.id));
  const byCleaner = new Map(team.map((member) => [member.id, member]));

  const propertyIds = distinct(jobs.map((job) => job.propertyId));
  const cleaningIds = distinct(jobs.flatMap((job) => job.cleanerIds.filter((cid) => job.assignments[cid].removedAt === null).map((cid) => job.assignments[cid].cleaningId).filter((id): id is string => id !== null)));
  const failedIds = copy ? Object.entries(copy.properties).filter(([, entry]) => entry.status === 'failed').map(([propertyId]) => propertyId) : [];
  const [propertyDocs, cleaningDocs, facing] = await Promise.all([
    propertyIds.length ? db.getAll(...propertyIds.map((id) => db.collection('properties').doc(id)), { fieldMask: ['name', 'details'] }) : Promise.resolve([]),
    cleaningIds.length ? db.getAll(...cleaningIds.map((id) => db.collection(CLEANINGS_COLLECTION).doc(id)), { fieldMask: ['status', 'amountCents', 'amountFrom', 'extra', 'history'] }) : Promise.resolve([]),
    cleanerFacingNamesOf([...propertyIds, ...failedIds]),
  ]);
  // Each property by the name the admin shows: its cleaner-facing name, usually the address, else its public title
  // (Kian's rulings of 2026-10-15, evening), as the cleaner app's job list already names it.
  const properties = new Map(propertyDocs.filter((doc) => doc.exists).map((doc) => {
    const details = doc.get('details');
    const d = details && typeof details === 'object' ? (details as Record<string, unknown>) : {};
    return [doc.id, { name: internalNameOf(facing, doc.id, fieldText(doc.get('name'))), checkOut: text(d.checkOut), checkIn: text(d.checkIn) }];
  }));
  const cleanings = new Map(cleaningDocs.filter((doc) => doc.exists).map((doc) => {
    const amount: unknown = doc.get('amountCents');
    const from: unknown = doc.get('amountFrom');
    const amountFrom: AmountSource | null = from === 'short' || from === 'mid' || from === 'long' || from === 'typed' || from === 'job' ? from : null;
    const extraStatus: unknown = doc.get('extra.status');
    const extra: ExtraState = extraStatus === 'asked' || extraStatus === 'approved' || extraStatus === 'declined' ? extraStatus : null;
    const history: unknown = doc.get('history');
    return [doc.id, { status: fieldText(doc.get('status')), amountCents: typeof amount === 'number' ? amount : null, amountFrom, extra, seen: Array.isArray(history) ? history.length : 0 }];
  }));

  const views: JobView[] = jobs.map((job) => {
    const { assignments, ...rest } = job;
    const property = properties.get(job.propertyId);
    const feed = copy?.properties[job.propertyId];
    const assignees: AssigneeView[] = job.cleanerIds.map((cid) => {
      const a = assignments[cid];
      const member = byCleaner.get(cid);
      const cleaning = a.cleaningId === null || a.removedAt !== null ? null : cleanings.has(a.cleaningId) ? { state: 'found' as const, ...cleanings.get(a.cleaningId)! } : { state: 'missing' as const, status: null, amountCents: null, amountFrom: null, extra: null, seen: 0 };
      return { ...a, cleanerId: cid, name: member?.name ?? a.nameAtAssignment, status: member?.status ?? null, state: member ? 'found' : 'missing', cleaning };
    });
    return {
      ...rest,
      property: property ? { state: 'found', name: property.name, checkOut: property.checkOut, checkIn: property.checkIn } : { state: 'missing', name: null, checkOut: null, checkIn: null },
      assignees,
      calendar: { status: feed?.status ?? null, failedSince: feed?.failedSince ?? null, fetchedAt: feed?.fetchedAt ?? null },
    };
  });
  views.sort((a, b) => a.checkout.localeCompare(b.checkout) || (a.property.name ?? '').localeCompare(b.property.name ?? '', 'en-CA') || a.id.localeCompare(b.id));

  const failed = copy
    ? Object.entries(copy.properties)
        .filter(([, entry]) => entry.status === 'failed')
        .map(([propertyId, entry]) => ({ propertyId, name: internalNameOf(facing, propertyId, entry.name), since: entry.failedSince ?? null }))
    : [];
  return { jobs: views, team, calendar: { refreshedAt: copy?.refreshedAt ?? null, failed }, unreadable };
}

// ─── Assignments (admin) ───────────────────────────────────────

export type SetAssigneesResult =
  | { kind: 'saved'; job: StoredJob; changed: boolean }
  | { kind: 'not-found' }
  | { kind: 'changed-since' }
  | { kind: 'unreadable' }
  /** Nobody is added to a job whose booking changed. */
  | { kind: 'booking-changed' }
  /** They marked it: their mark and cleaning stay; the office changes the cleaning under 37B. */
  | { kind: 'marked'; name: string | null }
  | { kind: 'not-assignable'; name: string | null; why: 'missing' | 'not-a-cleaner' | 'inactive' }
  /** Two or more cleaners asked for: a job has one (Build 2). */
  | { kind: 'one-cleaner' }
  | { kind: 'failed' };

export const ASSIGN_REFUSALS: Record<'not-found' | 'changed-since' | 'unreadable' | 'booking-changed' | 'one-cleaner' | 'failed', Refusal> = {
  'not-found': { status: 404, code: 'JOB_NOT_FOUND', message: 'No such job.', hint: 'Reload the Schedule.' },
  'one-cleaner': { status: 409, code: 'JOB_ONE_CLEANER', message: 'A job has one cleaner.', hint: 'Nothing was saved. Add another job on the same day for a second cleaner.' },
  'changed-since': { status: 409, code: 'JOB_CHANGED', message: 'This job changed since the page loaded.', hint: 'Nothing was saved. Reload, check what changed, and try again.' },
  unreadable: { status: 500, code: 'JOB_UNREADABLE', message: 'This job is not in the shape a change needs.', hint: 'Nothing was saved.' },
  'booking-changed': { status: 409, code: 'JOB_BOOKING_CHANGED', message: 'This job’s booking changed: nobody new is put on it.', hint: 'Nothing was saved. Assign the job for the booking as it is now.' },
  failed: { status: 502, code: 'JOB_SAVE_FAILED', message: 'Could not save who is on the job.', hint: 'It may or may not have been saved. Reload the Schedule to see.' },
};

/** A job has one cleaner (Kian's ruling of 2026-11-03, Build 2). */
export const MAX_ASSIGNEES = 1;

/**
 * Set who is on a job, as the admin saw it (`seen`: its history's length): one active cleaner, never a handyman
 * (ruling 2), or nobody; nobody is put on a job whose booking changed; two or more are refused (Build 2). A cleaner
 * taken off must not have marked it. Nothing differs, nothing is written.
 */
export async function setAssignees(actor: Actor, jobId: string, wanted: string[], seen: number): Promise<SetAssigneesResult> {
  const db = getAdminDb();
  const ref = db.collection(CLEANING_JOBS_COLLECTION).doc(jobId);
  try {
    return await db.runTransaction(async (tx): Promise<SetAssigneesResult> => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { kind: 'not-found' };
      const job = readJob(snap.id, snap.data() ?? {});
      if (!job) return { kind: 'unreadable' };
      if (job.history.length !== seen) return { kind: 'changed-since' };
      const want = [...new Set(wanted)];
      if (want.length > MAX_ASSIGNEES) return { kind: 'one-cleaner' };
      const added = want.filter((cid) => !job.cleanerIds.includes(cid));
      const removed = job.cleanerIds.filter((cid) => !want.includes(cid));
      if (added.length === 0 && removed.length === 0) return { kind: 'saved', job, changed: false };
      if (added.length > 0 && job.status !== 'open') return { kind: 'booking-changed' };
      for (const cid of removed) {
        if (job.assignments[cid].cleaningId !== null) return { kind: 'marked', name: job.assignments[cid].nameAtAssignment };
      }
      const docs = added.length ? await tx.getAll(...added.map((cid) => db.collection(CLEANERS_COLLECTION).doc(cid)), { fieldMask: ['name', 'role', 'status'] }) : [];
      const names = new Map<string, string | null>();
      for (const doc of docs) {
        const name = fieldText(doc.get('name'));
        if (!doc.exists) return { kind: 'not-assignable', name: null, why: 'missing' };
        if (roleOf({ role: doc.get('role') }) !== 'cleaner') return { kind: 'not-assignable', name, why: 'not-a-cleaner' };
        if (doc.get('status') !== 'active') return { kind: 'not-assignable', name, why: 'inactive' };
        names.set(doc.id, name);
      }

      const at = new Date().toISOString();
      const assignments: Record<string, Assignment> = {};
      const cleanerIds: string[] = [];
      for (const cid of job.cleanerIds) {
        if (removed.includes(cid)) continue;
        assignments[cid] = job.assignments[cid];
        cleanerIds.push(cid);
      }
      const events = [...job.history];
      for (const cid of removed) events.push(jobEvent(at, 'unassigned', actor, { cleanerId: cid, cleanerName: job.assignments[cid].nameAtAssignment }));
      for (const cid of added) {
        assignments[cid] = newAssignment(names.get(cid) ?? null, at, actor);
        cleanerIds.push(cid);
        events.push(jobEvent(at, 'assigned', actor, { cleanerId: cid, cleanerName: names.get(cid) ?? null }));
      }
      tx.update(ref, { cleanerIds, assignments, history: events });
      return { kind: 'saved', job: { ...job, cleanerIds, assignments, history: events }, changed: true };
    });
  } catch (err) {
    console.error(`[jobs] assigning on ${jobId} failed: grpc code ${grpcCode(err)}`);
    return { kind: 'failed' };
  }
}

// ─── A cleaner's list ──────────────────────────────────────────

/** What a cleaner's list needs of a property: its names and listed times. */
export interface JobProperty {
  name: string | null;
  city: string | null;
  checkOut: string | null;
  checkIn: string | null;
}

/**
 * The cleanings among `ids` that a finished statement prints — current or since replaced, as a cost row, in
 * `entryIds` or as an adjustment: their Undo is over. Reads each property's finished statements once.
 *
 * @throws if a read fails.
 */
async function printedAmong(byProperty: Map<string, string[]>): Promise<Set<string>> {
  const db = getAdminDb();
  const printed = new Set<string>();
  await Promise.all(
    [...byProperty].map(async ([propertyId, ids]) => {
      const snap = await db.collection(MONTHLY_REPORTS_COLLECTION).where('propertyId', '==', propertyId).select('entryIds', 'costs', 'adjustments').get();
      const names = (rows: unknown, id: string) => Array.isArray(rows) && rows.some((row) => !!row && typeof row === 'object' && (row as Record<string, unknown>).entryId === id);
      for (const doc of snap.docs) {
        const fields = doc.data();
        for (const id of ids) if ((Array.isArray(fields.entryIds) && fields.entryIds.includes(id)) || names(fields.costs, id) || names(fields.adjustments, id)) printed.add(id);
      }
    }),
  );
  return printed;
}

/** What changed on a job, as a cleaner's card says it (Kian's ruling R2): null while the booking stands. */
const changeOf = (job: StoredJob): CleanerJobView['change'] => (job.status === 'booking-changed' && job.change ? { kind: job.change.kind, movedTo: job.change.movedTo } : null);

/** The office recorded this cleaner's mark (ruling E): the job's own `marked` event for their cleaning, by an admin. */
const recordedByOffice = (job: StoredJob, cleanerId: string): boolean => {
  const a = job.assignments[cleanerId];
  return !!a && a.cleaningId !== null && job.history.some((event) => event.action === 'marked' && event.cleanerId === cleanerId && event.cleaningId === a.cleaningId && event.actor.role === 'admin');
};

/**
 * Whether each of these cleanings still waits on its note (Build 1, item 2: the note is the reason; ruling F's extra
 * ask): read field-masked, one read each, only for the marks that carried a note. A cleaning that cannot be found or
 * read waits on nothing: the card then reads "Cleaned" rather than amber for ever.
 *
 * @throws if the read fails.
 */
async function stillAskedOf(cleaningIds: string[]): Promise<Set<string>> {
  const asked = new Set<string>();
  if (cleaningIds.length === 0) return asked;
  const db = getAdminDb();
  const docs = await db.getAll(...cleaningIds.map((id) => db.collection(CLEANINGS_COLLECTION).doc(id)), { fieldMask: ['extra', 'status'] });
  for (const doc of docs) {
    if (doc.exists && doc.get('status') === 'logged' && doc.get('extra.status') === 'asked') asked.add(doc.id);
  }
  return asked;
}

/**
 * A cleaner's jobs as their app shows them: the jobs they are on whose checkout is within the 45 days their list
 * reaches (Kian's answer of the evening), or ahead; a job whose booking changed only until its checkout day has
 * passed, unless they marked it. Each with whether they can mark it now, and, once marked, whether Undo still holds.
 * Reads: the jobs they are on within those days (`cleanerIds` array-contains and `checkout` from 45 days back: theirs
 * only, never every job of the 45 days, Kian's instruction of 2026-10-15, and never their older jobs, Kian's approval
 * of the index the same day), and the finished statements of the properties whose cleanings they marked. The query
 * needs the composite index on `cleanerIds` and `checkout` in firestore.indexes.json; without it Firestore refuses it.
 *
 * The cleanings their marks made are not read (2026-10-19, the Schedule's round 1): a mark's cleaning stands while the
 * mark does. Undo clears the mark when it deletes the cleaning; the office's removal or deletion leaves it "removed
 * by the office" (keepMarkRemoved); so a mark not removed is a logged cleaning of the job's property, read from the
 * job alone. Undo itself still reads the cleaning before it acts. One exception since Build 1 (2026-11-02): a mark
 * that carried a note reads its cleaning's extra state (`stillAskedOf`, one read each), so the card's amber "note
 * sent" clears to "Cleaned" once the office has decided, as Kian's ruling asks.
 *
 * `properties` names them: a map already read (the start call reads every property for its unit list), or a loader
 * the jobs' properties are read through, once the jobs are known (the re-read after a refresh).
 *
 * @throws if a read fails.
 */
export async function cleanerJobs(cleanerId: string, properties: ReadonlyMap<string, JobProperty> | ((propertyIds: string[]) => Promise<ReadonlyMap<string, JobProperty>>), today: string = torontoDay(), paidThrough: string | null = null): Promise<CleanerJobView[]> {
  const db = getAdminDb();
  const from = cleanerListFrom(today);
  const snap = await db.collection(CLEANING_JOBS_COLLECTION).where('cleanerIds', 'array-contains', cleanerId).where('checkout', '>=', from).get();
  const mine = readJobs(snap.docs).jobs.filter((job) => job.cleanerIds.includes(cleanerId) && job.checkout >= from);
  const marked = mine.filter((job) => job.assignments[cleanerId].cleaningId !== null && job.assignments[cleanerId].removedAt === null);
  const byProperty = new Map<string, string[]>();
  for (const job of marked) byProperty.set(job.propertyId, [...(byProperty.get(job.propertyId) ?? []), job.assignments[cleanerId].cleaningId as string]);
  const shown = mine.filter((job) => job.status === 'open' || job.checkout >= today || job.assignments[cleanerId].cleaningId !== null);
  const noted = marked.filter((job) => job.assignments[cleanerId].extraAsked).map((job) => job.assignments[cleanerId].cleaningId as string);
  const [printed, named, stillAsked] = await Promise.all([printedAmong(byProperty), typeof properties === 'function' ? properties(distinct(shown.map((job) => job.propertyId))) : Promise.resolve(properties), stillAskedOf(noted)]);

  return shown
    .map((job): CleanerJobView => {
      const a = job.assignments[cleanerId];
      const property = named.get(job.propertyId);
      const standing = a.cleaningId !== null && a.removedAt === null;
      // Never on a cleaning dated on or before a payment to them (`paidThrough`, its latest day): the office removes those.
      const onStatement = standing && printed.has(a.cleaningId as string);
      const paid = standing && paidThrough !== null && job.checkout <= paidThrough;
      return {
        id: job.id,
        propertyId: job.propertyId,
        propertyName: property?.name ?? job.propertyNameAtCreation,
        city: property?.city ?? null,
        checkout: job.checkout,
        checkOutTime: property?.checkOut ?? null,
        checkInTime: property?.checkIn ?? null,
        nextCheckIn: job.nextCheckIn,
        status: job.status,
        change: changeOf(job),
        markedAt: a.markedAt,
        label: job.label,
        canUndo: standing && !onStatement && !paid,
        undoBlocked: !standing ? null : onStatement ? 'statement' : paid ? 'paid' : null,
        recordedByOffice: recordedByOffice(job, cleanerId),
        note: a.note,
        extraAsked: a.extraAsked && standing && stillAsked.has(a.cleaningId as string),
        markRefusal: markRefusal(job, cleanerId, today),
      };
    })
    .sort((x, y) => x.checkout.localeCompare(y.checkout) || (x.propertyName ?? '').localeCompare(y.propertyName ?? '', 'en-CA') || x.id.localeCompare(y.id));
}

/**
 * A cleaner's list read on its own, for their app to read its jobs again once a refresh it was told of has ended
 * (Kian's ruling R1 of 2026-10-19): the jobs, then only the properties they name (name, city, listed times, each
 * one's name for cleaners), and the latest day a payment to them was made, as the start call reads it.
 *
 * @throws if a read fails.
 */
export async function cleanerJobsRead(cleanerId: string, today: string = torontoDay()): Promise<CleanerJobView[]> {
  const db = getAdminDb();
  const paidThrough = await latestPaymentDay(cleanerId);
  return cleanerJobs(
    cleanerId,
    async (ids) => {
      if (ids.length === 0) return new Map();
      const [docs, facing] = await Promise.all([db.getAll(...ids.map((id) => db.collection('properties').doc(id)), { fieldMask: ['name', 'addressDetails', 'details'] }), cleanerFacingNamesOf(ids)]);
      return jobPropertiesOf(docs.filter((doc) => doc.exists), facing);
    },
    today,
    paidThrough,
  );
}

/** Properties as a cleaner's list names them: the cleaner-facing name when set (dispatch 21), the city, the listed times. */
export function jobPropertiesOf(docs: { id: string; get: (field: string) => unknown }[], facing: ReadonlyMap<string, string>): Map<string, JobProperty> {
  return new Map(
    docs.map((doc) => {
      const address = doc.get('addressDetails');
      const details = doc.get('details');
      const d = details && typeof details === 'object' ? (details as Record<string, unknown>) : {};
      return [doc.id, { name: facing.get(doc.id) ?? text(doc.get('name')), city: address && typeof address === 'object' ? text((address as Record<string, unknown>).city) : null, checkOut: text(d.checkOut), checkIn: text(d.checkIn) }];
    }),
  );
}

/**
 * One job as this cleaner's app shows it, after a mark or an undo: its property read again (its name for cleaners,
 * city and listed times; two reads), and the latest day a payment to them was made (one read), so a mark on a day a
 * payment already covers shows "Can't undo: already paid" at once rather than Undo. `canUndo` is the caller's: true
 * right after a mark (subject to that payment), false after an undo. A mark just made with a note waits on it.
 *
 * @throws if a read fails.
 */
export async function oneCleanerJob(job: StoredJob, cleanerId: string, canUndo: boolean, today: string = torontoDay()): Promise<CleanerJobView> {
  const db = getAdminDb();
  const [[doc], facing, paidThrough] = await Promise.all([db.getAll(db.collection('properties').doc(job.propertyId), { fieldMask: ['name', 'addressDetails', 'details'] }), getCleanerFacingName(job.propertyId), canUndo ? latestPaymentDay(cleanerId) : Promise.resolve(null)]);
  const property = doc.exists ? jobPropertiesOf([doc], facing ? new Map([[job.propertyId, facing]]) : new Map()).get(job.propertyId) : undefined;
  const a = job.assignments[cleanerId];
  const standing = !!a?.cleaningId && a.removedAt === null;
  const paid = standing && paidThrough !== null && job.checkout <= paidThrough;
  return {
    id: job.id,
    propertyId: job.propertyId,
    propertyName: property?.name ?? job.propertyNameAtCreation,
    city: property?.city ?? null,
    checkout: job.checkout,
    checkOutTime: property?.checkOut ?? null,
    checkInTime: property?.checkIn ?? null,
    nextCheckIn: job.nextCheckIn,
    status: job.status,
    change: changeOf(job),
    label: job.label,
    markedAt: a?.markedAt ?? null,
    canUndo: canUndo && standing && !paid,
    undoBlocked: canUndo && paid ? 'paid' : null,
    recordedByOffice: recordedByOffice(job, cleanerId),
    note: a?.note ?? null,
    extraAsked: standing && (a?.extraAsked ?? false),
    markRefusal: markRefusal(job, cleanerId, today),
  };
}

// ─── Mark cleaned, Undo (cleaner) ──────────────────────────────

export type MarkResult =
  | { kind: 'marked'; job: StoredJob; cleaningId: string; amountCents: number | null; statementMonth: string }
  /** Marked already, by an earlier press whose answer was lost: nothing was made twice. */
  | { kind: 'already'; job: StoredJob; cleaningId: string }
  | { kind: 'not-found' }
  | { kind: 'not-assigned' }
  /** The office removed the cleaning their mark made: they mark it again only once an admin reopens it. */
  | { kind: 'removed' }
  | { kind: 'booking-changed' }
  | { kind: 'too-early'; opensOn: string }
  | { kind: 'out-of-reach' }
  | { kind: 'no-such-property' }
  | { kind: 'not-a-cleaner' }
  | { kind: 'bad-day'; problem: string }
  | { kind: 'unreadable' }
  | { kind: 'failed' };

export const MARK_REFUSALS: Record<Exclude<MarkResult['kind'], 'marked' | 'already' | 'too-early' | 'bad-day'>, Refusal> = {
  'not-found': { status: 404, code: 'JOB_NOT_FOUND', message: 'This job is not on the schedule any more.', hint: 'Ask the office.' },
  'not-assigned': { status: 403, code: 'JOB_NOT_YOURS', message: 'You are not on this job.', hint: 'Ask the office.' },
  removed: { status: 409, code: 'JOB_MARK_REMOVED', message: 'The office removed your cleaning of this job.', hint: 'Nothing was recorded. Ask the office.' },
  'booking-changed': { status: 409, code: 'JOB_BOOKING_CHANGED', message: 'This booking changed.', hint: 'Nothing was recorded. Ask the office.' },
  'out-of-reach': { status: 409, code: 'JOB_OUT_OF_REACH', message: 'This job is too far back.', hint: 'Nothing was recorded. The office logs it.' },
  'no-such-property': { status: 404, code: 'PROPERTY_NOT_FOUND', message: 'This property is not on the list any more.', hint: 'Nothing was recorded. Ask the office.' },
  'not-a-cleaner': { status: 403, code: 'NOT_A_CLEANER', message: 'Only a cleaner marks a job cleaned.', hint: 'Nothing was recorded.' },
  unreadable: { status: 500, code: 'JOB_UNREADABLE', message: 'This job could not be read.', hint: 'Nothing was recorded. Ask the office.' },
  failed: { status: 502, code: 'MARK_FAILED', message: 'Not confirmed.', hint: 'Tap Mark cleaned again: it won’t be counted twice.' },
};

/** What a cleaner sends with their mark (Kian's ruling F): an optional note, and the reason when they ask for extra. */
export interface MarkInput {
  note?: string | null;
  extraReason?: string | null;
}

/**
 * The cleaning one mark makes for one cleaner on a job, with the assignment and the history event that go with it:
 * one shape for a cleaner's own Mark cleaned and an admin's Record as cleaned (ruling E), so the amount
 * (`markAmount`: the job's own amount, else the preset its tier takes, none with two or more cleaners), the day, the
 * statement line and the pay are the same. `actor` is who did it: the cleaner, or the admin recording for them. A
 * mark by the office says so in its `logged` event and in the job's history.
 */
function markOf(db: ReturnType<typeof getAdminDb>, job: StoredJob, cleanerId: string, cleanerName: string | null, actor: Actor, prices: Awaited<ReturnType<typeof pricesInTx>>, propertyName: string | null, at: string, input: MarkInput): { ref: DocumentReference; stored: Cleaning; assignment: Assignment; event: ReturnType<typeof jobEvent> } {
  const amount = markAmount(prices, job);
  const suggested = { from: amount.from, cents: amount.cents };
  const ref = db.collection(CLEANINGS_COLLECTION).doc();
  const note = input.note ?? null;
  const extraReason = input.extraReason ?? null;
  const byOffice = actor.role === 'admin';
  const stored: Cleaning = {
    schemaVersion: CLEANING_SCHEMA_VERSION,
    propertyId: job.propertyId,
    propertyNameAtEntry: propertyName,
    cleanerId,
    cleanerNameAtEntry: cleanerName,
    day: job.checkout,
    amountCents: suggested.cents,
    note,
    status: 'logged',
    suggested,
    amountFrom: amount.amountFrom,
    createdAt: at,
    actor,
    history: [{ at, action: 'logged', actor, reason: byOffice ? 'recorded by the office' : null }],
    jobId: job.id,
    extra: extraReason === null ? null : { status: 'asked', reason: extraReason, askedAt: at, decidedAt: null, decidedBy: null },
  };
  const assignment: Assignment = { ...job.assignments[cleanerId], cleaningId: ref.id, markedAt: at, note, extraAsked: extraReason !== null };
  const event = jobEvent(at, 'marked', actor, { cleanerId, cleanerName, cleaningId: ref.id, amountCents: suggested.cents, reason: byOffice ? 'recorded by the office' : null, note, extra: extraReason });
  return { ref, stored, assignment, event };
}

/**
 * Mark a job cleaned for this cleaner: one transaction makes their 37B cleaning and puts it on their assignment. The
 * amount is the job's own amount when an admin set one (ruling B), else the property's preset by the job's tier, when
 * they are its one cleaner, else null (`markAmount`) — never typed by them, and never shown to them. Their note and
 * "Ask for extra" (ruling F) go on the cleaning, the assignment and the history.
 */
export async function markCleaned(cleaner: { id: string; name: string | null }, jobId: string, now: Date = new Date(), input: MarkInput = {}): Promise<MarkResult> {
  const db = getAdminDb();
  const jobRef = db.collection(CLEANING_JOBS_COLLECTION).doc(jobId);
  const today = torontoDay(now);
  try {
    return await db.runTransaction(async (tx): Promise<MarkResult> => {
      const snap = await tx.get(jobRef);
      if (!snap.exists) return { kind: 'not-found' };
      const job = readJob(snap.id, snap.data() ?? {});
      if (!job) return { kind: 'unreadable' };
      const refusal = markRefusal(job, cleaner.id, today);
      if (refusal === 'already-marked') return { kind: 'already', job, cleaningId: job.assignments[cleaner.id].cleaningId as string };
      if (refusal === 'not-assigned') return { kind: 'not-assigned' };
      if (refusal === 'removed') return { kind: 'removed' };
      if (refusal === 'booking-changed') return { kind: 'booking-changed' };
      if (refusal === 'too-early') return { kind: 'too-early', opensOn: job.checkout };
      if (job.checkout < cleanerListFrom(today)) return { kind: 'out-of-reach' };
      const problem = cleaningDayProblem(job.checkout, now);
      if (problem) return { kind: 'bad-day', problem };

      const [[property, account], prices] = await Promise.all([tx.getAll(db.collection('properties').doc(job.propertyId), db.collection(CLEANERS_COLLECTION).doc(cleaner.id), { fieldMask: ['name', 'role', 'status'] }), pricesInTx(tx, job.propertyId)]);
      if (!property.exists) return { kind: 'no-such-property' };
      if (!account.exists || roleOf({ role: account.get('role') }) !== 'cleaner' || account.get('status') !== 'active') return { kind: 'not-a-cleaner' };
      const statementMonth = await statementMonthOf(job.propertyId, monthOfDay(job.checkout), tx);

      const at = now.toISOString();
      const actor: Actor = { role: 'cleaner', id: cleaner.id, name: fieldText(account.get('name')) ?? cleaner.name };
      const { ref, stored, assignment, event } = markOf(db, job, cleaner.id, actor.name, actor, prices, fieldText(property.get('name')), at, input);
      const next = { assignments: { ...job.assignments, [cleaner.id]: assignment }, history: [...job.history, event] };
      tx.create(ref, stored);
      tx.update(jobRef, next);
      return { kind: 'marked', job: { ...job, ...next }, cleaningId: ref.id, amountCents: stored.amountCents, statementMonth };
    });
  } catch (err) {
    console.error(`[jobs] marking ${jobId} failed: grpc code ${grpcCode(err)}`);
    return { kind: 'failed' };
  }
}

export type RecordResult =
  | { kind: 'recorded'; job: StoredJob; cleanings: { cleanerId: string; cleaningId: string; amountCents: number | null }[]; statementMonth: string }
  | { kind: 'not-found' }
  | { kind: 'changed-since' }
  | { kind: 'unreadable' }
  | { kind: 'nothing-to-record' }
  | { kind: 'not-assigned'; cleanerId: string }
  | { kind: 'removed'; name: string | null }
  | { kind: 'booking-changed' }
  | { kind: 'too-early'; opensOn: string }
  | { kind: 'bad-day'; problem: string }
  | { kind: 'no-such-property' }
  | { kind: 'not-a-cleaner'; name: string | null }
  | { kind: 'failed' };

/**
 * Record a job as cleaned for its assigned cleaners (Kian's ruling E of 2026-11-01): "an admin action on any job
 * whose day has come. It counts exactly as if the assigned cleaner marked it (same amount logic, statement line and
 * pay). The audit log notes the admin." One transaction, one cleaning per cleaner named (those already marked are
 * left as they are), each through the same `markOf` as a cleaner's own mark, the admin as the actor of each; the
 * mark's rules hold (on the job, not removed by the office, the booking unchanged, from the checkout day on). As
 * the admin saw it (`seen`).
 */
export async function recordCleaned(actor: Actor, jobId: string, cleanerIds: readonly string[], seen: number, now: Date = new Date()): Promise<RecordResult> {
  const db = getAdminDb();
  const jobRef = db.collection(CLEANING_JOBS_COLLECTION).doc(jobId);
  const today = torontoDay(now);
  try {
    return await db.runTransaction(async (tx): Promise<RecordResult> => {
      const snap = await tx.get(jobRef);
      if (!snap.exists) return { kind: 'not-found' };
      const job = readJob(snap.id, snap.data() ?? {});
      if (!job) return { kind: 'unreadable' };
      if (job.history.length !== seen) return { kind: 'changed-since' };
      const wanted = [...new Set(cleanerIds)];
      const toMark: string[] = [];
      for (const cid of wanted) {
        const refusal = recordRefusal(job, cid, today);
        if (refusal === 'already-marked') continue;
        if (refusal === 'not-assigned') return { kind: 'not-assigned', cleanerId: cid };
        if (refusal === 'removed') return { kind: 'removed', name: job.assignments[cid].nameAtAssignment };
        if (refusal === 'booking-changed') return { kind: 'booking-changed' };
        if (refusal === 'too-early') return { kind: 'too-early', opensOn: job.checkout };
        toMark.push(cid);
      }
      if (toMark.length === 0) return { kind: 'nothing-to-record' };
      const problem = cleaningDayProblem(job.checkout, now);
      if (problem) return { kind: 'bad-day', problem };

      const [[property, ...accounts], prices] = await Promise.all([tx.getAll(db.collection('properties').doc(job.propertyId), ...toMark.map((cid) => db.collection(CLEANERS_COLLECTION).doc(cid)), { fieldMask: ['name', 'role', 'status'] }), pricesInTx(tx, job.propertyId)]);
      if (!property.exists) return { kind: 'no-such-property' };
      const names = new Map<string, string | null>();
      for (const account of accounts) {
        if (!account.exists || roleOf({ role: account.get('role') }) !== 'cleaner' || account.get('status') !== 'active') return { kind: 'not-a-cleaner', name: account.exists ? fieldText(account.get('name')) : (job.assignments[account.id]?.nameAtAssignment ?? null) };
        names.set(account.id, fieldText(account.get('name')) ?? job.assignments[account.id].nameAtAssignment);
      }
      const statementMonth = await statementMonthOf(job.propertyId, monthOfDay(job.checkout), tx);

      const at = now.toISOString();
      const assignments = { ...job.assignments };
      const events = [...job.history];
      const made: { cleanerId: string; cleaningId: string; amountCents: number | null }[] = [];
      for (const cid of toMark) {
        const { ref, stored, assignment, event } = markOf(db, job, cid, names.get(cid) ?? null, actor, prices, fieldText(property.get('name')), at, {});
        tx.create(ref, stored);
        assignments[cid] = assignment;
        events.push(event);
        made.push({ cleanerId: cid, cleaningId: ref.id, amountCents: stored.amountCents });
      }
      const next = { assignments, history: events };
      tx.update(jobRef, next);
      return { kind: 'recorded', job: { ...job, ...next }, cleanings: made, statementMonth };
    });
  } catch (err) {
    console.error(`[jobs] recording ${jobId} cleaned failed: grpc code ${grpcCode(err)}`);
    return { kind: 'failed' };
  }
}

export const RECORD_REFUSALS: Record<'not-found' | 'changed-since' | 'unreadable' | 'nothing-to-record' | 'booking-changed' | 'no-such-property' | 'failed', Refusal> = {
  'not-found': ASSIGN_REFUSALS['not-found'],
  'changed-since': ASSIGN_REFUSALS['changed-since'],
  unreadable: ASSIGN_REFUSALS.unreadable,
  'nothing-to-record': { status: 409, code: 'JOB_NOTHING_TO_RECORD', message: 'Everyone named has marked this job already.', hint: 'Nothing was recorded.' },
  'booking-changed': { status: 409, code: 'JOB_BOOKING_CHANGED', message: 'This job’s booking changed: it cannot be recorded as cleaned.', hint: 'Nothing was recorded.' },
  'no-such-property': { status: 404, code: 'PROPERTY_NOT_FOUND', message: 'This job’s property no longer exists.', hint: 'Nothing was recorded.' },
  failed: { status: 502, code: 'RECORD_FAILED', message: 'Not confirmed.', hint: 'It may or may not have been recorded. Reload the Schedule to see; recording again never counts a cleaning twice.' },
};

// ─── A job added by hand (ruling C) ────────────────────────────

export interface AddJobInput {
  propertyId: string;
  /** The day it is cleaned: from the statements floor (November 1, 2026) on, any day after. */
  checkout: string;
  /** An active cleaner to put on it, or nobody yet. */
  cleanerId: string | null;
  /** The tier the amount's price came from (the UX pass of 2026-11-06: the price chosen, short-term unless another was). */
  tier: PresetKind;
  /**
   * The amount the admin's field held, or none (empty). Exactly the tier's cleaning price is stored as that price (no
   * amount on the job: `addedJobAmount`); anything else is the job's own amount (ruling B).
   */
  amountCents: number | null;
  /** Its label (Build 2): "Deep clean", "Extra visit"; none typed reads DEFAULT_JOB_LABEL. */
  label?: string | null;
  /** "Already cleaned" (2026-11-06): recorded cleaned for its cleaner as it is added, exactly as Record as cleaned would. */
  alreadyCleaned?: boolean;
}

/** What "Already cleaned" made: the cleaning, as Record as cleaned answers it. */
export interface RecordedOnAdd {
  cleanings: { cleanerId: string; cleaningId: string; amountCents: number | null }[];
  statementMonth: string;
}

export type AddJobResult =
  | { kind: 'added'; job: StoredJob; propertyName: string | null; recorded: RecordedOnAdd | null }
  | { kind: 'no-such-property' }
  | { kind: 'not-assignable'; name: string | null; why: 'missing' | 'not-a-cleaner' | 'inactive' }
  /** Before the statements floor: "Statements start in November 2026". */
  | { kind: 'before-floor'; problem: string }
  /** "Already cleaned" with nobody on the job. */
  | { kind: 'needs-cleaner' }
  /** "Already cleaned" on a day that has not come. */
  | { kind: 'too-early'; opensOn: string }
  /** "Already cleaned" on a day a cleaning cannot be logged for (cleaningDayProblem: more than twelve months back). */
  | { kind: 'bad-day'; problem: string }
  | { kind: 'failed' };

export const ADD_JOB_REFUSALS: Record<'no-such-property' | 'needs-cleaner' | 'failed', Refusal> = {
  'no-such-property': { status: 404, code: 'PROPERTY_NOT_FOUND', message: 'That property does not exist.', hint: 'Nothing was added.' },
  'needs-cleaner': { status: 422, code: 'JOB_NEEDS_CLEANER', message: 'Already cleaned needs the cleaner who cleaned it.', hint: 'Nothing was added. Pick the cleaner, or untick Already cleaned.' },
  failed: { status: 502, code: 'JOB_SAVE_FAILED', message: 'Could not add the job.', hint: 'It may or may not have been added. Reload the Schedule to see.' },
};

/** Six lowercase letters and digits, drawn at random: the suffix that tells one added job from another on a day. */
function jobSuffix(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 6; i += 1) out += alphabet[randomInt(alphabet.length)];
  return out;
}

/**
 * Add a job by hand (Kian's ruling C of 2026-11-01; any number on one property and day since Build 2): for any
 * property, with or without a calendar, any date, any active cleaner or nobody, a chosen tier (short by default), a
 * label ("Deep clean"), and the job's own amount when the admin typed one (ruling B). The job's ID is the turnover's
 * with its own suffix (addedJobIdOf), so it never collides with the calendar's job or another added one; it reaches
 * the cleaner's app like any job and is marked the same way; the calendar never changes or settles it (origin
 * "admin"). One transaction: the property, the cleaner and the property's cleaning prices read, the job created.
 *
 * The UX pass (Kian's instruction of 2026-11-06):
 *   - A day before the statements floor (November 1, 2026) is refused: "Statements start in November 2026".
 *   - The amount the admin left in the field is stored by `addedJobAmount`, with the prices read here: exactly the
 *     tier's cleaning price is stored as that price (no amount on the job), anything else as the job's own amount.
 *   - "Already cleaned" (`alreadyCleaned`) records it cleaned for its cleaner in the same transaction, exactly as Record
 *     as cleaned does: the mark's rules (a cleaner on it, its day come, `cleaningDayProblem`), the same `markOf` (the
 *     cleaning, its amount, the "marked" event naming the admin), and the statement month it goes on. Either both the
 *     job and its cleaning are written, or neither. The route adds Record as cleaned's line to the activity log.
 */
export async function addJob(actor: Actor, input: AddJobInput, now: Date = new Date()): Promise<AddJobResult> {
  const db = getAdminDb();
  if (!isDocumentId(input.propertyId)) return { kind: 'no-such-property' };
  const dayProblem = addedJobDayProblem(input.checkout);
  if (dayProblem) return { kind: 'before-floor', problem: dayProblem };
  const recordNow = input.alreadyCleaned === true;
  if (recordNow) {
    if (input.cleanerId === null) return { kind: 'needs-cleaner' };
    if (!canRecordOnAdd(input.checkout, torontoDay(now))) return { kind: 'too-early', opensOn: input.checkout };
    const problem = cleaningDayProblem(input.checkout, now);
    if (problem) return { kind: 'bad-day', problem };
  }
  const id = addedJobIdOf(input.propertyId, input.checkout, jobSuffix());
  const ref = db.collection(CLEANING_JOBS_COLLECTION).doc(id);
  const label = (input.label ?? '').trim() === '' ? DEFAULT_JOB_LABEL : (input.label as string).trim();
  try {
    return await db.runTransaction(async (tx): Promise<AddJobResult> => {
      const [[property], prices] = await Promise.all([tx.getAll(db.collection('properties').doc(input.propertyId), { fieldMask: ['name'] }), pricesInTx(tx, input.propertyId)]);
      if (!property.exists) return { kind: 'no-such-property' };
      let cleaner: { id: string; name: string | null } | null = null;
      if (input.cleanerId !== null) {
        const [account] = await tx.getAll(db.collection(CLEANERS_COLLECTION).doc(input.cleanerId), { fieldMask: ['name', 'role', 'status'] });
        if (!account.exists) return { kind: 'not-assignable', name: null, why: 'missing' };
        const name = fieldText(account.get('name'));
        if (roleOf({ role: account.get('role') }) !== 'cleaner') return { kind: 'not-assignable', name, why: 'not-a-cleaner' };
        if (account.get('status') !== 'active') return { kind: 'not-assignable', name, why: 'inactive' };
        cleaner = { id: account.id, name };
      }
      // Record as cleaned's last read, before any write: the statement the cleaning goes on.
      const statementMonth = recordNow ? await statementMonthOf(input.propertyId, monthOfDay(input.checkout), tx) : null;
      const at = now.toISOString();
      const propertyName = fieldText(property.get('name'));
      const { tier, amountCents } = addedJobAmount(prices, input.tier, input.amountCents);
      const history = [jobEvent(at, 'added', actor, { reason: `${label} · ${TIER_WORDS[tier]} job`, after: { start: null, end: input.checkout } })];
      if (amountCents !== null) history.push(jobEvent(at, 'amount-set', actor, { amountCents }));
      if (cleaner) history.push(jobEvent(at, 'assigned', actor, { cleanerId: cleaner.id, cleanerName: cleaner.name }));
      const job: CleaningJob = {
        schemaVersion: JOB_SCHEMA_VERSION,
        propertyId: input.propertyId,
        propertyNameAtCreation: propertyName,
        checkout: input.checkout,
        reservation: null,
        calendarKey: '',
        origin: 'admin',
        tier,
        amountCents,
        label,
        nextCheckIn: null,
        status: 'open',
        change: null,
        cleanerIds: cleaner ? [cleaner.id] : [],
        assignments: cleaner ? { [cleaner.id]: newAssignment(cleaner.name, at, actor) } : {},
        createdAt: at,
        history,
      };
      if (!recordNow || !cleaner || statementMonth === null) {
        tx.create(ref, job);
        return { kind: 'added', job: { id, ...job }, propertyName, recorded: null };
      }
      // "Already cleaned": the cleaning Record as cleaned would make, through the same markOf, the admin as its actor.
      const refusal = recordRefusal(job, cleaner.id, torontoDay(now));
      if (refusal === 'too-early') return { kind: 'too-early', opensOn: input.checkout };
      if (refusal !== null) return { kind: 'failed' };
      const mark = markOf(db, { id, ...job }, cleaner.id, cleaner.name, actor, prices, propertyName, at, {});
      const marked: CleaningJob = { ...job, assignments: { ...job.assignments, [cleaner.id]: mark.assignment }, history: [...job.history, mark.event] };
      tx.create(ref, marked);
      tx.create(mark.ref, mark.stored);
      return { kind: 'added', job: { id, ...marked }, propertyName, recorded: { cleanings: [{ cleanerId: cleaner.id, cleaningId: mark.ref.id, amountCents: mark.stored.amountCents }], statementMonth } };
    });
  } catch (err) {
    console.error(`[jobs] adding ${id} failed: grpc code ${grpcCode(err)}`);
    return { kind: 'failed' };
  }
}

// ─── The job's own amount (ruling B) ───────────────────────────

export type SetJobAmountResult =
  | { kind: 'set'; job: StoredJob; changed: boolean; cleaningsChanged: number }
  | { kind: 'not-found' }
  | { kind: 'changed-since' }
  | { kind: 'unreadable' }
  /** A mark's cleaning already counts its money (not waiting on an extra ask, not without an amount): edited on the Cleanings tab. */
  | { kind: 'locked' }
  | { kind: 'failed' };

export const JOB_AMOUNT_REFUSALS: Record<'not-found' | 'changed-since' | 'unreadable' | 'locked' | 'failed', Refusal> = {
  'not-found': ASSIGN_REFUSALS['not-found'],
  'changed-since': ASSIGN_REFUSALS['changed-since'],
  unreadable: ASSIGN_REFUSALS.unreadable,
  locked: { status: 409, code: 'JOB_AMOUNT_LOCKED', message: 'A cleaning of this job already counts its money.', hint: 'Nothing was saved. Change that cleaning’s amount on the Cleanings tab.' },
  failed: { status: 502, code: 'JOB_SAVE_FAILED', message: 'Could not save the job’s amount.', hint: 'It may or may not have been saved. Reload the Schedule to see.' },
};

/**
 * Set, change or clear a job's own amount (Kian's ruling B of 2026-11-01): "before assignment or at any time before
 * the cleaning's money is approved. It beats the base price." As the admin saw it (`seen`). A mark's cleaning that
 * still waits — its cleaner asked for extra and no admin has decided, or it has no amount yet — follows the new
 * amount (its history says so); one whose money already counts locks the amount here.
 */
export async function setJobAmount(actor: Actor, jobId: string, amountCents: number | null, seen: number, now: Date = new Date()): Promise<SetJobAmountResult> {
  const db = getAdminDb();
  const ref = db.collection(CLEANING_JOBS_COLLECTION).doc(jobId);
  try {
    return await db.runTransaction(async (tx): Promise<SetJobAmountResult> => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { kind: 'not-found' };
      const job = readJob(snap.id, snap.data() ?? {});
      if (!job) return { kind: 'unreadable' };
      if (job.history.length !== seen) return { kind: 'changed-since' };
      if (job.amountCents === amountCents) return { kind: 'set', job, changed: false, cleaningsChanged: 0 };
      const marked = job.cleanerIds.map((cid) => job.assignments[cid]).filter((a) => a.cleaningId !== null && a.removedAt === null);
      const docs = marked.length ? await tx.getAll(...marked.map((a) => db.collection(CLEANINGS_COLLECTION).doc(a.cleaningId as string))) : [];
      const waiting: { ref: DocumentReference; cleaning: Cleaning & { id: string } }[] = [];
      for (const doc of docs) {
        if (!doc.exists) continue;
        const cleaning = readCleaning(doc.id, doc.data() ?? {});
        if (!cleaning || cleaning.status !== 'logged') continue;
        const counts = cleaning.amountCents !== null && cleaning.extra?.status !== 'asked';
        if (counts) return { kind: 'locked' };
        waiting.push({ ref: doc.ref, cleaning });
      }
      const at = now.toISOString();
      tx.update(ref, { amountCents, history: [...job.history, jobEvent(at, 'amount-set', actor, { amountCents })] });
      let cleaningsChanged = 0;
      // A waiting cleaning of the job's cleaner follows the job's amount (an older job with two cleaners: never a share).
      if (job.cleanerIds.length === 1 && amountCents !== null) {
        for (const { ref: cleaningRef, cleaning } of waiting) {
          if (cleaning.amountCents === amountCents) continue;
          const event: CleaningEvent = { at, action: 'changed', actor, reason: 'amount set on the job', before: { amountCents: cleaning.amountCents }, after: { amountCents } };
          tx.update(cleaningRef, { amountCents, amountFrom: 'job', history: [...cleaning.history, event] });
          cleaningsChanged += 1;
        }
      }
      return { kind: 'set', job: { ...job, amountCents, history: [...job.history, jobEvent(at, 'amount-set', actor, { amountCents })] }, changed: true, cleaningsChanged };
    });
  } catch (err) {
    console.error(`[jobs] setting the amount on ${jobId} failed: grpc code ${grpcCode(err)}`);
    return { kind: 'failed' };
  }
}

// ─── Delete a job (Build 2, item 2) ────────────────────────────

export type DeleteJobResult =
  | { kind: 'deleted'; id: string; cleanings: number; marker: boolean }
  | { kind: 'not-found' }
  | { kind: 'changed-since' }
  | { kind: 'unreadable' }
  /** Its cleaning is dated on or before a payment to its cleaner (Kian's ruling of 2026-10-15): the payment counts it. */
  | { kind: 'cleaning-paid'; name: string | null; payment: PaymentView; day: string }
  /** Its cleaning is printed on a finished statement. */
  | { kind: 'cleaning-printed'; name: string | null; months: string[] }
  | { kind: 'payments-unreadable' }
  | { kind: 'failed' };

export const DELETE_JOB_REFUSALS: Record<'not-found' | 'changed-since' | 'unreadable' | 'payments-unreadable' | 'failed', Refusal> = {
  'not-found': ASSIGN_REFUSALS['not-found'],
  'changed-since': { status: 409, code: 'JOB_CHANGED', message: 'This job changed since the page loaded.', hint: 'Nothing was deleted. Reload, check what changed, and delete again if you still mean to.' },
  unreadable: { status: 500, code: 'JOB_UNREADABLE', message: 'This job is not in the shape a delete needs.', hint: 'Nothing was deleted.' },
  'payments-unreadable': { status: 500, code: 'PAYMENTS_UNREADABLE', message: 'A payment to its cleaner cannot be read, so this job cannot be deleted.', hint: 'Nothing was deleted.' },
  failed: { status: 502, code: 'JOB_DELETE_FAILED', message: 'Could not delete the job.', hint: 'It may or may not have been deleted. Reload the Schedule to see.' },
};

/**
 * Delete a job (Kian's ruling of 2026-11-03, Build 2, item 2), as the admin saw it (`seen`): the job and its cleaning
 * go in one transaction, unless that cleaning is dated on or before a payment to its cleaner (the payment counts it) or
 * printed on a finished statement — refused, with the reason, nothing deleted. A calendar job leaves a marker keyed by
 * the turnover and holding its booking (DeletedJobMarker), so the sync does not make it again while that booking still
 * ends that day; a job added by hand leaves nothing, the calendar never made it. The route's activity line is the one
 * record of the delete.
 */
export async function deleteJob(actor: Actor, jobId: string, seen: number, now: Date = new Date()): Promise<DeleteJobResult> {
  const db = getAdminDb();
  const ref = db.collection(CLEANING_JOBS_COLLECTION).doc(jobId);
  try {
    return await db.runTransaction(async (tx): Promise<DeleteJobResult> => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { kind: 'not-found' };
      const job = readJob(snap.id, snap.data() ?? {});
      if (!job) return { kind: 'unreadable' };
      if (job.history.length !== seen) return { kind: 'changed-since' };
      // Every cleaning a mark on it made, whether the office removed it or not: read, checked, then deleted with the job.
      const marks = job.cleanerIds.map((cid) => ({ cleanerId: cid, assignment: job.assignments[cid] })).filter((m) => m.assignment.cleaningId !== null);
      const docs = marks.length ? await tx.getAll(...marks.map((m) => db.collection(CLEANINGS_COLLECTION).doc(m.assignment.cleaningId as string))) : [];
      const toDelete: DocumentReference[] = [];
      for (const doc of docs) {
        if (!doc.exists) continue;
        const cleaning = readCleaning(doc.id, doc.data() ?? {});
        if (!cleaning) return { kind: 'unreadable' };
        const name = marks.find((m) => m.assignment.cleaningId === doc.id)?.assignment.nameAtAssignment ?? cleaning.cleanerNameAtEntry;
        const printing = await statementsPrinting(cleaning.propertyId, cleaning.id, tx);
        if (printing.length > 0) return { kind: 'cleaning-printed', name, months: [...new Set(printing.map((p) => p.month))].sort() };
        const paid = await paymentOnOrAfter(tx, cleaning.cleanerId, cleaning.day);
        if (paid.kind === 'unreadable') return { kind: 'payments-unreadable' };
        if (paid.kind === 'payment') return { kind: 'cleaning-paid', name, payment: paid.payment, day: cleaning.day };
        toDelete.push(doc.ref);
      }
      const marker = job.origin === 'calendar' && job.reservation !== null;
      if (marker) {
        tx.set(db.collection(DELETED_JOBS_COLLECTION).doc(job.id), {
          schemaVersion: DELETED_JOB_SCHEMA_VERSION,
          propertyId: job.propertyId,
          checkout: job.checkout,
          reservation: { uid: (job.reservation as { uid: string; start: string }).uid, start: (job.reservation as { uid: string; start: string }).start },
          deletedAt: now.toISOString(),
          deletedBy: actor,
        });
      }
      for (const cleaningRef of toDelete) tx.delete(cleaningRef);
      tx.delete(ref);
      return { kind: 'deleted', id: job.id, cleanings: toDelete.length, marker };
    });
  } catch (err) {
    console.error(`[jobs] deleting ${jobId} failed: grpc code ${grpcCode(err)}`);
    return { kind: 'failed' };
  }
}

// ─── Change cleaner (ruling D) ─────────────────────────────────

export type SwapResult =
  | { kind: 'swapped'; job: StoredJob; from: string | null; to: string | null }
  | { kind: 'not-found' }
  | { kind: 'changed-since' }
  | { kind: 'unreadable' }
  | { kind: 'booking-changed' }
  | { kind: 'not-on-job' }
  /** The cleaner coming off marked it: their mark and cleaning stay; the office changes the cleaning under 37B. */
  | { kind: 'marked'; name: string | null }
  | { kind: 'already-on'; name: string | null }
  | { kind: 'not-assignable'; name: string | null; why: 'missing' | 'not-a-cleaner' | 'inactive' }
  | { kind: 'failed' };

export const SWAP_REFUSALS: Record<'not-found' | 'changed-since' | 'unreadable' | 'booking-changed' | 'not-on-job' | 'failed', Refusal> = {
  'not-found': ASSIGN_REFUSALS['not-found'],
  'changed-since': ASSIGN_REFUSALS['changed-since'],
  unreadable: ASSIGN_REFUSALS.unreadable,
  'booking-changed': ASSIGN_REFUSALS['booking-changed'],
  'not-on-job': { status: 409, code: 'JOB_CLEANER_NOT_ON_IT', message: 'That cleaner is not on this job.', hint: 'Nothing was saved. Reload the Schedule.' },
  failed: ASSIGN_REFUSALS.failed,
};

/**
 * Change a job's cleaner (Kian's ruling D of 2026-11-01): "a one-step swap on an assigned job, logged. The old
 * cleaner's app drops it and the new one's shows it." One transaction: `from` comes off (never once they marked it),
 * `to`, an active cleaner not already on it, goes on in their place; the history says who was replaced by whom. As
 * the admin saw it (`seen`).
 */
export async function swapCleaner(actor: Actor, jobId: string, from: string, to: string, seen: number, now: Date = new Date()): Promise<SwapResult> {
  const db = getAdminDb();
  const ref = db.collection(CLEANING_JOBS_COLLECTION).doc(jobId);
  try {
    return await db.runTransaction(async (tx): Promise<SwapResult> => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { kind: 'not-found' };
      const job = readJob(snap.id, snap.data() ?? {});
      if (!job) return { kind: 'unreadable' };
      if (job.history.length !== seen) return { kind: 'changed-since' };
      if (job.status !== 'open') return { kind: 'booking-changed' };
      const leaving = job.assignments[from];
      if (!leaving) return { kind: 'not-on-job' };
      if (leaving.cleaningId !== null) return { kind: 'marked', name: leaving.nameAtAssignment };
      if (to === from || job.cleanerIds.includes(to)) return { kind: 'already-on', name: job.assignments[to]?.nameAtAssignment ?? leaving.nameAtAssignment };
      const [account] = await tx.getAll(db.collection(CLEANERS_COLLECTION).doc(to), { fieldMask: ['name', 'role', 'status'] });
      if (!account.exists) return { kind: 'not-assignable', name: null, why: 'missing' };
      const toName = fieldText(account.get('name'));
      if (roleOf({ role: account.get('role') }) !== 'cleaner') return { kind: 'not-assignable', name: toName, why: 'not-a-cleaner' };
      if (account.get('status') !== 'active') return { kind: 'not-assignable', name: toName, why: 'inactive' };

      const at = now.toISOString();
      const assignments: Record<string, Assignment> = {};
      const cleanerIds: string[] = [];
      for (const cid of job.cleanerIds) {
        if (cid === from) {
          assignments[to] = newAssignment(toName, at, actor);
          cleanerIds.push(to);
        } else {
          assignments[cid] = job.assignments[cid];
          cleanerIds.push(cid);
        }
      }
      const history = [
        ...job.history,
        jobEvent(at, 'unassigned', actor, { cleanerId: from, cleanerName: leaving.nameAtAssignment, reason: `replaced by ${toName ?? 'another cleaner'}` }),
        jobEvent(at, 'assigned', actor, { cleanerId: to, cleanerName: toName, reason: `in place of ${leaving.nameAtAssignment ?? 'another cleaner'}` }),
      ];
      tx.update(ref, { cleanerIds, assignments, history });
      return { kind: 'swapped', job: { ...job, cleanerIds, assignments, history }, from: leaving.nameAtAssignment, to: toName };
    });
  } catch (err) {
    console.error(`[jobs] changing the cleaner on ${jobId} failed: grpc code ${grpcCode(err)}`);
    return { kind: 'failed' };
  }
}

export type UndoResult =
  | { kind: 'undone'; job: StoredJob; cleaningId: string }
  | { kind: 'not-found' }
  | { kind: 'not-marked' }
  | { kind: 'out-of-reach' }
  /** The office removed the cleaning: it is theirs now. */
  | { kind: 'removed' }
  /** A finished statement prints it (ruling 6): admins change or remove it under 37B. */
  | { kind: 'printed'; months: string[] }
  /** Dated on or before a payment to them (Kian's ruling of 2026-10-15): an Undo deletes, so it is refused; the office removes it. */
  | { kind: 'paid'; payment: PaymentView }
  | { kind: 'unreadable' }
  | { kind: 'failed' };

export const UNDO_REFUSALS: Record<Exclude<UndoResult['kind'], 'undone' | 'printed' | 'paid'>, Refusal> = {
  'not-found': MARK_REFUSALS['not-found'],
  'not-marked': { status: 409, code: 'JOB_NOT_MARKED', message: 'This job is not marked cleaned by you.', hint: 'Nothing was changed.' },
  'out-of-reach': { status: 409, code: 'JOB_OUT_OF_REACH', message: 'This job is too far back to undo here.', hint: 'Nothing was changed. Ask the office.' },
  removed: { status: 409, code: 'CLEANING_REMOVED', message: 'The office has removed this cleaning.', hint: 'Nothing was changed. Ask the office.' },
  unreadable: MARK_REFUSALS.unreadable,
  failed: { status: 502, code: 'UNDO_FAILED', message: 'Not confirmed.', hint: 'Tap Undo again.' },
};

/**
 * Undo this cleaner's own Mark cleaned (ruling 6): until a finished statement prints the cleaning, within the 45 days
 * their list reaches. The cleaning is deleted (it never reached an owner); the job's history keeps who marked it,
 * when, its ID and its amount (Kian's answer of the evening).
 */
export async function undoMark(cleaner: { id: string; name: string | null }, jobId: string, now: Date = new Date()): Promise<UndoResult> {
  const db = getAdminDb();
  const jobRef = db.collection(CLEANING_JOBS_COLLECTION).doc(jobId);
  const today = torontoDay(now);
  try {
    return await db.runTransaction(async (tx): Promise<UndoResult> => {
      const snap = await tx.get(jobRef);
      if (!snap.exists) return { kind: 'not-found' };
      const job = readJob(snap.id, snap.data() ?? {});
      if (!job) return { kind: 'unreadable' };
      const mine = job.assignments[cleaner.id];
      if (!mine || mine.cleaningId === null) return { kind: 'not-marked' };
      if (mine.removedAt !== null) return { kind: 'removed' };
      if (job.checkout < cleanerListFrom(today)) return { kind: 'out-of-reach' };
      const cleaningRef = db.collection(CLEANINGS_COLLECTION).doc(mine.cleaningId);
      const cleaningSnap = await tx.get(cleaningRef);
      if (!cleaningSnap.exists) return { kind: 'not-marked' };
      const cleaning = readCleaning(cleaningSnap.id, cleaningSnap.data() ?? {});
      if (!cleaning || cleaning.cleanerId !== cleaner.id || cleaning.jobId !== job.id) return { kind: 'unreadable' };
      if (cleaning.status === 'removed') return { kind: 'removed' };
      const printing = await statementsPrinting(cleaning.propertyId, cleaning.id, tx);
      if (printing.length > 0) return { kind: 'printed', months: [...new Set(printing.map((p) => p.month))].sort() };
      // An Undo deletes the cleaning: one dated on or before a payment to them is the office's to remove (2026-10-15).
      const paid = await paymentOnOrAfter(tx, cleaner.id, cleaning.day);
      if (paid.kind === 'unreadable') return { kind: 'unreadable' };
      if (paid.kind === 'payment') return { kind: 'paid', payment: paid.payment };

      const at = now.toISOString();
      const actor: Actor = { role: 'cleaner', id: cleaner.id, name: cleaner.name };
      const next = {
        assignments: { ...job.assignments, [cleaner.id]: { ...mine, cleaningId: null, markedAt: null, note: null, extraAsked: false } },
        history: [...job.history, jobEvent(at, 'unmarked', actor, { cleanerId: cleaner.id, cleanerName: mine.nameAtAssignment, cleaningId: cleaning.id, amountCents: cleaning.amountCents })],
      };
      tx.delete(cleaningRef);
      tx.update(jobRef, next);
      return { kind: 'undone', job: { ...job, ...next }, cleaningId: cleaning.id };
    });
  } catch (err) {
    console.error(`[jobs] undoing on ${jobId} failed: grpc code ${grpcCode(err)}`);
    return { kind: 'failed' };
  }
}

// ─── Reopen (admin) ────────────────────────────────────────────

export type ReopenResult =
  | { kind: 'reopened'; job: StoredJob; name: string | null }
  | { kind: 'not-found' }
  | { kind: 'changed-since' }
  | { kind: 'unreadable' }
  /** Not on the job, or their mark is not removed by the office: there is nothing to reopen. */
  | { kind: 'not-removed'; name: string | null }
  | { kind: 'booking-changed' }
  /** Older than their list reaches: they could not mark it again; the office logs the cleaning by hand. */
  | { kind: 'out-of-reach' }
  | { kind: 'not-active'; name: string | null; why: 'missing' | 'not-a-cleaner' | 'inactive' }
  | { kind: 'failed' };

export const REOPEN_REFUSALS: Record<'not-found' | 'changed-since' | 'unreadable' | 'booking-changed' | 'out-of-reach' | 'failed', Refusal> = {
  'not-found': ASSIGN_REFUSALS['not-found'],
  'changed-since': ASSIGN_REFUSALS['changed-since'],
  unreadable: ASSIGN_REFUSALS.unreadable,
  'booking-changed': { status: 409, code: 'JOB_BOOKING_CHANGED', message: 'This job’s booking changed: it cannot be marked cleaned again.', hint: 'Nothing was saved.' },
  'out-of-reach': { status: 409, code: 'JOB_OUT_OF_REACH', message: `This job is more than ${CLEANER_LIST_DAYS} days back: its cleaner could not mark it again.`, hint: 'Nothing was saved. Log the cleaning by hand in the Cleanings tab.' },
  failed: { status: 502, code: 'JOB_SAVE_FAILED', message: 'Could not reopen the job.', hint: 'It may or may not have been reopened. Reload the Schedule to see.' },
};

/**
 * Reopen a job for a cleaner whose mark the office removed (Kian's ruling of 2026-10-14, night), as the admin saw it
 * (`seen`: its history's length): their mark comes off, so they can mark it cleaned again, and the job's history says
 * who reopened it and which cleaning had been removed. Only for an active cleaner, on a job whose booking is unchanged,
 * within the days their list reaches: anything else could never be marked again.
 */
export async function reopenMark(actor: Actor, jobId: string, cleanerId: string, seen: number, now: Date = new Date()): Promise<ReopenResult> {
  const db = getAdminDb();
  const ref = db.collection(CLEANING_JOBS_COLLECTION).doc(jobId);
  const today = torontoDay(now);
  try {
    return await db.runTransaction(async (tx): Promise<ReopenResult> => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { kind: 'not-found' };
      const job = readJob(snap.id, snap.data() ?? {});
      if (!job) return { kind: 'unreadable' };
      if (job.history.length !== seen) return { kind: 'changed-since' };
      const refusal = reopenRefusal(job, cleanerId);
      const mine = job.assignments[cleanerId];
      if (refusal === 'not-removed') return { kind: 'not-removed', name: mine?.nameAtAssignment ?? null };
      if (refusal === 'booking-changed') return { kind: 'booking-changed' };
      if (job.checkout < cleanerListFrom(today)) return { kind: 'out-of-reach' };
      const account = await tx.get(db.collection(CLEANERS_COLLECTION).doc(cleanerId));
      if (!account.exists) return { kind: 'not-active', name: mine.nameAtAssignment, why: 'missing' };
      const name = fieldText(account.get('name')) ?? mine.nameAtAssignment;
      if (roleOf({ role: account.get('role') }) !== 'cleaner') return { kind: 'not-active', name, why: 'not-a-cleaner' };
      if (account.get('status') !== 'active') return { kind: 'not-active', name, why: 'inactive' };

      const at = now.toISOString();
      const next = {
        assignments: { ...job.assignments, [cleanerId]: { ...mine, cleaningId: null, markedAt: null, removedAt: null, removedBy: null, note: null, extraAsked: false } },
        history: [...job.history, jobEvent(at, 'mark-reopened', actor, { cleanerId, cleanerName: name, cleaningId: mine.cleaningId })],
      };
      tx.update(ref, next);
      return { kind: 'reopened', job: { ...job, ...next }, name };
    });
  } catch (err) {
    console.error(`[jobs] reopening ${jobId} failed: grpc code ${grpcCode(err)}`);
    return { kind: 'failed' };
  }
}

// ─── A cleaner deactivated or deleted (the Team page) ──────────

/** The jobs a cleaner is on and has not marked, any day: what deactivating or deleting them takes them off. @throws if a read fails. */
export async function unmarkedJobsOf(cleanerId: string): Promise<UnmarkedJob[]> {
  if (!isDocumentId(cleanerId)) return [];
  const snap = await getAdminDb().collection(CLEANING_JOBS_COLLECTION).where('cleanerIds', 'array-contains', cleanerId).get();
  const jobs = readJobs(snap.docs).jobs.filter((job) => job.assignments[cleanerId]?.cleaningId === null);
  // Named as the admin names the property: its cleaner-facing name, else the title the job was made under (Kian's rulings of 2026-10-15, evening).
  const facing = await cleanerFacingNamesOf(jobs.map((job) => job.propertyId));
  return jobs
    .map((job) => ({ id: job.id, propertyName: internalNameOf(facing, job.propertyId, job.propertyNameAtCreation), checkout: job.checkout, status: job.status }))
    .sort((a, b) => a.checkout.localeCompare(b.checkout) || a.id.localeCompare(b.id));
}

/**
 * A team member's jobs in one month (Build 3, Kian's rulings of 2026-11-03): every job they are on whose checkout
 * falls in the month, with their mark on it, for their person page's calendar and summary. The query names them and
 * the month's days through the composite index on `cleanerIds` and `checkout`; each job is checked again. Named as the
 * admin names the property (its cleaner-facing name, else the title the job was made under). One read per job of
 * theirs in the month (one when they have none), and one per property named.
 *
 * @throws if a read fails.
 */
export async function memberJobsInMonth(cleanerId: string, month: string): Promise<PersonJob[]> {
  if (!isDocumentId(cleanerId)) return [];
  const { first, last } = monthBounds(month);
  const snap = await getAdminDb().collection(CLEANING_JOBS_COLLECTION).where('cleanerIds', 'array-contains', cleanerId).where('checkout', '>=', first).where('checkout', '<=', last).get();
  const jobs = readJobs(snap.docs).jobs.filter((job) => job.cleanerIds.includes(cleanerId) && job.checkout >= first && job.checkout <= last);
  const facing = await cleanerFacingNamesOf(jobs.map((job) => job.propertyId));
  return jobs
    .map((job): PersonJob => {
      const a = job.assignments[cleanerId];
      return {
        id: job.id,
        propertyId: job.propertyId,
        propertyName: internalNameOf(facing, job.propertyId, job.propertyNameAtCreation),
        checkout: job.checkout,
        label: job.label,
        origin: job.origin,
        status: job.status,
        change: job.status === 'booking-changed' && job.change ? { kind: job.change.kind, movedTo: job.change.movedTo } : null,
        markedAt: a.markedAt,
        cleaningId: a.cleaningId,
        removedAt: a.removedAt,
        note: a.note,
        extraAsked: a.extraAsked,
        amountCents: job.amountCents,
      };
    })
    .sort((a, b) => a.checkout.localeCompare(b.checkout) || a.id.localeCompare(b.id));
}

/**
 * Inside the deactivation's or the deletion's transaction: the jobs the cleaner is on and has not marked. A read, so
 * it runs before the transaction's first write; `takeOffJobs` writes after.
 */
export async function readUnmarkedJobs(tx: Transaction, cleanerId: string): Promise<{ ref: DocumentReference; job: StoredJob; propertyName: string | null }[]> {
  const snap = await tx.get(getAdminDb().collection(CLEANING_JOBS_COLLECTION).where('cleanerIds', 'array-contains', cleanerId));
  const out: { ref: DocumentReference; job: StoredJob }[] = [];
  for (const doc of snap.docs) {
    const job = readJob(doc.id, doc.data());
    if (job && job.assignments[cleanerId]?.cleaningId === null) out.push({ ref: doc.ref, job });
  }
  // The name the admin is told, display only (outside the transaction's reads): the cleaner-facing name, else the title the job was made under.
  const facing = await cleanerFacingNamesOf(out.map(({ job }) => job.propertyId));
  return out.map((found) => ({ ...found, propertyName: internalNameOf(facing, found.job.propertyId, found.job.propertyNameAtCreation) }));
}

/**
 * Take a cleaner off the jobs `readUnmarkedJobs` found, in the same transaction: each job's history says who did it
 * and why ("deactivated", "deleted"). A job they marked keeps their mark and their cleaning: their earnings record.
 */
export function takeOffJobs(tx: Transaction, found: { ref: DocumentReference; job: StoredJob; propertyName: string | null }[], cleanerId: string, actor: Actor, reason: 'deactivated' | 'deleted', at: string): UnmarkedJob[] {
  return found.map(({ ref, job, propertyName }) => {
    const assignments = { ...job.assignments };
    const name = assignments[cleanerId]?.nameAtAssignment ?? null;
    delete assignments[cleanerId];
    tx.update(ref, {
      cleanerIds: job.cleanerIds.filter((cid) => cid !== cleanerId),
      assignments,
      history: [...job.history, jobEvent(at, 'unassigned', actor, { cleanerId, cleanerName: name, reason })],
    });
    return { id: job.id, propertyName, checkout: job.checkout, status: job.status };
  });
}
