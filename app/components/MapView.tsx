"use client";

import { useRef, useEffect, useCallback, useState, useMemo } from "react";
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

interface Cluster {
  key: string;
  lng: number;
  lat: number;
  properties: Property[];
}

const MAP_STYLE = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";

// Convert lng/lat to Web Mercator pixel coords at a given zoom
function lngLatToPixel(lng: number, lat: number, zoom: number): [number, number] {
  const scale = Math.pow(2, zoom) * 256;
  const x = ((lng + 180) / 360) * scale;
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale;
  return [x, y];
}

// Greedy clustering: group properties whose projected pixel positions are within threshold
function clusterProperties(properties: Property[], zoom: number, pixelThreshold: number): Cluster[] {
  const clusters: Cluster[] = [];
  const assigned = new Set<string>();

  const projected = properties.map((p) => ({
    property: p,
    px: lngLatToPixel(p.coordinates[0], p.coordinates[1], zoom),
  }));

  for (let i = 0; i < projected.length; i++) {
    if (assigned.has(projected[i].property.id)) continue;

    const seed = projected[i];
    const group: Property[] = [seed.property];
    assigned.add(seed.property.id);

    for (let j = i + 1; j < projected.length; j++) {
      if (assigned.has(projected[j].property.id)) continue;
      const dx = seed.px[0] - projected[j].px[0];
      const dy = seed.px[1] - projected[j].px[1];
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < pixelThreshold) {
        group.push(projected[j].property);
        assigned.add(projected[j].property.id);
      }
    }

    const avgLng = group.reduce((s, p) => s + p.coordinates[0], 0) / group.length;
    const avgLat = group.reduce((s, p) => s + p.coordinates[1], 0) / group.length;

    clusters.push({
      key: group.map((p) => p.id).sort().join("|"),
      lng: avgLng,
      lat: avgLat,
      properties: group,
    });
  }

  return clusters;
}

// Check if all properties share the exact same coordinates
function allSameLocation(props: Property[]): boolean {
  return props.every(
    (p) =>
      p.coordinates[0].toFixed(6) === props[0].coordinates[0].toFixed(6) &&
      p.coordinates[1].toFixed(6) === props[0].coordinates[1].toFixed(6)
  );
}

