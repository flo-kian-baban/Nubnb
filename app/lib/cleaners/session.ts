/**
 * Cleaner sessions: the token, the cookie, and the check every cleaner route
 * runs first.
 *
 * A cleaner signs in with their code (POST /api/cleaner/session) and is given
 * a signed token in an HTTP-only cookie:
 *
 *   c1.<cleanerId>.<sessionEpoch>.<issuedAtMs>.<mac>
 *   mac = base64url(HMAC-SHA256(CLEANER_SESSION_SECRET,
 *           "nubnb:cleaner-session:v1:" + cleanerId + ":" + epoch + ":" + issuedAtMs))
 *
 * ── Apart from the admin door ──
 * Its own cookie name, its own key and its own format. The admin session
 * check reads only the admin cookie and cannot parse this token (`c1` is not
 * a timestamp); this module reads only `nubnb_cleaner_session` and cannot
 * parse an admin token. The cookie's path is /api/cleaner, so a browser never
 * sends it to /admin or to any admin API. A leaked cleaner cookie reveals
 * nothing about the admin PIN: breaking it means brute-forcing a 256-bit key.
 *
 * ── Revocation ──
 * The token carries the cleaner's `sessionEpoch`, and every status change and
 * every code change bumps it. Deactivating a cleaner, or giving them a new
 * code, therefore ends every session they hold on the next request, and
 * reactivating them does not revive those sessions. The lifetime is 12
 * hours, absolute, with no refresh. Signing out (DELETE /api/cleaner/session)
 * clears the cookie on that phone only.
 *
 * ── Order ──
 * Everything that needs no I/O — the keys, the cookie, the token's shape, its
 * MAC and its age — is checked before the one Firestore read. Cleaner
 * documents are never cached: every request reads the current one.
 *
 * Only the routes under /api/cleaner import this module.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import type { NextResponse } from 'next/server';
import { readSessionCleaner, type SignedInCleaner } from '@/app/lib/firebase/server-cleaners';
import type { Refusal } from './model';
import { CLEANER_AUTH_NOT_CONFIGURED, getCleanerSecrets } from './secrets';

// ─── Constants ─────────────────────────────────────────────────

export const CLEANER_SESSION_COOKIE = 'nubnb_cleaner_session';
/** The browser sends the cookie to /api/cleaner and below, and nowhere else. */
export const CLEANER_SESSION_PATH = '/api/cleaner';
export const CLEANER_SESSION_MAX_AGE = 43200; // 12 hours, absolute (seconds)

const MAC_LABEL = 'nubnb:cleaner-session:v1:';

/** The whole token, anchored: an auto ID, an epoch of 1–9 digits, a 13-digit time, a 43-character MAC. */
const TOKEN_PATTERN = /^c1\.([A-Za-z0-9]{20})\.([1-9][0-9]{0,8})\.([0-9]{13})\.([A-Za-z0-9_-]{43})$/;

/** This module's cookie, and only it. */
const COOKIE_PATTERN = new RegExp(`(?:^|;\\s*)${CLEANER_SESSION_COOKIE}=([^;]+)`);

/** How far a token's issue time may run ahead of this server's clock. */
const MAX_CLOCK_SKEW_MS = 60_000;

// ─── Refusals ──────────────────────────────────────────────────

/** 401: no session, or one that no longer holds. */
export const CLEANER_SESSION_INVALID: Refusal = {
  status: 401,
  code: 'CLEANER_SESSION_INVALID',
  message: 'Sign in with your code.',
};

/** 401 from sign-in, for every code that does not open the door. Deliberately says no more. */
export const CLEANER_CODE_NOT_RECOGNISED: Refusal = {
  status: 401,
  code: 'CLEANER_CODE_NOT_RECOGNISED',
  message: 'Code not recognised',
};

/** 503 from sign-in when a read fails. Access is never granted on an error. */
export const CLEANER_AUTH_UNAVAILABLE: Refusal = {
  status: 503,
  code: 'CLEANER_AUTH_UNAVAILABLE',
  message: 'Could not check the code. Try again.',
};

/** 503 from a session check when the read fails. */
const SESSION_CHECK_UNAVAILABLE: Refusal = {
  status: 503,
  code: 'CLEANER_AUTH_UNAVAILABLE',
  message: 'Could not check your sign-in. Try again.',
};

// ─── Token ─────────────────────────────────────────────────────

/** What a valid token says. */
export interface CleanerTokenClaims {
  cleanerId: string;
  sessionEpoch: number;
  issuedAtMs: number;
}

function macOf(sessionKey: Buffer, cleanerId: string, epoch: string, issuedAtMs: string): string {
  return createHmac('sha256', sessionKey)
    .update(`${MAC_LABEL}${cleanerId}:${epoch}:${issuedAtMs}`, 'utf8')
    .digest('base64url');
}

/**
 * A signed token for a cleaner who has just signed in.
 *
 * @throws if the fields cannot make a well-formed token: an ID that is not a
 * Firestore auto ID, or an epoch outside 1–999999999. The error never
 * carries the token.
 */
