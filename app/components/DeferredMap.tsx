"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { PropertySummary } from "@/app/types/property";
import styles from "./MapView.module.css";

/**
 * The longest the map waits for the page to finish loading before mounting
 * anyway. A visitor on a flaky connection still gets a map.
 */
const MAP_MOUNT_BACKSTOP_MS = 4000;

/**
 * MapLibre, loaded after the page's own resources have.
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
    let idleFallback: ReturnType<typeof setTimeout> | undefined;

    const mount = () => {
      if (!cancelled) setMounted(true);
    };

    // Idle alone was not enough. The first idle callback fires about 100 ms
    // into the page load, which is long before the LCP image has arrived, so
    // MapLibre's 271 KB chunk and ~300 KB of tiles were still competing with
    // it for bandwidth. Measured on production: blocking those two took the
    // LCP image's load time from 5,799 ms to 1,106 ms — 81% of it was
    // contention with the map, not origin latency.
    //
    // So the gate is the `load` event, which fires only once the images the
    // page asked for up front have finished, and then idle on top of it.
    const afterLoad = () => {
      if (cancelled) return;
      const ric = typeof window !== "undefined" ? window.requestIdleCallback : undefined;
      if (ric) idleHandle = ric(mount, { timeout: 1000 });
      else idleFallback = setTimeout(mount, 200);
    };

    // A stalled third-party image must not be able to hold the map back
    // forever, so `load` races a hard backstop.
    const backstop = setTimeout(mount, MAP_MOUNT_BACKSTOP_MS);

    if (document.readyState === "complete") afterLoad();
    else window.addEventListener("load", afterLoad, { once: true });

    return () => {
      cancelled = true;
      window.removeEventListener("load", afterLoad);
      if (idleHandle !== undefined) window.cancelIdleCallback?.(idleHandle);
      if (idleFallback) clearTimeout(idleFallback);
      clearTimeout(backstop);
    };
  }, []);

  if (!mounted) {
    // Deliberately empty. The logo the real map carries is 35.9 KB, and
    // rendering it here put it in flight alongside the LCP image for the sake
    // of a watermark on a grey rectangle nobody is looking at yet. MapView
    // draws it the moment it mounts, which is the first point it means
    // anything.
    return <div className={styles.mapContainer} aria-hidden="true" />;
  }

  return <MapView {...props} />;
}
