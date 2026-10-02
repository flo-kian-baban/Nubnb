"use client";

/**
 * The statements panel on the admin home (dispatch 23F, Kian's ruling of
 * 2026-10-01): the cross-property view that was the Reports section's
 * tracker (dispatch 23B), moved under the Statements tile. Click the tile
 * and this opens; one row per property, its status for the month, and each
 * row the way into that property's page for that month, where the
 * statement is written.
 *
 * Nothing about the data changes: the same one read, GET
 * /api/admin/monthly-reports, and the same pure functions (reports/
 * statement.ts) give the line at the top, the rows and the loose ends. A
 * finished row shows what the statement printed, how many times its PDF
 * link was made and when last, and Download PDF; a replaced statement is
 * listed under its row, marked, with the reason.
 *
 * Each row's badge is the month's standing in Nubnb's cycle (dispatch 23G,
 * `monthStanding`, the rule the property list's column and the tile use):
 * Finished; Due for the previous month and Past due for an earlier one,
 * when no statement is finished; "Open, not yet due" for the current month
 * (dispatch 23D). A draft is said beside the badge, not instead of it. Rows
 * sort past due first, then due, then open, then finished. Under the line,
 * the months other than the one shown that hold statements past due, each a
 * way to that month.
 */

import { useMemo, useState, type MouseEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, Download, RefreshCw, X } from "lucide-react";
import { NoticeBanner, useNotice } from "./Notice";
import { StandingBadge, propertyMonthHref } from "./StatementStatus";
import { fetchStatementLink, type TrackerData } from "@/app/lib/reports-client";
import { formatCents } from "@/app/lib/cleaners/model";
import { addMonths, displayRef, lastClosedMonth, monthLabel, monthOfDay, type ReportDownloadView } from "@/app/lib/reports/model";
import { looseEnds, trackerCounts, trackerRows, type ReportingStatus, type TrackerRow } from "@/app/lib/reports/statement";
import { SentAt, whenText } from "../costs/cost-display";
import shared from "../page.module.css";
import styles from "./StatementsPanel.module.css";

const SESSION_HINT = "Your admin session may have expired — reload and sign in again.";

interface Props {
  data: TrackerData;
  /** Every property's status, by property ID: the months past due other than the one shown. */
  statuses: Map<string, ReportingStatus>;
  month: string;
  /** Today, yyyy-mm-dd in Toronto. */
  today: string;
  onMonth: (month: string) => void;
  onClose: () => void;
  onRefresh: () => void;
  refreshing: boolean;
  /** A download link was made: the record, so the row's count changes. */
  onDownloaded: (record: ReportDownloadView) => void;
}

