/**
 * POST   /api/admin-auth — Sign in with a PIN; sets the session cookie.
 * GET    /api/admin-auth — The admin this browser is signed in as.
 * DELETE /api/admin-auth — Sign out: take the session cookie off this browser.
 *
 * Kian's rulings of 2026-10-13 (evening): admins sign in with their PIN only;
 * no name is typed, and the PIN identifies the admin. Five wrong PINs from
 * one connection lock sign-in from that connection for fifteen minutes —
 * rate limiting, for admin sign-in only — and the connection is kept only as
 * a keyed hash. Sessions are signed with their own secret,
 * ADMIN_SESSION_SECRET, never the PIN (app/lib/admins/session.ts).
 *
 * Sign-in, in order:
 *   1. a browser request from another site is refused (403), and the body
 *      must be declared as JSON (415);
 *   2. without ADMIN_SESSION_SECRET and ADMIN_PIN_KEY the door stays shut
 *      (503);
 *   3. the body must be exactly `{ pin: string }`, or 400. It holds a PIN, so
 *      it is never logged nor echoed;
 *   4. a PIN that is not four or six digits is refused with no read (401);
 *   5. signIn (server-admins.ts): a locked connection is refused before any
 *      hash; otherwise the PIN's lookup key finds its admin. Answers:
 *        200  signed in: `{ admin: { id, name, level, pin } }` and the
 *             cookie; with `newPin` when the shared PIN was used — the main
 *             admin on it is given a generated PIN, shown this once
 *        401  ADMIN_SIGN_IN_REFUSED "Wrong PIN." — the try before the lock
 *             carries the warning as its hint
 *        409  SHARED_PIN_AMBIGUOUS: more than one main admin is on the
 *             shared PIN, so it cannot say which
 *        429  ADMIN_SIGN_IN_LOCKED with `lockedUntil` and Retry-After: the
 *             fifth wrong PIN (`lockedNow: true`), or any try while this
 *             connection is locked, the right PIN included, which is neither
 *             checked nor counted
 *        503  ADMIN_AUTH_NOT_CONFIGURED or ADMIN_AUTH_UNAVAILABLE: never
 *             access on an error
 *
 * The GET reads nothing without a well-formed, correctly signed token, and
 * one admin document with one. A cookie that no longer opens anything — a
 * PIN-signed one from before dispatch 38, an expired one, one whose admin
 * was removed or given a new PIN — is answered 401 and cleared, so the gate
 * shows the sign-in and the browser stops sending it.
 *
 * Every response is no-store.
 */

import { z } from 'zod';
import { apiError, apiFailure, apiSuccess, noStore } from '@/app/lib/api/safe-response';
import { connectionOf } from '@/app/lib/admins/connection';
import { LOCK_MINUTES, SIGN_IN_PIN_PATTERN } from '@/app/lib/admins/model';
import { lockedResponse, signedInView } from '@/app/lib/admins/responses';
import { ADMIN_AUTH_NOT_CONFIGURED, getAdminPinKey, getAdminSessionKey } from '@/app/lib/admins/secrets';
import { ADMIN_AUTH_UNAVAILABLE, clearAdminSessionCookie, createAdminToken, setAdminSessionCookie, verifyAdminSession } from '@/app/lib/admins/session';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { signIn } from '@/app/lib/firebase/server-admins';

/** Strict: a body carrying anything else is refused, not trimmed. */
const SignInSchema = z.strictObject({
  pin: z.string().max(20),
});

/** 401 for every PIN that does not open the door. Deliberately says no more. */
const SIGN_IN_REFUSED = { status: 401, code: 'ADMIN_SIGN_IN_REFUSED', message: 'Wrong PIN.' };

export async function POST(request: Request) {
  // ── Cross-site and media type ──
  const crossSite = refuseCrossSite(request);
  if (crossSite) return crossSite;
  const wrongType = requireMediaType(request, 'application/json');
  if (wrongType) return wrongType;

  // ── Keys — without them the door stays shut ──
  const key = getAdminSessionKey();
  const pinKey = getAdminPinKey();
  if (!key || !pinKey) return noStore(apiFailure(ADMIN_AUTH_NOT_CONFIGURED));

  // ── Body — never logged, never echoed: it holds a PIN ──
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return noStore(apiError('Invalid request', 400));
  }
  const parsed = SignInSchema.safeParse(body);
  if (!parsed.success) return noStore(apiError('Invalid request', 400));
  const { pin } = parsed.data;
  if (!SIGN_IN_PIN_PATTERN.test(pin)) return noStore(apiFailure(SIGN_IN_REFUSED));

  // ── The check, with the connection's lock ──
  const outcome = await signIn(pin, connectionOf(request, pinKey));
  switch (outcome.kind) {
    case 'wrong':
      return noStore(
        apiFailure({
          ...SIGN_IN_REFUSED,
          ...(outcome.triesLeft === 1 ? { hint: `One more wrong PIN locks sign-in from here for ${LOCK_MINUTES} minutes.` } : {}),
        }),
      );
    case 'locked':
      return lockedResponse(outcome.lockedUntil, outcome.now);
    case 'shared-ambiguous':
      return noStore(apiFailure({ status: 409, code: 'SHARED_PIN_AMBIGUOUS', message: 'More than one main admin is on the shared PIN.', hint: 'Run the recovery script for one main admin at a time. Nothing was changed.' }));
    case 'not-configured':
      return noStore(apiFailure(ADMIN_AUTH_NOT_CONFIGURED));
    case 'unavailable':
      return noStore(apiFailure({ ...ADMIN_AUTH_UNAVAILABLE, message: 'Could not check the PIN. Try again.' }));
    case 'signed-in': {
      // The generated PIN travels in this answer only: shown once, stored nowhere.
      const response = noStore(apiSuccess({ admin: signedInView(outcome.admin), ...(outcome.newPin ? { newPin: outcome.newPin } : {}) }));
      try {
        setAdminSessionCookie(response, createAdminToken(key, outcome.admin.id, outcome.admin.sessionEpoch));
      } catch {
        console.error('[admin-auth] session not issued: the admin record cannot be put in a token');
        return noStore(apiFailure(ADMIN_AUTH_UNAVAILABLE));
      }
      return response;
    }
  }
}

export async function GET(request: Request) {
  const session = await verifyAdminSession(request);
  if (!session.ok) {
    const response = noStore(apiFailure(session.refusal));
    if (session.staleCookie) clearAdminSessionCookie(response);
    return response;
  }
  return noStore(apiSuccess({ admin: signedInView(session.admin) }));
}

export async function DELETE(request: Request) {
  // A page on another site must not sign an admin out.
  const crossSite = refuseCrossSite(request);
  if (crossSite) return crossSite;
  const response = noStore(apiSuccess({ signedOut: true }));
  clearAdminSessionCookie(response);
  return response;
}
