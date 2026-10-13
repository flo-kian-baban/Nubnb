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
 * row's figures are the month's money's (dispatch 37A, worked out on the
 * server with the read): a finished row shows what the statement printed,
 * how many times its PDF link was made and when last, and Download PDF; a
 * row not finished shows its draft as it stands, marked so; a correction
 * being written is said beside the statement as sent. Income − Costs − Fee −
 * Carried is the Revenue share on every row: the carried balance and any
 * carried balance settled have their column (T7). A replaced statement is
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
 *
 * For a closed month, "Finish empty" opens the list of properties whose month
 * has nothing to report and can be finished together (dispatch 36,
 * EmptyMonthDialog.tsx), each its own statement.
 */

import { useMemo, useState, type ComponentProps, type MouseEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCheck, ChevronLeft, ChevronRight, Download, RefreshCw, X } from "lucide-react";
import { NoticeBanner, useNotice } from "./Notice";
import { EmptyMonthDialog } from "./EmptyMonthDialog";
import { StandingBadge, propertyMonthHref } from "./StatementStatus";
import { fetchStatementLink, type TrackerData } from "@/app/lib/reports-client";
import { formatCents } from "@/app/lib/cleaners/model";
import { addMonths, displayRef, lastClosedMonth, monthLabel, monthName, monthOfDay, type ReportDownloadView } from "@/app/lib/reports/model";
import { downloadMonthZip, type MonthZipStep } from "@/app/lib/backup/download";
import { looseEnds, trackerCounts, trackerRows, type ReportingStatus, type TrackerRow } from "@/app/lib/reports/statement";
import { carriedAllCents, payableText } from "@/app/lib/money/month";
import type { PanelFigures } from "@/app/lib/reports-client";
import { SentAt, whenText } from "../costs/cost-display";
import shared from "../page.module.css";
import styles from "./StatementsPanel.module.css";