export function StatementsPanel({ data, statuses, month, today, onMonth, onClose, onRefresh, refreshing, onDownloaded }: Props) {
  const router = useRouter();
  const { notice, show, clear } = useNotice();
  const [linking, setLinking] = useState<string | null>(null);

  const rows = useMemo<TrackerRow[]>(() => trackerRows({ month, today, ...data }), [data, month, today]);
  const counts = useMemo(() => trackerCounts(rows), [rows]);
  /** The other months with statements past due, oldest first, and how many in each. */
  const pastDueElsewhere = useMemo(() => {
    const byMonth = new Map<string, number>();
    for (const status of statuses.values()) for (const m of status.pastDue) if (m !== month) byMonth.set(m, (byMonth.get(m) ?? 0) + 1);
    return [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [statuses, month]);
  const ends = useMemo(() => {
    const names = new Map(data.properties.map((p) => [p.id, p.name?.trim() || "Unnamed property"]));
    return looseEnds(month, data.entries, data.reports, data.management, (id) => names.get(id) ?? "Unknown property");
  }, [data, month]);

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
    onDownloaded(result.data.download);
    show({ tone: "success", title: `The PDF link opened; it works for ${result.data.seconds} seconds.` });
  };

  /** A click anywhere on a row opens the property's page for the month; a click on a control is that control's own. */
  const openRow = (event: MouseEvent<HTMLTableRowElement>, propertyId: string) => {
    if ((event.target as HTMLElement).closest("a, button")) return;
    if (window.getSelection()?.toString()) return;
    router.push(propertyMonthHref(propertyId, month));
  };

  const thisMonth = monthOfDay(today);
  const monthWord = month === lastClosedMonth(today) ? "last closed month" : month === thisMonth ? "current month" : month > thisMonth ? "not started yet" : "closed";
  const unreadable = data.unreadable.reports + data.unreadable.drafts;

  return (
    <section className={styles.panel} aria-label="Statements">
      <div className={styles.head}>
        <button type="button" className={styles.monthStep} aria-label="Previous month" onClick={() => onMonth(addMonths(month, -1))}>
          <ChevronLeft size={18} aria-hidden />
        </button>
        <h2 className={styles.monthTitle}>{monthLabel(month)}</h2>
        <button type="button" className={styles.monthStep} aria-label="Next month" onClick={() => onMonth(addMonths(month, 1))}>
          <ChevronRight size={18} aria-hidden />
        </button>
        <span className={styles.note}>{monthWord}</span>
        <div className={styles.headRight}>
          <button type="button" className={styles.iconBtn} onClick={onRefresh} disabled={refreshing} aria-label="Refresh the statements" title="Refresh">
            <RefreshCw size={15} aria-hidden />
          </button>
          <button type="button" className={styles.iconBtn} onClick={onClose} aria-label="Close the statements" title="Close">
            <X size={16} aria-hidden />
          </button>
        </div>
      </div>

      <NoticeBanner notice={notice} onDismiss={clear} className={shared.pageNotice} />

      <p className={`${styles.line} ${counts.pastDue > 0 ? styles.linePastDue : counts.due > 0 ? styles.lineAlert : ""}`}>
        <strong>{counts.finished} of {counts.owed}</strong> statements finished
        {counts.pastDue > 0 && <> · {counts.pastDue} past due</>}
        {counts.due > 0 && <> · {counts.due} due</>}
        {counts.open > 0 && <> · {counts.open} open, not yet due</>}
        {counts.drafts > 0 && <> · {counts.drafts} {counts.drafts === 1 ? "draft" : "drafts"} in progress</>}
        {unreadable > 0 && <span className={styles.noteWarn}> · {unreadable} stored {unreadable === 1 ? "document is" : "documents are"} not in the written shape and left out</span>}
      </p>
      {pastDueElsewhere.length > 0 && (
        <p className={`${styles.line} ${styles.linePastDue}`}>
          Past due in other months:{" "}
          {pastDueElsewhere.map(([m, n], i) => (
            <span key={m}>
              {i > 0 && " · "}
              <button type="button" className={styles.linkButton} onClick={() => onMonth(m)}>
                {monthLabel(m)}
              </button>{" "}
              ({n})
            </span>
          ))}
        </p>
      )}

      {rows.length === 0 ? (
        <div className={styles.empty}>
          <h3>No property expects a statement for {monthLabel(month)}</h3>
          <p className={styles.note}>Statements run from each property’s first statement month.</p>
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
                <PanelRow key={row.propertyId} row={row} month={month} linking={linking} onDownload={download} onOpen={openRow} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(ends.pending.length > 0 || ends.late.length > 0 || ends.adjustments.length > 0) && (
        <section className={styles.looseEnds} aria-label="Loose ends">
          <h3>Loose ends</h3>
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
    </section>
  );
}

function PanelRow({
  row,
  month,
  linking,
  onDownload,
  onOpen,
}: {
  row: TrackerRow;
  month: string;
  linking: string | null;
  onDownload: (reportId: string) => void;
  onOpen: (event: MouseEvent<HTMLTableRowElement>, propertyId: string) => void;
}) {
  const href = propertyMonthHref(row.propertyId, month);
  const { state } = row;
  /** The month's current finished statement: the row's figures, its exports and its PDF; with a correction in progress beside it, still this one. */
  const live = state.kind === "finished" ? state.report : row.standing === "finished" ? (row.reports.find((r) => r.replacedBy === null)?.report ?? null) : null;
  const replaced = row.reports.filter((r) => r.replacedBy !== null);
  return (
    <>
      <tr className={styles.row} onClick={(event) => onOpen(event, row.propertyId)} aria-label={`Open ${row.propertyName} for ${monthLabel(month)}`}>
        <td>
          <Link href={href} prefetch={false} className={styles.propertyLink}>
            {row.propertyName}
          </Link>
        </td>
        <td>
          <span className={styles.stateCell}>
            <StandingBadge standing={row.standing} />
            {live && (
              <span className={styles.note}>
                <SentAt iso={live.finishedAt} /> · <span className={styles.mono}>{displayRef(live)}</span>
                {replaced.length > 0 && ` · replaced ×${replaced.length}`}
              </span>
            )}
            {state.kind === "draft" && (
              <span className={styles.note}>
                {state.superseding ? "correction in progress" : "draft"}, saved <SentAt iso={state.savedAt} />
              </span>
            )}
          </span>
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
            {live && (
              <button type="button" className={styles.btnSmall} disabled={linking !== null} onClick={() => onDownload(live.id)}>
                <Download size={13} aria-hidden />
                <span>{linking === live.id ? "Opening…" : "PDF"}</span>
              </button>
            )}
          </span>
        </td>
      </tr>
      {replaced.map(({ report, replacedBy }) => (
        <tr key={report.id}>
          <td />
          <td colSpan={6}>
            <span className={`${shared.stateBadge} ${shared.stateReplaced}`}>Replaced</span>{" "}
            <span className={styles.note}>
              <span className={styles.mono}>{displayRef(report)}</span>, finished <SentAt iso={report.finishedAt} />, replaced on {whenText(replacedBy!.finishedAt)} by{" "}
              <span className={styles.mono}>{displayRef(replacedBy!)}</span>: “{replacedBy!.supersedes?.reason}”
            </span>
          </td>
          <td>
            <span className={styles.rowActions}>
              <button type="button" className={styles.btnSmall} disabled={linking !== null} onClick={() => onDownload(report.id)}>
                <Download size={13} aria-hidden />
                <span>{linking === report.id ? "Opening…" : "PDF"}</span>
              </button>
            </span>
          </td>
        </tr>
      ))}
    </>
  );
}
