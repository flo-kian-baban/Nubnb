/**
 * One property's cost report as an Excel workbook (.xlsx), written by hand:
 * a stored ZIP (zip.ts) of the seven XML parts Excel needs, with inline
 * strings, so no package is added.
 *
 *   Entries   one row per approved entry: date sent, ref, entry ID, kind
 *             (receipt or work, dispatch 24), who logged it, what was bought
 *             or the work done (discounts and returns listed with their
 *             amounts), lines, items, tax, total, corrected; then the period
 *             total. Tax is its own column (dispatch 21); an entry sent
 *             before tax was its own field reads "in items" there.
 *   Items     one row per line of those entries: the item, its quantity (for
 *             reference only) and its line total as printed, then one "Tax"
 *             row per entry that keeps its tax apart; then the total
 *
 * Dates are real Excel dates and amounts real numbers, so both sort and add
 * up in Excel. The totals are written as values worked out in whole cents,
 * not as formulas, so the file says exactly what the page and the PDF say.
 *
 * Client-safe, and pure: a report in, bytes out.
 */

import { zipStored } from './zip';
import { generatedLabel, periodLabel, whatWasBoughtText, type CostReport } from './report';
import { ENTRY_KIND_LABELS, isEntryKind, type LineNow } from '@/app/lib/cleaners/model';

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const RELATIONSHIPS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_RELATIONSHIPS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** Cell styles, by their place in styles.xml's cellXfs. */
const STYLE = { plain: 0, bold: 1, money: 2, day: 3, boldMoney: 4 } as const;

type Cell =
  | { kind: 'text'; value: string; bold?: boolean }
  | { kind: 'money'; cents: number; bold?: boolean }
  | { kind: 'day'; day: string }
  | { kind: 'number'; value: number }
  | null;

const text = (value: string, bold = false): Cell => (value === '' ? null : { kind: 'text', value, bold });
const money = (cents: number, bold = false): Cell => ({ kind: 'money', cents, bold });
const day = (value: string): Cell => ({ kind: 'day', day: value });
const count = (value: number): Cell => ({ kind: 'number', value });

