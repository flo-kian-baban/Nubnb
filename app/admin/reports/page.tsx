"use client";

/**
 * Reports: the statements tracker (dispatch 23B, plan §2.6). Opens on the
 * last closed month, with a control to move back or forward. One read,
 * GET /api/admin/monthly-reports, and everything on the page — the line at
 * the top, the table, the loose ends — is worked out here from that answer
 * by the same pure functions the home tile uses (reports/statement.ts).
 *
 * One row per property in scope for the month: outstanding first, in the
 * alert tone and in those words, then open, then drafts, then finished. A
 * finished row shows what the statement printed, how many times its PDF
 * link was made and when last, Open and Download PDF. A replaced statement
 * is listed under its row, marked "Replaced", with the reason. Every row
 * links to the property's own page, where its costs, income and statements
 * are (dispatch 23D).
 *
 * "Outstanding" is a closed month with no finished statement. The current
 * month reads "Open, not yet due" and is never outstanding; a statement may
 * still be finished for it (Kian's ruling of 2026-09-30).
 *
 * The backup column and panel are part C and are not here.
 *
 * "Could not load" is never "nothing outstanding": a failed read shows no
 * table and no counts.
 */

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, ChevronLeft, ChevronRight, Download, FileText, RefreshCw } from "lucide-react";
import { AdminHeader } from "../components/AdminHeader";
import { PinGate } from "../components/PinGate";
import { NoticeBanner, useNotice } from "../components/Notice";
import { fetchStatementLink, fetchTracker, type TrackerData } from "@/app/lib/reports-client";
import { formatCents } from "@/app/lib/cleaners/model";
import { torontoDayOf } from "@/app/lib/costs/report";
import { addMonths, displayRef, isMonth, lastClosedMonth, monthLabel, monthOfDay } from "@/app/lib/reports/model";
import { STATEMENT_STATE_LABELS, looseEnds, trackerCounts, trackerRows, type TrackerRow } from "@/app/lib/reports/statement";
import { SentAt, whenText } from "../costs/cost-display";
import shared from "../page.module.css";
import styles from "./page.module.css";

type ListState = { kind: "loading" } | { kind: "ready"; data: TrackerData } | { kind: "error"; title: string; detail?: string; status: number };

const SESSION_HINT = "Your admin session may have expired — reload and sign in again.";

export default function ReportsPage() {
  return (
    <PinGate>
      <Suspense fallback={null}>
        <Reports />
      </Suspense>
    </PinGate>
  );
}

