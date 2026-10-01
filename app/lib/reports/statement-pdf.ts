/**
 * The monthly statement as a PDF, for a property's co-owners (dispatch 23B):
 * the head, the income rows, the recorded costs on a grey band (with the
 * late entries and the adjustments under their own captions), the fee, the
 * boxed closing figure, the notes, and on every page the running head and
 * the page number. Laid out over app/lib/pdf/core.ts, the writer the ledger
 * PDF uses, with its one addition, the filled rectangle.
 *
 * The same pure function runs in the editor on every change (the live
 * preview) and on the server at finish, on the frozen inputs; the bytes the
 * server stores are these bytes. A draft prints "Draft" where the reference
 * goes and no finish time; the finished statement prints its ref and the
 * time it was finished.
 *
 * Client-safe, and pure: a statement in, bytes out.
 */

import { formatCents } from '@/app/lib/cleaners/model';
import { shortDay } from '@/app/lib/costs/report';
import { MARGIN, MUTED, PAGE_HEIGHT, Page, RIGHT, assemble, fitted, wrapped } from '@/app/lib/pdf/core';
import { INCOME_SOURCE_LABELS, monthLabel } from './model';
import { closingWords, nothingToReport, preparedFor, type Statement } from './statement';

const torontoTime = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', hour: 'numeric', minute: '2-digit' });
const torontoDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' });

/** "3 Oct 2026, 11:42 a.m., Toronto time". */
function finishedLabel(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return iso;
  const parts = Object.fromEntries(torontoDay.formatToParts(new Date(time)).map((part) => [part.type, part.value]));
  return `${shortDay(`${parts.year}-${parts.month}-${parts.day}`)}, ${torontoTime.format(time)}, Toronto time`;
}

/** "3 Oct 2026" for a finish time; the ISO text if it does not parse. */
function finishedDay(iso: string | null): string {
  if (iso === null) return 'an earlier date';
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return iso;
  const parts = Object.fromEntries(torontoDay.formatToParts(new Date(time)).map((part) => [part.type, part.value]));
  return shortDay(`${parts.year}-${parts.month}-${parts.day}`);
}

/** The band behind the recorded cost rows, and the text on it. */
const BAND_GRAY = 0.93;
const ROW = 18;
const AMOUNT_RIGHT = RIGHT - 8;
/** Where the running flow must stop on a page, leaving room for the foot. */
const LOWEST = MARGIN + 30;
const TOP = PAGE_HEIGHT - 92;

/** An amount in brackets when negative, as the ledger PDF prints money taken off. */
const money = (cents: number) => (cents < 0 ? `(${formatCents(-cents)})` : formatCents(cents));

/**
 * The running layout: a page, a baseline, and the way to the next page. Each
 * block asks for the room it needs before drawing, so a block never splits
 * across a page break mid-row.
 */
class Flow {
  readonly pages: Page[] = [];
  page!: Page;
  y = TOP;
  constructor(private readonly runningHead: string) {
    this.nextPage();
  }
  /** A new page. The first page carries the head; every later one the running head. */
  nextPage() {
    const first = this.pages.length === 0;
    this.page = new Page();
    this.pages.push(this.page);
    if (!first) this.page.text(fitted(this.runningHead, 'regular', 9, RIGHT - MARGIN), MARGIN, PAGE_HEIGHT - 62, 'regular', 9, MUTED);
    this.y = TOP;
  }
  /** Make sure `height` points are left; else a new page. */
  need(height: number) {
    if (this.y - height < LOWEST) this.nextPage();
  }
  /** A section caption with a rule under it. */
  caption(text: string) {
    this.need(ROW * 2.2);
    this.y -= 6;
    this.page.text(text.toUpperCase(), MARGIN, this.y, 'bold', 8.5, MUTED);
    this.page.rule(MARGIN, RIGHT, this.y - 6, 0.75, 0.6);
    this.y -= ROW + 2;
  }
  /** A quiet line of text, wrapped. */
  note(text: string, gray = 0.4, size = 8.5) {
    for (const line of wrapped(text, 'regular', size, RIGHT - MARGIN)) {
      this.need(12);
      this.page.text(line, MARGIN, this.y, 'regular', size, gray);
      this.y -= size + 3;
    }
  }
}

