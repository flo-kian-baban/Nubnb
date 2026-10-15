/**
 * POST   /api/cleaner/session — Sign a cleaner in with their code.
 * GET    /api/cleaner/session — The cleaner this request is signed in as.
 * DELETE /api/cleaner/session — Sign out: take the session cookie off this browser.
 *
 * The cleaner door. It shares nothing with the admin door: its own cookie,
 * its own key, its own token, and its own codes — four digits, like the admin
 * PIN, but never the admin PIN, which is never issued or set as a code.
 * Nothing here reads the admin PIN or the admin session cookie, and a cleaner
 * session opens no admin route (see app/lib/cleaners/session.ts).
 *
 * Sign-in, in order:
 *   1. a browser request from another site is refused (403), and the body
 *      must be declared as JSON (415);
 *   2. without the cleaner key the door stays shut (503);
 *   3. the body must be exactly `{ code: string }`, or 400. It holds a code,
 *      so it is never logged;
 *   4. a code that is not four digits is refused with no read at all (401),
 *      and is not counted: it is no guess;
 *   5. the connection's lock (Kian's ruling of 2026-10-14, evening: the
 *      admin door's lock): a locked connection is refused before anything
 *      else is read (429, with when it ends, or `capped` until an admin
 *      lifts it from the Team page);
 *   6. the code's document is looked up, then the cleaner it names. An
 *      unknown code (the admin PIN among them: it is never a code), a
 *      replaced one, a deactivated cleaner and a code the cleaner no longer
 *      holds all get the same 401, which says no more than that, and each
 *      counts against the connection: the fifth in a row locks it for 15
 *      minutes, the twentieth in a Toronto day until an admin lifts it; the
 *      try before a lock says so. A failed read is 503: access is never
 *      granted on an error;
 *   7. a session token is issued in an HTTP-only cookie scoped to
 *      /api/cleaner, good for 12 hours.
 *
 * Reads: none for a malformed code; one for a locked connection; otherwise
 * the lock twice, the code, and the cleaner when the code names one
 * (server-cleaners.ts, signInCleaner). The GET reads nothing when the token
 * is invalid, and one document otherwise. The DELETE reads nothing and needs
 * no session: it only clears the cookie, so it answers the same whether or
 * not one was sent.
 *
 * Every response, refusals included, is no-store.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiSuccess, apiError, apiFailure, noStore } from '@/app/lib/api/safe-response';
import { LOCK_MINUTES } from '@/app/lib/admins/model';
import { cleanerConnectionOf } from '@/app/lib/cleaners/lock';
import { CODE_PATTERN } from '@/app/lib/cleaners/model';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { CLEANER_AUTH_NOT_CONFIGURED, getCleanerSecrets } from '@/app/lib/cleaners/secrets';
import {
  CLEANER_AUTH_UNAVAILABLE,
  CLEANER_CODE_NOT_RECOGNISED,
  clearCleanerSessionCookie,
  createCleanerToken,
  setCleanerSessionCookie,
  verifyCleanerSession,
} from '@/app/lib/cleaners/session';
import { signInCleaner } from '@/app/lib/firebase/server-cleaners';

/** Strict: a body that carries anything besides `code` is refused, not trimmed. */
const SignInSchema = z.strictObject({
  code: z.string(),
});

/** The warning on the wrong code before a lock: the cleaner app shows it under the boxes. */
function lastTryWarning(untilLifted: boolean): string {
  return `One more wrong code locks sign-in from here ${untilLifted ? 'until the office lifts it' : `for ${LOCK_MINUTES} minutes`}.`;
}

/**
 * 429 CLEANER_SIGN_IN_LOCKED: sign-in from this connection is locked. For fifteen minutes, with when it ends and
 * Retry-After; or, after twenty wrong codes in a Toronto day, until an admin lifts it (`lockedUntil` null, `capped`).
 * `lockedNow` when this code locked it.
 */
function lockedResponse(lockedUntil: string | null, lockedNow: boolean): NextResponse {
  const capped = lockedUntil === null;
  const error = capped ? 'Sign-in from here is locked until the office lifts it.' : lockedNow ? `Five wrong codes in a row: sign-in from here is locked for ${LOCK_MINUTES} minutes.` : 'Sign-in from here is locked.';
  const headers: Record<string, string> = capped ? {} : { 'Retry-After': String(Math.max(1, Math.ceil((Date.parse(lockedUntil) - Date.now()) / 1_000))) };
  return noStore(NextResponse.json({ success: false, error, code: 'CLEANER_SIGN_IN_LOCKED', lockedUntil, capped, lockedNow }, { status: 429, headers }));
}

export async function POST(request: Request) {
  // ── Cross-site and media type ──
  const crossSite = refuseCrossSite(request);
  if (crossSite) return crossSite;
  const wrongType = requireMediaType(request, 'application/json');
  if (wrongType) return wrongType;

  // ── Key — without it the door stays shut ──
  const secrets = getCleanerSecrets();
  if (secrets.kind !== 'ok') return noStore(apiFailure(CLEANER_AUTH_NOT_CONFIGURED));

  // ── Body — never logged, and never echoed: it holds a code ──
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return noStore(apiError('Invalid request', 400));
  }

  const parsed = SignInSchema.safeParse(body);
  if (!parsed.success) return noStore(apiError('Invalid request', 400));

  // ── Shape — four digits, or refused without a read ──
  const { code } = parsed.data;
  if (!CODE_PATTERN.test(code)) return noStore(apiFailure(CLEANER_CODE_NOT_RECOGNISED));

  // ── Lookup, with the connection's lock — one answer for every code that does not open the door ──
  const found = await signInCleaner(code, cleanerConnectionOf(request, secrets.sessionKey));
  if (found.kind === 'unavailable') return noStore(apiFailure(CLEANER_AUTH_UNAVAILABLE));
  if (found.kind === 'locked') return lockedResponse(found.lockedUntil, found.now);
  if (found.kind === 'not-recognised') return noStore(apiFailure({ ...CLEANER_CODE_NOT_RECOGNISED, ...(found.triesLeft === 1 ? { hint: lastTryWarning(found.untilLifted) } : {}) }));

  // ── Session ──
  const { cleaner } = found;
  const response = noStore(apiSuccess({ cleaner: { id: cleaner.id, name: cleaner.name } }));
  try {
    setCleanerSessionCookie(
      response,
      createCleanerToken(secrets.sessionKey, cleaner.id, cleaner.sessionEpoch),
    );
  } catch {
    // Unreachable in practice: the lookup accepts only IDs and epochs a token
    // can carry. Whatever it was, no session is granted.
    console.error('[cleaner-session] session not issued: the cleaner record cannot be put in a token');
    return noStore(apiFailure(CLEANER_AUTH_UNAVAILABLE));
  }
  return response;
}

export async function GET(request: Request) {
  // ── Auth ──
  const session = await verifyCleanerSession(request);
  if (!session.ok) return noStore(apiFailure(session.refusal));

  const { id, name, role } = session.cleaner;
  return noStore(apiSuccess({ cleaner: { id, name, role } }));
}

export async function DELETE(request: Request) {
  // ── Cross-site ── a page on another site must not sign a cleaner out.
  const crossSite = refuseCrossSite(request);
  if (crossSite) return crossSite;

  const response = noStore(apiSuccess({ signedOut: true }));
  clearCleanerSessionCookie(response);
  return response;
}