/** Text as XML allows it: no control characters, no lone surrogates, markup escaped. */
function xmlText(value: string): string {
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
function decimal(cents: number): string {
  const abs = Math.abs(cents);
  const digits = `${(abs - (abs % 100)) / 100}.${String(abs % 100).padStart(2, '0')}`;
  return cents < 0 ? `-${digits}` : digits;
}

/** A yyyy-mm-dd day as an Excel date: days since 30 December 1899. */
function excelDay(value: string): number {
  const [y, m, d] = value.split('-').map(Number);
  return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86_400_000;
}

const column = (index: number) => String.fromCharCode(65 + index);

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

const CONTENT_TYPES_XML =
  `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
  '</Types>';

const ROOT_RELS_XML =
  `${XML_HEAD}<Relationships xmlns="${PACKAGE_RELATIONSHIPS}">` +
  `<Relationship Id="rId1" Type="${RELATIONSHIPS}/officeDocument" Target="xl/workbook.xml"/>` +
  '</Relationships>';

const WORKBOOK_XML =
  `${XML_HEAD}<workbook xmlns="${MAIN}" xmlns:r="${RELATIONSHIPS}"><sheets>` +
  '<sheet name="Entries" sheetId="1" r:id="rId1"/>' +
  '<sheet name="Items" sheetId="2" r:id="rId2"/>' +
  '</sheets></workbook>';

const WORKBOOK_RELS_XML =
  `${XML_HEAD}<Relationships xmlns="${PACKAGE_RELATIONSHIPS}">` +
  `<Relationship Id="rId1" Type="${RELATIONSHIPS}/worksheet" Target="worksheets/sheet1.xml"/>` +
  `<Relationship Id="rId2" Type="${RELATIONSHIPS}/worksheet" Target="worksheets/sheet2.xml"/>` +
  `<Relationship Id="rId3" Type="${RELATIONSHIPS}/styles" Target="styles.xml"/>` +
  '</Relationships>';

/** What a line's note says: whether an admin corrected it or added it. */
function lineNote(line: LineNow): string {
  if (line.origin === 'added') return 'Added by admin';
  return line.earlier.length > 0 ? 'Corrected' : '';
}

/** An entry's tax cell: the amount, "none" when the cleaner gave none, "in items" on an older entry. */
function taxCell(entry: CostReport['entries'][number]): Cell {
  if (entry.taxShape === 'in-lines') return text('in items');
  return entry.taxCents === null ? text('none') : money(entry.taxCents);
}

function quantity(value: LineNow['quantity']): Cell {
  if (value === null) return null;
  return typeof value === 'number' ? count(value) : text(value);
}

/** The workbook's bytes. */
export function workbookFor(report: CostReport): Uint8Array<ArrayBuffer> {
  const heading = (included: string): Cell[][] => [
    [text('Property', true), text(report.propertyName)],
    [text('Period', true), text(periodLabel(report.from, report.to))],
    [text('Included', true), text(included)],
    [text('Generated', true), text(generatedLabel(report.generatedAt))],
    [],
  ];

  const entries: Cell[][] = [
    ...heading('Approved entries only'),
    ['Date sent', 'Ref', 'Entry ID', 'Kind', 'Logged by', 'What was bought / work done', 'Lines', 'Items (CAD)', 'Tax (CAD)', 'Total (CAD)', 'Corrected'].map(
      (h) => text(h, true),
    ),
    ...(report.entries.length === 0
      ? [[text('No approved costs in this period.')]]
      : report.entries.map((entry) => [
          day(entry.day),
          text(entry.ref),
          text(entry.id),
          text(isEntryKind(entry.kind) ? ENTRY_KIND_LABELS[entry.kind] : entry.kind),
          text(entry.cleaner),
          text(whatWasBoughtText(entry.lines)),
          count(entry.lines.length),
          money(entry.itemsCents),
          taxCell(entry),
          money(entry.totalCents),
          text(entry.corrected ? 'Yes' : ''),
        ])),
    [
      text('Period total', true),
      null,
      null,
      null,
      null,
      null,
      null,
      money(report.itemsCents, true),
      money(report.taxCents, true),
      money(report.totalCents, true),
    ],
    ...(report.taxInLines
      ? [[text('Entries marked "in items" were sent before tax was its own field: any tax the cleaner typed is a line among their items, and inside their Items amount.')]]
      : []),
  ];

  const items: Cell[][] = [
    ...heading('Every line of the approved entries'),
    ['Date sent', 'Ref', 'Item', 'Qty (reference only)', 'Line total as printed (CAD)', 'Note'].map((h) =>
      text(h, true),
    ),
    ...report.entries.flatMap((entry) => [
      ...entry.lines.map((line) => [
        day(entry.day),
        text(entry.ref),
        text(line.name ?? ''),
        quantity(line.quantity),
        money(line.lineTotalCents),
        text(lineNote(line)),
      ]),
      // The entry's tax, apart from its items (dispatch 21), so the sheet's rows add up to the total.
      ...(entry.taxShape === 'field' && entry.taxCents !== null
        ? [[day(entry.day), text(entry.ref), text('Tax'), null, money(entry.taxCents), text('Tax')]]
        : []),
    ]),
    [text('Total', true), null, null, null, money(report.totalCents, true)],
  ];

  const encoder = new TextEncoder();
  return zipStored(
    [
      { name: '[Content_Types].xml', data: encoder.encode(CONTENT_TYPES_XML) },
      { name: '_rels/.rels', data: encoder.encode(ROOT_RELS_XML) },
      { name: 'xl/workbook.xml', data: encoder.encode(WORKBOOK_XML) },
      { name: 'xl/_rels/workbook.xml.rels', data: encoder.encode(WORKBOOK_RELS_XML) },
      { name: 'xl/styles.xml', data: encoder.encode(STYLES_XML) },
      { name: 'xl/worksheets/sheet1.xml', data: encoder.encode(sheetXml([13, 9, 24, 9, 22, 60, 7, 13, 12, 13, 11], entries)) },
      { name: 'xl/worksheets/sheet2.xml', data: encoder.encode(sheetXml([13, 9, 40, 20, 26, 16], items)) },
    ],
    report.generatedAt,
  );
}
