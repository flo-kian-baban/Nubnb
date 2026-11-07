/**
 * POST /api/admin-auth/pin — Change PIN, from the signed-in admin's own menu, or the gate's Set your PIN (dispatch 38).
 *
 * Request:  `{ currentPin, newPin }` — the PIN they hold now (four digits: a
 *           readable PIN, or the shared PIN), then the four digits they choose
 * Response: 200 `{ admin }`, and a new session cookie for this browser
 *
 * Kian's rulings of 2026-10-13: an admin can still change their own PIN;
 * PINs are stored readably and stay unique (night); four digits, never a
 * cleaner code current or retired (late night). The current PIN comes first,
 * checked against the admin's own document only (changeOwnPin), so a session
 * alone cannot become a PIN; a wrong one counts against the connection's lock
 * like a sign-in. So does every change: a PIN refused because another admin
 * holds it tells the chooser that admin's PIN (Kian's confirmation). Every
 * other session the admin holds ends; this browser gets a new token. It is
 * also how a main admin on the shared PIN, after the recovery script, sets
 * their own.
 *
 * Refusals, nothing changed, each in one plain line that says why (Kian's
 * ruling of 2026-10-17): 401 ADMIN_SESSION_INVALID; 401
 * ADMIN_CURRENT_PIN_WRONG; 409 ADMIN_PIN_TAKEN (another admin's now: one no
 * admin holds any more, their own before included, may be set again) and 409
 * ADMIN_PIN_IS_A_CODE (a cleaner code, current or retired), both counted, with
 * the warning before the try that locks as the hint; 409 ADMIN_PIN_SAME; 409
 * ADMIN_PIN_KEPT_BEFORE for a PIN set before PINs were four digits; 422 for a
 * new PIN that is not four digits, is too easy, or is the shared PIN; 429
 * ADMIN_SIGN_IN_LOCKED; 503 when the keys are not set. 502: it may or may not
 * have changed.
 *
 * The body holds PINs: it is never logged or echoed. The activity log records
 * that the admin changed their PIN, nothing more.
 */

import { NextRequest } from 'next/server';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { connectionOf } from '@/app/lib/admins/connection';
import { SIGN_IN_PIN_PATTERN, lastTryWords } from '@/app/lib/admins/model';
import { sharedPinMatches } from '@/app/lib/admins/pin';
import { PIN_IS_A_CODE, PIN_IS_SHARED, PIN_KEPT_BEFORE, PIN_TAKEN, lockedResponse, signedInView } from '@/app/lib/admins/responses';
import { ChangePinSchema } from '@/app/lib/admins/schemas';
import { ADMIN_AUTH_NOT_CONFIGURED, getAdminPinKey, getAdminSessionKey } from '@/app/lib/admins/secrets';
import { ADMIN_SESSION_INVALID, createAdminToken, setAdminSessionCookie } from '@/app/lib/admins/session';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { changeOwnPin } from '@/app/lib/firebase/server-admins';

const WRONG = (triesLeft: number, untilLifted: boolean) => ({ status: 401, code: 'ADMIN_CURRENT_PIN_WRONG', message: 'That is not your current PIN.', hint: triesLeft === 1 ? `${lastTryWords('try', untilLifted)} Nothing was changed.` : 'Nothing was changed.' });

export const POST = adminRoute(async function POST(request: NextRequest, _context: unknown, { admin }) {
  const crossSite = refuseCrossSite(request);
  if (crossSite) return crossSite;
  const wrongType = requireMediaType(request, 'application/json');
  if (wrongType) return wrongType;
  const sessionKey = getAdminSessionKey();
  const pinKey = getAdminPinKey();
  if (!sessionKey || !pinKey) return noStore(apiFailure(ADMIN_AUTH_NOT_CONFIGURED));

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return noStore(apiError('Invalid request', 400));
  }
  const parsed = ChangePinSchema.safeParse(body);
  if (!parsed.success) {
    // Only the new PIN's problems are said; the current PIN is never described.
    const issues = parsed.error.issues.filter((i) => i.path[0] === 'newPin').map((i) => ({ path: 'newPin', message: i.message }));
    return noStore(issues.length > 0 ? apiValidationError(issues) : apiError('Invalid request', 400));
  }
  const { currentPin, newPin } = parsed.data;
  if (!SIGN_IN_PIN_PATTERN.test(currentPin)) return noStore(apiFailure(WRONG(0, false)));
  if (sharedPinMatches(newPin) === true) return noStore(apiFailure(PIN_IS_SHARED));

  const outcome = await changeOwnPin(admin, currentPin, newPin, connectionOf(request, pinKey));
  switch (outcome.kind) {
    case 'wrong':
      return noStore(apiFailure(WRONG(outcome.triesLeft, outcome.untilLifted)));
    case 'taken': {
      // Which holds it, in one plain line (Kian's ruling of 2026-10-17); the warning before the try that locks, under it.
      const refusal = outcome.by === 'code' ? PIN_IS_A_CODE : PIN_TAKEN;
      return noStore(apiFailure(outcome.triesLeft === 1 ? { ...refusal, hint: lastTryWords('try', outcome.untilLifted) } : refusal));
    }
    case 'kept-before':
      return noStore(apiFailure(PIN_KEPT_BEFORE));
    case 'same':
      return noStore(apiFailure({ status: 409, code: 'ADMIN_PIN_SAME', message: 'That is your PIN already.', hint: 'Nothing was changed.' }));
    case 'locked':
      return lockedResponse(outcome.lockedUntil, outcome.now);
    case 'session-ended':
      return noStore(apiFailure(ADMIN_SESSION_INVALID));
    case 'not-configured':
      return noStore(apiFailure(ADMIN_AUTH_NOT_CONFIGURED));
    case 'unavailable':
      return noStore(apiFailure({ status: 502, code: 'ADMIN_PIN_CHANGE_UNCONFIRMED', message: 'Could not confirm the PIN change.', hint: 'It may or may not have changed. Sign in again to see which PIN works.' }));
    case 'changed': {
      const response = noStore(apiSuccess({ admin: signedInView(outcome.admin), ...(outcome.lockedUntil !== undefined ? { lockedUntil: outcome.lockedUntil, capped: outcome.lockedUntil === null } : {}) }));
      setAdminSessionCookie(response, createAdminToken(sessionKey, outcome.admin.id, outcome.admin.sessionEpoch));
      return response;
    }
  }
});
