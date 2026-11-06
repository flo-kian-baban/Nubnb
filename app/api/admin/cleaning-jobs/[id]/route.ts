/**
 * PATCH /api/admin/cleaning-jobs/[id] — set who is on a job (Kian's ruling 2 of 2026-10-14; one cleaner per job since
 * Build 2, Kian's ruling of 2026-11-03), change its cleaner in one step (ruling D of 2026-11-01), or set its own amount
 * (ruling B), each as the admin saw it.
 *
 * DELETE /api/admin/cleaning-jobs/[id] — delete the job and its cleaning (Build 2, item 2): `{ seen }`. Refused, in one
 * sentence, when the cleaning is dated on or before a payment to its cleaner (409 JOB_CLEANING_PAID) or printed on a
 * finished statement (409 JOB_CLEANING_PRINTED). A deleted calendar job leaves a marker the sync honours. One line in the
 * activity log, as every admin write. Response: 200 `{ deleted: { id, cleanings, marker } }`.
 *
 * Body: `{ cleanerIds: string[], seen: number }` — everyone who should be on it, and the job's history length when
 *       the page loaded it. Cleaners added must be active cleaners, never handymen, and nobody is added to a job whose
 *       booking changed; a cleaner who has marked it stays on it.
 *       `{ action: 'swap', from, to, seen }` — `from` comes off (never once they marked it), `to`, an active cleaner,
 *       goes on in their place; the history says who was replaced by whom. The old cleaner's app drops the job, the
 *       new one's shows it.
 *       `{ action: 'amount', amount: "75.00" | null, seen }` — the job's own amount, which a mark takes instead of the
 *       base price; locked once a mark's cleaning counts its money (409 JOB_AMOUNT_LOCKED: the Cleanings tab).
 * Recorded in the activity log.
 *
 * The price with Assign and Change cleaner (Kian's instruction of 2026-11-06): the first two bodies may carry `price`
 * ("75.00" or null, what the dialog's field held, sent only when the admin changed it) and `saveCleaningPrice`. They are
 * saved with the cleaner in one transaction: exactly the job's tier cleaning price is no amount on the job, anything
 * else is the job's own amount (as `action: 'amount'` sets it: the same lock, 409 JOB_AMOUNT_LOCKED), an emptied field
 * clears it; `saveCleaningPrice` sets the unit's cleaning price for the job's tier, only where it has none (409
 * CLEANING_PRICE_EXISTS; 422 JOB_PRICE_NEEDED without an amount), and the activity log then gets that save's own line
 * ("Set a property's cleaning prices") after this one.
 *
 * Response: 200 `{ success: true, data: { job, changed, price } }` (the job as stored; `price`: `{ amountCents,
 * amountChanged, cleaningPriceSaved, cleaningsChanged }` or null); 404, 409 (changed since, booking changed, marked,
 * locked), 422 (not assignable), 502 (outcome unknown).
 */

import { NextRequest } from 'next/server';
import { adminRoute, recordAlso } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { DELETE_JOB_REFUSALS, JOB_AMOUNT_REFUSALS, JOB_PRICE_REFUSALS, ASSIGN_REFUSALS, SWAP_REFUSALS, deleteJob, setAssignees, setJobAmount, swapCleaner, type JobPriceInput, type JobPriceOutcome } from '@/app/lib/firebase/server-cleaning-jobs';
import type { PresetKind } from '@/app/lib/cleanings/prices';
import { DeleteJobSchema, JobPatchSchema } from '@/app/lib/cleanings/schemas';
import { JOB_ID_PATTERN } from '@/app/lib/schedule/model';
import { paymentWords } from '@/app/lib/pay/model';
import { monthLabel } from '@/app/lib/reports/model';
import { dayText } from '@/app/lib/availability/days';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** A job's ID: a property's auto ID and its checkout day, with a job added by hand's suffix or not (Build 2). */
const JOB_ID = JOB_ID_PATTERN;

const NOT_ASSIGNABLE = { missing: 'no longer exists', 'not-a-cleaner': 'is a handyman, not a cleaner', inactive: 'is deactivated' } as const;

