"use client";

/**
 * Sent: a clear yes, what was sent, the way to the next receipt, and to the
 * receipts sent so far.
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
  onAnother,
  onMyReceipts,
  anotherLabel = "Log another receipt",
  listLabel = "See my receipts",
  tag,
}: {
  sent: SentReceipt;
  onAnother: () => void;
  onMyReceipts: () => void;
  anotherLabel?: string;
  listLabel?: string;
  tag?: string;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Announced on arrival.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <>
      <CleanerBar tag={tag} />
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
        <button type="button" className={styles.textButton} onClick={onMyReceipts}>
          {listLabel}
        </button>
        <div className={styles.bottomBar}>
          <button type="button" className={styles.primary} onClick={onAnother}>
            {anotherLabel}
          </button>
        </div>
      </main>
    </>
  );
}
