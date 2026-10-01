"use client";

/**
 * Add a cost from the office (dispatch 23D, Kian's ruling of 2026-09-30):
 * on a property's page, a description and an amount, optionally tax, with
 * no receipt. One call, POST /api/admin/cost-entries; the entry comes back
 * approved and marked `office`, and the page puts it in the ledger and
 * opens it. Nothing is optimistic: the list changes only to what the server
 * returns, and an answer that does not say whether the write landed is
 * reported as such, with Refresh rather than a second send.
 */

import { useState, type FormEvent } from "react";
import { Plus } from "lucide-react";
import type { Notice } from "../components/Notice";
import { createOfficeEntry } from "@/app/lib/costs-client";
import { LIMITS, formatCents, type CostEntryView } from "@/app/lib/cleaners/model";
import { readAmount } from "./cost-display";
import styles from "./page.module.css";

interface Props {
  propertyId: string;
  propertyName: string;
  /** The entry as the server stored it. */
  onAdded: (entry: CostEntryView) => void;
  show: (notice: Notice) => void;
}

export function AddCostForm({ propertyId, propertyName, onAdded, show }: Props) {
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [tax, setTax] = useState("");
  const [saving, setSaving] = useState(false);

  const close = () => {
    setOpen(false);
    setDescription("");
    setAmount("");
    setTax("");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const text = description.normalize("NFC").replace(/\s+/g, " ").trim();
    const amountRead = readAmount(amount);
    const taxRead = tax.trim() === "" ? null : readAmount(tax);
    const problems = [
      text === "" ? "Describe the cost." : null,
      amountRead === null || amountRead.startsWith("-") || amountRead === "0.00" ? "Check the amount: dollars and cents above $0.00, like 185.00." : null,
      tax.trim() !== "" && (taxRead === null || taxRead.startsWith("-")) ? "Check the tax: dollars and cents, like 12.50, or leave it empty." : null,
    ].filter((problem): problem is string => problem !== null);
    if (problems.length > 0 || amountRead === null) {
      show({ tone: "error", title: "The cost was not added.", items: problems });
      return;
    }
    setSaving(true);
    const result = await createOfficeEntry({ propertyId, description: text, amount: amountRead, tax: taxRead });
    setSaving(false);
    if (result.ok) {
      const { entry } = result.data;
      onAdded(entry);
      close();
      const total = entry.linesNow.kind === "ok" ? formatCents(entry.linesNow.totalCents) : amountRead;
      show({ tone: "success", title: `Added ${total}, approved.`, detail: "Marked as added by the office." });
      return;
    }
    show(
      result.unknown
        ? { tone: "warning", title: "The cost may or may not have been recorded. Refresh the ledger before adding it again.", detail: result.title }
        : { tone: "error", title: result.title, detail: result.detail },
    );
  };

  if (!open) {
    return (
      <button type="button" className={styles.btnApprove} onClick={() => setOpen(true)}>
        <Plus size={15} aria-hidden />
        <span>Add a cost</span>
      </button>
    );
  }

  return (
    <form className={`${styles.inlineForm} ${styles.addCost}`} onSubmit={submit} aria-label="Add a cost">
      <p className={styles.editorTitle}>Add a cost · {propertyName}</p>
      <div className={styles.editorGrid}>
        <label className={styles.editorField}>
          <span className={styles.fieldLabel}>Description</span>
          <input
            className={styles.textInput}
            value={description}
            maxLength={LIMITS.OFFICE_DESCRIPTION_MAX}
            placeholder="e.g. Plumber call-out, kitchen sink"
            onChange={(e) => setDescription(e.target.value)}
            disabled={saving}
            autoFocus
          />
        </label>
        <label className={styles.editorField}>
          <span className={styles.fieldLabel}>Amount ($)</span>
          <input className={styles.textInput} inputMode="decimal" placeholder="185.00" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={saving} />
        </label>
        <label className={styles.editorField}>
          <span className={styles.fieldLabel}>Tax ($, optional)</span>
          <input className={styles.textInput} inputMode="decimal" placeholder="none" value={tax} onChange={(e) => setTax(e.target.value)} disabled={saving} />
        </label>
      </div>
      <div className={styles.formRow}>
        <button type="submit" className={styles.btnApprove} disabled={saving}>
          {saving ? "Adding…" : "Add and approve"}
        </button>
        <button type="button" className={styles.btnGhost} disabled={saving} onClick={close}>
          Cancel
        </button>
      </div>
    </form>
  );
}