export function MapView({
  properties,
  hoveredId,
  selectedId,
  onHover,
  onSelect,
}: MapViewProps) {
  const mapRef = useRef<MapRef>(null);
  const [zoomLevel, setZoomLevel] = useState(10);
  // Track which property IDs are "force-expanded" (shown individually even if clustered)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const CLUSTER_PIXEL_THRESHOLD = 35;
  const COLLAPSE_ZOOM = 13;
  const AUTO_EXPAND_ZOOM = 14;

  // Split properties: expanded ones bypass clustering entirely
  const { toCluster, expanded } = useMemo(() => {
    const exp: Property[] = [];
    const rest: Property[] = [];
    properties.forEach((p) => {
      if (expandedIds.has(p.id)) exp.push(p);
      else rest.push(p);
    });
    return { toCluster: rest, expanded: exp };
  }, [properties, expandedIds]);

  // Only cluster the non-expanded properties
  const clusters = useMemo(
    () => clusterProperties(toCluster, zoomLevel, CLUSTER_PIXEL_THRESHOLD),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [toCluster, Math.round(zoomLevel * 2) / 2]
  );

  // Group expanded properties by same coordinates for translateY offset
  const expandedGroups = useMemo(() => {
    const map: Record<string, Property[]> = {};
    expanded.forEach((p) => {
      const key = `${p.coordinates[0].toFixed(6)},${p.coordinates[1].toFixed(6)}`;
      if (!map[key]) map[key] = [];
      map[key].push(p);
    });
    return Object.values(map);
  }, [expanded]);

  // When a property is selected, fly to it
  useEffect(() => {
    if (selectedId && mapRef.current) {
      const selected = properties.find((p) => p.id === selectedId);
      if (selected) {
        const viewportWidth = window.innerWidth;
        const panelWidth = 480;
        const mapContainerWidth = viewportWidth - panelWidth;
        const coveredWidth = Math.max(0, mapContainerWidth - panelWidth);
        const customEasing = (t: number) => 1 - Math.pow(1 - t, 4);

        mapRef.current.flyTo({
          center: selected.coordinates,
          zoom: 14,
          speed: 1.2,
          curve: 1.2,
          padding: { right: coveredWidth },
          easing: customEasing,
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onMapLoad = useCallback((e: any) => {
    const map = e.target;
    try {
      if (map.getLayer("water")) {
        map.setPaintProperty("water", "fill-color", [
          "match",
          ["get", "class"],
          ["ocean", "sea", "bay", "strait"], "#6599CD",
          "#d4dadc"
        ]);
      }
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

    // On mobile, fit bounds to show all properties
    if (window.innerWidth <= 768 && properties.length > 0) {
      const lngs = properties.map(p => p.coordinates[0]);
      const lats = properties.map(p => p.coordinates[1]);
      map.fitBounds(
        [
          [Math.min(...lngs), Math.min(...lats)],
          [Math.max(...lngs), Math.max(...lats)],
        ],
        { padding: { top: 80, bottom: 100, left: 40, right: 40 }, duration: 0 }
      );
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [properties]);

  // Auto-expand clusters at high zoom; collapse when zooming out
  useEffect(() => {
    if (zoomLevel >= AUTO_EXPAND_ZOOM && expandedIds.size === 0) {
      // Auto-expand all multi-member clusters
      const allExpandIds = new Set<string>();
      clusters.forEach((c) => {
        if (c.properties.length > 1) {
          c.properties.forEach((p) => allExpandIds.add(p.id));
        }
      });
      if (allExpandIds.size > 0) {
        setExpandedIds(allExpandIds);
      }
    }
    if (zoomLevel < COLLAPSE_ZOOM && expandedIds.size > 0) {
      setExpandedIds(new Set());
    }
  }, [zoomLevel, clusters, expandedIds.size]);

  // Collapse all
  const collapseAll = () => setExpandedIds(new Set());

  return (
    <div className={styles.mapContainer}>
      <Map
        ref={mapRef}
        initialViewState={{
          longitude: -79.4395,
          latitude: 43.8561,
          zoom: 10,
        }}
        mapStyle={MAP_STYLE}
        mapLib={maplibregl}
        interactiveLayerIds={[]}
        onLoad={onMapLoad}
        onZoom={(e) => setZoomLevel(e.viewState.zoom)}
        onClick={() => collapseAll()}
      >
        <NavigationControl position="bottom-right" showCompass={false} />

        {/* ── Non-expanded: single markers + cluster badges ── */}
        {clusters.map((cluster) => {
          const isMulti = cluster.properties.length > 1;

          // Single property marker
          if (!isMulti) {
            const property = cluster.properties[0];
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
          }

          // Cluster badge
          return (
            <Marker
              key={cluster.key}
              longitude={cluster.lng}
              latitude={cluster.lat}
              anchor="center"
              onClick={(e) => {
                e.originalEvent.stopPropagation();
                const members = cluster.properties;
                if (mapRef.current) {
                  const customEasing = (t: number) => 1 - Math.pow(1 - t, 4);
                  mapRef.current.flyTo({
                    center: [cluster.lng, cluster.lat],
                    zoom: Math.max(zoomLevel + 3, 15),
                    speed: 1.2,
                    curve: 1.2,
                    easing: customEasing,
                  });
                }
                setTimeout(() => {
                  setExpandedIds((prev) => {
                    const next = new Set(prev);
                    members.forEach((p) => next.add(p.id));
                    return next;
                  });
                }, 1000);
              }}
            >
              <div className={styles.clusterMarker}>
                <span className={styles.clusterCount}>{cluster.properties.length}</span>
                <span className={styles.clusterLabel}>units</span>
              </div>
            </Marker>
          );
        })}

        {/* ── Expanded properties: shown individually ── */}
        {expandedGroups.map((group) => {
          if (group.length > 1) {
            // Same-coordinate group: offset via translateY
            const half = (group.length - 1) / 2;
            return group.map((property, i) => {
              const isHovered = hoveredId === property.id;
              const isSelected = selectedId === property.id;
              const yOffset = (i - half) * 35;

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
                    className={styles.expandedOffset}
                    style={{ transform: `translateY(${yOffset}px)` }}
                  >
                    <div
                      className={`
                        ${styles.marker} 
                        ${styles.expandedMarker}
                        ${isHovered ? styles.hovered : ""} 
                        ${isSelected ? styles.selected : ""}
                      `}
                      onMouseEnter={() => onHover(property.id)}
                      onMouseLeave={() => onHover(null)}
                    >
                      {`$${property.price}`}
                    </div>
                  </div>
                </Marker>
              );
            });
          }

          // Single expanded property at its actual location
          const property = group[0];
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
                  ${isHovered ? styles.hovered : ""} 
                  ${isSelected ? styles.selected : ""}
                `}
                onMouseEnter={() => onHover(property.id)}
                onMouseLeave={() => onHover(null)}
              >
                {`$${property.price}`}
              </div>
            </Marker>
          );
        })}
      </Map>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo-nubnb.png" alt="NUBNB" className={styles.mapLogo} />
    </div>
  );
}

