"use client";

/**
 * A bar pinned to the bottom of the screen (Build 1 of 2026-11-02: "The pinned bar must never cover a card's content"):
 * the screen under it is padded by the bar's measured height, so the last card always scrolls clear of it. Measured
 * with a ResizeObserver, so a note added to the bar ("Not sent yet · …") pads the screen too. It watches the bar's
 * border box (2026-11-05): the bar's bottom padding holds the phone's safe-area inset, which Safari changes as its
 * toolbar shows and hides, and a padding change leaves the content box — the observer's default — as it was.
 */

import { useEffect, useRef, useState, type RefObject } from "react";

export function usePinnedHeight(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setHeight(Math.ceil(el.getBoundingClientRect().height));
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(el, { box: "border-box" });
    return () => observer.disconnect();
  }, []);
  return [ref, height];
}
