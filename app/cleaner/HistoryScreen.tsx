"use client";

/**
 * History (Kian's ruling 7 of 2026-10-16, replacing "My receipts"; rebuilt to his ruling of 2026-11-02, Build 1,
 * item 8): month by month, newest first, with a month switcher. Each month lists "Cleanings · n" — a dated list of
 * units, each reading Cleaned (with Undo while it holds, asking once), "Cleaned · note sent" in amber while the
 * office decides, or "Removed by the office" — and "Receipts · n", each with its total and its status: Waiting,
 * Approved, or Rejected with the office's reason. A handyman's screen is "My work": each entry with its description,
 * price and status (item 11). No pay figure and no cleaning amount anywhere (ruling H).
 *
 * Their own only. The server lists the signed-in cleaner's entries and cleanings and nothing else: no receipt photo, no
 * history, no other cleaner's work. A list that could not be loaded says so; it is never shown as empty. Cleanings
 * reach every month back to the statements floor (Kian's ruling H4 of 2026-11-02), read from the cleanings themselves;
 * within the 45 days the job list reaches a row is the job, with its Undo and grey words; further back it is the
 * cleaning's own words, with no Undo (an older cleaning is the office's). Entries, all of theirs.
 */

import { useEffect, useMemo, useState } from "react";
import { Check, ChevronLeft, ChevronRight, X } from "lucide-react";
import { loadMyEntries } from "@/app/lib/cleaner-client";
import { historyItems, historyMonths, monthItems, monthWords, type HistoryItem } from "@/app/lib/cleaner-home";
import {
  ENTRY_STATUS_CLEANER_LABELS,
  formatCents,
  isEntryStatus,
  type CleanerCleaning,
  type CleanerEntry,
  type CleanerProperty,
  type EntryStatus,
} from "@/app/lib/cleaners/model";
import type { CleanerJobView } from "@/app/lib/schedule/model";
import styles from "./cleaner.module.css";
import { CleanerBar } from "./CleanerBar";
import { CleanedLine } from "./JobsSection";

