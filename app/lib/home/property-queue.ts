/**
 * "Next property" (2026-10-17, build round 1 of the property page audit): the property page walks the home's list as
 * the admin last saw it — its chip, its search, its city and its order — without going back to it.
 *
 * The home writes the list it shows (each property's ID, its name, and where its page opens: the month and the tab its
 * Next step names, else the property alone, which opens on its month due) to this browser tab's session storage each
 * time the list changes; the property page reads it. Nothing is read from the server for it, and nothing is kept on
 * it: a per-viewer convenience, gone with the tab. The list is what the home showed when it was written, so a
 * property finished since stays on it; its page says its true state when it opens.
 *
 * Pure apart from `writeQueue` and `readQueue`, which never throw (storage can be missing or refused).
 */

/** One property on the list, as the home showed it. */
export interface QueueEntry {
  id: string;
  /** Its name on the list: the cleaner-facing name, usually the address. */
  name: string;
  /** Where its page opens: /admin/property?id=… with the month and tab of its Next step, when the step is on that page. */
  href: string;
}

export interface PropertyQueue {
  /** What narrowed and ordered the list, in words: "Statements blocked · Needs attention". */
  label: string;
  /** The list itself, with its filters (/admin?show=blocked&q=…), to go back to it. */
  listHref: string;
  entries: QueueEntry[];
}

const KEY = 'nubnb.admin.propertyQueue.v1';
const PROPERTY_PAGE = '/admin/property?id=';

/** Where a property's page opens from the list: its Next step's address when that is the property page, else the property alone. */
export function entryHref(id: string, stepHref: string | null | undefined): string {
  const own = `${PROPERTY_PAGE}${encodeURIComponent(id)}`;
  return stepHref && (stepHref === own || stepHref.startsWith(`${own}&`)) ? stepHref : own;
}

/** The list's words: the chip, the search and the city when set, then the order. */
export function queueLabel(parts: { chip: string | null; search: string; city: string | null; sort: string }): string {
  return [parts.chip, parts.search.trim() !== '' ? `“${parts.search.trim()}”` : null, parts.city, parts.sort].filter(Boolean).join(' · ');
}

/** Where a property stands on the list: its place (1-based), the total, and the properties before and after it. null when it is not on it. */
export function neighbours(queue: PropertyQueue | null, id: string): { place: number; total: number; previous: QueueEntry | null; next: QueueEntry | null } | null {
  if (!queue) return null;
  const i = queue.entries.findIndex((entry) => entry.id === id);
  if (i === -1) return null;
  return { place: i + 1, total: queue.entries.length, previous: queue.entries[i - 1] ?? null, next: queue.entries[i + 1] ?? null };
}

/** A stored list read back, or null when it is not one. */
export function parseQueue(raw: string | null): PropertyQueue | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object') return null;
    const { label, listHref, entries } = value as Record<string, unknown>;
    if (typeof label !== 'string' || typeof listHref !== 'string' || !listHref.startsWith('/admin') || !Array.isArray(entries)) return null;
    const read: QueueEntry[] = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') return null;
      const { id, name, href } = entry as Record<string, unknown>;
      if (typeof id !== 'string' || typeof name !== 'string' || typeof href !== 'string' || !href.startsWith(PROPERTY_PAGE)) return null;
      read.push({ id, name, href });
    }
    return { label, listHref, entries: read };
  } catch {
    return null;
  }
}

/** Keep the list for the property page. Never throws. */
export function writeQueue(queue: PropertyQueue): void {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(queue));
  } catch {
    /* storage missing or refused: Next property is simply not offered */
  }
}

/** The list the home last wrote in this tab, or null. Never throws. */
export function readQueue(): PropertyQueue | null {
  try {
    return parseQueue(window.sessionStorage.getItem(KEY));
  } catch {
    return null;
  }
}
