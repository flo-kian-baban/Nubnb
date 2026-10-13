/**
 * Airbnb's transaction report, read exactly, with no AI (dispatch 27). The
 * file is the CSV Airbnb exports from Earnings → Transaction history; the
 * one this was built from is the co-host account's September 2026 report:
 * 71 rows, 21 columns, every row dated by the day Airbnb paid it out.
 *
 *   Date, Arriving by date, Type, Confirmation Code, Booking date,
 *   Start date, End date, Nights, Guest, Listing, Details, Reference code,
 *   Currency, Amount, Paid out, Service fee, Fast Pay fee, Cleaning fee,
 *   Gross earnings, Airbnb remitted tax, Earnings year
 *
 * Each Payout row comes first and the rows it pays follow it; the payout's
 * "Paid out" equals their "Amount" added up. That is the file's own check,
 * and the only use of a Payout row (Kian's ruling): a payout row is never a
 * line, and its Details, which name where the money went, are never kept.
 *
 * Reservation, Adjustment, Resolution Adjustment and Resolution Payout rows
 * become lines. A row of any other type ("Pass Through Tot", say) becomes a
 * line too, kept with its listing, code and stay, and needs an admin's
 * decision (Kian's ruling of 2026-10-13, dispatch 37C: never dropped or set
 * aside silently). A row with no amount, no confirmation code, no listing,
 * or a currency other than CAD is listed as not read, with its amount, and
 * still counts in its payout's check.
 *
 * Columns are found by name in any case ("guest" is "Guest"). Guest and
 * Details must be there (dispatch 37C, I7): the kept copy empties them, and a
 * file whose guest names could not be found is refused rather than kept with
 * them.
 *
 * The payouts are checked against the rows after each; when a file's rows are
 * not in that order, day by day instead: each day's payouts against that
 * day's rows (dispatch 37C, I14).
 *
 * A file this reader cannot read exactly — a column missing, a date or an
 * amount not in Airbnb's form — is refused whole, with the rows named: a
 * row is never guessed at.
 *
 * Pure and client-safe.
 */

import { parseCsv, writeCsv } from './csv';
import { PLATFORM_TYPES, normaliseTitle } from './model';
import type { PlatformRead, PlatformRow } from './platforms';

/** The columns this reader needs, by Airbnb's names. */
export const AIRBNB_COLUMNS = {
  date: 'Date',
  type: 'Type',
  code: 'Confirmation Code',
  start: 'Start date',
  end: 'End date',
  nights: 'Nights',
  listing: 'Listing',
  currency: 'Currency',
  amount: 'Amount',
  paidOut: 'Paid out',
} as const;
/** Kept as evidence when the file has them; never printed. */
export const AIRBNB_EVIDENCE_COLUMNS = { gross: 'Gross earnings', serviceFee: 'Service fee', cleaningFee: 'Cleaning fee', tax: 'Airbnb remitted tax' } as const;
/** Emptied in the copy kept (Kian's ruling): the guest's name, and Details, which on a payout row says where the money went. Both must be in the file (I7). */
export const AIRBNB_BLANKED_COLUMNS = ['Guest', 'Details'] as const;
/** The row types Nubnb recognises; a row of any other type is a line that needs a decision. */
export const AIRBNB_LINE_TYPES = PLATFORM_TYPES.airbnb.known;
export const AIRBNB_PAYOUT_TYPE = 'Payout';
/** The currency Nubnb's statements are in. */
export const STATEMENT_CURRENCY = 'CAD';

/** A row that becomes a line, read. */
export type AirbnbLineRow = PlatformRow;

export interface AirbnbPayout {
  row: number;
  payoutDate: string;
  paidOutCents: number;
  /** The rows under it, added up. */
  rowsCents: number;
  rows: number;
}

export type AirbnbRead = PlatformRead;

const MAX_PROBLEMS = 20;

/** "09/30/2026" → "2026-09-30"; null when it is not a real day in Airbnb's form. */
export function airbnbDay(text: string): string | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text.trim());
  if (!match) return null;
  const [m, d, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (m < 1 || m > 12 || d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate()) return null;
  return `${match[3]}-${match[1]}-${match[2]}`;
}

