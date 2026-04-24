"use client";

import Image from "next/image";
import { MapPin } from "lucide-react";
import { Property } from "@/app/types/property";
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
        <Image 
          src={property.coverImage} 
          alt={property.name} 
          className={styles.image}
          fill
          sizes="(max-width: 768px) 100vw, (max-width: 1024px) 380px, 480px"
          priority={false}
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
            <div className={styles.price}>
              <span className={styles.priceCurrency}>$</span>{property.priceInfo?.nightly || property.price}
            </div>
            <div className={styles.priceLabel}>NIGHT</div>
          </div>
        </div>
      </div>
    </div>
  );
}
