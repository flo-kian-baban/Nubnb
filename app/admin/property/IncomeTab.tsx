"use client";

/**
 * The Income tab (dispatch 23F): the month's lines, as the statement prints
 * them. A line is a description, its dates, a quantity and a rate; the
 * amount is quantity × rate (Kian's ruling of 2026-10-01), computed and
 * shown. A typed line with a negative rate is an expense; an Airbnb line
 * below zero, a claw-back, takes revenue off and is never an expense (Kian's
 * ruling M1, 2026-10-13). The head's figures are the month's money's.
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
 * Lines from the platforms' files (dispatch 37C, Kian's ruling M10): a line
 * an admin accepted on the Income page is read where it is stored, never
 * copied into the draft. The statement prints it first, newest stay first;
 * this tab lists it apart, with its file and row, and lets it be edited (the
 * line itself changes, with its history) or sent back for review — until a
 * finished statement prints it: then it is locked, unless that statement is
 * being corrected. A line accepted for a month already finished is on the
 * next open statement, its day paid printed (M11). The month's lines still
 * waiting on the Income page are counted, with the way to them; a line
 * accepted before 37C is an ordinary line of the draft, marked with its file
 * and row. The month's calendar copies and the stays on them no line covers
 * are said here (I8, I15).
 */

import { useState, type FormEvent } from "react";
import type { EarningsLineView } from "@/app/lib/income/model";
import { decideIncomeLine, editIncomeLine } from "@/app/lib/income-client";
import Link from "next/link";
import { ArrowDown, ArrowUp, Plus } from "lucide-react";
import type { Notice } from "../components/Notice";
import { useAsk } from "../components/AskDialog";
import { DateRangeField } from "../components/DateRangeField";
import { formatCents } from "@/app/lib/cleaners/model";
import { STATEMENT_LIMITS, isDayText, lineAmount, monthLabel, monthRange, rangeText, type Line } from "@/app/lib/reports/model";
import { lineDetailsText } from "@/app/lib/reports/statement";
import { amountField, readAmount } from "../costs/cost-display";
import type { Figures } from "@/app/lib/money/month";
import { centsOf, newId, readQuantity, type LineDraft, type Typed } from "./statement-form";
import styles from "./page.module.css";

