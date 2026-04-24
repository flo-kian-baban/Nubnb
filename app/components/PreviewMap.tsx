"use client";

import React, { useRef, useCallback } from "react";
import Map, { Marker, MapRef } from "react-map-gl/maplibre";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MapPin } from "lucide-react";
import { Property } from "@/app/types/property";
import styles from "./PreviewMap.module.css";

const MAP_STYLE =
  "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";

interface PreviewMapProps {
  properties: Property[];
}

export function PreviewMap({ properties }: PreviewMapProps) {
  const mapRef = useRef<MapRef>(null);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onMapLoad = useCallback((e: any) => {
    const map = e.target;
    try {
      if (map.getLayer("water")) {
        map.setPaintProperty("water", "fill-color", [
          "match",
          ["get", "class"],
          ["ocean", "sea", "bay", "strait"],
          "#6599CD",
          "#d4dadc",
        ]);
      }
      const layers = map.getStyle().layers;
      if (layers) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        layers.forEach((layer: any) => {
          if (
            layer.id.includes("border") ||
            layer.id.includes("boundary")
          ) {
            map.setLayoutProperty(layer.id, "visibility", "none");
          }
        });
      }
    } catch (err) {
      console.warn("Could not customize preview map layers", err);
    }
  }, []);

  return (
    <div className={styles.previewContainer}>
      <Map
        ref={mapRef}
        initialViewState={{
          longitude: -79.4395,
          latitude: 43.8561,
          zoom: 9.2,
        }}
        mapStyle={MAP_STYLE}
        mapLib={maplibregl}
        interactive={false}
        attributionControl={false}
        onLoad={onMapLoad}
      >
        {properties.map((p) => (
          <Marker
            key={p.id}
            longitude={p.coordinates[0]}
            latitude={p.coordinates[1]}
            anchor="center"
          >
            <div className={styles.pin}>
              <MapPin size={18} strokeWidth={2.5} />
            </div>
          </Marker>
        ))}
      </Map>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo-nubnb.png" alt="NUBNB" className={styles.logo} />
    </div>
  );
}
