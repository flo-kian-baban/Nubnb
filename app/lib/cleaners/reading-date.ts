/**
 * A receipt the reading dates before the first statement month (Kian's instruction of 2026-11-01, Phase 2 step 2):
 * the cleaner is told, in a sentence they can act on, and the receipt is not sent. The phone holds Send back with
 * that sentence; the entry route refuses the same receipt before anything is stored (422
 * ENTRY_DATED_BEFORE_STATEMENTS), so nothing is written either way. Never the admin's floor line alone.
 *
 * The date is the one the model read off the photo (`purchasedOn`, YYYY-MM-DD). It still never fills the form
 * (Kian's ruling of 2026-09-30): it only stops a receipt that is too old for Nubnb's statements. Because the model
 * reads two-digit years badly (measured 2026-09-30: "20/09/26" read as 2020-09-26, "26/09/14" as 2014-09-26), only a
 * date in the twelve months before the first statement month is taken as real; a date read further back is taken as
 * a misreading and stops nothing. That window is the developer's choice, not a ruling.
 *
 * Client-safe, and pure.
 */

import { STATEMENTS_FROM_DEFAULT, addMonths, monthLabel } from '@/app/lib/reports/model';

/** What the cleaner sees, on the receipt and above Send. */
export const DATED_BEFORE_STATEMENTS = `This receipt is dated before ${monthLabel(STATEMENTS_FROM_DEFAULT)} and can’t be sent here. Give it to Nubnb directly.`;

/** The refusal's code on the entry route. */
export const DATED_BEFORE_STATEMENTS_CODE = 'ENTRY_DATED_BEFORE_STATEMENTS';

/** The first day of the first statement month, and the earliest read date taken as real: twelve months before it. */
const FIRST_DAY = `${STATEMENTS_FROM_DEFAULT}-01`;
const EARLIEST_DAY = `${addMonths(STATEMENTS_FROM_DEFAULT, -12)}-01`;

/**
 * The read date when it puts the receipt before the first statement month, else null: a real day written
 * YYYY-MM-DD, on or after EARLIEST_DAY and before FIRST_DAY. Anything else — no date, another format, a day that does
 * not exist, a date further back (a misreading), a date in or after the first statement month — stops nothing.
 */
export function readDateBeforeStatements(purchasedOn: unknown): string | null {
  if (typeof purchasedOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(purchasedOn)) return null;
  const [year, month, day] = purchasedOn.split('-').map(Number);
  if (new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) !== purchasedOn) return null;
  return purchasedOn >= EARLIEST_DAY && purchasedOn < FIRST_DAY ? purchasedOn : null;
}

/** The same question of a reading record: only a reading that answered (`ok`) dates a receipt. */
export function recordDatedBeforeStatements(record: { status?: unknown; output?: { purchasedOn?: unknown } | null } | null | undefined): string | null {
  if (!record || record.status !== 'ok' || !record.output) return null;
  return readDateBeforeStatements(record.output.purchasedOn);
}
