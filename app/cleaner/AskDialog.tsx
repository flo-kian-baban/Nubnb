"use client";

/**
 * The app's own pop-up (Build 1 of 2026-11-02): a question, a few words, an optional box to type in, and two clear
 * buttons. Used by Done ("Confirm done" / "Cancel", with the note for the office, item 2), by Undo ("Undo Cleaned?",
 * item 4), and wherever the app asked the browser's own confirm before. Modal: the rest of the page is inert while
 * it is open; Escape and the backdrop cancel; the first field or the confirm button takes focus. Rendered at the end of
 * the document (a portal), outside the inert main.
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
  /** True while the confirm is in flight: the buttons wait. */
  busy?: boolean;
  /** The confirm button in the danger tone (Undo). */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function AskDialog({ title, words, children, confirmLabel, cancelLabel = "Cancel", busy = false, danger = false, onConfirm, onCancel }: AskDialogProps) {
  const boxRef = useRef<HTMLDivElement>(null);

  // Focus moves in; Escape closes; the page behind cannot be reached.
  useEffect(() => {
    const box = boxRef.current;
    const first = box?.querySelector<HTMLElement>("textarea, input, button");
    first?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    document.addEventListener("keydown", onKey);
    const main = document.querySelector("main");
    main?.setAttribute("inert", "");
    return () => {
      document.removeEventListener("keydown", onKey);
      main?.removeAttribute("inert");
    };
  }, [busy, onCancel]);

  return createPortal(
    <div className={`${styles.app} ${styles.dialogBackdrop}`} onClick={() => !busy && onCancel()}>
      <div ref={boxRef} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="ask-title" onClick={(event) => event.stopPropagation()}>
        <h2 id="ask-title" className={styles.dialogTitle}>
          {title}
        </h2>
        {words && <div className={styles.dialogWords}>{words}</div>}
        {children}
        <div className={styles.dialogButtons}>
          <button type="button" className={`${styles.primary} ${danger ? styles.primaryDanger : ""}`} onClick={onConfirm} disabled={busy} aria-busy={busy || undefined}>
            {busy ? "Saving…" : confirmLabel}
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
