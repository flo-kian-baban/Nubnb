/**
 * The connection a cleaner's sign-in comes from, as the cleaner door's lock
 * counts it (Kian's ruling of 2026-10-14, evening: the cleaner door gets the
 * admin door's lock). Server-only.
 *
 * The address is read and normalized exactly as the admin door does
 * (admins/connection.ts: `x-real-ip`, then the first `x-forwarded-for`, both
 * set by Vercel; an IPv6 address cut to its /64) and turned at once into its
 * keyed hash under the cleaner key, CLEANER_SESSION_SECRET, with a label of
 * its own: the cleaner door shares no key with the admin door, and the two
 * doors' hashes of one address differ. Only the hash is ever stored or
 * logged.
 */

import { createHmac } from 'crypto';
import { normalizeAddress } from '@/app/lib/admins/model';

const CONNECTION_LABEL = 'nubnb:cleaner-connection:v1:';

/** The keyed hash a connection's cleaner lock is kept under: 64 hex characters. */
export function cleanerConnectionKey(sessionKey: Buffer, address: string): string {
  return createHmac('sha256', sessionKey).update(`${CONNECTION_LABEL}${address}`, 'utf8').digest('hex');
}

/** The keyed hash of the connection a request came from. A request with no address counts as one shared connection, "unknown". */
export function cleanerConnectionOf(request: Request, sessionKey: Buffer): string {
  const real = request.headers.get('x-real-ip');
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0];
  const address = normalizeAddress(real) ?? normalizeAddress(forwarded) ?? 'unknown';
  return cleanerConnectionKey(sessionKey, address);
}
