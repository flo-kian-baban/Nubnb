/**
 * POST /api/admin-auth  — Verify PIN, set HTTP-only session cookie.
 * GET  /api/admin-auth  — Check if the current session is valid.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  verifyAdminPin,
  createSessionToken,
  verifyAdminSession,
  SESSION_COOKIE,
  SESSION_MAX_AGE,
} from '@/app/lib/api/verify-admin';

/**
 * POST — Authenticate with PIN. On success, sets an HTTP-only session cookie.
 */
export async function POST(req: NextRequest) {
  try {
    const { pin } = await req.json();

    const check = verifyAdminPin(pin);
    if (!check.valid) {
      return NextResponse.json({ error: check.error }, { status: check.status });
    }

    // Create signed session token and set as HTTP-only cookie
    const token = createSessionToken();
    const isProduction = process.env.NODE_ENV === 'production';

    const response = NextResponse.json({ authenticated: true });
    response.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'strict',
      path: '/',
      maxAge: SESSION_MAX_AGE,
    });

    return response;
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
}

/**
 * GET — Check if the current session cookie is valid.
 * Used by PinGate on mount to determine auth state without trusting client storage.
 */
export async function GET(req: NextRequest) {
  const check = verifyAdminSession(req);
  if (!check.valid) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }
  return NextResponse.json({ authenticated: true });
}
