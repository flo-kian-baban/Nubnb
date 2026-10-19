/**
 * PATCH  /api/admin/cleaners/[id] — Deactivate or reactivate a cleaner (admin-only).
 * DELETE /api/admin/cleaners/[id] — Delete a cleaner or a handyman for good (admin-only).
 *
 * ── DELETE (Kian's ruling of 2026-10-02) ──
 * An optional JSON body `{ regular?: { [propertyId]: cleanerId | null } }` (Kian's
 * ruling K4 of 2026-10-19: the replacement regular cleaner for each property
 * the person is regular cleaner for — another active cleaner, or null for
 * nobody — applied in the same transaction and recorded in each property's
 * regular-cleaner history; existing jobs are not changed). One transaction
 * (deleteCleaner) deletes the account and retires every code it ever had, so
 * none is given out again; a phone signed in as them is signed out on its
 * next request; their entries stay on the ledger under the name they were
 * logged with. Answers 200 `{ deleted: { id, codes }, jobsTakenOff, regular }`
 * — `codes` is how many code documents were retired, `regular` what each
 * replacement did. Refusals: 404 CLEANER_NOT_FOUND (nothing deleted); 502
 * CLEANER_DELETE_FAILED (may or may not have been deleted); 409
 * MEMBER_HAS_BALANCE (Kian's ruling of 2026-10-15: a team member whose balance
 * is not zero cannot be deleted; the refusal names the balance and says to
 * deactivate instead) or 409 MEMBER_HAS_OUTSTANDING (Kian's ruling K3 of
 * 2026-10-19: nor one with a cleaning with no amount, or a receipt or work
 * not yet decided; the refusal names what is outstanding and points to
 * Deactivate). The page confirms first, naming what is lost; the server does
 * not ask again.
 *
 * ── PATCH ──
 * Accepts `{ status, regular? }` and nothing else — `regular` as the DELETE's,
 * applied on a deactivation (K4). A change is one transaction: it sets
 * the status, appends a history event with the admin as its actor, and bumps
 * the cleaner's session epoch, so every session they hold ends on its next
 * request — and stays ended after a reactivation, which covers a lost phone.
 * Their code is untouched: deactivation stops it working, reactivation makes
 * it work again (a new code is POST /api/admin/cleaners/[id]/code). Setting the status a cleaner already has writes nothing and
 * answers `changed: false`. See setCleanerStatus.
 *
 * Entries are not touched either way; each keeps the name it was logged
 * under. The page changes a row only from the cleaner this returns: status
 * changes are not optimistic.
 *
 * Order: the admin session, then the cross-site and media-type refusals, then
 * the ID, the JSON and the schema, then the work. Every response is no-store,
 * the refusals included.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { adminRoute } from '@/app/lib/api/verify-admin';
import {
  apiSuccess,
  apiError,
  apiFailure,
  apiValidationError,
  noStore,
} from '@/app/lib/api/safe-response';
import { CLEANER_STATUSES, type Refusal } from '@/app/lib/cleaners/model';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { DELETE_CLEANER_REFUSALS, deleteCleaner, setCleanerStatus, type SetCleanerStatusResult } from '@/app/lib/firebase/server-cleaners';
import { isDocumentId } from '@/app/lib/firebase/server-leads';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const DOC_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The replacements (Kian's ruling K4): at most 60 properties, each another cleaner's ID or null for nobody. */
const ReplacementsSchema = z.record(z.string().regex(DOC_ID, 'A property ID'), z.string().regex(DOC_ID, 'A cleaner ID, or null for nobody').nullable()).refine((r) => Object.keys(r).length <= 60, 'At most 60 properties');

/** Strict: a body that carries anything besides `status` and `regular` is refused, not trimmed. */
const StatusChangeSchema = z.strictObject({
  status: z.enum(CLEANER_STATUSES),
  regular: ReplacementsSchema.optional(),
});

/** The DELETE's optional body. */
const DeleteSchema = z.strictObject({
  regular: ReplacementsSchema.optional(),
});

