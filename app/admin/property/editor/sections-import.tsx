"use client";

/**
 * The Airbnb import (dispatch 30, from the dispatch-29 form): the listing's
 * link, Import, and the report of what was read, defaulted or not found,
 * field by field, with a way to each section that has something to check.
 * The import itself runs in the editor (it rewrites the draft and marks the
 * sections); this panel shows it.
 */

import { AlertTriangle, Check, Link2, Loader2, XCircle } from "lucide-react";
import { NoticeBanner, type Notice } from "../../components/Notice";
import type { ExtractionSummary } from "@/app/types/scrape";
import { TextInput } from "./controls";
import { SCRAPE_FIELD_LABEL, SCRAPE_FIELD_SECTION, SECTIONS, type SectionId } from "./model";
import { Panel, Tile, fieldIssue, isInvalid, type SectionContext } from "./shared";
import styles from "./editor.module.css";

export interface ImportTool {
  notice: Notice | null;
  summary: ExtractionSummary | null;
  importing: boolean;
  run: () => void;
  dismiss: () => void;
}

export function ImportSection({ ctx, importer }: { ctx: SectionContext; importer: ImportTool }) {
  const { draft, setProperty, fieldStatus, mode } = ctx;
  const url = draft.property.airbnbUrl ?? "";

  /** Fields the import could not read, grouped for the report. */
  const withStatus = (status: "defaulted" | "failed") =>
    Object.entries(fieldStatus || {})
      .filter(([, r]) => r.status === status)
      .map(([field, r]) => ({ field, label: SCRAPE_FIELD_LABEL[field] || field, reason: r.reason, defaultUsed: r.defaultUsed }));

  /** The sections with something to check, with how many fields each. */
  const toCheck = new Map<SectionId, number>();
  for (const [field, report] of Object.entries(fieldStatus || {})) {
    if (report.status === "extracted" || report.status === "admin-entered") continue;
    const section = SCRAPE_FIELD_SECTION[field];
    if (section) toCheck.set(section, (toCheck.get(section) ?? 0) + 1);
  }

  return (
    <Panel
      title="Airbnb"
      state={ctx.state}
      note={mode === "new" ? "Paste the listing's link and import it; then walk the sections the marks point at." : "Importing again replaces the title, description, photos, capacity, highlights, offers, rules, check-in times and reviews with the listing's. The price, the location details and the links stay."}
    >
      <Tile title="Airbnb listing" span={12}>
        <div className={styles.inputRow}>
          <div className={styles.inputWrap}>
            <Link2 size={15} aria-hidden />
            <TextInput
              field="airbnbUrl"
              value={url}
              onChange={(value) => setProperty((prev) => ({ ...prev, airbnbUrl: value }))}
              placeholder="https://www.airbnb.ca/rooms/…"
              disabled={importer.importing}
              invalid={isInvalid(ctx, "airbnbUrl")}
              aria-label="Airbnb listing URL"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  importer.run();
                }
              }}
            />
          </div>
          <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={importer.run} disabled={importer.importing || !url.trim()}>
            {importer.importing ? <Loader2 size={15} className={styles.spin} aria-hidden /> : <Link2 size={15} aria-hidden />}
            <span>{importer.importing ? "Importing…" : "Import"}</span>
          </button>
        </div>
        {fieldIssue(ctx, "airbnbUrl") && (
          <span className={styles.issue} role="alert" data-issue>
            {fieldIssue(ctx, "airbnbUrl")}
          </span>
        )}
        <NoticeBanner notice={importer.notice} onDismiss={importer.dismiss} />
      </Tile>

      {importer.summary && (
        <Tile title="What was read" span={12}>
        <div className={styles.report}>
          <div className={styles.reportCounts}>
            <span className={`${styles.scrapeBadge} ${styles.scrapeBadgeExtracted}`}>
              <Check size={11} aria-hidden /> {importer.summary.extracted} read
            </span>
            <span className={`${styles.scrapeBadge} ${styles.scrapeBadgeDefaulted}`}>
              <AlertTriangle size={11} aria-hidden /> {importer.summary.defaulted} defaulted
            </span>
            <span className={`${styles.scrapeBadge} ${styles.scrapeBadgeFailed}`}>
              <XCircle size={11} aria-hidden /> {importer.summary.failed} not found
            </span>
            <span className={styles.reportTotal}>of {importer.summary.total} fields</span>
          </div>
          {toCheck.size > 0 && (
            <div className={styles.reportSections}>
              <span>To check:</span>
              {SECTIONS.filter((s) => toCheck.has(s.id)).map((s) => (
                <button key={s.id} type="button" className={styles.linkBtn} onClick={() => ctx.goTo(s.id)}>
                  {s.label} ({toCheck.get(s.id)})
                </button>
              ))}
            </div>
          )}
          {(["defaulted", "failed"] as const).map((status) => {
            const rows = withStatus(status);
            if (rows.length === 0) return null;
            return (
              <ul key={status} className={styles.reportList}>
                {rows.map((row) => (
                  <li key={row.field}>
                    <span className={`${styles.scrapeBadge} ${status === "defaulted" ? styles.scrapeBadgeDefaulted : styles.scrapeBadgeFailed}`}>{status === "defaulted" ? `Default "${String(row.defaultUsed)}"` : "Not found"}</span>
                    <strong>{row.label}</strong>
                    <span className={styles.reportReason}>{row.reason}</span>
                  </li>
                ))}
              </ul>
            );
          })}
        </div>
        </Tile>
      )}
    </Panel>
  );
}
