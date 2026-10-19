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
 * ── Assignments (ruling 2) ──
 * An admin sets who is on a job: only active cleaners are added, never handymen, and never to a job whose booking
 * changed; anyone not yet marked can be taken off. Each change is a history event naming the admin.
 *
 * Failure contract: the reads throw when a read fails; the writes return a result naming what happened, "may or
 * may not have landed" included, and never throw.
 */

import type { DocumentReference, Transaction } from 'firebase-admin/firestore';
import { getAdminDb } from './admin';
import { isDocumentId } from './server-leads';
import { cleanerFacingNamesOf, getCleanerFacingName, internalNameOf } from './server-property-names';
import { cleaningDayProblem, statementMonthOf, statementsPrinting } from './server-cleanings';
import { latestPaymentDay, paymentOnOrAfter } from './server-pay';
import type { PaymentView } from '@/app/lib/pay/model';
import { CLEANERS_COLLECTION, fieldText, roleOf, type Actor, type Refusal } from '@/app/lib/cleaners/model';
import { CLEANINGS_COLLECTION, CLEANING_SCHEMA_VERSION, readCleaning, type Cleaning } from '@/app/lib/cleanings/model';
import { markAmount, type AmountSource } from '@/app/lib/cleanings/prices';
import { pricesInTx } from './server-cleaning-prices';
import { readCurrent } from '@/app/lib/availability/store';
import { torontoDay } from '@/app/lib/availability/days';
import { MONTHLY_REPORTS_COLLECTION, monthOfDay } from '@/app/lib/reports/model';
import {
  CLEANER_LIST_DAYS,
  CLEANING_JOBS_COLLECTION,
  cleanerListFrom,
  jobEvent,
  markRefusal,
  readJob,
  reopenRefusal,
  type Assignment,
  type AssigneeView,
  type CleanerJobView,
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
    cleaningIds.length ? db.getAll(...cleaningIds.map((id) => db.collection(CLEANINGS_COLLECTION).doc(id)), { fieldMask: ['status', 'amountCents', 'amountFrom'] }) : Promise.resolve([]),
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
    const amountFrom: AmountSource | null = from === 'short' || from === 'long' || from === 'typed' ? from : null;
    return [doc.id, { status: fieldText(doc.get('status')), amountCents: typeof amount === 'number' ? amount : null, amountFrom }];
  }));

  const views: JobView[] = jobs.map((job) => {
    const { assignments, ...rest } = job;
    const property = properties.get(job.propertyId);
    const feed = copy?.properties[job.propertyId];
    const assignees: AssigneeView[] = job.cleanerIds.map((cid) => {
      const a = assignments[cid];
      const member = byCleaner.get(cid);
      const cleaning = a.cleaningId === null || a.removedAt !== null ? null : cleanings.has(a.cleaningId) ? { state: 'found' as const, ...cleanings.get(a.cleaningId)! } : { state: 'missing' as const, status: null, amountCents: null, amountFrom: null };
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
  | { kind: 'failed' };

export const ASSIGN_REFUSALS: Record<'not-found' | 'changed-since' | 'unreadable' | 'booking-changed' | 'failed', Refusal> = {
  'not-found': { status: 404, code: 'JOB_NOT_FOUND', message: 'No such job.', hint: 'Reload the Schedule.' },
  'changed-since': { status: 409, code: 'JOB_CHANGED', message: 'This job changed since the page loaded.', hint: 'Nothing was saved. Reload, check what changed, and try again.' },
  unreadable: { status: 500, code: 'JOB_UNREADABLE', message: 'This job is not in the shape a change needs.', hint: 'Nothing was saved.' },
  'booking-changed': { status: 409, code: 'JOB_BOOKING_CHANGED', message: 'This job’s booking changed: nobody new is put on it.', hint: 'Nothing was saved. Assign the job for the booking as it is now.' },
  failed: { status: 502, code: 'JOB_SAVE_FAILED', message: 'Could not save who is on the job.', hint: 'It may or may not have been saved. Reload the Schedule to see.' },
};

/** At most this many cleaners on one job: a typing slip, not a team, past it. */
export const MAX_ASSIGNEES = 10;

/**
 * Set who is on a job, as the admin saw it (`seen`: its history's length). The cleaners added must exist, be
 * cleaners (not handymen) and be active (ruling 2); nobody is added to a job whose booking changed. A cleaner taken
 * off must not have marked it. Nothing differs, nothing is written.
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
        assignments[cid] = { nameAtAssignment: names.get(cid) ?? null, assignedAt: at, assignedBy: actor, cleaningId: null, markedAt: null, removedAt: null, removedBy: null };
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
 * job alone. Undo itself still reads the cleaning before it acts.
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
  const [printed, named] = await Promise.all([printedAmong(byProperty), typeof properties === 'function' ? properties(distinct(shown.map((job) => job.propertyId))) : Promise.resolve(properties)]);

  return shown
    .map((job): CleanerJobView => {
      const a = job.assignments[cleanerId];
      const property = named.get(job.propertyId);
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
        // Never on a cleaning dated on or before a payment to them (`paidThrough`, its latest day): the office removes those.
        canUndo: a.cleaningId !== null && a.removedAt === null && !printed.has(a.cleaningId) && (paidThrough === null || job.checkout > paidThrough),
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
 * city and listed times; two reads). `canUndo` is the caller's: true right after a mark, false after an undo.
 *
 * @throws if a read fails.
 */
export async function oneCleanerJob(job: StoredJob, cleanerId: string, canUndo: boolean, today: string = torontoDay()): Promise<CleanerJobView> {
  const db = getAdminDb();
  const [[doc], facing] = await Promise.all([db.getAll(db.collection('properties').doc(job.propertyId), { fieldMask: ['name', 'addressDetails', 'details'] }), getCleanerFacingName(job.propertyId)]);
  const property = doc.exists ? jobPropertiesOf([doc], facing ? new Map([[job.propertyId, facing]]) : new Map()).get(job.propertyId) : undefined;
  const a = job.assignments[cleanerId];
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
    markedAt: a?.markedAt ?? null,
    canUndo: canUndo && !!a?.cleaningId && a.removedAt === null,
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

/**
 * Mark a job cleaned for this cleaner: one transaction makes their 37B cleaning and puts it on their assignment. The
 * amount is the property's preset by the stay behind the job when they are its one cleaner, else null (Kian's ruling
 * of 2026-10-19, `markAmount`) — never typed by them, and never shown to them.
 */
export async function markCleaned(cleaner: { id: string; name: string | null }, jobId: string, now: Date = new Date()): Promise<MarkResult> {
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
      // The property's preset by the stay, with one cleaner on the job; no amount with two or more (the admin types the split).
      const amount = markAmount(prices, job);
      const suggested = { from: amount.from, cents: amount.cents };
      const statementMonth = await statementMonthOf(job.propertyId, monthOfDay(job.checkout), tx);

      const at = now.toISOString();
      const actor: Actor = { role: 'cleaner', id: cleaner.id, name: fieldText(account.get('name')) ?? cleaner.name };
      const ref = db.collection(CLEANINGS_COLLECTION).doc();
      const stored: Cleaning = {
        schemaVersion: CLEANING_SCHEMA_VERSION,
        propertyId: job.propertyId,
        propertyNameAtEntry: fieldText(property.get('name')),
        cleanerId: cleaner.id,
        cleanerNameAtEntry: actor.name,
        day: job.checkout,
        amountCents: suggested.cents,
        note: null,
        status: 'logged',
        suggested,
        amountFrom: amount.amountFrom,
        createdAt: at,
        actor,
        history: [{ at, action: 'logged', actor, reason: null }],
        jobId: job.id,
      };
      const next = {
        assignments: { ...job.assignments, [cleaner.id]: { ...job.assignments[cleaner.id], cleaningId: ref.id, markedAt: at } },
        history: [...job.history, jobEvent(at, 'marked', actor, { cleanerId: cleaner.id, cleanerName: actor.name, cleaningId: ref.id, amountCents: suggested.cents })],
      };
      tx.create(ref, stored);
      tx.update(jobRef, next);
      return { kind: 'marked', job: { ...job, ...next }, cleaningId: ref.id, amountCents: suggested.cents, statementMonth };
    });
  } catch (err) {
    console.error(`[jobs] marking ${jobId} failed: grpc code ${grpcCode(err)}`);
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
        assignments: { ...job.assignments, [cleaner.id]: { ...mine, cleaningId: null, markedAt: null } },
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
        assignments: { ...job.assignments, [cleanerId]: { ...mine, cleaningId: null, markedAt: null, removedAt: null, removedBy: null } },
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
