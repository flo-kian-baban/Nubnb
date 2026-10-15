"use client";

/**
 * A team member's pay (Team pay, Kian's rulings of 2026-10-15; TEAM-PAY-PLAN.md §4), opened from their name or
 * "Pay" on the Team page. It lives on the Team page, at /admin/cleaners?pay={id}, and is drawn from what that page
 * already holds — the cost list and every payment — so opening a person reads nothing more.
 *
 * At the top, their Earned, Paid and Balance over all time (ruling 3: no pay periods; overpaid in amber). Then
 * Record a payment, in Nubnb's own controls (ruling 2): the amount, the day paid, how, and a note. Then a date
 * filter, with what was earned and paid in it and the balance at its start and end, over every item and payment of
 * theirs by date, newest first: counted or not, with what changed each and when, and a change after a payment that
 * may have included it in amber (§3). A deleted payment stays listed, struck through (ruling 4).
 *
 * The figures and the list come from the one function, app/lib/pay/balance.ts, as the cleaner app's figures do.
 * Nothing here is optimistic: a payment appears, or is marked deleted, as the server stored it.
 */

import { useMemo, useState, type FormEvent, type MouseEvent } from "react";
import { ChevronLeft, RefreshCw } from "lucide-react";
import { AdminSelect } from "../components/AdminSelect";
import { DateRangeField, type DatePreset } from "../components/DateRangeField";
import type { Notice } from "../components/Notice";
import type { Question } from "../components/AskDialog";
import { CLEANER_ROLE_LABELS, CLEANER_STATUS_LABELS, formatCents, isCleanerRole, isCleanerStatus, type CleanerSummary, type CostEntryView } from "@/app/lib/cleaners/model";
import type { CleaningView } from "@/app/lib/cleanings/model";
import { inRange, presetRange } from "@/app/lib/costs/report";
import { balanceWords, changeWords, dayWords, memberPay, rowItemWords, type PayChange, type PayRow } from "@/app/lib/pay/balance";
import { PAYMENT_METHOD_LABELS, PAYMENT_METHODS, earliestPaymentDay, type PaymentMethod, type PaymentView } from "@/app/lib/pay/model";
import { deletePayment, recordPayment } from "@/app/lib/pay-client";
import shared from "../page.module.css";
import styles from "./page.module.css";

interface PayViewProps {
  member: CleanerSummary;
  cleanings: readonly CleaningView[];
  entries: readonly CostEntryView[];
  payments: readonly PaymentView[];
  /** Payments that could not be read, anyone's: the balance is then never shown as whole. */
  unreadablePayments: number;
  today: string;
  onBack: () => void;
  /** Read the team, the cost list and the payments again: the Team page's Refresh, in this page's head. */
  onRefresh: () => void;
  /** A payment as the server stored it, recorded or deleted. */
  onPayment: (payment: PaymentView) => void;
  show: (notice: Notice) => void;
  clear: () => void;
  ask: (question: Question) => Promise<boolean>;
}

/** Shown struck through: it counted once, or would have, and does not now. */
const STRUCK: readonly PayRow["state"][] = ["removed", "rejected", "nubnb-card", "moved", "deleted"];

/** The change a row's note already tells, by its first words: it is not told twice. */
const NOTE_TELLS: Partial<Record<PayRow["state"], string>> = { removed: "Removed", rejected: "Rejected", "nubnb-card": "Marked paid with Nubnb's card", moved: "Given to " };

/** A balance inside a sentence: "$60.00 owed", "$40.00 overpaid", "settled". */
const balanceInline = (cents: number) => (cents === 0 ? "settled" : balanceWords(cents).words);

