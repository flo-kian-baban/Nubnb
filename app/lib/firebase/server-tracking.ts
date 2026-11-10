/**
 * The tracking switch (Kian's ruling of 2026-11-10, "Not tracked by Nubnb"): one function flips a unit's mark on its
 * server-only management record (`property_management/{propertyId}`, the `excludedFromReporting` flag of dispatch 24)
 * and, in the same transaction, does what the ruling asks of its jobs — off: its open, unmarked jobs are deleted and
 * each calendar job leaves the deleted-job marker the sync honours, with the reason `tracking-off`; on: the markers
 * that switch-off wrote for checkouts from today on are cleared, so the next calendar read makes jobs for future
 * checkouts only (app/lib/schedule/tracking.ts has the rules). Two doors reach it: PUT …/tracking (the property page's
 * switch) and the property form's Save (server-management.ts, when the saved record flips the flag).
 *
 * Reads, in the transaction: the property (existence), the record, and the unit's jobs (off) or its markers (on), one
 * query each by property. Writes: the record, the deletes and the markers. A job or marker not in the written shape is
 * left as it is and counted in `unreadable`. Counted cleanings are never read or touched: a job with a mark stays.
 *
 * @throws if a read or write fails (the route answers 502; the record is then as it was).
 */

import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { getAdminDb } from './admin';
import { isDocumentId } from './server-leads';
import { torontoDay } from '@/app/lib/availability/days';
import type { Actor } from '@/app/lib/cleaners/model';
import { PROPERTY_MANAGEMENT_COLLECTION, PROPERTY_MANAGEMENT_SCHEMA_VERSION, STATEMENTS_FROM_DEFAULT, isExcludedFromReporting, readPropertyManagement, type PropertyManagement, type PropertyManagementView } from '@/app/lib/reports/model';
import { CLEANING_JOBS_COLLECTION, DELETED_JOBS_COLLECTION, readDeletedJob, readJob, type StoredJob } from '@/app/lib/schedule/model';
import { planTrackingOff, planTrackingOn, type TrackingChange, type TrackingMarker } from '@/app/lib/schedule/tracking';

/**
 * Inside a transaction whose reads so far are done and whose writes have not begun: read what the switch needs and
 * queue its writes. Off: the unit's jobs; on: the unit's markers. Returns what changed.
 */
export async function applyTrackingChange(tx: Transaction, db: Firestore, propertyId: string, tracked: boolean, actor: Actor, now: Date): Promise<TrackingChange> {
  const nowIso = now.toISOString();
  let unreadable = 0;
  if (!tracked) {
    const snap = await tx.get(db.collection(CLEANING_JOBS_COLLECTION).where('propertyId', '==', propertyId));
    const jobs: StoredJob[] = [];
    for (const doc of snap.docs) {
      const job = readJob(doc.id, doc.data());
      if (job) jobs.push(job);
      else unreadable += 1;
    }
    const plan = planTrackingOff(jobs, actor, nowIso);
    for (const job of plan.remove) tx.delete(db.collection(CLEANING_JOBS_COLLECTION).doc(job.id));
    for (const marker of plan.markers) {
      const { id, ...fields } = marker;
      tx.set(db.collection(DELETED_JOBS_COLLECTION).doc(id), fields);
    }
    return { tracked: false, jobsRemoved: plan.remove.length, markersWritten: plan.markers.length, markersCleared: 0, unreadable };
  }
  const snap = await tx.get(db.collection(DELETED_JOBS_COLLECTION).where('propertyId', '==', propertyId));
  const markers: TrackingMarker[] = [];
  for (const doc of snap.docs) {
    const marker = readDeletedJob(doc.id, doc.data());
    if (marker) markers.push(marker);
    else unreadable += 1;
  }
  const plan = planTrackingOn(markers, torontoDay(now));
  for (const id of plan.clear) tx.delete(db.collection(DELETED_JOBS_COLLECTION).doc(id));
  return { tracked: true, jobsRemoved: 0, markersWritten: 0, markersCleared: plan.clear.length, unreadable };
}

/** The record as stored with the mark set or cleared: written only when true, so a record that never set it keeps its shape. */
export function recordWithTracking(was: PropertyManagementView | null, propertyId: string, tracked: boolean, nowIso: string): PropertyManagement {
  let base: PropertyManagement;
  if (was) {
    // The stored fields without the view's `id` and without the mark, which is written below only when true.
    const fields: Record<string, unknown> = { ...was };
    delete fields.id;
    delete fields.excludedFromReporting;
    base = fields as unknown as PropertyManagement;
  } else {
    base = { schemaVersion: PROPERTY_MANAGEMENT_SCHEMA_VERSION, propertyId, reportFor: null, owners: [], statementsFrom: STATEMENTS_FROM_DEFAULT, statementsUntil: null, defaultFeeRateBasisPoints: null, defaultFee: null, setAt: nowIso };
  }
  return { ...base, ...(tracked ? {} : { excludedFromReporting: true }), setAt: nowIso };
}

export type SetTrackingResult =
  | { kind: 'set'; record: PropertyManagementView | null; tracked: boolean; changed: boolean; change: TrackingChange | null }
  | { kind: 'no-such-property' }
  /** The stored record is not in the written shape: nothing is changed until it is read. */
  | { kind: 'unreadable' };

/**
 * Turn a unit's tracking on or off, as the property page's switch does. Nothing differs, nothing is written. The
 * property document is never touched.
 *
 * @throws if a read or write fails.
 */
export async function setTracking(actor: Actor, propertyId: string, tracked: boolean, now: Date = new Date()): Promise<SetTrackingResult> {
  if (!isDocumentId(propertyId)) return { kind: 'no-such-property' };
  const db = getAdminDb();
  const ref = db.collection(PROPERTY_MANAGEMENT_COLLECTION).doc(propertyId);
  return db.runTransaction(async (tx): Promise<SetTrackingResult> => {
    const [[property], snap] = await Promise.all([tx.getAll(db.collection('properties').doc(propertyId), { fieldMask: ['name'] }), tx.get(ref)]);
    if (!property.exists) return { kind: 'no-such-property' };
    const was = snap.exists ? readPropertyManagement(snap.id, snap.data() ?? {}) : null;
    if (snap.exists && was === null) return { kind: 'unreadable' };
    const wasTracked = !isExcludedFromReporting(was);
    if (wasTracked === tracked) return { kind: 'set', record: was, tracked, changed: false, change: null };
    const change = await applyTrackingChange(tx, db, propertyId, tracked, actor, now);
    const record = recordWithTracking(was, propertyId, tracked, now.toISOString());
    tx.set(ref, record);
    return { kind: 'set', record: readPropertyManagement(propertyId, record as unknown as Record<string, unknown>), tracked, changed: true, change };
  });
}
