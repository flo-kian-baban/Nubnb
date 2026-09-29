"use client";

/**
 * Sent: a clear yes, what was sent, the way to the next receipt, and to the
 * receipts sent so far.
 */

import { useEffect, useRef } from "react";
import { Check } from "lucide-react";
import { formatCents } from "@/app/lib/cleaners/model";
import styles from "./cleaner.module.css";

export interface SentReceipt {
  propertyName: string;
  lineCount: number;
  totalCents: number;
}

export function DoneScreen({
  sent,
  onAnother,
  onMyReceipts,
}: {
  sent: SentReceipt;
  onAnother: () => void;
  onMyReceipts: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Announced on arrival.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <main className={`${styles.screen} ${styles.doneScreen}`}>
      <div className={styles.doneIcon} aria-hidden>
        <Check />
      </div>
      <h1 ref={headingRef} tabIndex={-1} className={styles.doneTitle}>
        Sent
      </h1>
      <p className={styles.doneProperty}>{sent.propertyName}</p>
      <p className={styles.doneSummary}>
        {sent.lineCount === 1 ? "1 item" : `${sent.lineCount} items`} · {formatCents(sent.totalCents)}
      </p>
      <button type="button" className={styles.textButton} onClick={onMyReceipts}>
        See my receipts
      </button>
      <div className={styles.bottomBar}>
        <button type="button" className={styles.primary} onClick={onAnother}>
          Log another receipt
        </button>
      </div>
    </main>
  );
}
