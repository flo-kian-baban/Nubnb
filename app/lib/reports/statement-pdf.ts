/**
 * The Payment Summary as a PDF (dispatch 23E): the document NuBNB sends its
 * owners, laid out as the reports it sends today — the NuBNB Suites mark,
 * "Payment Summary", the reference, the date, "Your Revenue Share" at the
 * top, "Report For", one table with Description · Transaction · Rate ·
 * Amount, Total, the carried balance, Notes — over app/lib/pdf/core.ts, the
 * writer the ledger PDF uses, with its image added for the mark.
 *
 * The same pure function runs in the editor on every change (the live
 * preview) and on the server at finish, on the frozen inputs; the bytes the
 * server stores are these bytes. A draft says "Draft · not yet issued" under
 * its reference; the finished statement does not.
 *
 * A statement finished before this (schema version 1 or 2) is drawn by the
 * writer of its time, kept verbatim in statement-pdf-legacy.ts, so its
 * preview is the bytes that were stored.
 *
 * Client-safe, and pure: a statement in, bytes out.
 */

import { formatCents } from '@/app/lib/cleaners/model';
import { PAGE_HEIGHT, PAGE_WIDTH, Page, assemble, fitted, widthOf, winAnsi, wrapped, type PdfImage } from '@/app/lib/pdf/core';
import { LOGO_HEIGHT, LOGO_WIDTH, logoBytes } from '@/app/lib/pdf/logo';
import { dateText } from './model';
import { printedLines, type AnyStatement, type Statement } from './statement';
import { legacyStatementPdf } from './statement-pdf-legacy';

/** What the head prints under the mark: the company, its site and both numbers, as the reports NuBNB sends print them. */
export const NUBNB_CONTACT = ['www.nubnb.ca', '416-738-1850', '647-500-8043'] as const;
export const NUBNB_NAME = 'NuBNB Suites';

const M = 46;
const R = PAGE_WIDTH - M;
const TOP = PAGE_HEIGHT - 40;
/** Where the running flow must stop on a page, leaving room for the foot. */
const LOWEST = 58;
const ROW = 17;
const WRAP = 12;
/** The table's columns: each number is the right edge it is aligned to; the description runs from DESC to DESC_END. */
const COL = { desc: M + 4, descEnd: R - 230, qty: R - 170, rate: R - 90, amount: R - 6 };
const BAR_GRAY = 0.22;
const BAND_GRAY = 0.94;
const MUTED = 0.45;

const LOGO_DRAWN_WIDTH = 84;
const LOGO_DRAWN_HEIGHT = Math.round((LOGO_DRAWN_WIDTH * LOGO_HEIGHT) / LOGO_WIDTH * 100) / 100;

/** A label that ends with a colon, as the reports print "Total:" and "Balance From June:". */
const withColon = (label: string) => (label.trim().endsWith(':') ? label.trim() : `${label.trim()}:`);

/** The running layout: a page, a baseline, and the way to the next page. */
class Flow {
  readonly pages: Page[] = [];
  page!: Page;
  y = TOP;
  constructor(private readonly runningHead: string) {
    this.nextPage();
  }
  nextPage() {
    const first = this.pages.length === 0;
    this.page = new Page();
    this.pages.push(this.page);
    this.y = TOP;
    if (!first) {
      this.page.text(fitted(this.runningHead, 'regular', 9, R - M), M, this.y - 4, 'regular', 9, MUTED);
      this.y -= 24;
    }
  }
  /** Make sure `height` points are left; else a new page, and `onBreak` draws what a continued block repeats. */
  need(height: number, onBreak?: () => void) {
    if (this.y - height < LOWEST) {
      this.nextPage();
      onBreak?.();
    }
  }
}

/** The Payment Summary's bytes; a legacy statement goes to the writer of its time. */
export function statementPdf(statement: AnyStatement): Uint8Array<ArrayBuffer> {
  if (statement.legacy) return legacyStatementPdf(statement);
  return paymentSummaryPdf(statement);
}