export const PATCH = adminRoute(async function PATCH(request: NextRequest, context: RouteContext, { actor }) {
  const crossSite = refuseCrossSite(request);
  if (crossSite) return crossSite;
  const wrongType = requireMediaType(request, 'application/json');
  if (wrongType) return wrongType;
  const { id } = await context.params;
  if (!JOB_ID.test(id)) return noStore(apiError('Invalid job ID', 400));
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return noStore(apiError('Invalid JSON body', 400));
  }
  const parsed = JobPatchSchema.safeParse(body);
  if (!parsed.success) return noStore(apiValidationError(parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))));

  // The price sent with Assign or Change cleaner (2026-11-06): none unless the admin changed it.
  const priceOf = (data: { price?: number | null; saveCleaningPrice: boolean }): JobPriceInput | undefined => (data.price === undefined && !data.saveCleaningPrice ? undefined : { cents: data.price ?? null, saveCleaningPrice: data.saveCleaningPrice });
  /** A cleaning price saved with it: that save's own line in the activity log, after this request's. */
  const recordPriceSaved = (job: { propertyId: string }, price: JobPriceOutcome | null) => {
    if (price?.cleaningPriceSaved) recordAlso(request, 'PUT', `/api/admin/properties/${job.propertyId}/cleaning-prices`, 200);
  };
  const priceRefusal = (kind: 'locked' | 'price-needed' | 'price-exists' | 'prices-unreadable', tier?: PresetKind) => noStore(apiFailure(kind === 'locked' ? JOB_AMOUNT_REFUSALS.locked : JOB_PRICE_REFUSALS[kind](tier ?? 'short')));

  if ('action' in parsed.data && parsed.data.action === 'swap') {
    const swapped = await swapCleaner(actor, id, parsed.data.from, parsed.data.to, parsed.data.seen, new Date(), priceOf(parsed.data));
    switch (swapped.kind) {
      case 'swapped':
        recordPriceSaved(swapped.job, swapped.price);
        return noStore(apiSuccess({ job: swapped.job, changed: true, from: swapped.from, to: swapped.to, price: swapped.price }));
      case 'locked':
        return priceRefusal('locked');
      case 'price-needed':
      case 'price-exists':
      case 'prices-unreadable':
        return priceRefusal(swapped.kind, swapped.tier);
      case 'marked':
        return noStore(apiFailure({ status: 409, code: 'JOB_ALREADY_MARKED', message: `${swapped.name ?? 'That cleaner'} has marked this job cleaned, so they stay on it.`, hint: 'Nothing was saved. Their cleaning is changed or removed in the Cleanings tab.' }));
      case 'already-on':
        return noStore(apiFailure({ status: 409, code: 'JOB_CLEANER_ALREADY_ON', message: `${swapped.name ?? 'That cleaner'} is on this job already.`, hint: 'Nothing was saved.' }));
      case 'not-assignable':
        return noStore(apiFailure({ status: 422, code: 'CLEANER_NOT_ASSIGNABLE', message: `${swapped.name ?? 'That team member'} ${NOT_ASSIGNABLE[swapped.why]}.`, hint: 'Nothing was saved. Only an active cleaner is put on a job.' }));
      default:
        return noStore(apiFailure(SWAP_REFUSALS[swapped.kind]));
    }
  }
  if ('action' in parsed.data && parsed.data.action === 'amount') {
    const set = await setJobAmount(actor, id, parsed.data.amount, parsed.data.seen);
    return set.kind === 'set' ? noStore(apiSuccess({ job: set.job, changed: set.changed, cleaningsChanged: set.cleaningsChanged })) : noStore(apiFailure(JOB_AMOUNT_REFUSALS[set.kind]));
  }

  const outcome = await setAssignees(actor, id, parsed.data.cleanerIds, parsed.data.seen, priceOf(parsed.data));
  switch (outcome.kind) {
    case 'saved':
      recordPriceSaved(outcome.job, outcome.price);
      return noStore(apiSuccess({ job: outcome.job, changed: outcome.changed, price: outcome.price }));
    case 'locked':
      return priceRefusal('locked');
    case 'price-needed':
    case 'price-exists':
    case 'prices-unreadable':
      return priceRefusal(outcome.kind, outcome.tier);
    case 'marked':
      return noStore(apiFailure({ status: 409, code: 'JOB_ALREADY_MARKED', message: `${outcome.name ?? 'That cleaner'} has marked this job cleaned, so they stay on it.`, hint: 'Nothing was saved. Their cleaning is changed or removed in the Cleanings tab.' }));
    case 'not-assignable':
      return noStore(apiFailure({ status: 422, code: 'CLEANER_NOT_ASSIGNABLE', message: `${outcome.name ?? 'That team member'} ${NOT_ASSIGNABLE[outcome.why]}.`, hint: 'Nothing was saved. Only an active cleaner is put on a job.' }));
    default:
      return noStore(apiFailure(ASSIGN_REFUSALS[outcome.kind]));
  }
});

export const DELETE = adminRoute(async function DELETE(request: NextRequest, context: RouteContext, { actor }) {
  const crossSite = refuseCrossSite(request);
  if (crossSite) return crossSite;
  const wrongType = requireMediaType(request, 'application/json');
  if (wrongType) return wrongType;
  const { id } = await context.params;
  if (!JOB_ID.test(id)) return noStore(apiError('Invalid job ID', 400));
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return noStore(apiError('Invalid JSON body', 400));
  }
  const parsed = DeleteJobSchema.safeParse(body);
  if (!parsed.success) return noStore(apiValidationError(parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))));
  const outcome = await deleteJob(actor, id, parsed.data.seen);
  switch (outcome.kind) {
    case 'deleted':
      return noStore(apiSuccess({ deleted: { id: outcome.id, cleanings: outcome.cleanings, marker: outcome.marker } }));
    case 'cleaning-paid':
      // The reason in one sentence (Build 2): the cleaning is counted in a recorded payment.
      return noStore(apiFailure({ status: 409, code: 'JOB_CLEANING_PAID', message: `${outcome.name ?? 'The cleaner'}’s cleaning of ${dayText(outcome.day)} is counted in ${paymentWords(outcome.payment)}, so this job can’t be deleted.`, hint: 'Nothing was deleted.', evidence: { payment: outcome.payment.id } }));
    case 'cleaning-printed':
      return noStore(apiFailure({ status: 409, code: 'JOB_CLEANING_PRINTED', message: `${outcome.name ?? 'The cleaner'}’s cleaning is printed on ${outcome.months.map((m) => (m ? `${monthLabel(m)}’s` : 'a')).join(' and ')} statement, so this job can’t be deleted.`, hint: 'Nothing was deleted.' }));
    default:
      return noStore(apiFailure(DELETE_JOB_REFUSALS[outcome.kind]));
  }
});
