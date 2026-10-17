"use client";

/**
 * The home screen (Kian's rulings of 2026-10-16 and 2026-10-17): a cleaner's jobs for today and tomorrow, with Mark
 * cleaned; under them every unit, "All units", searchable, their recent units first (UnitList), where a tap starts a
 * receipt for that unit — a handyman's work; and one "Add a receipt" button ("Add work"). Mark cleaned is only on the
 * jobs they are on: a unit in the list has none. History is in the bar. No pay anywhere.
 *
 * The one button is pinned to the bottom of the screen, within reach of a thumb. A receipt or a piece of work begun
 * and not sent yet is kept on the phone; the button then reads "Finish the receipt" (or "Finish the work") and opens
 * it, with the property it is for named above it, so nothing typed is lost to a new one.
 */

import type { ReactNode } from "react";
import { Camera, Plus } from "lucide-react";
import type { CleanerProperty } from "@/app/lib/cleaners/model";
import styles from "./cleaner.module.css";
import { CleanerBar } from "./CleanerBar";
import { UnitList } from "./UnitList";

interface HomeScreenProps {
  cleanerName: string | null;
  /** The jobs (a cleaner's); nothing for a handyman. */
  jobs?: ReactNode;
  kind: "receipt" | "work";
  /** Every unit, and the ones this person logged against, most recent first. */
  properties: CleanerProperty[];
  recentPropertyIds: string[];
  /** A unit tapped in "All units": a receipt (or work) for it. */
  onUnit: (property: CleanerProperty) => void;
  /** A receipt or piece of work begun and not sent: what it is for, or null when there is none. */
  unsent: { propertyName: string | null } | null;
  onAdd: () => void;
  onHistory: () => void;
}

export function HomeScreen({ cleanerName, jobs, kind, properties, recentPropertyIds, onUnit, unsent, onAdd, onHistory }: HomeScreenProps) {
  const firstName = cleanerName?.trim().split(/\s+/)[0];
  const label = unsent ? (kind === "receipt" ? "Finish the receipt" : "Finish the work") : kind === "receipt" ? "Add a receipt" : "Add work";
  return (
    <>
      <CleanerBar
        actions={
          <button type="button" className={styles.barButton} onClick={onHistory}>
            History
          </button>
        }
      />
      <main className={styles.screen}>
        <p className={styles.greeting}>{firstName ? `Hi ${firstName}` : "Hi"}</p>
        {jobs}
        <section aria-labelledby="units-heading" className={styles.units}>
          <h2 id="units-heading" className={styles.sectionLabel}>
            All units
          </h2>
          <UnitList properties={properties} recentPropertyIds={recentPropertyIds} onChoose={onUnit} restLabel="Other units" />
        </section>
        <div className={`${styles.bottomBar} ${styles.pinnedBar}`}>
          {unsent && (
            <p className={styles.unsentNote} role="status">
              Not sent yet{unsent.propertyName ? ` · ${unsent.propertyName}` : ""}
            </p>
          )}
          <button type="button" className={styles.primary} onClick={onAdd}>
            {kind === "receipt" ? <Camera aria-hidden /> : <Plus aria-hidden />}
            <span>{label}</span>
          </button>
        </div>
      </main>
    </>
  );
}
