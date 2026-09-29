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
 *   4. a code that is not four digits is refused with no read at all (401);
 *   5. the code's document is looked up, then the cleaner it names. An
 *      unknown code (the admin PIN among them: it is never a code), a
 *      replaced one, a deactivated cleaner and a code the cleaner no longer
 *      holds all get the same 401, which says no more than that. A failed
 *      read is 503: access is never granted on an error;
 *   6. a session token is issued in an HTTP-only cookie scoped to
 *      /api/cleaner, good for 12 hours.
 *
 * Reads: none for a malformed code, one for an unknown code, two for a
 * recognised one. The GET reads nothing when the token is invalid, and one
 * document otherwise. The DELETE reads nothing and needs no session: it only
 * clears the cookie, so it answers the same whether or not one was sent.
 *
 * Every response, refusals included, is no-store.
 */

import { z } from 'zod';
import { apiSuccess, apiError, apiFailure, noStore } from '@/app/lib/api/safe-response';
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
import { findCleanerByCode } from '@/app/lib/firebase/server-cleaners';

/** Strict: a body that carries anything besides `code` is refused, not trimmed. */
const SignInSchema = z.strictObject({
  code: z.string(),
});

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

  // ── Lookup — one answer for every code that does not open the door ──
  const found = await findCleanerByCode(code);
  if (found.kind === 'unavailable') return noStore(apiFailure(CLEANER_AUTH_UNAVAILABLE));
  if (found.kind === 'not-recognised') return noStore(apiFailure(CLEANER_CODE_NOT_RECOGNISED));

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

  const { id, name } = session.cleaner;
  return noStore(apiSuccess({ cleaner: { id, name } }));
}

export async function DELETE(request: Request) {
  // ── Cross-site ── a page on another site must not sign a cleaner out.
  const crossSite = refuseCrossSite(request);
  if (crossSite) return crossSite;

  const response = noStore(apiSuccess({ signedOut: true }));
  clearCleanerSessionCookie(response);
  return response;
}
