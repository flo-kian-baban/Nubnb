"use client";

/**
 * The Finish tab (dispatch 23F): the reference and the date the statement
 * prints, the state of the draft, Finish and issue, and — once finished —
 * Download PDF and "Correct this statement…", with every earlier version of
 * the month's statement listed under it, each with its PDF.
 *
 * Finish sends the page's claim; the server rebuilds the statement and
 * refuses unless that is what is stored (dispatch 23B). After finishing the
 * page runs the writer on the frozen object the server returned and says
 * whether its SHA-256 is the stored object's.
 */

import { Download } from "lucide-react";
import { formatCents } from "@/app/lib/cleaners/model";
import { STATEMENT_LIMITS, addMonths, displayRef, isDayText, monthLabel, type MonthlyReportView } from "@/app/lib/reports/model";
import type { MonthlyReportSummaryLike } from "@/app/lib/reports/statement";
import { SentAt, whenText } from "../costs/cost-display";
import type { Typed } from "./statement-form";
import shared from "../page.module.css";
import styles from "./page.module.css";

export type SaveState = { kind: "saved"; at: string } | { kind: "saving" } | { kind: "unsaved" } | { kind: "failed"; reason: string } | { kind: "none" };

interface Props {
  month: string;
  /** Whether the month has not ended: a statement may still be finished for it; later entries go into the next month's. */
  monthOpen: boolean;
  typed: Typed;
  readOnly: boolean;
  onChange: (next: Typed) => void;
  finishedReport: MonthlyReportView | null;
  /** Every finished statement for the month, newest first, with which replaced which. */
  versions: { report: MonthlyReportSummaryLike; replacedBy: MonthlyReportSummaryLike | null }[];
  /** A correction in progress: the statement it replaces, and why. */
  supersedes: { reportId: string; reason: string } | null;
  save: SaveState;
  reportForState: "saved" | "saving" | "unsaved" | "failed";
  /** The revenue share the statement would print; null when it cannot be built. */
  payableCents: number | null;
  /** Whether the statement can be built (no unreadable entry). */
  buildable: boolean;
  finishing: boolean;
  onFinish: () => void;
  onCorrect: () => void;
  linking: string | null;
  onDownload: (reportId: string) => void;
  verified: { ok: boolean; stored: string; computed: string } | null;
  /** How many download links were made for a report, and the last. */
  downloadsOf: (reportId: string) => { count: number; last: string | null };
}