export function createCleanerToken(
  sessionKey: Buffer,
  cleanerId: string,
  sessionEpoch: number,
  issuedAtMs: number = Date.now(),
): string {
  const epoch = String(sessionEpoch);
  const issued = String(issuedAtMs);
  const token = `c1.${cleanerId}.${epoch}.${issued}.${macOf(sessionKey, cleanerId, epoch, issued)}`;
  if (!TOKEN_PATTERN.test(token)) throw new Error('createCleanerToken: fields out of range');
  return token;
}

/**
 * The claims of a token that is well-formed, correctly signed and in date —
 * issued no more than 12 hours ago and no more than a minute ahead of this
 * clock — or null. Pure: no I/O. Whether the cleaner is still active on the
 * same epoch is the caller's read.
 */
export function parseCleanerToken(
  token: string,
  sessionKey: Buffer,
  nowMs: number = Date.now(),
): CleanerTokenClaims | null {
  const match = TOKEN_PATTERN.exec(token);
  if (!match) return null;
  const [, cleanerId, epoch, issued, mac] = match;

  // Constant-time, on the decoded MACs, which are 32 bytes each.
  const given = Buffer.from(mac, 'base64url');
  const expected = Buffer.from(macOf(sessionKey, cleanerId, epoch, issued), 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  const issuedAtMs = Number(issued);
  const age = nowMs - issuedAtMs;
  if (age > CLEANER_SESSION_MAX_AGE * 1000 || -age > MAX_CLOCK_SKEW_MS) return null;

  return { cleanerId, sessionEpoch: Number(epoch), issuedAtMs };
}

// ─── Request-level session verification ────────────────────────

export type CleanerSessionResult =
  | { ok: true; cleaner: SignedInCleaner }
  /** Send as `noStore(apiFailure(refusal))`. */
  | { ok: false; refusal: Refusal };

/** The token from this module's cookie, or null. No other cookie is read. */
function readSessionCookie(request: Request): string | null {
  const match = (request.headers.get('cookie') ?? '').match(COOKIE_PATTERN);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/**
 * Verify the cleaner session on a request. Every /api/cleaner handler except
 * sign-in calls this first, before reading the body.
 *
 *   503 CLEANER_AUTH_NOT_CONFIGURED  the cleaner keys are missing or invalid
 *   401 CLEANER_SESSION_INVALID      no cookie, a malformed, forged or expired
 *                                    token, or a cleaner who is gone, not
 *                                    active, or has changed status since
 *   503 CLEANER_AUTH_UNAVAILABLE     the cleaner could not be read
 *
 * The keys are checked first, so a server without them answers 503 on every
 * cleaner route. No I/O happens until the token has passed its MAC and age
 * checks; then the cleaner's document is read once.
 */
export async function verifyCleanerSession(request: Request): Promise<CleanerSessionResult> {
  const secrets = getCleanerSecrets();
  if (secrets.kind !== 'ok') return { ok: false, refusal: CLEANER_AUTH_NOT_CONFIGURED };

  const token = readSessionCookie(request);
  if (!token) return { ok: false, refusal: CLEANER_SESSION_INVALID };

  const claims = parseCleanerToken(token, secrets.sessionKey);
  if (!claims) return { ok: false, refusal: CLEANER_SESSION_INVALID };

  const read = await readSessionCleaner(claims.cleanerId, claims.sessionEpoch);
  if (read.kind === 'unavailable') return { ok: false, refusal: SESSION_CHECK_UNAVAILABLE };
  if (read.kind === 'invalid') return { ok: false, refusal: CLEANER_SESSION_INVALID };
  return { ok: true, cleaner: read.cleaner };
}

// ─── Cookie ────────────────────────────────────────────────────

/**
 * Put the session cookie on a sign-in response.
 *
 * Written as the Set-Cookie header itself, so that every attribute the
 * browser receives is on this one line: HttpOnly, SameSite=Strict, the
 * /api/cleaner path, the 12-hour Max-Age, and Secure in production. The
 * token needs no encoding — it is letters, digits, `.`, `_` and `-`.
 *
 * @throws if `token` is not one createCleanerToken made. The error never
 * carries the token.
 */
export function setCleanerSessionCookie(response: NextResponse, token: string): void {
  if (!TOKEN_PATTERN.test(token)) throw new Error('setCleanerSessionCookie: not a cleaner token');
  const attributes = [
    `${CLEANER_SESSION_COOKIE}=${token}`,
    `Path=${CLEANER_SESSION_PATH}`,
    `Max-Age=${CLEANER_SESSION_MAX_AGE}`,
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (process.env.NODE_ENV === 'production') attributes.push('Secure');
  response.headers.append('Set-Cookie', attributes.join('; '));
}

/**
 * Take the session cookie off this browser, on a sign-out response: the same
 * name and path, empty, expiring now. The token itself stays valid until it
 * ages out or the cleaner's epoch moves, but this browser no longer holds it.
 */
export function clearCleanerSessionCookie(response: NextResponse): void {
  const attributes = [
    `${CLEANER_SESSION_COOKIE}=`,
    `Path=${CLEANER_SESSION_PATH}`,
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (process.env.NODE_ENV === 'production') attributes.push('Secure');
  response.headers.append('Set-Cookie', attributes.join('; '));
}
