"use client";

/**
 * Asking before an action, in Nubnb's own dialog (Kian's ruling of
 * 2026-10-12: no native browser dialogs anywhere in the admin). `useAsk`
 * gives `ask(question)`, a promise of the admin's answer, and the dialog to
 * render; a page renders `dialog` once, anywhere. A question is a title, its
 * lines, and the words of the button that goes ahead; Escape, the × and the
 * other button answer no. The keyboard starts on the button that does
 * nothing.
 *
 * The dialog is the property pages' own (`editor/controls.tsx`), so every
 * question in the admin looks and behaves the same.
 */

import { useCallback, useState, type ReactNode } from "react";
import { Dialog } from "../property/editor/controls";
import ed from "../property/editor/editor.module.css";

export interface Question {
  title: string;
  /** Paragraphs under the title; null and empty ones are left out. */
  lines?: (string | null | undefined)[];
  /** The button that goes ahead: "Delete entry", "Download anyway". */
  confirm: string;
  /** The button that does nothing: "Cancel" unless given. */
  cancel?: string;
  /** Whether going ahead loses something: the button reads in the danger tone. */
  danger?: boolean;
}

export function useAsk(): { ask: (question: Question) => Promise<boolean>; dialog: ReactNode } {
  const [open, setOpen] = useState<{ question: Question; resolve: (yes: boolean) => void } | null>(null);
  const ask = useCallback((question: Question) => new Promise<boolean>((resolve) => setOpen({ question, resolve })), []);
  const answer = (yes: boolean) => {
    open?.resolve(yes);
    setOpen(null);
  };
  const dialog = open ? (
    <Dialog
      title={open.question.title}
      onClose={() => answer(false)}
      actions={
        <>
          <button type="button" className={`${ed.btn} ${ed.btnGhost}`} onClick={() => answer(false)}>
            {open.question.cancel ?? "Cancel"}
          </button>
          <button type="button" className={`${ed.btn} ${open.question.danger ? `${ed.btnGhost} ${ed.btnDanger}` : ed.btnPrimary}`} onClick={() => answer(true)}>
            {open.question.confirm}
          </button>
        </>
      }
    >
      {(open.question.lines ?? []).filter((line): line is string => typeof line === "string" && line.trim() !== "").map((line, i) => (
        <p key={i}>{line}</p>
      ))}
    </Dialog>
  ) : null;
  return { ask, dialog };
}
