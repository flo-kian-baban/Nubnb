/**
 * What the admin sign-in and account routes answer with, shared by POST
 * /api/admin-auth, POST /api/admin-auth/pin and the main admin's routes
 * (dispatch 38). Server-only.
 */

import { NextResponse } from 'next/server';
import { noStore } from '@/app/lib/api/safe-response';
import type { Refusal } from '@/app/lib/cleaners/model';
import type { SignedInAdmin } from '@/app/lib/firebase/server-admins';
import { DAILY_TRIES, LOCK_MINUTES, type SignedInAdminView } from './model';

/** The signed-in admin as a page may see them: never the epoch. */
export const signedInView = (admin: SignedInAdmin): SignedInAdminView => ({ id: admin.id, name: admin.name, level: admin.level, pin: admin.pin });

/**
 * 429 ADMIN_SIGN_IN_LOCKED: sign-in from this connection is locked (Kian's
 * rulings of 2026-10-13). For fifteen minutes, with when it ends and
 * Retry-After; or, after twenty tries in a Toronto day, until a main admin
 * lifts it (`lockedUntil` null, `capped`). `lockedNow` when this try locked it.
 */
export function lockedResponse(lockedUntil: string | null, lockedNow: boolean): NextResponse {
  const capped = lockedUntil === null;
  const seconds = capped ? 0 : Math.max(1, Math.ceil((Date.parse(lockedUntil) - Date.now()) / 1_000));
  const minutes = Math.ceil(seconds / 60);
  // Why, in one plain line (Kian's ruling of 2026-10-17): the Team page shows it as it is for a typed code.
  const error = capped
    ? lockedNow
      ? `${DAILY_TRIES} tries today: sign-in from this connection is locked until a main admin lifts it.`
      : 'Too many tries today: sign-in from this connection is locked until a main admin lifts it.'
    : lockedNow
      ? `Five tries in a row: sign-in from this connection is locked for ${LOCK_MINUTES} minutes.`
      : `Too many tries in a row: sign-in from this connection is locked for ${minutes === 1 ? '1 more minute' : `${minutes} more minutes`}.`;
  const headers: Record<string, string> = capped ? {} : { 'Retry-After': String(seconds) };
  return noStore(NextResponse.json({ success: false, error, code: 'ADMIN_SIGN_IN_LOCKED', lockedUntil, capped, lockedNow }, { status: 429, headers }));
}

/** What the main admin's account routes answer when an action may not be done (accountVerdict, model.ts). Nothing was changed. */
export const ACCOUNT_REFUSALS: Record<'not-found' | 'main-admin' | 'last-main-admin' | 'yourself', Refusal> = {
  'not-found': { status: 404, code: 'ADMIN_NOT_FOUND', message: 'That admin does not exist.', hint: 'They may have been removed. Reload the list.' },
  'main-admin': {
    status: 409,
    code: 'MAIN_ADMIN_PROTECTED',
    message: 'That is a main admin: only they can remove, demote or give a new PIN to their own account.',
    hint: 'Nothing was changed.',
  },
  'last-main-admin': { status: 409, code: 'LAST_MAIN_ADMIN', message: 'You are the only main admin.', hint: 'Make another admin a main admin first. Nothing was changed.' },
  yourself: { status: 409, code: 'ADMIN_IS_YOU', message: 'Change your own PIN from your name in the header.', hint: 'Nothing was changed.' },
};

/*
 * The refusals of a PIN being set, each one plain line that says why (Kian's ruling of 2026-10-17), and the same
 * words for the main admin setting one and an admin choosing their own. Nothing was changed.
 */

/** 409: another admin holds that PIN now (PINs stay unique; one no admin holds any more may be set again). */
export const PIN_TAKEN: Refusal = { status: 409, code: 'ADMIN_PIN_TAKEN', message: 'Another admin has that PIN.' };

/** 409: a cleaner code, current or retired, is those four digits (Kian's rulings of 2026-10-13, late night, and 2026-10-17). */
export const PIN_IS_A_CODE: Refusal = { status: 409, code: 'ADMIN_PIN_IS_A_CODE', message: 'That is a cleaner code, now or before, and an admin PIN can never be one.' };

/** 409: a PIN kept before is not changed by its holder (Kian's ruling of 2026-10-13, late night). Nothing was changed. */
export const PIN_KEPT_BEFORE: Refusal = {
  status: 409,
  code: 'ADMIN_PIN_KEPT_BEFORE',
  message: 'Your PIN was set before PINs were four digits.',
  hint: 'A main admin sets a new one for you; a main admin uses the recovery script. Nothing was changed.',
};

/** 422: the PIN is the shared PIN, ADMIN_PIN, which is the recovery script's alone. Nothing was changed. */
export const PIN_IS_SHARED: Refusal = { status: 422, code: 'ADMIN_PIN_IS_SHARED', message: 'That is the shared PIN, which only the recovery script uses.' };
