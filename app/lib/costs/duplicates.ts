/**
 * A possible second send of a receipt, in words (Phase 2, 2026-11-01). The server writes the hints on a new receipt
 * when it is created (server-cost-entries.ts findPossibleDuplicates); the Costs queue marks the row and the entry's
 * pane says which earlier receipt it matches, with a link to it. Nothing here blocks or writes anything.
 *
 * Client-safe, and pure.
 */

import type { DuplicateHintView } from '@/app/lib/cleaners/model';
import { sentDay, shortDay } from './report';

/** The hints an entry carries; none when the server found no earlier receipt to match. */
export function duplicateHints(entry: { possibleDuplicates?: DuplicateHintView[] }): DuplicateHintView[] {
  return entry.possibleDuplicates ?? [];
}

/** "Same photo as the receipt sent 3 Nov 2028", "Same amount, same unit, as the receipt sent 3 Nov 2028". */
export function duplicateWords(hint: DuplicateHintView): string {
  const day = sentDay(hint.sentAt);
  const when = day === null ? '' : ` sent ${shortDay(day)}`;
  return hint.why === 'same-photo' ? `Same photo as the receipt${when}` : `Same amount, same unit, as the receipt${when}`;
}

/** Where the matched receipt opens on the Costs page, whatever its status. */
export function duplicateHref(hint: DuplicateHintView): string {
  return `/admin/costs?entry=${encodeURIComponent(hint.entryId)}&status=all`;
}
