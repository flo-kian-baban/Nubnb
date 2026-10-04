"use client";

/**
 * The Income tab (dispatch 23F): the month's lines, as the statement prints
 * them. A line is a description, its dates, a quantity and a rate; the
 * amount is quantity × rate (Kian's ruling of 2026-10-01), computed and
 * shown. A line with a negative rate is an expense.
 *
 * Asked the way the Costs tab asks for a cost (Kian, 2026-10-02): the one
 * action in the block's head, "Add a line", opens a labelled form under it;
 * the lines are a table like the month's costs, and a click on a line opens
 * the same form on it, with Save line and Remove line. A line goes into the
 * draft when the form is submitted, and the draft saves itself 800 ms later
 * through the page; the first line on a month with nothing stored creates
 * it. ↑ ↓ on each row keep the admin's order.
 *
 * A finished month shows the frozen lines, with no form.
 *
 * Lines from the platforms' files (dispatch 27): a line an admin accepted on
 * the Income page is an ordinary line of the draft, marked here with its file
 * and row; the month's lines still waiting there are counted, with the way
 * to them. The Income page reads the same draft.
 */

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, Plus } from "lucide-react";
import type { Notice } from "../components/Notice";
import { DateRangeField } from "../components/DateRangeField";
import { formatCents } from "@/app/lib/cleaners/model";
import { STATEMENT_LIMITS, isDayText, lineAmount, rangeText } from "@/app/lib/reports/model";
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
  show: (notice: Notice) => void;
  /** The month's lines from the platforms' files: each accepted line's file and row, by line id; how many wait on the Income page; whether they could be read. */
  files?: { marks: Map<string, string>; pending: number; failed: boolean; month: string };
}

/** The form's fields: the line being added (id null) or corrected (its id), as typed so far. */
interface Editing {
  id: string | null;
  description: string;
  from: string;
  to: string;
  quantity: string;
  rate: string;
}

/** A line's figures as typed: null where a field does not read. */
function figuresOf(line: Pick<LineDraft, "quantity" | "rate">) {
  const rate = readAmount(line.rate);
  const quantity = readQuantity(line.quantity);
  const rateCents = rate === null || rate === "0.00" ? null : centsOf(rate);
  return { quantity, rateCents, amountCents: rateCents !== null && quantity !== null ? lineAmount(quantity, rateCents) : null };
}

