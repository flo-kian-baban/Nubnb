"use client";

/**
 * The home screen (Kian's rulings of 2026-10-16 and 2026-10-17, rebuilt to his rulings of 2026-11-02, Build 1 of the
 * UX audit): a control centre with nothing to think about.
 *
 * At the top (Kian's instruction of 2026-11-05): the NUBNB logo, the person's first name with a small chevron that
 * opens Sign out, and the two tabs under it — "Jobs | History" for a cleaner, "Add work | My work" for a handyman
 * (CleanerBar). Nothing at the page's foot: the list starts under the tabs and ends above the pinned bar.
 *
 * A cleaner: their jobs (JobsSection), today then tomorrow, each card with Done and Add receipt, or one calm line, "No
 * jobs right now." One pinned button, "All properties", opens the full list for a receipt on any unit (item 1); it is
 * the light button (white, a hairline border, dark words), so Done stays the only filled one on the screen. A receipt
 * begun and not sent turns it into "Finish the receipt", with the unit it is for named above it, so nothing typed is
 * lost to a new one. No greeting, no unit list on the home.
 *
 * A handyman (item 9): "Add work" pinned, his recent units (up to five; a tap starts work for that unit), "All
 * properties" with search behind one light button. The bar never covers a card: the screen is padded by the bar's
 * measured height (usePinnedHeight).
 */

import type { ReactNode } from "react";
import { Camera, List, Plus } from "lucide-react";
import type { CleanerProperty } from "@/app/lib/cleaners/model";
import styles from "./cleaner.module.css";
import { CleanerBar, type BarPerson, type BarTab } from "./CleanerBar";
import { UnitRow } from "./UnitList";
import { usePinnedHeight } from "./usePinnedHeight";

interface HomeScreenProps {
  kind: "receipt" | "work";
  /** Who is signed in, for the name menu (Sign out). */
  person: BarPerson;
  /** The two tabs under the bar: Jobs | History, or Add work | My work. */
  tabs: readonly BarTab[];
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
}

export function HomeScreen({ kind, person, tabs, jobs, recent, unsent, onAdd, onAllProperties, onDiscard }: HomeScreenProps) {
  const [barRef, barHeight] = usePinnedHeight();
  const label = unsent ? (kind === "receipt" ? "Finish the receipt" : "Finish the work") : kind === "receipt" ? "All properties" : "Add work";
  const icon = unsent ? kind === "receipt" ? <Camera aria-hidden /> : <Plus aria-hidden /> : kind === "receipt" ? <List aria-hidden /> : <Plus aria-hidden />;
  return (
    <>
      <CleanerBar person={person} tabs={tabs} />
      <main className={`${styles.screen} ${styles.screenUnderTabs}`} style={{ paddingBottom: barHeight + 16 }}>
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
              <button type="button" className={styles.light} onClick={onAllProperties}>
                <List aria-hidden />
                <span>All properties</span>
              </button>
            )}
          </section>
        )}
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
          {/* A cleaner's pinned button is the light one, so Done stays the only filled button on the screen; a handyman's Add work stays filled. */}
          <button type="button" className={kind === "receipt" ? styles.light : styles.primary} onClick={onAdd}>
            {icon}
            <span>{label}</span>
          </button>
        </div>
      </div>
    </>
  );
}
