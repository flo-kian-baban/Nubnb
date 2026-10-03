/**
 * The parts every workbook Nubnb writes shares (lifted from costs/xlsx.ts in
 * dispatch 24, as pdf/core.ts was lifted from costs/pdf.ts): cells, sheets,
 * the five cell styles, and the package of XML parts Excel needs, stored in a
 * ZIP (costs/zip.ts) with inline strings, so no package is added.
 *
 * Dates are real Excel dates and amounts real numbers, so both sort and add
 * up in Excel. Amounts are whole cents written out by integer arithmetic;
 * totals are values worked out in whole cents, never formulas, so a file
 * says exactly what the page and the PDF say.
 *
 * Client-safe, and pure: rows in, bytes out. The ledger's workbook
 * (`workbookFor` in costs/xlsx.ts) is written through this and comes out
 * byte for byte as it did before the lift.
 */

import { zipStored } from '@/app/lib/costs/zip';

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const RELATIONSHIPS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_RELATIONSHIPS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** Cell styles, by their place in styles.xml's cellXfs. */
const STYLE = { plain: 0, bold: 1, money: 2, day: 3, boldMoney: 4 } as const;

export type Cell =
  | { kind: 'text'; value: string; bold?: boolean }
  | { kind: 'money'; cents: number; bold?: boolean }
  | { kind: 'day'; day: string }
  | { kind: 'number'; value: number }
  | null;

export const text = (value: string, bold = false): Cell => (value === '' ? null : { kind: 'text', value, bold });
export const money = (cents: number, bold = false): Cell => ({ kind: 'money', cents, bold });
export const day = (value: string): Cell => ({ kind: 'day', day: value });
export const count = (value: number): Cell => ({ kind: 'number', value });

/** One sheet: its tab name (at most 31 characters, none of `: \ / ? * [ ]`), its column widths, its rows. */
export interface Sheet {
  name: string;
  widths: number[];
  rows: Cell[][];
}

/** Text as XML allows it: no control characters, no lone surrogates, markup escaped. */
export function xmlText(value: string): string {
  let clean = '';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        clean += value[i] + value[i + 1];
        i++;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) continue;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue;
    if (code === 0xfffe || code === 0xffff) continue;
    clean += value[i];
  }
  return clean.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Whole cents as the decimal Excel reads: 3798 → "37.98", -500 → "-5.00". Integer arithmetic only. */
export function decimal(cents: number): string {
  const abs = Math.abs(cents);
  const digits = `${(abs - (abs % 100)) / 100}.${String(abs % 100).padStart(2, '0')}`;
  return cents < 0 ? `-${digits}` : digits;
}

/** A yyyy-mm-dd day as an Excel date: days since 30 December 1899. */
export function excelDay(value: string): number {
  const [y, m, d] = value.split('-').map(Number);
  return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86_400_000;
}

/** A column's letters from its index: 0 → A, 25 → Z, 26 → AA. */
export function column(index: number): string {
  let letters = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  return letters;
}

function cellXml(cell: Cell, ref: string): string {
  if (cell === null) return '';
  switch (cell.kind) {
    case 'text':
      return `<c r="${ref}" t="inlineStr"${cell.bold ? ` s="${STYLE.bold}"` : ''}><is><t xml:space="preserve">${xmlText(cell.value)}</t></is></c>`;
    case 'money':
      return `<c r="${ref}" s="${cell.bold ? STYLE.boldMoney : STYLE.money}"><v>${decimal(cell.cents)}</v></c>`;
    case 'day':
      return `<c r="${ref}" s="${STYLE.day}"><v>${excelDay(cell.day)}</v></c>`;
    case 'number': {
      const written = String(cell.value);
      return /^-?[0-9]+(\.[0-9]+)?$/.test(written)
        ? `<c r="${ref}"><v>${written}</v></c>`
        : cellXml({ kind: 'text', value: written }, ref);
    }
  }
}

function sheetXml(widths: number[], rows: Cell[][]): string {
  const cols = widths.map((width, i) => `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`).join('');
  const body = rows
    .map((cells, r) => {
      const written = cells.map((cell, c) => cellXml(cell, `${column(c)}${r + 1}`)).join('');
      return written === '' ? '' : `<row r="${r + 1}">${written}</row>`;
    })
    .join('');
  return `${XML_HEAD}<worksheet xmlns="${MAIN}"><cols>${cols}</cols><sheetData>${body}</sheetData></worksheet>`;
}

const STYLES_XML =
  `${XML_HEAD}<styleSheet xmlns="${MAIN}">` +
  '<numFmts count="2">' +
  '<numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00;-&quot;$&quot;#,##0.00"/>' +
  '<numFmt numFmtId="165" formatCode="d mmm yyyy"/>' +
  '</numFmts>' +
  '<fonts count="2">' +
  '<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
  '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
  '</fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="5">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/>' +
  '</cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

const ROOT_RELS_XML =
  `${XML_HEAD}<Relationships xmlns="${PACKAGE_RELATIONSHIPS}">` +
  `<Relationship Id="rId1" Type="${RELATIONSHIPS}/officeDocument" Target="xl/workbook.xml"/>` +
  '</Relationships>';

/** A sheet's tab name as Excel takes it: the forbidden characters dropped, at most 31 characters. */
function tabName(name: string): string {
  const clean = name.replace(/[:\\/?*[\]]/g, '').trim();
  return (clean === '' ? 'Sheet' : clean).slice(0, 31);
}

/** The workbook's bytes: the sheets in the order given, stamped with `modified`. */
export function workbookBytes(sheets: Sheet[], modified: Date): Uint8Array<ArrayBuffer> {
  const contentTypes =
    `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '</Types>';
  const workbook =
    `${XML_HEAD}<workbook xmlns="${MAIN}" xmlns:r="${RELATIONSHIPS}"><sheets>` +
    sheets.map((sheet, i) => `<sheet name="${xmlText(tabName(sheet.name))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
    '</sheets></workbook>';
  const workbookRels =
    `${XML_HEAD}<Relationships xmlns="${PACKAGE_RELATIONSHIPS}">` +
    sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${RELATIONSHIPS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
    `<Relationship Id="rId${sheets.length + 1}" Type="${RELATIONSHIPS}/styles" Target="styles.xml"/>` +
    '</Relationships>';

  const encoder = new TextEncoder();
  return zipStored(
    [
      { name: '[Content_Types].xml', data: encoder.encode(contentTypes) },
      { name: '_rels/.rels', data: encoder.encode(ROOT_RELS_XML) },
      { name: 'xl/workbook.xml', data: encoder.encode(workbook) },
      { name: 'xl/_rels/workbook.xml.rels', data: encoder.encode(workbookRels) },
      { name: 'xl/styles.xml', data: encoder.encode(STYLES_XML) },
      ...sheets.map((sheet, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: encoder.encode(sheetXml(sheet.widths, sheet.rows)) })),
    ],
    modified,
  );
}