function Reports() {
  const params = useSearchParams();
  const today = torontoDayOf(new Date());
  const [month, setMonth] = useState(() => {
    const wanted = params.get("month");
    return isMonth(wanted) ? wanted : lastClosedMonth(today);
  });
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [linking, setLinking] = useState<string | null>(null);
  const { notice, show, clear } = useNotice();

  useEffect(() => {
    let cancelled = false;
    fetchTracker().then((result) => {
      if (cancelled) return;
      setList(result.ok ? { kind: "ready", data: result.data } : { kind: "error", title: result.title, detail: result.detail, status: result.status });
    });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("month", month);
    if (url.href !== window.location.href) window.history.replaceState(null, "", url.href);
  }, [month]);

  const reload = () => {
    clear();
    setList({ kind: "loading" });
    setAttempt((n) => n + 1);
  };

  const rows = useMemo<TrackerRow[]>(() => (list.kind === "ready" ? trackerRows({ month, today, ...list.data }) : []), [list, month, today]);
  const counts = useMemo(() => trackerCounts(rows), [rows]);
  const ends = useMemo(() => {
    if (list.kind !== "ready") return null;
    const names = new Map(list.data.properties.map((p) => [p.id, p.name?.trim() || "Unnamed property"]));
    // The summaries carry each report's entry list and what it printed per entry, which is all the loose ends read.
    return looseEnds(month, list.data.entries, list.data.reports, list.data.management, (id) => names.get(id) ?? "Unknown property");
  }, [list, month]);

  const download = async (reportId: string) => {
    if (linking !== null) return;
    clear();
    setLinking(reportId);
    const result = await fetchStatementLink(reportId);
    setLinking(null);
    if (!result.ok) {
      show({ tone: "error", title: result.title, detail: [result.detail, result.status === 401 || result.status === 403 ? SESSION_HINT : null].filter(Boolean).join(" ") });
      return;
    }
    window.open(result.data.url, "_blank", "noopener");
    setList((prev) => (prev.kind === "ready" ? { kind: "ready", data: { ...prev.data, downloads: [...prev.data.downloads, result.data.download] } } : prev));
    show({ tone: "success", title: `The PDF link opened; it works for ${result.data.seconds} seconds.`, detail: "The download is recorded; the tracker shows it." });
  };

  const current =
    month === lastClosedMonth(today) ? "the last closed month" : month === monthOfDay(today) ? "the current month: open, not yet due" : month > monthOfDay(today) ? "not started yet" : "closed";

  return (
    <div className={shared.container}>
      <AdminHeader current="reports">
        <button type="button" className={shared.btnGhost} onClick={reload} disabled={list.kind === "loading"}>
          <RefreshCw size={15} aria-hidden />
          <span>Refresh</span>
        </button>
      </AdminHeader>

      <main className={shared.main}>
        <NoticeBanner notice={notice} onDismiss={clear} className={shared.pageNotice} />

        <div className={styles.monthRow}>
          <button type="button" className={styles.monthStep} aria-label="Previous month" onClick={() => setMonth((m) => addMonths(m, -1))}>
            <ChevronLeft size={18} aria-hidden />
          </button>
          <h2 className={styles.monthTitle}>{monthLabel(month)}</h2>
          <button type="button" className={styles.monthStep} aria-label="Next month" onClick={() => setMonth((m) => addMonths(m, 1))}>
            <ChevronRight size={18} aria-hidden />
          </button>
          <span className={styles.note}>{current}</span>
        </div>

        {list.kind === "loading" ? (
          <div className={shared.loading}>
            <div className={shared.spinner} />
            <p>Loading statements…</p>
          </div>
        ) : list.kind === "error" ? (
          <div className={`${shared.empty} ${shared.loadError}`} role="alert">
            <AlertTriangle size={48} strokeWidth={1} />
            <h2>Could not load the statements</h2>
            <p>
              It is not empty — it has not loaded.
              {(list.status === 401 || list.status === 403) && ` ${SESSION_HINT}`}
            </p>
            <code className={shared.loadErrorDetail}>
              {list.title}
              {list.detail ? ` ${list.detail}` : ""}
            </code>
            <button type="button" className={shared.btnPrimary} onClick={reload}>
              <RefreshCw size={18} />
              <span>Retry</span>
            </button>
          </div>
        ) : (
          <>
            <p className={`${styles.line} ${counts.outstanding > 0 ? styles.lineAlert : ""}`}>
              <strong>{monthLabel(month)}</strong> · {counts.finished} of {counts.inScope} statements finished · {counts.outstanding} outstanding
              {counts.open > 0 && <> · {counts.open} open, not yet due</>} · {counts.drafts} {counts.drafts === 1 ? "draft" : "drafts"} in progress
              {(list.data.unreadable.reports > 0 || list.data.unreadable.drafts > 0) && (
                <span className={styles.noteWarn}>
                  {" "}
                  · {list.data.unreadable.reports + list.data.unreadable.drafts} stored {list.data.unreadable.reports + list.data.unreadable.drafts === 1 ? "document is" : "documents are"} not in the written shape and {list.data.unreadable.reports + list.data.unreadable.drafts === 1 ? "is" : "are"} left out
                </span>
              )}
            </p>

            {rows.length === 0 ? (
              <div className={shared.empty}>
                <FileText size={48} strokeWidth={1} />
                <h2>No property expects a statement for {monthLabel(month)}</h2>
                <p>Statements run from each property’s first statement month (October 2026 unless its record says otherwise).</p>
              </div>
            ) : (
              <div className={shared.tableContainer}>
                <table className={shared.table}>
                  <thead>
                    <tr>
                      <th>Property</th>
                      <th>Statement</th>
                      <th className={styles.num}>Income</th>
                      <th className={styles.num}>Costs</th>
                      <th className={styles.num}>Fee</th>
                      <th className={styles.num}>Revenue share</th>
                      <th>Exported</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <TrackerLine key={row.propertyId} row={row} month={month} linking={linking} onDownload={download} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {ends && (ends.pending.length > 0 || ends.late.length > 0 || ends.adjustments.length > 0) && (
              <section className={styles.looseEnds} aria-label="Loose ends">
                <h2>Loose ends</h2>
                <ul>
                  {ends.pending.map((end) => (
                    <li key={`p-${end.propertyId}`}>
                      {end.count === 1 ? "1 entry" : `${end.count} entries`} sent in {monthLabel(month)} for {end.propertyName} {end.count === 1 ? "is" : "are"} still pending: in no statement until reviewed.{" "}
                      <Link href={`/admin/costs?property=${encodeURIComponent(end.propertyId)}`} prefetch={false} className={styles.linkButton}>
                        Review
                      </Link>
                    </li>
                  ))}
                  {ends.late.map((end) => (
                    <li key={`l-${end.propertyId}`}>
                      {end.count === 1 ? "1 approved entry" : `${end.count} approved entries`} for {end.propertyName} {end.count === 1 ? "is" : "are"} in no current statement: {end.count === 1 ? "it" : "they"} will go into the next one.
                    </li>
                  ))}
                  {ends.adjustments.map((end) => (
                    <li key={`a-${end.propertyId}`}>
                      {end.count === 1 ? "1 adjustment" : `${end.count} adjustments`} for {end.propertyName}: an entry a statement printed has changed since, and will go into the next statement — or correct the statement that printed it.
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function TrackerLine({ row, month, linking, onDownload }: { row: TrackerRow; month: string; linking: string | null; onDownload: (reportId: string) => void }) {
  const open = `/admin/reports/edit?property=${encodeURIComponent(row.propertyId)}&month=${month}`;
  const propertyPage = `/admin/costs?property=${encodeURIComponent(row.propertyId)}&status=approved`;
  const { state } = row;
  const live = state.kind === "finished" ? state.report : null;
  const replaced = row.reports.filter((r) => r.replacedBy !== null);
  return (
    <>
      <tr>
        <td>
          <Link href={open} prefetch={false} className={styles.linkButton}>
            {row.propertyName}
          </Link>
        </td>
        <td>
          {state.kind === "outstanding" && <span className={`${styles.badge} ${styles.badgeOutstanding}`}>{STATEMENT_STATE_LABELS.outstanding}</span>}
          {state.kind === "open" && <span className={`${styles.badge} ${styles.badgeOpen}`}>{STATEMENT_STATE_LABELS.open}</span>}
          {state.kind === "draft" && (
            <span>
              <span className={`${styles.badge} ${styles.badgeDraft}`}>{state.superseding ? "Correction in progress" : "Draft"}</span>{" "}
              <span className={styles.note}>
                saved <SentAt iso={state.savedAt} />
              </span>
            </span>
          )}
          {state.kind === "finished" && (
            <span>
              <span className={`${styles.badge} ${styles.badgeFinished}`}>Finished</span>{" "}
              <span className={styles.note}>
                <SentAt iso={state.report.finishedAt} /> · <span className={styles.mono}>{displayRef(state.report)}</span>
                {state.replaced > 0 && ` · replaced ×${state.replaced}`}
              </span>
            </span>
          )}
        </td>
        <td className={styles.num}>{live ? formatCents(live.incomeCents) : <span className={styles.muted}>—</span>}</td>
        <td className={styles.num}>{live ? formatCents(live.costsCents) : <span className={styles.muted}>—</span>}</td>
        <td className={styles.num}>{live ? formatCents(live.feeCents) : <span className={styles.muted}>—</span>}</td>
        <td className={styles.num}>{live ? (live.payableCents < 0 ? `${formatCents(live.payableCents)} owed to NuBNB` : formatCents(live.payableCents)) : <span className={styles.muted}>—</span>}</td>
        <td>
          {live ? (
            row.downloads === 0 ? (
              <span className={styles.muted}>Never</span>
            ) : (
              <span className={styles.note}>
                downloaded {row.downloads === 1 ? "once" : row.downloads === 2 ? "twice" : `${row.downloads} times`}, last {whenText(row.lastDownloadAt)}
              </span>
            )
          ) : (
            <span className={styles.muted}>—</span>
          )}
        </td>
        <td>
          <span className={styles.rowActions}>
            <Link href={open} prefetch={false} className={`${styles.btnGhost} ${styles.btnSmall}`}>
              {state.kind === "finished" ? "Open" : state.kind === "draft" ? "Continue" : "Start"}
            </Link>
            <Link href={propertyPage} prefetch={false} className={`${styles.btnGhost} ${styles.btnSmall}`} title="The property's page: its costs, income and statements">
              Property
            </Link>
            {live && (
              <button type="button" className={`${styles.btnGhost} ${styles.btnSmall}`} disabled={linking !== null} onClick={() => onDownload(live.id)}>
                <Download size={13} aria-hidden />
                <span>{linking === live.id ? "Opening…" : "Download PDF"}</span>
              </button>
            )}
          </span>
        </td>
      </tr>
      {replaced.map(({ report, replacedBy }) => (
        <tr key={report.id}>
          <td />
          <td colSpan={6}>
            <span className={`${styles.badge} ${styles.badgeReplaced}`}>Replaced</span>{" "}
            <span className={styles.note}>
              <span className={styles.mono}>{displayRef(report)}</span>, finished <SentAt iso={report.finishedAt} />, replaced on {whenText(replacedBy!.finishedAt)} by{" "}
              <span className={styles.mono}>{displayRef(replacedBy!)}</span>: “{replacedBy!.supersedes?.reason}”
            </span>
          </td>
          <td>
            <button type="button" className={`${styles.btnGhost} ${styles.btnSmall}`} disabled={linking !== null} onClick={() => onDownload(report.id)}>
              <Download size={13} aria-hidden />
              <span>{linking === report.id ? "Opening…" : "Download PDF"}</span>
            </button>
          </td>
        </tr>
      ))}
    </>
  );
}
