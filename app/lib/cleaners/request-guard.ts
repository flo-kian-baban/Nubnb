/**
 * Refusals for cross-site and wrongly typed requests, on the routes that
 * change cleaner data: POST and PATCH /api/admin/cleaners*, POST and DELETE
 * /api/cleaner/session and POST /api/cleaner/entries.
 *
 * SameSite=Strict already withholds both session cookies from a cross-site
 * request. These are the second layer, and they are needed because checking
 * for JSON is not a CORS preflight: a `text/plain` or multipart POST is a
 * "simple" request, which a page on any origin can send without one.
 *
 *   refuseCrossSite    a request whose Sec-Fetch-Site header is present and
 *                      is anything but `same-origin` is refused, 403.
 *                      Browsers always send the header; curl and other
 *                      non-browser callers send none and are not affected.
 *   requireMediaType   the media type — Content-Type up to any `;` — must be
 *                      the one the route reads, or 415.
 *
 * Existing routes are not changed. Each check returns a finished response
 * for the route to send, or null to carry on:
 *
 *   const refused = refuseCrossSite(request);
 *   if (refused) return refused;
 */

import type { NextResponse } from 'next/server';
import { apiFailure, noStore } from '@/app/lib/api/safe-response';

/** The request bodies the cleaner routes read. */
export type ExpectedMediaType = 'application/json' | 'multipart/form-data';

/** 403 CROSS_SITE_REFUSED for a browser request from another site, else null. */
export function refuseCrossSite(request: Request): NextResponse | null {
  const site = request.headers.get('sec-fetch-site');
  if (site === null || site === 'same-origin') return null;

  return noStore(
    apiFailure({
      message: 'Requests from other sites are refused.',
      status: 403,
      code: 'CROSS_SITE_REFUSED',
      hint: 'Use this page on the Nubnb site itself.',
    }),
  );
}

/** 415 UNSUPPORTED_CONTENT_TYPE unless the body is declared as `expected`, else null. */
export function requireMediaType(request: Request, expected: ExpectedMediaType): NextResponse | null {
  const declared = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (declared === expected) return null;

  return noStore(
    apiFailure({
      message: 'Unsupported content type.',
      status: 415,
      code: 'UNSUPPORTED_CONTENT_TYPE',
      hint: `Send the body as ${expected}.`,
    }),
  );
}
