/**
 * Writing the plan (sync.ts) to `cleaning_jobs`, through the Admin SDK: run
 * right after the calendar copy is written, by every refresh — the day's
 * first admin page or cleaner app, and Refresh calendars (refresh.ts). Like
 * availability/store.ts, nothing here initialises an app: each caller passes
 * its own `Firestore`.
 *
 * Reads: one query, the jobs from today on (a few days' checkouts), and one
 * read per job that changed. Writes: one `create()` per new job — an ID that
 * exists already (two runs at once) is left as it is — and one transaction per
 * changed job, which reads it again and plans again before writing, so an
 * admin's assignment or a cleaner's mark in between is never lost.
 *
 * Never throws: the copy is already written when this runs, and a failed sync
 * is reported in the outcome and the log, then made good by the next run.
 */

import { createHash } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import type { AvailabilitySnapshot } from '../availability/types';
import { CLEANING_JOBS_COLLECTION, readJob, type StoredJob } from './model';
import { planCreates, planJob } from './sync';

/** A calendar link's key: the first ten hex of its SHA-256. Tells a changed link apart; never the link. '' for none. */
export function calendarKeyOf(url: string | null | undefined): string {
  const link = typeof url === 'string' ? url.trim() : '';
  return link ? createHash('sha256').update(link, 'utf8').digest('hex').slice(0, 10) : '';
}

export interface JobSyncOutcome {
  created: number;
  changed: number;
  /** Stored jobs from today on, read to compare. */
  watched: number;
  /** Stored jobs not in the written shape, left as they are. */
  unreadable: number;
  /** The gRPC code of a failure that stopped the sync; null when it ran through. */
  failed: string | null;
}

function grpcCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? String(code) : typeof code === 'string' ? code : 'unknown';
}

/** Make and update the jobs from the copy just written. See the file's header. */
export async function syncJobs(db: Firestore, snapshot: AvailabilitySnapshot, log: (line: string) => void = () => undefined): Promise<JobSyncOutcome> {
  const outcome: JobSyncOutcome = { created: 0, changed: 0, watched: 0, unreadable: 0, failed: null };
  try {
    const jobsRef = db.collection(CLEANING_JOBS_COLLECTION);
    const stored = await jobsRef.where('checkout', '>=', snapshot.today).get();
    const jobs: StoredJob[] = [];
    for (const doc of stored.docs) {
      const job = readJob(doc.id, doc.data());
      if (job) jobs.push(job);
      else outcome.unreadable += 1;
    }
    outcome.watched = jobs.length;
    const keys = new Map(Object.entries(snapshot.properties).map(([id, entry]) => [id, calendarKeyOf(entry.icalUrl)]));
    const nowIso = new Date().toISOString();

    for (const { id, job } of planCreates({ snapshot, existing: new Set(stored.docs.map((doc) => doc.id)), keys, nowIso })) {
      try {
        await jobsRef.doc(id).create(job);
        outcome.created += 1;
      } catch (err) {
        // ALREADY_EXISTS (gRPC code 6): another run made it a moment ago.
        if ((err as { code?: unknown } | null)?.code !== 6) throw err;
      }
    }

    for (const job of jobs) {
      if (!planJob(job, snapshot, keys.get(job.propertyId) ?? null, nowIso)) continue;
      const ref = jobsRef.doc(job.id);
      const wrote = await db.runTransaction(async (tx) => {
        const fresh = await tx.get(ref);
        const current = fresh.exists ? readJob(fresh.id, fresh.data() ?? {}) : null;
        if (!current) return false;
        const patch = planJob(current, snapshot, keys.get(current.propertyId) ?? null, nowIso);
        if (!patch) return false;
        tx.update(ref, { ...patch.fields, history: [...current.history, ...patch.events] });
        return true;
      });
      if (wrote) outcome.changed += 1;
    }
    if (outcome.unreadable > 0) log(`jobs: ${outcome.unreadable} stored job(s) not in the written shape, left as they are`);
  } catch (err) {
    outcome.failed = grpcCode(err);
    log(`jobs: the sync stopped (grpc code ${outcome.failed}); the copy is written, and the next run tries again`);
  }
  return outcome;
}
