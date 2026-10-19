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
 * and assigns nobody: the job sync checks the account each time it makes a job.
 */

import { getAdminDb } from './admin';
import { isDocumentId } from './server-leads';
import { cleanerFacingNamesOf, internalNameOf } from './server-property-names';
import { CLEANERS_COLLECTION, fieldText, roleOf, type Actor } from '@/app/lib/cleaners/model';
import { PROPERTY_REGULAR_CLEANERS_COLLECTION, REGULAR_CLEANER_SCHEMA_VERSION, readRegularCleaner, regularAssigns } from '@/app/lib/schedule/regular';

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
export async function getRegularCleaner(propertyId: string, withChoices = false): Promise<{ regular: RegularCleanerView | null; choices: RegularChoice[] | null; unreadable: boolean }> {
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
  const account = team?.docs.find((d) => d.id === record.cleanerId) ?? (await db.getAll(db.collection(CLEANERS_COLLECTION).doc(record.cleanerId), { fieldMask: ['name', 'role', 'status'] }))[0];
  const found = account?.exists ?? false;
  const role = found ? roleOf({ role: account!.get('role') }) : null;
  const status = found ? fieldText(account!.get('status')) : null;
  return {
    regular: {
      cleanerId: record.cleanerId,
      name: (found ? fieldText(account!.get('name')) : null) ?? record.cleanerNameAtSet,
      state: found ? 'found' : 'missing',
      role,
      status,
      assigns: found && regularAssigns({ id: record.cleanerId, name: null, role: role ?? '', status }),
      setAt: record.setAt,
      setBy: record.setBy as Actor,
    },
    choices,
    unreadable: false,
  };
}

export type SetRegularCleanerResult =
  | { kind: 'set'; name: string | null }
  | { kind: 'cleared' }
  | { kind: 'unchanged' }
  | { kind: 'no-such-property' }
  | { kind: 'not-assignable'; name: string | null; why: 'missing' | 'not-a-cleaner' | 'inactive' }
  | { kind: 'failed' };

/**
 * Set a property's regular cleaner, or clear it (`cleanerId` null), as `actor`. Only an existing, active cleaner is
 * set. One transaction: the property, the record and the account are read, then the record written or deleted.
 * Existing jobs are never changed: the next job the sync makes is the first it applies to.
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
      if (cleanerId === null) {
        if (!current.exists) return { kind: 'unchanged' };
        tx.delete(ref);
        return { kind: 'cleared' };
      }
      const account = await tx.get(db.collection(CLEANERS_COLLECTION).doc(cleanerId));
      const name = account.exists ? fieldText(account.get('name')) : null;
      if (!account.exists) return { kind: 'not-assignable', name: null, why: 'missing' };
      if (roleOf({ role: account.get('role') }) !== 'cleaner') return { kind: 'not-assignable', name, why: 'not-a-cleaner' };
      if (account.get('status') !== 'active') return { kind: 'not-assignable', name, why: 'inactive' };
      if (stored?.cleanerId === cleanerId) return { kind: 'unchanged' };
      tx.set(ref, { schemaVersion: REGULAR_CLEANER_SCHEMA_VERSION, propertyId, cleanerId, cleanerNameAtSet: name, setAt: new Date().toISOString(), setBy: actor });
      return { kind: 'set', name };
    });
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    console.error(`[regular-cleaner] setting it for ${propertyId} failed: grpc code ${typeof code === 'number' ? code : 'unknown'}`);
    return { kind: 'failed' };
  }
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
  if (!isDocumentId(cleanerId)) return [];
  const db = getAdminDb();
  const snap = await db.collection(PROPERTY_REGULAR_CLEANERS_COLLECTION).where('cleanerId', '==', cleanerId).get();
  const ids = snap.docs.map((doc) => doc.id);
  if (ids.length === 0) return [];
  const facing = await cleanerFacingNamesOf(ids);
  const untitled = ids.filter((id) => !facing.has(id));
  const titles = untitled.length ? await db.getAll(...untitled.map((id) => db.collection('properties').doc(id)), { fieldMask: ['name'] }) : [];
  const titleOf = new Map(titles.map((doc) => [doc.id, doc.exists ? fieldText(doc.get('name')) : null]));
  return ids.map((id) => internalNameOf(facing, id, titleOf.get(id) ?? null) ?? 'a deleted property').sort((a, b) => a.localeCompare(b, 'en-CA'));
}
