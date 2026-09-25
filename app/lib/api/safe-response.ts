/**
 * Consistent API response helpers.
 * Never exposes internal error details to the client.
 */

import { NextResponse } from 'next/server';

/**
 * Return a success response with consistent shape.
 *
 * Response body: `{ success: true, data: T }`
 */
export function apiSuccess<T>(data: T, status: number = 200): NextResponse {
  return NextResponse.json({ success: true, data }, { status });
}

/**
 * Return an error response with a safe public message.
 * Internal error details are logged server-side only.
 *
 * Response body: `{ success: false, error: string }`
 */
export function apiError(
  publicMessage: string,
  status: number = 400,
  internalError?: unknown,
): NextResponse {
  // Log internal details server-side for debugging
  if (internalError) {
    console.error(`[API Error] ${publicMessage}:`, internalError);
  }

  return NextResponse.json(
    { success: false, error: publicMessage },
    { status },
  );
}

/**
 * Return a 429 Too Many Requests response with Retry-After header.
 */
export function apiRateLimited(retryAfterMs: number): NextResponse {
  const retryAfterSeconds = Math.ceil(retryAfterMs / 1000);

  return NextResponse.json(
    { success: false, error: 'Too many requests. Please try again later.' },
    {
      status: 429,
      headers: { 'Retry-After': String(retryAfterSeconds) },
    },
  );
}

/**
 * Mark a response as never to be kept by a browser or a CDN. For routes that
 * return personal data, and for reads that must reflect the last write.
 */
export function noStore(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

/**
 * Return a 422 Unprocessable Entity response with typed validation issues.
 * Field-level errors are safe to surface to the client.
 *
 * Response body: `{ success: false, error: string, issues: { path: string, message: string }[] }`
 */
export function apiValidationError(
  issues: { path: string; message: string }[],
): NextResponse {
  return NextResponse.json(
    { success: false, error: 'Validation failed', issues },
    { status: 422 },
  );
}


/**
 * Return a failure with a machine-readable `code` alongside the public message,
 * so the caller can tell *which* failure happened rather than only that one did.
 *
 * Response body: `{ success: false, error, code, hint?, evidence? }`
 */
export function apiFailure(opts: {
  message: string;
  status: number;
  code: string;
  /** Short, operator-actionable next step. */
  hint?: string;
  /** Safe-to-surface evidence (page title, section counts…) — never internals. */
  evidence?: Record<string, string | number>;
  /** Logged server-side only. */
  internalError?: unknown;
}): NextResponse {
  if (opts.internalError) {
    console.error(`[API Failure ${opts.code}] ${opts.message}:`, opts.internalError);
  }

  return NextResponse.json(
    {
      success: false,
      error: opts.message,
      code: opts.code,
      ...(opts.hint ? { hint: opts.hint } : {}),
      ...(opts.evidence ? { evidence: opts.evidence } : {}),
    },
    { status: opts.status },
  );
}
