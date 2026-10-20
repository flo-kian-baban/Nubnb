/**
 * An admin PIN against the list of codes never given out (security rule, 2026-10-19): a value that appeared in Nubnb's
 * public code is never a cleaner code and never an admin PIN either, refused with the same sentence wherever a PIN is
 * chosen or set — a new admin's (POST /api/admin/admins), an ordinary admin's by a main admin
 * (POST /api/admin/admins/[id]/pin), an admin's own (POST /api/admin-auth/pin); the recovery script mirrors it
 * (scripts/admin-pin-rules.mjs). Checked before any read, like the shared PIN; a refused value counts as no wrong try,
 * since it is public already and says nothing about any account. Server-only.
 */

import { PUBLIC_CODE_REFUSAL_LINE, isPublicCode } from '@/app/lib/cleaners/codes';
import { codeDenylist } from '@/app/lib/cleaners/denylist';
import type { Refusal } from '@/app/lib/cleaners/model';

/** 422: the PIN appeared in Nubnb's public code. Nothing was changed. */
export const PIN_IS_PUBLIC: Refusal = { status: 422, code: 'ADMIN_PIN_PUBLIC', message: PUBLIC_CODE_REFUSAL_LINE };

/** 503: the list is set but cannot be checked (no cleaner key): setting a PIN fails closed. Nothing was changed. */
export const PIN_DENYLIST_UNKEYED: Refusal = {
  status: 503,
  code: 'ADMIN_PIN_DENYLIST_UNKEYED',
  message: 'The list of codes never given out cannot be checked on this server.',
  hint: 'CLEANER_CODE_DENYLIST is set but CLEANER_SESSION_SECRET is not. Nothing was changed.',
};

/** Why a chosen PIN is refused by the list, or null: it is on the list (422), or the list cannot be checked (503). */
export function pinDenied(pin: string): Refusal | null {
  const denied = codeDenylist();
  if (denied.kind === 'unkeyed') return PIN_DENYLIST_UNKEYED;
  return isPublicCode(pin, denied.denylist) ? PIN_IS_PUBLIC : null;
}
