/**
 * The month package's three workbooks (FINANCIAL-MANAGEMENT-PLAN.md §2.7.2,
 * §2.7.3): a property's month, Nubnb's fee income, and what was not charged.
 * Written through the shared workbook core: real numbers and real dates,
 * totals as values in whole cents, never formulas.
 *
 * A property's workbook names nobody on Nubnb's team: who logged a cost is a
 * role. Nubnb's own workbooks name them.
 *
 * Client-safe, and pure.
 */

import { readCostEntryFields, readLinesNow, formatCents, type CostEntryFields, type HistoryEventView, type LineNow, type LineView, type LinesNow } from '@/app/lib/cleaners/model';
import { REPORT_TIME_ZONE, whatWasBoughtText } from '@/app/lib/costs/report';
import { monthLabel, monthOfDay, rateText, reportRef, type StatementCost } from '@/app/lib/reports/model';
import { STANDING_LABELS, closingWords, printedLines } from '@/app/lib/reports/statement';
import { count, day, money, text, workbookBytes, type Cell } from '@/app/lib/xlsx/core';
import type { MonthPackageData, NotCharged, PackageFolder } from './data';

/** A file the package holds, as a workbook names it: its path inside the folder and the hashes checked. */
export interface FileNote {
  name: string;
  bytes: number;
  recordedSha256: string | null;
  sha256: string;
}

const KIND_WORDS: Record<string, string> = { receipt: 'Receipt', work: 'Handyman work', office: 'Office' };
const ROLE_WORDS: Record<string, string> = { receipt: 'Cleaner', work: 'Handyman', office: 'Office' };
const ACTOR_WORDS: Record<string, string> = { admin: 'Office', cleaner: 'Cleaner', handyman: 'Handyman', system: 'Automatic approval' };

