"use client";

/**
 * History (Kian's ruling 7 of 2026-10-16, replacing "My receipts"): the jobs this cleaner did and the receipts they
 * sent — a handyman's work — newest first, by day, each with what became of it: a job cleaned, or removed by the
 * office; an entry waiting for review, approved, rejected with the office's reason, or removed. No pay: no earned, paid
 * or balance figure (ruling 1). An entry shows its own total as it now stands, and what was sent when the office changed
 * it, as the receipt itself says.
 *
 * A job reads "Cleaned · Undo" here as on the home screen (ruling 6), while Undo holds, so a mark made on an earlier
 * day can still be undone. Jobs reach back the 45 days their list reaches; entries, all of theirs.
 *
 * Their own only. The server lists the signed-in cleaner's entries and nothing else: no receipt photo, no history, no
 * other cleaner's work. A list that could not be loaded says so; it is never shown as empty.
 */

import { useEffect, useMemo, useState } from "react";
import { loadMyEntries } from "@/app/lib/cleaner-client";
import { historyItems, type HistoryItem } from "@/app/lib/cleaner-home";
import { addDays } from "@/app/lib/availability/days";
import {
  ENTRY_STATUS_CLEANER_LABELS,
  formatCents,
  isEntryStatus,
  type CleanerEntry,
  type CleanerProperty,
  type EntryStatus,
} from "@/app/lib/cleaners/model";
import type { CleanerJobView } from "@/app/lib/schedule/model";
import styles from "./cleaner.module.css";
import { CleanerBar } from "./CleanerBar";
import { CleanedLine } from "./JobsSection";

interface HistoryScreenProps {
  properties: CleanerProperty[];
  /** Their jobs as they now stand: the marked ones are listed. Empty for a handyman. */
  jobs: CleanerJobView[];
  today: string;
  /** The job whose undo is in flight, and the answer under a job, as on the home screen. */
  busyId: string | null;
  messages: Record<string, string>;
  onUndo: (job: CleanerJobView) => void;
  onBack: () => void;
  /** The session ended while the list was open: back to the code. */
  onSignedOut: () => void;
}

type ListState =
  | { kind: "loading" }
  | { kind: "ready"; entries: CleanerEntry[] }
  | { kind: "offline" }
  | { kind: "failed" };

const STATUS_CLASS: Record<EntryStatus, string> = {
  pending: styles.statusPending,
  approved: styles.statusApproved,
  rejected: styles.statusRejected,
  removed: styles.statusRemoved,
};

/** "Today", "Yesterday", "Wed, Oct 14", with the year when it is not this year. */
function dayHeading(day: string | null, today: string): string {
  if (day === null) return "Date not known";
  if (day === today) return "Today";
  if (day === addDays(today, -1)) return "Yesterday";
  const date = new Date(`${day}T12:00:00`);
  const shown = new Intl.DateTimeFormat("en-CA", { weekday: "short", month: "short", day: "numeric" }).format(date);
  return day.slice(0, 4) === today.slice(0, 4) ? shown : `${shown}, ${day.slice(0, 4)}`;
}

/** The items, grouped under their day, in order. */
function byDay(items: HistoryItem[]): { day: string | null; items: HistoryItem[] }[] {
  const groups: { day: string | null; items: HistoryItem[] }[] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && last.day === item.day) last.items.push(item);
    else groups.push({ day: item.day, items: [item] });
  }
  return groups;
}

