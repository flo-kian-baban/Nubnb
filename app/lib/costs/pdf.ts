/**
 * One property's cost report as a PDF, for its co-owners: the property, the
 * period, each approved entry with its date, what was bought or the work
 * done and its total, and the period total. No cleaner's or handyman's name
 * is in it. A discount or a return is listed in "What was bought / work
 * done" with its amount, and is never the part cut when the column is too
 * narrow, so each total can be read from what is listed. A work entry's
 * description (dispatch 24) wraps to a second line rather than being cut,
 * so the co-owner reads what was done; it is marked "Work:", and a cost the
 * office added (dispatch 23D) "Office:", each explained in a note, so the
 * three kinds are told apart on the page.
 *
 * Written by hand as PDF 1.4 with Helvetica and Helvetica-Bold, which every
 * PDF reader carries, so no font is embedded and no package is added
 * (app/lib/pdf/core.ts, lifted out of this file in dispatch 23B; the bytes
 * this module writes are unchanged). US Letter, portrait; the table's
 * header repeats on every page and each page is numbered. Text is encoded
 * as Windows-1252 (WinAnsiEncoding): accented letters print; a character
 * outside it, an emoji say, prints as "?". The widths are Adobe's Helvetica
 * metrics, so amounts line up on the right and a long list of items is cut
 * to its column with "…".
 *
 * Client-safe, and pure: a report in, bytes out.
 */

import { formatCents, isOneLineKind, type LineNow } from '@/app/lib/cleaners/model';
import { ELLIPSIS, MARGIN, MUTED, Page, RIGHT, assemble, fitted, widthOf, winAnsi, wrapped } from '@/app/lib/pdf/core';
import { byStatementText, chargedOnText, generatedLabel, periodLabel, shortDay, whatWasBought, type CostReport, type FromEarlier } from './report';
import { monthLabel } from '@/app/lib/reports/model';

/**
 * A work entry's description on at most two lines (dispatch 24): as many
 * whole words as fit on the first, the rest on the second, cut with "…"
 * only if even that is too long.
 */
function twoLines(text: string, max: number): number[][] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [winAnsi('—')];
  const line: string[] = [];
  let i = 0;
  for (; i < words.length; i++) {
    if (line.length > 0 && widthOf(winAnsi([...line, words[i]].join(' ')), 'regular', 10) > max) break;
    line.push(words[i]);
  }
  const first = fitted(line.join(' '), 'regular', 10, max);
  if (i >= words.length) return [first];
  return [first, fitted(words.slice(i).join(' '), 'regular', 10, max)];
}

/**
 * An entry's "What was bought", fitted to its column. The money taken off —
 * discounts and returns, with their amounts — is kept whole; the items'
 * names are what gets cut with "…" when there is not room for both.
 */
function boughtCell(lines: LineNow[], max: number): number[] {
  const { items, adjustments } = whatWasBought(lines);
  const taken = adjustments.join(', ');
  if (items.length === 0) return taken ? fitted(taken, 'regular', 10, max) : winAnsi('—');
  if (!taken) return fitted(items.join(', '), 'regular', 10, max);
  const tail = winAnsi(`, ${taken}`);
  const room = max - widthOf(tail, 'regular', 10);
  // Not even an ellipsis beside it: the money taken off alone, cut if it must be.
  if (room <= widthOf([ELLIPSIS], 'regular', 10)) return fitted(taken, 'regular', 10, max);
  return [...fitted(items.join(', '), 'regular', 10, room), ...tail];
}

// ─── Layout, in points from the bottom left ────────────────────

/** Where amounts end. A corrected entry's "*" sits just after. */
const AMOUNT_RIGHT = RIGHT - 8;
/** Items, tax and total each right-align at their edge (dispatch 21); the ref sits before them. */
const COLUMN = { number: MARGIN + 16, date: MARGIN + 28, bought: MARGIN + 96, ref: RIGHT - 232, items: RIGHT - 120, tax: RIGHT - 62 };
const ROW = 20;
/** The lowest a row's baseline may sit. */
const LOWEST_ROW = MARGIN + 8;

