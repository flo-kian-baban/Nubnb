/**
 * Cleaner codes: how one is drawn, and which are never issued.
 *
 * A code is four digits, drawn uniformly from the operating system's CSPRNG.
 * Ten thousand codes and no rate limiting mean the cleaner door can be
 * brute-forced; that is an accepted risk (CLAUDE.md).
 *
 * ── Stored readably ──
 * By Kian's ruling of 2026-09-28, an admin can read a cleaner's code at any
 * time and change it. The code is stored as it is: it is the ID of its
 * `cleaner_codes` document, the index that keeps codes unique, and the
 * cleaner's document points at it (`code`). There is no hash and no pepper.
 * A copy of the database is therefore a copy of every cleaner code.
 *
 * Codes issued before the ruling were stored as keyed digests (schema
 * version 1). Those documents are kept but never read at the cleaner door:
 * a cleaner with only a digest has no working code until an admin sets one.
 */

import { randomInt, timingSafeEqual } from 'crypto';
import { isTooEasyCode } from './model';

/** Digits in a code. The same as the admin PIN, which is why the PIN itself is never a code. */
export const CODE_LENGTH = 4;

/**
 * One candidate code: four digits, leading zeros kept, uniform over
 * 0000–9999.
 *
 * Deliberately exactly `randomInt(0, 10_000)`, synchronous, with nothing
 * injected: the generator is the operating system's, and the reserved-code
 * check below runs on whatever it returns.
 */
export function generateCandidate(): string {
  return String(randomInt(0, 10_000)).padStart(CODE_LENGTH, '0');
}

/**
 * Whether this code is the admin PIN.
 *
 * The /admin PIN gate takes four digits and submits the moment the fourth is
 * in, so a cleaner whose code were the admin PIN would open /admin with it.
 * That one code is never issued, and never accepted as a new code.
 *
 * The PIN is only compared, in constant time. A PIN of any other length
 * cannot equal a code. An empty PIN is refused before this is reached; were
 * one to get here, every code would count as the PIN.
 */
function isAdminPin(code: string, adminPin: string): boolean {
  if (adminPin.length === 0) return true;

  const candidate = Buffer.from(code, 'utf8');
  const pin = Buffer.from(adminPin, 'utf8');
  if (candidate.length !== pin.length) return false;
  return timingSafeEqual(candidate, pin);
}

/** Why a code may never be a cleaner's, or null if it may. */
export type ReservedReason = 'admin-pin' | 'too-easy';

/**
 * Whether a code is reserved: the admin PIN, or on the reserved list (the
 * twenty-four too easy to guess: isTooEasyCode in model.ts). Issuance draws
 * again; a code an admin types is refused with the reason.
 *
 * A code an active account holds now is refused too, but that is a fact
 * about the database, not the digits: the transaction that writes the
 * code's `cleaner_codes` document checks it (server-cleaners.ts). Any other
 * code — replaced, a deleted account's, a deactivated account's — is free
 * (Kian's ruling of 2026-10-02).
 */
export function reservedReason(code: string, adminPin: string): ReservedReason | null {
  if (isAdminPin(code, adminPin)) return 'admin-pin';
  if (isTooEasyCode(code)) return 'too-easy';
  return null;
}
