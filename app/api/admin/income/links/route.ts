/**
 * PUT /api/admin/income/links — Link a listing title to a property, or move its link (admin-only, dispatch 27).
 *
 * Request: `{ channel, title, propertyId, expected }` — `expected` is the
 * property the page showed the title linked to, "not-nubnb" for a title set
 * aside, or null for none. Or `{ channel, title, notNubnb: true, expected }`
 * to set the title aside as not a Nubnb property (dispatch 36, Kian's ruling
 * of 2026-10-12): it stays listed and marked, leaves the gaps count, and its
 * proposed lines are rejected; the answer then carries `rejected`, how many.
 *
 * Response: 200 `{ link }`. 404 PROPERTY_NOT_FOUND; 409 LINK_CHANGED when the
 * stored link is not `expected` (nothing changes); 422 for a title or ID that
 * is not one.
 *
 * Kian's ruling: each title is linked to one property by an admin, once, and
 * remembered. Lines already accepted stay where they went; lines still
 * proposed follow the link. Every response is no-store.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { verifyAdminSession } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { isDocumentId } from '@/app/lib/firebase/server-leads';
import { LINK_REFUSALS, linkTitle, setTitleAside } from '@/app/lib/firebase/server-income';
import { INCOME_CHANNELS, INCOME_LIMITS, NOT_NUBNB, normaliseTitle } from '@/app/lib/income/model';

const CONTROL_CHARACTER = /\p{Cc}/u;

const LinkInputSchema = z.strictObject({
  channel: z.enum(INCOME_CHANNELS),
  title: z
    .string()
    .transform(normaliseTitle)
    .pipe(z.string().min(1, 'A title').max(INCOME_LIMITS.TITLE_MAX, `At most ${INCOME_LIMITS.TITLE_MAX} characters`).refine((s) => !CONTROL_CHARACTER.test(s), 'No control characters')),
  /** The property to link it to; absent when the title is set aside. */
  propertyId: z.string().refine((id) => isDocumentId(id), 'Not a property ID').optional(),
  /** Set the title aside as not a Nubnb property (dispatch 36). */
  notNubnb: z.literal(true).optional(),
  expected: z
    .string()
    .refine((id) => id === NOT_NUBNB || isDocumentId(id), 'Not a property ID')
    .nullable(),
}).refine((input) => (input.propertyId !== undefined) !== (input.notNubnb === true), { message: 'Either a property to link it to, or notNubnb', path: ['propertyId'] });

export async function PUT(request: NextRequest) {
  const auth = verifyAdminSession(request);
  if (!auth.valid) return noStore(apiError(auth.error!, auth.status!));
  const crossSite = refuseCrossSite(request);
  if (crossSite) return crossSite;
  const wrongType = requireMediaType(request, 'application/json');
  if (wrongType) return wrongType;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return noStore(apiError('Invalid JSON body', 400));
  }
  const parsed = LinkInputSchema.safeParse(body);
  if (!parsed.success) return noStore(apiValidationError(parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))));
  const { channel, title, propertyId, notNubnb, expected } = parsed.data;
  if (notNubnb) {
    const aside = await setTitleAside({ platform: channel, title, expected });
    if (aside.kind === 'set-aside') return noStore(apiSuccess({ link: aside.link, rejected: aside.rejected }));
    return noStore(apiFailure(LINK_REFUSALS[aside.kind]));
  }
  const outcome = await linkTitle({ platform: channel, title, propertyId: propertyId!, expected });
  if (outcome.kind === 'linked') return noStore(apiSuccess({ link: outcome.link }));
  return noStore(apiFailure(LINK_REFUSALS[outcome.kind]));
}
