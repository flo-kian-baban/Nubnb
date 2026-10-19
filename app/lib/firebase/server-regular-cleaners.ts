/**
 * A property's regular cleaner, on the server (Kian's ruling R5 of 2026-10-19; the rule is app/lib/schedule/regular.ts,
 * its use the job sync in app/lib/schedule/store.ts).
 *
 * `property_regular_cleaners/{propertyId}`, one document per property that has one, reached only through the Admin
 * SDK: firestore.rules' catch-all denies every browser, and the world-readable property document never holds it (the
 * property save refuses it). Admins set it on the property's edit page and on the Schedule, through
 * PUT /api/admin/properties/[id]/regular-cleaner. Clearing it deletes the document, so "absent" is the one way of
 * saying "none".
 *
 * Only an active cleaner is set; a handyman never. A regular cleaner later deactivated or deleted stays named here
 * and assigns nobody: the job sync checks the account each time it makes a job — unless the admin chose a replacement
 * when deactivating or deleting them (Kian's ruling K4 of 2026-10-19, the Team page): then `replaceRegularCleaner`,
 * inside that transaction, names the replacement (another active cleaner) or nobody, recorded in the record's history
 * (schema version 2, regular.ts). Since version 2 a clear keeps the record with nobody named, for its history; a
 * missing record and one naming nobody both mean none.
 */

import type { DocumentSnapshot, Transaction } from 'firebase-admin/firestore';
import { getAdminDb } from './admin';
import { isDocumentId } from './server-leads';
import { cleanerFacingNamesOf, internalNameOf } from './server-property-names';
import { CLEANERS_COLLECTION, fieldText, roleOf, type Actor } from '@/app/lib/cleaners/model';
import { PROPERTY_REGULAR_CLEANERS_COLLECTION, readRegularCleaner, regularAssigns, regularEvent, regularRecordAfter, replacementAssigns, type RegularCandidate, type RegularCleanerEvent, type RegularCleanerRecord, type RegularChangeReason, type RegularReplacements, type RegularWho } from '@/app/lib/schedule/regular';
import { CLEANING_JOBS_COLLECTION, readJob } from '@/app/lib/schedule/model';
import { torontoDay } from '@/app/lib/availability/days';

/** A property's regular cleaner as the admin sees them: who, and whether they would be given its next job. */
export interface RegularCleanerView {
  cleanerId: string;
  /** Their name now, else their name when set. */
  name: string | null;
  /** 'found', or 'missing' when the account no longer exists. */
  state: 'found' | 'missing';
  role: string | null;
  status: string | null;
  /** They would be put on the property's next job: an active cleaner. */
  assigns: boolean;
  setAt: string;
  setBy: Actor;
  /** Every change of the property's regular cleaner, oldest first (schema version 2); empty before. */
  history: RegularCleanerEvent[];
}

/** One active cleaner the admin can choose. */
export interface RegularChoice {
  id: string;
  name: string | null;
}

/**
 * A property's regular cleaner, or null; and, with `withChoices`, every active cleaner, for the edit page's choice.
 * Reads: the record (one), the account it names (one), and the team's names, roles and statuses when asked.
 *
 * @throws if a read fails.
 */
