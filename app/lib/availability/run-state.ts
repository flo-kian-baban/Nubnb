/**
 * One calendar refresh at a time, and the day's first one (Kian's ruling of
 * 2026-10-14, night: no scheduled job; the calendar copy and the cleaning
 * jobs refresh in the background on the first admin page or the first
 * cleaner app opened each Toronto day, and when an admin presses Refresh
 * calendars; only one refresh runs at a time, and a second trigger while one
 * runs does nothing).
 *
 * The state is one small document, `availability_snapshots/refresh`, in the
 * collection firestore.rules already denies every browser:
 *   running     the run holding the lease, and when the lease runs out;
 *   lastDone    the last run that wrote the copy and synced the jobs: its
 *               Toronto day is what "already refreshed today" means;
 *   lastFailed  the last run that did not finish (it threw, or its lease ran
 *               out because the time limit or a crash stopped it).
 *
 * A run claims the lease in a transaction, so two triggers at once start one
 * run. The lease outlasts any run: the routes that run one stop at 300 s.
 * The first-visit refresh also waits RETRY_PAUSE_MS after a try that did not
 * finish, so a failing run is not retried on every page view; Refresh
 * calendars waits for no pause, only for a lease.
 *
 * Reads on open (Kian's ruling R1 of 2026-10-19, extending the first-visit
 * ruling): when the Schedule or a cleaner's app opens and the last finished
 * run is more than three hours old, the same refresh starts, under the same
 * lease and the same pause. It is the first-visit decision with a threshold
 * (`staleAfterMs`): the stored state keeps its shape, its source "daily" and
 * its triggers.
 *
 * The decisions are pure (`decideClaim`, `afterRun`), so tests hold them;
 * `claimRefresh` and `finishRefresh` wrap them in transactions. Readers are
 * strict: a state not in the written shape is reported, never guessed at;
 * the first-visit refresh then does nothing, and Refresh calendars replaces
 * it.
 */

import { randomUUID } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { torontoDay } from './days';
import { SNAPSHOTS_COLLECTION } from './store';

export const REFRESH_STATE_DOC = 'refresh';
export const REFRESH_STATE_SCHEMA_VERSION = 1;
/** Longer than any run lasts: the routes that run one stop at 300 seconds (their maxDuration). */
export const LEASE_MS = 6 * 60_000;
/** The first-visit refresh waits this long after a try that did not finish. */
export const RETRY_PAUSE_MS = 15 * 60_000;
/** A copy older than this is read again when the Schedule or a cleaner's app opens (Kian's ruling R1 of 2026-10-19). */
export const STALE_AFTER_MS = 3 * 3_600_000;

/** "daily": the day's first admin page or cleaner app; "manual": Refresh calendars. */
export type RefreshSource = 'daily' | 'manual';
export type RefreshTrigger = 'admin-page' | 'cleaner-app' | 'refresh-button';

export interface RefreshLease {
  id: string;
  source: RefreshSource;
  trigger: RefreshTrigger;
  startedAt: string;
  leaseUntil: string;
}

export interface RefreshState {
  schemaVersion: number;
  running: RefreshLease | null;
  lastDone: { id: string; source: RefreshSource; trigger: RefreshTrigger; day: string; startedAt: string; finishedAt: string } | null;
  lastFailed: { id: string; source: RefreshSource; trigger: RefreshTrigger; startedAt: string; at: string; reason: string } | null;
}

export const NO_REFRESH_YET: RefreshState = { schemaVersion: REFRESH_STATE_SCHEMA_VERSION, running: null, lastDone: null, lastFailed: null };

// ─── Reading strictly ──────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';
const isTime = (value: unknown): value is string => isText(value) && Number.isFinite(Date.parse(value));
const isDay = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
const isSource = (value: unknown): value is RefreshSource => value === 'daily' || value === 'manual';
const isTrigger = (value: unknown): value is RefreshTrigger => value === 'admin-page' || value === 'cleaner-app' || value === 'refresh-button';

