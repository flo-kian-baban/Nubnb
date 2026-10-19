/**
 * The regular cleaner (Kian's ruling R5 of 2026-10-19, in CLAUDE.md under *Schedule, round 1*): a property can have one
 * regular cleaner, set on its edit page and on the Schedule. When the job sync makes a job for a property whose regular
 * cleaner is an active cleaner, it puts them on it, recorded in the job's history as assigned by "regular cleaner".
 * A deactivated or deleted regular cleaner assigns nobody: the job is made with nobody on it. Jobs already made are
 * never changed by it.
 *
 * The record is `property_regular_cleaners/{propertyId}`, a server-only collection (firestore.rules' catch-all
 * denies every browser), never a field of the world-readable property document: the property save refuses it, as it
 * refuses the name cleaners see. Clearing it deletes the record.
 *
 * Pure and dependency-free, like model.ts: nothing here imports Next, Firebase or anything under `@/`.
 */

import { jobEvent, type CleaningJob, type JobActor } from './model';

export const PROPERTY_REGULAR_CLEANERS_COLLECTION = 'property_regular_cleaners';
export const REGULAR_CLEANER_SCHEMA_VERSION = 1;

/** Who put the regular cleaner on a job the sync made: the system, as "regular cleaner". */
export const REGULAR_CLEANER_ACTOR: JobActor = { role: 'system', id: null, name: 'regular cleaner' };

/** Names a regular cleaner could be sent under on a property body: none is ever a property field. */
export const REGULAR_CLEANER_FIELDS = ['regularCleaner', 'regularCleanerId', 'regularCleanerName'] as const;

/** `property_regular_cleaners/{propertyId}`, as written. */
export interface RegularCleanerRecord {
  schemaVersion: number;
  propertyId: string;
  cleanerId: string;
  /** Their name when set: the record still reads by it once the account is gone. */
  cleanerNameAtSet: string | null;
  setAt: string;
  setBy: JobActor;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';
const isTextOrNull = (value: unknown): value is string | null => value === null || typeof value === 'string';
const isActor = (value: unknown): value is JobActor => isRecord(value) && ['admin', 'cleaner', 'handyman', 'system'].includes(value.role as string) && isTextOrNull(value.id) && isTextOrNull(value.name);

/** A stored record, read strictly: null when any field is not in the written shape, or it names another property. */
export function readRegularCleaner(id: string, fields: Record<string, unknown>): RegularCleanerRecord | null {
  const { schemaVersion, propertyId, cleanerId, cleanerNameAtSet, setAt, setBy } = fields;
  if (typeof schemaVersion !== 'number' || !isText(propertyId) || propertyId !== id || !isText(cleanerId) || !isTextOrNull(cleanerNameAtSet) || !isText(setAt) || !isActor(setBy)) return null;
  return { schemaVersion, propertyId, cleanerId, cleanerNameAtSet, setAt, setBy };
}

/** A team member as the rule needs them: who they are, and whether they can be given a job. */
export interface RegularCandidate {
  id: string;
  name: string | null;
  role: string;
  status: string | null;
}

/**
 * The question Nubnb's own dialog asks before a regular cleaner is set, in Kian's words of 2026-10-19: the same on the
 * Schedule's picker and on the edit page, which both save it at once.
 */
export function regularCleanerQuestion(name: string | null, property: string): { title: string; lines: string[]; confirm: string } {
  return { title: `Make ${name ?? 'this cleaner'} the regular cleaner for ${property}?`, lines: [`New jobs there go to ${name ?? 'them'}.`], confirm: 'Make them its regular cleaner' };
}

/** Whether the regular cleaner assigns: an existing, active cleaner (a handyman never). */
export function regularAssigns(candidate: RegularCandidate | null | undefined): candidate is RegularCandidate {
  return !!candidate && candidate.role === 'cleaner' && candidate.status === 'active';
}

/**
 * A job the sync is about to make, with the property's regular cleaner on it when they assign (`regularAssigns`):
 * their assignment, made by REGULAR_CLEANER_ACTOR at the run's time, and an `assigned` event after `created`. Anyone
 * else, or nobody: the job as planned, with nobody on it.
 */
export function withRegularCleaner(job: CleaningJob, regular: RegularCandidate | null | undefined, nowIso: string): CleaningJob {
  if (!regularAssigns(regular) || job.cleanerIds.length > 0) return job;
  return {
    ...job,
    cleanerIds: [regular.id],
    assignments: {
      [regular.id]: { nameAtAssignment: regular.name, assignedAt: nowIso, assignedBy: REGULAR_CLEANER_ACTOR, cleaningId: null, markedAt: null, removedAt: null, removedBy: null },
    },
    history: [...job.history, jobEvent(nowIso, 'assigned', REGULAR_CLEANER_ACTOR, { cleanerId: regular.id, cleanerName: regular.name })],
  };
}