export async function getRegularCleaner(propertyId: string, withChoices = false): Promise<{ regular: RegularCleanerView | null; choices: RegularChoice[] | null; unreadable: boolean; history?: RegularCleanerEvent[] }> {
  const db = getAdminDb();
  const [doc, team] = await Promise.all([
    db.collection(PROPERTY_REGULAR_CLEANERS_COLLECTION).doc(propertyId).get(),
    withChoices ? db.collection(CLEANERS_COLLECTION).select('name', 'role', 'status').get() : Promise.resolve(null),
  ]);
  const choices = team
    ? team.docs
        .filter((d) => roleOf({ role: d.get('role') }) === 'cleaner' && d.get('status') === 'active')
        .map((d) => ({ id: d.id, name: fieldText(d.get('name')) }))
        .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', 'en-CA') || a.id.localeCompare(b.id))
    : null;
  if (!doc.exists) return { regular: null, choices, unreadable: false };
  const record = readRegularCleaner(doc.id, doc.data() ?? {});
  if (!record) {
    console.error(`[regular-cleaner] ${PROPERTY_REGULAR_CLEANERS_COLLECTION}/${propertyId} is not in the written shape`);
    return { regular: null, choices, unreadable: true };
  }
  // A record naming nobody (version 2): none, kept for its history.
  if (record.cleanerId === null) return { regular: null, choices, unreadable: false, history: record.history };
  const cleanerId = record.cleanerId;
  const account = team?.docs.find((d) => d.id === cleanerId) ?? (await db.getAll(db.collection(CLEANERS_COLLECTION).doc(cleanerId), { fieldMask: ['name', 'role', 'status'] }))[0];
  const found = account?.exists ?? false;
  const role = found ? roleOf({ role: account!.get('role') }) : null;
  const status = found ? fieldText(account!.get('status')) : null;
  return {
    regular: {
      cleanerId,
      name: (found ? fieldText(account!.get('name')) : null) ?? record.cleanerNameAtSet,
      state: found ? 'found' : 'missing',
      role,
      status,
      assigns: found && regularAssigns({ id: cleanerId, name: null, role: role ?? '', status }),
      setAt: record.setAt,
      setBy: record.setBy as Actor,
      history: record.history,
    },
    choices,
    unreadable: false,
    history: record.history,
  };
}

export type SetRegularCleanerResult =
  | { kind: 'set'; name: string | null }
  | { kind: 'cleared' }
  | { kind: 'unchanged' }
  | { kind: 'no-such-property' }
  | { kind: 'not-assignable'; name: string | null; why: 'missing' | 'not-a-cleaner' | 'inactive' }
  | { kind: 'failed' };

/** Who a record names now, for a history event's `from`; null when nobody. */
const namedBy = (record: RegularCleanerRecord | null): RegularWho | null => (record && record.cleanerId !== null ? { cleanerId: record.cleanerId, name: record.cleanerNameAtSet } : null);

/**
 * Set a property's regular cleaner, or clear it (`cleanerId` null), as `actor`. Only an existing, active cleaner is
 * set. One transaction: the property, the record and the account are read, then the record written (schema version 2,
 * the change appended to its history; a clear keeps the record naming nobody). Existing jobs are never changed: the
 * next job the sync makes is the first it applies to.
 */
export async function setRegularCleaner(actor: Actor, propertyId: string, cleanerId: string | null): Promise<SetRegularCleanerResult> {
  if (!isDocumentId(propertyId) || (cleanerId !== null && !isDocumentId(cleanerId))) return { kind: 'no-such-property' };
  const db = getAdminDb();
  const ref = db.collection(PROPERTY_REGULAR_CLEANERS_COLLECTION).doc(propertyId);
  try {
    return await db.runTransaction(async (tx): Promise<SetRegularCleanerResult> => {
      const reads = [tx.get(db.collection('properties').doc(propertyId)), tx.get(ref)] as const;
      const [property, current] = await Promise.all(reads);
      if (!property.exists) return { kind: 'no-such-property' };
      const stored = current.exists ? readRegularCleaner(current.id, current.data() ?? {}) : null;
      const now = new Date().toISOString();
      if (cleanerId === null) {
        if (!current.exists || (stored !== null && stored.cleanerId === null)) return { kind: 'unchanged' };
        tx.set(ref, regularRecordAfter(propertyId, stored, null, regularEvent(now, 'cleared', actor, namedBy(stored), null)));
        return { kind: 'cleared' };
      }
      const account = await tx.get(db.collection(CLEANERS_COLLECTION).doc(cleanerId));
      const name = account.exists ? fieldText(account.get('name')) : null;
      if (!account.exists) return { kind: 'not-assignable', name: null, why: 'missing' };
      if (roleOf({ role: account.get('role') }) !== 'cleaner') return { kind: 'not-assignable', name, why: 'not-a-cleaner' };
      if (account.get('status') !== 'active') return { kind: 'not-assignable', name, why: 'inactive' };
      if (stored?.cleanerId === cleanerId) return { kind: 'unchanged' };
      tx.set(ref, regularRecordAfter(propertyId, stored, { cleanerId, name }, regularEvent(now, 'set', actor, namedBy(stored), { cleanerId, name })));
      return { kind: 'set', name };
    });
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    console.error(`[regular-cleaner] setting it for ${propertyId} failed: grpc code ${typeof code === 'number' ? code : 'unknown'}`);
    return { kind: 'failed' };
  }
}