/** "2599.37", "-397.40", "1,234.5" → cents, by the digits alone; null when it is not an amount. */
export function airbnbCents(text: string): number | null {
  const match = /^(-)?(\d{1,3}(?:,\d{3})+|\d{1,9})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  const cents = Number(match[2].replace(/,/g, '')) * 100 + Number((match[3] ?? '').padEnd(2, '0'));
  return match[1] && cents !== 0 ? -cents : cents;
}

/** Read Airbnb's transaction report. */
export function readAirbnbCsv(text: string): AirbnbRead {
  const table = parseCsv(text);
  if (table === null) return { ok: false, problems: ['The file has a quoted field that never closes: it is not a CSV this can read.'] };
  const header = table.header.map((name) => name.trim());
  // A column by its name in any case (I7): "guest" is "Guest".
  const index = (name: string) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const missing = Object.values(AIRBNB_COLUMNS).filter((name) => index(name) < 0);
  if (header.length === 0 || missing.length > 0) {
    return { ok: false, problems: [`This is not Airbnb's transaction report: ${missing.length === 1 ? 'the column' : 'the columns'} ${missing.map((m) => `"${m}"`).join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing.`] };
  }
  // Guest and Details are emptied in the copy kept: a file where they cannot be found is not kept with them (I7).
  const unblankable = AIRBNB_BLANKED_COLUMNS.filter((name) => index(name) < 0);
  if (unblankable.length > 0) {
    return {
      ok: false,
      problems: [`The ${unblankable.length === 1 ? 'column' : 'columns'} ${unblankable.map((m) => `"${m}"`).join(' and ')} ${unblankable.length === 1 ? 'is' : 'are'} not in this file. Nubnb empties the guests' names and the payout details in the copy it keeps, and cannot find them here, so nothing was stored.`],
    };
  }
  if (table.records.length === 0) return { ok: false, problems: ['The file has its column names and no rows.'] };

  const col = Object.fromEntries(Object.entries(AIRBNB_COLUMNS).map(([key, name]) => [key, index(name)])) as Record<keyof typeof AIRBNB_COLUMNS, number>;
  const evidence = Object.fromEntries(Object.entries(AIRBNB_EVIDENCE_COLUMNS).map(([key, name]) => [key, index(name)])) as Record<keyof typeof AIRBNB_EVIDENCE_COLUMNS, number>;

  const problems: string[] = [];
  const problem = (text: string) => {
    if (problems.length < MAX_PROBLEMS) problems.push(text);
  };
  const lines: AirbnbLineRow[] = [];
  const payouts: AirbnbPayout[] = [];
  const notRead: { row: number; payoutDate: string; type: string; amountCents: number; why: string }[] = [];
  const orphan = { rows: 0, cents: 0 };
  const rowAmounts: { payoutDate: string; amountCents: number }[] = [];
  let amountCents = 0;
  let paidOutCents = 0;

  table.records.forEach((record, i) => {
    const row = i + 2;
    if (record.length !== header.length) {
      problem(`Row ${row}: ${record.length} fields where the header has ${header.length}.`);
      return;
    }
    const cell = (at: number) => (at < 0 ? '' : record[at].trim());
    const optionalCents = (at: number, name: string): number | null => {
      const value = cell(at);
      if (value === '') return null;
      const cents = airbnbCents(value);
      if (cents === null) problem(`Row ${row}: ${name} "${value}" is not an amount.`);
      return cents;
    };
    const payoutDate = airbnbDay(cell(col.date));
    if (payoutDate === null) {
      problem(`Row ${row}: the date "${cell(col.date)}" is not a day written MM/DD/YYYY.`);
      return;
    }
    const type = cell(col.type);

    if (type === AIRBNB_PAYOUT_TYPE) {
      const paid = airbnbCents(cell(col.paidOut));
      if (paid === null) {
        problem(`Row ${row}: a payout with no amount paid out.`);
        return;
      }
      paidOutCents += paid;
      payouts.push({ row, payoutDate, paidOutCents: paid, rowsCents: 0, rows: 0 });
      return;
    }

    const amountText = cell(col.amount);
    const amount = amountText === '' ? 0 : airbnbCents(amountText);
    if (amount === null) {
      problem(`Row ${row}: the amount "${amountText}" is not an amount.`);
      return;
    }
    amountCents += amount;
    rowAmounts.push({ payoutDate, amountCents: amount });
    const under = payouts[payouts.length - 1];
    if (under) {
      under.rowsCents += amount;
      under.rows += 1;
    } else {
      orphan.rows += 1;
      orphan.cents += amount;
    }

    // A row of a type Nubnb does not recognise is read as a line all the same, and needs a decision (Kian's ruling of 2026-10-13).
    if (type === '') {
      notRead.push({ row, payoutDate, type, amountCents: amount, why: 'no type' });
      return;
    }
    const start = cell(col.start) === '' ? null : airbnbDay(cell(col.start));
    const end = cell(col.end) === '' ? null : airbnbDay(cell(col.end));
    const nightsText = cell(col.nights);
    const nights = nightsText === '' ? null : /^\d{1,4}$/.test(nightsText) ? Number(nightsText) : NaN;
    if ((cell(col.start) !== '' && start === null) || (cell(col.end) !== '' && end === null) || Number.isNaN(nights)) {
      problem(`Row ${row}: the stay's dates or nights are not in Airbnb's form.`);
      return;
    }
    const grossCents = optionalCents(evidence.gross, 'the gross earnings');
    const serviceFeeCents = optionalCents(evidence.serviceFee, 'the service fee');
    const cleaningFeeCents = optionalCents(evidence.cleaningFee, 'the cleaning fee');
    const remittedTaxCents = optionalCents(evidence.tax, 'the remitted tax');
    const code = cell(col.code);
    const title = normaliseTitle(record[col.listing]);
    const currency = cell(col.currency);
    const why =
      amount === 0 ? 'no amount' : code === '' ? 'no confirmation code' : title === '' ? 'no listing' : currency !== STATEMENT_CURRENCY ? `the currency is ${currency || 'not given'}, not ${STATEMENT_CURRENCY}` : null;
    if (why !== null) {
      notRead.push({ row, payoutDate, type, amountCents: amount, why });
      return;
    }
    lines.push({
      row,
      payoutDate,
      type,
      confirmationCode: code,
      listingTitle: title,
      stay: { start, end, nights },
      amountCents: amount,
      currency,
      evidence: { grossCents, serviceFeeCents, cleaningFeeCents },
      remittedTaxCents,
    });
  });

  if (problems.length > 0) return { ok: false, problems };

  const inOrder = payouts.filter((p) => p.paidOutCents !== p.rowsCents).map((p) => ({ row: p.row, paidOutCents: p.paidOutCents, rowsCents: p.rowsCents }));
  if (orphan.rows > 0) inOrder.unshift({ row: 0, paidOutCents: 0, rowsCents: orphan.cents });
  // Rows not after their payout (I14): each day's payouts against the day's rows. A file in Airbnb's order passes the first check.
  let checkedBy: 'order' | 'day' = 'order';
  let unbalanced = inOrder;
  if (inOrder.length > 0 && amountCents === paidOutCents) {
    const byDay = new Map<string, number>();
    for (const p of payouts) byDay.set(p.payoutDate, (byDay.get(p.payoutDate) ?? 0) + p.paidOutCents);
    for (const r of rowAmounts) byDay.set(r.payoutDate, (byDay.get(r.payoutDate) ?? 0) - r.amountCents);
    if ([...byDay.values()].every((left) => left === 0)) {
      checkedBy = 'day';
      unbalanced = [];
    }
  }

  // The copy kept: the same rows, Guest and Details emptied.
  const blankedColumns = AIRBNB_BLANKED_COLUMNS.filter((name) => index(name) >= 0);
  const blankAt = blankedColumns.map(index);
  const blanked = writeCsv({ ...table, records: table.records.map((record) => record.map((value, at) => (blankAt.includes(at) ? '' : value))) });

  return {
    ok: true,
    rows: table.records.length,
    lines,
    payouts,
    notRead,
    amountCents,
    paidOutCents,
    balanced: unbalanced.length === 0 && amountCents === paidOutCents,
    unbalanced,
    checkedBy,
    blanked,
    blankedColumns: [...blankedColumns],
  };
}
