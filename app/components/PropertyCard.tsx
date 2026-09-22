"use client";

import Image from "next/image";
import { MapPin } from "lucide-react";
import { PropertySummary } from "@/app/types/property";
import styles from "./PropertyCard.module.css";
import { nightlyPrice } from "@/app/lib/price";
import { useNearViewport } from "@/app/lib/useNearViewport";
import { withMinVariantWidth } from "@/app/lib/image-variants";

/**
 * How far ahead of the viewport a card asks for its image.
 *
 * One screen-ish. Tight enough that a card well below the fold stays
 * unrequested — the whole point, since 618 KB of off-screen card images were
 * competing with the LCP image for bandwidth — and loose enough that an
 * image is in flight before a normal scroll reaches it.
 */
const IMAGE_PRELOAD_MARGIN = "400px";

/**
 * The narrowest variant a card may ever be served.
 *
 * A card is between 375 and 480 CSS px wide, so w200 would be a visibly soft
 * upscale. `next/image` does not offer a way to restrict a single image's
 * candidate widths, so the floor is declared on the src and enforced by our
 * own loader — see `withMinVariantWidth`. It is a no-op today and a guard
 * against next/image changing how it picks candidates.
 */
const CARD_MIN_WIDTH = 400;

interface PropertyCardProps {
  property: PropertySummary;
  isHovered: boolean;
  isSelected: boolean;
  onHover: () => void;
  onLeave: () => void;
  onClick: () => void;
  /**
   * Preload this card's image instead of lazy-loading it.
   *
   * Every card used to be `priority={false}`, which was harmless while the
   * page shipped no listings at all. Now that the list is server-rendered the
   * first card's image is the page's LCP element, and leaving it
   * `loading="lazy"` means the browser finds it late: measured at 3.5s or
   * 6.8s on the same build depending on when the lazy loader got to it.
   */
  priority?: boolean;
  /**
   * False while the list is translated off-screen behind an open detail
   * panel. Chrome's lazy-loading threshold reaches thousands of pixels past
   * the viewport on a slow connection, so `loading="lazy"` alone still
   * fetched all 35 cards on a /property/<slug> arrival — 1,594 KB for a list
   * the visitor is not looking at. The only reliable gate is not rendering
   * the <img> at all. The box keeps its size either way, so revealing the
   * list shifts nothing.
   *
   * When true the card still waits until it is within
   * IMAGE_PRELOAD_MARGIN of the viewport, unless `priority` says it is
   * above the fold.
   */
  showImage?: boolean;
}

/**
 * A card is one interactive control, not a clickable box.
 *
 * It used to be a `<div onClick>`: not reachable by Tab, not operable by
 * Enter or Space, and announced as nothing in particular. The control is now
 * the title button, whose `::after` is stretched over the whole card — so the
 * click target is exactly what it was, the accessible name is just the
 * property name rather than the card's entire contents, and the `<h3>` stays
 * a real heading instead of being swallowed by a button (a heading is flow
 * content and is not valid inside one).
 *
 * Focus is mirrored to the map the same way hover is, so tabbing the list
 * highlights pins exactly as pointing at it does.
 */
export function PropertyCard({
  property,
  isHovered,
  isSelected,
  onHover,
  onLeave,
  onClick,
  priority = false,
  showImage = true,
}: PropertyCardProps) {
  // An above-the-fold card never waits: it is the LCP candidate and is
  // preloaded from the HTML.
  const [imageRef, nearViewport] = useNearViewport<HTMLDivElement>(
    IMAGE_PRELOAD_MARGIN,
    priority,
  );
  const loadImage = showImage && nearViewport;

  return (
    <div 
      className={`
        ${styles.card} 
        ${isHovered ? styles.hovered : ''} 
        ${isSelected ? styles.selected : ''}
      `}
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
    >
      <div className={styles.imageContainer} ref={imageRef}>
        {loadImage && (
          <Image
            src={withMinVariantWidth(property.coverImage, CARD_MIN_WIDTH)}
            alt={property.name}
            className={styles.image}
            fill
            /* The honest figure: a card fills the screen at phone width.

               A DPR-2 phone therefore asks for 750px and gets the w750
               variant. The w400 variant serves DPR-1 and the narrower
               breakpoints. An earlier revision declared 51vw to force w400
               everywhere; that traded sharpness for bytes by lying about the
               layout, and it leaned on next/image's candidate arithmetic to
               keep the 200px thumbnail size out of this srcset. Both are
               stated directly now — the width below, and CARD_MIN_WIDTH. */
            sizes="(max-width: 768px) 100vw, (max-width: 1024px) 380px, 480px"
            priority={priority}
            /* `priority` emits the <link rel="preload"> and drops
               loading="lazy", but Next does not put fetchpriority on the
               <img> itself, so the request still queues behind the scripts.
               Setting it here is what actually moves the LCP image to the
               front. Measured Load Delay of 3,962 ms without it. */
            fetchPriority={priority ? "high" : undefined}
          />
        )}
      </div>
      
      <div className={styles.gradientOverlay} />
      
      <div className={styles.statsNotch}>
        <div className={styles.statItem}>
          <MapPin size={14} /> 
          <span>
            {property.addressDetails?.city 
              ? `${property.addressDetails.city}${property.addressDetails.state ? `, ${property.addressDetails.state}` : ''}` 
              : property.location}
          </span>
        </div>
      </div>

      <div className={styles.content}>
        <div className={styles.bottomRow}>
          <div className={styles.mainInfo}>
            <h3 className={styles.title}>
              <button
                type="button"
                className={styles.titleButton}
                onClick={onClick}
                onFocus={onHover}
                onBlur={onLeave}
              >
                {property.name}
              </button>
            </h3>
            <div className={styles.meta}>
              {property.guests} Guests <span className={styles.dot}>•</span> {property.bedrooms} Beds <span className={styles.dot}>•</span> {property.bathrooms} Baths
            </div>
          </div>
          
          <div className={styles.priceGroup}>
            <div className={styles.price}>
              <span className={styles.priceCurrency}>$</span>{nightlyPrice(property)}
            </div>
            <div className={styles.priceLabel}>NIGHT</div>
          </div>
        </div>
      </div>
    </div>
  );
}
