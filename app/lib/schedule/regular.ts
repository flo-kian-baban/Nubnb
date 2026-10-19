/**
 * The regular cleaner (Kian's ruling R5 of 2026-10-19, in CLAUDE.md under *Schedule, round 1*): a property can have one
 * regular cleaner, set on its edit page and on the Schedule. When the job sync makes a job for a property whose regular
 * cleaner is an active cleaner, it puts them on it, recorded in the job's history as assigned by "regular cleaner".
 * A deactivated or deleted regular cleaner assigns nobody: the job is made with nobody on it. Jobs already made are
 * never changed by it.
 *
 * The record is `property_regular_cleaners/{propertyId}`, a server-only collection (firestore.rules' catch-all
 * denies every browser), never a field of the world-readable property document: the property save refuses it, as it
 * refuses the name cleaners see.
 *
 * ── Schema version 2: a history (Kian's ruling K4 of 2026-10-19, the Team page) ──
 * Deactivating or deleting a regular cleaner offers a replacement for each of their properties, applied with the
 * deactivation or delete and "recorded in each property's regular-cleaner history". So a record carries `history`:
 * one event per change — set, cleared, replaced — with who, when, from whom to whom, and why when it was not the
 * admin's own choice ("deactivated", "deleted"). A record whose cleaner was cleared or replaced by nobody stays, with
 * `cleanerId` null, so its history is kept: "none" is a missing record or a record naming nobody, and both assign
 * nobody. Version 1 records (no `history`, a cleaner always named) read as before, with an empty history; they are
 * never rewritten until the next change (no backfill).
 *
 * Pure and dependency-free, like model.ts: nothing here imports Next, Firebase or anything under `@/`.
 */

import { jobEvent, type CleaningJob, type JobActor } from './model';

export const PROPERTY_REGULAR_CLEANERS_COLLECTION = 'property_regular_cleaners';
export const REGULAR_CLEANER_SCHEMA_VERSION = 2;

/** Who put the regular cleaner on a job the sync made: the system, as "regular cleaner". */
export const REGULAR_CLEANER_ACTOR: JobActor = { role: 'system', id: null, name: 'regular cleaner' };

/** Names a regular cleaner could be sent under on a property body: none is ever a property field. */
export const REGULAR_CLEANER_FIELDS = ['regularCleaner', 'regularCleanerId', 'regularCleanerName'] as const;

/** Who a change was from or to: a cleaner, by ID and the name they had then. */
export interface RegularWho {
  cleanerId: string;
  name: string | null;
}

/** Why a regular cleaner was replaced when it was not the admin's own choice (Kian's ruling K4): the account's deactivation or deletion. */
export type RegularChangeReason = 'deactivated' | 'deleted';

/** One change of a property's regular cleaner, append-only (schema version 2). */
export interface RegularCleanerEvent {
  /** ISO-8601 UTC. */
  at: string;
  /** `set` (a cleaner chosen, none before), `cleared` (nobody, by the admin's own choice), `replaced` (with the account's deactivation or deletion: another cleaner, or nobody). */
  action: 'set' | 'cleared' | 'replaced';
  actor: JobActor;
  from: RegularWho | null;
  to: RegularWho | null;
  reason: RegularChangeReason | null;
}

