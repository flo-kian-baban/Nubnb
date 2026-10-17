"use client";

/**
 * Sent: a clear yes, what was sent, Done back to the home screen, and the way
 * to the next receipt (or piece of work) straight away. History is on the
 * home screen's bar.
 */

import { useEffect, useRef } from "react";
import { Check } from "lucide-react";
import { formatCents } from "@/app/lib/cleaners/model";
import styles from "./cleaner.module.css";
import { CleanerBar } from "./CleanerBar";

export interface SentReceipt {
  propertyName: string;
  lineCount: number;
  totalCents: number;
  /** `work` for a handyman's entry (dispatch 24); a receipt otherwise. */
  kind?: "receipt" | "work";
}

export function DoneScreen({
  sent,
  onDone,
  onAnother,
  anotherLabel = "Add another receipt",
}: {
  sent: SentReceipt;
  onDone: () => void;
  onAnother: () => void;
  anotherLabel?: string;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Announced on arrival.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <>
      <CleanerBar />
      <main className={`${styles.screen} ${styles.doneScreen}`}>
        <div className={styles.doneIcon} aria-hidden>
          <Check />
        </div>
        <h1 ref={headingRef} tabIndex={-1} className={styles.doneTitle}>
          Sent
        </h1>
        <p className={styles.doneProperty}>{sent.propertyName}</p>
        <p className={styles.doneSummary}>
          {sent.kind === "work" ? "Work" : sent.lineCount === 1 ? "1 item" : `${sent.lineCount} items`} · {formatCents(sent.totalCents)}
        </p>
        {sent.kind === "work" && <p className={styles.doneNote}>It waits for the office to approve it.</p>}
        <button type="button" className={styles.textButton} onClick={onAnother}>
          {anotherLabel}
        </button>
        <div className={`${styles.bottomBar} ${styles.pinnedBar}`}>
          <button type="button" className={styles.primary} onClick={onDone}>
            Done
          </button>
        </div>
      </main>
    </>
  );
}
