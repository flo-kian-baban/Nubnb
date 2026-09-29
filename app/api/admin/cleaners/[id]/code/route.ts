/**
 * POST /api/admin/cleaners/[id]/code — Give a cleaner a new code (admin-only).
 *
 * Accepts exactly one of:
 *   { code: "5831" }    the four digits the admin typed
 *   { generate: true }  a code drawn by the server, like an issued one
 * and answers 200 `{ cleaner, changed }` with the cleaner as now stored, new
 * code included.
 *
 * Refused, with nothing written:
 *   422 CLEANER_CODE_IS_ADMIN_PIN  the admin PIN is never a cleaner's code:
 *                                  both are four digits, so the cleaner
 *                                  would open /admin with it
 *   422 CLEANER_CODE_TOO_EASY      on the reserved list (1111, 1234, 9876 …)
 *   409 CLEANER_CODE_TAKEN         another cleaner's code, or anyone's before:
 *                                  a replaced code is never given out again
 *   409 CLEANER_CODE_UNAVAILABLE   generate only: no free code was drawn
 * Typing the code the cleaner already has writes nothing: `changed: false`.
 *
 * A change is one transaction (setCleanerCode): the new code's document is
 * created, the old one is marked retired and kept, and the cleaner points at
 * the new code. The old code stops working at once, and a phone signed in
 * with it is signed out on its next request. The cleaner keeps their ID,
 * name and status, and every entry keeps its attribution.
 *
 * Like the create route, this reads ADMIN_PIN to keep codes clear of it; the
 * PIN is only compared, and never logged. Order: the admin session, then the
 * cross-site and media-type refusals, then the ID, the JSON and the schema,
 * then the work. Every response is no-store, the refusals included.
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
import { CODE_PATTERN, type Refusal } from '@/app/lib/cleaners/model';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { setCleanerCode, type SetCleanerCodeResult } from '@/app/lib/firebase/server-cleaners';
import { isDocumentId } from '@/app/lib/firebase/server-leads';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const CODE_MESSAGE = 'A code is four digits, like 0429';

/** Strict: exactly one of the two shapes, and nothing else. */
const NewCodeSchema = z.union([
  z.strictObject({ code: z.string().regex(CODE_PATTERN, CODE_MESSAGE) }),
  z.strictObject({ generate: z.literal(true) }),
]);

/** What the POST answers for every outcome but `done` and `not-a-code`. */
const CODE_REFUSALS: Record<
  Exclude<SetCleanerCodeResult['kind'], 'done' | 'not-a-code' | 'reserved' | 'taken'>,
  Refusal
> = {
  'not-found': {
    status: 404,
    code: 'CLEANER_NOT_FOUND',
    message: 'Cleaner not found',
  },
  'admin-pin-missing': {
    status: 503,
    code: 'ADMIN_PIN_NOT_CONFIGURED',
    message: 'The admin PIN is not set on this server.',
    hint: 'Nothing was changed. Codes are kept clear of the admin PIN, so none can be set without it.',
  },
  exhausted: {
    status: 409,
    code: 'CLEANER_CODE_UNAVAILABLE',
    message: 'No unused code could be drawn. Nothing was changed. Try again.',
  },
  unreadable: {
    status: 500,
    code: 'CLEANER_RECORD_UNREADABLE',
    message: 'This cleaner’s stored record is not in the shape a code change needs.',
    hint: 'Nothing was changed.',
  },
  // The transaction failed. A failure can come after the commit landed, so
  // this does not claim that nothing was saved.
  failed: {
    status: 502,
    code: 'CLEANER_CODE_CHANGE_FAILED',
    message: 'Could not save the new code.',
    hint: 'It may or may not have been saved. Reload to see the stored code.',
  },
};

const ADMIN_PIN_REFUSAL: Refusal = {
  status: 422,
  code: 'CLEANER_CODE_IS_ADMIN_PIN',
  message: 'That is the admin PIN.',
  hint: 'A cleaner’s code can never be the admin PIN: they would open /admin with it. Nothing was changed.',
};

const TOO_EASY_REFUSAL: Refusal = {
  status: 422,
  code: 'CLEANER_CODE_TOO_EASY',
  message: 'That code is too easy to guess.',
  hint: 'Four of the same digit and runs like 1234 or 9876 are never used. Nothing was changed.',
};

function takenRefusal(retired: boolean): Refusal {
  return {
    status: 409,
    code: 'CLEANER_CODE_TAKEN',
    message: retired
      ? 'That code was used before and is never given out again.'
      : 'That code belongs to another cleaner.',
    hint: 'Choose another, or generate one. Nothing was changed.',
  };
}

export async function POST(request: NextRequest, context: RouteContext) {
  // ── Auth ──
  const auth = verifyAdminSession(request);
  if (!auth.valid) return noStore(apiError(auth.error!, auth.status!));

  // ── Cross-site and media type ──
  const crossSite = refuseCrossSite(request);
  if (crossSite) return crossSite;
  const wrongType = requireMediaType(request, 'application/json');
  if (wrongType) return wrongType;

  const { id } = await context.params;
  if (!isDocumentId(id)) return noStore(apiError('Invalid cleaner ID', 400));

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return noStore(apiError('Invalid JSON body', 400));
  }

  // ── Validate ──
  const result = NewCodeSchema.safeParse(body);
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

  // ── Change ──
  // ADMIN_PIN is read inside the handler, never at module scope, and passed
  // on unlogged. The body holds a code, so it is never logged either.
  const outcome = await setCleanerCode(
    id,
    'code' in result.data ? { kind: 'typed', code: result.data.code } : { kind: 'generate' },
    process.env.ADMIN_PIN,
  );

  switch (outcome.kind) {
    case 'done':
      return noStore(apiSuccess({ cleaner: outcome.cleaner, changed: outcome.changed }));
    case 'not-a-code':
      return noStore(apiValidationError([{ path: 'code', message: CODE_MESSAGE }]));
    case 'reserved':
      return noStore(apiFailure(outcome.reason === 'admin-pin' ? ADMIN_PIN_REFUSAL : TOO_EASY_REFUSAL));
    case 'taken':
      return noStore(apiFailure(takenRefusal(outcome.retired)));
    default:
      return noStore(apiFailure(CODE_REFUSALS[outcome.kind]));
  }
}
