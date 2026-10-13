"use client";

/**
 * The Costs tab (dispatch 23F): log a cost, and see the month's approved
 * entries — the ledger of dispatch 21, bound to the month.
 *
 * Its figures are the month's money's (dispatch 37A, app/lib/money/month.ts;
 * Kian's ruling of 2026-10-13: every page showing a property-month's figures
 * reads them through the one calculation). The block's head: how many
 * approved entries the month holds and what they add up to, and, when any of
 * them is charged on another month's statement, which statements charge
 * them and how much — "$100.00 on September 2026's statement · $50.00 on
 * October 2026's" (T1) — with the month's Excel and PDF beside it (Kian's
 * ruling of 2026-09-30: a property's costs come with both exports), and Log a
 * cost (dispatch 23D), which opens its form under the head, as the Income
 * tab's does (Kian, 2026-10-02). Under it, a warning when entries sent in the
 * month are still pending — they are in no statement until reviewed — then
 * the entries, newest first: when sent, who logged it, the total. Each is
 * marked when it has changed since the newest cost PDF for its day, and when
 * a statement other than its month's charges it, or charges it a different
 * amount: the mark names each statement and its part. An entry removed or
 * rejected after a statement printed it stays listed, marked, with what was
 * charged and given back, so the head adds up to the statements. Under them,
 * what else the month's statement charges: entries of earlier months, and
 * adjustments to earlier statements, as cost amounts (T9).
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
import { FileSpreadsheet, FileText, Plus } from "lucide-react";
import type { Notice } from "../components/Notice";
import { useAsk } from "../components/AskDialog";
import { recordPdfExport } from "@/app/lib/costs-client";
import { formatCents, type CostEntryView, type ReportExportView } from "@/app/lib/cleaners/model";
import { buildReport, cleanerLabel, deletedSincePdf, entryPdfState, officeWhen, periodLabel, readPdfRecords, reportFileName, sentDay, shortDay, type EntryPdfState } from "@/app/lib/costs/report";
import { watchList } from "@/app/lib/costs/patterns";
import { pdfFor } from "@/app/lib/costs/pdf";
import { workbookFor } from "@/app/lib/costs/xlsx";
import { monthLabel, monthRange } from "@/app/lib/reports/model";
import { chargesByMonth, type Charge, type CostLine, type MonthMoney } from "@/app/lib/money/month";
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
  /** The month's money (dispatch 37A): its cost lines, where each is charged, and what else its statement charges. */
  money: MonthMoney;
  /** Every statement that charges each of the property's entries, for the month's Excel and PDF. */
  charges: ReadonlyMap<string, Charge[]>;
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

/**
 * Where a cost line is charged, in words, when that is not simply its own month's statement at what it adds up to
 * now: "on October 2026's statement", or each statement with its part. null otherwise.
 */
function chargeWords(line: CostLine, month: string): string | null {
  const parts = chargesByMonth(line.charges);
  if (line.state === "confirmed" && parts.length === 1 && parts[0].month === month && parts[0].cents === line.nowCents) return null;
  if (parts.length === 0) return line.state === "confirmed" ? "on no statement" : null;
  if (parts.length === 1 && parts[0].cents === line.nowCents) return `on ${monthLabel(parts[0].month)}’s statement`;
  return parts.map((part) => `${monthLabel(part.month)}’s statement ${formatCents(part.cents)}`).join(" · ");
}

