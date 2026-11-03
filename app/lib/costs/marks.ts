/**
 * The marks a receipt carries for the admin, in words (Build 1 of 2026-11-02, item 6): lines that did not add up to the
 * total the receipt prints. The server writes the mark on a new receipt when it is created
 * (server-cost-entries.ts); the Costs queue marks the row, the entry's pane says the two figures, and the pay view's
 * waiting line says why it waits. Nothing here blocks or writes anything. Client-safe, and pure.
 */

import { formatCents, type TotalDiffers } from '@/app/lib/cleaners/model';

/** The mark an entry carries; null when its lines agreed with the printed total, or the receipt printed none. */
export function totalDiffers(entry: { totalDiffers?: TotalDiffers }): TotalDiffers | null {
  return entry.totalDiffers ?? null;
}

/** The short mark on a row. */
export const TOTAL_DIFFERS_MARK = 'Total differs from the receipt';

/** "Total differs from the receipt: it prints $47.20; the lines add up to $45.20." */
export function totalDiffersWords(mark: TotalDiffers): string {
  return `${TOTAL_DIFFERS_MARK}: it prints ${formatCents(mark.printedTotalCents)}; the lines add up to ${formatCents(mark.sentTotalCents)}.`;
}
