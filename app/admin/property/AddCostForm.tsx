"use client";

/**
 * Log a cost from the office (dispatch 23D, Kian's ruling of 2026-09-30):
 * on a property's page, a description and an amount, optionally tax, with
 * no receipt. One call, POST /api/admin/cost-entries; the entry comes back
 * approved and marked `office`, and the page puts it in the month's costs
 * and in the statement preview. Nothing is optimistic: the list changes
 * only to what the server returns, and an answer that does not say whether
 * the write landed is reported as such, with Refresh rather than a second
 * send. On the property page since dispatch 23F.
 *
 * The form alone: the Costs tab opens it from the block's head, under it,
 * the way the Income tab opens a line's form (Kian, 2026-10-02).
 *
 * The month (dispatch 36, Kian's ruling of 2026-10-12): an office cost
 * belongs to a month the admin picks, the month on screen first, from
 * September 2026 to the current month. A cost for a month already finished
 * goes on the next statement, and the notice names the statement it went on.
 */

import { useState, type FormEvent } from "react";
import type { Notice } from "../components/Notice";
import { AdminSelect } from "../components/AdminSelect";
import { createOfficeEntry } from "@/app/lib/costs-client";
import { LIMITS, formatCents, type CostEntryView } from "@/app/lib/cleaners/model";
import { STATEMENTS_FROM_DEFAULT, addMonths, monthLabel, monthOfDay } from "@/app/lib/reports/model";
import { readAmount } from "../costs/cost-display";
import styles from "./page.module.css";

interface Props {
  propertyId: string;
  /** The month on screen: the month the cost is logged for unless the admin picks another. */
  month: string;
  /** Today, yyyy-mm-dd in Toronto: no month after this one can be picked. */
  today: string;
  /** The entry as the server stored it. */
  onAdded: (entry: CostEntryView) => void;
  onClose: () => void;
  show: (notice: Notice) => void;
}

export function AddCostForm({ propertyId, month, today, onAdded, onClose, show }: Props) {
  const thisMonth = monthOfDay(today);
  /** The months a cost can belong to, newest first: September 2026 to the current month. */
  const months: string[] = [];
  for (let m = thisMonth; m >= STATEMENTS_FROM_DEFAULT && months.length < 240; m = addMonths(m, -1)) months.push(m);
  const [forMonth, setForMonth] = useState(() => (month > thisMonth ? thisMonth : month < STATEMENTS_FROM_DEFAULT ? STATEMENTS_FROM_DEFAULT : month));
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [tax, setTax] = useState("");
  const [saving, setSaving] = useState(false);

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
      show({ tone: "error", title: "The cost was not logged.", items: problems });
      return;
    }
    setSaving(true);
    const result = await createOfficeEntry({ propertyId, description: text, amount: amountRead, tax: taxRead, month: forMonth });
    setSaving(false);
    if (result.ok) {
      const { entry, statementMonth } = result.data;
      onAdded(entry);
      onClose();
      const total = entry.linesNow.kind === "ok" ? formatCents(entry.linesNow.totalCents) : amountRead;
      // The statement it went on (Kian's ruling of 2026-10-12): its month's, or the next one's when that is finished.
      const goesOn =
        statementMonth === null
          ? "Its statement could not be looked up."
          : statementMonth === forMonth
            ? `It goes on ${monthLabel(forMonth)}'s statement.`
            : `${monthLabel(forMonth)} is finished: it goes on ${monthLabel(statementMonth)}'s statement.`;
      show({ tone: statementMonth === forMonth ? "success" : "info", title: `Logged ${total} for ${monthLabel(forMonth)}, approved.`, detail: `${goesOn} Marked as added by the office.` });
      return;
    }
    show(
      result.unknown
        ? { tone: "warning", title: "The cost may or may not have been recorded. Refresh before logging it again.", detail: result.title }
        : { tone: "error", title: result.title, detail: result.detail },
    );
  };

  return (
    <form className={styles.form} onSubmit={submit} aria-label="Log a cost">
      <p className={styles.formTitle}>Log a cost</p>
      <div className={styles.fields}>
        <label className={`${styles.field} ${styles.fieldGrow}`}>
          <span className={styles.fieldLabel}>Description</span>
          <input className={styles.textInput} value={description} maxLength={LIMITS.OFFICE_DESCRIPTION_MAX} placeholder="Plumber call-out, kitchen sink" onChange={(e) => setDescription(e.target.value)} disabled={saving} autoFocus />
        </label>
        <label className={`${styles.field} ${styles.fieldAmount}`}>
          <span className={styles.fieldLabel}>Amount ($)</span>
          <input className={`${styles.textInput} ${styles.amountInput}`} inputMode="decimal" placeholder="185.00" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={saving} />
        </label>
        <label className={`${styles.field} ${styles.fieldAmount}`}>
          <span className={styles.fieldLabel}>Tax ($, optional)</span>
          <input className={`${styles.textInput} ${styles.amountInput}`} inputMode="decimal" placeholder="0.00" value={tax} onChange={(e) => setTax(e.target.value)} disabled={saving} />
        </label>
        <div className={`${styles.field} ${styles.fieldAmount}`}>
          <span className={styles.fieldLabel}>For the month</span>
          <AdminSelect label="For the month" value={forMonth} onChange={setForMonth} disabled={saving} groups={[{ options: months.map((m) => ({ value: m, label: monthLabel(m) })) }]} />
        </div>
      </div>
      <div className={styles.formActions}>
        <button type="submit" className={styles.btnPrimary} disabled={saving}>
          {saving ? "Logging…" : "Log and approve"}
        </button>
        <button type="button" className={styles.btnGhost} disabled={saving} onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}
