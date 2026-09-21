"use client";

/**
 * Route-level error boundary.
 *
 * This is where a failed server read surfaces. The listing pages deliberately
 * throw rather than rendering an empty catalogue (see server-properties.ts),
 * so "we could not load the data" reaches the visitor as an error with a
 * retry — never as "No properties found", which claims the business has no
 * inventory.
 *
 * `reset()` re-renders the segment, which re-runs the server read. On a
 * transient Firestore failure that is a real retry, not a cosmetic one.
 */

import { useEffect } from "react";
import { WifiOff, RefreshCw } from "lucide-react";
import styles from "./page.module.css";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[route error]", error);
  }, [error]);

  return (
    <main className={styles.errorPage}>
      <div className={styles.errorCard}>
        <div className={styles.errorIconWrap}>
          <WifiOff size={32} strokeWidth={1.5} />
        </div>
        <h1 className={styles.errorTitle}>Something went wrong</h1>
        <p className={styles.errorMessage}>
          We couldn&apos;t load this page right now. Please try again in a moment.
        </p>
        <button className={styles.errorRetry} onClick={reset}>
          <RefreshCw size={16} />
          Try again
        </button>
      </div>
    </main>
  );
}
