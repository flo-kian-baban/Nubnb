"use client";

/**
 * A row's other actions, behind "⋯" (TEAM-PAY-PLAN.md §4: the Team page's row needed the room its buttons took; shared
 * with the Schedule since Build 2, 2026-11-03, where "Amount" and "Delete…" live in it, Kian's ruling: the per-job
 * amount is set from the row's menu, not a button on every row). Nubnb's own menu, as the header's account menu is: it
 * opens under its button, closes on a pick, a click elsewhere, Escape, or the page scrolling, and is drawn fixed to the
 * window so the table's scrolling box cannot cut it off. The trigger's look is the page's (`triggerClassName`).
 */

import { useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import styles from "./RowMenu.module.css";

export interface RowMenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  /** Shown, but not to be chosen, with why in the tooltip. */
  disabled?: boolean;
  title?: string;
}

export function RowMenu({ label, items, disabled, triggerClassName }: { label: string; items: RowMenuItem[]; disabled?: boolean; /** The page's own look for the "⋯" button; the Team page's dark ghost button when not given. */ triggerClassName?: string }) {
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!at) return;
    const close = () => setAt(null);
    const onDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      close();
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [at]);

  const toggle = () => {
    if (at) {
      setAt(null);
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setAt({ top: rect.bottom + 6, right: window.innerWidth - rect.right });
  };

  return (
    <div ref={rootRef} className={styles.root}>
      <button ref={triggerRef} type="button" className={triggerClassName ?? styles.trigger} aria-haspopup="menu" aria-expanded={at !== null} aria-label={label} title={label} disabled={disabled} onClick={toggle}>
        <MoreHorizontal size={16} aria-hidden />
      </button>
      {at && (
        <div className={styles.menu} role="menu" aria-label={label} style={{ top: at.top, right: at.right }}>
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={`${styles.item} ${item.danger ? styles.itemDanger : ""}`}
              disabled={item.disabled}
              title={item.title}
              onClick={() => {
                setAt(null);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