/** The table's header row. Returns the first row's baseline. */
function tableHeader(page: Page, y: number): number {
  page.text('#', COLUMN.number, y, 'bold', 8.5, MUTED, 'right');
  page.text('Date', COLUMN.date, y, 'bold', 8.5, MUTED);
  page.text('What was bought / work done', COLUMN.bought, y, 'bold', 8.5, MUTED);
  page.text('Ref', COLUMN.ref, y, 'bold', 8.5, MUTED);
  page.text('Items', COLUMN.items, y, 'bold', 8.5, MUTED, 'right');
  page.text('Tax', COLUMN.tax, y, 'bold', 8.5, MUTED, 'right');
  page.text('Total', AMOUNT_RIGHT, y, 'bold', 8.5, MUTED, 'right');
  page.rule(MARGIN, RIGHT, y - 7, 0.75, 0.6);
  return y - 7 - 16;
}

/** An entry's tax column: the amount, "none" when the cleaner gave none, "in items" on an older entry. */
function taxText(entry: CostReport['entries'][number]): string {
  if (entry.taxShape === 'in-lines') return 'in items';
  return entry.taxCents === null ? 'none' : formatCents(entry.taxCents);
}

const entriesLabel = (count: number) => (count === 0 ? 'No entries' : count === 1 ? '1 entry' : `${count} entries`);

/** The section's header row (Kian's ruling K1 of 2026-10-18). Returns the first row's baseline. */
function earlierHeader(page: Page, y: number): number {
  page.text('Date', COLUMN.date, y, 'bold', 8.5, MUTED);
  page.text('What it was · the month it belongs to', COLUMN.bought, y, 'bold', 8.5, MUTED);
  page.text('Ref', COLUMN.ref, y, 'bold', 8.5, MUTED);
  page.text('On this statement', AMOUNT_RIGHT, y, 'bold', 8.5, MUTED, 'right');
  page.rule(MARGIN, RIGHT, y - 7, 0.75, 0.6);
  return y - 7 - 16;
}

/**
 * A whole month's section "On this month's statement from earlier months" (Kian's ruling K1 of 2026-10-18), from `y`
 * down, on new pages as needed: each cost of an earlier month this month's statement charges, late or as an
 * adjustment, with the month it belongs to; their total; and what the statement charges for costs in all. Returns the
 * baseline under it.
 */
function earlierSection(section: FromEarlier, at: { page: Page; y: number }, nextPage: () => void, current: () => { page: Page; y: number }): number {
  let { page, y } = at;
  const fresh = () => {
    nextPage();
    ({ page, y } = current());
  };
  if (y - 18 - 23 - 2 * (ROW + 12) - 40 < MARGIN) fresh();
  page.text("On this month's statement from earlier months", MARGIN, y, 'bold', 11);
  y = earlierHeader(page, y - 18);
  const whatWidth = COLUMN.ref - 12 - COLUMN.bought;
  for (const row of section.rows) {
    if (y - 12 < LOWEST_ROW + 40) {
      fresh();
      y = earlierHeader(page, y);
    }
    page.text(row.office === null ? shortDay(row.day) : row.office.month, COLUMN.date, y, 'regular', 10);
    page.text(fitted(`${row.kind === 'adjustment' ? 'Adjustment: ' : row.entryKind === 'work' ? 'Work: ' : row.entryKind === 'office' ? 'Office: ' : ''}${row.what}`, 'regular', 10, whatWidth), COLUMN.bought, y, 'regular', 10);
    page.text(fitted(`Belongs to ${monthLabel(row.belongsTo)}${row.office !== null ? ` · ${row.office.logged}` : ''}`, 'regular', 8, whatWidth), COLUMN.bought, y - 12, 'regular', 8, MUTED);
    page.text(row.ref, COLUMN.ref, y, 'regular', 10, MUTED);
    page.text(formatCents(row.cents), AMOUNT_RIGHT, y, 'regular', 10, 0, 'right');
    page.rule(MARGIN, RIGHT, y - 12 - 7, 0.9, 0.4);
    y -= ROW + 12;
  }
  if (y - 34 < MARGIN) fresh();
  const base = y + ROW - 9 - 18;
  page.rule(MARGIN, RIGHT, base + 18, 0.25, 0.8);
  page.text('From earlier months', COLUMN.ref, base, 'bold', 11, 0);
  page.text(formatCents(section.totalCents), AMOUNT_RIGHT, base, 'bold', 11, 0, 'right');
  page.text(`${monthLabel(section.month)}'s statement charges for costs in all`, COLUMN.date, base - 16, 'regular', 9.5, 0);
  page.text(formatCents(section.statementCents), AMOUNT_RIGHT, base - 16, 'regular', 9.5, 0, 'right');
  return base - 16 - 26;
}