// ─── Replacing a regular cleaner who leaves (Kian's ruling K4 of 2026-10-19) ───

/** One property's outcome when its regular cleaner was deactivated or deleted with a replacement chosen. */
export interface RegularReplaced {
  propertyId: string;
  /** The property, by the name the admin knows it by. */
  name: string;
  /** `replaced` (another cleaner), `cleared` (nobody), `not-theirs` (the record no longer named the person: left as it is), `not-assignable` (the replacement is not an active cleaner: left as it is). */
  outcome: 'replaced' | 'cleared' | 'not-theirs' | 'not-assignable';
  to: RegularWho | null;
}

/**
 * The reads a replacement needs, inside the deactivation's or the deletion's transaction, before its first write:
 * each named property's record and each chosen replacement's account. `apply` then writes them (the property's record
 * with a `replaced` event, reason `deactivated` or `deleted`) — only where the record still names the person leaving,
 * and only a replacement that is an active cleaner other than them; anything else is left as it is and said.
 */
export async function readRegularReplacements(tx: Transaction, leaving: string, replacements: RegularReplacements): Promise<{ apply: (actor: Actor, reason: RegularChangeReason, at: string) => RegularReplaced[] }> {
  const db = getAdminDb();
  const propertyIds = Object.keys(replacements).filter((id) => isDocumentId(id));
  if (propertyIds.length === 0) return { apply: () => [] };
  const chosen = [...new Set(Object.values(replacements).filter((id): id is string => id !== null && isDocumentId(id)))];
  const [records, accounts]: [DocumentSnapshot[], DocumentSnapshot[]] = await Promise.all([
    tx.getAll(...propertyIds.map((id) => db.collection(PROPERTY_REGULAR_CLEANERS_COLLECTION).doc(id))),
    chosen.length ? tx.getAll(...chosen.map((id) => db.collection(CLEANERS_COLLECTION).doc(id)), { fieldMask: ['name', 'role', 'status'] }) : Promise.resolve([] as DocumentSnapshot[]),
  ]);
  // Display names, outside the transaction's reads: the cleaner-facing name, else the title.
  const facing = await cleanerFacingNamesOf(propertyIds);
  const untitled = propertyIds.filter((id) => !facing.has(id));
  const titles = untitled.length ? await db.getAll(...untitled.map((id) => db.collection('properties').doc(id)), { fieldMask: ['name'] }) : [];
  const titleOf = new Map(titles.map((doc) => [doc.id, doc.exists ? fieldText(doc.get('name')) : null]));
  const nameOf = (id: string) => internalNameOf(facing, id, titleOf.get(id) ?? null) ?? 'a property';
  const candidates = new Map<string, RegularCandidate>(accounts.filter((doc) => doc.exists).map((doc) => [doc.id, { id: doc.id, name: fieldText(doc.get('name')), role: roleOf({ role: doc.get('role') }), status: fieldText(doc.get('status')) }]));
  const stored = new Map<string, RegularCleanerRecord | null>(records.map((doc) => [doc.id, doc.exists ? readRegularCleaner(doc.id, doc.data() ?? {}) : null]));
  return {
    apply(actor, reason, at) {
      return propertyIds.map((propertyId): RegularReplaced => {
        const record = stored.get(propertyId) ?? null;
        const name = nameOf(propertyId);
        if (!record || record.cleanerId !== leaving) return { propertyId, name, outcome: 'not-theirs', to: null };
        const wanted = replacements[propertyId];
        const candidate = wanted === null ? null : candidates.get(wanted);
        if (wanted !== null && !replacementAssigns(candidate, leaving)) return { propertyId, name, outcome: 'not-assignable', to: null };
        const to: RegularWho | null = candidate ? { cleanerId: candidate.id, name: candidate.name } : null;
        tx.set(db.collection(PROPERTY_REGULAR_CLEANERS_COLLECTION).doc(propertyId), regularRecordAfter(propertyId, record, to, regularEvent(at, 'replaced', actor, namedBy(record), to, reason)));
        return { propertyId, name, outcome: to ? 'replaced' : 'cleared', to };
      });
    },
  };
}

