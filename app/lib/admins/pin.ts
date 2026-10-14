/**
 * How admin PINs are checked (dispatch 38). Server-only.
 *
 * ── Stored readably (Kian's rulings of 2026-10-13, night) ──
 * The main admin sets each admin's PIN, and main admins see every PIN, so a
 * PIN is kept as it is: on its admin's document (`pin: { state: 'readable',
 * value }`) and as the ID of its `admin_pins/{PIN}` document, which names the
 * admin — the way `cleaner_codes/{code}` works. Sign-in reads that one
 * document; no hash. `create()` on it keeps PINs unique. samePin compares two
 * PINs in constant time.
 *
 * ── The connection ──
 * connectionKey: HMAC-SHA256(ADMIN_PIN_KEY, "nubnb:admin-connection:v1:" +
 * the address as model.ts normalizes it), hex. The address is never stored.
 *
 * ── The shared PIN ──
 * ADMIN_PIN stays as the recovery script's PIN only, compared in constant
 * time; nothing about it is written anywhere.
 *
 * ── PINs kept before they were readable ──
 * The first version kept chosen PINs as salted hashes (`scheme:
 * 'scrypt-hmac-v1'`); the evening generated PINs and kept a lookup key
 * (`scheme: 'lookup-v1'`). Neither signs in any more. pinMatches and
 * pinLookup check one against its own admin's document, when that admin,
 * signed in, sets their PIN.
 *
 * Nothing here logs a PIN, a hash, an address or a key.
 */

import { createHmac, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'crypto';

/** The evening's generated PINs, kept as a lookup key. */
export const PIN_LOOKUP_SCHEME = 'lookup-v1';
/** The first version's chosen PINs, kept as salted hashes. */
export const PIN_HASH_SCHEME = 'scrypt-hmac-v1';

const PARAMS = { N: 32768, r: 8, p: 1 } as const;
const KEY_BYTES = 32;
/** scrypt needs 128·N·r bytes: 32 MiB here. Node's default ceiling is exactly that, so give it room. */
const MAX_MEM = 64 * 1024 * 1024;
const LOOKUP_LABEL = 'nubnb:admin-pin-lookup:v1:';
/** The evening's lookup gave the same key for the same PIN, so its salt was fixed. */
const LOOKUP_SALT = Buffer.from('nubnb admin pin lookup v1', 'utf8');
const CONNECTION_LABEL = 'nubnb:admin-connection:v1:';
const LEGACY_LABEL = 'nubnb:admin-pin:v1:';

function stretch(input: Buffer, salt: Buffer, params: { N: number; r: number; p: number }): Promise<Buffer> {
  const options: ScryptOptions = { N: params.N, r: params.r, p: params.p, maxmem: MAX_MEM };
  return new Promise((resolve, reject) => {
    scrypt(input, salt, KEY_BYTES, options, (err, derived) => (err ? reject(err) : resolve(derived)));
  });
}

/** The evening's lookup key of a PIN (64 hex characters), to check a PIN generated then against its admin's document. */
export async function pinLookup(pinKey: Buffer, pin: string): Promise<string> {
  const keyed = createHmac('sha256', pinKey).update(`${LOOKUP_LABEL}${pin}`, 'utf8').digest();
  return (await stretch(keyed, LOOKUP_SALT, PARAMS)).toString('hex');
}

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

/** The shared PIN as configured, or null when ADMIN_PIN is not four to six digits. */
function sharedPin(): string | null {
  const shared = process.env.ADMIN_PIN;
  return shared && /^[0-9]{4,6}$/.test(shared) ? shared : null;
}

/** How many digits the shared PIN has, or null when ADMIN_PIN is not set to four to six digits. */
export function sharedPinLength(): number | null {
  return sharedPin()?.length ?? null;
}

/** Whether `typed` is the shared PIN, compared in constant time; null when ADMIN_PIN is not set to four to six digits. */
export function sharedPinMatches(typed: string): boolean | null {
  const shared = sharedPin();
  if (shared === null) return null;
  const a = Buffer.from(typed.padEnd(8, '\0'), 'utf8');
  const b = Buffer.from(shared.padEnd(8, '\0'), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b) && typed.length === shared.length;
}

// ─── The first version's chosen PINs, as salted hashes ──

/** A stored hash of dispatch 38's first version, if it is one with parameters this module will run; else null. */
export function readStoredPinHash(value: unknown): { salt: string; hash: string; N: number; r: number; p: number } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.scheme !== PIN_HASH_SCHEME || typeof v.salt !== 'string' || typeof v.hash !== 'string') return null;
  const { N, r, p } = v;
  if (typeof N !== 'number' || typeof r !== 'number' || typeof p !== 'number') return null;
  // A power of two from 2^14 to 2^20, and r and p in reason: nothing stored can make a check hang the server.
  if (!Number.isInteger(Math.log2(N)) || N < 16384 || N > 1048576 || !Number.isInteger(r) || r < 1 || r > 16 || !Number.isInteger(p) || p < 1 || p > 4) return null;
  if (Buffer.from(v.salt, 'base64url').length < 16 || Buffer.from(v.hash, 'base64url').length !== KEY_BYTES) return null;
  return { salt: v.salt, hash: v.hash, N, r, p };
}

/** Whether `typed` is the PIN a first-version hash was made from. False for anything stored that is not one. */
export async function pinMatches(pinKey: Buffer, stored: unknown, typed: string): Promise<boolean> {
  const hash = readStoredPinHash(stored);
  if (!hash) {
    await stretch(randomBytes(32), randomBytes(16), PARAMS);
    return false;
  }
  const keyed = createHmac('sha256', pinKey).update(`${LEGACY_LABEL}${typed}`, 'utf8').digest();
  const derived = await stretch(keyed, Buffer.from(hash.salt, 'base64url'), hash);
  return timingSafeEqual(derived, Buffer.from(hash.hash, 'base64url'));
}
