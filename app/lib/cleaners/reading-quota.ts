/**
 * The runaway-bill guard for receipt readings (dispatch 20).
 *
 * Every reading costs money at Google. Before the read route calls the
 * model it takes a slot here: one Firestore document per Toronto day,
 * `receipt_reading_quota/YYYY-MM-DD`, counting readings for the day in all
 * and per cleaner. A cleaner past READING_LIMITS.PER_CLEANER_PER_DAY, or a
 * day past READING_LIMITS.PER_DAY, gets no reading and the phone shows the
 * form to type into; the photo and the entry are unaffected.
 *
 * At the limits, and the measured cost of about $0.002 a reading, a day
 * costs at most about $0.60, and a month at most about $18, even if every
 * slot were taken. The typical month at 200 receipts costs about $0.40.
 * Google's own quota for the API key's project is the backstop behind this
 * one; it is set in the Cloud console, not here.
 *
 * The slot is taken in a transaction, so two readings at once cannot both
 * be the last one. A slot that cannot be taken — the transaction failed —
 * means no reading: the guard fails closed on cost, never open.
 *
 * One read and one write per reading. The document is never deleted by the
 * app; a day's document is about 1 KB.
 */

import { getAdminDb } from '@/app/lib/firebase/admin';
import {
  ENTRY_TIME_ZONE,
  READING_LIMITS,
  RECEIPT_READING_QUOTA_COLLECTION,
  RECEIPT_READING_QUOTA_SCHEMA_VERSION,
  dayIn,
} from './model';

export type SlotResult =
  | { kind: 'taken'; day: string; cleanerToday: number; today: number }
  | { kind: 'over'; which: 'cleaner' | 'day'; day: string };

const count = (value: unknown): number => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0);

/**
 * Take one reading slot for this cleaner today, or report which limit is
 * reached. @throws when Firestore cannot be reached or written: the caller
 * treats that as no slot.
 */
export async function takeReadingSlot(cleanerId: string, now: Date = new Date()): Promise<SlotResult> {
  const day = dayIn(ENTRY_TIME_ZONE, now);
  const ref = getAdminDb().collection(RECEIPT_READING_QUOTA_COLLECTION).doc(day);
  return getAdminDb().runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    const byCleaner: Record<string, unknown> =
      snapshot.exists && typeof snapshot.get('byCleaner') === 'object' && snapshot.get('byCleaner') !== null
        ? (snapshot.get('byCleaner') as Record<string, unknown>)
        : {};
    const today = count(snapshot.exists ? snapshot.get('total') : 0);
    const cleanerToday = count(byCleaner[cleanerId]);

    if (cleanerToday >= READING_LIMITS.PER_CLEANER_PER_DAY) return { kind: 'over', which: 'cleaner', day };
    if (today >= READING_LIMITS.PER_DAY) return { kind: 'over', which: 'day', day };

    const at = now.toISOString();
    tx.set(
      ref,
      {
        schemaVersion: RECEIPT_READING_QUOTA_SCHEMA_VERSION,
        day,
        total: today + 1,
        byCleaner: { ...Object.fromEntries(Object.entries(byCleaner).map(([id, n]) => [id, count(n)])), [cleanerId]: cleanerToday + 1 },
        ...(snapshot.exists ? {} : { createdAt: at }),
        updatedAt: at,
      },
      { merge: true },
    );
    return { kind: 'taken', day, cleanerToday: cleanerToday + 1, today: today + 1 };
  });
}