const whenFormat = new Intl.DateTimeFormat('en-CA', { timeZone: REPORT_TIME_ZONE, year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

/** "Oct 4, 2026, 14:42", Toronto time. */
export function whenWords(iso: string | null): string {
  if (!iso) return '';
  const time = Date.parse(iso);
  return Number.isFinite(time) ? whenFormat.format(new Date(time)) : iso;
}

/** An entry's stored fields; null when the package does not hold it. */
export function fieldsOf(data: MonthPackageData, entryId: string): CostEntryFields | null {
  const stored = data.entries[entryId];
  return stored ? readCostEntryFields(entryId, stored) : null;
}

/** The lines as they stood after the first `n` events of the entry's history: what a statement printed. */
export function linesAt(fields: CostEntryFields, n: number): LinesNow {
  return readLinesNow(fields.lines, (fields.history ?? []).slice(0, n), { shape: fields.taxShape, cents: fields.taxCents });
}

function lineWords(line: LineView | null): string {
  if (!line) return '';
  const amount = typeof line.lineTotalCents === 'number' ? formatCents(line.lineTotalCents) : String(line.lineTotalCents ?? '');
  return `${line.name ?? ''} × ${line.quantity ?? ''} ${amount}`.trim();
}

function taxWords(value: number | string | null): string {
  if (value === null) return 'none';
  return typeof value === 'number' ? formatCents(value) : value;
}

/** How it was approved, from the events the statement printed. */
function approvedWords(fields: CostEntryFields, events: HistoryEventView[]): string {
  if (fields.kind === 'office') return 'Entered by the office';
  const approval = [...events].reverse().find((event) => event.action === 'approved');
  if (!approval) return '';
  return approval.actor?.role === 'system' ? 'Automatically, under $200' : 'By the office';
}

function taxCell(row: Pick<StatementCost, 'taxCents'>, fields: CostEntryFields | null): Cell {
  if (fields?.taxShape === 'in-lines') return text('In the items');
  return row.taxCents === null ? text('None entered') : money(row.taxCents);
}

function noReceiptWords(kind: string): string {
  if (kind === 'work') return 'No receipt: handyman work';
  if (kind === 'office') return 'No receipt: entered by the office';
  return 'No receipt on record';
}

const header = (labels: string[]): Cell[] => labels.map((label) => text(label, true));

/** The facts on top of a sheet: label, value. */
function facts(pairs: [string, Cell][]): Cell[][] {
  return pairs.filter(([, value]) => value !== null).map(([label, value]) => [text(label, true), value]);
}

// ─── A property's month ────────────────────────────────────────

export interface PropertyWorkbookInput {
  data: MonthPackageData;
  folder: PackageFolder;
  /** Each receipt's file, by entry ID: its name under the folder (`Receipts/…`). Absent for an entry with no receipt. */
  receipts: Map<string, FileNote[]>;
  madeAt: Date;
}

function stateWords(folder: PackageFolder): string {
  if (folder.kind === 'finished' && folder.report) return `Finished ${whenWords(folder.report.finishedAt)}, Toronto time`;
  if (folder.kind === 'draft') return 'Draft: not sent to anyone';
  return 'No statement: the costs as they stand';
}

export function propertyWorkbook(input: PropertyWorkbookInput): Uint8Array<ArrayBuffer> {
  const { data, folder } = input;
  const statement = folder.statement;
  const printed = printedLines(statement);
  const printedFor = new Map(printed.filter((line) => line.entryId !== null).map((line) => [line.entryId as string, line.description]));
  const closing = closingWords(statement.payableCents);

  // ── Statement ──
  const statementRows: Cell[][] = [
    ...facts([
      ['Property', text(folder.propertyName)],
      ['Month', text(monthLabel(data.month))],
      ['State', text(stateWords(folder))],
      ['Standing', text(STANDING_LABELS[folder.standing])],
      ['Reference', text(statement.reference)],
      ['Report date', statement.reportDate ? day(statement.reportDate) : null],
      ['Report For', statement.reportFor ? text(statement.reportFor.name) : null],
    ]),
    ...(statement.reportFor?.address ? statement.reportFor.address.split('\n').map((line) => [null, text(line)]) : []),
    [],
    header(['Description', 'Transaction', 'Rate', 'Amount']),
    ...(printed.length === 0 ? [[text('Nothing to report.')]] : printed.map((line) => [text(line.description), count(line.quantity), money(line.rateCents), money(line.amountCents)])),
    [],
    [text('Total', true), null, null, money(statement.totalCents, true)],
    ...(statement.carried ? [[text(statement.carried.label || 'Carried balance'), null, null, money(-statement.carried.amountCents)]] : []),
    [text(closing.label, true), null, null, money(statement.payableCents, true)],
    [],
    ...facts([
      ['Fee', statement.fee ? text(statement.fee.label) : text('No fee')],
      ['Fee rate', statement.fee?.rateBasisPoints != null ? text(rateText(statement.fee.rateBasisPoints)) : null],
      ['Fee base', statement.fee && statement.fee.rateBasisPoints !== null && statement.fee.baseCents !== null ? money(statement.fee.baseCents) : null],
      ['Fee as computed', statement.fee && statement.fee.computedCents !== null ? money(statement.fee.computedCents) : null],
      ['Fee as printed', statement.fee ? money(statement.fee.amountCents) : null],
      ['Overwritten', statement.fee ? text(statement.fee.overwritten ? 'Yes' : 'No') : null],
      ['Notes', statement.notes ? text(statement.notes) : null],
      ['Entries pending when finished', folder.kind === 'finished' ? count(statement.pendingLeftOut) : null],
    ]),
    ...(folder.unreadable.length > 0 ? [[], [text(`No statement can be worked out: ${folder.unreadable.length} approved ${folder.unreadable.length === 1 ? 'entry cannot' : 'entries cannot'} be added up (${folder.unreadable.join(', ')}).`)]] : []),
  ];

  // ── Costs, Items, History: each cost as the statement printed it ──
  const costRows: Cell[][] = [
    header(['Line on the statement', 'Day sent', 'Ref', 'Entry ID', 'Kind', 'Logged by', 'What was bought / work done', 'Items (CAD)', 'Tax (CAD)', 'Total (CAD)', 'Corrected by Nubnb', 'Approved', 'Purchase date', 'Receipt file', 'Receipt SHA-256', 'In this statement as', 'Checked']),
  ];
  const itemRows: Cell[][] = [header(['Ref', 'Item', 'Qty (reference only)', 'Amount as printed (CAD)', 'Note'])];
  // An adjusted entry's lines are listed apart, under the total: the statement charges only its change.
  const adjustedItemRows: Cell[][] = [];
  const historyRows: Cell[][] = [header(['Ref', 'When (Toronto)', 'What', 'From', 'To', 'By', 'Reason', 'Before', 'After'])];
  let itemsTotal = 0;

  const historyOf = (ref: string, fields: CostEntryFields, n: number) => {
    for (const event of (fields.history ?? []).slice(0, n)) {
      historyRows.push([
        text(ref),
        text(whenWords(event.at)),
        text(event.action ?? ''),
        text(event.from ?? ''),
        text(event.to ?? ''),
        text(event.actor?.role ? (ACTOR_WORDS[event.actor.role] ?? event.actor.role) : ''),
        text(event.reason ?? ''),
        text(event.line ? lineWords(event.line.before) : event.tax ? taxWords(event.tax.before) : ''),
        text(event.line ? lineWords(event.line.after) : event.tax ? taxWords(event.tax.after) : ''),
      ]);
    }
  };
  const itemsOf = (ref: string, fields: CostEntryFields, lines: LinesNow, into: Cell[][], counted: boolean) => {
    if (lines.kind !== 'ok') {
      into.push([text(ref), text('The lines cannot be read.')]);
      return;
    }
    for (const line of lines.lines as LineNow[]) {
      into.push([text(ref), text(line.name ?? ''), typeof line.quantity === 'number' ? count(line.quantity) : text(String(line.quantity ?? '')), money(line.lineTotalCents), text(line.origin === 'added' ? 'Added by the office' : line.earlier.length > 0 ? 'Corrected' : '')]);
    }
    if (fields.taxShape === 'field' && lines.taxCents !== null) into.push([text(ref), text('Tax'), null, money(lines.taxCents), text('Tax')]);
    if (counted) itemsTotal += lines.totalCents;
  };

  for (const row of statement.costs) {
    const fields = fieldsOf(data, row.entryId);
    const lines = fields ? linesAt(fields, row.historyLength) : null;
    const events = fields ? (fields.history ?? []).slice(0, row.historyLength) : [];
    const files = input.receipts.get(row.entryId) ?? [];
    const recomputed = lines?.kind === 'ok' ? lines.totalCents : null;
    costRows.push([
      text(printedFor.get(row.entryId) ?? row.description),
      day(row.day),
      text(row.ref),
      text(row.entryId),
      text(KIND_WORDS[row.kind] ?? row.kind),
      text(ROLE_WORDS[row.kind] ?? ''),
      text(lines?.kind === 'ok' ? whatWasBoughtText(lines.lines) : ''),
      money(row.itemsCents),
      taxCell(row, fields),
      money(row.totalCents),
      text(row.corrected ? 'Yes' : ''),
      text(fields ? approvedWords(fields, events) : ''),
      fields?.purchasedOn ? day(fields.purchasedOn) : null,
      text(files.length > 0 ? files.map((file) => file.name).join(', ') : noReceiptWords(row.kind)),
      text(row.receiptSha256 ?? ''),
      text(row.group === 'month' ? 'This month' : `From ${monthLabel(monthOfDay(row.day))}`),
      text(recomputed === null ? 'The entry is not in this package' : recomputed === row.totalCents ? 'Yes' : `Differs: its history adds up to ${formatCents(recomputed)}`),
    ]);
    if (fields && lines) itemsOf(row.ref, fields, lines, itemRows, true);
    if (fields) historyOf(row.ref, fields, row.historyLength);
  }
  if (statement.costs.length === 0) costRows.push([text('No recorded costs.')]);
  else costRows.push([text('Total', true), null, null, null, null, null, null, money(statement.costs.reduce((s, r) => s + r.itemsCents, 0), true), money(statement.costs.reduce((s, r) => s + (r.taxCents ?? 0), 0), true), money(statement.costs.reduce((s, r) => s + r.totalCents, 0), true)]);

  // ── Adjustments ──
  const adjustmentRows: Cell[][] = [header(['Ref', 'Entry ID', 'Printed in', 'Printed (CAD)', 'Now (CAD)', 'Change (CAD)', 'On this statement (CAD)'])];
  for (const row of statement.adjustments) {
    const where = data.printedStatements[row.statementId];
    const name = where ? `${where.reference?.trim() || reportRef(row.statementId)}, ${monthLabel(where.month)}` : row.printedMonth ? monthLabel(row.printedMonth) : reportRef(row.statementId);
    adjustmentRows.push([text(row.entryId.slice(0, 6)), text(row.entryId), text(name), money(row.printedCents), money(row.nowCents), money(row.deltaCents), money(-row.deltaCents)]);
    const fields = fieldsOf(data, row.entryId);
    if (fields) {
      itemsOf(row.entryId.slice(0, 6), fields, linesAt(fields, row.historyLength), adjustedItemRows, false);
      historyOf(row.entryId.slice(0, 6), fields, row.historyLength);
    }
  }
  if (statement.adjustments.length === 0) adjustmentRows.push([text('No adjustments to earlier statements.')]);
  itemRows.push([text('Total', true), null, null, money(itemsTotal, true)]);
  if (adjustedItemRows.length > 0) itemRows.push([], [text('Entries adjusted by this statement, as they now stand (it charges only the change: see Adjustments)', true)], ...adjustedItemRows);

  // ── Receipts ──
  const receiptRows: Cell[][] = [header(['File', 'Ref', 'Bytes', 'SHA-256 recorded at upload', 'SHA-256 of the file', 'Equal'])];
  for (const [entryId, files] of input.receipts) {
    for (const file of files) receiptRows.push([text(file.name), text(entryId.slice(0, 6)), count(file.bytes), text(file.recordedSha256 ?? ''), text(file.sha256), text(file.recordedSha256 === file.sha256 ? 'Yes' : 'No')]);
  }
  if (input.receipts.size === 0) receiptRows.push([text('No receipt photos in this month.')]);

  const about: Cell[][] = aboutRows([
    `${folder.propertyName}, ${monthLabel(data.month)}.`,
    `Made ${whenWords(data.madeAt)}, Toronto time, from what Nubnb held then.`,
    'Statement: the Payment Summary line by line, as the PDF prints it, with its fee, carried balance and closing figure.',
    'Costs: each recorded cost the statement charges, with its tax apart. "None entered" means no tax was given, which is not zero.',
    'Items and History: each cost as it stood when the statement printed it, worked out from the lines the cleaner sent and the corrections made since.',
    'Receipts: each photo with the SHA-256 Nubnb recorded when it was uploaded and the SHA-256 of the file here.',
    'Who logged a cost is given as a role. Nubnb keeps who it was.',
    'What this cannot show: that a purchase happened, for this property, at this price; when a photo was taken; that a tax figure is the one printed on the receipt; which person in the office did anything.',
  ]);

  return workbookBytes(
    [
      { name: 'Statement', widths: [58, 14, 14, 16], rows: statementRows },
      { name: 'Costs', widths: [44, 12, 9, 24, 14, 11, 44, 12, 12, 12, 10, 24, 13, 34, 66, 20, 24], rows: costRows },
      { name: 'Items', widths: [9, 44, 18, 22, 18], rows: itemRows },
      { name: 'Adjustments', widths: [9, 24, 34, 14, 14, 14, 20], rows: adjustmentRows },
      { name: 'History', widths: [9, 22, 16, 12, 12, 18, 30, 30, 30], rows: historyRows },
      { name: 'Receipts', widths: [34, 9, 10, 66, 66, 7], rows: receiptRows },
      { name: 'About', widths: [120], rows: about },
    ],
    input.madeAt,
  );
}

function aboutRows(lines: string[]): Cell[][] {
  return lines.map((line) => [text(line)]);
}

// ─── Nubnb's fee income ────────────────────────────────────────

export interface FeeIncomeInput {
  data: MonthPackageData;
  /** Each finished statement's PDF: its path in the package, by report ID. */
  statements: Map<string, FileNote & { path: string }>;
  madeAt: Date;
}

export function feeIncomeWorkbook(input: FeeIncomeInput): Uint8Array<ArrayBuffer> {
  const { data } = input;
  const folders = new Map(data.folders.map((folder) => [folder.propertyId, folder]));
  const rows: Cell[][] = [
    header(['Property', 'Property ID', 'Standing', 'Draft in progress', 'Statement', 'Report ID', 'Finished (Toronto)', 'Revenue (CAD)', 'Typed expenses (CAD)', 'Recorded costs (CAD)', 'Fee base (CAD)', 'Fee rate', 'Fee as computed (CAD)', 'Fee as printed (CAD)', 'Overwritten', 'Total (CAD)', 'Carried (CAD)', 'Revenue share (CAD)', 'Owed to NuBNB (CAD)', 'Downloads recorded']),
  ];
  const sums = { fee: 0, revenue: 0, payable: 0, owed: 0, finished: 0 };
  for (const property of data.properties) {
    const folder = folders.get(property.id);
    const finished = folder?.kind === 'finished' && folder.report ? folder : null;
    const s = finished?.statement ?? null;
    if (s && finished?.report) {
      sums.fee += s.feeCents;
      sums.revenue += s.incomeCents;
      if (s.payableCents >= 0) sums.payable += s.payableCents;
      else sums.owed += -s.payableCents;
      sums.finished += 1;
    }
    rows.push([
      text(property.name),
      text(property.id),
      text(STANDING_LABELS[property.standing]),
      text(property.draft ? 'Yes' : ''),
      text(s?.reference ?? ''),
      text(finished?.report?.id ?? ''),
      text(finished?.report ? whenWords(finished.report.finishedAt) : ''),
      s ? money(s.incomeCents) : null,
      s ? money(s.expensesCents) : null,
      s ? money(s.recordedCents) : null,
      s?.fee && s.fee.rateBasisPoints !== null && s.fee.baseCents !== null ? money(s.fee.baseCents) : null,
      s?.fee?.rateBasisPoints != null ? text(rateText(s.fee.rateBasisPoints)) : null,
      s?.fee && s.fee.computedCents !== null ? money(s.fee.computedCents) : null,
      s ? money(s.feeCents) : null,
      s?.fee ? text(s.fee.overwritten ? 'Yes' : 'No') : null,
      s ? money(s.totalCents) : null,
      s ? money(s.carriedCents) : null,
      s ? money(s.payableCents) : null,
      s && s.payableCents < 0 ? money(-s.payableCents) : null,
      finished?.report ? count(finished.report.downloads.length) : null,
    ]);
  }
  rows.push([]);
  rows.push([text(`Finished statements: ${sums.finished}`, true), null, null, null, null, null, null, money(sums.revenue, true), null, null, null, null, null, money(sums.fee, true), null, null, null, money(sums.payable, true), money(sums.owed, true)]);

  const statementRows: Cell[][] = [header(['Property', 'Statement', 'Report ID', 'Finished (Toronto)', 'File in this package', 'Bytes', 'SHA-256'])];
  for (const folder of data.folders) {
    if (folder.kind !== 'finished' || !folder.report) continue;
    const file = input.statements.get(folder.report.id);
    statementRows.push([text(folder.propertyName), text(folder.report.reference), text(folder.report.id), text(whenWords(folder.report.finishedAt)), text(file?.path ?? ''), file ? count(file.bytes) : null, text(file?.sha256 ?? folder.report.pdf.sha256)]);
  }
  if (statementRows.length === 1) statementRows.push([text(`No statement for ${monthLabel(data.month)} is finished.`)]);

  return workbookBytes(
    [
      { name: 'Fees', widths: [40, 24, 22, 10, 22, 24, 22, 14, 14, 14, 14, 9, 14, 14, 11, 14, 14, 14, 14, 10], rows },
      { name: 'Statements', widths: [40, 22, 24, 22, 90, 10, 66], rows: statementRows },
      {
        name: 'About',
        widths: [120],
        rows: aboutRows([
          `Nubnb's fee income for ${monthLabel(data.month)}, as the statements printed it. Made ${whenWords(data.madeAt)}, Toronto time.`,
          'Every property has a row. The figures are those of a finished statement; a property with none shows its standing alone.',
          'The fee is one printed amount. Nothing in Nubnb records whether HST applies to it.',
          'Statements: each finished statement of the month, its file in this package and its SHA-256, taken over the PDF when it was finished.',
        ]),
      },
    ],
    input.madeAt,
  );
}

// ─── What was not charged ──────────────────────────────────────

export interface NotChargedInput {
  data: MonthPackageData;
  /** Each receipt's file, by entry ID: its path under Nubnb's month folder. */
  receipts: Map<string, FileNote[]>;
  madeAt: Date;
}

export function notChargedWorkbook(input: NotChargedInput): Uint8Array<ArrayBuffer> {
  const { data } = input;
  const rows: Cell[][] = [header(['Property', 'Day sent (Toronto)', 'Ref', 'Entry ID', 'Kind', 'Logged by', 'Status', 'Reason', 'Items (CAD)', 'Tax (CAD)', 'Total (CAD)', 'Where it is charged', 'Receipt file'])];
  const historyRows: Cell[][] = [header(['Ref', 'When (Toronto)', 'What', 'From', 'To', 'By', 'Reason', 'Before', 'After'])];
  for (const item of data.notCharged as NotCharged[]) {
    const fields = fieldsOf(data, item.entryId);
    if (!fields) continue;
    const lines = linesAt(fields, (fields.history ?? []).length);
    const files = input.receipts.get(item.entryId) ?? [];
    rows.push([
      text(item.propertyName),
      text(whenWords(fields.createdAt)),
      text(item.entryId.slice(0, 6)),
      text(item.entryId),
      text(KIND_WORDS[fields.kind] ?? fields.kind),
      text(fields.kind === 'office' ? 'Office' : (fields.cleanerNameAtEntry ?? '')),
      text(fields.status ?? ''),
      text(fields.statusReason ?? ''),
      lines.kind === 'ok' ? money(lines.itemsCents) : text('Cannot be read'),
      fields.taxShape === 'in-lines' ? text('In the items') : lines.kind === 'ok' ? (lines.taxCents === null ? text('None entered') : money(lines.taxCents)) : null,
      lines.kind === 'ok' ? money(lines.totalCents) : null,
      text(item.printedIn ? `In the statement for ${monthLabel(item.printedIn.month)}${item.printedIn.reference ? ` (${item.printedIn.reference})` : ''}` : 'In no statement'),
      text(files.length > 0 ? files.map((file) => file.name).join(', ') : noReceiptWords(fields.kind)),
    ]);
    for (const event of fields.history ?? []) {
      historyRows.push([
        text(item.entryId.slice(0, 6)),
        text(whenWords(event.at)),
        text(event.action ?? ''),
        text(event.from ?? ''),
        text(event.to ?? ''),
        text(event.actor ? [event.actor.role ? (ACTOR_WORDS[event.actor.role] ?? event.actor.role) : '', event.actor.name ?? ''].filter(Boolean).join(': ') : ''),
        text(event.reason ?? ''),
        text(event.line ? lineWords(event.line.before) : event.tax ? taxWords(event.tax.before) : ''),
        text(event.line ? lineWords(event.line.after) : event.tax ? taxWords(event.tax.after) : ''),
      ]);
    }
  }
  if (rows.length === 1) rows.push([text(`Every entry sent in ${monthLabel(data.month)} is charged by its statement.`)]);

  return workbookBytes(
    [
      { name: 'Not charged', widths: [40, 22, 9, 24, 14, 20, 11, 30, 12, 12, 12, 34, 52], rows },
      { name: 'History', widths: [9, 22, 16, 12, 12, 26, 30, 30, 30], rows: historyRows },
      {
        name: 'About',
        widths: [120],
        rows: aboutRows([
          `Every entry sent in ${monthLabel(data.month)} that the month's statements do not charge: pending, rejected, removed, or charged by another month's statement. Made ${whenWords(data.madeAt)}, Toronto time.`,
          'For Nubnb only: it names who logged each entry. Owners’ folders never do.',
        ]),
      },
    ],
    input.madeAt,
  );
}
