"use client";

/**
 * The Income tab's Direct block (part B of PROPERTY-LIST-COLUMNS-PLAN.md, §5; Kian's rulings of 2026-10-15): money
 * paid to Nubnb outside Airbnb for this property, for the month on screen.
 *
 *   Arrangements   each on one row: its words, who pays, the amount a month, the due day and its state; the month's
 *                  expected, received and state under it (periods.ts), and any credit waiting for the next month.
 *                  Pause, Resume, Change amount and End behind "⋯", each a step in its history with its admin.
 *   Payments       the month's, and any earlier one this month's statement prints: the day received, what the owner's
 *                  statement prints ("Cash - Monthly stay - received Oct 3"), the amount, the months it pays, the
 *                  admin who recorded it, and where it is printed. A payment on a finished statement is locked
 *                  (Kian's ruling: it changes only by correcting that statement). One not printed can be removed:
 *                  it stays listed, struck through, out of every total. Its months can be set by hand ("Months…").
 *
 * One action in the head: Record a payment; Set up an arrangement beside it. Nothing here is optimistic: after each
 * write the page reads the payments again, and the statement places them.
 */

import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import type { Notice } from "../components/Notice";
import { useAsk } from "../components/AskDialog";
import { RowMenu } from "../cleaners/RowMenu";
import { ArrangementDialog, PaymentMonthsDialog, RecordPaymentDialog, type ArrangementDialogMode } from "../components/DirectDialogs";
import { formatCents } from "@/app/lib/cleaners/model";
import { monthLabel, monthOfDay, monthRange, type Line } from "@/app/lib/reports/model";
import { DIRECT_METHOD_LABELS, DIRECT_PURPOSE_LABELS, appliesToWords, directLineText, directPaymentWords, dueDayWords, shortDay, stayNights, type ArrangementView, type DirectPaymentView } from "@/app/lib/direct/model";
import { rangeText } from "@/app/lib/availability/days";
import { ARRANGEMENT_STATUS_LABELS, PERIOD_STATE_LABELS, amountFor, arrangementMonths } from "@/app/lib/direct/periods";
import { removeDirectPayment, type DirectAnswer } from "@/app/lib/direct-client";
import styles from "./page.module.css";

export type DirectRead = { kind: "loading" } | { kind: "error"; title: string } | { kind: "ready"; data: DirectAnswer };

/** Which current finished statement prints a payment: locked unless that statement is being corrected. */
export type PrintedBy = Map<string, { reference: string; month: string; correcting: boolean }>;

interface Props {
  propertyId: string;
  month: string;
  today: string;
  read: DirectRead;
  /** The direct lines the month's statement prints, in print order. */
  lines: Line[];
  printed: PrintedBy;
  onChanged: () => void;
  show: (notice: Notice) => void;
}

const when = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", month: "short", day: "numeric" }).format(new Date(iso));
const STATE_CLASS: Record<string, string> = { paid: styles.directPaid, partly: styles.directPartly, overdue: styles.directOverdue, expected: styles.directExpected };