/** The stored state, read strictly: null when any field is not in the written shape. */
export function readRefreshState(fields: Record<string, unknown>): RefreshState | null {
  const { schemaVersion, running, lastDone, lastFailed } = fields;
  if (typeof schemaVersion !== 'number') return null;
  if (!(running === null || (isRecord(running) && isText(running.id) && isSource(running.source) && isTrigger(running.trigger) && isTime(running.startedAt) && isTime(running.leaseUntil)))) return null;
  if (!(lastDone === null || (isRecord(lastDone) && isText(lastDone.id) && isSource(lastDone.source) && isTrigger(lastDone.trigger) && isDay(lastDone.day) && isTime(lastDone.startedAt) && isTime(lastDone.finishedAt)))) return null;
  if (!(lastFailed === null || (isRecord(lastFailed) && isText(lastFailed.id) && isSource(lastFailed.source) && isTrigger(lastFailed.trigger) && isTime(lastFailed.startedAt) && isTime(lastFailed.at) && isText(lastFailed.reason)))) return null;
  return {
    schemaVersion,
    running: running === null ? null : { id: running.id as string, source: running.source as RefreshSource, trigger: running.trigger as RefreshTrigger, startedAt: running.startedAt as string, leaseUntil: running.leaseUntil as string },
    lastDone: lastDone === null ? null : { id: lastDone.id as string, source: lastDone.source as RefreshSource, trigger: lastDone.trigger as RefreshTrigger, day: lastDone.day as string, startedAt: lastDone.startedAt as string, finishedAt: lastDone.finishedAt as string },
    lastFailed: lastFailed === null ? null : { id: lastFailed.id as string, source: lastFailed.source as RefreshSource, trigger: lastFailed.trigger as RefreshTrigger, startedAt: lastFailed.startedAt as string, at: lastFailed.at as string, reason: lastFailed.reason as string },
  };
}

// ─── The decisions (pure) ──────────────────────────────────────

export type ClaimDecision =
  | { kind: 'claimed'; run: RefreshLease; next: RefreshState }
  /** Another run holds the lease: this trigger does nothing. */
  | { kind: 'running'; run: RefreshLease }
  /** First-visit only: a run already wrote the copy and synced the jobs this Toronto day (and, with a threshold, within it). */
  | { kind: 'done-today'; finishedAt: string }
  /** First-visit only: a try that did not finish was too recent. */
  | { kind: 'paused'; until: string };

/** A lease that ran out never finished: the time limit or a crash stopped its run. */
function withExpiredLease(state: RefreshState, nowMs: number): RefreshState {
  const run = state.running;
  if (!run || Date.parse(run.leaseUntil) > nowMs) return state;
  return { ...state, running: null, lastFailed: { id: run.id, source: run.source, trigger: run.trigger, startedAt: run.startedAt, at: run.leaseUntil, reason: 'stopped before it finished: the lease ran out' } };
}

/**
 * Whether a trigger starts a run now, from the stored state (NO_REFRESH_YET
 * when there is none). One at a time: a live lease answers `running` to
 * every trigger. The first-visit refresh also needs this Toronto day to have
 * no finished run, and RETRY_PAUSE_MS since a try that did not finish.
 * With `staleAfterMs` (the reads on open, R1), a run finished this Toronto
 * day counts only while it finished no longer ago than that.
 */
export function decideClaim(stored: RefreshState, source: RefreshSource, trigger: RefreshTrigger, now: Date, id: string = randomUUID(), staleAfterMs: number | null = null): ClaimDecision {
  const nowMs = now.getTime();
  if (stored.running && Date.parse(stored.running.leaseUntil) > nowMs) return { kind: 'running', run: stored.running };
  const state = withExpiredLease(stored, nowMs);
  if (source === 'daily') {
    const fresh = staleAfterMs === null || nowMs - Date.parse(state.lastDone?.finishedAt ?? '') <= staleAfterMs;
    if (state.lastDone?.day === torontoDay(now) && fresh) return { kind: 'done-today', finishedAt: state.lastDone.finishedAt };
    const pauseUntil = state.lastFailed ? Date.parse(state.lastFailed.startedAt) + RETRY_PAUSE_MS : 0;
    if (pauseUntil > nowMs) return { kind: 'paused', until: new Date(pauseUntil).toISOString() };
  }
  const run: RefreshLease = { id, source, trigger, startedAt: now.toISOString(), leaseUntil: new Date(nowMs + LEASE_MS).toISOString() };
  return { kind: 'claimed', run, next: { schemaVersion: REFRESH_STATE_SCHEMA_VERSION, running: run, lastDone: state.lastDone, lastFailed: state.lastFailed } };
}

