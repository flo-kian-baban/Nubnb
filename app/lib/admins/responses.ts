/**
 * What the admin sign-in routes answer with, shared by POST /api/admin-auth
 * and POST /api/admin-auth/pin (dispatch 38). Server-only.
 */

import { NextResponse } from 'next/server';
import { noStore } from '@/app/lib/api/safe-response';
import type { Refusal } from '@/app/lib/cleaners/model';
import type { SignedInAdmin } from '@/app/lib/firebase/server-admins';
import { LOCK_MINUTES, type SignedInAdminView } from './model';

/** The signed-in admin as a page may see them: never the epoch. */
export const signedInView = (admin: SignedInAdmin): SignedInAdminView => ({ id: admin.id, name: admin.name, level: admin.level, pin: admin.pin });

/**
 * 429 ADMIN_SIGN_IN_LOCKED, with when the lock ends and Retry-After: sign-in
 * from this connection is locked (Kian's ruling of 2026-10-13, evening).
 * `lockedNow` when this PIN was the fifth wrong one.
 */
export function lockedResponse(lockedUntil: string, lockedNow: boolean): NextResponse {
  const seconds = Math.max(1, Math.ceil((Date.parse(lockedUntil) - Date.now()) / 1000));
  return noStore(
    NextResponse.json(
      {
        success: false,
        error: lockedNow ? `Five wrong PINs: sign-in from this connection is locked for ${LOCK_MINUTES} minutes.` : 'Sign-in from this connection is locked.',
        code: 'ADMIN_SIGN_IN_LOCKED',
        lockedUntil,
        lockedNow,
      },
      { status: 429, headers: { 'Retry-After': String(seconds) } },
    ),
  );
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
  yourself: { status: 409, code: 'ADMIN_IS_YOU', message: 'Get your own new PIN from your name in the header.', hint: 'Nothing was changed.' },
};