export function DirectBlock({ propertyId, month, today, read, lines, printed, onChanged, show }: Props) {
  const [recording, setRecording] = useState(false);
  const [arranging, setArranging] = useState<ArrangementDialogMode | null>(null);
  const [applying, setApplying] = useState<DirectPaymentView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { ask, dialog } = useAsk();

  const data = read.kind === "ready" ? read.data : null;
  const arrangements = useMemo(() => (data ? data.arrangements.filter((a) => a.propertyId === propertyId) : []), [data, propertyId]);
  const payments = useMemo(() => (data ? data.payments.filter((p) => p.propertyId === propertyId) : []), [data, propertyId]);
  const onStatement = useMemo(() => new Set(lines.map((line) => line.platformLineId)), [lines]);
  const rows = useMemo(() => payments.filter((p) => monthOfDay(p.day) === month || onStatement.has(p.id)).sort((a, b) => b.day.localeCompare(a.day) || b.recordedAt.localeCompare(a.recordedAt)), [payments, month, onStatement]);
  const receivedCents = payments.filter((p) => p.status === "recorded" && monthOfDay(p.day) === month).reduce((sum, p) => sum + p.amountCents, 0);
  const monthsOf = useMemo(() => new Map(arrangements.map((a) => [a.id, arrangementMonths(a, payments, today)])), [arrangements, payments, today]);
  // The form opens on today, or on the month's last day when the month on screen is earlier.
  const defaultDay = monthRange(month).to < today ? monthRange(month).to : today;

  const remove = async (payment: DirectPaymentView) => {
    if (busy) return;
    const yes = await ask({
      title: `Remove ${directPaymentWords(payment)}?`,
      lines: ["It stays listed, struck through, and leaves the statement and every total. It is never deleted."],
      confirm: "Remove payment",
      danger: true,
    });
    if (!yes) return;
    setBusy(payment.id);
    const result = await removeDirectPayment(payment.id, payment.history.length);
    setBusy(null);
    if (!result.ok) {
      show(result.unknown ? { tone: "warning", title: "The payment may or may not have been removed. Refresh to see.", detail: result.title } : { tone: result.status === 409 ? "warning" : "error", title: result.title, detail: result.detail });
      return;
    }
    show({ tone: "success", title: `Removed ${directPaymentWords(payment)}.`, detail: "It stays listed, struck through, and no longer counts." });
    onChanged();
  };

  return (
    <section className={styles.block} aria-label="Direct payments">
      <div className={styles.blockHead}>
        <h3 className={styles.blockTitle}>Direct</h3>
        <span className={styles.blockTotal}>{data ? `received in ${monthLabel(month)} ${formatCents(receivedCents)}` : read.kind === "error" ? "—" : "…"}</span>
        <span className={styles.blockActions}>
          <button type="button" className={styles.btnGhost} onClick={() => setArranging({ kind: "start", propertyId })} disabled={!data}>
            Set up an arrangement
          </button>
          <button type="button" className={styles.btnPrimary} onClick={() => setRecording(true)} disabled={!data}>
            <Plus size={15} aria-hidden />
            <span>Record a payment</span>
          </button>
        </span>
      </div>

      {read.kind === "error" && <p className={styles.noteWarn}>The direct payments could not be read: {read.title}</p>}
      {data && data.unreadable > 0 && <p className={styles.noteWarn}>{data.unreadable} stored direct {data.unreadable === 1 ? "record is" : "records are"} not in the written shape and left out.</p>}

      {/* ── Arrangements ── */}
      {arrangements.length > 0 && (
        <table className={styles.listTable}>
          <thead>
            <tr>
              <th>Arrangement</th>
              <th>{monthLabel(month)}</th>
              <th className={styles.orderCell} aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {arrangements.map((a) => {
              const months = monthsOf.get(a.id)!;
              const period = months.periods.find((p) => p.month === month);
              const openPause = a.pauses.length > 0 && a.pauses[a.pauses.length - 1].until === null;
              const items = [
                ...(a.untilMonth === null ? [openPause ? { label: "Resume…", onSelect: () => setArranging({ kind: "resume", arrangement: a }) } : { label: "Pause…", onSelect: () => setArranging({ kind: "pause", arrangement: a }) }] : []),
                ...(a.untilMonth === null ? [{ label: "Change amount…", onSelect: () => setArranging({ kind: "amount", arrangement: a }) }] : []),
                ...(a.untilMonth === null ? [{ label: "End…", danger: true, onSelect: () => setArranging({ kind: "end", arrangement: a }) }] : []),
              ];
              const last = a.history[a.history.length - 1];
              return (
                <tr key={a.id}>
                  <td className={styles.cellWhat}>
                    {a.wording} · {a.payerName}
                    <span className={styles.rowSub}>
                      {formatCents(amountFor(a, monthOfDay(today) > a.fromMonth ? monthOfDay(today) : a.fromMonth))} a month · due {dueDayWords(a.dueDay)} · {ARRANGEMENT_STATUS_LABELS[months.status]} · from {monthLabel(a.fromMonth)}
                      {a.untilMonth ? ` to ${monthLabel(a.untilMonth)}` : ""} · last change: {last.action.replace("-", " ")} {monthLabel(last.month)} by {last.actor.name ?? "an admin"} on {when(last.at)}
                    </span>
                  </td>
                  <td className={styles.cellWhat}>
                    {period ? (
                      <>
                        <span className={`${styles.directState} ${STATE_CLASS[period.state]}`}>{PERIOD_STATE_LABELS[period.state]}</span> {formatCents(period.receivedCents)} of {formatCents(period.expectedCents)}
                        <span className={styles.rowSub}>due {shortDay(period.dueDate)}</span>
                      </>
                    ) : (
                      <span className={styles.muted}>Nothing expected</span>
                    )}
                    {months.creditCents > 0 && <span className={styles.rowSub}>{formatCents(months.creditCents)} credit · waits for {months.nextMonth ? monthLabel(months.nextMonth) : "the next month expected"}</span>}
                  </td>
                  <td className={styles.orderCell}>{items.length > 0 && <RowMenu label={`More for ${a.wording}`} items={items} disabled={busy !== null} />}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {/* ── Payments: the month's, and earlier ones this statement prints ── */}
      {data && rows.length === 0 && arrangements.length === 0 && <p className={styles.note}>Nothing received outside Airbnb in {monthLabel(month)}.</p>}
      {rows.length > 0 && (
        <>
          <h4 className={styles.subTitle}>Payments · {rows.length}</h4>
          <table className={styles.listTable}>
            <thead>
              <tr>
                <th>Received</th>
                <th>Prints</th>
                <th className={styles.num}>Amount</th>
                <th>Statement</th>
                <th className={styles.orderCell} aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const removed = p.status === "removed";
                const lock = printed.get(p.id);
                const locked = !!lock && !lock.correcting;
                const months = p.arrangementId ? monthsOf.get(p.arrangementId)?.applied.get(p.id) : undefined;
                const where = removed
                  ? `Removed by ${p.removedBy?.name ?? "an admin"} on ${when(p.removedAt as string)}`
                  : lock
                    ? `Printed on ${lock.reference} (${monthLabel(lock.month)})${locked ? " · locked" : " · being corrected"}`
                    : onStatement.has(p.id)
                      ? `On ${monthLabel(month)}'s statement${monthOfDay(p.day) !== month ? ` · ${monthLabel(monthOfDay(p.day))} was finished` : ""}`
                      : `On the next open statement`;
                const arrangement = p.arrangementId ? arrangements.find((a) => a.id === p.arrangementId) : undefined;
                const items = removed || busy !== null
                  ? []
                  : [
                      ...(arrangement ? [{ label: "Months…", onSelect: () => setApplying(p) }] : []),
                      ...(locked ? [] : [{ label: "Remove…", danger: true, onSelect: () => void remove(p) }]),
                    ];
                return (
                  <tr key={p.id}>
                    <td>{removed ? <s>{shortDay(p.day)}</s> : shortDay(p.day)}</td>
                    <td className={styles.cellWhat}>
                      {removed ? <s>{directLineText(p)}</s> : directLineText(p)}
                      <span className={styles.rowSub}>
                        {[
                          `${DIRECT_METHOD_LABELS[p.method]} · recorded by ${p.recordedBy.name ?? "an admin"}`,
                          p.arrangementId ? (months ? `pays ${months.parts.length > 0 ? appliesToWords(months.parts) : "no month yet"}${months.creditCents > 0 ? ` · ${formatCents(months.creditCents)} credit` : ""}${p.appliesTo ? " (set by hand)" : ""}` : null) : p.stay ? `a stay of ${stayNights(p.stay)} nights, ${rangeText(p.stay.from, p.stay.to)}` : DIRECT_PURPOSE_LABELS[p.purpose],
                          p.note,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </td>
                    <td className={styles.num}>{removed ? <s>{formatCents(p.amountCents)}</s> : formatCents(p.amountCents)}</td>
                    <td className={`${styles.cellWhat} ${locked ? styles.muted : ""}`}>{where}</td>
                    <td className={styles.orderCell}>{items.length > 0 && <RowMenu label={`More for the payment of ${shortDay(p.day)}`} items={items} />}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.some((p) => printed.get(p.id) && !printed.get(p.id)!.correcting && p.status === "recorded") && <p className={styles.note}>A payment printed on a finished statement is locked: correct that statement to change it.</p>}
        </>
      )}

      {recording && data && (
        <RecordPaymentDialog
          properties={null}
          propertyId={propertyId}
          arrangements={data.arrangements}
          payments={data.payments}
          today={today}
          defaultDay={defaultDay}
          onClose={() => setRecording(false)}
          onRecorded={(payment) => {
            setRecording(false);
            show({ tone: "success", title: `Recorded ${formatCents(payment.amountCents)} received ${shortDay(payment.day)}.`, detail: `Prints “${directLineText(payment)}”.` });
            onChanged();
          }}
        />
      )}
      {arranging && (
        <ArrangementDialog
          mode={arranging}
          today={today}
          onClose={() => setArranging(null)}
          onSaved={(arrangement: ArrangementView) => {
            setArranging(null);
            show({ tone: "success", title: arranging.kind === "start" ? `Set up ${arrangement.wording} · ${arrangement.payerName}.` : `Saved: ${arrangement.wording} · ${arrangement.payerName}.` });
            onChanged();
          }}
        />
      )}
      {applying && data && (
        <PaymentMonthsDialog
          payment={applying}
          arrangement={arrangements.find((a) => a.id === applying.arrangementId)!}
          payments={data.payments}
          today={today}
          onClose={() => setApplying(null)}
          onSaved={() => {
            setApplying(null);
            show({ tone: "success", title: "Saved the months it pays." });
            onChanged();
          }}
        />
      )}
      {dialog}
    </section>
  );
}
