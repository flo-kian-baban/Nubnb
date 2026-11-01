/**
 * What the cleaning routes accept (dispatch 37B). Server-only use, client-safe code: no server imports.
 * Amounts arrive as typed text, "65.00", and become cents here; nothing is ever worked out from a rate.
 */

import { z } from 'zod';
import { CLEANING_LIMITS } from './model';

const CONTROL_CHARACTER = /\p{Cc}/u;

/** "65.00": dollars and cents as typed, more than zero, at most $9,999.99. */
export const AmountSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,3})\.[0-9]{2}$/, 'Write the amount as dollars and cents, like 75.00')
  .transform((text) => Math.round(Number(text) * 100))
  .refine((cents) => cents > 0 && cents <= CLEANING_LIMITS.AMOUNT_MAX_CENTS, 'More than $0.00, at most $9,999.99');

/** Optional text: null or blank is none; the page sends null for an empty field. */
const text = (max: number) =>
  z
    .string()
    .transform((s) => s.normalize('NFC').replace(/\s+/g, ' ').trim())
    .pipe(z.string().max(max, `At most ${max} characters`).refine((s) => !CONTROL_CHARACTER.test(s), 'No control characters'))
    .transform((s) => (s === '' ? null : s))
    .nullable();

const DaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Write the day as yyyy-mm-dd');
const IdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'Not an ID');

export const LogCleaningSchema = z.strictObject({
  propertyId: IdSchema,
  cleanerId: IdSchema,
  day: DaySchema,
  amount: AmountSchema,
  note: text(CLEANING_LIMITS.NOTE_MAX).optional().default(null),
});

export const ChangeCleaningSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('change'),
    seen: z.number().int().min(0).max(1_000_000),
    day: DaySchema.optional(),
    amount: AmountSchema.optional(),
    cleanerId: IdSchema.optional(),
    note: text(CLEANING_LIMITS.NOTE_MAX).optional(),
    reason: text(CLEANING_LIMITS.REASON_MAX).optional().default(null),
  }),
  z.strictObject({
    action: z.literal('remove'),
    seen: z.number().int().min(0).max(1_000_000),
    reason: text(CLEANING_LIMITS.REASON_MAX).optional().default(null),
  }),
  // The extra a cleaner asked for (Kian's ruling F of 2026-11-01): approved, at a new amount or not, or declined.
  z.strictObject({
    action: z.literal('extra'),
    seen: z.number().int().min(0).max(1_000_000),
    decision: z.enum(['approve', 'decline']),
    amount: AmountSchema.optional(),
    reason: text(CLEANING_LIMITS.REASON_MAX).optional().default(null),
  }),
]);

// ─── The cleaning flow (Kian's rulings of 2026-11-01) ───

const TierSchema = z.enum(['short', 'mid', 'long']);
const SeenSchema = z.number().int().min(0).max(1_000_000);
/** A job's ID: a property's auto ID and its checkout day. */
export const JobIdSchema = z.string().regex(/^[A-Za-z0-9]{1,64}_\d{4}-\d{2}-\d{2}$/, 'Not a job ID');

/** POST /api/cleaner/jobs/[id]: Mark cleaned with the cleaner's optional note and "Ask for extra" (its reason required when asked), or Undo. */
export const JobActionSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('mark'),
    note: text(CLEANING_LIMITS.NOTE_MAX).optional().default(null),
    extraReason: text(CLEANING_LIMITS.REASON_MAX).optional().default(null),
  }),
  z.strictObject({ action: z.literal('undo') }),
]);

/** POST /api/admin/cleaning-jobs (ruling C): a job by hand. */
export const AddJobSchema = z.strictObject({
  propertyId: IdSchema,
  checkout: DaySchema,
  cleanerId: IdSchema.nullable(),
  tier: TierSchema,
  amount: AmountSchema.nullable().optional().default(null),
});

/** PATCH /api/admin/cleaning-jobs/[id]: who is on it (as before), a one-step swap (ruling D), or the job's own amount (ruling B). */
export const JobPatchSchema = z.union([
  z.strictObject({ cleanerIds: z.array(IdSchema).max(10, 'At most 10 cleaners on one job'), seen: SeenSchema }),
  z.strictObject({ action: z.literal('swap'), from: IdSchema, to: IdSchema, seen: SeenSchema }),
  z.strictObject({ action: z.literal('amount'), amount: AmountSchema.nullable(), seen: SeenSchema }),
]);

/** POST /api/admin/cleaning-jobs/[id]/record (ruling E): the cleaners to record it cleaned for. */
export const RecordJobSchema = z.strictObject({
  cleanerIds: z.array(IdSchema).min(1, 'Name a cleaner').max(10),
  seen: SeenSchema,
});

export const DeleteCleaningSchema = z.strictObject({
  seen: z.number().int().min(0).max(1_000_000),
});

/** The account's default rate (Kian's ruling of 2026-10-13; retired by the ruling of 2026-10-19: presets per property), or null to have none. The route stays, unused. */
export const DefaultRateSchema = z.strictObject({
  defaultRate: AmountSchema.nullable(),
});

// ─── Cleaning prices per property (Kian's ruling of 2026-10-19) ───

/** A preset as typed, "75.00", or null for none. */
const PriceSchema = AmountSchema.nullable();

/** PUT /api/admin/properties/[id]/cleaning-prices: the three presets (Kian's ruling A of 2026-11-01), each "75.00" or null. */
export const CleaningPricesSchema = z.strictObject({
  shortTerm: PriceSchema,
  midTerm: PriceSchema,
  longTerm: PriceSchema,
});

/** POST /api/admin/cleaning-prices (the sheet's import): the matched rows, each a property and its two presets. */
export const ImportCleaningPricesSchema = z.strictObject({
  rows: z
    .array(
      z.strictObject({
        propertyId: IdSchema,
        shortTerm: PriceSchema,
        midTerm: PriceSchema,
        longTerm: PriceSchema,
      }),
    )
    .min(1, 'No rows to save')
    .max(500, 'At most 500 rows at once'),
});

/** GET /api/admin/cleanings/suggest: the property and the day a cleaning is being logged for. */
export const SuggestQuerySchema = z.strictObject({
  propertyId: IdSchema,
  day: DaySchema,
});
