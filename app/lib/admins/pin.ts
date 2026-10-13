/**
 * How admin PINs are kept and checked (dispatch 38). Server-only.
 *
 * ── Stored ──
 * Never as typed. A PIN is first keyed with ADMIN_PIN_KEY (HMAC-SHA256 over
 * a label and the PIN), then stretched with scrypt and a random 16-byte salt:
 *
 *   hash = scrypt(HMAC-SHA256(ADMIN_PIN_KEY, "nubnb:admin-pin:v1:" + pin), salt, 32)
 *
 * The admin document keeps the scheme, the salt, the hash and scrypt's
 * parameters (N 2^15, r 8, p 1: 32 MiB and some tens of milliseconds a check),
 * so they can be raised later without stranding anyone. A six-digit PIN has a
 * million values, which no hash protects on its own; the key is what makes a
 * copy of the database useless for finding one, since it never leaves the
 * environment. Unlike cleaner codes, nobody can read an admin's PIN back, the
 * main admin included.
 *
 * ── The shared PIN ──
 * Kian's ruling: today's shared PIN becomes the main admin's until he changes
 * it. It stays where it is, ADMIN_PIN in the environment, and is compared in
 * constant time; nothing about it is written anywhere.
 *
 * ── Timing ──
 * Every check costs one scrypt, whichever way it goes: a shared-PIN check and
 * a name nobody holds spend one too (spendAPinCheck), so how long a sign-in
 * takes does not say whether the name exists or which kind of PIN it has.
 *
 * Nothing here logs a PIN, a hash or a key.
 */

import { createHmac, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'crypto';

export const PIN_HASH_SCHEME = 'scrypt-hmac-v1';

const PARAMS = { N: 32768, r: 8, p: 1 } as const;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
/** scrypt needs 128·N·r bytes: 32 MiB here. Node's default ceiling is exactly that, so give it room. */
const MAX_MEM = 64 * 1024 * 1024;
const LABEL = 'nubnb:admin-pin:v1:';

/** A PIN as an admin document holds it. Never the PIN. */
export interface StoredPinHash {
  scheme: typeof PIN_HASH_SCHEME;
  /** base64url of 16 random bytes. */
  salt: string;
  /** base64url of scrypt's 32 bytes. */
  hash: string;
  N: number;
  r: number;
  p: number;
}

function stretch(input: Buffer, salt: Buffer, params: { N: number; r: number; p: number }): Promise<Buffer> {
  const options: ScryptOptions = { N: params.N, r: params.r, p: params.p, maxmem: MAX_MEM };
  return new Promise((resolve, reject) => {
    scrypt(input, salt, KEY_BYTES, options, (err, derived) => (err ? reject(err) : resolve(derived)));
  });
}

function keyed(pinKey: Buffer, pin: string): Buffer {
  return createHmac('sha256', pinKey).update(`${LABEL}${pin}`, 'utf8').digest();
}

/** A new PIN's hash, with a fresh salt. */
export async function hashPin(pinKey: Buffer, pin: string): Promise<StoredPinHash> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await stretch(keyed(pinKey, pin), salt, PARAMS);
  return { scheme: PIN_HASH_SCHEME, salt: salt.toString('base64url'), hash: hash.toString('base64url'), ...PARAMS };
}

/** The stored hash, if it is one this module wrote with parameters it will run; else null. */
export function readStoredPinHash(value: unknown): StoredPinHash | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.scheme !== PIN_HASH_SCHEME || typeof v.salt !== 'string' || typeof v.hash !== 'string') return null;
  const { N, r, p } = v;
  if (typeof N !== 'number' || typeof r !== 'number' || typeof p !== 'number') return null;
  // A power of two from 2^14 to 2^20, and r and p in reason: nothing stored can make a check hang the server.
  if (!Number.isInteger(Math.log2(N)) || N < 16384 || N > 1048576 || !Number.isInteger(r) || r < 1 || r > 16 || !Number.isInteger(p) || p < 1 || p > 4) return null;
  if (Buffer.from(v.salt, 'base64url').length < SALT_BYTES || Buffer.from(v.hash, 'base64url').length !== KEY_BYTES) return null;
  return { scheme: PIN_HASH_SCHEME, salt: v.salt, hash: v.hash, N, r, p };
}

/** Whether `typed` is the PIN `stored` was made from. False for anything stored that is not a hash this module wrote. */
export async function pinMatches(pinKey: Buffer, stored: unknown, typed: string): Promise<boolean> {
  const hash = readStoredPinHash(stored);
  if (!hash) {
    await spendAPinCheck();
    return false;
  }
  const derived = await stretch(keyed(pinKey, typed), Buffer.from(hash.salt, 'base64url'), hash);
  return timingSafeEqual(derived, Buffer.from(hash.hash, 'base64url'));
}

/** One scrypt on nothing, so a check that needs none takes as long as one that does. */
export async function spendAPinCheck(): Promise<void> {
  await stretch(randomBytes(32), randomBytes(SALT_BYTES), PARAMS);
}

/**
 * Whether `typed` is the shared PIN, ADMIN_PIN, compared in constant time;
 * null when ADMIN_PIN is not set to four to six digits, so no PIN can match it.
 * Spends one scrypt either way.
 */
export async function sharedPinMatches(typed: string): Promise<boolean | null> {
  await spendAPinCheck();
  const shared = process.env.ADMIN_PIN;
  if (!shared || !/^[0-9]{4,6}$/.test(shared)) return null;
  const a = Buffer.from(typed.padEnd(8, '\0'), 'utf8');
  const b = Buffer.from(shared.padEnd(8, '\0'), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b) && typed.length === shared.length;
}
