/**
 * The one property-slug function.
 *
 * There used to be two, and they disagreed. The admin form generated a slug at
 * creation time with `[^a-z0-9]+ → -`, which turns "&" into a separator and
 * drops it; the URL layer converted "&" to "and" first. Two of the 43 stored
 * slugs diverged for that reason alone.
 *
 * This is the URL layer's algorithm, unchanged. It is canonical precisely
 * because it is what every live link already contains — changing the output
 * here would break URLs that currently work, which is the opposite of the fix.
 *
 * Note that a stored `slug` field can still differ from `toSlug(name)`: the
 * form only ever generated a slug when the field was empty, so renaming a
 * property left the old slug in place (23 of 43). Resolution therefore has to
 * accept both — see `resolvePropertySlug`.
 */
export function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[&]/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/** The minimum shape `resolvePropertySlug` needs. */
interface SlugResolvable {
  name: string;
  slug?: string;
}

export interface SlugResolution<T> {
  property: T;
  /** The slug this property should be reachable at. */
  canonical: string;
  /** True when the request came in on a stored-but-not-canonical slug. */
  isLegacy: boolean;
}

/**
 * Find the property a URL slug refers to, accepting either the canonical slug
 * or the one stored on the document.
 *
 * Canonical wins when both match, so a stored slug that happens to equal
 * another property's canonical slug could never shadow it. (Checked against
 * the live catalogue on 2026-09-21: no stored slug collides with any canonical
 * slug, and neither set contains duplicates.)
 */
export function resolvePropertySlug<T extends SlugResolvable>(
  properties: T[],
  slug: string,
): SlugResolution<T> | null {
  const byCanonical = properties.find((p) => toSlug(p.name) === slug);
  if (byCanonical) {
    return { property: byCanonical, canonical: slug, isLegacy: false };
  }

  const byStored = properties.find((p) => p.slug === slug);
  if (byStored) {
    return { property: byStored, canonical: toSlug(byStored.name), isLegacy: true };
  }

  return null;
}
