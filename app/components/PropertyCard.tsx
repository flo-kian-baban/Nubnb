"use client";

import { MapPin } from "lucide-react";
import { Property } from "../data/properties";
import styles from "./PropertyCard.module.css";

interface PropertyCardProps {
  property: Property;
  isHovered: boolean;
  isSelected: boolean;
  onHover: () => void;
  onLeave: () => void;
  onClick: () => void;
}

export function PropertyCard({
  property,
  isHovered,
  isSelected,
  onHover,
  onLeave,
  onClick
}: PropertyCardProps) {
  // We use next/link conceptually for the handoff, 
  // but for the split view it also acts as a selector. 
  // In a real app we might route to `/[slug]` directly, 
  // but here we select on click. We'll wrap the image in a link to show the handoff intent.
  
  return (
    <div 
      className={`
        ${styles.card} 
        ${isHovered ? styles.hovered : ''} 
        ${isSelected ? styles.selected : ''}
      `}
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
      onClick={onClick}
    >
      <div className={styles.imageContainer}>
        <img 
          src={property.coverImage} 
          alt={property.name} 
          className={styles.image}
          loading="lazy"
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
            <h3 className={styles.title}>{property.name}</h3>
            <div className={styles.meta}>
              {property.guests} Guests <span className={styles.dot}>•</span> {property.bedrooms} Beds <span className={styles.dot}>•</span> {property.bathrooms} Baths
            </div>
          </div>
          
          <div className={styles.priceGroup}>
            <div className={styles.price}>${property.priceInfo?.nightly || property.price}</div>
            <div className={styles.priceLabel}>NIGHT</div>
          </div>
        </div>
      </div>
    </div>
  );
}