/**
 * The properties whose regular cleaner this is, by the name the admin knows them by (their cleaner-facing name, else
 * their title): what the Team page says before deactivating or deleting them, since those properties' new jobs are
 * then made with nobody on them. Reads: the records naming them (one query), their names, and the titles of those
 * without one.
 *
 * @throws if a read fails.
 */
export async function regularAt(cleanerId: string): Promise<string[]> {
  return (await regularFor(cleanerId)).map((p) => p.name);
}

/** A property a team member is the regular cleaner for, by ID and the name the admin knows it by. */
export interface RegularProperty {
  propertyId: string;
  name: string;
}

/** The names the admin knows these properties by (their cleaner-facing name, else their title), A to Z. */
async function namedProperties(ids: string[]): Promise<RegularProperty[]> {
  if (ids.length === 0) return [];
  const db = getAdminDb();
  const facing = await cleanerFacingNamesOf(ids);
  const untitled = ids.filter((id) => !facing.has(id));
  const titles = untitled.length ? await db.getAll(...untitled.map((id) => db.collection('properties').doc(id)), { fieldMask: ['name'] }) : [];
  const titleOf = new Map(titles.map((doc) => [doc.id, doc.exists ? fieldText(doc.get('name')) : null]));
  return ids.map((id) => ({ propertyId: id, name: internalNameOf(facing, id, titleOf.get(id) ?? null) ?? 'a deleted property' })).sort((a, b) => a.name.localeCompare(b.name, 'en-CA') || a.propertyId.localeCompare(b.propertyId));
}

/**
 * The properties whose regular cleaner this is, by ID and name (Kian's ruling K4 of 2026-10-19: the deactivate and
 * delete dialogs offer a replacement for each). Reads: the records naming them (one query), their names, and the
 * titles of those without one.
 *
 * @throws if a read fails.
 */
export async function regularFor(cleanerId: string): Promise<RegularProperty[]> {
  if (!isDocumentId(cleanerId)) return [];
  const snap = await getAdminDb().collection(PROPERTY_REGULAR_CLEANERS_COLLECTION).where('cleanerId', '==', cleanerId).get();
  return namedProperties(snap.docs.map((doc) => doc.id));
}

/**
 * Every team member's regular properties and their jobs ahead, for the Team page (2026-10-19): the properties each is
 * the regular cleaner for, by name, and how many jobs each is on whose checkout is today or later. Reads: every
 * regular-cleaner record (one query), the names of the properties named, and the jobs from today on (one query: jobs
 * are made two days ahead, so a few documents).
 *
 * @throws if a read fails.
 */
export async function teamSchedule(today: string = torontoDay()): Promise<{ today: string; regular: Record<string, RegularProperty[]>; upcoming: Record<string, number> }> {
  const db = getAdminDb();
  const [records, jobs] = await Promise.all([db.collection(PROPERTY_REGULAR_CLEANERS_COLLECTION).get(), db.collection(CLEANING_JOBS_COLLECTION).where('checkout', '>=', today).get()]);
  const byCleaner = new Map<string, string[]>();
  for (const doc of records.docs) {
    const record = readRegularCleaner(doc.id, doc.data() ?? {});
    if (!record || record.cleanerId === null) continue;
    byCleaner.set(record.cleanerId, [...(byCleaner.get(record.cleanerId) ?? []), doc.id]);
  }
  const named = await namedProperties([...new Set([...byCleaner.values()].flat())]);
  const nameOf = new Map(named.map((p) => [p.propertyId, p]));
  const regular: Record<string, RegularProperty[]> = {};
  for (const [cleanerId, ids] of byCleaner) regular[cleanerId] = ids.map((id) => nameOf.get(id)).filter((p): p is RegularProperty => p !== undefined).sort((a, b) => a.name.localeCompare(b.name, 'en-CA'));
  const upcoming: Record<string, number> = {};
  for (const doc of jobs.docs) {
    const job = readJob(doc.id, doc.data() ?? {});
    if (!job || job.status !== 'open') continue;
    for (const cleanerId of job.cleanerIds) upcoming[cleanerId] = (upcoming[cleanerId] ?? 0) + 1;
  }
  return { today, regular, upcoming };
}
