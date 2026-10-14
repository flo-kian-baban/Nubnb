/**
 * The connection a sign-in comes from (Kian's ruling of 2026-10-13, evening:
 * five wrong PINs from one connection lock sign-in from that connection for
 * 15 minutes; the connection is kept only as a keyed hash, never the address
 * itself). Server-only.
 *
 * On Vercel the client's address is the `x-real-ip` header, which Vercel sets
 * from the connection it received and overwrites whatever a client sent; then
 * the first entry of `x-forwarded-for`, which Vercel also overwrites. Off
 * Vercel (a local `next start`) both are whatever the client sent: fine for a
 * test, and not something to run the admin behind. A request with neither
 * counts as one shared connection, "unknown".
 *
 * The address is normalized (an IPv6 address cut to its /64: model.ts,
 * normalizeAddress) and turned into its keyed hash at once (pin.ts,
 * connectionKey). Only the hash is ever stored or logged.
 */

import { normalizeAddress } from './model';
import { connectionKey } from './pin';

/** The keyed hash of the connection a request came from. */
export function connectionOf(request: Request, pinKey: Buffer): string {
  const real = request.headers.get('x-real-ip');
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0];
  const address = normalizeAddress(real) ?? normalizeAddress(forwarded) ?? 'unknown';
  return connectionKey(pinKey, address);
}