/** The report's bytes. */
export function pdfFor(report: CostReport): Uint8Array<ArrayBuffer> {
  const period = periodLabel(report.from, report.to);
  const pages: Page[] = [];
  let page = new Page();
  pages.push(page);

  // ── First page: who and when ──
  page.text('NUBNB · PROPERTY COSTS', MARGIN, 730, 'bold', 8.5, MUTED);
  page.text(fitted(report.propertyName, 'bold', 20, RIGHT - MARGIN), MARGIN, 702, 'bold', 20);
  page.text(period, MARGIN, 682, 'regular', 11.5);
  page.text('Approved costs, in Canadian dollars', MARGIN, 667, 'regular', 9.5, MUTED);
  let y = tableHeader(page, 633);

  const nextPage = (withTable: boolean) => {
    page = new Page();
    pages.push(page);
    page.text(fitted(`${report.propertyName} · ${period}`, 'regular', 9, RIGHT - MARGIN), MARGIN, 730, 'regular', 9, MUTED);
    y = withTable ? tableHeader(page, 700) : 700;
  };

  // ── The entries, oldest first ──
  if (report.entries.length === 0) {
    page.text('No approved costs in this period.', COLUMN.date, y, 'regular', 10, MUTED);
    y -= ROW;
  }
  const boughtWidth = COLUMN.ref - 12 - COLUMN.bought;
  report.entries.forEach((entry, i) => {
    // A work or office entry's description, marked by kind, wraps to a second line (dispatch 24); two lines at most, the rest cut with "…".
    const work = isOneLineKind(entry.kind) ? twoLines(`${entry.kind === 'work' ? 'Work' : 'Office'}: ${whatWasBought(entry.lines).items.join(', ')}`, boughtWidth) : null;
    // An office cost is dated by the month it belongs to, the day it was logged in brackets under it (Kian's ruling of 2026-10-12).
    const office = entry.office;
    // An entry charged on another month's statement says which, under what was bought (dispatch 37A, T1); split
    // across two statements, it wraps rather than being cut (dispatch 37B).
    const charged = entry.chargedOn ? wrapped(chargedOnText(entry.chargedOn), 'regular', 8, boughtWidth) : null;
    const boughtLines = (work?.length ?? 1) + (charged?.length ?? 0);
    const extraLines = Math.max(office !== null ? 1 : 0, boughtLines - 1);
    const secondLine = extraLines > 0;
    if (y - extraLines * 12 < LOWEST_ROW) nextPage(true);
    page.text(String(i + 1), COLUMN.number, y, 'regular', 10, MUTED, 'right');
    if (office === null) {
      page.text(shortDay(entry.day), COLUMN.date, y, 'regular', 10);
    } else {
      page.text(office.month, COLUMN.date, y, 'regular', 10);
      page.text(fitted(office.logged, 'regular', 8, COLUMN.bought - 8 - COLUMN.date), COLUMN.date, y - 12, 'regular', 8, MUTED);
    }
    if (work === null) {
      page.text(boughtCell(entry.lines, boughtWidth), COLUMN.bought, y, 'regular', 10);
    } else {
      page.text(work[0], COLUMN.bought, y, 'regular', 10);
      if (work.length > 1) page.text(work[1], COLUMN.bought, y - 12, 'regular', 10);
    }
    page.text(entry.ref, COLUMN.ref, y, 'regular', 10, MUTED);
    page.text(formatCents(entry.itemsCents), COLUMN.items, y, 'regular', 10, 0, 'right');
    page.text(taxText(entry), COLUMN.tax, y, 'regular', 10, entry.taxShape === 'field' && entry.taxCents !== null ? 0 : MUTED, 'right');
    page.text(formatCents(entry.totalCents), AMOUNT_RIGHT, y, 'regular', 10, 0, 'right');
    if (entry.corrected) page.text('*', AMOUNT_RIGHT + 1.5, y, 'regular', 10);
    charged?.forEach((line, k) => page.text(line, COLUMN.bought, y - (boughtLines - charged.length + k) * 12, 'regular', 8, MUTED));
    const rowHeight = secondLine ? ROW + extraLines * 12 : ROW;
    page.rule(MARGIN, RIGHT, y - rowHeight + ROW - 7, 0.9, 0.4);
    y -= rowHeight;
  });

  // ── The period total, and what the numbers are ──
  const notes = [
    ...(report.entries.some((entry) => entry.corrected && entry.kind !== 'cleaning') ? ['* Corrected by Nubnb against the receipt.'] : []),
    ...(report.entries.some((entry) => entry.corrected && entry.kind === 'cleaning') ? ['* A cleaning marked so was changed by Nubnb after it was logged.'] : []),
    ...(report.entries.some((entry) => entry.lines.some((line) => line.lineTotalCents < 0))
      ? ['Amounts in brackets were taken off: discounts and returns, already counted in the total.']
      : []),
    ...(report.taxInLines
      ? ['Entries whose tax reads "in items" were sent before tax was recorded apart: any tax the cleaner typed is a line among their items, and inside their Items amount.']
      : []),
    ...(report.entries.some((entry) => entry.kind === 'work')
      ? ['An entry marked "Work:" is a handyman\'s work done for the property, at the price logged: no receipt, and Items is that price.']
      : []),
    ...(report.entries.some((entry) => entry.kind === 'office')
      ? ['An entry marked "Office:" was added by Nubnb\'s office, with no receipt: Items is the amount entered.']
      : []),
    ...(report.byStatement
      ? ['An entry marked with a statement belongs to this period but is charged on that month\'s statement: its own month\'s statement was already finished when it was logged or changed.']
      : []),
    ...(report.fromEarlier
      ? ['From earlier months: costs that belong to an earlier month, on this month\'s statement because that month\'s statement was already finished when they were logged, approved or changed; an adjustment is a change to a cost an earlier statement printed.']
      : []),
    ...(report.entries.some((entry) => entry.kind === 'cleaning')
      ? ['An entry reading "Cleaning" is one cleaning of the property, on the day it was cleaned, at the amount Nubnb pays for it; the statement prints the month\'s cleanings as one line.']
      : []),
    'Each entry is one receipt, one piece of work, or one cost the office entered. Items is the sum of the amounts the receipt prints for each line, Tax is the receipt\'s tax, and Total is the two together; quantities are never multiplied.',
  ].flatMap((note) => wrapped(note, 'regular', 8.5, RIGHT - MARGIN));

  // The period's total by statement (dispatch 37A, T1), under the total, only when an entry is charged on another month's.
  const split = report.byStatement ? wrapped(byStatementText(report.byStatement, report.unchargedCents ?? 0), 'regular', 9.5, RIGHT - COLUMN.date) : [];
  const splitHeight = split.length * 13;
  let top = y + ROW - 9;
  if (top - 18 - splitHeight - 26 - (notes.length - 1) * 11.5 < MARGIN) {
    nextPage(false);
    top = 706;
  }
  page.rule(MARGIN, RIGHT, top, 0.25, 0.8);
  const base = top - 18;
  const amount = formatCents(report.totalCents);
  page.text(entriesLabel(report.entries.length), COLUMN.date, base, 'regular', 9.5, MUTED);
  page.text(formatCents(report.itemsCents), COLUMN.items, base, 'regular', 9.5, MUTED, 'right');
  page.text(formatCents(report.taxCents), COLUMN.tax, base, 'regular', 9.5, MUTED, 'right');
  page.text(amount, AMOUNT_RIGHT, base, 'bold', 11, 0, 'right');
  page.text('Period total', COLUMN.ref, base, 'bold', 11, 0);
  split.forEach((line, i) => page.text(line, COLUMN.date, base - 16 - i * 13, 'regular', 9.5, 0));
  let noteY = base - 26 - splitHeight;
  // Kian's ruling K1 (2026-10-18): a whole month's ledger lists, under its total, what the statement charges for earlier months.
  if (report.fromEarlier) {
    noteY = earlierSection(report.fromEarlier, { page, y: noteY - 4 }, () => nextPage(false), () => ({ page, y }));
    if (noteY - (notes.length - 1) * 11.5 < MARGIN) {
      nextPage(false);
      noteY = 706;
    }
  }
  for (const line of notes) {
    page.text(line, MARGIN, noteY, 'regular', 8.5, 0.4);
    noteY -= 11.5;
  }

  // ── Every page: when it was made, and which page ──
  const generated = `Generated ${generatedLabel(report.generatedAt)}`;
  pages.forEach((p, i) => {
    p.text(generated, MARGIN, 34, 'regular', 8, 0.5);
    p.text(`Page ${i + 1} of ${pages.length}`, RIGHT, 34, 'regular', 8, 0.5, 'right');
  });

  return assemble(pages, `Nubnb costs – ${report.propertyName} – ${period}`, report.generatedAt);
}