/** `day` moved back `days` days. */
const daysBefore = (day: string, days: number) => new Date(Date.parse(`${day}T12:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

/** A plain click, which opens in place; any other (a new tab, a new window) is left to the browser. */
export const plainClick = (event: MouseEvent) => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

/** "300", "$1,240.5", "300.00" → "300.00"; null when it is not dollars and cents. */
function amountText(typed: string): string | null {
  const match = /^\$?(\d{1,6})(?:\.(\d{1,2}))?$/.exec(typed.replace(/[\s,]/g, ""));
  return match ? `${Number(match[1])}.${(match[2] ?? "0").padEnd(2, "0")}` : null;
}

export function PayView({ member, cleanings, entries, payments, unreadablePayments, today, onBack, onRefresh, onPayment, show, clear, ask }: PayViewProps) {
  const name = member.name !== null && member.name.trim() !== "" ? member.name : "this team member";
  const [range, setRange] = useState(() => presetRange("this-month", today));
  const pay = useMemo(() => memberPay(member.id, { cleanings, entries, payments }, range), [member.id, cleanings, entries, payments, range]);
  const [amount, setAmount] = useState(() => (pay.balanceCents > 0 ? (pay.balanceCents / 100).toFixed(2) : ""));
  const [day, setDay] = useState(today);
  const [method, setMethod] = useState<PaymentMethod>("e-transfer");
  const [note, setNote] = useState("");
  /** The one write in flight: recording, or deleting the payment with this ID. */
  const [busy, setBusy] = useState<string | null>(null);

  const presets: DatePreset[] = [
    { key: "this-month", label: "This month", ...presetRange("this-month", today) },
    { key: "last-month", label: "Last month", ...presetRange("last-month", today) },
    { key: "last-90", label: "Last 90 days", from: daysBefore(today, 89), to: today },
    { key: "all-time", label: "All time", from: "", to: "" },
  ];

  const record = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy !== null) return;
    const text = amountText(amount);
    if (text === null) {
      show({ tone: "error", title: "Type the amount as dollars and cents, like 300.00." });
      return;
    }
    if (text === "0.00") {
      show({ tone: "error", title: "A payment is more than $0.00." });
      return;
    }
    clear();
    setBusy("record");
    const result = await recordPayment({ memberId: member.id, amount: text, day, method, note: note.trim() === "" ? null : note });
    setBusy(null);
    if (!result.ok) {
      show(
        result.unknown
          ? { tone: "warning", title: "The payment may or may not have been recorded. Refresh to see before recording it again.", detail: result.title }
          : { tone: "error", title: result.title, detail: result.detail ?? "Nothing was recorded." },
      );
      return;
    }
    const stored = result.data.payment;
    onPayment(stored);
    setAmount("");
    setNote("");
    show({
      tone: "success",
      title: `Recorded ${formatCents(stored.amountCents)} paid to ${name} on ${dayWords(stored.day)}.`,
      detail: inRange(stored.day, range.from, range.to) ? undefined : "It is outside the dates shown below.",
    });
  };

  const remove = async (payment: PaymentView) => {
    if (busy !== null) return;
    const yes = await ask({
      title: `Delete ${name}'s payment of ${formatCents(payment.amountCents)} on ${dayWords(payment.day)} (${PAYMENT_METHOD_LABELS[payment.method].toLowerCase()}, recorded by ${payment.recordedBy.name ?? "an admin"})?`,
      lines: [`It stays in ${name}'s history, marked deleted by you, and stops counting as paid.`],
      confirm: "Delete payment",
      danger: true,
    });
    if (!yes) return;
    clear();
    setBusy(payment.id);
    const result = await deletePayment(payment.id, payment.history.length);
    setBusy(null);
    if (!result.ok) {
      show(
        result.unknown
          ? { tone: "warning", title: "The payment may or may not have been deleted. Refresh to see.", detail: result.title }
          : { tone: "error", title: result.title, detail: result.detail ?? "Nothing was deleted." },
      );
      return;
    }
    onPayment(result.data.payment);
    show({ tone: "success", title: `Deleted the payment of ${formatCents(payment.amountCents)} on ${dayWords(payment.day)}.`, detail: `It stays in ${name}'s history, struck through, and no longer counts as paid.` });
  };

  const balance = balanceWords(pay.balanceCents);
  const role = isCleanerRole(member.role) ? CLEANER_ROLE_LABELS[member.role] : (member.role ?? "No role");
  const status = isCleanerStatus(member.status) ? CLEANER_STATUS_LABELS[member.status] : (member.status ?? "No status");
  const parts = [
    pay.parts.cleaningsCents !== 0 ? `cleanings ${formatCents(pay.parts.cleaningsCents)}` : null,
    pay.parts.receiptsCents !== 0 ? `receipts ${formatCents(pay.parts.receiptsCents)}` : null,
    pay.parts.workCents !== 0 ? `work ${formatCents(pay.parts.workCents)}` : null,
  ].filter((part): part is string => part !== null);
  const rows = pay.rows.filter((row) => inRange(row.day, range.from, range.to));
  const inDates = pay.range;

  return (
    <>
      {/* ── Who, and the page's own button (Kian's ruling of 2026-10-15: none in the navigation) ── */}
      <div className={styles.payTop}>
        <div className={styles.payWho}>
          <a
            href="/admin/cleaners"
            className={styles.payBack}
            onClick={(event) => {
              if (!plainClick(event)) return;
              event.preventDefault();
              onBack();
            }}
          >
            <ChevronLeft size={16} aria-hidden />
            <span>Team</span>
          </a>
          <h2 className={styles.payTitle}>{name}</h2>
          <p className={styles.payMeta}>
            {role} · {status} · <span className={styles.mono}>ID {member.id}</span>
          </p>
        </div>
        <button type="button" className={shared.btnGhost} onClick={onRefresh} disabled={busy !== null}>
          <RefreshCw size={15} aria-hidden />
          <span>Refresh</span>
        </button>
      </div>

      {/* ── Earned, Paid, Balance: all time ── */}
      <div className={styles.payFigures}>
        <div className={styles.payFigure}>
          <span className={styles.payFigureLabel}>Earned</span>
          <span className={styles.payFigureValue}>{formatCents(pay.earnedCents)}</span>
          {parts.length > 0 && <span className={styles.payFigureDetail}>{parts.join(" · ")}</span>}
        </div>
        <div className={styles.payFigure}>
          <span className={styles.payFigureLabel}>Paid</span>
          <span className={styles.payFigureValue}>{formatCents(pay.paidCents)}</span>
        </div>
        <div className={`${styles.payFigure} ${balance.tone === "overpaid" ? styles.payFigureWarn : ""}`}>
          <span className={styles.payFigureLabel}>Balance</span>
          <span className={styles.payFigureValue}>
            {balance.tone === "owed" ? `${formatCents(pay.balanceCents)} owed to ${name}` : balance.tone === "overpaid" ? `Overpaid ${formatCents(-pay.balanceCents)}` : "Settled"}
          </span>
        </div>
      </div>
      {(pay.waiting > 0 || pay.cannotAddUp > 0 || unreadablePayments > 0) && (
        <ul className={styles.payNotes}>
          {pay.waiting > 0 && <li>{pay.waiting === 1 ? "1 item is" : `${pay.waiting} items are`} waiting for review or an amount: not counted yet.</li>}
          {pay.cannotAddUp > 0 && <li className={styles.payWarn}>{pay.cannotAddUp === 1 ? "1 entry cannot" : `${pay.cannotAddUp} entries cannot`} add up and {pay.cannotAddUp === 1 ? "is" : "are"} left out: the balance is not whole.</li>}
          {unreadablePayments > 0 && <li className={styles.payWarn}>{unreadablePayments === 1 ? "1 payment" : `${unreadablePayments} payments`} could not be read and {unreadablePayments === 1 ? "is" : "are"} left out: the balance is not whole.</li>}
        </ul>
      )}

      {/* ── Record a payment (ruling 2) ── */}
      <form className={styles.codeEditor} onSubmit={record} noValidate aria-labelledby="pay-record-title">
        <h2 id="pay-record-title" className={styles.codeEditorTitle}>
          Record a payment
        </h2>
        <div className={styles.payForm}>
          <label className={styles.payField}>
            <span className={styles.createLabel}>Amount ($)</span>
            <input type="text" inputMode="decimal" autoComplete="off" placeholder="0.00" className={styles.payInput} value={amount} onChange={(event) => setAmount(event.target.value)} disabled={busy !== null} />
          </label>
          <div className={styles.payField}>
            <span className={styles.createLabel}>Date paid</span>
            <DateRangeField label="Date paid" single from={day} to={day} max={today} min={earliestPaymentDay(today)} onChange={(picked) => setDay(picked.from)} />
          </div>
          <div className={styles.payField}>
            <span className={styles.createLabel}>Method</span>
            <AdminSelect label="Method" value={method} onChange={(value) => setMethod(value as PaymentMethod)} groups={[{ options: PAYMENT_METHODS.map((value) => ({ value, label: PAYMENT_METHOD_LABELS[value] })) }]} disabled={busy !== null} />
          </div>
          <label className={`${styles.payField} ${styles.payNoteField}`}>
            <span className={styles.createLabel}>Note</span>
            <input type="text" autoComplete="off" placeholder="Optional" maxLength={500} className={styles.payInput} value={note} onChange={(event) => setNote(event.target.value)} disabled={busy !== null} />
          </label>
          <button type="submit" className={`${shared.btnPrimary} ${styles.createBtn}`} disabled={busy !== null}>
            {busy === "record" ? "Recording…" : "Record"}
          </button>
        </div>
      </form>

      {/* ── The dates, and what fell in them ── */}
      <div className={styles.payFilter}>
        <DateRangeField label="Dates" from={range.from} to={range.to} max={today} presets={presets} onChange={setRange} note="Cleanings by the day cleaned, receipts and work by the day sent, payments by the day paid." />
        {inDates && (
          <p className={styles.payRange}>
            In these dates: earned {formatCents(inDates.earnedCents)} · paid {formatCents(inDates.paidCents)}
            {inDates.from !== "" && ` · balance ${balanceInline(inDates.balanceBeforeCents)} at the start`}
            {inDates.to !== "" && `${inDates.from !== "" ? "," : " · balance"} ${balanceInline(inDates.balanceAtEndCents)} at the end`}
          </p>
        )}
      </div>

      {/* ── Every item and payment, newest first ── */}
      {rows.length === 0 ? (
        <p className={styles.payEmpty}>Nothing in these dates.</p>
      ) : (
        <div className={`${shared.tableContainer} ${styles.tableScroll}`}>
          <table className={shared.table}>
            <thead>
              <tr>
                <th>Date</th>
                <th>Item</th>
                <th className={styles.payCol}>Earned</th>
                <th className={styles.payCol}>Paid</th>
                <th>
                  <span className={shared.srOnly}>What happened</span>
                </th>
                <th className={shared.actionsHeader}>
                  <span className={shared.srOnly}>Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.kind}:${row.id}`}>
                  <td className={styles.payDay}>{row.day ? dayWords(row.day) : <span className={styles.payWarn}>No date</span>}</td>
                  <td className={styles.payItem}>{rowItemWords(row)}</td>
                  <td className={styles.payCol}>{row.kind === "payment" ? null : <Amount row={row} counted={row.earnedCents} />}</td>
                  <td className={styles.payCol}>{row.kind === "payment" ? <Amount row={row} counted={row.paidCents} /> : null}</td>
                  <td className={styles.payWhat}>
                    <RowNotes row={row} />
                  </td>
                  <td className={styles.actionCell}>
                    {row.payment && row.payment.status === "recorded" && (
                      <button type="button" className={`${styles.rowAction} ${styles.rowActionDanger}`} disabled={busy !== null} onClick={() => row.payment && remove(row.payment)}>
                        {busy === row.id ? "Deleting…" : "Delete…"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/** What it adds now; the amount struck through when it no longer counts; muted while it waits; a dash with none. */
function Amount({ row, counted }: { row: PayRow; counted: number | null }) {
  if (counted !== null) return <>{formatCents(counted)}</>;
  if (row.amountCents === null) return <span className={styles.muted}>—</span>;
  if (STRUCK.includes(row.state)) return <s className={styles.payStruck}>{formatCents(row.amountCents)}</s>;
  return <span className={styles.muted}>{formatCents(row.amountCents)}</span>;
}

/** Its state now, then what changed it, each change after a payment that may have included it marked in amber. */
function RowNotes({ row }: { row: PayRow }) {
  const last = row.changes[row.changes.length - 1];
  const tells = NOTE_TELLS[row.state];
  const told = tells !== undefined && last !== undefined && last.words.startsWith(tells) ? last : null;
  const others = row.changes.filter((change) => change !== told);
  return (
    <>
      {row.note !== null && (
        <span className={`${styles.payLine} ${row.state === "cannot-add-up" || row.state === "unknown" ? styles.payWarn : ""}`}>
          {row.note}
          {told && <AfterPayment change={told} />}
        </span>
      )}
      {others.map((change, i) => (
        <span key={i} className={styles.payLine}>
          {changeWords(change)}
          <AfterPayment change={change} />
        </span>
      ))}
    </>
  );
}

function AfterPayment({ change }: { change: PayChange }) {
  if (change.afterPayment === null) return null;
  return <span className={styles.payAmber}> · after the payment of {dayWords(change.afterPayment.day)}</span>;
}
