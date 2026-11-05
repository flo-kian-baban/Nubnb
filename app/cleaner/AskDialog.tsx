"use client";

/**
 * The app's own pop-up (Build 1 of 2026-11-02): a question, a few words, an optional box to type in, and two clear
 * buttons. Used by Done ("Confirm done" / "Cancel", with the note for the office, item 2), by Undo ("Undo Cleaned?",
 * item 4), by Sign out ("Sign out?", 2026-11-05), and wherever the app asked the browser's own confirm before. Modal:
 * the rest of the page is inert while it is open — the top bar and its tabs, the screen and its pinned bar, everything
 * in the document but the pop-up itself; Escape and the backdrop cancel; the first field or the confirm button takes
 * focus. Rendered at the end of the document (a portal), outside what it makes inert.
 */

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import styles from "./cleaner.module.css";

interface AskDialogProps {
  title: string;
  /** Under the title: the unit and day, or what the choice means. */
  words?: ReactNode;
  /** Something to type, between the words and the buttons. */
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** The confirm button's words while it is in flight: "Saving…" unless said ("Signing out…"). */
  busyLabel?: string;
  /** True while the confirm is in flight: the buttons wait. */
  busy?: boolean;
  /** The confirm button in the danger tone (Undo). */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function AskDialog({ title, words, children, confirmLabel, cancelLabel = "Cancel", busyLabel = "Saving…", busy = false, danger = false, onConfirm, onCancel }: AskDialogProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  // Focus moves in; Escape closes; the page behind cannot be reached: every other element at the top of the document
  // is inert while the pop-up is open (the bar and the tabs sit outside <main>, as does the pinned bar).
  useEffect(() => {
    const box = boxRef.current;
    const first = box?.querySelector<HTMLElement>("textarea, input, button");
    first?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    document.addEventListener("keydown", onKey);
    const behind = Array.from(document.body.children).filter((el) => el !== rootRef.current && !el.hasAttribute("inert"));
    for (const el of behind) el.setAttribute("inert", "");
    return () => {
      document.removeEventListener("keydown", onKey);
      for (const el of behind) el.removeAttribute("inert");
    };
  }, [busy, onCancel]);

  return createPortal(
    <div ref={rootRef} className={`${styles.app} ${styles.dialogBackdrop}`} onClick={() => !busy && onCancel()}>
      <div ref={boxRef} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="ask-title" onClick={(event) => event.stopPropagation()}>
        <h2 id="ask-title" className={styles.dialogTitle}>
          {title}
        </h2>
        {words && <div className={styles.dialogWords}>{words}</div>}
        {children}
        <div className={styles.dialogButtons}>
          <button type="button" className={`${styles.primary} ${danger ? styles.primaryDanger : ""}`} onClick={onConfirm} disabled={busy} aria-busy={busy || undefined}>
            {busy ? busyLabel : confirmLabel}
          </button>
          <button type="button" className={styles.secondary} onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
