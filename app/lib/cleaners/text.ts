/**
 * Matching text the way a person types it: capitals, accents and extra
 * spaces make no difference. "creme nettoyante" finds "Crème Nettoyante".
 *
 * Client-safe. The server uses the same fold to group item names that differ
 * only in those ways, and the cleaner app uses it to search properties and
 * suggest item names, so both sides agree on what counts as the same words.
 */

/** Lowercase, accents removed, runs of whitespace as one space, trimmed. */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * How well `text` matches what was typed, or null for no match. Lower is
 * better: 0 when it starts with the query, 1 when a later word does, 2 when
 * the query is somewhere inside. Both arguments are folded first.
 */
export function matchRank(text: string, query: string): 0 | 1 | 2 | null {
  const haystack = fold(text);
  const needle = fold(query);
  if (needle === '') return 0;
  if (haystack.startsWith(needle)) return 0;
  if (haystack.includes(` ${needle}`)) return 1;
  if (haystack.includes(needle)) return 2;
  return null;
}
