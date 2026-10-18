/**
 * POST /api/admin/cost-entries/seen — Mark many receipts approved automatically as seen, in one request (admin-only;
 * the Costs page, round 1: "Mark these n seen").
 *
 * Request:  JSON `{ entries: [{ id, seen }] }`, at most SEEN_MANY_MAX: each entry's ID and the length of its history as
 *           the page read it.
 * Response: 200 `{ success: true, data: { seen: [{ id, event }], unchanged: [id] } }` — each entry marked with the event
 *           its history took; `unchanged`, already looked at: nothing written for it.
 *           409 ENTRIES_CHANGED, 404 ENTRIES_NOT_FOUND, 409 ENTRIES_NOT_AUTO_APPROVED: nothing written, the IDs, comma-separated, in the
 *           failure's evidence. 502 ENTRIES_SEEN_FAILED: may or may not have been saved.
 *
 * One transaction that reads only the entries named (markEntriesSeen). Order: the admin session, then the cross-site
 * and media-type refusals, then the JSON and the schema, then the work. Every response is no-store.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { SEEN_MANY_MAX, markEntriesSeen } from '@/app/lib/firebase/server-cost-entries';
import { isDocumentId } from '@/app/lib/firebase/server-leads';

const SeenManySchema = z.strictObject({
  entries: z
    .array(z.strictObject({ id: z.string().refine((id) => isDocumentId(id), 'Not an entry ID'), seen: z.number().int().min(0).max(1_000_000) }))
    .min(1, 'Name at least one entry')
    .max(SEEN_MANY_MAX, `At most ${SEEN_MANY_MAX} entries`),
});

const REFUSED = {
  'changed-since': { status: 409, code: 'ENTRIES_CHANGED', message: 'Some of these entries changed since they were loaded.', hint: 'Nothing was saved. Refresh and try again.' },
  'not-found': { status: 404, code: 'ENTRIES_NOT_FOUND', message: 'Some of these entries no longer exist.', hint: 'Nothing was saved. Refresh and try again.' },
  'not-auto-approved': { status: 409, code: 'ENTRIES_NOT_AUTO_APPROVED', message: 'Some of these entries were not approved automatically.', hint: 'Nothing was saved.' },
} as const;

export const POST = adminRoute(async function POST(request: NextRequest, _context: unknown, { actor }) {
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
  const parsed = SeenManySchema.safeParse(body);
  if (!parsed.success) {
    return noStore(apiValidationError(parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))));
  }

  const outcome = await markEntriesSeen(actor, parsed.data.entries);
  if (outcome.kind === 'refused') return noStore(apiFailure({ ...REFUSED[outcome.reason], evidence: { ids: outcome.ids.join(','), count: outcome.ids.length } }));
  if (outcome.kind === 'failed') return noStore(apiFailure({ status: 502, code: 'ENTRIES_SEEN_FAILED', message: 'Could not save.', hint: 'It may or may not have been saved. Refresh to see what is stored.' }));
  return noStore(apiSuccess({ seen: outcome.seen, unchanged: outcome.unchanged }));
});
