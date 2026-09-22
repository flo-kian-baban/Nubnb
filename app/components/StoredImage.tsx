"use client";

import Image from "next/image";
import { useState } from "react";
import { bareStoredUrl } from "@/app/lib/image-variants";

/**
 * A property image, served from Nubnb's own Storage through the custom
 * `next/image` loader.
 *
 * Two layers of fallback, for two different failures:
 *
 *  1. **No stored URL.** The server already resolved this: the summary and
 *     the document carry `coverImageStored` when it exists and the original
 *     `a0.muscache.com` URL when it does not (see `toSummary`). A non-Storage
 *     URL makes the loader a no-op, so the original is served untouched.
 *  2. **Stored URL, missing variant.** Should not happen — the mirror refuses
 *     to record an image as stored until all three variants exist — but a
 *     derived URL that 404s or 403s would otherwise render as a broken image
 *     forever. `onError` drops to `unoptimized`, which bypasses the loader
 *     and requests the stored original exactly as given.
 *
 * `fill` is always used: every call site is a fixed-aspect box, and `fill`
 * plus `object-fit: cover` reproduces the `background-size: cover` these
 * surfaces used before without introducing layout shift.
 */
interface StoredImageProps {
  src: string;
  alt: string;
  /** Maps to the widths in next.config.mjs — 200, 750 or 1200. */
  sizes: string;
  className?: string;
  priority?: boolean;
}

export function StoredImage({ src, alt, sizes, className, priority = false }: StoredImageProps) {
  const [variantFailed, setVariantFailed] = useState(false);

  return (
    <Image
      key={src}
      src={variantFailed ? bareStoredUrl(src) : src}
      alt={alt}
      fill
      sizes={sizes}
      className={className}
      priority={priority}
      /* See PropertyCard: `priority` alone does not reach the <img>. */
      fetchPriority={priority ? "high" : undefined}
      unoptimized={variantFailed}
      onError={() => setVariantFailed(true)}
    />
  );
}
