"use client";

import { StoredImage } from "./StoredImage";
import { useNearViewport } from "@/app/lib/useNearViewport";

/**
 * How far outside the visible strip a thumbnail asks for its image.
 *
 * The strip scrolls horizontally and each tile is 100px wide, so roughly
 * three tiles either side of what is on screen. A property with 48 images
 * used to request all 48 at once; now it requests what is visible plus a
 * short runway.
 */
const THUMB_PRELOAD_MARGIN = "300px";

/**
 * How many thumbnails load without waiting to be seen.
 *
 * The first is the hero's own image and is already in the browser cache from
 * the hero itself; the next few are in the visible part of the strip at
 * phone width.
 */
export const EAGER_THUMBS = 4;

interface GalleryThumbProps {
  src: string;
  index: number;
  active: boolean;
  className: string;
  imageClassName: string;
  sizes: string;
  onSelect: () => void;
}

/**
 * One tile in the detail panel's thumbnail strip.
 *
 * Split out of PropertyDetailPanel so each tile can own an
 * IntersectionObserver — a hook cannot be called inside a `.map()` in the
 * parent. The markup and click behaviour are unchanged from the inline
 * version it replaces.
 */
export function GalleryThumb({
  src,
  index,
  active,
  className,
  imageClassName,
  sizes,
  onSelect,
}: GalleryThumbProps) {
  const [ref, near] = useNearViewport<HTMLDivElement>(
    THUMB_PRELOAD_MARGIN,
    index < EAGER_THUMBS,
  );

  return (
    <div
      ref={ref}
      className={className}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
      title={`View image ${index + 1}`}
      aria-current={active ? "true" : undefined}
    >
      {/* Decorative: the control is the tile, which carries the accessible
          name via `title`. An alt here would announce the same property name
          once per thumbnail. */}
      {near && <StoredImage src={src} alt="" className={imageClassName} sizes={sizes} />}
    </div>
  );
}
