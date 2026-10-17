"use client";

/**
 * The property a receipt or a piece of work is for, in bold just above Send, with Change (Kian's ruling 5 of
 * 2026-10-16). With none chosen yet it reads so, with Choose; after a Send with none, it says to choose one, in the
 * problem tone, and is the first problem shown.
 */

import styles from "./cleaner.module.css";

interface PropertyChoiceProps {
  /** The property chosen, by its name for cleaners; null when none is. */
  property: { name: string | null } | null;
  /** After a Send with no property. */
  problem: boolean;
  disabled: boolean;
  onChange: () => void;
}

export function PropertyChoice({ property, problem, disabled, onChange }: PropertyChoiceProps) {
  return (
    <div className={`${styles.sendTo} ${problem ? styles.sendToProblem : ""}`} data-problem={problem || undefined}>
      <p className={styles.sendToText}>
        <span className={styles.sendToLabel}>Property</span>
        {property ? (
          <strong className={styles.sendToName}>{property.name ?? "Unnamed property"}</strong>
        ) : (
          <span id="property-choice-none" className={styles.sendToNone}>
            {problem ? "Choose the property" : "Not chosen yet"}
          </span>
        )}
      </p>
      <button type="button" className={styles.sendToChange} onClick={onChange} disabled={disabled} aria-describedby={property ? undefined : "property-choice-none"}>
        {property ? "Change" : "Choose"}
      </button>
    </div>
  );
}
