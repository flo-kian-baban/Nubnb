"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import styles from "./layout.module.css";

/* ── Transition context ──────────────────── */
type TransitionFn = (href: string, bg: string) => void;
const TransitionCtx = createContext<TransitionFn>(() => {});

export function usePageTransition() {
  return useContext(TransitionCtx);
}

/* ── Layout ──────────────────────────────── */
export default function AboutLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [overlay, setOverlay] = useState({ visible: false, fading: false, bg: "" });

  const startTransition: TransitionFn = useCallback(
    (href, bg) => {
      if (overlay.visible) return;

      router.prefetch(href);

      // Phase 1: overlay fades in (syncs with the panel expansion in the page)
      setOverlay({ visible: true, fading: false, bg });

      // Phase 2: navigate while overlay is fully opaque
      setTimeout(() => {
        router.push(href);

        // Phase 3: new page has mounted, start fading overlay out
        requestAnimationFrame(() => {
          setTimeout(() => {
            setOverlay((o) => ({ ...o, fading: true }));

            // Phase 4: cleanup
            setTimeout(() => {
              setOverlay({ visible: false, fading: false, bg: "" });
            }, 550);
          }, 100);
        });
      }, 650);
    },
    [overlay.visible, router]
  );

  return (
    <TransitionCtx.Provider value={startTransition}>
      {children}

      {overlay.visible && (
        <div
          className={`${styles.overlay} ${overlay.fading ? styles.overlayFadeOut : styles.overlayFadeIn}`}
          style={{ backgroundColor: overlay.bg }}
        />
      )}
    </TransitionCtx.Provider>
  );
}
