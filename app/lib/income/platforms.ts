/**
 * One reader per platform (dispatch 37C, the architecture's 4.4): reading the file — its columns, dates, amounts,
 * row types, the payout check and which columns are emptied in the kept copy — is each platform's own. Everything
 * after it is shared: the lines are stored the same way with the platform named, their month is the day paid,
 * their amount the file's, duplicates are platform + code + day + type + amount, a property holds one active title
 * per platform, and review, acceptance, the statement, the ZIP and the reports do not change with the platform.
 * Vrbo later is a reader here and an entry in INCOME_CHANNELS; nothing else.
 *
 * Pure and client-safe.
 */

import { readAirbnbCsv } from './airbnb';
import type { IncomeChannel, Stay } from './model';

/** One row a line comes from, as a platform's reader gives it. */
export interface PlatformRow {
  /** As a spreadsheet numbers it: the header is row 1. */
  row: number;
  payoutDate: string;
  type: string;
  confirmationCode: string;
  listingTitle: string;
  stay: Stay;
  amountCents: number;
  currency: string;
  /** Kept, never printed: what the platform says the stay grossed and charged. */
  evidence: { grossCents: number | null; serviceFeeCents: number | null; cleaningFeeCents: number | null };
  remittedTaxCents: number | null;
}

export type PlatformRead =
  | {
      ok: true;
      /** Data rows in the file. */
      rows: number;
      lines: PlatformRow[];
      payouts: { row: number; payoutDate: string; paidOutCents: number; rowsCents: number; rows: number }[];
      /** Rows that are not payouts and become no line, with why. */
      notRead: { row: number; payoutDate: string; type: string; amountCents: number; why: string }[];
      amountCents: number;
      paidOutCents: number;
      balanced: boolean;
      unbalanced: { row: number; paidOutCents: number; rowsCents: number }[];
      /** How the payouts were checked: each payout against the rows after it, or, rows out of that order, day by day. */
      checkedBy: 'order' | 'day';
      /** The copy kept, with the columns that name people or where money went emptied. */
      blanked: string;
      blankedColumns: string[];
    }
  | { ok: false; problems: string[] };

export interface PlatformReader {
  platform: IncomeChannel;
  read: (text: string) => PlatformRead;
}

const READERS: Record<IncomeChannel, PlatformReader> = {
  airbnb: { platform: 'airbnb', read: readAirbnbCsv },
};

/** The reader for a platform's file. */
export function readerFor(platform: IncomeChannel): PlatformReader {
  return READERS[platform];
}
