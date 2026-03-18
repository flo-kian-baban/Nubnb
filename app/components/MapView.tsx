"use client";

import { useRef, useEffect, useCallback, useState } from "react";
import Map, { Marker, NavigationControl, MapRef } from "react-map-gl/maplibre";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MapPin } from "lucide-react";
import { Property } from "../data/properties";
import styles from "./MapView.module.css";

interface MapViewProps {
  properties: Property[];
  hoveredId: string | null;
  selectedId: string | null;
  onHover: (id: string | null) => void;
  onSelect: (id: string | null) => void;
}

// Ensure maplibre knows how to process vector styles correctly without mapbox token
// CartoDB Positron provides a clean, gray/white base map perfect for premium UI.
const MAP_STYLE = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";

export function MapView({
  properties,
  hoveredId,
  selectedId,
  onHover,
  onSelect,
}: MapViewProps) {
  const mapRef = useRef<MapRef>(null);
  const [zoomLevel, setZoomLevel] = useState(10); // Default zoom matches initialViewState

  // When a property is selected, fly to it perfectly using padding to account for the sliding UI overlap
  useEffect(() => {
    if (selectedId && mapRef.current) {
      const selected = properties.find((p) => p.id === selectedId);
      if (selected) {
        // Calculate the exact amount of map canvas covered by the animating detail panel
        const viewportWidth = window.innerWidth;
        const panelWidth = 480; // Matches --panel-width in globals.css
        const mapContainerWidth = viewportWidth - panelWidth;
        const coveredWidth = Math.max(0, mapContainerWidth - panelWidth);

        // A close approximation of the Apple cubic-bezier(0.32, 0.72, 0, 1) transition
        const customEasing = (t: number) => 1 - Math.pow(1 - t, 4);

        mapRef.current.flyTo({
          center: selected.coordinates,
          zoom: 14,
          speed: 1.2, // Slightly slower, majestic speed to match the 0.7s CSS shift
          curve: 1.2,
          padding: { right: coveredWidth }, // Forces mapbox to center the pin in the *visible* left 1/3
          easing: customEasing,
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // Tint the water to match the UI's secondary color (Light Blue)
  // and remove administrative borders for a cleaner look
  // and remove administrative borders for a cleaner look
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onMapLoad = useCallback((e: any) => {
    const map = e.target;
    
    try {
      // 1. Tint water layers (seas, oceans) but leave lakes and rivers (waterways) untouched
      if (map.getLayer("water")) {
        map.setPaintProperty("water", "fill-color", [
          "match",
          ["get", "class"],
          ["ocean", "sea", "bay", "strait"], "#6599CD", // Brand Light Blue for major bodies
          "#d4dadc" // the default CartoDB Positron water grey-blue for lakes/inland
        ]);
      }

      // 2. Hide administrative boundaries (country, state, city lines)
      // CartoDB Positron uses these specific layer naming conventions
      
      // We iterate over actual layers to catch CartoDB's specific nomenclature 
      // which often looks like 'boundary-{level}'
      const layers = map.getStyle().layers;
      if (layers) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        layers.forEach((layer: any) => {
          if (layer.id.includes("border") || layer.id.includes("boundary")) {
            map.setLayoutProperty(layer.id, "visibility", "none");
          }
        });
      }
    } catch (err) {
      console.warn("Could not customize map layers", err);
    }
  }, []);

  return (
    <div className={styles.mapContainer}>
      <Map
        ref={mapRef}
        initialViewState={{
          longitude: -79.4395, // Centered around Richmond Hill initially
          latitude: 43.8561,
          zoom: 10,
        }}
        mapStyle={MAP_STYLE}
        mapLib={maplibregl}
        interactiveLayerIds={[]}
        onLoad={onMapLoad}
        onZoom={(e) => setZoomLevel(e.viewState.zoom)}
      >
        <NavigationControl position="bottom-right" showCompass={false} />

        {properties.map((property) => {
          const isHovered = hoveredId === property.id;
          const isSelected = selectedId === property.id;

          return (
            <Marker
              key={property.id}
              longitude={property.coordinates[0]}
              latitude={property.coordinates[1]}
              anchor="center"
              onClick={(e) => {
                e.originalEvent.stopPropagation();
                onSelect(property.id);
              }}
            >
              <div
                className={`
                  ${styles.marker} 
                  ${(zoomLevel < 9.5 && !isHovered && !isSelected) ? styles.condensed : ""}
                  ${isHovered ? styles.hovered : ""} 
                  ${isSelected ? styles.selected : ""}
                `}
                onMouseEnter={() => onHover(property.id)}
                onMouseLeave={() => onHover(null)}
              >
                {(zoomLevel < 9.5 && !isHovered && !isSelected) ? (
                  <MapPin size={24} strokeWidth={2.5} />
                ) : (
                  `$${property.price}`
                )}
              </div>
            </Marker>
          );
        })}
      </Map>
    </div>
  );
}
