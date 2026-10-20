/**
 * GET  /api/admin/cleaners — Every cleaner and handyman, newest first, with their codes (admin-only).
 * POST /api/admin/cleaners — Create a cleaner or a handyman with their code (admin-only).
 *
 * The body is `{ name, role?, code? }`. `role` (dispatch 24) is `cleaner` or
 * `handyman`, and `cleaner` when absent, for the callers that predate it.
 * Both roles come from the one code index, so a code is unique across both.
 * `code` (dispatch 23H) is the four digits the admin typed — the Team page
 * always sends one, which its "Generate" may have filled in; when absent, the
 * server draws one, as before. An easy code (four of one digit, a straight run) is accepted
 * (Kian's ruling of 2026-10-17). A typed code is refused, with nothing
 * written, exactly as on a code change, each refusal in one plain line that
 * says why (Kian's ruling of 2026-10-17):
 *   422 CLEANER_CODE_IS_ADMIN_PIN  an admin PIN: the shared one, or any
 *                                  admin's (Kian's rulings of 2026-10-13,
 *                                  late night)
 *   422 CLEANER_CODE_PUBLIC        a code that appeared in Nubnb's public code
 *                                  (security rule, 2026-10-19; never drawn
 *                                  either)
 *   409 CLEANER_CODE_TAKEN         an active account's code now (any other
 *                                  code is free: Kian's ruling of 2026-10-02)
 *   429 ADMIN_SIGN_IN_LOCKED       an ordinary admin's connection is locked
 * An ordinary admin's typed code is a try on their connection's sign-in lock,
 * whatever the answer, since a refusal could tell them an admin's PIN; a main
 * admin's is not counted. A drawn code is never an admin's PIN either.
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
 * PIN would open /admin — nor any admin's PIN, read from `admin_pins` in the
 * same transaction. The PIN is only compared, and never logged.
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
import { adminRoute } from '@/app/lib/api/verify-admin';
import {
  apiSuccess,
  apiError,
  apiFailure,
  apiValidationError,
  noStore,
} from '@/app/lib/api/safe-response';
import { CLEANER_ROLES, CODE_PATTERN, LIMITS, type Refusal } from '@/app/lib/cleaners/model';
import { PUBLIC_CODE_REFUSAL_LINE } from '@/app/lib/cleaners/codes';
import { connectionOf } from '@/app/lib/admins/connection';
import { lockedResponse } from '@/app/lib/admins/responses';
import { ADMIN_AUTH_NOT_CONFIGURED, getAdminPinKey } from '@/app/lib/admins/secrets';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import {
  issueCleaner,
  listCleaners,
  type CodeTyper,
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
const ISSUE_REFUSALS: Record<Exclude<IssueCleanerResult['kind'], 'created' | 'not-a-code' | 'reserved' | 'taken' | 'admin-pin' | 'locked' | 'not-configured' | 'denylist-unkeyed'>, Refusal> = {
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
    message: 'Every code drawn was already in use: try again.',
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
  message: 'That is an admin PIN, and a code can never be one.',
};

/** A code that appeared in Nubnb's public code (security rule, 2026-10-19; codes.ts): never given out, in one plain line. */
const PUBLIC_CODE_REFUSAL: Refusal = {
  status: 422,
  code: 'CLEANER_CODE_PUBLIC',
  message: PUBLIC_CODE_REFUSAL_LINE,
};

/** The denylist is set but cannot be checked: issuance fails closed. */
const DENYLIST_UNKEYED: Refusal = {
  status: 503,
  code: 'CLEANER_CODE_DENYLIST_UNKEYED',
  message: 'The list of codes never given out cannot be checked on this server.',
  hint: 'CLEANER_CODE_DENYLIST is set but CLEANER_SESSION_SECRET is not. Nothing was changed.',
};

function takenRefusal(holder: string | null): Refusal {
  return {
    status: 409,
    code: 'CLEANER_CODE_TAKEN',
    message: holder ? `${holder} already has that code.` : 'Someone else on the team already has that code.',
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

export const GET = adminRoute(async function GET() {
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
});

export const POST = adminRoute(async function POST(request: NextRequest, _context: unknown, { admin, actor }) {
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
  // An ordinary admin's typed code is a try on their connection (Kian's rulings of 2026-10-13, late night), which needs
  // the connection's keyed hash; a main admin's is not counted: they see every admin's PIN already.
  const pinKey = getAdminPinKey();
  const typer: CodeTyper | null = result.data.code === null ? null : admin.level === 'main' ? { counted: false } : pinKey ? { counted: true, connection: connectionOf(request, pinKey) } : null;
  if (result.data.code !== null && typer === null) return noStore(apiFailure(ADMIN_AUTH_NOT_CONFIGURED));
  const outcome = await issueCleaner(actor, result.data.name, result.data.role, process.env.ADMIN_PIN, result.data.code, typer);
  switch (outcome.kind) {
    case 'created':
      // The new cleaner, their code included. Nothing logs it.
      return noStore(apiSuccess({ cleaner: outcome.cleaner, released: outcome.released, ...(outcome.lockedUntil !== undefined ? { lockedUntil: outcome.lockedUntil } : {}) }, 201));
    case 'not-a-code':
      return noStore(apiValidationError([{ path: 'code', message: CODE_MESSAGE }]));
    case 'reserved':
      return noStore(apiFailure(outcome.reason === 'public-history' ? PUBLIC_CODE_REFUSAL : ADMIN_PIN_REFUSAL));
    case 'denylist-unkeyed':
      return noStore(apiFailure(DENYLIST_UNKEYED));
    case 'admin-pin':
      return noStore(apiFailure(ADMIN_PIN_REFUSAL));
    case 'locked':
      return lockedResponse(outcome.lockedUntil, outcome.now);
    case 'not-configured':
      return noStore(apiFailure(ADMIN_AUTH_NOT_CONFIGURED));
    case 'taken':
      return noStore(apiFailure(takenRefusal(outcome.holder)));
    default:
      return noStore(apiFailure(ISSUE_REFUSALS[outcome.kind]));
  }
});
