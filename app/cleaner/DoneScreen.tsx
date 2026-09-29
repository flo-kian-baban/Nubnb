"use client";

/**
 * Sent: a clear yes, what was sent, and the way to the next receipt.
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

export function DoneScreen({ sent, onAnother }: { sent: SentReceipt; onAnother: () => void }) {
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
      <div className={styles.bottomBar}>
        <button type="button" className={styles.primary} onClick={onAnother}>
          Log another receipt
        </button>
      </div>
    </main>
  );
}
