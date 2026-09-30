"use client";

/**
 * The bar at the top of every screen (2026-09-30): white with a hairline
 * under it, the NUBNB wordmark in the brand's navy blue (not a dark band:
 * Kian's word), so a cleaner always sees whose app this is. On the property screen it carries the two ways out of
 * the flow, as pills; on a step into the flow it carries Back and the
 * property's name instead. The same simplicity as the bar it replaces, with
 * the brand's wordmark and blue. Styles in cleaner.module.css (".bar…").
 */

import type { ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import styles from "./cleaner.module.css";

interface CleanerBarProps {
  /** Back, when the screen is a step into the flow; the wordmark otherwise. */
  onBack?: () => void;
  backDisabled?: boolean;
  /** The property's name on a step, at the right. */
  title?: string;
  /** Buttons at the right, on the property screen. */
  actions?: ReactNode;
}

export function CleanerBar({ onBack, backDisabled, title, actions }: CleanerBarProps) {
  return (
    <header className={styles.bar}>
      <div className={styles.barInner}>
        {onBack ? (
          <button type="button" className={styles.barBack} onClick={onBack} disabled={backDisabled}>
            <ChevronLeft aria-hidden />
            <span>Back</span>
          </button>
        ) : (
          <p className={styles.barBrand}>
            <span className={styles.barWordmark}>NUBNB</span>
            <span className={styles.barTag}>Receipts</span>
          </p>
        )}
        {title ? <p className={styles.barTitle}>{title}</p> : actions ? <div className={styles.barActions}>{actions}</div> : null}
      </div>
    </header>
  );
}