export function IncomeTab({ typed, readOnly, sums, onChange, show, files }: Props) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const full = typed.lines.length >= STATEMENT_LIMITS.LINES_MAX;

  const openNew = () => setEditing({ id: null, description: "", from: "", to: "", quantity: "1", rate: "" });
  const openLine = (line: LineDraft) => setEditing({ id: line.id, description: line.description, from: line.from, to: line.to, quantity: line.quantity, rate: line.rate });
  const move = (index: number, by: -1 | 1) => {
    const lines = [...typed.lines];
    const [line] = lines.splice(index, 1);
    lines.splice(index + by, 0, line);
    onChange({ ...typed, lines });
  };
  const removeLine = () => {
    if (!editing || editing.id === null) return;
    if (!window.confirm("Remove this line?")) return;
    onChange({ ...typed, lines: typed.lines.filter((l) => l.id !== editing.id) });
    setEditing(null);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    const description = editing.description.normalize("NFC").replace(/\s+/g, " ").trim();
    const rate = readAmount(editing.rate);
    const quantity = readQuantity(editing.quantity);
    const from = editing.from.trim();
    const to = editing.to.trim();
    const problems = [
      description === "" ? "Describe the line." : null,
      quantity === null ? "Check the quantity: a whole number, 1 or more." : null,
      rate === null || rate === "0.00" ? "Check the rate: dollars and cents other than 0.00, like 1200.00 (negative for an expense)." : null,
      (from !== "" && !isDayText(from)) || (to !== "" && !isDayText(to)) || (from !== "" && to !== "" && to < from) ? "Check the dates." : null,
    ].filter((problem): problem is string => problem !== null);
    if (problems.length > 0 || rate === null) {
      show({ tone: "error", title: editing.id === null ? "The line was not added." : "The line was not saved.", items: problems });
      return;
    }
    const fields = { description, from, to, quantity: String(quantity), rate };
    const lines =
      editing.id === null ? [...typed.lines, { id: newId(), ...fields }] : typed.lines.map((line) => (line.id === editing.id ? { ...line, ...fields } : line));
    onChange({ ...typed, lines });
    setEditing(null);
  };

  const live = editing ? figuresOf(editing) : null;
  const position = editing?.id === null ? null : typed.lines.findIndex((line) => line.id === editing?.id);

  return (
    <section className={styles.block} aria-label="Income">
      <div className={styles.blockHead}>
        <h3 className={styles.blockTitle}>Income</h3>
        <span className={styles.blockTotal}>{sums ? `${formatCents(sums.incomeCents)} revenue · ${formatCents(sums.expensesCents)} expenses` : "—"}</span>
        {!readOnly && (
          <span className={styles.blockActions}>
            <button type="button" className={styles.btnPrimary} onClick={openNew} disabled={editing !== null || full} title={full ? `A statement holds at most ${STATEMENT_LIMITS.LINES_MAX} lines` : undefined}>
              <Plus size={15} aria-hidden />
              <span>Add a line</span>
            </button>
          </span>
        )}
      </div>

      {/* ── The month's lines from the files that wait on the Income page (dispatch 27) ── */}
      {files && files.pending > 0 && (
        <p className={styles.note}>
          {files.pending === 1 ? "1 line" : `${files.pending} lines`} from the Airbnb file to review ·{" "}
          <Link href={`/admin/income?month=${files.month}`} prefetch={false} className={styles.linkButton}>
            Income page
          </Link>
        </p>
      )}
      {files?.failed && <p className={styles.noteWarn}>The lines from the files could not be read: which lines came from a file is not shown.</p>}

      {/* ── The form: a new line, or the line clicked ── */}
      {editing && !readOnly && (
        <form className={styles.form} onSubmit={submit} aria-label={editing.id === null ? "Add a line" : "Line editor"}>
          <p className={styles.formTitle}>{editing.id === null ? "Add a line" : `Line ${(position ?? 0) + 1}`}</p>
          <div className={styles.fields}>
            <label className={`${styles.field} ${styles.fieldGrow}`}>
              <span className={styles.fieldLabel}>Description</span>
              <input className={styles.textInput} value={editing.description} maxLength={STATEMENT_LIMITS.LINE_DESCRIPTION_MAX} placeholder="Revenue" onChange={(e) => setEditing({ ...editing, description: e.target.value })} autoFocus />
            </label>
            <div className={`${styles.field} ${styles.fieldDates}`}>
              <span className={styles.fieldLabel}>Dates</span>
              <DateRangeField label="Dates" from={editing.from} to={editing.to} onChange={(range) => setEditing({ ...editing, from: range.from, to: range.to })} emptyText="No dates" className={styles.datesField} />
            </div>
            <span className={styles.fieldBreak} aria-hidden />
            <label className={`${styles.field} ${styles.fieldQty}`}>
              <span className={styles.fieldLabel}>Quantity</span>
              <input className={`${styles.textInput} ${styles.amountInput}`} inputMode="numeric" value={editing.quantity} onChange={(e) => setEditing({ ...editing, quantity: e.target.value })} />
            </label>
            <label className={`${styles.field} ${styles.fieldAmount}`}>
              <span className={styles.fieldLabel}>Rate ($)</span>
              <input
                className={`${styles.textInput} ${styles.amountInput}`}
                inputMode="decimal"
                placeholder="1200.00"
                value={editing.rate}
                onChange={(e) => setEditing({ ...editing, rate: e.target.value })}
                onBlur={() => {
                  const read = readAmount(editing.rate);
                  if (read && read !== editing.rate) setEditing({ ...editing, rate: read });
                }}
              />
            </label>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Amount</span>
              <span className={styles.fieldValue} aria-live="polite">
                {live?.amountCents == null ? "—" : formatCents(live.amountCents)}
              </span>
            </div>
          </div>
          <div className={styles.formActions}>
            <button type="submit" className={styles.btnPrimary}>
              {editing.id === null ? "Add line" : "Save line"}
            </button>
            <button type="button" className={styles.btnGhost} onClick={() => setEditing(null)}>
              Cancel
            </button>
            {editing.id !== null && (
              <button type="button" className={`${styles.btnGhost} ${styles.btnDanger} ${styles.formActionEnd}`} onClick={removeLine}>
                Remove line
              </button>
            )}
          </div>
        </form>
      )}

      {/* ── The lines, in the admin's order ── */}
      {typed.lines.length > 0 && (
        <table className={styles.listTable}>
          <thead>
            <tr>
              <th>Description</th>
              <th className={styles.num}>Qty</th>
              <th className={styles.num}>Rate</th>
              <th className={styles.num}>Amount</th>
              {!readOnly && <th className={styles.orderCell} aria-label="Order" />}
            </tr>
          </thead>
          <tbody>
            {typed.lines.map((line, i) => {
              const { quantity, rateCents, amountCents } = figuresOf(line);
              const dates = line.from || line.to ? rangeText(line.from || null, line.to || null) : "";
              const details = line.details ? lineDetailsText({ source: line.details.source, reference: line.details.reference ?? null }) : "";
              const fromFile = files?.marks.get(line.id) ?? "";
              const open = editing?.id === line.id;
              const unreadable = line.description.trim() === "" || amountCents === null;
              return (
                <tr key={line.id} className={`${readOnly ? "" : styles.rowClick} ${open ? styles.rowOpen : ""}`} onClick={readOnly ? undefined : () => openLine(line)} aria-current={open ? "true" : undefined}>
                  <td className={styles.cellWhat}>
                    {readOnly ? (
                      line.description || <span className={styles.muted}>No description</span>
                    ) : (
                      <button
                        type="button"
                        className={styles.rowButton}
                        onClick={(e) => {
                          e.stopPropagation();
                          openLine(line);
                        }}
                      >
                        {line.description || <span className={styles.muted}>No description</span>}
                      </button>
                    )}
                    {(dates !== "" || details !== "" || fromFile !== "" || unreadable) && (
                      <span className={`${styles.rowSub} ${unreadable && !readOnly ? styles.rowSubWarn : ""}`}>
                        {[dates, details ? `${details} · recorded before` : "", fromFile ? `From ${fromFile}` : "", unreadable && !readOnly ? "Check this line" : ""].filter(Boolean).join(" · ")}
                      </span>
                    )}
                  </td>
                  <td className={styles.num}>{quantity ?? "—"}</td>
                  <td className={styles.num}>{rateCents === null ? "—" : formatCents(rateCents)}</td>
                  <td className={styles.num}>{amountCents === null ? "—" : formatCents(amountCents)}</td>
                  {!readOnly && (
                    <td className={styles.orderCell}>
                      <button
                        type="button"
                        className={styles.orderBtn}
                        aria-label={`Move line ${i + 1} up`}
                        disabled={i === 0}
                        onClick={(e) => {
                          e.stopPropagation();
                          move(i, -1);
                        }}
                      >
                        <ArrowUp size={13} aria-hidden />
                      </button>
                      <button
                        type="button"
                        className={styles.orderBtn}
                        aria-label={`Move line ${i + 1} down`}
                        disabled={i === typed.lines.length - 1}
                        onClick={(e) => {
                          e.stopPropagation();
                          move(i, 1);
                        }}
                      >
                        <ArrowDown size={13} aria-hidden />
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
