/**
 * One property's cost report as a PDF, for its co-owners: the property, the
 * period, each approved entry with its date, what was bought and its total,
 * and the period total. No cleaner's name is in it. A discount or a return
 * is listed in "What was bought" with its amount, and is never the part cut
 * when the column is too narrow, so each total can be read from what is
 * listed.
 *
 * Written by hand as PDF 1.4 with Helvetica and Helvetica-Bold, which every
 * PDF reader carries, so no font is embedded and no package is added. US
 * Letter, portrait; the table's header repeats on every page and each page
 * is numbered. Text is encoded as Windows-1252 (WinAnsiEncoding): accented
 * letters print; a character outside it, an emoji say, prints as "?". The
 * widths are Adobe's Helvetica metrics, so amounts line up on the right and
 * a long list of items is cut to its column with "…".
 *
 * Client-safe, and pure: a report in, bytes out.
 */

import { formatCents, type LineNow } from '@/app/lib/cleaners/model';
import { generatedLabel, periodLabel, shortDay, whatWasBought, type CostReport } from './report';

// Widths of WinAnsiEncoding codes 32–255, in thousandths of the font size,
// from Adobe's Core 14 AFM files (Helvetica.afm, Helvetica-Bold.afm). Codes
// the encoding leaves undefined are 0; nothing here ever writes one.
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, 0,
  556, 0, 222, 556, 333, 1000, 556, 556, 333, 1000, 667, 333, 1000, 0, 611, 0,
  0, 222, 222, 333, 333, 350, 556, 1000, 333, 1000, 500, 333, 944, 0, 500, 667,
  278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333,
  400, 584, 333, 333, 333, 556, 537, 278, 333, 333, 365, 556, 834, 834, 834, 611,
  667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278,
  722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611,
  556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 278, 278, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500,
];

const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584, 0,
  556, 0, 278, 556, 500, 1000, 556, 556, 333, 1000, 667, 333, 1000, 0, 611, 0,
  0, 278, 278, 500, 500, 350, 556, 1000, 333, 1000, 556, 333, 944, 0, 500, 667,
  278, 333, 556, 556, 556, 556, 280, 556, 333, 737, 370, 556, 584, 333, 737, 333,
  400, 584, 333, 333, 333, 611, 556, 278, 333, 333, 365, 556, 834, 834, 834, 611,
  722, 722, 722, 722, 722, 722, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278,
  722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611,
  556, 556, 556, 556, 556, 556, 889, 556, 556, 556, 556, 556, 278, 278, 278, 278,
  611, 611, 611, 611, 611, 611, 611, 584, 611, 611, 611, 611, 611, 556, 611, 556,
];

type Face = 'regular' | 'bold';

const WIDTHS: Record<Face, number[]> = { regular: HELVETICA, bold: HELVETICA_BOLD };
const RESOURCE: Record<Face, string> = { regular: 'F1', bold: 'F2' };

/** Windows-1252 bytes for the characters outside Latin-1 that it has. */
const WIN_ANSI_EXTRA: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
  0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91,
  0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98,
  0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

const QUESTION_MARK = 0x3f;
const ELLIPSIS = 0x85;

/** Text as WinAnsiEncoding bytes. Anything the encoding lacks becomes "?". */
function winAnsi(text: string): number[] {
  const bytes: number[] = [];
  for (const char of text.normalize('NFC')) {
    const code = char.codePointAt(0) ?? QUESTION_MARK;
    if (code === 0x09 || code === 0x0a || code === 0x0d) bytes.push(0x20);
    else if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) bytes.push(code);
    else if (code === 0x2212) bytes.push(0x2d); // minus sign
    else bytes.push(WIN_ANSI_EXTRA[code] ?? QUESTION_MARK);
  }
  return bytes;
}

/** How wide bytes print, in points. */
function widthOf(bytes: number[], face: Face, size: number): number {
  let units = 0;
  for (const byte of bytes) units += WIDTHS[face][byte - 32] ?? 0;
  return (units * size) / 1000;
}

/** As much of the text as fits in `max` points, ending "…" when it had to be cut. */
function fitted(text: string, face: Face, size: number, max: number): number[] {
  const bytes = winAnsi(text);
  if (widthOf(bytes, face, size) <= max) return bytes;
  const room = max - widthOf([ELLIPSIS], face, size);
  const kept = bytes.slice();
  while (kept.length > 0 && widthOf(kept, face, size) > room) kept.pop();
  // No dangling space or comma before the ellipsis.
  while (kept.length > 0 && (kept[kept.length - 1] === 0x20 || kept[kept.length - 1] === 0x2c)) kept.pop();
  return [...kept, ELLIPSIS];
}