/** `property_regular_cleaners/{propertyId}`, as written. */
export interface RegularCleanerRecord {
  schemaVersion: number;
  propertyId: string;
  /** The regular cleaner; null (version 2) when the record names nobody and is kept for its history. */
  cleanerId: string | null;
  /** Their name when set: the record still reads by it once the account is gone. */
  cleanerNameAtSet: string | null;
  setAt: string;
  setBy: JobActor;
  /** Every change, oldest first (version 2); empty on a version 1 record. */
  history: RegularCleanerEvent[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';
const isTextOrNull = (value: unknown): value is string | null => value === null || typeof value === 'string';
const isActor = (value: unknown): value is JobActor => isRecord(value) && ['admin', 'cleaner', 'handyman', 'system'].includes(value.role as string) && isTextOrNull(value.id) && isTextOrNull(value.name);
const isWhoOrNull = (value: unknown): value is RegularWho | null => value === null || (isRecord(value) && isText(value.cleanerId) && isTextOrNull(value.name));

function readEvent(value: unknown): RegularCleanerEvent | null {
  if (!isRecord(value) || !isText(value.at) || !isActor(value.actor) || !isWhoOrNull(value.from) || !isWhoOrNull(value.to)) return null;
  if (value.action !== 'set' && value.action !== 'cleared' && value.action !== 'replaced') return null;
  if (!(value.reason === null || value.reason === 'deactivated' || value.reason === 'deleted')) return null;
  return { at: value.at, action: value.action, actor: value.actor, from: value.from, to: value.to, reason: value.reason };
}

/**
 * A stored record, read strictly: null when any field is not in the written shape, or it names another property. A
 * version 1 record (no `history`) always names a cleaner and reads with an empty history; a version 2 record may name
 * nobody (`cleanerId` null) and carries every change.
 */
export function readRegularCleaner(id: string, fields: Record<string, unknown>): RegularCleanerRecord | null {
  const { schemaVersion, propertyId, cleanerId, cleanerNameAtSet, setAt, setBy, history } = fields;
  if (typeof schemaVersion !== 'number' || !isText(propertyId) || propertyId !== id || !isTextOrNull(cleanerNameAtSet) || !isText(setAt) || !isActor(setBy)) return null;
  if (history === undefined) {
    if (!isText(cleanerId)) return null;
    return { schemaVersion, propertyId, cleanerId, cleanerNameAtSet, setAt, setBy, history: [] };
  }
  if (!(cleanerId === null || isText(cleanerId)) || !Array.isArray(history)) return null;
  const events = history.map(readEvent);
  if (events.some((event) => event === null)) return null;
  return { schemaVersion, propertyId, cleanerId, cleanerNameAtSet, setAt, setBy, history: events as RegularCleanerEvent[] };
}

/** One event of a record's history, every field written. */
export function regularEvent(at: string, action: RegularCleanerEvent['action'], actor: JobActor, from: RegularWho | null, to: RegularWho | null, reason: RegularChangeReason | null = null): RegularCleanerEvent {
  return { at, action, actor, from, to, reason };
}

/**
 * The record as it is written after a change (schema version 2): who it names now, when and by whom, and the history
 * so far with the change appended. A version 1 record's history starts here.
 */
export function regularRecordAfter(propertyId: string, previous: RegularCleanerRecord | null, to: RegularWho | null, event: RegularCleanerEvent): RegularCleanerRecord {
  return { schemaVersion: REGULAR_CLEANER_SCHEMA_VERSION, propertyId, cleanerId: to?.cleanerId ?? null, cleanerNameAtSet: to?.name ?? null, setAt: event.at, setBy: event.actor, history: [...(previous?.history ?? []), event] };
}

/** A regular-cleaner event in words, for an admin: "Replaced Test Ana with Test Ben (deactivated) · Oct 19 by Kian". */
export function regularEventWords(event: RegularCleanerEvent): string {
  const who = (w: RegularWho | null) => w?.name ?? (w ? 'a cleaner' : 'nobody');
  const by = `${new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', month: 'short', day: 'numeric' }).format(new Date(event.at))}${event.actor.name ? ` by ${event.actor.name}` : ''}`;
  if (event.action === 'set') return `Set to ${who(event.to)} · ${by}`;
  if (event.action === 'cleared') return `Cleared (was ${who(event.from)}) · ${by}`;
  return `Replaced ${who(event.from)} with ${who(event.to)}${event.reason ? ` (${event.reason})` : ''} · ${by}`;
}

/**
 * The replacements an admin chose before deactivating or deleting a regular cleaner (Kian's ruling K4): each of
 * their properties, with another active cleaner or nobody. Checked here before the server applies them: a
 * replacement must be an active cleaner other than the person; nobody is null.
 */
export type RegularReplacements = Record<string, string | null>;

/** Whether a chosen replacement can be a property's regular cleaner: an active cleaner, not the person leaving. */
export function replacementAssigns(candidate: RegularCandidate | null | undefined, leaving: string): candidate is RegularCandidate {
  return regularAssigns(candidate) && candidate.id !== leaving;
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
