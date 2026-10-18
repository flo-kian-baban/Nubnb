/**
 * The Report For sheet (2026-10-17, build round 1 of the property page audit): every property's Report For name and
 * address, its reference stem (Kian's ruling K5) and its default fee rate (K6), each typed in place and saved through
 * the management route, which keeps every other field of the record as stored.
 *
 * What a row holds as typed, whether it can be saved and why not, in one line, and what it sends. Pure and
 * client-safe: the page and tests/statements/report-for-sheet.mjs run the same functions.
 */

import { STATEMENT_LIMITS, rateText, stemProblem, type PropertyManagementView } from './model';

/** One row as typed. */
export interface SheetFields {
  name: string;
  address: string;
  stem: string;
  /** "20" or "12.5"; '' for none. */
  rate: string;
}

/** A rate as typed: "20" or "12.5", at most two decimals, 0–100 (the management route's rule). */
const RATE = /^(100(\.0{1,2})?|[0-9]{1,2}(\.[0-9]{1,2})?)$/;

/** A row as the record holds it; an empty row when the property has no record. */
export function sheetFieldsOf(record: Pick<PropertyManagementView, 'reportFor' | 'referenceStem' | 'defaultFeeRateBasisPoints'> | null): SheetFields {
  return {
    name: record?.reportFor?.name ?? '',
    address: record?.reportFor?.address ?? '',
    stem: record?.referenceStem ?? '',
    rate: record?.defaultFeeRateBasisPoints == null ? '' : rateText(record.defaultFeeRateBasisPoints).replace('%', ''),
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

/** The row as the route will store it: what two rows are compared by, so a change that stores nothing new sends nothing. */
export function sheetNormal(fields: SheetFields): SheetFields {
  return { name: oneLine(fields.name), address: lines(fields.address), stem: oneLine(fields.stem), rate: fields.rate.trim() };
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
  return null;
}

/** What the row sends to the management route: its three fields alone, so every other field keeps what is stored. */
export function sheetPayload(fields: SheetFields): { reportFor: { name: string; address: string } | null; referenceStem: string | null; defaultFeeRate: string | null } {
  const row = sheetNormal(fields);
  return { reportFor: row.name === '' ? null : { name: row.name, address: row.address }, referenceStem: row.stem || null, defaultFeeRate: row.rate || null };
}

/** Two rows that store the same thing. */
export function sameSheetRow(a: SheetFields, b: SheetFields): boolean {
  const x = sheetNormal(a);
  const y = sheetNormal(b);
  return x.name === y.name && x.address === y.address && x.stem === y.stem && x.rate === y.rate;
}
