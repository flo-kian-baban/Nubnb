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
 *
 * ── Codes that appeared in Nubnb's public code (security rule, 2026-10-19) ──
 * The repository is public. A code or PIN ever issued whose four digits appear
 * anywhere in its git history is never given out again: not drawn, and
 * refused when typed. The list is kept out of the repository, as keyed hashes
 * in the server's environment — CLEANER_CODE_DENYLIST, comma-separated
 * HMAC-SHA256 of each code under CLEANER_SESSION_SECRET with the label below —
 * made by scripts/code-denylist.mjs from the history and an export. With the
 * list set and no key to check it, issuance fails closed.
 */

import { createHmac, randomInt, timingSafeEqual } from 'crypto';
import { isTooEasyCode } from './model';

/** The label under which a code is hashed into the denylist: a hash of the same digits for another purpose never matches. */
const DENYLIST_LABEL = 'nubnb:code-denylist:v1:';

/** The environment variable that holds the denylist's hashes. */
export const CODE_DENYLIST_VAR = 'CLEANER_CODE_DENYLIST';

/** The hashes of the codes never given out, with the key they were made under. */
export interface CodeDenylist {
  hashes: ReadonlySet<string>;
  key: Buffer;
}

/** A code's entry in the denylist: HMAC-SHA256, hex, under the cleaner key. */
export function denylistHash(code: string, key: Buffer): string {
  return createHmac('sha256', key).update(`${DENYLIST_LABEL}${code}`, 'utf8').digest('hex');
}

/** The denylist as an environment value: the hashes, comma-separated, sorted. */
export function denylistValue(codes: readonly string[], key: Buffer): string {
  return [...new Set(codes.map((code) => denylistHash(code, key)))].sort().join(',');
}

/**
 * The denylist the server holds: `none` when CLEANER_CODE_DENYLIST is not set
 * (nothing is denied), `unkeyed` when it is set but there is no key to check
 * it with (issuance then fails closed), else the hashes and the key.
 */
export function readCodeDenylist(value: string | undefined, key: Buffer | null): { kind: 'ok'; denylist: CodeDenylist } | { kind: 'none' } | { kind: 'unkeyed' } {
  const hashes = (value ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => /^[0-9a-f]{64}$/.test(h));
  if (hashes.length === 0) return { kind: 'none' };
  if (!key) return { kind: 'unkeyed' };
  return { kind: 'ok', denylist: { hashes: new Set(hashes), key } };
}

/** Whether a code is on the denylist: it has appeared in Nubnb's public code. */
export function isPublicCode(code: string, denylist: CodeDenylist | null | undefined): boolean {
  return !!denylist && denylist.hashes.has(denylistHash(code, denylist.key));
}

/** The one plain line a typed code on the list is refused with (Kian's ruling of 2026-10-17: every refusal says why). */
export const PUBLIC_CODE_REFUSAL_LINE = "That code has appeared in Nubnb's public code and is never given out.";

/** Digits in a code. The same as the admin PIN, which is why the PIN itself is never a code. */
export const CODE_LENGTH = 4;

/**
 * One candidate code: four digits, leading zeros kept, uniform over
 * the ten thousand four-digit codes.
 *
 * Deliberately exactly `randomInt(0, 10_000)`, synchronous, with nothing
 * injected: the generator is the operating system's, and the checks below
 * (reservedReason, isDrawable) run on whatever it returns.
 */
export function generateCandidate(): string {
  return String(randomInt(0, 10_000)).padStart(CODE_LENGTH, '0');
}

/**
 * Whether this code is the admin PIN — ADMIN_PIN, the shared PIN.
 *
 * Until dispatch 38 the /admin gate took that one four-digit PIN, so a
 * cleaner whose code were it would open /admin. It is now the PIN the
 * recovery script puts a main admin back on (scripts/admin-recover.mjs), so
 * it still opens /admin for them. That one code is never issued, and never
 * accepted as a new code. Admins' own PINs are four digits too (Kian's
 * rulings of 2026-10-13, late night): the transaction that gives out a code
 * refuses one an admin holds (server-cleaners.ts, codeAvailability).
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

/** Why a code may never be a cleaner's, or null if it may: the admin PIN, or a code that appeared in Nubnb's public code. */
export type ReservedReason = 'admin-pin' | 'public-history';

/**
 * Whether a code is reserved: the admin PIN. Issuance draws again; a code an
 * admin types is refused with the reason.
 *
 * Easy codes — four of one digit, straight runs — are not reserved: cleaner
 * and handyman codes may be easy codes (Kian's ruling of 2026-10-17), so an
 * admin who types an easy code (four of one digit, a straight run) gets it. Only a code drawn here or suggested
 * by the Team page's Generate skips them (isDrawable).
 *
 * A code an active account holds now is refused too, and so is an admin's
 * PIN, but those are facts about the database, not the digits: the
 * transaction that writes the code's `cleaner_codes` document checks them
 * (server-cleaners.ts). Any other code — replaced, a deleted account's, a
 * deactivated account's — is free (Kian's ruling of 2026-10-02).
 */
export function reservedReason(code: string, adminPin: string, denylist: CodeDenylist | null = null): ReservedReason | null {
  if (isAdminPin(code, adminPin)) return 'admin-pin';
  // A code that appeared in Nubnb's public code is never given out (security rule, 2026-10-19).
  if (isPublicCode(code, denylist)) return 'public-history';
  return null;
}

/**
 * Whether a drawn code may be given out: not reserved, not on the denylist,
 * and not an easy code. Nothing refuses an easy code an admin types; a code
 * chosen at random simply has no reason to be one.
 */
export function isDrawable(code: string, adminPin: string, denylist: CodeDenylist | null = null): boolean {
  return reservedReason(code, adminPin, denylist) === null && !isTooEasyCode(code);
}