/** Text broken into lines of at most `max` points, at spaces. */
function wrapped(text: string, face: Face, size: number, max: number): number[][] {
  const lines: number[][] = [];
  let line: number[] = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line.length > 0 ? [...line, 0x20, ...winAnsi(word)] : winAnsi(word);
    if (line.length > 0 && widthOf(next, face, size) > max) {
      lines.push(line);
      line = winAnsi(word);
    } else {
      line = next;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines;
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

/** A PDF string literal: printable ASCII as it is, everything else as an octal escape. */
function literal(bytes: number[]): string {
  let out = '(';
  for (const byte of bytes) {
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) out += `\\${String.fromCharCode(byte)}`;
    else if (byte < 0x20 || byte > 0x7e) out += `\\${byte.toString(8).padStart(3, '0')}`;
    else out += String.fromCharCode(byte);
  }
  return `${out})`;
}

/** A coordinate, in points: at most two decimals, never an exponent. */
const pt = (value: number) => String(Math.round(value * 100) / 100);

class Page {
  readonly ops: string[] = [];

  text(value: string | number[], x: number, y: number, face: Face, size: number, gray = 0, align: 'left' | 'right' = 'left') {
    const bytes = typeof value === 'string' ? winAnsi(value) : value;
    const left = align === 'right' ? x - widthOf(bytes, face, size) : x;
    this.ops.push(`BT ${gray} g /${RESOURCE[face]} ${size} Tf ${pt(left)} ${pt(y)} Td ${literal(bytes)} Tj ET`);
  }

  rule(x1: number, x2: number, y: number, gray: number, lineWidth: number) {
    this.ops.push(`${gray} G ${lineWidth} w ${pt(x1)} ${pt(y)} m ${pt(x2)} ${pt(y)} l S`);
  }
}

// ─── Layout, in points from the bottom left ────────────────────

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const RIGHT = PAGE_WIDTH - MARGIN;
/** Where amounts end. A corrected entry's "*" sits just after. */
const AMOUNT_RIGHT = RIGHT - 8;
const COLUMN = { number: MARGIN + 16, date: MARGIN + 28, bought: MARGIN + 96, ref: RIGHT - 120 };
const ROW = 20;
/** The lowest a row's baseline may sit. */
const LOWEST_ROW = MARGIN + 8;
const MUTED = 0.45;

/** The table's header row. Returns the first row's baseline. */
function tableHeader(page: Page, y: number): number {
  page.text('#', COLUMN.number, y, 'bold', 8.5, MUTED, 'right');
  page.text('Date', COLUMN.date, y, 'bold', 8.5, MUTED);
  page.text('What was bought', COLUMN.bought, y, 'bold', 8.5, MUTED);
  page.text('Ref', COLUMN.ref, y, 'bold', 8.5, MUTED);
  page.text('Total', AMOUNT_RIGHT, y, 'bold', 8.5, MUTED, 'right');
  page.rule(MARGIN, RIGHT, y - 7, 0.75, 0.6);
  return y - 7 - 16;
}

const entriesLabel = (count: number) => (count === 0 ? 'No entries' : count === 1 ? '1 entry' : `${count} entries`);

/** UTF-16BE, as a PDF text string for the document's title. */
function textString(value: string): string {
  let hex = '<FEFF';
  for (let i = 0; i < value.length; i++) hex += value.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  return `${hex}>`;
}

/** A PDF date: D:YYYYMMDDHHmmSSZ, in UTC. */
function pdfDate(when: Date): string {
  const iso = when.toISOString();
  return `D:${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
}

/** The file: numbered objects, their cross-reference table and the trailer. */
function assemble(pages: Page[], title: string, created: Date): Uint8Array<ArrayBuffer> {
  const objects: string[] = [];
  const pageObject = (i: number) => 6 + i * 2;

  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[1] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageObject(i)} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[2] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  objects[4] = `<< /Title ${textString(title)} /Producer (Nubnb) /CreationDate (${pdfDate(created)}) >>`;
  pages.forEach((page, i) => {
    // Every byte of a content stream is ASCII (literal() escapes the rest), so its length is its byte count.
    const stream = page.ops.join('\n');
    objects[pageObject(i) - 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageObject(i) + 1} 0 R >>`;
    objects[pageObject(i)] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });

  // One character per byte throughout; the second line marks the file as binary.
  let out = '%PDF-1.4\n%âãÏÓ\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i);
  return bytes;
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
  report.entries.forEach((entry, i) => {
    if (y < LOWEST_ROW) nextPage(true);
    page.text(String(i + 1), COLUMN.number, y, 'regular', 10, MUTED, 'right');
    page.text(shortDay(entry.day), COLUMN.date, y, 'regular', 10);
    page.text(boughtCell(entry.lines, COLUMN.ref - 12 - COLUMN.bought), COLUMN.bought, y, 'regular', 10);
    page.text(entry.ref, COLUMN.ref, y, 'regular', 10, MUTED);
    page.text(formatCents(entry.totalCents), AMOUNT_RIGHT, y, 'regular', 10, 0, 'right');
    if (entry.corrected) page.text('*', AMOUNT_RIGHT + 1.5, y, 'regular', 10);
    page.rule(MARGIN, RIGHT, y - 7, 0.9, 0.4);
    y -= ROW;
  });

  // ── The period total, and what the numbers are ──
  const notes = [
    ...(report.entries.some((entry) => entry.corrected) ? ['* Corrected by Nubnb against the receipt.'] : []),
    ...(report.entries.some((entry) => entry.lines.some((line) => line.lineTotalCents < 0))
      ? ['Amounts in brackets were taken off: discounts and returns, already counted in the total.']
      : []),
    'Each entry is one receipt. Its total is the sum of the amounts the receipt prints for each line; quantities are never multiplied.',
  ].flatMap((note) => wrapped(note, 'regular', 8.5, RIGHT - MARGIN));

  let top = y + ROW - 9;
  if (top - 18 - 26 - (notes.length - 1) * 11.5 < MARGIN) {
    nextPage(false);
    top = 706;
  }
  page.rule(MARGIN, RIGHT, top, 0.25, 0.8);
  const base = top - 18;
  const amount = formatCents(report.totalCents);
  page.text(entriesLabel(report.entries.length), COLUMN.date, base, 'regular', 9.5, MUTED);
  page.text(amount, AMOUNT_RIGHT, base, 'bold', 11, 0, 'right');
  page.text('Period total', AMOUNT_RIGHT - widthOf(winAnsi(amount), 'bold', 11) - 14, base, 'bold', 11, 0, 'right');
  let noteY = base - 26;
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