function paymentSummaryPdf(statement: Statement): Uint8Array<ArrayBuffer> {
  const reference = statement.reference.trim();
  const refText = reference ? `# ${reference}` : '# (no reference yet)';
  const flow = new Flow(`Payment Summary · ${refText} · continued`);
  const { page } = flow;

  // ── The mark, and the company ──
  page.image('Im1', M, TOP - LOGO_DRAWN_HEIGHT, LOGO_DRAWN_WIDTH, LOGO_DRAWN_HEIGHT);
  let left = TOP - LOGO_DRAWN_HEIGHT - 20;
  page.text(NUBNB_NAME, M, left, 'bold', 10);
  for (const line of NUBNB_CONTACT) {
    left -= 13;
    page.text(line, M, left, 'regular', 9.5);
  }

  // ── Report For ──
  if (statement.reportFor && statement.reportFor.name.trim() !== '') {
    left -= 26;
    page.text('Report For:', M, left, 'regular', 9.5, MUTED);
    left -= 15;
    page.text(fitted(statement.reportFor.name, 'bold', 10, 250), M, left, 'bold', 10);
    for (const line of statement.reportFor.address.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
      left -= 13;
      page.text(fitted(line, 'regular', 9.5, 250), M, left, 'regular', 9.5);
    }
  }

  // ── Title, reference, date, the headline figure ──
  page.text('Payment Summary', R, TOP - 22, 'regular', 26, 0.25, 'right');
  page.text(fitted(refText, 'regular', 11, 300), R, TOP - 40, 'regular', 11, MUTED, 'right');
  let right = TOP - 40;
  if (statement.draft) {
    right -= 13;
    page.text('Draft · not yet issued', R, right, 'regular', 8.5, 0.55, 'right');
  }
  if (statement.supersedes) {
    right -= 13;
    const dated = statement.supersedes.reportDate ? ` dated ${dateText(statement.supersedes.reportDate)}` : '';
    page.text(fitted(`Replaces # ${statement.supersedes.ref}${dated} · ${statement.supersedes.reason}`, 'regular', 8.5, 330), R, right, 'regular', 8.5, MUTED, 'right');
  }
  right -= 30;
  const BLOCK_LEFT = R - 290;
  page.text('Date:', BLOCK_LEFT + 10, right, 'regular', 10, MUTED);
  page.text(statement.reportDate ? dateText(statement.reportDate) : '—', COL.amount, right, 'regular', 10, 0, 'right');
  right -= 12;
  page.rect(BLOCK_LEFT, right - 20, R - BLOCK_LEFT, 26, BAND_GRAY);
  page.text('Your Revenue Share:', BLOCK_LEFT + 10, right - 12, 'bold', 11);
  page.text(formatCents(statement.payableCents), COL.amount, right - 12, 'bold', 11, 0, 'right');
  right -= 20;

  // ── The table ──
  flow.y = Math.min(left, right) - 34;
  const header = () => {
    const y = flow.y;
    flow.page.rect(M - 6, y - 6, R - M + 12, 20, BAR_GRAY);
    flow.page.text('Description', COL.desc, y, 'regular', 9.5, 1);
    flow.page.text('Transaction', COL.qty, y, 'regular', 9.5, 1, 'right');
    flow.page.text('Rate', COL.rate, y, 'regular', 9.5, 1, 'right');
    flow.page.text('Amount', COL.amount, y, 'regular', 9.5, 1, 'right');
    flow.y -= ROW + 6;
  };
  header();
  const rows = printedLines(statement);
  if (rows.length === 0) {
    flow.need(ROW, header);
    flow.page.text('Nothing to report this month.', COL.desc, flow.y, 'regular', 10, MUTED);
    flow.y -= ROW;
  }
  for (const row of rows) {
    const lines = wrapped(row.description, 'regular', 10, COL.descEnd - COL.desc);
    const height = ROW + Math.max(0, lines.length - 1) * WRAP;
    flow.need(height, header);
    const y = flow.y;
    lines.forEach((line, i) => flow.page.text(line, COL.desc, y - i * WRAP, 'regular', 10));
    flow.page.text(String(row.quantity), COL.qty, y, 'regular', 10, 0.1, 'right');
    flow.page.text(formatCents(row.rateCents), COL.rate, y, 'regular', 10, 0.1, 'right');
    flow.page.text(formatCents(row.amountCents), COL.amount, y, 'regular', 10, 0, 'right');
    flow.page.rule(M - 6, R + 6, y - height + ROW - 7, 0.88, 0.4);
    flow.y -= height;
  }

  // ── Total, the carried balance ──
  flow.need(ROW * 2.5 + (statement.carried ? ROW : 0));
  flow.y -= 10;
  flow.page.text('Total:', COL.rate, flow.y, 'regular', 10, MUTED, 'right');
  flow.page.text(formatCents(statement.totalCents), COL.amount, flow.y, 'bold', 10.5, 0, 'right');
  flow.y -= ROW;
  if (statement.carried) {
    const label = withColon(statement.carried.label);
    const width = widthOf(winAnsi(label), 'regular', 10);
    flow.page.text(width > 250 ? fitted(label, 'regular', 10, 250) : label, COL.rate, flow.y, 'regular', 10, MUTED, 'right');
    flow.page.text(formatCents(statement.carried.amountCents), COL.amount, flow.y, 'regular', 10, 0, 'right');
    flow.y -= ROW;
  }

  // ── Notes ──
  if (statement.notes && statement.notes.trim() !== '') {
    flow.need(ROW * 2.5);
    flow.y -= 14;
    flow.page.text('Notes:', M, flow.y, 'regular', 9.5, MUTED);
    flow.y -= 15;
    for (const paragraph of statement.notes.split(/\r?\n/)) {
      if (paragraph.trim() === '') {
        flow.y -= 6;
        continue;
      }
      for (const line of wrapped(paragraph, 'regular', 9.5, R - M)) {
        flow.need(13);
        flow.page.text(line, M, flow.y, 'regular', 9.5, 0.1);
        flow.y -= 13;
      }
    }
  }

  // ── Every page ──
  flow.pages.forEach((p, i) => {
    p.text(`${NUBNB_NAME} · ${NUBNB_CONTACT[0]}`, M, 30, 'regular', 8, 0.5);
    p.text(`${refText} · Page ${i + 1} of ${flow.pages.length}`, R, 30, 'regular', 8, 0.5, 'right');
  });

  const images: PdfImage[] = [{ name: 'Im1', width: LOGO_WIDTH, height: LOGO_HEIGHT, data: logoBytes() }];
  const title = `Payment Summary ${reference || 'draft'}`;
  const created = statement.reportDate && Number.isFinite(Date.parse(statement.reportDate)) ? new Date(`${statement.reportDate}T12:00:00Z`) : new Date(0);
  return assemble(flow.pages, title, created, images);
}
