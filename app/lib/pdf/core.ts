/**
 * The PDF writer's core (dispatch 23B, lifted from costs/pdf.ts, whose
 * `pdfFor` is unchanged byte for byte): PDF 1.4 by hand, Helvetica and
 * Helvetica-Bold with Adobe's metrics so text can be measured, right-aligned,
 * cut with "…" and wrapped; WinAnsi text; US Letter portrait; a title and
 * creation date in the Info dictionary. Three drawing operations: text, a
 * horizontal rule, and a filled rectangle (`re f`), the last one added for
 * the monthly statement's shaded band and boxed closing figure
 * (reports/statement-pdf.ts) — and, since dispatch 23E, an image: a
 * Flate-compressed RGB XObject `assemble` is handed and `Page.image` draws,
 * for the NuBNB Suites mark on the Payment Summary. With no image handed,
 * the file is byte for byte what it was. Each layout — the ledger report,
 * the statement — is its own module over this one.
 *
 * Client-safe, and pure.
 */

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

export type Face = 'regular' | 'bold';

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
export const ELLIPSIS = 0x85;

/** Text as WinAnsiEncoding bytes. Anything the encoding lacks becomes "?". */
export function winAnsi(text: string): number[] {
  const bytes: number[] = [];
  for (const char of text.normalize('NFC')) {
    const code = char.codePointAt(0) ?? QUESTION_MARK;
    if (code === 0x09 || code === 0x0a || code === 0x0d) bytes.push(0x20);
    else if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) bytes.push(code);
    else if (code === 0x2212) bytes.push(0x2d); // minus sign
    else if (code === 0x30fb) bytes.push(0xb7); // katakana middle dot, as the reports NuBNB sends use it: "Resolution Payout・Jul 28–29"
    else bytes.push(WIN_ANSI_EXTRA[code] ?? QUESTION_MARK);
  }
  return bytes;
}

/** How wide bytes print, in points. */
export function widthOf(bytes: number[], face: Face, size: number): number {
  let units = 0;
  for (const byte of bytes) units += WIDTHS[face][byte - 32] ?? 0;
  return (units * size) / 1000;
}

/** As much of the text as fits in `max` points, ending "…" when it had to be cut. */
export function fitted(text: string, face: Face, size: number, max: number): number[] {
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
export function wrapped(text: string, face: Face, size: number, max: number): number[][] {
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

/** A PDF string literal: printable ASCII as it is, everything else as an octal escape. */
export function literal(bytes: number[]): string {
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

export class Page {
  readonly ops: string[] = [];

  text(value: string | number[], x: number, y: number, face: Face, size: number, gray = 0, align: 'left' | 'right' = 'left') {
    const bytes = typeof value === 'string' ? winAnsi(value) : value;
    const left = align === 'right' ? x - widthOf(bytes, face, size) : x;
    this.ops.push(`BT ${gray} g /${RESOURCE[face]} ${size} Tf ${pt(left)} ${pt(y)} Td ${literal(bytes)} Tj ET`);
  }

  rule(x1: number, x2: number, y: number, gray: number, lineWidth: number) {
    this.ops.push(`${gray} G ${lineWidth} w ${pt(x1)} ${pt(y)} m ${pt(x2)} ${pt(y)} l S`);
  }

  /** A filled rectangle, from its bottom-left corner. Text drawn after it sets its own fill gray. */
  rect(x: number, y: number, width: number, height: number, gray: number) {
    this.ops.push(`${gray} g ${pt(x)} ${pt(y)} ${pt(width)} ${pt(height)} re f`);
  }

  /** An image handed to `assemble` under `name`, drawn `width` × `height` points from its bottom-left corner. */
  image(name: string, x: number, y: number, width: number, height: number) {
    this.ops.push(`q ${pt(width)} 0 0 ${pt(height)} ${pt(x)} ${pt(y)} cm /${name} Do Q`);
  }
}

/** An image for `assemble`: 8-bit RGB rows, Flate-compressed, drawn by `Page.image(name, …)`. */
export interface PdfImage {
  /** The resource name the pages draw it by: "Im1". */
  name: string;
  width: number;
  height: number;
  /** The deflated RGB samples, row by row, three bytes a pixel. */
  data: Uint8Array;
}

/** Bytes as a one-character-per-byte string, so a binary stream sits in the file like everything else. */
function latin1(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return out;
}

/** UTF-16BE, as a PDF text string for the document's title. */
// ─── The page, in points from the bottom left ──────────────────

export const PAGE_WIDTH = 612;
export const PAGE_HEIGHT = 792;
export const MARGIN = 54;
export const RIGHT = PAGE_WIDTH - MARGIN;
/** The gray of captions and secondary text. */
export const MUTED = 0.45;

export function textString(value: string): string {
  let hex = '<FEFF';
  for (let i = 0; i < value.length; i++) hex += value.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  return `${hex}>`;
}

/** A PDF date: D:YYYYMMDDHHmmSSZ, in UTC. */
export function pdfDate(when: Date): string {
  const iso = when.toISOString();
  return `D:${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
}

/**
 * The file: numbered objects, their cross-reference table and the trailer.
 * Images, when any, are objects after the pages and are named in every
 * page's resources; with none, nothing in the file changes.
 */
export function assemble(pages: Page[], title: string, created: Date, images: PdfImage[] = []): Uint8Array<ArrayBuffer> {
  const objects: string[] = [];
  const pageObject = (i: number) => 6 + i * 2;
  const imageObject = (j: number) => 6 + pages.length * 2 + j;
  const xobjects = images.length === 0 ? '' : ` /XObject << ${images.map((image, j) => `/${image.name} ${imageObject(j)} 0 R`).join(' ')} >>`;

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
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xobjects} >> /Contents ${pageObject(i) + 1} 0 R >>`;
    objects[pageObject(i)] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  images.forEach((image, j) => {
    // The samples are binary; one character per byte keeps the offsets right.
    objects[imageObject(j) - 1] =
      `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB ` +
      `/BitsPerComponent 8 /Filter /FlateDecode /Length ${image.data.length} >>\nstream\n${latin1(image.data)}\nendstream`;
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

