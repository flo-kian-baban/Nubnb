"use client";

/**
 * The home screen (Kian's rulings of 2026-10-16 and 2026-10-17, rebuilt to his rulings of 2026-11-02, Build 1 of the
 * UX audit): a control centre with nothing to think about.
 *
 * A cleaner: their jobs first (JobsSection), today then tomorrow, each card with Done and Add receipt; then the foot,
 * "Signed in as <name> · Sign out" (item 5). One pinned button, "All properties", opens the full list for a receipt on
 * any unit (item 1); a receipt begun and not sent turns it into "Finish the receipt", with the unit it is for named
 * above it, so nothing typed is lost to a new one. No greeting, no unit list on the home.
 *
 * A handyman (item 9): "Add work" pinned, his recent units (up to five; a tap starts work for that unit), "All
 * properties" with search behind one button, and "My work" on the bar. The bar never covers a card: the screen is
 * padded by the bar's measured height (usePinnedHeight).
 */

import type { ReactNode } from "react";
import { Camera, List, Plus } from "lucide-react";
import type { CleanerProperty } from "@/app/lib/cleaners/model";
import styles from "./cleaner.module.css";
import { CleanerBar } from "./CleanerBar";
import { UnitRow } from "./UnitList";
import { usePinnedHeight } from "./usePinnedHeight";

interface HomeScreenProps {
  cleanerName: string | null;
  kind: "receipt" | "work";
  /** The jobs (a cleaner's); nothing for a handyman. */
  jobs?: ReactNode;
  /** A handyman's recent units, most recent first, already cut to five; a tap starts work for that unit. */
  recent?: { properties: CleanerProperty[]; onUnit: (property: CleanerProperty) => void };
  /** A receipt or piece of work begun and not sent: what it is for, or null when there is none. */
  unsent: { propertyName: string | null } | null;
  /** The pinned button: "Finish the receipt" / "Finish the work" when something is unsent, else "All properties" (a cleaner) or "Add work" (a handyman). */
  onAdd: () => void;
  /** "All properties", a handyman's second way to the one list; a cleaner's is the pinned button. */
  onAllProperties?: () => void;
  /** Discard the unsent work (a handyman's form has no Start over). */
  onDiscard?: () => void;
  onHistory: () => void;
  onSignOut: () => void;
  signingOut: boolean;
}

export function HomeScreen({ cleanerName, kind, jobs, recent, unsent, onAdd, onAllProperties, onDiscard, onHistory, onSignOut, signingOut }: HomeScreenProps) {
  const [barRef, barHeight] = usePinnedHeight();
  const name = cleanerName?.trim() || null;
  const label = unsent ? (kind === "receipt" ? "Finish the receipt" : "Finish the work") : kind === "receipt" ? "All properties" : "Add work";
  const icon = unsent ? kind === "receipt" ? <Camera aria-hidden /> : <Plus aria-hidden /> : kind === "receipt" ? <List aria-hidden /> : <Plus aria-hidden />;
  return (
    <>
      <CleanerBar
        actions={
          <button type="button" className={styles.barButton} onClick={onHistory}>
            {kind === "receipt" ? "History" : "My work"}
          </button>
        }
      />
      <main className={styles.screen} style={{ paddingBottom: barHeight + 16 }}>
        {jobs}
        {recent && (
          <section aria-labelledby="recent-heading" className={styles.recent}>
            <h2 id="recent-heading" className={styles.groupHead}>
              Recent
            </h2>
            {recent.properties.length === 0 ? (
              <p className={styles.jobsEmpty}>No work sent yet. Add work to start.</p>
            ) : (
              <ul className={styles.propertyList}>
                {recent.properties.map((property) => (
                  <UnitRow key={property.id} property={property} icon="recent" onChoose={recent.onUnit} />
                ))}
              </ul>
            )}
            {onAllProperties && (
              <button type="button" className={styles.secondary} onClick={onAllProperties}>
                <List aria-hidden />
                <span>All properties</span>
              </button>
            )}
          </section>
        )}
        <footer className={styles.foot}>
          <span className={styles.footWho}>{name ? `Signed in as ${name}` : "Signed in"}</span>
          <button type="button" className={styles.signOut} onClick={onSignOut} disabled={signingOut}>
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </footer>
      </main>
      <div ref={barRef} className={styles.pinnedFixed}>
        <div className={styles.pinnedInner}>
          {unsent && (
            <p className={styles.unsentNote} role="status">
              <span>Not sent yet{unsent.propertyName ? ` · ${unsent.propertyName}` : ""}</span>
              {onDiscard && (
                <button type="button" className={styles.unsentDiscard} onClick={onDiscard}>
                  Discard
                </button>
              )}
            </p>
          )}
          <button type="button" className={styles.primary} onClick={onAdd}>
            {icon}
            <span>{label}</span>
          </button>
        </div>
      </div>
    </>
  );
}
