/**
 * What the direct-payment routes accept (part B of PROPERTY-LIST-COLUMNS-PLAN.md, Kian's rulings of 2026-10-15).
 * Server-only use, client-safe code: no server imports. Amounts arrive as typed text, "1200.00", and become cents by
 * splitting the string, never through a float (team pay's way).
 */

import { z } from 'zod';
import { PaymentAmountSchema } from '@/app/lib/pay/schemas';
import { DIRECT_LIMITS, DIRECT_METHODS, DIRECT_PAYMENT_ID, ONE_OFF_PURPOSES } from './model';

const CONTROL_CHARACTER = /\p{Cc}/u;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Text as typed: spaces collapsed, NFC, no control characters, 1 to `max` characters. */
const words = (max: number, empty: string) =>
  z
    .string()
    .transform((s) => s.normalize('NFC').replace(/\s+/g, ' ').trim())
    .pipe(z.string().min(1, empty).max(max, `At most ${max} characters`).refine((s) => !CONTROL_CHARACTER.test(s), 'No control characters'));

/** Optional text: null or blank is none. */
const optional = (max: number) =>
  z
    .string()
    .transform((s) => s.normalize('NFC').replace(/\s+/g, ' ').trim())
    .pipe(z.string().max(max, `At most ${max} characters`).refine((s) => !CONTROL_CHARACTER.test(s), 'No control characters'))
    .transform((s) => (s === '' ? null : s))
    .nullable();

const Month = z.string().regex(MONTH, 'Write the month as yyyy-mm');
const Seen = z.number().int().min(0).max(1_000_000);
const PropertyId = z.string().regex(/^[A-Za-z0-9]{1,64}$/, 'Not a property ID');
const ArrangementId = z.string().regex(/^[A-Za-z0-9]{1,64}$/, 'Not an arrangement ID');

/** The months a payment pays, as the admin sets them: each a month and its part, together the whole amount. */
const AppliesTo = z
  .array(z.strictObject({ month: Month, amount: PaymentAmountSchema }))
  .min(1)
  .max(24)
  .transform((parts) => parts.map((p) => ({ month: p.month, cents: p.amount })))
  .refine((parts) => new Set(parts.map((p) => p.month)).size === parts.length, 'Each month once')
  .nullable();

export const StartArrangementSchema = z.strictObject({
  propertyId: PropertyId,
  payerName: words(DIRECT_LIMITS.PAYER_MAX, 'Who pays: a name'),
  wording: words(DIRECT_LIMITS.WORDING_MAX, 'What the statement prints, like Monthly stay'),
  amount: PaymentAmountSchema,
  dueDay: z.number().int().min(1, 'A day from 1 to 28').max(DIRECT_LIMITS.DUE_DAY_MAX, 'A day from 1 to 28'),
  fromMonth: Month,
});

export const ChangeArrangementSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('pause'), seen: Seen, month: Month }),
  z.strictObject({ action: z.literal('resume'), seen: Seen, month: Month }),
  z.strictObject({ action: z.literal('amount'), seen: Seen, month: Month, amount: PaymentAmountSchema }),
  z.strictObject({ action: z.literal('end'), seen: Seen, month: Month }),
]);

export const RecordDirectPaymentSchema = z
  .strictObject({
    propertyId: PropertyId,
    /** The arrangement it pays; null for a one-off payment. */
    arrangementId: ArrangementId.nullable(),
    /** A one-off payment's: a stay of 30 nights or more, or not a stay. Never a short stay (Kian's rulings). */
    purpose: z.enum(ONE_OFF_PURPOSES).nullable(),
    /** A one-off stay's first night and checkout day; the server refuses one under 30 nights. Absent or null otherwise. */
    stay: z.strictObject({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Write the day as yyyy-mm-dd'), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Write the day as yyyy-mm-dd') }).nullable().optional().default(null),
    payerName: optional(DIRECT_LIMITS.PAYER_MAX).optional().default(null),
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Write the day as yyyy-mm-dd'),
    amount: PaymentAmountSchema,
    method: z.enum(DIRECT_METHODS),
    wording: words(DIRECT_LIMITS.WORDING_MAX, 'What the statement prints, like Monthly stay'),
    note: optional(DIRECT_LIMITS.NOTE_MAX).optional().default(null),
    appliesTo: AppliesTo.optional().default(null),
  })
  .superRefine((body, ctx) => {
    if (body.arrangementId === null && body.purpose === null) ctx.addIssue({ code: 'custom', path: ['purpose'], message: 'Say what a one-off payment is for' });
    if (body.arrangementId !== null && body.purpose !== null) ctx.addIssue({ code: 'custom', path: ['purpose'], message: 'An arrangement payment is a monthly stay' });
    if (body.arrangementId === null && body.appliesTo !== null) ctx.addIssue({ code: 'custom', path: ['appliesTo'], message: 'A one-off payment pays no months' });
    if (body.purpose === 'long-stay' && body.stay === null) ctx.addIssue({ code: 'custom', path: ['stay'], message: 'Give the stay its first night and its checkout day' });
    if (body.purpose !== 'long-stay' && body.stay !== null) ctx.addIssue({ code: 'custom', path: ['stay'], message: 'Only a stay payment has a stay' });
    if (body.appliesTo !== null && body.appliesTo.reduce((sum, p) => sum + p.cents, 0) !== body.amount) ctx.addIssue({ code: 'custom', path: ['appliesTo'], message: 'The months add up to the whole amount' });
  });

export const ChangeDirectPaymentSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('remove'), seen: Seen }),
  z.strictObject({ action: z.literal('apply'), seen: Seen, appliesTo: AppliesTo }),
]);

export const isDirectPaymentId = (id: unknown): id is string => typeof id === 'string' && DIRECT_PAYMENT_ID.test(id);
