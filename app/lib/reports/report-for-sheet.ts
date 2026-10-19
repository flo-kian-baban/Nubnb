/**
 * The Report For sheet (2026-10-17, build round 1 of the property page audit): every property's Report For name and
 * address, its reference stem (Kian's ruling K5) and its default fee rate (K6), each typed in place and saved through
 * the management route, which keeps every other field of the record as stored; and, since Kian's ruling of 2026-10-19,
 * its two cleaning prices — "Cleaning: short" and "Cleaning: long (28+ nights)" — saved through the prices route.
 *
 * What a row holds as typed, whether it can be saved and why not, in one line, and what each of its two routes is
 * sent. Pure and client-safe: the page and the tests run the same functions.
 */

import { STATEMENT_LIMITS, rateText, stemProblem, type PropertyManagementView } from './model';
import { priceField, priceTextForRoute, readPriceText, type CleaningPrices } from '@/app/lib/cleanings/prices';

/** One row as typed. */
export interface SheetFields {
  name: string;
  address: string;
  stem: string;
  /** "20" or "12.5"; '' for none. */
  rate: string;
  /** The cleaning prices, "80.00"; '' for none (Kian's ruling of 2026-10-19). */
  short: string;
  long: string;
}

/** The fields the management route holds, and the fields the prices route holds. */
export const MANAGEMENT_FIELDS = ['name', 'address', 'stem', 'rate'] as const;
export const PRICE_FIELDS = ['short', 'long'] as const;

/** A rate as typed: "20" or "12.5", at most two decimals, 0–100 (the management route's rule). */
const RATE = /^(100(\.0{1,2})?|[0-9]{1,2}(\.[0-9]{1,2})?)$/;

/** A row as the records hold it; empty fields where the property has no record. */
export function sheetFieldsOf(record: Pick<PropertyManagementView, 'reportFor' | 'referenceStem' | 'defaultFeeRateBasisPoints'> | null, prices: CleaningPrices | null = null): SheetFields {
  return {
    name: record?.reportFor?.name ?? '',
    address: record?.reportFor?.address ?? '',
    stem: record?.referenceStem ?? '',
    rate: record?.defaultFeeRateBasisPoints == null ? '' : rateText(record.defaultFeeRateBasisPoints).replace('%', ''),
    short: priceField(prices?.shortTermCents ?? null),
    long: priceField(prices?.longTermCents ?? null),
  };
}

const oneLine = (text: string) => text.normalize('NFC').replace(/\s+/g, ' ').trim();
/** An address as the route keeps it: each line's spaces folded, blank lines at either end dropped. */
const lines = (text: string) =>
  text
    .normalize('NFC')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line, i, all) => line !== '' || (i > 0 && i < all.length - 1))
    .join('\n')
    .trim();
/** A price as the route will store it ("80.00"), '' for none, or the text itself when it is not a price (so it never reads as equal to a stored one). A row from before the prices (no field) is none. */
const price = (text: string | undefined) => {
  const read = readPriceText(text ?? '');
  return read.kind === 'none' ? '' : read.kind === 'cents' ? priceField(read.cents) : `?${text}`;
};

/** The row as the routes will store it: what two rows are compared by, so a change that stores nothing new sends nothing. */
export function sheetNormal(fields: SheetFields): SheetFields {
  return { name: oneLine(fields.name), address: lines(fields.address), stem: oneLine(fields.stem), rate: fields.rate.trim(), short: price(fields.short), long: price(fields.long) };
}

/** Why the row cannot be saved as typed, in one line; null when it can. */
export function sheetProblem(fields: SheetFields): string | null {
  const row = sheetNormal(fields);
  if (row.name === '' && row.address !== '') return 'Type a name above the address.';
  if (row.name.length > STATEMENT_LIMITS.REPORT_FOR_NAME_MAX) return `The name: at most ${STATEMENT_LIMITS.REPORT_FOR_NAME_MAX} characters.`;
  if (row.address.length > STATEMENT_LIMITS.REPORT_FOR_ADDRESS_MAX) return `The address: at most ${STATEMENT_LIMITS.REPORT_FOR_ADDRESS_MAX} characters.`;
  if (row.address.split('\n').length > STATEMENT_LIMITS.REPORT_FOR_ADDRESS_LINES_MAX) return `The address: at most ${STATEMENT_LIMITS.REPORT_FOR_ADDRESS_LINES_MAX} lines.`;
  const stem = stemProblem(row.stem);
  if (stem) return `The stem: ${stem}`;
  if (row.rate !== '' && !RATE.test(row.rate)) return 'The fee rate is a percent, like 20 or 12.5.';
  if (readPriceText(fields.short ?? '').kind === 'bad') return 'The short-term cleaning price is dollars and cents, like 80 or 80.00, up to 9,999.99.';
  if (readPriceText(fields.long ?? '').kind === 'bad') return 'The long-term cleaning price is dollars and cents, like 120 or 120.00, up to 9,999.99.';
  return null;
}

/** What the row sends to the management route: its three fields alone, so every other field keeps what is stored. */
export function sheetPayload(fields: SheetFields): { reportFor: { name: string; address: string } | null; referenceStem: string | null; defaultFeeRate: string | null } {
  const row = sheetNormal(fields);
  return { reportFor: row.name === '' ? null : { name: row.name, address: row.address }, referenceStem: row.stem || null, defaultFeeRate: row.rate || null };
}

/** What the row sends to the prices route: both presets, "80.00" or null (Kian's ruling of 2026-10-19). Only for a row sheetProblem accepts. */
export function pricesPayload(fields: SheetFields): { shortTerm: string | null; longTerm: string | null } {
  return { shortTerm: priceTextForRoute(fields.short) ?? null, longTerm: priceTextForRoute(fields.long) ?? null };
}

/** Two rows whose management fields store the same thing. */
export function sameManagement(a: SheetFields, b: SheetFields): boolean {
  const x = sheetNormal(a);
  const y = sheetNormal(b);
  return MANAGEMENT_FIELDS.every((field) => x[field] === y[field]);
}

/** Two rows whose cleaning prices store the same thing. */
export function samePriceFields(a: SheetFields, b: SheetFields): boolean {
  const x = sheetNormal(a);
  const y = sheetNormal(b);
  return PRICE_FIELDS.every((field) => x[field] === y[field]);
}

/** Two rows that store the same thing, in every field. */
export function sameSheetRow(a: SheetFields, b: SheetFields): boolean {
  return sameManagement(a, b) && samePriceFields(a, b);
}
