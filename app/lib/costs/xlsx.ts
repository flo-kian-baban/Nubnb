/**
 * One property's cost report as an Excel workbook (.xlsx), written by hand
 * through the shared workbook core (app/lib/xlsx/core.ts, lifted from here in
 * dispatch 24): a stored ZIP of the seven XML parts Excel needs, with inline
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

import { count, day, money, text, workbookBytes, type Cell } from '@/app/lib/xlsx/core';
import { generatedLabel, periodLabel, whatWasBoughtText, type CostReport } from './report';
import { ENTRY_KIND_LABELS, isEntryKind, type LineNow } from '@/app/lib/cleaners/model';

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

  return workbookBytes(
    [
      { name: 'Entries', widths: [13, 9, 24, 9, 22, 60, 7, 13, 12, 13, 11], rows: entries },
      { name: 'Items', widths: [13, 9, 40, 20, 26, 16], rows: items },
    ],
    report.generatedAt,
  );
}
