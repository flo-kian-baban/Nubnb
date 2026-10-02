"use client";

/**
 * The Costs tab (dispatch 23F): log a cost, and see the month's approved
 * entries — the ledger of dispatch 21, bound to the month.
 *
 * One line at the top: how many approved entries the month holds and what
 * they add up to, with the month's Excel and PDF beside it (Kian's ruling
 * of 2026-09-30: a property's costs come with both exports), and Log a cost
 * (dispatch 23D). Under it, a warning when entries sent in the month are
 * still pending — they are in no statement until reviewed — then the
 * entries, newest first: when sent, who logged it, what was bought, the
 * total. Each is marked when it has changed since the newest cost PDF for
 * its day, and, once the month's statement is finished, when it no longer
 * adds up to what the statement printed. Under them, what else the
 * statement carries: entries of earlier months not reported before, and
 * adjustments to earlier statements.
 *
 * Clicking an entry opens it here, in place of the list: the costs page's
 * pane, with its receipt, its lines, its corrections and its history
 * (Kian's ruling: approved entries stay correctable and removable). A
 * change shows in the statement preview at once.
 *
 * The ledger for any dates is a link away.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { FileSpreadsheet, FileText } from "lucide-react";
import type { Notice } from "../components/Notice";
import { recordPdfExport } from "@/app/lib/costs-client";
import { formatCents, type CostEntryView, type ReportExportView } from "@/app/lib/cleaners/model";
import { buildReport, cleanerLabel, deletedSincePdf, entryPdfState, periodLabel, readPdfRecords, reportFileName, sentDay, shortDay, type EntryPdfState } from "@/app/lib/costs/report";
import { watchList } from "@/app/lib/costs/patterns";
import { pdfFor } from "@/app/lib/costs/pdf";
import { workbookFor } from "@/app/lib/costs/xlsx";
import { monthLabel, monthRange, type MonthlyReportView } from "@/app/lib/reports/model";
import { printedLines, type AnyStatement } from "@/app/lib/reports/statement";
import { EntryPane, type PropertyStatementsState } from "../costs/EntryPane";
import { KindBadge, whenText } from "../costs/cost-display";
import { AddCostForm } from "./AddCostForm";
import styles from "./page.module.css";

const SESSION_HINT = "Your admin session may have expired — reload and sign in again.";

interface Props {
  propertyId: string;
  propertyName: string;
  month: string;
  today: string;
  /** Every entry, every property: the costs page's one read. */
  entries: CostEntryView[];
  /** Every recorded cost PDF. */
  exports: ReportExportView[];
  /** The statement as it stands for the month, for what else it carries; null when it cannot be built. */
  statement: AnyStatement | null;
  /** The finished statement for the month, when there is one: what it printed for each entry. */
  finishedReport: MonthlyReportView | null;
  /** The property's statements, for the open entry's "Property and statement" section. */
  statements: PropertyStatementsState;
  openEntryId: string | null;
  onOpenEntry: (id: string | null) => void;
  onEntryChanged: (entry: CostEntryView) => void;
  /** An entry deleted outright (dispatch 23H). */
  onEntryDeleted: (id: string) => void;
  onEntryAdded: (entry: CostEntryView) => void;
  onExportRecorded: (record: ReportExportView) => void;
  show: (notice: Notice) => void;
}

