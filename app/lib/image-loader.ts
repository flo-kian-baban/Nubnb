/**
 * The `next/image` loader — wired in next.config.mjs as `images.loader:
 * 'custom'`, which takes Vercel's image optimiser out of the path entirely.
 *
 * With a custom loader `next/image` never requests `/_next/image`, so a page
 * view costs zero image transformations, zero image cache reads and zero
 * image cache writes on Vercel, and the bytes come from Firebase Storage
 * instead of Vercel's Fast Data Transfer. That is the point of the change:
 * Storage egress is free to 100 GB/month in us-central1, and the Vercel
 * allowance is shared with other projects.
 *
 * What `next/image` still does for us: sizing from the `sizes` attribute,
 * `srcset` generation, lazy-loading, `priority` preloads and the
 * aspect-ratio box that keeps CLS at zero. Only the byte-serving moves.
 *
 * Anything that is not a mirrored image is returned untouched — the logo in
 * /public, the illustrations on the About pages, an admin upload, or a
 * property whose images have not been mirrored yet. Those are served as they
 * always were; they are simply not resized.
 */

import { variantUrl } from './image-variants';

interface LoaderArgs {
  src: string;
  width: number;
  quality?: number;
}

/**
 * `quality` is deliberately ignored: the variants are pre-encoded at q=75 in
 * the mirror, so there is nothing to vary at request time. Accepting the
 * argument and dropping it is what keeps `next/image`'s own API intact.
 */
export default function nubnbImageLoader({ src, width }: LoaderArgs): string {
  return variantUrl(src, width) ?? src;
}