export function FinishTab({ month, monthOpen, typed, readOnly, onChange, finishedReport, versions, supersedes, save, reportForState, payableCents, buildable, finishing, onFinish, onCorrect, linking, onDownload, verified, downloadsOf }: Props) {
  const legacyView = readOnly && finishedReport?.legacy === true;
  const stateLine =
    readOnly && finishedReport ? (
      <span className={styles.stateLine}>
        <strong>Finished</strong> <SentAt iso={finishedReport.finishedAt} seconds /> · <span className={styles.mono}>{displayRef(finishedReport)}</span>
        {finishedReport.supersedes && <> · replaces {displayRef(versions.find((v) => v.report.id === finishedReport.supersedes!.reportId)?.report ?? { id: finishedReport.supersedes.reportId })}</>}
      </span>
    ) : save.kind === "saving" || reportForState === "saving" ? (
      <span className={styles.stateLine}>Saving…</span>
    ) : save.kind === "failed" ? (
      <span className={`${styles.stateLine} ${styles.stateLineWarn}`}>Not saved: {save.reason}</span>
    ) : save.kind === "unsaved" || reportForState === "unsaved" ? (
      <span className={styles.stateLine}>{supersedes ? "Correction" : "Draft"} · changed, saving shortly</span>
    ) : save.kind === "saved" ? (
      <span className={styles.stateLine}>
        <strong>{supersedes ? "Correction" : "Draft"}</strong> · saved {whenText(save.at)}
      </span>
    ) : (
      <span className={styles.stateLine}>Nothing saved yet</span>
    );
  const downloadTitle = (reportId: string) => {
    const d = downloadsOf(reportId);
    return d.count === 0 ? "Not downloaded yet" : `Downloaded ${d.count === 1 ? "once" : d.count === 2 ? "twice" : `${d.count} times`}, last ${whenText(d.last)}`;
  };
  const earlier = versions.filter((v) => v.replacedBy !== null);

  return (
    <>
      {/* ── The reference and the date ── */}
      <section className={styles.block} aria-label="Reference and date">
        <div className={styles.blockHead}>
          <h3 className={styles.blockTitle}>Reference and date</h3>
        </div>
        <div className={styles.referenceGrid}>
          <div>
            <label className={styles.fieldLabel} htmlFor="reference">Reference</label>
            <input
              id="reference"
              className={`${styles.textInput} ${!readOnly && typed.reference.trim() === "" ? styles.inputInvalid : ""}`}
              value={legacyView ? "" : typed.reference}
              maxLength={STATEMENT_LIMITS.REFERENCE_MAX}
              disabled={readOnly}
              placeholder={legacyView ? "" : "e.g. Aug-321-John"}
              onChange={(e) => onChange({ ...typed, reference: e.target.value })}
            />
          </div>
          <div>
            <label className={styles.fieldLabel} htmlFor="report-date">Date</label>
            <input id="report-date" type="date" className={`${styles.textInput} ${!readOnly && !isDayText(typed.reportDate) ? styles.inputInvalid : ""}`} value={legacyView ? "" : typed.reportDate} disabled={readOnly} onChange={(e) => onChange({ ...typed, reportDate: e.target.value })} />
          </div>
        </div>
      </section>

      {/* ── Finish, or the finished statement ── */}
      <section className={styles.block} aria-label="Finish">
        <div className={styles.blockHead}>
          <h3 className={styles.blockTitle}>{readOnly ? "Statement" : "Finish"}</h3>
          {stateLine}
        </div>
        {supersedes && !readOnly && (
          <p className={styles.note}>
            Correcting {displayRef(versions.find((v) => v.report.id === supersedes.reportId)?.report ?? { id: supersedes.reportId })}: “{supersedes.reason}”. Finishing makes a replacing statement; the old one stays on record, marked replaced.
          </p>
        )}
        <div className={styles.finishRow}>
          {readOnly && finishedReport ? (
            <>
              <button type="button" className={styles.btnPrimary} onClick={() => onDownload(finishedReport.id)} disabled={linking !== null} title={downloadTitle(finishedReport.id)}>
                <Download size={14} aria-hidden />
                <span>{linking === finishedReport.id ? "Opening…" : "Download PDF"}</span>
              </button>
              <button type="button" className={styles.btnGhost} onClick={onCorrect} disabled={finishing}>
                Correct this statement…
              </button>
              {verified && (
                <span className={verified.ok ? styles.verified : styles.noteWarn} title={`stored ${verified.stored}\ncomputed ${verified.computed}`}>
                  {verified.ok ? "✓ Stored PDF verified: SHA-256 matches" : "Stored PDF does not match the page"}
                </span>
              )}
            </>
          ) : (
            <>
              <button type="button" className={styles.btnPrimary} onClick={onFinish} disabled={finishing || !buildable}>
                {finishing ? "Finishing…" : "Finish and issue…"}
              </button>
              <span className={styles.note}>{payableCents !== null ? `Your Revenue Share ${formatCents(payableCents)}.` : ""} A finished statement is never edited.</span>
            </>
          )}
        </div>
        {monthOpen && !readOnly && <p className={styles.note}>{monthLabel(month)} has not ended. Entries approved after finishing go into {monthLabel(addMonths(month, 1))}’s statement.</p>}
        {finishedReport?.legacy && <p className={styles.note}>Finished before the Payment Summary layout; shown and downloaded as it was issued.</p>}
      </section>

      {/* ── Earlier versions of this month's statement ── */}
      {earlier.length > 0 && (
        <section className={styles.block} aria-label="Earlier versions">
          <div className={styles.blockHead}>
            <h3 className={styles.blockTitle}>Earlier versions</h3>
          </div>
          <ul className={styles.versionList}>
            {earlier.map(({ report, replacedBy }) => (
              <li key={report.id} className={styles.versionItem}>
                <span>
                  <span className={styles.mono}>{displayRef(report)}</span> · finished <SentAt iso={report.finishedAt} />
                  {replacedBy && (
                    <>
                      {" "}
                      <span className={`${shared.stateBadge} ${shared.stateReplaced}`} title={`Replaced by ${displayRef(replacedBy)}: ${replacedBy.supersedes?.reason ?? ""}`}>
                        Replaced
                      </span>
                    </>
                  )}
                </span>
                <span className={styles.num}>{formatCents(report.payableCents)}</span>
                <button type="button" className={`${styles.btnGhost} ${styles.btnSmall}`} disabled={linking !== null} onClick={() => onDownload(report.id)} title={downloadTitle(report.id)}>
                  <Download size={13} aria-hidden />
                  <span>{linking === report.id ? "Opening…" : "PDF"}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
