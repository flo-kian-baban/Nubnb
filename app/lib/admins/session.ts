/**
 * Admin sessions (dispatch 38): the token, the cookie, and the check every
 * admin route runs first. Server-only.
 *
 * An admin signs in with their name and PIN (POST /api/admin-auth) and is
 * given a signed token in an HTTP-only cookie:
 *
 *   a1.<adminId>.<sessionEpoch>.<issuedAtMs>.<mac>
 *   mac = base64url(HMAC-SHA256(ADMIN_SESSION_SECRET,
 *           "nubnb:admin-session:v1:" + adminId + ":" + epoch + ":" + issuedAtMs))
 *
 * Kian's ruling of 2026-10-13: sessions are signed with their own secret, no
 * longer the PIN. Until dispatch 38 the token was `<issuedAtMs>.<hex mac>`
 * keyed with ADMIN_PIN itself, so one leaked cookie gave the PIN away offline.
 * Such a token does not match the pattern below: it is refused like any other
 * stranger, and the sign-in check clears it from the browser, so every
 * session made before dispatch 38 ends at the first request after deploy.
 *
 * ── Which admin ──
 * The token names the admin by ID. Every request reads that admin's
 * document: it must still exist and hold the same `sessionEpoch`. The name,
 * the level and the PIN's state come from that read, never from the token,
 * so a level change holds on the next request, and a removal, a new PIN or a
 * PIN change (which move or delete the epoch) end that admin's other sessions
 * at once. The lifetime is 24 hours, absolute, as before.
 *
 * ── Apart from the cleaner door ──
 * Its own cookie, key and format. The cleaner check reads only
 * `nubnb_cleaner_session` and cannot parse an `a1` token; this one reads only
 * `nubnb_admin_session` and cannot parse a `c1` token.
 *
 * ── Order ──
 * The key, the cookie, the token's shape, its MAC and its age are checked
 * before the one Firestore read. Admin documents are never cached.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import type { NextResponse } from 'next/server';
import type { Refusal } from '@/app/lib/cleaners/model';
import { readSessionAdmin, type SignedInAdmin } from '@/app/lib/firebase/server-admins';
import { ADMIN_AUTH_NOT_CONFIGURED, getAdminSessionKey } from './secrets';

// ─── Constants ─────────────────────────────────────────────────

/** The name the PIN-signed cookie had, so the first answer after deploy replaces or clears it. */
export const ADMIN_SESSION_COOKIE = 'nubnb_admin_session';
export const ADMIN_SESSION_MAX_AGE = 24 * 60 * 60; // 24 hours, absolute (seconds)

const MAC_LABEL = 'nubnb:admin-session:v1:';

/** The whole token, anchored: an auto ID, an epoch of 1–9 digits, a 13-digit time, a 43-character MAC. */
const TOKEN_PATTERN = /^a1\.([A-Za-z0-9]{20})\.([1-9][0-9]{0,8})\.([0-9]{13})\.([A-Za-z0-9_-]{43})$/;

const COOKIE_PATTERN = new RegExp(`(?:^|;\\s*)${ADMIN_SESSION_COOKIE}=([^;]*)`);

/** How far a token's issue time may run ahead of this server's clock. */
const MAX_CLOCK_SKEW_MS = 60_000;

// ─── Refusals ──────────────────────────────────────────────────

/** 401: no session, or one that no longer holds. */
export const ADMIN_SESSION_INVALID: Refusal = {
  status: 401,
  code: 'ADMIN_SESSION_INVALID',
  message: 'Sign in again.',
};

/** 503: the admin could not be read. Access is never granted on an error. */
export const ADMIN_AUTH_UNAVAILABLE: Refusal = {
  status: 503,
  code: 'ADMIN_AUTH_UNAVAILABLE',
  message: 'Could not check your sign-in. Try again.',
};

/** 403: signed in on a temporary PIN, which opens only the step where the admin chooses their own. */
export const ADMIN_PIN_CHANGE_REQUIRED: Refusal = {
  status: 403,
  code: 'ADMIN_PIN_CHANGE_REQUIRED',
  message: 'Choose your own PIN first.',
  hint: 'You signed in with a temporary PIN. Nothing was changed.',
};

/** 403: a main admin's page or action, asked for by an admin. */
export const MAIN_ADMIN_ONLY: Refusal = {
  status: 403,
  code: 'MAIN_ADMIN_ONLY',
  message: 'Only a main admin can do this.',
  hint: 'Nothing was changed.',
};

// ─── Token ─────────────────────────────────────────────────────

export interface AdminTokenClaims {
  adminId: string;
  sessionEpoch: number;
  issuedAtMs: number;
}

function macOf(key: Buffer, adminId: string, epoch: string, issuedAtMs: string): string {
  return createHmac('sha256', key).update(`${MAC_LABEL}${adminId}:${epoch}:${issuedAtMs}`, 'utf8').digest('base64url');
}

/**
 * A signed token for an admin who has just signed in or changed their PIN.
 *
 * @throws if the fields cannot make a well-formed token. The error never
 * carries the token.
 */
