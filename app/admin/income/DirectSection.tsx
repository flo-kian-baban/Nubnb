"use client";

/**
 * The Income page's Direct section (part B of PROPERTY-LIST-COLUMNS-PLAN.md, §5; Kian's rulings of 2026-10-15):
 * money paid to Nubnb outside Airbnb, for every property, beside the month's files — income comes in in one place
 * (Kian's ruling of 2026-10-04).
 *
 *   Due now        every arrangement's month not fully paid, overdue first (periods.ts), each a way to its property
 *   Arrangements   every arrangement: its property, words, who pays, amount, due day and state
 *   Received       the month's payments, by the day received: what each prints, the amount, who recorded it;
 *                  a removed one struck through
 *
 * One action: Record a payment, for any property. Its own read (GET /api/admin/direct), apart from the month's
 * files, so neither waits for the other; read again after a payment is recorded.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Plus } from "lucide-react";
import type { Notice } from "../components/Notice";
import { RecordPaymentDialog } from "../components/DirectDialogs";
import { formatCents } from "@/app/lib/cleaners/model";
import { monthLabel, monthOfDay, monthRange } from "@/app/lib/reports/model";
import { DIRECT_METHOD_LABELS, directLineText, dueDayWords, shortDay } from "@/app/lib/direct/model";
import { ARRANGEMENT_STATUS_LABELS, PERIOD_STATE_LABELS, amountFor, arrangementMonths } from "@/app/lib/direct/periods";
import { fetchDirect, type DirectAnswer } from "@/app/lib/direct-client";
import shared from "../page.module.css";
import styles from "./page.module.css";

type Read = { kind: "loading" } | { kind: "error"; title: string } | { kind: "ready"; data: DirectAnswer };

const propertyHref = (id: string, month: string) => `/admin/property?id=${encodeURIComponent(id)}&month=${month}`;

export function DirectSection({ month, properties, show, onRecorded }: { month: string; properties: { id: string; name: string }[]; show: (notice: Notice) => void; onRecorded: () => void }) {
  const [read, setRead] = useState<Read>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [recording, setRecording] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetchDirect().then((result) => {
      if (!cancelled) setRead(result.ok ? { kind: "ready", data: result.data } : { kind: "error", title: result.title });
    });
    return () => {
      cancelled = true;
    };
  }, [attempt]);
  const reread = useCallback(() => setAttempt((n) => n + 1), []);

  const data = read.kind === "ready" ? read.data : null;
  const names = useMemo(() => new Map(properties.map((p) => [p.id, p.name])), [properties]);
  const nameOf = (id: string, fallback: string | null) => names.get(id) ?? fallback ?? "A deleted property";

  const due = useMemo(() => {
    if (!data) return [];
    const rows: { key: string; propertyId: string; wording: string; payerName: string; month: string; expectedCents: number; receivedCents: number; state: "overdue" | "partly"; fallback: string | null }[] = [];
    for (const a of data.arrangements) {
      for (const p of arrangementMonths(a, data.payments, data.today).periods) {
        if (p.state === "overdue" || p.state === "partly") rows.push({ key: `${a.id}:${p.month}`, propertyId: a.propertyId, wording: a.wording, payerName: a.payerName, month: p.month, expectedCents: p.expectedCents, receivedCents: p.receivedCents, state: p.state, fallback: a.propertyNameAtStart });
      }
    }
    return rows.sort((x, y) => (x.state === y.state ? x.month.localeCompare(y.month) : x.state === "overdue" ? -1 : 1));
  }, [data]);
  const received = useMemo(() => (data ? data.payments.filter((p) => monthOfDay(p.day) === month) : []), [data, month]);
  const receivedCents = received.filter((p) => p.status === "recorded").reduce((sum, p) => sum + p.amountCents, 0);

  const firstProperty = data?.arrangements.find((a) => a.untilMonth === null)?.propertyId ?? properties[0]?.id ?? "";
  const defaultDay = data ? (monthRange(month).to < data.today ? monthRange(month).to : data.today) : "";

  return (
    <section className={styles.block} aria-label="Direct">
      <div className={styles.blockHead}>
        <h2 className={styles.blockTitle}>Direct</h2>
        <span className={styles.blockFigure}>{data ? `${formatCents(receivedCents)} received in ${monthLabel(month)} · ${due.length === 0 ? "nothing due" : `${due.length} due`}` : read.kind === "error" ? "—" : "…"}</span>
        <span className={styles.blockAction}>
          <button type="button" className={shared.btnPrimary} onClick={() => setRecording(true)} disabled={!data || properties.length === 0}>
            <Plus size={15} aria-hidden />
            <span>Record a payment</span>
          </button>
        </span>
      </div>
      {read.kind === "error" && <p className={styles.noteWarn}>The direct payments could not be read: {read.title}</p>}
      {data && data.unreadable > 0 && <p className={styles.noteWarn}>{data.unreadable} stored direct {data.unreadable === 1 ? "record is" : "records are"} not in the written shape and left out.</p>}
      {data && data.arrangements.length === 0 && received.length === 0 && <p className={styles.empty}>Nothing received outside Airbnb in {monthLabel(month)}. Arrangements are set up on a property&rsquo;s Income tab.</p>}

      {due.length > 0 && (
        <div className={shared.tableContainer}>
          <div className={styles.tableScroll}>
            <table className={shared.table} aria-label="Due now">
              <thead>
                <tr>
                  <th>Due now</th>
                  <th>Month</th>
                  <th className={styles.num}>Expected</th>
                  <th className={styles.num}>Received</th>
                  <th className={styles.colFit}>State</th>
                </tr>
              </thead>
              <tbody>
                {due.map((row) => (
                  <tr key={row.key}>
                    <td className={styles.cellWhat}>
                      <Link href={propertyHref(row.propertyId, row.month)} prefetch={false} className={styles.linkButton}>
                        {nameOf(row.propertyId, row.fallback)}
                      </Link>
                      <span className={styles.cellSub}>
                        {row.wording} · {row.payerName}
                      </span>
                    </td>
                    <td>{monthLabel(row.month)}</td>
                    <td className={styles.num}>{formatCents(row.expectedCents)}</td>
                    <td className={styles.num}>{formatCents(row.receivedCents)}</td>
                    <td className={styles.colFit}>
                      <span className={`${styles.badge} ${row.state === "overdue" ? styles.badgeWarn : ""}`}>{PERIOD_STATE_LABELS[row.state]}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {data && data.arrangements.length > 0 && (
        <div className={shared.tableContainer}>
          <div className={styles.tableScroll}>
            <table className={shared.table} aria-label="Arrangements">
              <thead>
                <tr>
                  <th>Arrangements · {data.arrangements.length}</th>
                  <th className={styles.num}>A month</th>
                  <th>Due</th>
                  <th className={styles.colFit}>State</th>
                </tr>
              </thead>
              <tbody>
                {data.arrangements.map((a) => {
                  const months = arrangementMonths(a, data.payments, data.today);
                  const now = monthOfDay(data.today);
                  return (
                    <tr key={a.id}>
                      <td className={styles.cellWhat}>
                        <Link href={`${propertyHref(a.propertyId, now)}`} prefetch={false} className={styles.linkButton}>
                          {nameOf(a.propertyId, a.propertyNameAtStart)}
                        </Link>
                        <span className={styles.cellSub}>
                          {a.wording} · {a.payerName} · from {monthLabel(a.fromMonth)}
                          {a.untilMonth ? ` to ${monthLabel(a.untilMonth)}` : ""}
                          {months.creditCents > 0 ? ` · ${formatCents(months.creditCents)} credit` : ""}
                        </span>
                      </td>
                      <td className={styles.num}>{formatCents(amountFor(a, now > a.fromMonth ? now : a.fromMonth))}</td>
                      <td>{dueDayWords(a.dueDay)}</td>
                      <td className={styles.colFit}>
                        <span className={styles.badge}>{ARRANGEMENT_STATUS_LABELS[months.status]}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {received.length > 0 && (
        <div className={shared.tableContainer}>
          <div className={styles.tableScroll}>
            <table className={shared.table} aria-label={`Received in ${monthLabel(month)}`}>
              <thead>
                <tr>
                  <th>Received in {monthLabel(month)}</th>
                  <th>Day</th>
                  <th className={styles.num}>Amount</th>
                  <th>Recorded by</th>
                </tr>
              </thead>
              <tbody>
                {received.map((p) => {
                  const removed = p.status === "removed";
                  return (
                    <tr key={p.id}>
                      <td className={styles.cellWhat}>
                        <Link href={propertyHref(p.propertyId, month)} prefetch={false} className={styles.linkButton}>
                          {nameOf(p.propertyId, p.propertyNameAtRecord)}
                        </Link>
                        <span className={styles.cellSub}>{removed ? <s>{directLineText(p)}</s> : directLineText(p)}{removed ? " · removed" : ""}</span>
                      </td>
                      <td>{shortDay(p.day)}</td>
                      <td className={styles.num}>{removed ? <s>{formatCents(p.amountCents)}</s> : formatCents(p.amountCents)}</td>
                      <td>
                        {p.recordedBy.name ?? "an admin"} · {DIRECT_METHOD_LABELS[p.method]}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {recording && data && (
        <RecordPaymentDialog
          properties={properties}
          propertyId={firstProperty}
          arrangements={data.arrangements}
          payments={data.payments}
          today={data.today}
          defaultDay={defaultDay}
          onClose={() => setRecording(false)}
          onRecorded={(payment) => {
            setRecording(false);
            show({ tone: "success", title: `Recorded ${formatCents(payment.amountCents)} received ${shortDay(payment.day)} for ${nameOf(payment.propertyId, payment.propertyNameAtRecord)}.`, detail: `Prints “${directLineText(payment)}”.` });
            reread();
            onRecorded();
          }}
        />
      )}
    </section>
  );
}
