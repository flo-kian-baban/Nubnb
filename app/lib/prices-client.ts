/**
 * Browser-side calls for cleaning prices per property (Kian's ruling of 2026-10-19): a property's presets, every
 * property's, setting one property's, and the Report For sheet's import. Every call resolves and never throws, as in
 * schedule-client.ts: the data, checked for shape, or a failure fit to show as a Notice, saying when it is not known
 * whether a write landed.
 *
 * Client-safe: it imports only the prices model and the shared error reading.
 */

import { describeErrorBody, readErrorBody } from '@/app/lib/api/http-failure';
import { isPriceCents, type CleaningPricesRecord } from '@/app/lib/cleanings/prices';

export type PricesResult<T> = { ok: true; data: T } | { ok: false; status: number; title: string; detail?: string; code?: string; unknown: boolean };

const isRecord = (data: unknown): data is Record<string, unknown> => !!data && typeof data === 'object' && !Array.isArray(data);
const isPriceOrNull = (value: unknown) => value === null || isPriceCents(value);
/** A record in the shape the pages read: the presets and when they were set; the history is read as it comes. */
export const isPricesRecord = (value: unknown): value is CleaningPricesRecord => isRecord(value) && typeof value.propertyId === 'string' && isPriceOrNull(value.shortTermCents) && isPriceOrNull(value.longTermCents) && typeof value.setAt === 'string' && Array.isArray(value.history);

async function call<T>(url: string, init: RequestInit, action: string, isExpected: (data: unknown) => boolean, unconfirmedCodes: readonly string[] = []): Promise<PricesResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, cache: 'no-store' });
  } catch (err) {
    return { ok: false, status: 0, title: `${action}: the server could not be reached.`, detail: err instanceof Error ? err.message : undefined, unknown: true };
  }
  const body = await readErrorBody(res);
  if (!res.ok) {
    const failure = describeErrorBody(body, res.status, action);
    const code = typeof body.code === 'string' ? body.code : undefined;
    return { ok: false, status: failure.status, title: failure.title, detail: failure.detail, code, unknown: res.status >= 500 || (code !== undefined && unconfirmedCodes.includes(code)) };
  }
  if (!isExpected(body.data)) return { ok: false, status: res.status, title: `${action}: the server's answer was not in the expected form.`, detail: 'Nothing is shown rather than something that might be wrong.', unknown: true };
  return { ok: true, data: body.data as T };
}

/** What the routes take: each preset as "80.00", or null for none. */
export interface PricesPayload {
  shortTerm: string | null;
  longTerm: string | null;
}

/** A property's prices record, null when it has none. */
export function fetchCleaningPrices(propertyId: string): Promise<PricesResult<{ record: CleaningPricesRecord | null; unreadable: boolean }>> {
  return call(`/api/admin/properties/${encodeURIComponent(propertyId)}/cleaning-prices`, {}, 'Loading the cleaning prices failed', (data) => isRecord(data) && (data.record === null || isPricesRecord(data.record)) && typeof data.unreadable === 'boolean');
}

/** Every property's prices record, by property ID (the sheet's second read). */
export function fetchAllCleaningPrices(): Promise<PricesResult<{ prices: Record<string, CleaningPricesRecord> }>> {
  return call('/api/admin/cleaning-prices', {}, 'Loading the cleaning prices failed', (data) => isRecord(data) && isRecord(data.prices) && Object.values(data.prices).every(isPricesRecord));
}

/** Set a property's two presets. CLEANING_PRICES_SAVE_FAILED: they may or may not have landed. */
export function setCleaningPricesOf(propertyId: string, payload: PricesPayload): Promise<PricesResult<{ record: CleaningPricesRecord; changed: boolean }>> {
  return call(
    `/api/admin/properties/${encodeURIComponent(propertyId)}/cleaning-prices`,
    { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) },
    'Saving the cleaning prices failed',
    (data) => isRecord(data) && isPricesRecord(data.record) && typeof data.changed === 'boolean',
    ['CLEANING_PRICES_SAVE_FAILED'],
  );
}

/** The sheet's import: the matched rows, saved in one transaction on the admin's confirm. CLEANING_PRICES_IMPORT_FAILED: unknown whether they landed. */
export function importCleaningPricesRows(rows: ({ propertyId: string } & PricesPayload)[]): Promise<PricesResult<{ saved: { propertyId: string; record: CleaningPricesRecord; changed: boolean }[] }>> {
  return call(
    '/api/admin/cleaning-prices',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows }) },
    'Importing the prices failed',
    (data) => isRecord(data) && Array.isArray(data.saved) && data.saved.every((s) => isRecord(s) && typeof s.propertyId === 'string' && isPricesRecord(s.record) && typeof s.changed === 'boolean'),
    ['CLEANING_PRICES_IMPORT_FAILED'],
  );
}