/** The statement's bytes. */
export function statementPdf(statement: Statement): Uint8Array<ArrayBuffer> {
  const month = monthLabel(statement.month);
  const flow = new Flow(`${statement.propertyName} · ${month} · Nubnb monthly statement`);
  const { page } = flow;
  const refText = statement.ref === null ? 'Draft' : `Ref ${statement.ref}`;

  // ── Head ──
  page.text('NUBNB · MONTHLY STATEMENT', MARGIN, 730, 'bold', 8.5, MUTED);
  page.text(refText, RIGHT, 730, 'bold', 8.5, statement.ref === null ? 0.6 : MUTED, 'right');
  page.text(fitted(statement.propertyName, 'bold', 20, RIGHT - MARGIN), MARGIN, 702, 'bold', 20);
  page.text(month, MARGIN, 682, 'regular', 11.5);
  page.text(fitted(preparedFor(statement), 'regular', 9.5, RIGHT - MARGIN), MARGIN, 667, 'regular', 9.5, MUTED);
  flow.y = 648;
  if (statement.supersedes) {
    flow.note(`Replaces the statement finished ${finishedDay(statement.supersedes.finishedAt)} (ref ${statement.supersedes.ref}). Reason: ${statement.supersedes.reason}`, 0.25, 9);
    flow.y -= 4;
  }
  if (nothingToReport(statement)) {
    flow.y -= 4;
    flow.page.text('Nothing to report this month.', MARGIN, flow.y, 'bold', 11);
    flow.y -= ROW;
  }

  // ── Income ──
  flow.caption('Income');
  const INCOME = { stay: MARGIN, source: MARGIN + 92, label: MARGIN + 140, reference: RIGHT - 150 };
  if (statement.income.length === 0) {
    flow.need(ROW);
    flow.page.text('No income recorded.', MARGIN, flow.y, 'regular', 10, MUTED);
    flow.y -= ROW;
  }
  for (const row of statement.income) {
    flow.need(ROW);
    const stay = row.from && row.to ? (row.from === row.to ? shortDay(row.from) : `${shortDay(row.from)} – ${shortDay(row.to)}`) : (row.from ?? row.to ?? '');
    flow.page.text(fitted(stay, 'regular', 9, INCOME.source - 6 - INCOME.stay), INCOME.stay, flow.y, 'regular', 9, 0.3);
    flow.page.text(INCOME_SOURCE_LABELS[row.source], INCOME.source, flow.y, 'regular', 10);
    flow.page.text(fitted(row.label, 'regular', 10, INCOME.reference - 8 - INCOME.label), INCOME.label, flow.y, 'regular', 10);
    flow.page.text(fitted(row.reference ?? '', 'regular', 9, 70), INCOME.reference, flow.y, 'regular', 9, MUTED);
    flow.page.text(money(row.amountCents), AMOUNT_RIGHT, flow.y, 'regular', 10, 0, 'right');
    flow.page.rule(MARGIN, RIGHT, flow.y - 6, 0.9, 0.4);
    flow.y -= ROW;
  }
  flow.need(ROW);
  flow.page.text('Total income', MARGIN, flow.y, 'bold', 10);
  flow.page.text(money(statement.incomeCents), AMOUNT_RIGHT, flow.y, 'bold', 10, 0, 'right');
  flow.y -= ROW + 4;

  // ── Costs, on the band ──
  flow.caption('Costs');
  flow.note("Recorded from receipts and work approved in Nubnb's cost ledger. They are shown as recorded and cannot be edited here.", 0.4, 8.5);
  flow.y -= 2;
  const COST = { number: MARGIN + 16, date: MARGIN + 28, bought: MARGIN + 96, ref: RIGHT - 232, items: RIGHT - 120, tax: RIGHT - 62 };
  const costHeader = () => {
    flow.need(ROW * 1.5);
    const y = flow.y;
    flow.page.text('#', COST.number, y, 'bold', 8, MUTED, 'right');
    flow.page.text('Date', COST.date, y, 'bold', 8, MUTED);
    flow.page.text('What was bought / work done', COST.bought, y, 'bold', 8, MUTED);
    flow.page.text('Ref', COST.ref, y, 'bold', 8, MUTED);
    flow.page.text('Items', COST.items, y, 'bold', 8, MUTED, 'right');
    flow.page.text('Tax', COST.tax, y, 'bold', 8, MUTED, 'right');
    flow.page.text('Total', AMOUNT_RIGHT, y, 'bold', 8, MUTED, 'right');
    flow.y -= ROW - 4;
  };
  const costRow = (n: number, row: Statement['costs'][number]) => {
    flow.need(ROW);
    const y = flow.y;
    flow.page.rect(MARGIN - 6, y - 6, RIGHT - MARGIN + 12, ROW, BAND_GRAY);
    flow.page.text(String(n), COST.number, y, 'regular', 9.5, MUTED, 'right');
    flow.page.text(shortDay(row.day), COST.date, y, 'regular', 9.5);
    flow.page.text(fitted(row.kind === 'work' ? `Work: ${row.description}` : row.description, 'regular', 9.5, COST.ref - 12 - COST.bought), COST.bought, y, 'regular', 9.5);
    flow.page.text(row.ref, COST.ref, y, 'regular', 9.5, MUTED);
    flow.page.text(formatCents(row.itemsCents), COST.items, y, 'regular', 9.5, 0, 'right');
    flow.page.text(row.taxCents === null ? '—' : formatCents(row.taxCents), COST.tax, y, 'regular', 9.5, row.taxCents === null ? MUTED : 0, 'right');
    flow.page.text(formatCents(row.totalCents), AMOUNT_RIGHT, y, 'regular', 9.5, 0, 'right');
    if (row.corrected) flow.page.text('*', AMOUNT_RIGHT + 1.5, y, 'regular', 9.5);
    flow.y -= ROW;
  };
  const monthRows = statement.costs.filter((row) => row.group === 'month');
  const earlierRows = statement.costs.filter((row) => row.group === 'earlier');
  let n = 0;
  if (monthRows.length === 0 && earlierRows.length === 0 && statement.adjustments.length === 0) {
    flow.need(ROW);
    flow.page.text('No costs recorded this month.', MARGIN, flow.y, 'regular', 10, MUTED);
    flow.y -= ROW;
  }
  if (monthRows.length > 0) {
    costHeader();
    for (const row of monthRows) costRow(++n, row);
  }
  if (earlierRows.length > 0) {
    flow.need(ROW * 2.5);
    flow.y -= 4;
    flow.page.text('From earlier months, not previously reported', MARGIN, flow.y, 'bold', 9);
    flow.y -= ROW - 4;
    costHeader();
    for (const row of earlierRows) costRow(++n, row);
  }
  if (statement.adjustments.length > 0) {
    flow.need(ROW * 2.5);
    flow.y -= 4;
    flow.page.text('Adjustments to earlier statements', MARGIN, flow.y, 'bold', 9);
    flow.y -= ROW - 4;
    flow.need(ROW * 1.5);
    flow.page.text('Entry', COST.date, flow.y, 'bold', 8, MUTED);
    flow.page.text('Statement', COST.bought, flow.y, 'bold', 8, MUTED);
    flow.page.text('Printed', COST.items, flow.y, 'bold', 8, MUTED, 'right');
    flow.page.text('Now', COST.tax, flow.y, 'bold', 8, MUTED, 'right');
    flow.page.text('Difference', AMOUNT_RIGHT, flow.y, 'bold', 8, MUTED, 'right');
    flow.y -= ROW - 4;
    for (const row of statement.adjustments) {
      flow.need(ROW);
      const y = flow.y;
      flow.page.rect(MARGIN - 6, y - 6, RIGHT - MARGIN + 12, ROW, BAND_GRAY);
      flow.page.text(row.entryId.slice(0, 6), COST.date, y, 'regular', 9.5);
      flow.page.text(`ref ${row.statementId.slice(0, 6)}${row.nowCents === 0 ? ' · no longer in the ledger' : ''}`, COST.bought, y, 'regular', 9.5, 0.3);
      flow.page.text(formatCents(row.printedCents), COST.items, y, 'regular', 9.5, 0, 'right');
      flow.page.text(formatCents(row.nowCents), COST.tax, y, 'regular', 9.5, 0, 'right');
      flow.page.text(money(row.deltaCents), AMOUNT_RIGHT, y, 'regular', 9.5, 0, 'right');
      flow.y -= ROW;
    }
  }
  flow.need(ROW);
  flow.page.text('Total costs', MARGIN, flow.y, 'bold', 10);
  flow.page.text(money(statement.costsCents), AMOUNT_RIGHT, flow.y, 'bold', 10, 0, 'right');
  flow.y -= ROW + 4;

  // ── Fee ──
  flow.caption('Management fee');
  flow.need(ROW);
  if (statement.fee === null) {
    flow.page.text('No fee this month', MARGIN, flow.y, 'regular', 10, MUTED);
  } else {
    flow.page.text(fitted(statement.fee.label, 'regular', 10, RIGHT - MARGIN - 90), MARGIN, flow.y, 'regular', 10);
    flow.page.text(money(statement.fee.amountCents), AMOUNT_RIGHT, flow.y, 'regular', 10, 0, 'right');
  }
  flow.y -= ROW + 6;

  // ── Closing figure, boxed ──
  const closing = closingWords(statement.payableCents);
  flow.need(ROW * 5 + 20);
  const boxTop = flow.y + 10;
  const boxHeight = ROW * 4 + 22;
  flow.page.rect(MARGIN - 6, boxTop - boxHeight, RIGHT - MARGIN + 12, boxHeight, 0.96);
  flow.page.rule(MARGIN - 6, RIGHT + 6, boxTop, 0.6, 0.8);
  flow.page.rule(MARGIN - 6, RIGHT + 6, boxTop - boxHeight, 0.6, 0.8);
  let y = boxTop - 16;
  for (const [label, cents] of [['Income', statement.incomeCents], ['Costs', -statement.costsCents], ['Management fee', -statement.feeCents]] as const) {
    flow.page.text(label, MARGIN, y, 'regular', 9.5, 0.3);
    flow.page.text(money(cents), AMOUNT_RIGHT, y, 'regular', 9.5, 0.3, 'right');
    y -= ROW - 2;
  }
  flow.page.rule(MARGIN, RIGHT, y + 8, 0.6, 0.6);
  y -= 4;
  flow.page.text(closing.label, MARGIN, y, 'bold', 12);
  flow.page.text(closing.amount, AMOUNT_RIGHT, y, 'bold', 12, 0, 'right');
  flow.y = boxTop - boxHeight - ROW;

  // ── Notes ──
  if (statement.notes && statement.notes.trim() !== '') {
    flow.caption('Notes to the owners');
    for (const paragraph of statement.notes.split(/\n+/)) flow.note(paragraph, 0.1, 9.5);
    flow.y -= 6;
  }
  const standard = [
    ...(statement.costs.some((row) => row.corrected) ? ['* Corrected by Nubnb against the receipt.'] : []),
    ...(statement.costs.some((row) => row.kind === 'work') ? ['An entry marked "Work" is a handyman\'s work done for the property, at the price logged: no receipt, and Items is that price.'] : []),
    ...(statement.pendingLeftOut > 0 ? [`${statement.pendingLeftOut === 1 ? '1 entry' : `${statement.pendingLeftOut} entries`} sent in ${month} ${statement.pendingLeftOut === 1 ? 'was' : 'were'} still under review when this statement was finished and ${statement.pendingLeftOut === 1 ? 'is' : 'are'} not in it; once approved ${statement.pendingLeftOut === 1 ? 'it' : 'they'} will appear in a later statement.`] : []),
    'Each cost is one receipt or one piece of work. Items is the sum of the amounts the receipt prints for each line, Tax is the receipt\'s tax, and Total is the two together; quantities are never multiplied. Nubnb keeps every receipt; an entry\'s reference finds it.',
    statement.finishedAt === null ? 'Draft: not yet finished. The reference and the finish time appear when it is.' : `Statement finished ${finishedLabel(statement.finishedAt)} · ref ${statement.ref}`,
  ];
  flow.y -= 2;
  for (const line of standard) flow.note(line, 0.4, 8.5);

  // ── Every page ──
  flow.pages.forEach((p, i) => {
    p.text(`${statement.propertyName} · ${month}`.length > 70 ? fitted(`${statement.propertyName} · ${month}`, 'regular', 8, 380) : `${statement.propertyName} · ${month}`, MARGIN, 34, 'regular', 8, 0.5);
    p.text(`Page ${i + 1} of ${flow.pages.length}`, RIGHT, 34, 'regular', 8, 0.5, 'right');
  });

  const title = `Nubnb statement – ${statement.propertyName} – ${month}${statement.ref ? ` – ${statement.ref}` : ' – draft'}`;
  const created = statement.finishedAt !== null && Number.isFinite(Date.parse(statement.finishedAt)) ? new Date(statement.finishedAt) : new Date(0);
  return assemble(flow.pages, title, created);
}
