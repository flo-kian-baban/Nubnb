/**
 * The cleaner door's key, read from the environment.
 *
 *   CLEANER_SESSION_SECRET  signs cleaner session tokens. Rotate at will:
 *                           every cleaner is signed out, no data changes.
 *
 * It is base64url of 32 random bytes —
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
 * — and the key is the decoded bytes. Nothing here uses the admin PIN, or
 * anything derived from it, as a key.
 *
 * Codes need no key: by Kian's ruling of 2026-09-28 they are stored readably
 * (codes.ts). CLEANER_CODE_PEPPER, which keyed the digests codes were stored
 * as before that, is no longer read by the app.
 *
 * Validated lazily, inside the request, never at module scope: `next build`
 * succeeds without it, and a server without it fails closed. Every cleaner
 * route then answers 503 CLEANER_AUTH_NOT_CONFIGURED; the admin door is
 * unaffected.
 *
 * The value is never logged. A problem is reported by variable name only.
 */

import type { Refusal } from './model';

/** At least 32 bytes of base64url: 43 characters or more, nothing else. */
const KEY_FORMAT = /^[A-Za-z0-9_-]{43,}$/;
const MIN_KEY_BYTES = 32;

export interface CleanerSecrets {
  /** CLEANER_SESSION_SECRET, decoded. */
  sessionKey: Buffer;
}

export type CleanerSecretsResult = ({ kind: 'ok' } & CleanerSecrets) | { kind: 'not-configured' };

/** What every cleaner route answers when the key is missing or invalid. */
export const CLEANER_AUTH_NOT_CONFIGURED: Refusal = {
  status: 503,
  code: 'CLEANER_AUTH_NOT_CONFIGURED',
  message: 'Cleaner sign-in is not set up on this server.',
  hint: 'CLEANER_SESSION_SECRET must be set. Nothing was changed.',
};

/** The decoded key, or why it cannot be used. */
function decodeKey(name: string, value: string | undefined): Buffer | string {
  if (!value) return `${name} is not set`;
  if (!KEY_FORMAT.test(value)) return `${name} is not base64url of at least ${MIN_KEY_BYTES} bytes`;
  const key = Buffer.from(value, 'base64url');
  if (key.length < MIN_KEY_BYTES) return `${name} decodes to fewer than ${MIN_KEY_BYTES} bytes`;
  return key;
}

/**
 * The cleaner key, or `not-configured`. Call it inside a handler, never at
 * module scope.
 */
export function getCleanerSecrets(): CleanerSecretsResult {
  const sessionKey = decodeKey('CLEANER_SESSION_SECRET', process.env.CLEANER_SESSION_SECRET);
  if (typeof sessionKey === 'string') {
    console.error(`[cleaners] Cleaner key not configured: ${sessionKey}`);
    return { kind: 'not-configured' };
  }
  return { kind: 'ok', sessionKey };
}
