/**
 * GET  /api/admin/cost-entries — Everything the costs page works from (admin-only).
 * POST /api/admin/cost-entries — Add a cost from the office (admin-only, dispatch 23D).
 *
 * GET response: 200 `{ success: true, data: { entries, exports, properties } }`
 *
 * `entries`: what cleaners spent, one receipt at a time, newest first. Each
 * entry comes with the current name and status of its cleaner and the
 * current name of its property, beside the names recorded when it was
 * logged: display prefers the live name and falls back to the recorded one.
 * A lookup that failed shows as 'unreadable' on that entry and never fails
 * the list. Each entry also carries `linesNow`, its lines with every
 * correction applied, which is what totals and reports add up. Receipt
 * object paths are never returned.
 *
 * `exports`: every PDF report recorded, newest first, with the history
 * length and the printed amounts of each entry in it, so the page can say
 * when a PDF that went out no longer matches the ledger.
 *
 * `properties`: every property's ID and current name, so a property's
 * ledger can be opened, and named, before it has any entry. null when the
 * names could not be read.
 *
 * Both collections are read whole — no orderBy, no limit — so nothing can
 * silently drop out; see listCosts.
 *
 * Read by the costs page, /admin/costs, once when it opens and on Refresh. No
 * public page calls it, so it adds no function call to a renter's page view.
 *
 * POST request:  JSON `{ propertyId, description, amount, tax }`
 *                  description  1–200 characters
 *                  amount       "185.00": positive, two decimals
 *                  tax          "12.50" or null
 * POST response: 201 `{ success: true, data: { entry: CostEntryView } }`
 *                422 ENTRY_PROPERTY_NOT_FOUND when no property has the ID
 *                502 PROPERTY_LOOKUP_FAILED (nothing written),
 *                502 ENTRY_WRITE_FAILED (may or may not have been written)
 *
 * The entry is written approved, of kind `office`, with no receipt and no
 * account (Kian's ruling of 2026-09-30): see createOfficeEntry. Order: the
 * admin session, then the cross-site and media-type refusals, then the JSON
 * and the schema, then the property, then the write. Every response is
 * no-store.
 */

import { NextRequest } from 'next/server';
import { verifyAdminSession } from '@/app/lib/api/verify-admin';
import { apiSuccess, apiError, apiFailure, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { OfficeInputSchema, createOfficeEntry, listCosts, lookupPropertyName, type PropertyLookup } from '@/app/lib/firebase/server-cost-entries';

/**
 * The one thing logged about a failed read: its gRPC code, as on every other
 * cleaner path. The error's message is not logged.
 */
function grpcCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? String(code) : 'unknown';
}

export async function GET(request: NextRequest) {
  // ── Auth ──
  const auth = verifyAdminSession(request);
  if (!auth.valid) return noStore(apiError(auth.error!, auth.status!));

  try {
    return noStore(apiSuccess(await listCosts()));
  } catch (err) {
    // A read that failed is not an empty list: the 500 says "could not load",
    // never "no entries" and never "no PDF was exported".
    console.error(`[cost-entries] list failed: grpc code ${grpcCode(err)}`);
    return noStore(
      apiFailure({
        message: 'Failed to load cost entries',
        status: 500,
        code: 'COST_ENTRIES_READ_FAILED',
      }),
    );
  }
}

export async function POST(request: NextRequest) {
  // ── Auth ──
  const auth = verifyAdminSession(request);
  if (!auth.valid) return noStore(apiError(auth.error!, auth.status!));

  // ── Cross-site and media type ──
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

  // ── Validate ──
  const result = OfficeInputSchema.safeParse(body);
  if (!result.success) {
    return noStore(apiValidationError(result.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))));
  }
  const office = result.data;

  // ── The property must exist ──
  let property: PropertyLookup;
  try {
    property = await lookupPropertyName(office.propertyId);
  } catch (err) {
    console.error(`[cost-entries] property lookup failed: grpc code ${grpcCode(err)}`);
    return noStore(apiFailure({ message: 'Could not check the property.', status: 502, code: 'PROPERTY_LOOKUP_FAILED', hint: 'Nothing was recorded; retry.' }));
  }
  if (property.kind === 'missing') {
    return noStore(apiFailure({ message: 'That property does not exist.', status: 422, code: 'ENTRY_PROPERTY_NOT_FOUND', hint: 'Nothing was recorded.' }));
  }

  // ── Write ──
  try {
    const entry = await createOfficeEntry({ office, propertyNameAtEntry: property.name });
    return noStore(apiSuccess({ entry }, 201));
  } catch (err) {
    console.error(`[cost-entries] office entry not written: grpc code ${grpcCode(err)}`);
    return noStore(apiFailure({ message: 'The cost could not be saved.', status: 502, code: 'ENTRY_WRITE_FAILED', hint: 'It may or may not have been recorded. Refresh the ledger before adding it again.' }));
  }
}