interface Props {
  typed: Typed;
  readOnly: boolean;
  /** The revenue and the typed expenses, as the month's money gives them (dispatch 37A: an Airbnb claw-back takes revenue off, Kian's ruling M1); null when it cannot be built. */
  figures: Pick<Figures, "revenueCents" | "airbnbCents" | "directCents" | "expensesCents"> | null;
  /** While a correction is written: the statement as sent, beside it. */
  sent: Pick<Figures, "revenueCents" | "expensesCents"> | null;
  onChange: (next: Typed) => void;
  show: (notice: Notice) => void;
  /**
   * The month's lines from the platforms' files: a copy's file and row (accepted before dispatch 37C), by its draft
   * line's id; how many wait on the Income page; whether they could be read; the stored lines by ID and the files'
   * names; and the month's calendar copies with the stays no line covers.
   */
  files?: {
    marks: Map<string, string>;
    pending: number;
    failed: boolean;
    month: string;
    stored: Map<string, EarningsLineView>;
    names: Map<string, string>;
    calendar: { days: string[]; uncovered: { start: string; end: string }[] } | null;
  };
  /** The statement's lines read from the files where they are stored (dispatch 37C), in print order. */
  fileLines?: Line[];
  /** One of them was edited or sent back: the page reads the lines again. */
  onFilesChanged?: () => void;
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

/** "$2,000.00 revenue, Airbnb $1,900.00, direct $100.00 · $60.00 expenses": each part named when other revenue sits beside it. */
function incomeWords(figures: Pick<Figures, "revenueCents" | "airbnbCents" | "directCents" | "expensesCents">): string {
  const airbnb = figures.airbnbCents !== 0 && figures.airbnbCents !== figures.revenueCents ? `, Airbnb ${formatCents(figures.airbnbCents)}` : "";
  const direct = figures.directCents !== 0 && figures.directCents !== figures.revenueCents ? `, direct ${formatCents(figures.directCents)}` : "";
  return `${formatCents(figures.revenueCents)} revenue${airbnb}${direct} · ${formatCents(figures.expensesCents)} expenses`;
}

/** A line from a file being edited: its words and amount as typed. */
interface FileEditing {
  id: string;
  description: string;
  amount: string;
}

export function IncomeTab({ typed, readOnly, figures, sent, onChange, show, files, fileLines = [], onFilesChanged }: Props) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const [fileEditing, setFileEditing] = useState<FileEditing | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** Questions in Nubnb's own dialog (Kian's ruling of 2026-10-12: no native browser dialogs in the admin). */
  const { ask, dialog } = useAsk();
  const full = typed.lines.length >= STATEMENT_LIMITS.LINES_MAX;

  const openNew = () => setEditing({ id: null, description: "", from: "", to: "", quantity: "1", rate: "" });
  const openLine = (line: LineDraft) => setEditing({ id: line.id, description: line.description, from: line.from, to: line.to, quantity: line.quantity, rate: line.rate });
  const move = (index: number, by: -1 | 1) => {
    const lines = [...typed.lines];
    const [line] = lines.splice(index, 1);
    lines.splice(index + by, 0, line);
    onChange({ ...typed, lines });
  };
  const removeLine = async () => {
    if (!editing || editing.id === null) return;
    const id = editing.id;
    if (!(await ask({ title: "Remove this line?", lines: [editing.description.trim() ? `“${editing.description.trim()}” leaves the statement.` : null], confirm: "Remove line", danger: true }))) return;
    onChange({ ...typed, lines: typed.lines.filter((l) => l.id !== id) });
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

  // ── A line from a file: edited, or sent back for review (Kian's ruling M10: until a finished statement prints it) ──
  const saveFileLine = async (event: FormEvent) => {
    event.preventDefault();
    if (!fileEditing || busy) return;
    const line = files?.stored.get(fileEditing.id);
    if (!line || line.decided?.status !== "accepted") return;
    const description = fileEditing.description.normalize("NFC").replace(/\s+/g, " ").trim();
    const amount = readAmount(fileEditing.amount);
    const problems = [
      description === "" || description.length > STATEMENT_LIMITS.LINE_DESCRIPTION_MAX ? `Describe the line, in at most ${STATEMENT_LIMITS.LINE_DESCRIPTION_MAX} characters.` : null,
      amount === null || amount === "0.00" ? "Check the amount: dollars and cents other than 0.00, negative for money taken back." : null,
    ].filter((p): p is string => p !== null);
    if (problems.length > 0 || amount === null) {
      show({ tone: "error", title: "The line was not saved.", items: problems });
      return;
    }
    const change: { seen: number; description?: string; amount?: string } = { seen: line.history.length };
    if (description !== line.decided.description) change.description = description;
    if (amount !== amountField(line.decided.amountCents)) change.amount = amount;
    if (change.description === undefined && change.amount === undefined) {
      setFileEditing(null);
      return;
    }
    setBusy(`edit:${line.id}`);
    const result = await editIncomeLine(line.id, change);
    setBusy(null);
    if (!result.ok) {
      show({ tone: result.status === 409 ? "warning" : "error", title: result.title, detail: result.detail });
      return;
    }
    setFileEditing(null);
    show({ tone: "success", title: "Saved. The line's history keeps what it said before." });
    onFilesChanged?.();
  };
  const sendBack = async (line: EarningsLineView) => {
    if (busy || line.decided?.status !== "accepted") return;
    const yes = await ask({
      title: "Send this line back for review?",
      lines: [`“${line.decided.description}” leaves the statement and waits on the Income page, where it can be accepted again or rejected.`],
      confirm: "Send back",
    });
    if (!yes) return;
    setBusy(`back:${line.id}`);
    const result = await decideIncomeLine(line.id, "propose-again");
    setBusy(null);
    if (!result.ok) {
      show({ tone: result.status === 409 ? "warning" : "error", title: result.title, detail: result.detail });
      return;
    }
    show({ tone: "success", title: "Sent back: it waits on the Income page." });
    onFilesChanged?.();
  };
  const monthDays = files ? Number(monthRange(files.month).to.slice(8)) : 0;

  const live = editing ? figuresOf(editing) : null;
  const position = editing?.id === null ? null : typed.lines.findIndex((line) => line.id === editing?.id);

  return (
    <section className={styles.block} aria-label="Income">
      <div className={styles.blockHead}>
        <h3 className={styles.blockTitle}>Income</h3>
        <span className={styles.blockTotal}>
          {figures ? incomeWords(figures) : "—"}
          {sent && <span className={styles.note}> · as sent {formatCents(sent.revenueCents)} revenue · {formatCents(sent.expensesCents)} expenses</span>}
        </span>
        {!readOnly && (
          <span className={styles.blockActions}>
            <button type="button" className={styles.btnPrimary} onClick={openNew} disabled={editing !== null || full} title={full ? `A statement holds at most ${STATEMENT_LIMITS.LINES_MAX} lines` : undefined}>
              <Plus size={15} aria-hidden />
              <span>Add a line</span>
            </button>
          </span>
        )}
      </div>

      {/* ── The lines from the files, read where they are stored (dispatch 37C): printed first, newest stay first ── */}
      {fileLines.length > 0 && (
        <>
          <h4 className={styles.subTitle}>From the Airbnb file · {fileLines.length}</h4>
          <table className={styles.listTable}>
            <thead>
              <tr>
                <th>Description</th>
                <th className={styles.num}>Amount</th>
                {!readOnly && <th className={styles.orderCell} aria-label="Actions" />}
              </tr>
            </thead>
            <tbody>
              {fileLines.map((printed) => {
                const line = printed.platformLineId ? files?.stored.get(printed.platformLineId) : undefined;
                const from = line ? `${files?.names.get(line.uploadId) ?? "a file"} · row ${line.fileRow}` : "a file";
                const edited = line?.history.some((h) => h.action === "edited") ?? false;
                const late = line && files && line.month !== files.month ? `${monthLabel(line.month)}'s, accepted after that month was finished` : null;
                if (line && fileEditing?.id === line.id && !readOnly) {
                  return (
                    <tr key={printed.id} className={styles.rowOpen}>
                      <td colSpan={3}>
                        <form className={styles.inlineForm} onSubmit={saveFileLine} aria-label="Edit the line from the file">
                          <input className={`${styles.textInput} ${styles.inlineDescription}`} aria-label="Description" value={fileEditing.description} maxLength={STATEMENT_LIMITS.LINE_DESCRIPTION_MAX} onChange={(e) => setFileEditing({ ...fileEditing, description: e.target.value })} autoFocus />
                          <input className={`${styles.textInput} ${styles.amountInput} ${styles.inlineAmount}`} aria-label="Amount" inputMode="decimal" value={fileEditing.amount} onChange={(e) => setFileEditing({ ...fileEditing, amount: e.target.value })} />
                          <button type="submit" className={styles.btnPrimary} disabled={busy !== null}>
                            {busy === `edit:${line.id}` ? "Saving…" : "Save"}
                          </button>
                          <button type="button" className={styles.btnGhost} onClick={() => setFileEditing(null)}>
                            Cancel
                          </button>
                          <span className={styles.note}>
                            In the file: {formatCents(line.amountCents)} · {from}
                          </span>
                        </form>
                      </td>
                    </tr>
                  );
                }
                return (
                  <tr key={printed.id}>
                    <td className={styles.cellWhat}>
                      {printed.description}
                      <span className={styles.rowSub}>{[`From ${from}`, edited ? "edited since accepted" : null, late].filter(Boolean).join(" · ")}</span>
                    </td>
                    <td className={styles.num}>{formatCents(printed.amountCents)}</td>
                    {!readOnly && (
                      <td className={styles.orderCell}>
                        {line && line.decided?.status === "accepted" && (
                          <span className={styles.rowActions}>
                            <button type="button" className={styles.btnGhost} disabled={busy !== null || fileEditing !== null} onClick={() => line.decided?.status === "accepted" && setFileEditing({ id: line.id, description: line.decided.description, amount: amountField(line.decided.amountCents) })}>
                              Edit
                            </button>
                            <button type="button" className={styles.btnGhost} disabled={busy !== null || fileEditing !== null} onClick={() => void sendBack(line)}>
                              {busy === `back:${line.id}` ? "Sending…" : "Send back"}
                            </button>
                          </span>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {readOnly && <p className={styles.note}>On a finished statement, so locked. Correcting the statement lets them change.</p>}
        </>
      )}

      {/* ── The month's calendar (I8, I15): which days' copies were read, and the stays on them no line covers ── */}
      {files?.calendar && files.calendar.days.filter((d) => d.startsWith(files.month)).length < monthDays && (
        <p className={styles.note}>
          Calendar copies kept for {files.calendar.days.filter((d) => d.startsWith(files.month)).length} of {monthLabel(files.month)}&rsquo;s {monthDays} days: stays on the other days are not checked.
        </p>
      )}
      {files?.calendar && files.calendar.uncovered.length > 0 && (
        <p className={styles.noteWarn}>
          {files.calendar.uncovered.length === 1 ? "1 stay" : `${files.calendar.uncovered.length} stays`} on its calendar {files.calendar.uncovered.length === 1 ? "is" : "are"} in no Airbnb line: {files.calendar.uncovered.map((stay) => rangeText(stay.start, stay.end)).join(", ")}.
        </p>
      )}

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
              <button type="button" className={`${styles.btnGhost} ${styles.btnDanger} ${styles.formActionEnd}`} onClick={() => void removeLine()}>
                Remove line
              </button>
            )}
          </div>
        </form>
      )}

      {/* ── The lines, in the admin's order ── */}
      {fileLines.length > 0 && typed.lines.length > 0 && <h4 className={styles.subTitle}>Typed · {typed.lines.length}</h4>}
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
      {dialog}
    </section>
  );
}
