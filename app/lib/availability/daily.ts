/**
 * The day's first refresh, in the background (Kian's ruling of 2026-10-14,
 * night): the first admin page or the first cleaner app opened each Toronto
 * day refreshes the calendar copy and the cleaning jobs, never delaying the
 * page. Called by the routes those open with — GET and POST /api/admin-auth
 * (every admin page's sign-in check, and a sign-in) and GET /api/cleaner/start
 * (the cleaner app's first call) — once their own answer is decided.
 *
 * Nothing is read or written before the response: `after()` (next/server)
 * runs the check once the response is sent, inside the same invocation (on
 * Vercel, its waitUntil), within the route's maxDuration of 300 seconds.
 * There it reads the refresh's state (one read, run-state.ts); when today has
 * no finished run, no run holds the lease and no recent try failed, it
 * claims the lease in a transaction and runs the refresh Refresh calendars
 * runs. Each server instance remembers the Toronto day it has seen
 * refreshed, so its later page views that day read nothing at all.
 *
 * The listing-page check does not run here: it was the scheduled function's,
 * subject to the datacenter test, and from Vercel a blocked answer would
 * replace a "gone" verdict with "unknown".
 */

import { after } from 'next/server';
import type { Firestore } from 'firebase-admin/firestore';
import { getAdminDb } from '@/app/lib/firebase/admin';
import { torontoDay } from './days';
import { runRefresh, type RefreshOutcome } from './refresh';
import { claimRefresh, decideClaim, finishRefresh, readRefreshStateDoc, type RefreshLease, type RunEnd } from './run-state';

/** The Toronto day this server instance has seen refreshed: its later page views that day read nothing. */
let refreshedDay: string | null = null;

const grpcCode = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? String(code) : typeof code === 'string' ? code : 'unknown';
};

/**
 * From a route that opens an admin page or the cleaner app, once its answer
 * is decided: the day's first such call starts the refresh after the
 * response. Never throws, never waits.
 */
export function refreshIfFirstToday(trigger: 'admin-page' | 'cleaner-app'): void {
  if (refreshedDay === torontoDay()) return;
  after(async () => {
    try {
      await refreshIfDue(trigger);
    } catch (err) {
      console.error(`[availability] the first-visit refresh (${trigger}) did not run: grpc code ${grpcCode(err)}`);
    }
  });
}

async function refreshIfDue(trigger: 'admin-page' | 'cleaner-app'): Promise<void> {
  const db = getAdminDb();
  const now = new Date();
  // One read; most page views end here.
  const state = await readRefreshStateDoc(db);
  if (state === 'unreadable') {
    console.error('[availability] the refresh state is not in the written shape: no first-visit refresh until Refresh calendars replaces it');
    return;
  }
  const look = decideClaim(state, 'daily', trigger, now);
  if (look.kind === 'done-today') {
    refreshedDay = torontoDay(now);
    return;
  }
  if (look.kind !== 'claimed') return;
  // Again, in a transaction: of two triggers at once, one claims and the other finds it running.
  const claim = await claimRefresh(db, 'daily', trigger, now);
  if (claim.kind === 'done-today') refreshedDay = torontoDay(now);
  if (claim.kind !== 'claimed') return;
  console.log(`[availability] first-visit refresh ${claim.run.id} (${trigger}) started`);
  await runWithLease(db, claim.run);
}

/**
 * Run the refresh under a lease already claimed, then record how it ended and
 * let the lease go. It ended well when the copy was written and the job sync
 * ran through. Throws what the refresh throws, once that is recorded; a
 * failure to record it is logged, and the lease then runs out by itself.
 */
export async function runWithLease(db: Firestore, run: RefreshLease): Promise<RefreshOutcome> {
  let outcome: RefreshOutcome;
  try {
    outcome = await runRefresh({ db, source: run.source, checkPages: false, log: (line) => console.log(`[availability] ${line}`) });
  } catch (err) {
    await finishRefresh(db, run, { ok: false, reason: `the refresh failed: grpc code ${grpcCode(err)}` }).catch((e) => console.error(`[availability] could not record that run ${run.id} failed: grpc code ${grpcCode(e)}`));
    throw err;
  }
  const end: RunEnd = outcome.jobs.failed === null ? { ok: true, day: outcome.snapshot.today } : { ok: false, reason: `the job sync stopped: grpc code ${outcome.jobs.failed}` };
  await finishRefresh(db, run, end).catch((e) => console.error(`[availability] could not record the end of run ${run.id}: grpc code ${grpcCode(e)}; its lease runs out by itself`));
  if (end.ok) refreshedDay = end.day;
  return outcome;
}
