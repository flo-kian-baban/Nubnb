/**
 * The one nightly-price function.
 *
 * `priceInfo.nightly` is the price. There used to be two fields — a top-level
 * `price` and `priceInfo.nightly` — filled from two separate inputs in the
 * admin form, and they disagreed on 3 of the 43 stored properties. Which
 * number you saw depended on which surface you were looking at: the card, the
 * detail panel and the map pin read `nightly`, while the admin list displayed,
 * sorted by and averaged `price`. One listing sorted in the admin as a $239
 * stay and advertised $699 to renters.
 *
 * Every surface that shows or computes a price now calls this. The admin form
 * writes the same value to both fields on save, so the two converge property
 * by property as operators touch them — nothing rewrites a stored document on
 * its own.
 *
 * The fallback to `price` is for a document that has no usable `nightly` at
 * all, which is true of none of the 43 today. It exists so a malformed
 * document renders a stale number rather than "$0", and it is the same
 * expression the public surfaces already used.
 */

export interface NightlyPriced {
  price?: number;
  priceInfo?: { nightly?: number } | null;
}

export function nightlyPrice(property: NightlyPriced | null | undefined): number {
  if (!property) return 0;
  const nightly = property.priceInfo?.nightly;
  if (typeof nightly === 'number' && Number.isFinite(nightly) && nightly > 0) return nightly;
  const base = property.price;
  return typeof base === 'number' && Number.isFinite(base) ? base : 0;
}

/**
 * True when a stored document still carries a `price` that disagrees with its
 * `priceInfo.nightly`. Drives the admin form's warning; it is deliberately
 * strict about both being real numbers, so a document missing one is not
 * reported as a disagreement.
 */
export function hasPriceDivergence(property: NightlyPriced | null | undefined): boolean {
  if (!property) return false;
  const base = property.price;
  const nightly = property.priceInfo?.nightly;
  return (
    typeof base === 'number' &&
    typeof nightly === 'number' &&
    Number.isFinite(base) &&
    Number.isFinite(nightly) &&
    base !== nightly
  );
}
