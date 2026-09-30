/**
 * Nubnb's Cloud Functions (2nd generation). One so far:
 *
 *   refreshAvailability — every hour, on the Toronto clock: fetch every
 *   property's Airbnb calendar and write the stored copy the admin's
 *   Availability page searches (availability_snapshots/current, and the
 *   day's availability_days/{day}). See AVAILABILITY-SEARCH-PLAN.md §2.3.
 *
 * The code it runs is the app's own app/lib/availability module, copied in
 * under src/lib/ by scripts/functions-sync.mjs before each build: one
 * parser, one builder, one writer, shared with the Vercel routes.
 *
 * Runs as the project's default service account (no key anywhere), in
 * us-central1 beside the nam5 Firestore database, on 256 MiB, never more
 * than one instance, and never kept warm: a run is under ten seconds and
 * everything here stays inside the no-cost allowances (plan §2.3).
 */

import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { onSchedule } from 'firebase-functions/scheduler';
import { runRefresh } from './lib/availability/refresh';

initializeApp();

export const refreshAvailability = onSchedule(
  {
    schedule: 'every 60 minutes',
    timeZone: 'America/Toronto',
    region: 'us-central1',
    memory: '256MiB',
    timeoutSeconds: 120,
    maxInstances: 1,
    minInstances: 0,
    retryCount: 0,
  },
  async () => {
    const outcome = await runRefresh({
      db: getFirestore(),
      source: 'schedule',
      checkPages: 'auto',
      log: (line) => logger.info(line),
    });
    const { run } = outcome.snapshot;
    logger.info('refreshAvailability finished', {
      refreshedAt: outcome.snapshot.refreshedAt,
      fetched: run.fetched,
      failed: run.failed.length,
      pagesChecked: outcome.pagesChecked,
      dayWritten: outcome.dayWritten,
    });
  },
);
