/**
 * How admin PINs are found, generated and checked (dispatch 38). Server-only.
 *
 * ── Found by lookup (Kian's ruling of 2026-10-13, evening: the PIN
 *    identifies the admin) ──
 * Each PIN is turned into one lookup key, deterministic so the same PIN
 * always gives the same key:
 *
 *   lookup = hex(scrypt(HMAC-SHA256(ADMIN_PIN_KEY, "nubnb:admin-pin-lookup:v1:" + pin), fixed salt, 32))
 *
 * The key is the ID of the PIN's `admin_pins` document, which names its
 * admin, and the admin document holds the same key. Sign-in computes it once
 * from the typed PIN and reads that one document: one hash and one read,
 * however many admins there are, and no admin's hash is ever tried. The PIN
 * itself is stored nowhere. Without ADMIN_PIN_KEY, which lives only in the
 * environment, a copy of the database cannot be turned back into PINs; with
 * it, scrypt (N 2^15, r 8, p 1) still makes each of the million guesses
 * cost tens of milliseconds. The `admin_pins` document is created with
 * `create()`, which fails if any admin already holds that PIN: that is what
 * keeps PINs unique.
 *
 * ── Generated, never chosen ──
 * drawPin: six digits from the operating system's CSPRNG, never one of the
 * too-easy twenty (model.ts) and never ADMIN_PIN. Uniqueness is the caller's,
 * through the `admin_pins` document.
 *
 * ── The connection ──
 * connectionKey: HMAC-SHA256(ADMIN_PIN_KEY, "nubnb:admin-connection:v1:" +
 * the address as model.ts normalizes it), hex. The address is never stored.
 *
 * ── The shared PIN ──
 * ADMIN_PIN stays as the recovery script's PIN only, compared in constant
 * time; nothing about it is written anywhere.
 *
 * ── Dispatch 38's first version ──
 * Chosen PINs were kept as salted hashes (`scheme: 'scrypt-hmac-v1'`). None
 * is written any more; pinMatches checks one against its own admin's
 * document, when that admin, signed in, asks for a new PIN.
 *
 * Nothing here logs a PIN, a hash, an address or a key.
 */

import { createHmac, randomBytes, randomInt, scrypt, timingSafeEqual, type ScryptOptions } from 'crypto';
import { PIN_LENGTH, isTooEasyPin } from './model';

export const PIN_LOOKUP_SCHEME = 'lookup-v1';
export const PIN_HASH_SCHEME = 'scrypt-hmac-v1';

const PARAMS = { N: 32768, r: 8, p: 1 } as const;
const KEY_BYTES = 32;
/** scrypt needs 128·N·r bytes: 32 MiB here. Node's default ceiling is exactly that, so give it room. */
const MAX_MEM = 64 * 1024 * 1024;
const LOOKUP_LABEL = 'nubnb:admin-pin-lookup:v1:';
/** The lookup must give the same key for the same PIN, so its salt is fixed: ADMIN_PIN_KEY is what keeps it secret. */
const LOOKUP_SALT = Buffer.from('nubnb admin pin lookup v1', 'utf8');
const CONNECTION_LABEL = 'nubnb:admin-connection:v1:';
const LEGACY_LABEL = 'nubnb:admin-pin:v1:';

function stretch(input: Buffer, salt: Buffer, params: { N: number; r: number; p: number }): Promise<Buffer> {
  const options: ScryptOptions = { N: params.N, r: params.r, p: params.p, maxmem: MAX_MEM };
  return new Promise((resolve, reject) => {
    scrypt(input, salt, KEY_BYTES, options, (err, derived) => (err ? reject(err) : resolve(derived)));
  });
}

/** The lookup key of a PIN: 64 hex characters, the ID of its `admin_pins` document. */
export async function pinLookup(pinKey: Buffer, pin: string): Promise<string> {
  const keyed = createHmac('sha256', pinKey).update(`${LOOKUP_LABEL}${pin}`, 'utf8').digest();
  return (await stretch(keyed, LOOKUP_SALT, PARAMS)).toString('hex');
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

/**
 * A new PIN: six digits, uniform over 000000–999999, drawn again while it is
 * too easy or the shared PIN. Exactly `randomInt(0, 1_000_000)`, the
 * operating system's generator; `next` is there only for the tests to feed it
 * numbers.
 */
export function drawPin(next: () => number = () => randomInt(0, 1_000_000)): string {
  const shared = sharedPin();
  for (;;) {
    const pin = String(next()).padStart(PIN_LENGTH, '0');
    if (/^[0-9]{6}$/.test(pin) && !isTooEasyPin(pin) && pin !== shared) return pin;
  }
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

// ─── Dispatch 38's first version: chosen PINs as salted hashes ──

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
