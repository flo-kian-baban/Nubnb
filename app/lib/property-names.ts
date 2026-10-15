/**
 * The name an admin surface shows for a property (Kian's rulings of 2026-10-15, evening: no internal list is titled by
 * the Airbnb title): its cleaner-facing name, usually its street address, which the server resolves as `internalName`,
 * else its public title. The public title stays what the public site, the property's web address and the Airbnb title
 * matching use; the cleaner-facing name never leaves the admin and the cleaner app, and is never written on the
 * world-readable property document.
 *
 * Pure: the server sends `internalName` beside `name`; nothing here reads Firestore.
 */

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null);

/** The name to show: the internal name, else the public title; null when neither is usable text. */
export function internalLabel(property: { name?: string | null; internalName?: string | null } | null | undefined): string | null {
  return text(property?.internalName) ?? text(property?.name);
}
