/**
 * What the payment routes accept (Team pay, Kian's rulings of 2026-10-15). Server-only use, client-safe code: no
 * server imports. Amounts arrive as typed text, "300.00", and become cents by splitting the string, never through a
 * float.
 */

import { z } from 'zod';
import { PAYMENT_LIMITS, PAYMENT_METHODS } from './model';

const CONTROL_CHARACTER = /\p{Cc}/u;

/** "300.00": dollars and cents as typed, more than zero, at most $999,999.99. */
export const PaymentAmountSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,5})\.[0-9]{2}$/, 'Write the amount as dollars and cents, like 300.00')
  .transform((text) => {
    const [dollars, cents] = text.split('.');
    return Number(dollars) * 100 + Number(cents);
  })
  .refine((cents) => cents > 0 && cents <= PAYMENT_LIMITS.AMOUNT_MAX_CENTS, 'More than $0.00, at most $999,999.99');

/** Optional text: null or blank is none. */
const NoteSchema = z
  .string()
  .transform((s) => s.normalize('NFC').replace(/\s+/g, ' ').trim())
  .pipe(z.string().max(PAYMENT_LIMITS.NOTE_MAX, `At most ${PAYMENT_LIMITS.NOTE_MAX} characters`).refine((s) => !CONTROL_CHARACTER.test(s), 'No control characters'))
  .transform((s) => (s === '' ? null : s))
  .nullable();

export const RecordPaymentSchema = z.strictObject({
  memberId: z.string().regex(/^[A-Za-z0-9]{1,64}$/, 'Not an ID'),
  amount: PaymentAmountSchema,
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Write the day as yyyy-mm-dd'),
  method: z.enum(PAYMENT_METHODS),
  note: NoteSchema.optional().default(null),
});

export const DeletePaymentSchema = z.strictObject({
  seen: z.number().int().min(0).max(1_000_000),
});