/** How a run ended: it wrote the copy and synced the jobs (its Toronto day), or not, and why. */
export type RunEnd = { ok: true; day: string } | { ok: false; reason: string };

/**
 * The state once `run` has ended. The lease is let go only if it is still
 * this run's (a run whose lease ran out may have been followed by another).
 * A finished run becomes `lastDone` unless a later one already is.
 */
export function afterRun(stored: RefreshState, run: RefreshLease, end: RunEnd, now: Date): RefreshState {
  const at = now.toISOString();
  const running = stored.running?.id === run.id ? null : stored.running;
  if (end.ok) {
    const later = stored.lastDone && stored.lastDone.startedAt > run.startedAt;
    return { schemaVersion: REFRESH_STATE_SCHEMA_VERSION, running, lastDone: later ? stored.lastDone : { id: run.id, source: run.source, trigger: run.trigger, day: end.day, startedAt: run.startedAt, finishedAt: at }, lastFailed: stored.lastFailed };
  }
  return { schemaVersion: REFRESH_STATE_SCHEMA_VERSION, running, lastDone: stored.lastDone, lastFailed: { id: run.id, source: run.source, trigger: run.trigger, startedAt: run.startedAt, at, reason: end.reason } };
}

// ─── In Firestore ──────────────────────────────────────────────

const stateRef = (db: Firestore) => db.collection(SNAPSHOTS_COLLECTION).doc(REFRESH_STATE_DOC);

/** The state as stored; NO_REFRESH_YET when there is none; 'unreadable' when it is not in shape. One read. @throws if the read fails. */
export async function readRefreshStateDoc(db: Firestore): Promise<RefreshState | 'unreadable'> {
  const snap = await stateRef(db).get();
  if (!snap.exists) return NO_REFRESH_YET;
  return readRefreshState(snap.data() ?? {}) ?? 'unreadable';
}

export type Claim = ClaimDecision | { kind: 'unreadable' };

/**
 * Claim the lease for a run, in a transaction, so two triggers at once start
 * one run. A state not in shape stops the first-visit refresh (it is logged);
 * Refresh calendars replaces it. `staleAfterMs` as for decideClaim (the reads
 * on open). @throws if Firestore fails.
 */
export async function claimRefresh(db: Firestore, source: RefreshSource, trigger: RefreshTrigger, now: Date = new Date(), staleAfterMs: number | null = null): Promise<Claim> {
  const ref = stateRef(db);
  return db.runTransaction(async (tx): Promise<Claim> => {
    const snap = await tx.get(ref);
    const read = snap.exists ? readRefreshState(snap.data() ?? {}) : NO_REFRESH_YET;
    if (read === null) {
      console.error(`[availability] ${SNAPSHOTS_COLLECTION}/${REFRESH_STATE_DOC} is not in the written shape${source === 'daily' ? '; no first-visit refresh until Refresh calendars replaces it' : '; Refresh calendars replaces it'}`);
      if (source === 'daily') return { kind: 'unreadable' };
    }
    const decision = decideClaim(read ?? NO_REFRESH_YET, source, trigger, now, undefined, staleAfterMs);
    if (decision.kind === 'claimed') tx.set(ref, decision.next);
    return decision;
  });
}

/** Record how a run ended and let its lease go, in a transaction. @throws if Firestore fails. */
export async function finishRefresh(db: Firestore, run: RefreshLease, end: RunEnd, now: Date = new Date()): Promise<void> {
  const ref = stateRef(db);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const read = snap.exists ? readRefreshState(snap.data() ?? {}) : NO_REFRESH_YET;
    tx.set(ref, afterRun(read ?? NO_REFRESH_YET, run, end, now));
  });
}
