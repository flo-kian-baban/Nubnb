/**
 * GET  /api/admin/cleaners — Every cleaner and handyman, newest first, with their codes (admin-only).
 * POST /api/admin/cleaners — Create a cleaner or a handyman with their code (admin-only).
 *
 * The body is `{ name, role?, code? }`. `role` (dispatch 24) is `cleaner` or
 * `handyman`, and `cleaner` when absent, for the callers that predate it.
 * Both roles come from the one code index, so a code is unique across both.
 * `code` (dispatch 23H) is the four digits the admin typed — the Team page
 * always sends one, which its "Generate" may have filled in; when absent, the
 * server draws one, as before. A typed code is refused, with nothing
 * written, exactly as on a code change:
 *   422 CLEANER_CODE_IS_ADMIN_PIN  the admin PIN
 *   422 CLEANER_CODE_TOO_EASY      on the reserved list (1111, 1234, 9876 …)
 *   409 CLEANER_CODE_TAKEN         an active account's code now (any other
 *                                  code is free: Kian's ruling of 2026-10-02)
 *
 * A cleaner signs in at their own door, /api/cleaner, with a four-digit code;
 * this is where the admin makes one. By Kian's ruling of 2026-09-28 codes are
 * stored readably and an admin can see them at any time: every list row
 * carries the cleaner's current code, and the POST's 201 carries the new
 * cleaner with theirs, and `released`: the deactivated account that held the
 * typed code and now has none, or null. A row never carries the session epoch.
 *
 * The POST is one of the few readers of ADMIN_PIN besides the admin session
 * module. It hands the PIN to issueCleaner, which never issues it as a code —
 * codes and the PIN are both four digits, so a cleaner whose code were the
 * PIN would open /admin. The PIN is only compared, and never logged.
 *
 * Order, for the POST: the admin session, then the cross-site and media-type
 * refusals, then the JSON, then the schema, then the work. Every response is
 * no-store, the refusals included.
 *
 * Only admin pages call this. No public page does, so it adds no function
 * call to a renter's page view.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { verifyAdminSession } from '@/app/lib/api/verify-admin';
import {
  apiSuccess,
  apiError,
  apiFailure,
  apiValidationError,
  noStore,
} from '@/app/lib/api/safe-response';
import { CLEANER_ROLES, CODE_PATTERN, LIMITS, type Refusal } from '@/app/lib/cleaners/model';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import {
  issueCleaner,
  listCleaners,
  type IssueCleanerResult,
} from '@/app/lib/firebase/server-cleaners';

const CONTROL_CHARACTER = /\p{Cc}/u;

const CODE_MESSAGE = 'A code is four digits, like 0429';

/**
 * Strict: a body that carries anything besides `name`, `role` and `code` is
 * refused, not trimmed. The name is stored as validated here — NFC, trimmed,
 * 1–80 characters, no control characters. Duplicates are allowed.
 */
const NewCleanerSchema = z.strictObject({
  name: z
    .string()
    .transform((s) => s.normalize('NFC').trim())
    .pipe(
      z
        .string()
        .min(1, 'Name the cleaner')
        .max(LIMITS.NAME_MAX, `At most ${LIMITS.NAME_MAX} characters`)
        .refine((s) => !CONTROL_CHARACTER.test(s), 'No control characters'),
    ),
  /** `cleaner` when absent (dispatch 24). */
  role: z.enum(CLEANER_ROLES).optional().transform((value) => value ?? 'cleaner'),
  /** The four digits the admin typed (dispatch 23H); absent, the server draws a code. */
  code: z.string().regex(CODE_PATTERN, CODE_MESSAGE).optional().transform((value) => value ?? null),
});

/**
 * What the POST answers for every outcome but `created`. None of them wrote
 * anything, except `unconfirmed`, which cannot say whether the batch landed
 * and is never retried.
 */