export function CostsTab({ propertyId, propertyName, month, today, entries, exports, money, charges, statements, openEntryId, onOpenEntry, onEntryChanged, onEntryDeleted, onEntryAdded, onExportRecorded, show }: Props) {
  const [recording, setRecording] = useState(false);
  const [adding, setAdding] = useState(false);
  /** Questions in Nubnb's own dialog (Kian's ruling of 2026-10-12: no native browser dialogs in the admin). */
  const { ask, dialog } = useAsk();
  const range = monthRange(month);
  const totals = money.costTotals;
  /**
   * The month's cost lines, newest first: the approved ones, and any removed or rejected one a statement charged
   * (listed so the head adds up to what the statements say).
   */
  const shown = useMemo(
    () => money.costs.filter((line) => line.state === "confirmed" || (line.state === "setAside" && line.charges.length > 0)).sort((a, b) => (b.entry.createdAt ?? "").localeCompare(a.entry.createdAt ?? "") || a.entry.id.localeCompare(b.entry.id)),
    [money.costs],
  );
  /** The head's split by statement, when the month's costs are not all on its own statement (T1). */
  const split = totals.byStatement.some((row) => row.month !== month) || totals.unchargedCents !== 0 ? totals.byStatement : null;

  /** The recorded cost PDFs, and how each entry stands beside the newest for its day. */
  const pdfRecords = useMemo(() => readPdfRecords(exports).records, [exports]);
  const pdfStateOf = (entry: CostEntryView): EntryPdfState | null => (pdfRecords.length === 0 ? null : entryPdfState(entry, pdfRecords));
  /** Recorded PDFs covering the month that list an entry since deleted (dispatch 23H): no row is left to mark, so each is said. */
  const deletedSince = useMemo(
    () => deletedSincePdf(pdfRecords, entries, propertyId).filter(({ record }) => record.from <= range.to && record.to >= range.from),
    [pdfRecords, entries, propertyId, range.from, range.to],
  );
  /** What else the month's statement charges: earlier months' entries and adjustments, as cost amounts. */
  const alsoCharged = money.alsoCharged;
  const patterns = useMemo(() => watchList(entries, today), [entries, today]);

  const exportReport = async (kind: "pdf" | "xlsx") => {
    if (recording) return;
    // Each entry with the statements that charge it, so an entry charged on another month's statement is marked (T1).
    const built = buildReport(entries, propertyId, range.from, range.to, new Date(), propertyName, charges);
    if (built.kind === "unreadable") {
      show({ tone: "error", title: "This report cannot be made while an approved entry in it cannot be read.", detail: `Open ${built.entryIds.length === 1 ? "entry" : "entries"} ${built.entryIds.join(", ")} to see why. Nothing was downloaded.` });
      return;
    }
    const { report, pendingLeftOut } = built;
    if (
      pendingLeftOut > 0 &&
      !(await ask({
        title: "Download it anyway?",
        lines: [`${pendingLeftOut === 1 ? "1 entry" : `${pendingLeftOut} entries`} in ${monthLabel(month)} ${pendingLeftOut === 1 ? "is" : "are"} still pending review and ${pendingLeftOut === 1 ? "is" : "are"} not in the report, which holds approved entries only.`],
        confirm: "Download anyway",
      }))
    )
      return;
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
      <div className={styles.blockHead}>
        <h3 className={styles.blockTitle}>Approved costs</h3>
        <span className={styles.blockTotal}>
          {totals.count === 0 ? "None" : `${totals.count === 1 ? "1 entry" : `${totals.count} entries`} · ${formatCents(totals.cents)}${totals.taxCents > 0 ? ` · tax ${formatCents(totals.taxCents)}` : ""}`}
          {totals.unreadable > 0 && <span className={styles.noteWarn}> · {totals.unreadable} cannot be added up</span>}
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
          <button type="button" className={styles.btnPrimary} onClick={() => setAdding(true)} disabled={adding}>
            <Plus size={15} aria-hidden />
            <span>Log a cost</span>
          </button>
        </span>
      </div>

      {split && (
        <p className={styles.costSplit} role="status">
          {split.map((row) => `${formatCents(row.cents)} on ${monthLabel(row.month)}’s statement${row.month === month ? "" : row.finished ? "" : ", not yet finished"}`).join(" · ")}
          {totals.unchargedCents !== 0 && ` · ${formatCents(totals.unchargedCents)} on no statement`}
        </p>
      )}

      {adding && <AddCostForm propertyId={propertyId} month={month} today={today} onAdded={onEntryAdded} onClose={() => setAdding(false)} show={show} />}

      {totals.waiting.count > 0 && (
        <p className={styles.noteWarn} role="status">
          {totals.waiting.count === 1 ? "1 entry" : `${totals.waiting.count} entries`} sent in {monthLabel(month)} {totals.waiting.count === 1 ? "is" : "are"} pending and in no statement until reviewed.{" "}
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

      {shown.length === 0 && alsoCharged.length === 0 ? null : (
        <table className={styles.listTable}>
          <thead>
            <tr>
              <th className={styles.costWhen}>Submitted</th>
              <th>Logged by</th>
              <th className={styles.num}>Total</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((line) => {
              const { entry } = line;
              const day = sentDay(entry.createdAt);
              const now = entry.linesNow;
              const pdf = pdfStateOf(entry);
              const where = chargeWords(line, month);
              return (
                <tr key={entry.id} className={styles.rowClick} onClick={() => onOpenEntry(entry.id)}>
                  {/* The cost is named by the day it was submitted (Kian, 2026-10-01), an office cost by its month and the day it was logged (Kian's ruling of 2026-10-12): what was bought is in the entry it opens. */}
                  <td className={styles.costWhen}>
                    <button
                      type="button"
                      className={styles.rowButton}
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenEntry(entry.id);
                      }}
                    >
                      {officeWhen(entry) ?? (day ? shortDay(day) : "—")}
                    </button>
                  </td>
                  <td>
                    {cleanerLabel(entry)}
                    <KindBadge kind={entry.kind} />
                  </td>
                  <td className={styles.num}>
                    {line.state === "setAside" ? (
                      <span className={`${styles.costMark} ${styles.costMarkWarn}`} title="It no longer counts: what the statements charged for it is given back on the next open one.">
                        {entry.status ?? "set aside"}
                      </span>
                    ) : now.kind === "ok" ? (
                      <span title={now.corrected ? `Corrected; sent as ${formatCents(now.sentTotalCents)}` : undefined}>
                        {now.corrected ? "✎ " : ""}
                        {formatCents(now.totalCents)}
                      </span>
                    ) : (
                      <span className={styles.noteWarn} title={now.reason}>
                        Cannot add up
                      </span>
                    )}
                    {where !== null && (
                      <span className={`${styles.costMark} ${line.charges.some((charge) => charge.month !== month) ? "" : styles.costMarkWarn}`} title="The statements that charge it, and their part (the month's money).">
                        {where}
                      </span>
                    )}
                    {pdf !== null && pdf.latest !== "same" && pdf.latest !== "not-listed" && (
                      <span className={`${styles.costMark} ${pdf.latest === "corrected" ? "" : styles.costMarkWarn}`} title={`The cost PDF exported ${whenText(pdf.lastListed.record.createdAt)} shows this entry at ${formatCents(pdf.lastListed.printed.totalCents)}.`}>
                        {pdf.latest === "corrected" ? "corrected since PDF" : "changed since PDF"}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
            {alsoCharged.length > 0 && (
              <tr className={styles.costGroup}>
                <td colSpan={3}>Also in this statement</td>
              </tr>
            )}
            {alsoCharged.map((row) => (
              <tr key={row.key} className={row.entryId ? styles.rowClick : undefined} onClick={row.entryId ? () => onOpenEntry(row.entryId) : undefined}>
                <td colSpan={2} className={styles.costWhat}>
                  {row.description}
                </td>
                {/* A cost as an amount, as the entries above it (T9); below zero, money given back. */}
                <td className={styles.num}>{formatCents(row.cents)}</td>
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
      {dialog}
    </section>
  );
}
