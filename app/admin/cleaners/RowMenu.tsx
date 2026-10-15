"use client";

/**
 * A team member's other actions, behind "⋯" beside Pay (TEAM-PAY-PLAN.md §4: the row's three pay columns need the
 * room the buttons took). Nubnb's own menu, as the header's account menu is: it opens under its button, closes on a
 * pick, a click elsewhere, Escape, or the page scrolling, and is drawn fixed to the window so the table's scrolling
 * box cannot cut it off.
 */

import { useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import styles from "./page.module.css";

export interface RowMenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
}

export function RowMenu({ label, items, disabled }: { label: string; items: RowMenuItem[]; disabled?: boolean }) {
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
    <div ref={rootRef} className={styles.rowMenuRoot}>
      <button ref={triggerRef} type="button" className={`${styles.rowAction} ${styles.rowMenuTrigger}`} aria-haspopup="menu" aria-expanded={at !== null} aria-label={label} title={label} disabled={disabled} onClick={toggle}>
        <MoreHorizontal size={16} aria-hidden />
      </button>
      {at && (
        <div className={styles.rowMenu} role="menu" aria-label={label} style={{ top: at.top, right: at.right }}>
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={`${styles.rowMenuItem} ${item.danger ? styles.rowMenuItemDanger : ""}`}
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