const SESSION_HINT = "Your admin session may have expired — reload and sign in again.";
/** What the month's download button says while it works (dispatch 24). */
const ZIP_STEP_WORDS: Record<MonthZipStep, string> = { asking: "Reading the month…", fetching: "Fetching the files…", building: "Making the ZIP…", saving: "Saving…" };

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
  const [zipStep, setZipStep] = useState<MonthZipStep | null>(null);
  const [emptyOpen, setEmptyOpen] = useState(false);

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

  /**
   * The month as a ZIP (Kian's ruling of 2026-10-03): owners' folders and
   * Nubnb's, as the backup will hold them, made in this browser. Its
   * statements count as downloaded, so the rows are read again after.
   */
  const downloadMonth = async () => {
    if (zipStep !== null) return;
    clear();
    setZipStep("asking");
    const result = await downloadMonthZip(month, setZipStep);
    setZipStep(null);
    if (!result.ok) {
      show({ tone: "error", title: result.title, detail: [result.detail, result.status === 401 || result.status === 403 ? SESSION_HINT : null].filter(Boolean).join(" ") });
      return;
    }
    show({ tone: "success", title: `${result.name} saved: ${result.folders} ${result.folders === 1 ? "property" : "properties"}, ${result.files} files.` });
    if (result.statements > 0) onRefresh();
  };

  /** A click anywhere on a row opens the property's page for the month; a click on a control is that control's own. */
  const openRow = (event: MouseEvent<HTMLTableRowElement>, propertyId: string) => {
    if ((event.target as HTMLElement).closest("a, button")) return;
    if (window.getSelection()?.toString()) return;
    router.push(propertyMonthHref(propertyId, month));
  };

  /** The empty statements were finished (dispatch 36): what became of each, said once, and the rows read again. */
  const emptyFinished = (outcome: Parameters<ComponentProps<typeof EmptyMonthDialog>["onFinished"]>[0]) => {
    setEmptyOpen(false);
    if ("unknown" in outcome) {
      show({ ...outcome.unknown, detail: [outcome.unknown.detail, "Some may have been finished. The rows are read again."].filter(Boolean).join(" ") });
      onRefresh();
      return;
    }
    const name = (id: string) => outcome.names.get(id) ?? "A property";
    const finished = outcome.results.filter((r) => r.outcome === "finished");
    const notFinished = outcome.results.filter((r): r is Extract<typeof r, { why: string }> => r.outcome !== "finished");
    show({
      tone: notFinished.length > 0 ? "warning" : "success",
      title: `${finished.length === 1 ? "1 empty statement" : `${finished.length} empty statements`} finished for ${monthLabel(month)}.`,
      detail: notFinished.length > 0 ? `${notFinished.length === 1 ? "1 was" : `${notFinished.length} were`} not:` : undefined,
      items: notFinished.map((r) => `${name(r.propertyId)} — ${r.why}`),
    });
    onRefresh();
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
          {month < thisMonth && (
            <button type="button" className={styles.headBtn} onClick={() => setEmptyOpen(true)} title={`Finish every property whose ${monthLabel(month)} has nothing to report, each its own statement`}>
              <CheckCheck size={15} aria-hidden />
              Finish empty
            </button>
          )}
          <button
            type="button"
            className={styles.headBtn}
            onClick={downloadMonth}
            disabled={zipStep !== null}
            title={`Every property's folder and Nubnb's for ${monthLabel(month)}, as the backup will hold them: statements, workbooks, receipts`}
          >
            <Download size={15} aria-hidden />
            {zipStep ? ZIP_STEP_WORDS[zipStep] : `Download ${monthName(month)}`}
          </button>
          <button type="button" className={styles.iconBtn} onClick={onRefresh} disabled={refreshing} aria-label="Refresh the statements" title="Refresh">
            <RefreshCw size={15} aria-hidden />
          </button>
          <button type="button" className={styles.iconBtn} onClick={onClose} aria-label="Close the statements" title="Close">
            <X size={16} aria-hidden />
          </button>
        </div>
      </div>

      <NoticeBanner notice={notice} onDismiss={clear} className={shared.pageNotice} />
      {emptyOpen && <EmptyMonthDialog month={month} onClose={() => setEmptyOpen(false)} onFinished={emptyFinished} />}

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
                <th className={styles.num} title="The carried balance, and any carried balance settled on this statement">Carried</th>
                <th className={styles.num}>Revenue share</th>
                <th>Exported</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <PanelRow key={row.propertyId} row={row} month={month} money={data.figures?.[month]?.[row.propertyId] ?? null} linking={linking} onDownload={download} onOpen={openRow} />
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
  money,
  linking,
  onDownload,
  onOpen,
}: {
  row: TrackerRow;
  month: string;
  /** The row's figures, the month's money's; null when the month has nothing to show. */
  money: PanelFigures | null;
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
        {money === null ? (
          <>
            <td className={styles.num}><span className={styles.muted}>—</span></td>
            <td className={styles.num}><span className={styles.muted}>—</span></td>
            <td className={styles.num}><span className={styles.muted}>—</span></td>
            <td className={styles.num}><span className={styles.muted}>—</span></td>
            <td className={styles.num}><span className={styles.muted}>—</span></td>
          </>
        ) : (
          <>
            {/* Amounts, named by their column (T9); a row not finished is its draft as it stands, said in grey. */}
            <td className={`${styles.num} ${money.asItStands ? styles.muted : ""}`} title={money.asItStands ? "As it stands: not finished" : undefined}>{formatCents(money.figures.revenueCents)}</td>
            <td className={`${styles.num} ${money.asItStands ? styles.muted : ""}`}>{formatCents(money.figures.costsCents)}</td>
            <td className={`${styles.num} ${money.asItStands ? styles.muted : ""}`}>{formatCents(money.figures.feeCents)}</td>
            <td className={`${styles.num} ${money.asItStands ? styles.muted : ""}`}>{carriedAllCents(money.figures) === 0 ? <span className={styles.muted}>—</span> : formatCents(carriedAllCents(money.figures))}</td>
            <td className={`${styles.num} ${money.asItStands ? styles.muted : ""}`}>
              {payableText(money.figures.payableCents)}
              {money.correction && <span className={styles.note}> · correction {payableText(money.correction.payableCents)}</span>}
            </td>
          </>
        )}
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
          <td colSpan={7}>
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
