import { useEffect } from "react";
import { Property } from "@/app/types/property";
import { PropertyCard } from "./PropertyCard";
import styles from "./PropertyList.module.css";
import { MapPin } from "lucide-react";

interface PropertyListProps {
  properties: Property[];
  hoveredId: string | null;
  selectedId: string | null;
  onHover: (id: string | null) => void;
  onSelect: (id: string | null) => void;
}

export function PropertyList({
  properties,
  hoveredId,
  selectedId,
  onHover,
  onSelect,
}: PropertyListProps) {
  
  // Smoothly scroll the list to the selected property card when it changes
  useEffect(() => {
    if (selectedId) {
      const element = document.getElementById(`property-card-${selectedId}`);
      if (element) {
        element.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
  }, [selectedId]);
  if (properties.length === 0) {
    return (
      <div className={styles.emptyState}>
        <MapPin size={32} opacity={0.5} />
        <div>
          <h3>No properties found</h3>
          <p>Try adjusting your search or filters to explore more locations.</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`${styles.list} ${selectedId ? styles.hasSelection : ""}`}>
      {properties.map((property) => (
        <div
          key={property.id}
          id={`property-card-${property.id}`}
          className={selectedId === property.id ? styles.selectedCard : ""}
        >
          <PropertyCard
            property={property}
            isHovered={hoveredId === property.id}
            isSelected={selectedId === property.id}
            onHover={() => onHover(property.id)}
            onLeave={() => onHover(null)}
            onClick={() => onSelect(property.id)}
          />
        </div>
      ))}
    </div>
  );
}
