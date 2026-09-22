"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { PropertySummary } from "@/app/types/property";
import styles from "./MapView.module.css";

/**
 * MapLibre, loaded after the list has painted.
 *
 * MapLibre GL is 271 KB over the wire and 1,025 KB unpacked, and it cost
 * 710 ms of main-thread time (547 ms of it scripting) during the first paint.
 * Measured on production before this change: 80% of an 8.24 s LCP was Render
 * Delay, and blocking this one chunk took Lighthouse mobile from 62 to 86 and
 * LCP from 8.24 s to 3.92 s. Nothing about the images came close — the LCP
 * image's own download was 229 ms of that 8.24 s.
 *
 * So the map is split into its own chunk and mounted only once the browser
 * has painted the list and gone idle. The listings are the page; the map is
 * what you look at second.
 *
 * ── No layout shift ──
 * The placeholder is the same `.mapContainer` box the real map renders into —
 * same class, same `flex: 1` inside `.rightPanel`, same background, same
 * logo. The swap replaces the contents of a box whose size never changes, so
 * CLS stays at the 0.000 it was measured at.
 */
const MapView = dynamic(() => import("./MapView").then((m) => m.MapView), {
  // The map reads `window` during setup and has no meaningful server render;
  // it was already client-only in practice.
  ssr: false,
});

interface DeferredMapProps {
  properties: PropertySummary[];
  hoveredId: string | null;
  selectedId: string | null;
  onHover: (id: string | null) => void;
  onSelect: (id: string | null) => void;
}

export function DeferredMap(props: DeferredMapProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let idleHandle: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const mount = () => {
      if (!cancelled) setMounted(true);
    };

    // One frame to let the hydrated list paint, then the first idle moment
    // after it. The 1.5 s timeout is the backstop: on a slow phone the main
    // thread may never go properly idle, and a map that never appears is a
    // worse outcome than one that appears a beat late.
    const frame = requestAnimationFrame(() => {
      if (cancelled) return;
      const ric = typeof window !== "undefined" ? window.requestIdleCallback : undefined;
      if (ric) idleHandle = ric(mount, { timeout: 1500 });
      else timer = setTimeout(mount, 300);
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      if (idleHandle !== undefined) window.cancelIdleCallback?.(idleHandle);
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (!mounted) {
    return (
      <div className={styles.mapContainer} aria-hidden="true">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo-nubnb.png" alt="" className={styles.mapLogo} />
      </div>
    );
  }

  return <MapView {...props} />;
}
