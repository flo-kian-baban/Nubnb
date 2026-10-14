/**
 * How admin PINs are compared, and the connection's keyed hash (dispatch 38).
 * Server-only.
 *
 * ── Stored readably (Kian's rulings of 2026-10-13, night and late night) ──
 * The main admin sets each admin's PIN, and main admins see every PIN, so a
 * PIN is kept as it is: four digits, on its admin's document (`pin: { state:
 * 'readable', value }`) and as the ID of its `admin_pins/{PIN}` document,
 * which names the admin — the way `cleaner_codes/{code}` works. No four digits
 * are both an admin's PIN and a cleaner code (server-admins.ts). samePin
 * compares two PINs in constant time.
 *
 * ── The connection ──
 * connectionKey: HMAC-SHA256(ADMIN_PIN_KEY, "nubnb:admin-connection:v1:" +
 * the address as model.ts normalizes it), hex. The address is never stored.
 *
 * ── The shared PIN ──
 * ADMIN_PIN, four digits like every PIN, stays as the recovery script's PIN
 * only, compared in constant time; nothing about it is written anywhere.
 *
 * ── PINs kept before ──
 * The first version's salted hashes, the evening's lookup keys and the
 * night's six digits are no longer read: they sign in no more, and their
 * holders' PINs are set again — by a main admin, or through the recovery
 * script (Kian's rulings of 2026-10-13, late night).
 *
 * Nothing here logs a PIN, an address or a key.
 */

import { createHmac, timingSafeEqual } from 'crypto';

const CONNECTION_LABEL = 'nubnb:admin-connection:v1:';

/** Whether two PINs are the same, in constant time. */
export function samePin(a: string, b: string): boolean {
  const x = Buffer.from(a.padEnd(8, '\0'), 'utf8');
  const y = Buffer.from(b.padEnd(8, '\0'), 'utf8');
  return x.length === y.length && timingSafeEqual(x, y) && a.length === b.length;
}

/** The keyed hash a connection's lock is kept under: 64 hex characters. */
export function connectionKey(pinKey: Buffer, address: string): string {
  return createHmac('sha256', pinKey).update(`${CONNECTION_LABEL}${address}`, 'utf8').digest('hex');
}

/** The shared PIN as configured, or null when ADMIN_PIN is not four digits (sign-in takes four). */
function sharedPin(): string | null {
  const shared = process.env.ADMIN_PIN;
  return shared && /^[0-9]{4}$/.test(shared) ? shared : null;
}

/** How many digits the shared PIN has — four — or null when ADMIN_PIN is not four digits. */
export function sharedPinLength(): number | null {
  return sharedPin()?.length ?? null;
}

/** Whether `typed` is the shared PIN, compared in constant time; null when ADMIN_PIN is not four digits. */
export function sharedPinMatches(typed: string): boolean | null {
  const shared = sharedPin();
  if (shared === null) return null;
  return samePin(typed, shared);
}
