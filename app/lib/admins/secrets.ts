/**
 * The admin door's two keys, read from the environment (dispatch 38).
 *
 *   ADMIN_SESSION_SECRET  signs admin session tokens. Kian's ruling of
 *                         2026-10-13: sessions are signed with their own
 *                         secret, no longer the PIN. Rotate at will: every
 *                         admin is signed out, no data changes.
 *   ADMIN_PIN_KEY         keys every admin PIN's hash (pin.ts), so a copy of
 *                         the database — every ./backups/ export included —
 *                         cannot be used to recover a PIN without it. Never
 *                         rotate it alone: every stored PIN stops matching.
 *                         Should it be lost, the main admin goes back to the
 *                         shared PIN with scripts/admin-recover.mjs and gives
 *                         every other admin a new PIN.
 *
 * Each is base64url of 32 random bytes —
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
 * — and the key is the decoded bytes; the same value goes in Vercel
 * Production and in `.env.local`. Nothing here uses ADMIN_PIN, or anything
 * derived from it, as a key: ADMIN_PIN is only ever compared (pin.ts).
 *
 * Validated lazily, inside the request, never at module scope: `next build`
 * succeeds without them, and a server without them fails closed. Without
 * ADMIN_SESSION_SECRET no admin can sign in and every admin route answers 503
 * ADMIN_AUTH_NOT_CONFIGURED. Without ADMIN_PIN_KEY, only the main admin on
 * the shared PIN can sign in, and no PIN can be set.
 *
 * Values are never logged. A problem is reported by variable name only.
 */

import type { Refusal } from '@/app/lib/cleaners/model';

/** At least 32 bytes of base64url: 43 characters or more, nothing else. */
const KEY_FORMAT = /^[A-Za-z0-9_-]{43,}$/;
const MIN_KEY_BYTES = 32;

/** What the admin door answers when a key it needs is missing or invalid. Nothing was changed. */
export const ADMIN_AUTH_NOT_CONFIGURED: Refusal = {
  status: 503,
  code: 'ADMIN_AUTH_NOT_CONFIGURED',
  message: 'Admin sign-in is not set up on this server.',
  hint: 'ADMIN_SESSION_SECRET and ADMIN_PIN_KEY must be set. Nothing was changed.',
};

/** The decoded key, or why it cannot be used. */
function decodeKey(name: string, value: string | undefined): Buffer | string {
  if (!value) return `${name} is not set`;
  if (!KEY_FORMAT.test(value)) return `${name} is not base64url of at least ${MIN_KEY_BYTES} bytes`;
  const key = Buffer.from(value, 'base64url');
  if (key.length < MIN_KEY_BYTES) return `${name} decodes to fewer than ${MIN_KEY_BYTES} bytes`;
  return key;
}

function read(name: 'ADMIN_SESSION_SECRET' | 'ADMIN_PIN_KEY'): Buffer | null {
  const key = decodeKey(name, process.env[name]);
  if (typeof key === 'string') {
    console.error(`[admins] Admin key not configured: ${key}`);
    return null;
  }
  return key;
}

/** ADMIN_SESSION_SECRET, decoded, or null. Call it inside a handler, never at module scope. */
export function getAdminSessionKey(): Buffer | null {
  return read('ADMIN_SESSION_SECRET');
}

/** ADMIN_PIN_KEY, decoded, or null. Call it inside a handler, never at module scope. */
export function getAdminPinKey(): Buffer | null {
  return read('ADMIN_PIN_KEY');
}
