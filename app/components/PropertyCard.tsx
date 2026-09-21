"use client";

import Image from "next/image";
import { MapPin } from "lucide-react";
import { PropertySummary } from "@/app/types/property";
import styles from "./PropertyCard.module.css";
import { nightlyPrice } from "@/app/lib/price";

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
}: PropertyCardProps) {
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
      <div className={styles.imageContainer}>
        <Image 
          src={property.coverImage} 
          alt={property.name} 
          className={styles.image}
          fill
          sizes="(max-width: 768px) 100vw, (max-width: 1024px) 380px, 480px"
          priority={priority}
        />
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
