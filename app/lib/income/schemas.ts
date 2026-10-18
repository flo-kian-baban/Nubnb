/**
 * What the income routes accept (dispatch 27; dispatch 37C), in one place so the bodies the pages send are tested as
 * they are. Server-only use, client-safe code: no server imports. Amounts arrive as typed text, "1205.90" or
 * "-397.40", and become cents here; nothing is worked out from a nightly price.
 */

import { z } from 'zod';
import { STATEMENT_LIMITS, isMonth } from '@/app/lib/reports/model';
import { INCOME_CHANNELS, INCOME_LIMITS, NOT_NUBNB, normaliseTitle } from './model';

const CONTROL_CHARACTER = /\p{Cc}/u;
const LINE_ID = /^[0-9a-f]{64}$/;
/** A Firestore auto-ID or a Nubnb property ID: letters and digits, 1–64. */
const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** The statement's own form for an amount: "60.00" or "-60.00", at most $999,999.99. */
const SIGNED_AMOUNT = /^-?(0|[1-9][0-9]{0,5})\.[0-9]{2}$/;

/** "-397.40" → -39740. */
export function amountCents(text: string): number {
  const negative = text.startsWith('-');
  const [whole, fraction] = (negative ? text.slice(1) : text).split('.');
  const cents = Number(whole + fraction);
  return negative && cents !== 0 ? -cents : cents;
}

/** The description as it will be stored on the statement line: NFC, spaces collapsed, 1–160 characters, no control characters. Null when it cannot be. */
export function cleanDescription(text: string): string | null {
  const description = text.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (description === '' || description.length > STATEMENT_LIMITS.LINE_DESCRIPTION_MAX || CONTROL_CHARACTER.test(description)) return null;
  return description;
}

const LineId = z.string().regex(LINE_ID, 'Not a line ID');
const Description = z.string().transform((s, ctx) => {
  const clean = cleanDescription(s);
  if (clean === null) ctx.addIssue({ code: 'custom', message: `1 to ${STATEMENT_LIMITS.LINE_DESCRIPTION_MAX} characters, no control characters` });
  return clean ?? '';
});
const Amount = z
  .string()
  .regex(SIGNED_AMOUNT, 'An amount with two decimals, like 1205.90 or -397.40')
  .transform(amountCents)
  .pipe(z.number().refine((cents) => cents !== 0, 'An amount is never $0.00'));
const Title = z
  .string()
  .transform(normaliseTitle)
  .pipe(z.string().min(1, 'A title').max(INCOME_LIMITS.TITLE_MAX, `At most ${INCOME_LIMITS.TITLE_MAX} characters`).refine((s) => !CONTROL_CHARACTER.test(s), 'No control characters'));
/** A link's state as the page showed it: the property's ID, "not-nubnb" for a title set aside, null for none. */
const Expected = z
  .string()
  .refine((id) => id === NOT_NUBNB || DOCUMENT_ID.test(id), 'Not a property ID')
  .nullable();

/** POST /api/admin/income/lines/accept */
export const AcceptInputSchema = z.strictObject({
  propertyId: z.string().regex(DOCUMENT_ID, 'Not a property ID'),
  month: z.string().refine(isMonth, 'A month, like 2026-09'),
  lines: z
    .array(z.strictObject({ id: LineId, description: Description.optional(), amount: Amount.optional() }))
    .min(1, 'At least one line')
    .max(INCOME_LIMITS.LINES_PER_UPLOAD_MAX)
    .refine((lines) => new Set(lines.map((line) => line.id)).size === lines.length, 'A line is listed twice'),
});

/** PATCH /api/admin/income/lines/[id] */
export const LineInputSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('reject') }),
  z.strictObject({ action: z.literal('propose-again') }),
  z
    .strictObject({ action: z.literal('edit'), seen: z.number().int().min(0).max(100_000), description: Description.optional(), amount: Amount.optional() })
    .refine((input) => input.description !== undefined || input.amount !== undefined, { message: 'The words, the amount, or both', path: ['description'] }),
]);

/** POST /api/admin/income/lines/reject */
export const RejectInputSchema = z.strictObject({
  ids: z
    .array(LineId)
    .min(1, 'At least one line')
    .max(INCOME_LIMITS.LINES_PER_UPLOAD_MAX)
    .refine((ids) => new Set(ids).size === ids.length, 'A line is listed twice'),
});

/** PUT /api/admin/income/links */
export const LinkInputSchema = z
  .strictObject({
    channel: z.enum(INCOME_CHANNELS),
    title: Title,
    /** The property to make it the active title of; absent when the title is set aside. */
    propertyId: z.string().regex(DOCUMENT_ID, 'Not a property ID').optional(),
    /** Set the title aside as not a Nubnb property (dispatch 36). */
    notNubnb: z.literal(true).optional(),
    expected: Expected,
  })
  .refine((input) => (input.propertyId !== undefined) !== (input.notNubnb === true), { message: 'Either a property to link it to, or notNubnb', path: ['propertyId'] });

/** PUT /api/admin/properties/[id]/airbnb-title */
export const TitleInputSchema = z.strictObject({ title: Title, expected: Expected });

/** POST /api/admin/income/lines/accept-month (Kian's ruling K1 of 2026-10-17): the month's routine lines, by property, and what the confirmation named. */
export const AcceptMonthInputSchema = z.strictObject({
  month: z.string().refine(isMonth, 'A month, like 2026-09'),
  groups: z
    .array(
      z.strictObject({
        propertyId: z.string().regex(DOCUMENT_ID, 'Not a property ID'),
        ids: z.array(LineId).min(1, 'At least one line').max(INCOME_LIMITS.LINES_PER_UPLOAD_MAX),
      }),
    )
    .min(1, 'At least one property')
    .refine((groups) => new Set(groups.map((group) => group.propertyId)).size === groups.length, 'A property is listed twice')
    .refine((groups) => groups.reduce((n, group) => n + group.ids.length, 0) <= INCOME_LIMITS.LINES_PER_UPLOAD_MAX, `At most ${INCOME_LIMITS.LINES_PER_UPLOAD_MAX} lines in one confirmation`)
    .refine((groups) => {
      const ids = groups.flatMap((group) => group.ids);
      return new Set(ids).size === ids.length;
    }, 'A line is listed twice'),
  expected: z.strictObject({
    lines: z.number().int().min(1).max(INCOME_LIMITS.LINES_PER_UPLOAD_MAX),
    properties: z.number().int().min(1).max(INCOME_LIMITS.LINES_PER_UPLOAD_MAX),
    amountCents: z.number().int().refine(Number.isSafeInteger, 'An amount in cents'),
  }),
});

/** PUT /api/admin/properties/[id]/income-source (Kian's ruling K2 of 2026-10-17): marked or not, as the page saw it. */
export const IncomeSourceInputSchema = z.strictObject({ notThroughFiles: z.boolean(), expected: z.boolean() });
