"use client";

/**
 * Choose the property, behind Change (or Choose, when none was prefilled) on a receipt or a piece of work (Kian's
 * ruling 5 of 2026-10-16): the unit list (UnitList), searchable, recent properties first, each with its cover photo.
 * Back returns to the receipt as it was.
 */

import type { CleanerProperty } from "@/app/lib/cleaners/model";
import styles from "./cleaner.module.css";
import { CleanerBar } from "./CleanerBar";
import { UnitList } from "./UnitList";

interface PropertyScreenProps {
  properties: CleanerProperty[];
  recentPropertyIds: string[];
  selectedId: string | null;
  onChoose: (property: CleanerProperty) => void;
  onBack: () => void;
}

export function PropertyScreen({ properties, recentPropertyIds, selectedId, onChoose, onBack }: PropertyScreenProps) {
  return (
    <>
      <CleanerBar onBack={onBack} />
      <main className={styles.screen}>
        <h1 className={styles.title}>Which property?</h1>
        <UnitList properties={properties} recentPropertyIds={recentPropertyIds} selectedId={selectedId} onChoose={onChoose} restLabel="All properties" />
      </main>
    </>
  );
}
