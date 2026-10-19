"use client";

/**
 * The question asked before deactivating or deleting a team member who is the regular cleaner for one or more
 * properties (Kian's ruling K4 of 2026-10-19, in CLAUDE.md under *Team page*): the same dialog lists those properties,
 * each with a picker — another active cleaner, or "Nobody" — and saving applies the replacements together with the
 * deactivation or delete, recorded in each property's regular-cleaner history. Existing jobs follow Schedule round 1's
 * rules unchanged: the person comes off the jobs they have not marked, and nobody is put on them in their place.
 *
 * Nubnb's own dialog (Kian's ruling of 2026-10-12: no native browser dialogs in the admin), the property pages' Dialog
 * with AdminSelect pickers; Escape, the × and Cancel answer no. The pickers start on "Nobody", which is what happens
 * without a choice (R5: a deactivated or deleted regular cleaner assigns nobody).
 */

import { useState } from "react";
import { Dialog } from "../property/editor/controls";
import { AdminSelect } from "../components/AdminSelect";
import type { RegularProperty, RegularReplacements } from "@/app/lib/cleaners-client";
import ed from "../property/editor/editor.module.css";
import styles from "./page.module.css";

export interface ReplaceRegularProps {
  title: string;
  /** The paragraphs above the pickers: what deactivating or deleting does, the jobs they come off. */
  lines: (string | null)[];
  /** The properties they are the regular cleaner for. */
  properties: RegularProperty[];
  /** The active cleaners a property can go to, the person leaving left out. */
  choices: { id: string; name: string | null }[];
  confirm: string;
  danger?: boolean;
  /** The replacements chosen (null for Nobody), or null when the admin did not go ahead. */
  onAnswer: (replacements: RegularReplacements | null) => void;
}

export function ReplaceRegularDialog({ title, lines, properties, choices, confirm, danger, onAnswer }: ReplaceRegularProps) {
  const [picked, setPicked] = useState<Record<string, string>>(() => Object.fromEntries(properties.map((p) => [p.propertyId, ""])));
  const options = [{ value: "", label: "Nobody" }, ...choices.map((c) => ({ value: c.id, label: c.name?.trim() || "Unnamed cleaner" }))];
  const answer = () => onAnswer(Object.fromEntries(properties.map((p) => [p.propertyId, picked[p.propertyId] === "" ? null : picked[p.propertyId]])));
  return (
    <Dialog
      title={title}
      onClose={() => onAnswer(null)}
      initialFocus="none"
      actions={
        <>
          <button type="button" className={`${ed.btn} ${ed.btnGhost}`} onClick={() => onAnswer(null)}>
            Cancel
          </button>
          <button type="button" className={`${ed.btn} ${danger ? `${ed.btnGhost} ${ed.btnDanger}` : ed.btnPrimary}`} onClick={answer}>
            {confirm}
          </button>
        </>
      }
    >
      <div className={styles.replaceBody}>
        {lines.filter((line): line is string => typeof line === "string" && line.trim() !== "").map((line, i) => (
          <p key={i}>{line}</p>
        ))}
        <p>
          They are the regular cleaner for {properties.length === 1 ? "1 property" : `${properties.length} properties`}. Choose who new jobs there go to: another cleaner, or nobody. Jobs already made are not changed.
        </p>
        <ul className={styles.replaceList} aria-label="Regular cleaner replacements">
          {properties.map((p) => (
            <li key={p.propertyId} className={styles.replaceRow}>
              <span className={styles.replaceProperty}>{p.name}</span>
              <AdminSelect label={`New regular cleaner for ${p.name}`} value={picked[p.propertyId] ?? ""} onChange={(value) => setPicked((was) => ({ ...was, [p.propertyId]: value }))} groups={[{ options }]} className={styles.replaceSelect} />
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}