export function CostsTab({ propertyId, propertyName, month, today, entries, exports, statement, finishedReport, statements, openEntryId, onOpenEntry, onEntryChanged, onEntryDeleted, onEntryAdded, onExportRecorded, show }: Props) {
  const [recording, setRecording] = useState(false);
  const range = monthRange(month);
  const inMonth = (entry: CostEntryView) => {
    const day = sentDay(entry.createdAt);
    return day !== null && day >= range.from && day <= range.to;
  };
  const mine = entries.filter((entry) => entry.property.id === propertyId);
  /** The month's approved entries, newest first. */
  const approved = mine.filter((entry) => entry.status === "approved" && inMonth(entry)).sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "") || a.id.localeCompare(b.id));
  const pending = mine.filter((entry) => entry.status === "pending" && inMonth(entry)).length;
  const readable = approved.filter((entry) => entry.linesNow.kind === "ok");
  const totalCents = readable.reduce((sum, entry) => sum + (entry.linesNow.kind === "ok" ? entry.linesNow.totalCents : 0), 0);
  const taxCents = readable.reduce((sum, entry) => sum + (entry.linesNow.kind === "ok" ? (entry.linesNow.taxCents ?? 0) : 0), 0);
  const unreadable = approved.length - readable.length;

  /** The recorded cost PDFs, and how each entry stands beside the newest for its day. */
  const pdfRecords = useMemo(() => readPdfRecords(exports).records, [exports]);
  const pdfStateOf = (entry: CostEntryView): EntryPdfState | null => (pdfRecords.length === 0 ? null : entryPdfState(entry, pdfRecords));
  /** Recorded PDFs covering the month that list an entry since deleted (dispatch 23H): no row is left to mark, so each is said. */
  const deletedSince = useMemo(
    () => deletedSincePdf(pdfRecords, entries, propertyId).filter(({ record }) => record.from <= range.to && record.to >= range.from),
    [pdfRecords, entries, propertyId, range.from, range.to],
  );
  /** What the finished statement printed for each entry it carried, so a later change shows. */
  const printed = useMemo(() => (finishedReport ? new Map(finishedReport.costs.map((cost) => [cost.entryId, cost.totalCents])) : null), [finishedReport]);
  /** What else the statement carries: earlier-month entries and adjustments, as it prints them. */
  const alsoCarried = useMemo(() => (statement && !statement.legacy ? printedLines({ lines: [], costs: statement.costs.filter((cost) => cost.group === "earlier"), adjustments: statement.adjustments, fee: null }) : []), [statement]);
  const patterns = useMemo(() => watchList(entries, today), [entries, today]);

  const exportReport = async (kind: "pdf" | "xlsx") => {
    if (recording) return;
    const built = buildReport(entries, propertyId, range.from, range.to, new Date(), propertyName);
    if (built.kind === "unreadable") {
      show({ tone: "error", title: "This report cannot be made while an approved entry in it cannot be read.", detail: `Open ${built.entryIds.length === 1 ? "entry" : "entries"} ${built.entryIds.join(", ")} to see why. Nothing was downloaded.` });
      return;
    }
    const { report, pendingLeftOut } = built;
    if (pendingLeftOut > 0 && !window.confirm(`${pendingLeftOut === 1 ? "1 entry" : `${pendingLeftOut} entries`} in ${monthLabel(month)} ${pendingLeftOut === 1 ? "is" : "are"} still pending review and ${pendingLeftOut === 1 ? "is" : "are"} not in the report, which holds approved entries only. Download it anyway?`)) return;
    // A PDF goes to the owner, so it is recorded first (dispatch 21) and downloaded only once the record is stored.
    let printedReport = report;
    if (kind === "pdf") {
      const seen = new Map(entries.map((entry) => [entry.id, entry.history?.length ?? 0]));
      setRecording(true);
      const result = await recordPdfExport({ propertyId: report.propertyId, from: report.from, to: report.to, entries: report.entries.map((entry) => ({ id: entry.id, seen: seen.get(entry.id) ?? 0 })) });
      setRecording(false);
      if (!result.ok) {
        show(
          result.unknown
            ? { tone: "warning", title: "The PDF was not downloaded. Its record may or may not have been made: Refresh to see what is on record.", detail: result.title }
            : { tone: "error", title: `The PDF was not downloaded. ${result.title}`, detail: [result.detail, result.status === 401 || result.status === 403 ? SESSION_HINT : null].filter(Boolean).join(" ") },
        );
        return;
      }
      const record = result.data.export;
      onExportRecorded(record);
      printedReport = { ...report, generatedAt: new Date(record.createdAt ?? report.generatedAt), propertyName: record.propertyNameAtExport ?? report.propertyName };
    }
    const bytes = kind === "pdf" ? pdfFor(printedReport) : workbookFor(printedReport);
    const type = kind === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = reportFileName(printedReport, kind);
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    show({
      tone: "success",
      title: `Downloaded the ${kind === "pdf" ? "PDF" : "Excel file"} for ${printedReport.propertyName}.`,
      detail: `${periodLabel(report.from, report.to)} · ${report.entries.length === 1 ? "1 approved entry" : `${report.entries.length} approved entries`} · ${formatCents(report.totalCents)}${pendingLeftOut > 0 ? ` · ${pendingLeftOut} pending left out` : ""}${kind === "pdf" ? " · recorded, so a later correction shows against it" : ""}`,
    });
  };

  // ── The open entry, in place of the list ──
  if (openEntryId !== null) {
    const entry = entries.find((e) => e.id === openEntryId) ?? null;
    if (!entry) {
      return (
        <section className={styles.block} aria-label="Entry">
          <p className={styles.note}>This entry is not in the list. It may have been opened from an old link.</p>
          <button type="button" className={`${styles.btnGhost} ${styles.btnSmall}`} onClick={() => onOpenEntry(null)}>
            Back to the costs
          </button>
        </section>
      );
    }
    return (
      <div className={styles.entryDrill}>
        <div className={styles.drillHead}>
          <button type="button" className={styles.linkButton} onClick={() => onOpenEntry(null)}>
            ← {monthLabel(month)}’s costs
          </button>
        </div>
        <EntryPane
          key={entry.id}
          entry={entry}
          pdf={pdfStateOf(entry)}
          pattern={entry.cleaner.id === null ? null : (patterns.find((pattern) => pattern.cleanerId === entry.cleaner.id) ?? null)}
          statements={statements}
          onChanged={onEntryChanged}
          onDeleted={(id, done) => {
            onOpenEntry(null);
            onEntryDeleted(id);
            show(done);
          }}
          onClose={() => onOpenEntry(null)}
        />
      </div>
    );
  }

  return (
    <section className={styles.block} aria-label="Costs">
      <div className={styles.costsHead}>
        <span className={styles.costsTotal}>
          {approved.length === 0 ? `No approved costs in ${monthLabel(month)}.` : `${approved.length === 1 ? "1 approved entry" : `${approved.length} approved entries`} · ${formatCents(totalCents)}${taxCents > 0 ? ` · tax ${formatCents(taxCents)}` : ""}`}
          {unreadable > 0 && <span className={styles.noteWarn}> · {unreadable} cannot be added up</span>}
        </span>
        <span className={styles.blockActions}>
          <button type="button" className={styles.btnGhost} disabled={recording} onClick={() => exportReport("xlsx")} title={`Approved entries of ${monthLabel(month)}, as a workbook`}>
            <FileSpreadsheet size={14} aria-hidden />
            <span>Excel</span>
          </button>
          <button type="button" className={styles.btnGhost} disabled={recording} onClick={() => exportReport("pdf")} title={`For the owner: approved entries of ${monthLabel(month)}, no names. Recorded, so a later correction shows against it.`}>
            <FileText size={14} aria-hidden />
            <span>{recording ? "Recording…" : "PDF"}</span>
          </button>
          <AddCostForm propertyId={propertyId} propertyName={propertyName} onAdded={onEntryAdded} show={show} />
        </span>
      </div>

      {pending > 0 && (
        <p className={styles.noteWarn} role="status">
          {pending === 1 ? "1 entry" : `${pending} entries`} sent in {monthLabel(month)} {pending === 1 ? "is" : "are"} pending and in no statement until reviewed.{" "}
          <Link href={`/admin/costs?property=${encodeURIComponent(propertyId)}`} prefetch={false} className={styles.linkButton}>
            Review
          </Link>
        </p>
      )}

      {deletedSince.map(({ record, printed }) => (
        <p key={record.id} className={styles.noteWarn} role="status">
          The cost PDF exported {whenText(record.createdAt)} for {periodLabel(record.from, record.to)} lists{" "}
          {printed.length === 1 ? "an entry" : `${printed.length} entries`} since deleted, at{" "}
          {formatCents(printed.reduce((sum, entry) => sum + entry.totalCents, 0))}: whoever received it holds a total that includes{" "}
          {printed.length === 1 ? "it" : "them"}.
        </p>
      ))}

      {approved.length === 0 && alsoCarried.length === 0 ? null : (
        <table className={styles.costTable}>
          <thead>
            <tr>
              <th className={styles.costWhen}>Submitted</th>
              <th>Logged by</th>
              <th className={styles.num}>Total</th>
            </tr>
          </thead>
          <tbody>
            {approved.map((entry) => {
              const day = sentDay(entry.createdAt);
              const now = entry.linesNow;
              const pdf = pdfStateOf(entry);
              const wasPrinted = printed?.get(entry.id);
              return (
                <tr key={entry.id} className={styles.costRow} onClick={() => onOpenEntry(entry.id)}>
                  {/* The cost is named by the day it was submitted (Kian, 2026-10-01): what was bought is in the entry it opens. */}
                  <td className={styles.costWhen}>
                    <button
                      type="button"
                      className={styles.rowButton}
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenEntry(entry.id);
                      }}
                    >
                      {day ? shortDay(day) : "—"}
                    </button>
                  </td>
                  <td>
                    {cleanerLabel(entry)}
                    <KindBadge kind={entry.kind} />
                  </td>
                  <td className={styles.num}>
                    {now.kind === "ok" ? (
                      <>
                        <span title={now.corrected ? `Corrected; sent as ${formatCents(now.sentTotalCents)}` : undefined}>
                          {now.corrected ? "✎ " : ""}
                          {formatCents(now.totalCents)}
                        </span>
                        {wasPrinted !== undefined && wasPrinted !== now.totalCents && (
                          <span className={`${styles.costMark} ${styles.costMarkWarn}`} title={`The finished statement printed this entry at ${formatCents(wasPrinted)}.`}>
                            statement says {formatCents(wasPrinted)}
                          </span>
                        )}
                        {pdf !== null && pdf.latest !== "same" && pdf.latest !== "not-listed" && (
                          <span className={`${styles.costMark} ${pdf.latest === "corrected" ? "" : styles.costMarkWarn}`} title={`The cost PDF exported ${whenText(pdf.lastListed.record.createdAt)} shows this entry at ${formatCents(pdf.lastListed.printed.totalCents)}.`}>
                            {pdf.latest === "corrected" ? "corrected since PDF" : "changed since PDF"}
                          </span>
                        )}
                      </>
                    ) : (
                      <span className={styles.noteWarn} title={now.reason}>
                        Cannot add up
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
            {alsoCarried.length > 0 && (
              <tr className={styles.costGroup}>
                <td colSpan={3}>Also in this statement</td>
              </tr>
            )}
            {alsoCarried.map((row) => (
              <tr key={row.key} className={row.entryId ? styles.costRow : undefined} onClick={row.entryId ? () => onOpenEntry(row.entryId) : undefined}>
                <td colSpan={2} className={styles.costWhat}>
                  {row.description}
                </td>
                <td className={styles.num}>{formatCents(row.amountCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className={`${styles.note} ${styles.costsFoot}`}>
        <Link href={`/admin/costs?property=${encodeURIComponent(propertyId)}&status=approved`} prefetch={false} className={styles.linkButton}>
          Ledger: all dates, Excel and PDF
        </Link>
      </p>
    </section>
  );
}