const ISSUE_REFUSALS: Record<Exclude<IssueCleanerResult['kind'], 'created' | 'not-a-code' | 'reserved' | 'taken'>, Refusal> = {
  'admin-pin-missing': {
    status: 503,
    code: 'ADMIN_PIN_NOT_CONFIGURED',
    message: 'The admin PIN is not set on this server.',
    hint: 'Nothing was created. Codes are kept clear of the admin PIN, so none can be issued without it.',
  },
  unavailable: {
    status: 503,
    code: 'CLEANERS_UNAVAILABLE',
    message: 'Could not reach the cleaner records.',
    hint: 'Nothing was created. Try again.',
  },
  exhausted: {
    status: 409,
    code: 'CLEANER_CODE_UNAVAILABLE',
    message: 'No unused code could be issued. Nothing was created. Try again.',
  },
  unconfirmed: {
    status: 502,
    code: 'CLEANER_CREATE_UNCONFIRMED',
    message: 'Could not confirm that the cleaner was created.',
    hint: 'It may have been created. Reload the list: if the name appears, their code is in their row.',
  },
};

/** A typed code refused: the refusals of a code change, saying nothing was created. */
const ADMIN_PIN_REFUSAL: Refusal = {
  status: 422,
  code: 'CLEANER_CODE_IS_ADMIN_PIN',
  message: 'That is the admin PIN.',
  hint: 'A code can never be the admin PIN: whoever holds it would open /admin with it. Nothing was created.',
};

const TOO_EASY_REFUSAL: Refusal = {
  status: 422,
  code: 'CLEANER_CODE_TOO_EASY',
  message: 'That code is too easy to guess.',
  hint: 'Four of the same digit and runs like 1234 or 9876 are never used. Nothing was created.',
};

function takenRefusal(holder: string | null): Refusal {
  return {
    status: 409,
    code: 'CLEANER_CODE_TAKEN',
    message: holder ? `That code is ${holder}’s.` : 'That code belongs to someone else on the team.',
    hint: 'Change their code or delete them to reuse it, or choose another. Nothing was created.',
  };
}

/**
 * The one thing logged about a failed read: its gRPC code, as on every other
 * cleaner path. The error's message is not logged.
 */
function grpcCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? String(code) : 'unknown';
}

export async function GET(request: NextRequest) {
  // ── Auth ──
  const auth = verifyAdminSession(request);
  if (!auth.valid) return noStore(apiError(auth.error!, auth.status!));

  try {
    return noStore(apiSuccess(await listCleaners()));
  } catch (err) {
    // A read that failed is not an empty list. The 500 is what lets the page
    // say "could not load" instead of "no cleaners yet".
    console.error(`[cleaners] list failed: grpc code ${grpcCode(err)}`);
    return noStore(
      apiFailure({
        message: 'Failed to load cleaners',
        status: 500,
        code: 'CLEANERS_READ_FAILED',
      }),
    );
  }
}

export async function POST(request: NextRequest) {
  // ── Auth ──
  const auth = verifyAdminSession(request);
  if (!auth.valid) return noStore(apiError(auth.error!, auth.status!));

  // ── Cross-site and media type ──
  const crossSite = refuseCrossSite(request);
  if (crossSite) return crossSite;
  const wrongType = requireMediaType(request, 'application/json');
  if (wrongType) return wrongType;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return noStore(apiError('Invalid JSON body', 400));
  }

  // ── Validate ──
  const result = NewCleanerSchema.safeParse(body);
  if (!result.success) {
    return noStore(
      apiValidationError(
        result.error.issues.map((i) => ({
          path: i.path.map(String).join('.'),
          message: i.message,
        })),
      ),
    );
  }

  // ── Issue ──
  // Read inside the handler, never at module scope, and passed on unlogged.
  // The body may hold a code, so it is never logged.
  const outcome = await issueCleaner(result.data.name, result.data.role, process.env.ADMIN_PIN, result.data.code);
  switch (outcome.kind) {
    case 'created':
      // The new cleaner, their code included. Nothing logs it.
      return noStore(apiSuccess({ cleaner: outcome.cleaner, released: outcome.released }, 201));
    case 'not-a-code':
      return noStore(apiValidationError([{ path: 'code', message: CODE_MESSAGE }]));
    case 'reserved':
      return noStore(apiFailure(outcome.reason === 'admin-pin' ? ADMIN_PIN_REFUSAL : TOO_EASY_REFUSAL));
    case 'taken':
      return noStore(apiFailure(takenRefusal(outcome.holder)));
    default:
      return noStore(apiFailure(ISSUE_REFUSALS[outcome.kind]));
  }
}