export function HistoryScreen({ properties, jobs, today, busyId, messages, onUndo, onBack, onSignedOut }: HistoryScreenProps) {
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    loadMyEntries().then((result) => {
      if (cancelled) return;
      if (result.kind === "signed-out") {
        onSignedOut();
        return;
      }
      setList(result.kind === "ok" ? { kind: "ready", entries: result.entries } : { kind: result.kind });
    });
    return () => {
      cancelled = true;
    };
  }, [attempt, onSignedOut]);

  const groups = useMemo(() => (list.kind === "ready" ? byDay(historyItems(jobs, list.entries)) : []), [jobs, list]);

  const retry = () => {
    setList({ kind: "loading" });
    setAttempt((n) => n + 1);
  };

  const nameOf = (entry: CleanerEntry) =>
    properties.find((property) => property.id === entry.propertyId)?.name ?? entry.propertyNameAtEntry ?? "Property";

  const entryRow = (entry: CleanerEntry) => {
    const known = isEntryStatus(entry.status) ? entry.status : null;
    const out = entry.status === "rejected" || entry.status === "removed";
    return (
      <li key={`entry-${entry.id}`} className={styles.receiptRow}>
        <div className={styles.receiptTop}>
          <span className={styles.receiptProperty}>{nameOf(entry)}</span>
          <span className={`${styles.receiptTotal} ${out ? styles.receiptTotalOut : ""}`}>
            {entry.totalCents === null ? "—" : formatCents(entry.totalCents)}
          </span>
        </div>
        {entry.kind === "work" && entry.description !== null && <p className={styles.receiptDescription}>{entry.description}</p>}
        <div className={styles.receiptMeta}>
          <span>
            {entry.kind === "work"
              ? "Work"
              : `Receipt${entry.lineCount !== null ? ` · ${entry.lineCount === 1 ? "1 item" : `${entry.lineCount} items`}` : ""}`}
          </span>
          <span className={`${styles.receiptStatus} ${known ? STATUS_CLASS[known] : ""}`}>
            {known ? ENTRY_STATUS_CLEANER_LABELS[known] : (entry.status ?? "Not known")}
          </span>
        </div>
        {entry.corrected && entry.sentTotalCents !== null && (
          <p className={styles.receiptNote}>Changed by the office. You sent {formatCents(entry.sentTotalCents)}.</p>
        )}
        {entry.status === "rejected" && entry.statusReason && <p className={styles.receiptNote}>“{entry.statusReason}”</p>}
      </li>
    );
  };

  const jobRow = (job: CleanerJobView) => (
    <li key={`job-${job.id}`} className={styles.receiptRow}>
      <div className={styles.receiptTop}>
        <span className={styles.receiptProperty}>{job.propertyName ?? "Property"}</span>
      </div>
      <div className={styles.receiptMeta}>
        <span>Cleaning{job.status === "booking-changed" ? " · booking changed" : ""}</span>
      </div>
      <CleanedLine job={job} busy={busyId === job.id} disabled={busyId !== null} onUndo={() => onUndo(job)} />
      {messages[job.id] && (
        <p className={styles.jobMessage} role="alert">
          {messages[job.id]}
        </p>
      )}
    </li>
  );

  return (
    <>
      <CleanerBar onBack={onBack} />
      <main className={styles.screen}>
        <h1 className={styles.title}>History</h1>

        {list.kind === "loading" ? (
          <div className={styles.listLoading} aria-busy="true">
            <span className={styles.spinner} aria-label="Loading" />
          </div>
        ) : list.kind === "offline" || list.kind === "failed" ? (
          <div className={styles.emptyState} role="alert">
            <p>{list.kind === "offline" ? "No connection." : "Couldn’t load your history."}</p>
            <button type="button" className={styles.secondary} onClick={retry}>
              Try again
            </button>
          </div>
        ) : groups.length === 0 ? (
          <div className={styles.emptyState}>
            <p>Nothing yet.</p>
          </div>
        ) : (
          groups.map((group) => (
            <section key={group.day ?? "unknown"} aria-label={dayHeading(group.day, today)} className={styles.historyDay}>
              <h2 className={styles.sectionLabel}>{dayHeading(group.day, today)}</h2>
              <ul className={styles.receiptList}>{group.items.map((item) => (item.kind === "job" ? jobRow(item.job) : entryRow(item.entry)))}</ul>
            </section>
          ))
        )}
      </main>
    </>
  );
}
