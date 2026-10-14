/**
 * Request bodies of the admin account routes (dispatch 38). Strict: a body
 * carrying anything else is refused, not trimmed. Since Kian's rulings of
 * 2026-10-13 (night) the main admin sets each admin's PIN, and an admin can
 * change their own: those bodies carry a PIN, which is never logged or echoed.
 * A PIN must be four digits and not too easy (model.ts, pinProblem); whether
 * another admin holds it, or it is the shared PIN, is the route's to say.
 */

import { z } from 'zod';
import { ADMIN_LEVELS, adminNameProblem, cleanAdminName, pinProblem } from './model';

const name = z
  .string()
  .max(500)
  .superRefine((value, ctx) => {
    const problem = adminNameProblem(value);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  })
  .transform(cleanAdminName);

const pin = z
  .string()
  .max(20)
  .superRefine((value, ctx) => {
    const problem = pinProblem(value);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  });

/** Adding an admin: their name, level and PIN, all set by the main admin. */
export const NewAdminSchema = z.strictObject({
  name,
  level: z.enum(ADMIN_LEVELS),
  pin,
});

export const SetLevelSchema = z.strictObject({ level: z.enum(ADMIN_LEVELS) });

/** Setting an ordinary admin's PIN, from the main admin's Admins page. */
export const SetPinSchema = z.strictObject({ pin });

/** Change name, from an admin's own menu. */
export const ChangeNameSchema = z.strictObject({ name });

/** Change PIN, from an admin's own menu or the gate's Set your PIN: the current PIN first, then the new one. */
export const ChangePinSchema = z.strictObject({ currentPin: z.string().max(20), newPin: pin });
