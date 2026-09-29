"use client";

/**
 * My receipts: what this cleaner has sent, newest first, and what became of
 * each — waiting for review, approved, rejected with the office's reason, or
 * removed — with the total as it now stands, and what they sent when the
 * office changed it.
 *
 * Their own only. The server lists the signed-in cleaner's entries and
 * nothing else: no receipt photo, no history, no other cleaner's work. A
 * list that could not be loaded says so; it is never shown as empty.
 */

import { useEffect, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { loadMyEntries } from "@/app/lib/cleaner-client";
import {
  ENTRY_STATUS_CLEANER_LABELS,
  formatCents,
  isEntryStatus,
  type CleanerEntry,
  type CleanerProperty,
  type EntryStatus,
} from "@/app/lib/cleaners/model";
import styles from "./cleaner.module.css";

interface ReceiptsScreenProps {
  properties: CleanerProperty[];
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

// The properties are in Toronto, and so is the office's list.
const dayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", month: "short", day: "numeric" });
const yearFormat = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric" });

/** "Sep 25", with the year when it is not this year. */
function sentOn(iso: string | null): string {
  const time = Date.parse(iso ?? "");
  if (!Number.isFinite(time)) return "Date not known";
  const year = yearFormat.format(time);
  return year === yearFormat.format(Date.now()) ? dayFormat.format(time) : `${dayFormat.format(time)}, ${year}`;
}

export function ReceiptsScreen({ properties, onBack, onSignedOut }: ReceiptsScreenProps) {
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

  const retry = () => {
    setList({ kind: "loading" });
    setAttempt((n) => n + 1);
  };

  const nameOf = (entry: CleanerEntry) =>
    properties.find((property) => property.id === entry.propertyId)?.name ?? entry.propertyNameAtEntry ?? "Property";

  return (
    <main className={styles.screen}>
      <header className={styles.topBar}>
        <button type="button" className={styles.backButton} onClick={onBack}>
          <ChevronLeft aria-hidden />
          <span>Back</span>
        </button>
      </header>

      <h1 className={styles.title}>My receipts</h1>

      {list.kind === "loading" ? (
        <div className={styles.listLoading} aria-busy="true">
          <span className={styles.spinner} aria-label="Loading" />
        </div>
      ) : list.kind === "offline" || list.kind === "failed" ? (
        <div className={styles.emptyState} role="alert">
          <p>{list.kind === "offline" ? "No connection." : "Couldn’t load your receipts."}</p>
          <button type="button" className={styles.secondary} onClick={retry}>
            Try again
          </button>
        </div>
      ) : list.entries.length === 0 ? (
        <div className={styles.emptyState}>
          <p>No receipts yet.</p>
        </div>
      ) : (
        <ul className={styles.receiptList}>
          {list.entries.map((entry) => {
            const known = isEntryStatus(entry.status) ? entry.status : null;
            const out = entry.status === "rejected" || entry.status === "removed";
            return (
              <li key={entry.id} className={styles.receiptRow}>
                <div className={styles.receiptTop}>
                  <span className={styles.receiptProperty}>{nameOf(entry)}</span>
                  <span className={`${styles.receiptTotal} ${out ? styles.receiptTotalOut : ""}`}>
                    {entry.totalCents === null ? "—" : formatCents(entry.totalCents)}
                  </span>
                </div>
                <div className={styles.receiptMeta}>
                  <span>
                    {sentOn(entry.createdAt)}
                    {entry.lineCount !== null && ` · ${entry.lineCount === 1 ? "1 item" : `${entry.lineCount} items`}`}
                  </span>
                  <span className={`${styles.receiptStatus} ${known ? STATUS_CLASS[known] : ""}`}>
                    {known ? ENTRY_STATUS_CLEANER_LABELS[known] : (entry.status ?? "Not known")}
                  </span>
                </div>
                {entry.corrected && entry.sentTotalCents !== null && (
                  <p className={styles.receiptNote}>Changed by the office. You sent {formatCents(entry.sentTotalCents)}.</p>
                )}
                {entry.status === "rejected" && entry.statusReason && (
                  <p className={styles.receiptNote}>“{entry.statusReason}”</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