interface HistoryScreenProps {
  kind: "receipt" | "work";
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
  | { kind: "ready"; entries: CleanerEntry[]; cleanings: CleanerCleaning[] }
  | { kind: "offline" }
  | { kind: "failed" };

const STATUS_CLASS: Record<EntryStatus, string> = {
  pending: styles.statusPending,
  approved: styles.statusApproved,
  rejected: styles.statusRejected,
  removed: styles.statusRemoved,
};

/** "Nov 18": the day on a row; "—" for an entry with no readable date. */
const rowDay = (day: string | null) => (day === null ? "—" : new Intl.DateTimeFormat("en-CA", { month: "short", day: "numeric" }).format(new Date(`${day}T12:00:00`)));

export function HistoryScreen({ kind, properties, jobs, today, busyId, messages, onUndo, onBack, onSignedOut }: HistoryScreenProps) {
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [month, setMonth] = useState(today.slice(0, 7));

  useEffect(() => {
    let cancelled = false;
    loadMyEntries().then((result) => {
      if (cancelled) return;
      if (result.kind === "signed-out") {
        onSignedOut();
        return;
      }
      setList(result.kind === "ok" ? { kind: "ready", entries: result.entries, cleanings: result.cleanings } : { kind: result.kind });
    });
    return () => {
      cancelled = true;
    };
  }, [attempt, onSignedOut]);

  const items = useMemo(() => (list.kind === "ready" ? historyItems(jobs, list.entries, list.cleanings) : []), [jobs, list]);
  const months = useMemo(() => historyMonths(items, today), [items, today]);
  const shown = useMemo(() => monthItems(items, month, months), [items, month, months]);
  const at = months.indexOf(month);
  const older = at >= 0 && at < months.length - 1 ? months[at + 1] : null;
  const newer = at > 0 ? months[at - 1] : null;

  const retry = () => {
    setList({ kind: "loading" });
    setAttempt((n) => n + 1);
  };

  const nameOf = (entry: CleanerEntry) =>
    properties.find((property) => property.id === entry.propertyId)?.name ?? entry.propertyNameAtEntry ?? "Property";

  const entryRow = (item: Extract<HistoryItem, { kind: "entry" }>) => {
    const { entry } = item;
    const known = isEntryStatus(entry.status) ? entry.status : null;
    const out = entry.status === "rejected" || entry.status === "removed";
    return (
      <li key={`entry-${entry.id}`} className={styles.historyRow}>
        <div className={styles.historyTop}>
          <span className={styles.historyDay}>{rowDay(item.day)}</span>
          <span className={styles.historyName}>{nameOf(entry)}</span>
          <span className={`${styles.receiptTotal} ${out ? styles.receiptTotalOut : ""}`}>{entry.totalCents === null ? "—" : formatCents(entry.totalCents)}</span>
        </div>
        {entry.kind === "work" && entry.description !== null && <p className={styles.receiptDescription}>{entry.description}</p>}
        <div className={styles.historyMeta}>
          <span className={`${styles.receiptStatus} ${known ? STATUS_CLASS[known] : ""}`}>{known ? ENTRY_STATUS_CLEANER_LABELS[known] : (entry.status ?? "Not known")}</span>
          {entry.status === "rejected" && entry.statusReason && <span className={styles.receiptNote}>“{entry.statusReason}”</span>}
          {entry.corrected && entry.sentTotalCents !== null && <span className={styles.receiptNote}>Changed by the office. You sent {formatCents(entry.sentTotalCents)}.</span>}
        </div>
      </li>
    );
  };

  const jobRow = (item: Extract<HistoryItem, { kind: "job" }>) => {
    const { job } = item;
    return (
      <li key={`job-${job.id}`} className={styles.historyRow}>
        <div className={styles.historyTop}>
          <span className={styles.historyDay}>{rowDay(item.day)}</span>
          <span className={styles.historyName}>{job.propertyName ?? "Property"}</span>
        </div>
        {job.status === "booking-changed" && <p className={styles.jobNote}>Booking changed after it was marked.</p>}
        <CleanedLine job={job} busy={busyId === job.id} disabled={busyId !== null} onUndo={() => onUndo(job)} />
        {messages[job.id] && (
          <p className={styles.jobMessage} role="alert">
            {messages[job.id]}
          </p>
        )}
      </li>
    );
  };

  /** A cleaning from further back than the job list reaches (H4): its words, no Undo (an older cleaning is the office's). */
  const cleaningRow = (item: Extract<HistoryItem, { kind: "cleaning" }>) => {
    const { cleaning } = item;
    const name = properties.find((property) => property.id === cleaning.propertyId)?.name ?? cleaning.propertyNameAtEntry ?? "Property";
    return (
      <li key={`cleaning-${cleaning.id}`} className={styles.historyRow}>
        <div className={styles.historyTop}>
          <span className={styles.historyDay}>{rowDay(item.day)}</span>
          <span className={styles.historyName}>{name}</span>
        </div>
        {cleaning.status === "removed" ? (
          <p className={`${styles.jobState} ${styles.jobStateRemoved}`}>
            <X aria-hidden />
            <span>Removed by the office</span>
          </p>
        ) : (
          <p className={`${styles.jobState} ${cleaning.noteSent ? styles.jobStateExtra : ""}`}>
            <Check aria-hidden />
            <span>{cleaning.noteSent ? "Cleaned · note sent" : "Cleaned"}</span>
          </p>
        )}
        {cleaning.recordedByOffice && <p className={styles.undoWords}>Recorded by the office</p>}
      </li>
    );
  };

  const cleanings = shown.filter((item): item is Extract<HistoryItem, { kind: "job" | "cleaning" }> => item.kind === "job" || item.kind === "cleaning");
  const entries = shown.filter((item): item is Extract<HistoryItem, { kind: "entry" }> => item.kind === "entry");
  const entriesWord = kind === "work" ? "Work" : "Receipts";

  return (
    <>
      <CleanerBar onBack={onBack} />
      <main className={styles.screen}>
        <h1 className={styles.title}>{kind === "work" ? "My work" : "History"}</h1>

        <nav className={styles.monthBar} aria-label="Month">
          <button type="button" className={styles.monthButton} onClick={() => older && setMonth(older)} disabled={!older} aria-label={older ? `Older: ${monthWords(older)}` : "No older month"}>
            <ChevronLeft aria-hidden />
          </button>
          <span className={styles.monthName} aria-live="polite">
            {monthWords(month)}
          </span>
          <button type="button" className={styles.monthButton} onClick={() => newer && setMonth(newer)} disabled={!newer} aria-label={newer ? `Newer: ${monthWords(newer)}` : "No newer month"}>
            <ChevronRight aria-hidden />
          </button>
        </nav>

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
        ) : shown.length === 0 ? (
          <div className={styles.emptyState}>
            <p>Nothing in {monthWords(month)}.</p>
          </div>
        ) : (
          <>
            {kind === "receipt" && (
              <section aria-label={`Cleanings · ${cleanings.length}`} className={styles.historySection}>
                <h2 className={styles.groupHead}>Cleanings · {cleanings.length}</h2>
                {cleanings.length === 0 ? <p className={styles.jobsEmpty}>None this month.</p> : <ul className={styles.receiptList}>{cleanings.map((item) => (item.kind === "job" ? jobRow(item) : cleaningRow(item)))}</ul>}
              </section>
            )}
            <section aria-label={`${entriesWord} · ${entries.length}`} className={styles.historySection}>
              <h2 className={styles.groupHead}>
                {entriesWord} · {entries.length}
              </h2>
              {entries.length === 0 ? <p className={styles.jobsEmpty}>None this month.</p> : <ul className={styles.receiptList}>{entries.map(entryRow)}</ul>}
            </section>
          </>
        )}
      </main>
    </>
  );
}
