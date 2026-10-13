/**
 * PUT /api/admin-auth/pin — The signed-in admin replaces their own PIN (dispatch 38).
 *
 * Request:  `{ currentPin, newPin }` — the current PIN (four digits for the
 *           shared PIN, six otherwise) and six new digits
 * Response: 200 `{ admin }`, and a new session cookie for this browser
 *
 * It is how the main admin leaves today's shared PIN (Kian's ruling: it is
 * his until he changes it), and the one step a temporary PIN opens: an admin
 * the main admin added, or gave a new PIN, chooses their own here before
 * anything else. The new PIN is six digits and not on the too-easy list
 * (model.ts). The current PIN is checked with the lock, exactly as at
 * sign-in: a wrong one counts, the fifth locks it for fifteen minutes, and
 * nothing is checked while it is locked. Every other session the admin holds
 * ends; this browser gets a new token.
 *
 * Refusals, nothing changed: 401 ADMIN_SESSION_INVALID; 401
 * ADMIN_CURRENT_PIN_WRONG; 422 ADMIN_PIN_NOT_ALLOWED (not six digits, too
 * easy, or the PIN already held); 429 ADMIN_PIN_LOCKED; 503 when the keys are
 * not set. 502: it may or may not have changed.
 *
 * The body holds PINs: never logged, never echoed. The activity log records
 * that the admin changed their PIN, nothing more.
 */

import { after } from 'next/server';
import { z } from 'zod';
import { apiError, apiFailure, apiSuccess, noStore } from '@/app/lib/api/safe-response';
import { LOCK_MINUTES, SIGN_IN_PIN_PATTERN, newPinProblem } from '@/app/lib/admins/model';
import { lockedResponse, signedInView } from '@/app/lib/admins/responses';
import { ADMIN_AUTH_NOT_CONFIGURED, getAdminPinKey, getAdminSessionKey } from '@/app/lib/admins/secrets';
import { ADMIN_SESSION_INVALID, createAdminToken, setAdminSessionCookie, verifyAdminSession } from '@/app/lib/admins/session';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { changeOwnPin, recordAdminAction } from '@/app/lib/firebase/server-admins';

const ChangePinSchema = z.strictObject({
  currentPin: z.string().max(20),
  newPin: z.string().max(20),
});

export async function PUT(request: Request) {
  const crossSite = refuseCrossSite(request);
  if (crossSite) return crossSite;
  const wrongType = requireMediaType(request, 'application/json');
  if (wrongType) return wrongType;

  // ── Who — a temporary PIN's session is enough here, and only here ──
  const session = await verifyAdminSession(request, { allowTemporary: true });
  if (!session.ok) return noStore(apiFailure(session.refusal));
  const sessionKey = getAdminSessionKey();
  if (!sessionKey || !getAdminPinKey()) return noStore(apiFailure(ADMIN_AUTH_NOT_CONFIGURED));

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return noStore(apiError('Invalid request', 400));
  }
  const parsed = ChangePinSchema.safeParse(body);
  if (!parsed.success) return noStore(apiError('Invalid request', 400));
  const { currentPin, newPin } = parsed.data;

  const problem = newPinProblem(newPin) ?? (newPin === currentPin ? 'Choose a PIN other than the one you have.' : null);
  if (problem) return noStore(apiFailure({ status: 422, code: 'ADMIN_PIN_NOT_ALLOWED', message: problem, hint: 'Nothing was changed.' }));
  if (!SIGN_IN_PIN_PATTERN.test(currentPin)) {
    return noStore(apiFailure({ status: 401, code: 'ADMIN_CURRENT_PIN_WRONG', message: 'That is not your current PIN.', hint: 'Nothing was changed.' }));
  }

  const admin = session.admin;
  const outcome = await changeOwnPin(admin, currentPin, newPin);
  switch (outcome.kind) {
    case 'wrong':
      return noStore(
        apiFailure({
          status: 401,
          code: 'ADMIN_CURRENT_PIN_WRONG',
          message: 'That is not your current PIN.',
          hint: outcome.triesLeft === 1 ? `One more wrong try locks it for ${LOCK_MINUTES} minutes. Nothing was changed.` : 'Nothing was changed.',
        }),
      );
    case 'locked':
      return lockedResponse(outcome.lockedUntil, outcome.now);
    case 'session-ended':
      return noStore(apiFailure(ADMIN_SESSION_INVALID));
    case 'not-configured':
      return noStore(apiFailure(ADMIN_AUTH_NOT_CONFIGURED));
    case 'unavailable':
      return noStore(
        apiFailure({ status: 502, code: 'ADMIN_PIN_CHANGE_UNCONFIRMED', message: 'Could not confirm the PIN change.', hint: 'It may or may not have changed. Sign in again to see which PIN works.' }),
      );
    case 'changed': {
      const response = noStore(apiSuccess({ admin: signedInView(outcome.admin) }));
      setAdminSessionCookie(response, createAdminToken(sessionKey, outcome.admin.id, outcome.admin.sessionEpoch));
      const record = {
        at: new Date().toISOString(),
        admin: { id: admin.id, name: admin.name, level: admin.level },
        method: 'PUT',
        path: new URL(request.url).pathname,
        status: 200,
      };
      after(() => recordAdminAction(record));
      return response;
    }
  }
}
