/**
 * GET  /api/admin/cleaning-prices — every property's cleaning prices (admin-only; Kian's ruling of 2026-10-19), for
 *      the Report For sheet's two columns: 200 `{ success: true, data: { prices: { [propertyId]: record } } }`.
 * POST /api/admin/cleaning-prices — the sheet's CSV import, saved on the admin's confirm: the matched rows, each a
 *      property and its two presets, in one transaction.
 *
 * Request (POST): `{ rows: [{ propertyId, shortTerm: "80.00" | null, longTerm: "120.00" | null }, …] }` (1–500 rows).
 * Response:       200 `{ success: true, data: { saved: [{ propertyId, record, changed }] } }` — every row, `changed`
 *                 false where the record already said this and nothing was written;
 *                 404 PROPERTY_NOT_FOUND naming the IDs no property has (nothing saved);
 *                 422 VALIDATION_ERROR, or DUPLICATE_ROWS when a property is named twice (nothing saved);
 *                 502 when it is not known whether the rows were saved.
 *
 * The page matches the file's rows to properties by exact address (case and spaces ignored) and shows the admin what
 * would change before anything is sent here; nothing saves before the confirm. Recorded in the activity log.
 *
 * Order: the admin session, then the cross-site and media-type refusals, then the JSON and the body, then the work.
 * Every response is no-store.
 */

import { NextRequest } from 'next/server';
import { adminRoute } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { ImportCleaningPricesSchema } from '@/app/lib/cleanings/schemas';
import { importCleaningPrices, listCleaningPrices } from '@/app/lib/firebase/server-cleaning-prices';

const grpcCode = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? String(code) : 'unknown';
};

export const GET = adminRoute(async function GET() {
  try {
    const records = await listCleaningPrices();
    return noStore(apiSuccess({ prices: Object.fromEntries(records) }));
  } catch (err) {
    console.error(`[cleaning-prices] list failed: grpc code ${grpcCode(err)}`);
    return noStore(apiFailure({ message: 'Could not read the cleaning prices.', status: 503, code: 'CLEANING_PRICES_UNAVAILABLE' }));
  }
});

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
  const parsed = ImportCleaningPricesSchema.safeParse(body);
  if (!parsed.success) return noStore(apiValidationError(parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))));

  const outcome = await importCleaningPrices(
    actor,
    parsed.data.rows.map((row) => ({ propertyId: row.propertyId, prices: { shortTermCents: row.shortTerm, longTermCents: row.longTerm } })),
  );
  switch (outcome.kind) {
    case 'imported':
      console.log(`[cleaning-prices] import saved ${outcome.saved.filter((s) => s.changed).length} of ${outcome.saved.length} rows`);
      return noStore(apiSuccess({ saved: outcome.saved }));
    case 'no-such-property':
      return noStore(apiFailure({ status: 404, code: 'PROPERTY_NOT_FOUND', message: `${outcome.propertyIds.length === 1 ? 'A row names a property that does not exist' : `${outcome.propertyIds.length} rows name properties that do not exist`}.`, hint: 'Nothing was saved. Reload the sheet and import again.' }));
    case 'duplicate':
      return noStore(apiFailure({ status: 422, code: 'DUPLICATE_ROWS', message: `${outcome.propertyIds.length === 1 ? 'A property is named twice' : `${outcome.propertyIds.length} properties are named twice`}.`, hint: 'Nothing was saved.' }));
    case 'failed':
      return noStore(apiFailure({ status: 502, code: 'CLEANING_PRICES_IMPORT_FAILED', message: 'Could not save the prices.', hint: 'They may or may not have been saved. Reload the sheet to see.' }));
  }
});
