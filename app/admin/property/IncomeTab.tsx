"use client";

/**
 * The Income tab (dispatch 23F): the month's lines, as the statement editor
 * had them (dispatch 23E). A line is a description, its dates, a quantity
 * and a rate; the amount is quantity × rate (Kian's ruling of 2026-10-01),
 * computed and shown. A line with a negative rate is an expense. Lines are
 * ordered with ↑ ↓, removed with a confirm when they hold anything, and
 * added with Add line. Every change saves the draft 800 ms later, through
 * the page; the first change on a month with nothing stored creates it.
 *
 * A finished month shows the frozen lines, disabled.
 */

import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { DateRangeField } from "../components/DateRangeField";
import { formatCents } from "@/app/lib/cleaners/model";
import { STATEMENT_LIMITS, lineAmount, rangeText } from "@/app/lib/reports/model";
import { lineDetailsText } from "@/app/lib/reports/statement";
import { readAmount } from "../costs/cost-display";
import { centsOf, newId, readQuantity, type LineDraft, type Typed } from "./statement-form";
import styles from "./page.module.css";

interface Props {
  typed: Typed;
  readOnly: boolean;
  /** The revenue and the typed expenses, as the statement adds them up; null when it cannot be built. */
  sums: { incomeCents: number; expensesCents: number } | null;
  onChange: (next: Typed) => void;
}

export function IncomeTab({ typed, readOnly, sums, onChange }: Props) {
  const setLine = (id: string, patch: Partial<LineDraft>) => onChange({ ...typed, lines: typed.lines.map((line) => (line.id === id ? { ...line, ...patch } : line)) });
  const move = (index: number, by: -1 | 1) => {
    const lines = [...typed.lines];
    const [line] = lines.splice(index, 1);
    lines.splice(index + by, 0, line);
    onChange({ ...typed, lines });
  };
  const removeLine = (line: LineDraft) => {
    if ((line.description.trim() || line.rate.trim()) && !window.confirm("Remove this line?")) return;
    onChange({ ...typed, lines: typed.lines.filter((l) => l.id !== line.id) });
  };
  const addLine = () => onChange({ ...typed, lines: [...typed.lines, { id: newId(), description: "", from: "", to: "", quantity: "1", rate: "" }] });

  return (
    <section className={`${styles.block} ${styles.linesBlock}`} aria-label="Income lines">
      <div className={styles.blockHead}>
        <h3 className={styles.blockTitle}>Lines</h3>
        <span className={styles.blockTotal}>{sums ? `${formatCents(sums.incomeCents)} revenue · ${formatCents(-sums.expensesCents)} expenses` : "—"}</span>
      </div>
      {typed.lines.length > 0 && (
        <div className={styles.lineHead} aria-hidden>
          <span />
          <span>Description</span>
          <span className={styles.num}>Qty</span>
          <span className={styles.num}>Rate</span>
          <span className={styles.num}>Amount</span>
          <span />
        </div>
      )}
      {typed.lines.map((line, i) => {
        const rate = readAmount(line.rate);
        const quantity = readQuantity(line.quantity);
        const amount = rate !== null && quantity !== null ? lineAmount(quantity, centsOf(rate)) : null;
        const details = line.details ? lineDetailsText({ source: line.details.source, reference: line.details.reference ?? null }) : "";
        return (
          <div key={line.id} className={styles.lineRow}>
            <div className={styles.orderButtons}>
              <button type="button" aria-label="Move up" disabled={readOnly || i === 0} onClick={() => move(i, -1)}>
                <ArrowUp size={12} aria-hidden />
              </button>
              <button type="button" aria-label="Move down" disabled={readOnly || i === typed.lines.length - 1} onClick={() => move(i, 1)}>
                <ArrowDown size={12} aria-hidden />
              </button>
            </div>
            <input
              className={`${styles.textInput} ${!readOnly && line.description.trim() === "" ? styles.inputInvalid : ""}`}
              placeholder="Revenue, or Expense - Cleaning"
              value={line.description}
              maxLength={STATEMENT_LIMITS.LINE_DESCRIPTION_MAX}
              disabled={readOnly}
              onChange={(e) => setLine(line.id, { description: e.target.value })}
              aria-label={`Line ${i + 1} description`}
            />
            {readOnly ? (
              <span className={styles.lineDates}>{line.from || line.to ? rangeText(line.from || null, line.to || null) : <span className={styles.muted}>No dates</span>}</span>
            ) : (
              <DateRangeField label={`Line ${i + 1} dates`} from={line.from} to={line.to} onChange={(range) => setLine(line.id, { from: range.from, to: range.to })} emptyText="Add dates" className={styles.lineDates} />
            )}
            <input
              className={`${styles.textInput} ${styles.amountInput} ${!readOnly && quantity === null ? styles.inputInvalid : ""}`}
              inputMode="numeric"
              value={line.quantity}
              disabled={readOnly}
              onChange={(e) => setLine(line.id, { quantity: e.target.value })}
              aria-label={`Line ${i + 1} quantity`}
            />
            <input
              className={`${styles.textInput} ${styles.amountInput} ${!readOnly && (rate === null || rate === "0.00") ? styles.inputInvalid : ""}`}
              placeholder="0.00"
              inputMode="decimal"
              value={line.rate}
              disabled={readOnly}
              onChange={(e) => setLine(line.id, { rate: e.target.value })}
              onBlur={() => {
                const read = readAmount(line.rate);
                if (read && read !== line.rate) setLine(line.id, { rate: read });
              }}
              aria-label={`Line ${i + 1} rate`}
            />
            <span className={`${styles.num} ${styles.lineAmount}`} aria-label={`Line ${i + 1} amount`}>
              {amount === null ? "—" : formatCents(amount)}
            </span>
            <button type="button" className={styles.removeBtn} aria-label={`Remove line ${i + 1}`} disabled={readOnly} onClick={() => removeLine(line)}>
              <Trash2 size={14} aria-hidden />
            </button>
            {details !== "" && (
              <p className={styles.lineDetails} title="Recorded with this line before; kept as it is">
                {details} <span className={styles.muted}>· recorded before</span>
              </p>
            )}
          </div>
        );
      })}
      {typed.lines.length === 0 && <p className={styles.note}>No lines yet.</p>}
      {!readOnly && (
        <button type="button" className={`${styles.btnGhost} ${styles.btnSmall} ${styles.addLine}`} onClick={addLine} disabled={typed.lines.length >= STATEMENT_LIMITS.LINES_MAX}>
          <Plus size={13} aria-hidden />
          <span>Add line</span>
        </button>
      )}
    </section>
  );
}
