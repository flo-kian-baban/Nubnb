/**
 * Request bodies of the main admin's routes (dispatch 38). Strict: a body
 * carrying anything else is refused, not trimmed. Bodies hold PINs, so the
 * routes never log or echo them.
 */

import { z } from 'zod';
import { ADMIN_LEVELS, adminNameProblem, cleanAdminName, newPinProblem } from './model';

const pin = z.string().max(20).superRefine((value, ctx) => {
  const problem = newPinProblem(value);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
});

export const NewAdminSchema = z.strictObject({
  name: z
    .string()
    .max(500)
    .superRefine((value, ctx) => {
      const problem = adminNameProblem(value);
      if (problem) ctx.addIssue({ code: 'custom', message: problem });
    })
    .transform(cleanAdminName),
  level: z.enum(ADMIN_LEVELS),
  /** The temporary PIN the main admin typed, or filled with Generate: six digits. */
  pin,
});

export const SetLevelSchema = z.strictObject({ level: z.enum(ADMIN_LEVELS) });

export const NewPinSchema = z.strictObject({ pin });