export function createAdminToken(key: Buffer, adminId: string, sessionEpoch: number, issuedAtMs: number = Date.now()): string {
  const epoch = String(sessionEpoch);
  const issued = String(issuedAtMs);
  const token = `a1.${adminId}.${epoch}.${issued}.${macOf(key, adminId, epoch, issued)}`;
  if (!TOKEN_PATTERN.test(token)) throw new Error('createAdminToken: fields out of range');
  return token;
}

/**
 * The claims of a token that is well-formed, correctly signed and in date —
 * issued no more than 24 hours ago and no more than a minute ahead of this
 * clock — or null. Pure: no I/O.
 */
export function parseAdminToken(token: string, key: Buffer, nowMs: number = Date.now()): AdminTokenClaims | null {
  const match = TOKEN_PATTERN.exec(token);
  if (!match) return null;
  const [, adminId, epoch, issued, mac] = match;

  const given = Buffer.from(mac, 'base64url');
  const expected = Buffer.from(macOf(key, adminId, epoch, issued), 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  const issuedAtMs = Number(issued);
  const age = nowMs - issuedAtMs;
  if (age > ADMIN_SESSION_MAX_AGE * 1000 || -age > MAX_CLOCK_SKEW_MS) return null;

  return { adminId, sessionEpoch: Number(epoch), issuedAtMs };
}

// ─── Request-level session verification ────────────────────────

export type AdminSessionResult =
  | { ok: true; admin: SignedInAdmin }
  /** `staleCookie`: the request carried an admin cookie that no longer opens anything, which the answer may clear. */
  | { ok: false; refusal: Refusal; staleCookie: boolean };

/** The raw value of this module's cookie, or null when the request carries none. */
function readSessionCookie(request: Request): string | null {
  const match = (request.headers.get('cookie') ?? '').match(COOKIE_PATTERN);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/**
 * The admin a request is signed in as.
 *
 *   503 ADMIN_AUTH_NOT_CONFIGURED   no session key on this server
 *   401 ADMIN_SESSION_INVALID       no cookie; a malformed, forged or expired
 *                                   token (every PIN-signed one of before
 *                                   dispatch 38 among them); an admin who was
 *                                   removed or whose epoch has moved
 *   503 ADMIN_AUTH_UNAVAILABLE      the admin could not be read
 *   403 ADMIN_PIN_CHANGE_REQUIRED   on a temporary PIN, unless `allowTemporary`
 *
 * No I/O happens until the token has passed its MAC and age checks.
 */
export async function verifyAdminSession(request: Request, options: { allowTemporary?: boolean } = {}): Promise<AdminSessionResult> {
  const key = getAdminSessionKey();
  if (!key) return { ok: false, refusal: ADMIN_AUTH_NOT_CONFIGURED, staleCookie: false };

  const token = readSessionCookie(request);
  if (token === null) return { ok: false, refusal: ADMIN_SESSION_INVALID, staleCookie: false };

  const claims = parseAdminToken(token, key);
  if (!claims) return { ok: false, refusal: ADMIN_SESSION_INVALID, staleCookie: true };

  const read = await readSessionAdmin(claims.adminId, claims.sessionEpoch);
  if (read.kind === 'unavailable') return { ok: false, refusal: ADMIN_AUTH_UNAVAILABLE, staleCookie: false };
  if (read.kind === 'invalid') return { ok: false, refusal: ADMIN_SESSION_INVALID, staleCookie: true };
  if (read.admin.pin === 'temporary' && !options.allowTemporary) {
    return { ok: false, refusal: ADMIN_PIN_CHANGE_REQUIRED, staleCookie: false };
  }
  return { ok: true, admin: read.admin };
}

// ─── Cookie ────────────────────────────────────────────────────

/**
 * Put the session cookie on a response: HttpOnly, SameSite=Strict, path /,
 * 24 hours, and Secure in production — as the PIN-signed cookie was, so the
 * new one replaces it in the browser.
 *
 * @throws if `token` is not one createAdminToken made.
 */
export function setAdminSessionCookie(response: NextResponse, token: string): void {
  if (!TOKEN_PATTERN.test(token)) throw new Error('setAdminSessionCookie: not an admin token');
  const attributes = [`${ADMIN_SESSION_COOKIE}=${token}`, 'Path=/', `Max-Age=${ADMIN_SESSION_MAX_AGE}`, 'HttpOnly', 'SameSite=Strict'];
  if (process.env.NODE_ENV === 'production') attributes.push('Secure');
  response.headers.append('Set-Cookie', attributes.join('; '));
}

/** Take the session cookie off this browser: the same name and path, empty, expiring now. */
export function clearAdminSessionCookie(response: NextResponse): void {
  const attributes = [`${ADMIN_SESSION_COOKIE}=`, 'Path=/', 'Max-Age=0', 'HttpOnly', 'SameSite=Strict'];
  if (process.env.NODE_ENV === 'production') attributes.push('Secure');
  response.headers.append('Set-Cookie', attributes.join('; '));
}
