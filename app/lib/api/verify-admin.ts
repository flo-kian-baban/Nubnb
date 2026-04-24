/**
 * Admin session management.
 *
 * PIN verification:  Used once during login (admin-auth POST).
 * Session tokens:    HMAC-signed, stored in an HTTP-only cookie.
 * Session checks:    All admin API routes call verifyAdminSession() which
 *                    reads the cookie and validates the HMAC signature.
 */

import { createHmac, timingSafeEqual } from 'crypto';

// ─── Constants ─────────────────────────────────────────────────

export const SESSION_COOKIE = 'nubnb_admin_session';
export const SESSION_MAX_AGE = 24 * 60 * 60; // 24 hours (seconds)

// ─── Types ─────────────────────────────────────────────────────

export interface AdminVerification {
  valid: boolean;
  error?: string;
  status?: number;
}

// ─── Internal helpers ──────────────────────────────────────────

function getSecret(): string {
  const pin = process.env.ADMIN_PIN;
  if (!pin) throw new Error('ADMIN_PIN environment variable is not configured');
  return pin;
}

// ─── PIN verification (one-time login) ─────────────────────────

/**
 * Verify a raw PIN string against ADMIN_PIN using constant-time comparison.
 * Used only by the /api/admin-auth POST handler.
 */
export function verifyAdminPin(pin: string): AdminVerification {
  if (!pin || typeof pin !== 'string') {
    return { valid: false, error: 'PIN is required', status: 400 };
  }

  let adminPin: string;
  try {
    adminPin = getSecret();
  } catch {
    return { valid: false, error: 'Server configuration error', status: 500 };
  }

  const PAD_LENGTH = 64;
  const pinBuf = Buffer.from(pin.padEnd(PAD_LENGTH, '\0'));
  const adminBuf = Buffer.from(adminPin.padEnd(PAD_LENGTH, '\0'));

  if (pin.length !== adminPin.length || !timingSafeEqual(pinBuf, adminBuf)) {
    return { valid: false, error: 'Invalid PIN', status: 401 };
  }

  return { valid: true };
}

// ─── Session token lifecycle ───────────────────────────────────

/**
 * Create an HMAC-signed session token: `<timestamp>.<signature>`.
 * The signature is HMAC-SHA256(ADMIN_PIN, timestamp).
 */
export function createSessionToken(): string {
  const timestamp = Date.now().toString();
  const signature = createHmac('sha256', getSecret())
    .update(timestamp)
    .digest('hex');
  return `${timestamp}.${signature}`;
}

/**
 * Validate an HMAC-signed session token.
 * Checks structure, expiry (24h), and signature integrity.
 */
export function verifySessionToken(token: string): boolean {
  if (!token || typeof token !== 'string') return false;

  const dotIndex = token.indexOf('.');
  if (dotIndex === -1) return false;

  const timestamp = token.slice(0, dotIndex);
  const signature = token.slice(dotIndex + 1);

  // Check expiry
  const age = Date.now() - parseInt(timestamp, 10);
  if (isNaN(age) || age < 0 || age > SESSION_MAX_AGE * 1000) return false;

  // Recompute expected signature
  let expected: string;
  try {
    expected = createHmac('sha256', getSecret())
      .update(timestamp)
      .digest('hex');
  } catch {
    return false;
  }

  // Constant-time comparison
  if (signature.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ─── Request-level session verification ────────────────────────

/**
 * Verify the admin session from the request's HTTP-only cookie.
 * Use this in every admin-protected API route.
 */
export function verifyAdminSession(request: Request): AdminVerification {
  // Read the cookie from the Cookie header
  const cookieHeader = request.headers.get('cookie') || '';
  const match = cookieHeader.match(
    new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`)
  );
  const token = match?.[1];

  if (!token) {
    return { valid: false, error: 'Authentication required', status: 401 };
  }

  if (!verifySessionToken(decodeURIComponent(token))) {
    return { valid: false, error: 'Session expired or invalid', status: 401 };
  }

  return { valid: true };
}
