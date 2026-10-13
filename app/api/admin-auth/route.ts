/**
 * POST   /api/admin-auth — Sign in with a name and a PIN; sets the session cookie.
 * GET    /api/admin-auth — The admin this browser is signed in as.
 * DELETE /api/admin-auth — Sign out: take the session cookie off this browser.
 *
 * Dispatch 38 (Kian's rulings of 2026-10-13): each admin signs in with their
 * own PIN, and five wrong tries lock that PIN for fifteen minutes — rate
 * limiting, for admin sign-in only. Sessions are signed with their own
 * secret, ADMIN_SESSION_SECRET, never the PIN (app/lib/admins/session.ts).
 *
 * Sign-in, in order:
 *   1. a browser request from another site is refused (403), and the body
 *      must be declared as JSON (415);
 *   2. without ADMIN_SESSION_SECRET the door stays shut (503);
 *   3. the body must be exactly `{ name: string, pin: string }`, or 400. It
 *      holds a PIN, so it is never logged nor echoed;
 *   4. a PIN that is not four or six digits is refused with no read (401);
 *   5. signIn (server-admins.ts) finds the admin by name and checks the PIN.
 *      Answers:
 *        200  signed in: `{ admin: { id, name, level, pin } }` and the cookie.
 *             `pin: 'temporary'` means the next step is choosing their own
 *             (PUT /api/admin-auth/pin); nothing else opens until then
 *        401  ADMIN_SIGN_IN_REFUSED "Wrong name or PIN." — for a name nobody
 *             holds too, which locks nothing. The try before the lock carries
 *             the warning as its hint
 *        429  ADMIN_PIN_LOCKED with `lockedUntil` and Retry-After: the fifth
 *             wrong try (`lockedNow: true`), or any try while locked, the
 *             right PIN included, which is neither checked nor counted
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
import { LOCK_MINUTES, SIGN_IN_PIN_PATTERN } from '@/app/lib/admins/model';
import { lockedResponse, signedInView } from '@/app/lib/admins/responses';
import { ADMIN_AUTH_NOT_CONFIGURED, getAdminSessionKey } from '@/app/lib/admins/secrets';
import { ADMIN_AUTH_UNAVAILABLE, clearAdminSessionCookie, createAdminToken, setAdminSessionCookie, verifyAdminSession } from '@/app/lib/admins/session';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { signIn } from '@/app/lib/firebase/server-admins';

/** Strict: a body carrying anything else is refused, not trimmed. A name of any length is matched, never stored. */
const SignInSchema = z.strictObject({
  name: z.string().max(200),
  pin: z.string().max(20),
});

/** 401 for every name and PIN that do not open the door. Deliberately says no more. */
const SIGN_IN_REFUSED = { status: 401, code: 'ADMIN_SIGN_IN_REFUSED', message: 'Wrong name or PIN.' };

export async function POST(request: Request) {
  // ── Cross-site and media type ──
  const crossSite = refuseCrossSite(request);
  if (crossSite) return crossSite;
  const wrongType = requireMediaType(request, 'application/json');
  if (wrongType) return wrongType;

  // ── Key — without it the door stays shut ──
  const key = getAdminSessionKey();
  if (!key) return noStore(apiFailure(ADMIN_AUTH_NOT_CONFIGURED));

  // ── Body — never logged, never echoed: it holds a PIN ──
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return noStore(apiError('Invalid request', 400));
  }
  const parsed = SignInSchema.safeParse(body);
  if (!parsed.success) return noStore(apiError('Invalid request', 400));
  const { name, pin } = parsed.data;
  if (!SIGN_IN_PIN_PATTERN.test(pin)) return noStore(apiFailure(SIGN_IN_REFUSED));

  // ── The check, with the lock ──
  const outcome = await signIn(name, pin);
  switch (outcome.kind) {
    case 'wrong':
      return noStore(
        apiFailure({
          ...SIGN_IN_REFUSED,
          ...(outcome.triesLeft === 1 ? { hint: `One more wrong try locks it for ${LOCK_MINUTES} minutes.` } : {}),
        }),
      );
    case 'locked':
      return lockedResponse(outcome.lockedUntil, outcome.now);
    case 'not-configured':
      return noStore(apiFailure(ADMIN_AUTH_NOT_CONFIGURED));
    case 'unavailable':
      return noStore(apiFailure({ ...ADMIN_AUTH_UNAVAILABLE, message: 'Could not check the PIN. Try again.' }));
    case 'signed-in': {
      const response = noStore(apiSuccess({ admin: signedInView(outcome.admin) }));
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
  const session = await verifyAdminSession(request, { allowTemporary: true });
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
