/**
 * Derived WebP variants of the mirrored images, addressed without Firestore.
 *
 * Every mirrored original lives at
 *
 *     properties/mirrored/<propertyId>/<slot>_<hash>.<ext>
 *
 * and is served by the Firebase download endpoint, where the unguessable
 * `token` in the query string *is* the read credential (storage.rules denies
 * all client access; token URLs bypass rules entirely). A variant is stored
 * beside its original under a name derived from it:
 *
 *     properties/mirrored/<propertyId>/<slot>_<hash>_w750.webp
 *
 * and — this is the whole trick — is written with the **same
 * `firebaseStorageDownloadTokens` value as its original**. So the variant's
 * URL is a pure function of the original's stored URL: swap the object path,
 * keep the query string untouched. No Firestore field changes, no second
 * lookup, nothing to keep in sync.
 *
 * Verified against the live bucket before this module was written: two
 * objects sharing one token both returned 200; the same variant returned 403
 * with a different token and 403 with no token. The token remains a real
 * credential — it is simply shared between an original and its derivatives,
 * which are the same bytes at a different size.
 *
 * ── What this module will not do ──
 * `variantUrl` returns `null` for anything that is not one of our own Storage
 * objects — an unmirrored property still carrying its `a0.muscache.com` URL,
 * the logo in /public, an About-page illustration. Those are returned as
 * given rather than rewritten into a 404. Admin uploads
 * (`properties/<timestamp>_<uuid>_<name>`) *do* get variants, generated in
 * place beside them, because they are their own stored URL and are never
 * re-fetched into the mirror.
 */

/**
 * The widths generated for every mirrored image.
 *
 * Three, not five, because the sources cap at 1200px wide (Airbnb serves
 * `im_w=1200`) and the surfaces only ask for three sizes:
 *   200  — the 100x68 detail-panel thumbnails at 2x
 *   750  — a card at phone width, and the detail hero on mobile, at 2x
 *  1200  — the detail hero on desktop; also the source's native width
 *
 * Kept in sync with `images.deviceSizes` / `images.imageSizes` in
 * next.config.mjs, so `next/image` only ever asks for a width that exists.
 */
export const VARIANT_WIDTHS = [200, 750, 1200] as const;

export type VariantWidth = (typeof VARIANT_WIDTHS)[number];

/**
 * Only objects under this prefix have variants.
 *
 * Deliberately `properties/` and not `properties/mirrored/`: an image the
 * admin uploaded through `/api/upload-image` lands at
 * `properties/<timestamp>_<uuid>_<name>` and is its own stored URL — it is
 * never re-fetched into the mirror — so it needs variants generated beside it
 * in place. `mirrorPropertyImages` generates them for both kinds, and refuses
 * to report an image stored until they exist.
 */
export const VARIANT_PREFIX = 'properties/';

/**
 * A Firebase download URL, split into the parts we need.
 *
 * Matched rather than parsed with `new URL` so this stays cheap enough to run
 * once per image per srcset entry in the browser.
 */
const DOWNLOAD_URL = /^(https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/[^/]+\/o\/)([^?]+)(\?.*)$/;

/**
 * The object path a variant of `originalPath` is stored at.
 *
 * The original's extension is replaced, not appended to, so
 * `cover_ab12.jpg` and a hypothetical `cover_ab12.png` of the same image
 * would not collide at different widths.
 */
export function variantObjectPath(originalPath: string, width: number): string {
  const base = originalPath.replace(/\.[a-z0-9]+$/i, '');
  return `${base}_w${width}.webp`;
}

/**
 * The variant width to serve for a requested width.
 *
 * The smallest variant at least as wide as the request, so an image is never
 * upscaled; the largest variant when the request exceeds every variant, which
 * is the best we have — the sources are 1200px wide and there is nothing
 * sharper to serve.
 */
export function pickVariantWidth(requested: number): VariantWidth {
  for (const w of VARIANT_WIDTHS) {
    if (w >= requested) return w;
  }
  return VARIANT_WIDTHS[VARIANT_WIDTHS.length - 1];
}

/**
 * The URL of `storedUrl`'s variant at `width`, or `null` when there is none.
 *
 * `null` means "this is not one of our Storage objects" — not "the variant is
 * missing". A missing variant cannot be detected from the URL alone, and is
 * handled the only place it can be: `mirrorPropertyImages` refuses to report
 * an image stored until all three variants exist, so a stored URL either has
 * its full set or the document was never given a stored URL at all. The
 * surfaces additionally carry a runtime `onError` fallback to the original,
 * for objects that predate that rule.
 */
export function variantUrl(storedUrl: string, width: number): string | null {
  const m = DOWNLOAD_URL.exec(storedUrl);
  if (!m) return null;

  const [, origin, encodedPath, query] = m;

  let objectPath: string;
  try {
    objectPath = decodeURIComponent(encodedPath);
  } catch {
    return null; // malformed percent-encoding — leave the URL alone
  }

  if (!objectPath.startsWith(VARIANT_PREFIX)) return null;

  return origin + encodeURIComponent(variantObjectPath(objectPath, pickVariantWidth(width))) + query;
}

/**
 * True when `url` is a mirrored original that has variants.
 *
 * Used by the surfaces to decide whether an image can be asked for at a
 * specific width or has to be taken as-is.
 */
export function hasVariants(url: string): boolean {
  return variantUrl(url, VARIANT_WIDTHS[0]) !== null;
}