/** What the PATCH answers for every outcome but `done`. */
const STATUS_REFUSALS: Record<Exclude<SetCleanerStatusResult['kind'], 'done'>, Refusal> = {
  'not-found': {
    status: 404,
    code: 'CLEANER_NOT_FOUND',
    message: 'Cleaner not found',
  },
  unreadable: {
    status: 500,
    code: 'CLEANER_RECORD_UNREADABLE',
    message: 'This cleaner’s stored record is not in the shape a status change needs.',
    hint: 'Nothing was changed.',
  },
  // The transaction failed. A failure can come after the commit landed, so
  // this does not claim that nothing was saved.
  failed: {
    status: 502,
    code: 'CLEANER_UPDATE_FAILED',
    message: 'Could not save the status change.',
    hint: 'It may or may not have been saved. Reload to see the stored status.',
  },
};

export const PATCH = adminRoute(async function PATCH(request: NextRequest, context: RouteContext, { actor }) {
  // ── Cross-site and media type ──
  const crossSite = refuseCrossSite(request);
  if (crossSite) return crossSite;
  const wrongType = requireMediaType(request, 'application/json');
  if (wrongType) return wrongType;

  const { id } = await context.params;
  if (!isDocumentId(id)) return noStore(apiError('Invalid cleaner ID', 400));

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return noStore(apiError('Invalid JSON body', 400));
  }

  // ── Validate ──
  const result = StatusChangeSchema.safeParse(body);
  if (!result.success) {
    return noStore(
      apiValidationError(
        result.error.issues.map((i) => ({
          path: i.path.map(String).join('.'),
          message: i.message,
        })),
      ),
    );
  }

  const outcome = await setCleanerStatus(actor, id, result.data.status, result.data.regular ?? {});
  if (outcome.kind !== 'done') return noStore(apiFailure(STATUS_REFUSALS[outcome.kind]));

  // The jobs a deactivation took them off (the cleaning schedule), and what each replacement did (K4): the page names them.
  return noStore(apiSuccess({ cleaner: outcome.cleaner, changed: outcome.changed, jobsTakenOff: outcome.jobsTakenOff, regular: outcome.regular }));
});

export const DELETE = adminRoute(async function DELETE(request: NextRequest, context: RouteContext, { actor }) {
  // ── Cross-site ──
  const crossSite = refuseCrossSite(request);
  if (crossSite) return crossSite;

  const { id } = await context.params;
  if (!isDocumentId(id)) return noStore(apiError('Invalid cleaner ID', 400));

  // The body is optional (the replacements, K4); when there is one it is JSON in the schema's shape.
  let regular: Record<string, string | null> = {};
  const text = (await request.text()).trim();
  if (text !== '') {
    const wrongType = requireMediaType(request, 'application/json');
    if (wrongType) return wrongType;
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return noStore(apiError('Invalid JSON body', 400));
    }
    const parsed = DeleteSchema.safeParse(body);
    if (!parsed.success) return noStore(apiValidationError(parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))));
    regular = parsed.data.regular ?? {};
  }

  const outcome = await deleteCleaner(actor, id, regular);
  if (outcome.kind === 'cannot-delete') {
    // Kian's rulings of 2026-10-15 and K3 of 2026-10-19: the refusal names the balance and what is outstanding, in the page's words (pay/checks.ts), and says to deactivate instead.
    return noStore(apiFailure({ status: 409, code: outcome.refusal.code, message: outcome.refusal.message, hint: outcome.refusal.hint, evidence: { balanceCents: outcome.balanceCents, noAmount: outcome.noAmount, waitingReview: outcome.waitingReview } }));
  }
  if (outcome.kind !== 'deleted') return noStore(apiFailure(DELETE_CLEANER_REFUSALS[outcome.kind]));
  // The account as it was, without its code: the list is the only place a code is shown. And the jobs it came off, and what each replacement did.
  return noStore(apiSuccess({ deleted: { id: outcome.cleaner.id, name: outcome.cleaner.name, role: outcome.cleaner.role, codes: outcome.codes }, jobsTakenOff: outcome.jobsTakenOff, regular: outcome.regular }));
});
