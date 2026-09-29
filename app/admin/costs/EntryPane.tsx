"use client";

/**
 * One cost entry, opened from the costs table: its status and the review
 * actions, the receipt photo, its items as they now count, and its history.
 *
 * ── Review ──
 * Approve, reject (with a reason the cleaner sees) or remove, whenever the
 * admin chooses; each of the three can follow any other, so approving undoes
 * a removal. A line is corrected, or one added — a discount, say, which the
 * phone cannot enter — without a reason. Nothing is ever deleted: the entry's
 * lines stay as the cleaner sent them, each correction goes into the history
 * with the line before and after, and every earlier version stays beneath its
 * line, struck through.
 *
 * Changes are not optimistic. Each sends the length of the history this pane
 * shows, and the server refuses it if the entry changed since — another
 * admin, say. The pane changes only to the entry the server returns. An
 * answer that does not say whether a change landed is reported as such.
 */

import { useState, type FormEvent, type ReactNode } from "react";
import { Ban, Check, Plus, Trash2, X } from "lucide-react";
import { NoticeBanner, useNotice, type Notice } from "../components/Notice";
import { changeEntryLine, setEntryStatus, type CostResult, type EntryChange } from "@/app/lib/costs-client";
import {
  ENTRY_STATUS_LABELS,
  HISTORY_ACTION_LABELS,
  LIMITS,
  formatCents,
  type CostEntryView,
  type HistoryEventView,
  type LineNow,
  type ReviewStatus,
} from "@/app/lib/cleaners/model";
import { cleanerLabel, propertyLabel } from "@/app/lib/costs/report";
import { Absent, FieldText } from "../leads/lead-display";
import {
  EntryStatusBadge,
  SentAt,
  amountField,
  lineText,
  quantityText,
  readAmount,
  readQuantity,
  statusWord,
} from "./cost-display";
import { ReceiptImage } from "./ReceiptImage";
import styles from "./page.module.css";

interface EntryPaneProps {
  entry: CostEntryView;
  /** The entry as the server now stores it, after a review. */
  onChanged: (entry: CostEntryView) => void;
  onClose: () => void;
}

/** A line being corrected (its place) or added (null), as typed so far. */
interface LineDraft {
  index: number | null;
  name: string;
  quantity: string;
  amount: string;
}

const SESSION_HINT = "Your admin session may have expired — reload and sign in again.";

const STATUS_DONE: Record<ReviewStatus, string> = {
  approved: "It counts in totals and reports.",
  rejected: "The cleaner sees the reason in their app. It no longer counts in totals or reports.",
  removed: "It stays here, marked, and no longer counts in totals or reports.",
};

export function EntryPane({ entry, onChanged, onClose }: EntryPaneProps) {
  /** What is being saved, for its button's label; null when nothing is. */
  const [saving, setSaving] = useState<ReviewStatus | "line" | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [draft, setDraft] = useState<LineDraft | null>(null);
  const { notice, show, clear } = useNotice();

  /** The history length this pane shows; null when there is no history to add to. */
  const seen = entry.history?.length ?? null;
  const reviewable = seen !== null;
  const busy = saving !== null;
  const now = entry.linesNow;

  /** Show the server's answer: the new entry, or why not, or that nobody can tell. */
  const settle = (result: CostResult<EntryChange>, done: (change: EntryChange) => Notice): boolean => {
    if (result.ok) {
      onChanged(result.data.entry);
      show(done(result.data));
      return true;
    }
    show(
      result.unknown
        ? {
            tone: "warning",
            title: "The change may or may not have been saved. Refresh to see what is stored.",
            detail: result.title,
          }
        : { tone: "error", title: result.title, detail: failureDetail(result) },
    );
    return false;
  };

  const review = async (status: ReviewStatus) => {
    if (busy || seen === null) return;
    if (
      status === "removed" &&
      !window.confirm(
        "Remove this entry? It stays in the record, marked removed, and stops counting in totals and reports. Approving it later counts it again.",
      )
    ) {
      return;
    }
    const why = status === "rejected" ? reason.trim() : null;
    if (status === "rejected" && !why) return;

    clear();
    setSaving(status);
    const result = await setEntryStatus(entry.id, { status, reason: why, seen });
    setSaving(null);
    const saved = settle(result, (change) =>
      change.changed
        ? { tone: "success", title: `${ENTRY_STATUS_LABELS[status]}.`, detail: STATUS_DONE[status] }
        : { tone: "info", title: `Nothing was changed: it was already ${ENTRY_STATUS_LABELS[status].toLowerCase()}.` },
    );
    if (saved) {
      setRejecting(false);
      setReason("");
    }
  };

  const correct = (line: LineNow) => {
    clear();
    setDraft({
      index: line.index,
      name: line.name ?? "",
      quantity: typeof line.quantity === "number" ? String(line.quantity) : "1",
      amount: amountField(line.lineTotalCents),
    });
  };

  const add = () => {
    clear();
    setDraft({ index: null, name: "", quantity: "1", amount: "" });
  };

  const saveLine = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft || busy || seen === null) return;
    const name = draft.name.normalize("NFC").trim();
    const quantity = readQuantity(draft.quantity);
    const lineTotal = readAmount(draft.amount);
    const problems = [
      name === "" ? "Type the item." : null,
      quantity === null ? "Check the quantity: a number above 0, with at most three decimals." : null,
      lineTotal === null ? "Check the amount: dollars and cents as printed, like 7.98, or -5.00 for money back." : null,
    ].filter((problem): problem is string => problem !== null);
    if (problems.length > 0 || quantity === null || lineTotal === null) {
      show({ tone: "error", title: "The line was not saved.", items: problems });
      return;
    }

    clear();
    setSaving("line");
    const result = await changeEntryLine(entry.id, { index: draft.index, line: { name, quantity, lineTotal }, seen });
    setSaving(null);
    const saved = settle(result, (change) =>
      change.changed
        ? {
            tone: "success",
            title: draft.index === null ? "Line added." : `Line ${draft.index + 1} corrected.`,
            detail: draft.index === null ? "It is marked as added by an admin." : "What it said before stays beneath it.",
          }
        : { tone: "info", title: "Nothing was changed: the line already said that." },
    );
    if (saved) setDraft(null);
  };

  return (
    <div className={styles.detail}>
      {/* ── Whose, and when ── */}
      <div className={styles.detailHead}>
        <div className={styles.detailHeadText}>
          <h2 className={styles.detailTitle}>{propertyLabel(entry)}</h2>
          <p className={styles.detailMeta}>
            {cleanerLabel(entry)} · sent <SentAt iso={entry.createdAt} />
          </p>
          <NameNotes entry={entry} />
        </div>
        <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close the entry">
          <X size={16} />
        </button>
      </div>

      <NoticeBanner notice={notice} onDismiss={clear} className={styles.detailNotice} />

      {/* ── Review ── */}
      <section className={styles.statusBlock} aria-label="Review">
        <div className={styles.statusRow}>
          <EntryStatusBadge status={entry.status} />
          <span className={styles.statusSince}>
            since <SentAt iso={entry.statusChangedAt} />
          </span>
        </div>
        {entry.status === "rejected" && (
          <p className={styles.reasonText}>
            Reason, as the cleaner sees it: <FieldText value={entry.statusReason} />
          </p>
        )}
        {entry.status === "removed" && (
          <p className={styles.statusNote}>
            Removed: it stays here, marked, and does not count in totals or reports. Approve it to count it again.
          </p>
        )}
        {entry.status === "rejected" && (
          <p className={styles.statusNote}>Rejected: it does not count in totals or reports.</p>
        )}

        {reviewable ? (
          <div className={styles.actions}>
            {entry.status !== "approved" && (
              <button type="button" className={styles.btnApprove} disabled={busy} onClick={() => review("approved")}>
                <Check size={15} aria-hidden />
                <span>{saving === "approved" ? "Saving…" : "Approve"}</span>
              </button>
            )}
            {entry.status !== "rejected" && (
              <button
                type="button"
                className={styles.btnGhost}
                disabled={busy || rejecting}
                onClick={() => {
                  clear();
                  setRejecting(true);
                }}
              >
                <Ban size={15} aria-hidden />
                <span>Reject…</span>
              </button>
            )}
            {entry.status !== "removed" && (
              <button type="button" className={styles.btnGhost} disabled={busy} onClick={() => review("removed")}>
                <Trash2 size={15} aria-hidden />
                <span>{saving === "removed" ? "Saving…" : "Remove…"}</span>
              </button>
            )}
          </div>
        ) : (
          <p className={styles.noteWarn}>
            This entry’s history cannot be read, so it cannot be reviewed here. Nothing about it has been changed.
          </p>
        )}

        {rejecting && (
          <form
            className={styles.inlineForm}
            onSubmit={(event) => {
              event.preventDefault();
              review("rejected");
            }}
          >
            <label htmlFor="reject-reason" className={styles.fieldLabel}>
              Why is it rejected? The cleaner sees this.
            </label>
            <textarea
              id="reject-reason"
              className={styles.textInput}
              rows={3}
              maxLength={LIMITS.REASON_MAX}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={busy}
              autoFocus
            />
            <div className={styles.formRow}>
              <button type="submit" className={styles.btnReject} disabled={busy || reason.trim() === ""}>
                {saving === "rejected" ? "Saving…" : "Reject entry"}
              </button>
              <button
                type="button"
                className={styles.btnGhost}
                disabled={busy}
                onClick={() => {
                  setRejecting(false);
                  setReason("");
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </section>

      {/* ── Receipt ── */}
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Receipt</h3>
        {entry.receipts === null || entry.receipts.length === 0 ? (
          <Absent label="No receipt on record" />
        ) : (
          <ReceiptImage key={entry.id} entryId={entry.id} />
        )}
      </section>

      {/* ── Items ── */}
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Items</h3>
        {now.kind === "unreadable" ? (
          <div>
            <p className={styles.noteWarn}>
              {now.reason} This entry is not counted in any total or report, and its lines cannot be corrected here.
            </p>
            {entry.lines !== null && entry.lines.length > 0 && (
              <ul className={styles.rawLines}>
                {entry.lines.map((line, i) => (
                  <li key={i}>
                    {i + 1}. {lineText(line)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <>
            <div className={styles.linesScroll}>
              <table className={styles.lines}>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Item</th>
                    <th>Qty (reference)</th>
                    <th className={styles.num}>Line total as printed</th>
                  </tr>
                </thead>
                <tbody>
                  {now.lines.map((line) => (
                    <tr key={line.index} className={draft?.index === line.index ? styles.lineEditing : undefined}>
                      <td className={styles.lineNumber}>{line.index + 1}</td>
                      <td className={styles.lineName}>
                        <FieldText value={line.name} />
                        {line.origin === "added" && (
                          <span className={`${styles.badge} ${styles.badgeAdded}`}>Added by admin</span>
                        )}
                        {line.earlier.map((version, i) => (
                          <span key={i} className={styles.earlier}>
                            <s>
                              {version.name ?? "no name"} · {quantityText(version.quantity)} ·{" "}
                              {formatCents(version.lineTotalCents)}
                            </s>{" "}
                            <span className={styles.earlierWhen}>
                              {line.origin === "sent" && i === 0 ? "as sent" : "earlier"}, replaced{" "}
                              <SentAt iso={version.replacedAt} />
                            </span>
                          </span>
                        ))}
                        {reviewable && (
                          <button
                            type="button"
                            className={styles.lineAction}
                            disabled={busy}
                            onClick={() => correct(line)}
                            aria-label={`Correct line ${line.index + 1}`}
                          >
                            Correct
                          </button>
                        )}
                      </td>
                      <td>{quantityText(line.quantity)}</td>
                      <td className={styles.num}>{formatCents(line.lineTotalCents)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td />
                    <td colSpan={2}>Total</td>
                    <td className={styles.num}>{formatCents(now.totalCents)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            {now.corrected && (
              <p className={styles.note}>The cleaner sent {formatCents(now.sentTotalCents)}; corrections are above.</p>
            )}
            <p className={styles.note}>
              Each amount is what the receipt prints for that line, for all of that item together. Quantities are for
              reference and are never multiplied.
            </p>

            {draft ? (
              <form className={styles.inlineForm} onSubmit={saveLine} aria-label="Line editor">
                <p className={styles.editorTitle}>
                  {draft.index === null ? "Add a line" : `Correct line ${draft.index + 1}`}
                </p>
                <div className={styles.editorGrid}>
                  <label className={styles.editorField}>
                    <span className={styles.fieldLabel}>Item</span>
                    <input
                      className={styles.textInput}
                      value={draft.name}
                      maxLength={LIMITS.LINE_NAME_MAX}
                      onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                      disabled={busy}
                      autoFocus
                    />
                  </label>
                  <label className={styles.editorField}>
                    <span className={styles.fieldLabel}>Qty (reference only)</span>
                    <input
                      className={styles.textInput}
                      inputMode="decimal"
                      value={draft.quantity}
                      onChange={(e) => setDraft({ ...draft, quantity: e.target.value })}
                      disabled={busy}
                    />
                  </label>
                  <label className={styles.editorField}>
                    <span className={styles.fieldLabel}>Line total as printed ($)</span>
                    <input
                      className={styles.textInput}
                      inputMode="decimal"
                      placeholder="7.98, or -5.00 for money back"
                      value={draft.amount}
                      onChange={(e) => setDraft({ ...draft, amount: e.target.value })}
                      disabled={busy}
                    />
                  </label>
                </div>
                <p className={styles.note}>
                  The amount the receipt prints for this line — for all of it together, not for one.
                </p>
                <div className={styles.formRow}>
                  <button type="submit" className={styles.btnApprove} disabled={busy}>
                    {saving === "line" ? "Saving…" : draft.index === null ? "Add line" : "Save correction"}
                  </button>
                  <button type="button" className={styles.btnGhost} disabled={busy} onClick={() => setDraft(null)}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              reviewable && (
                <button type="button" className={styles.btnGhost} disabled={busy} onClick={add}>
                  <Plus size={15} aria-hidden />
                  <span>Add a line</span>
                </button>
              )
            )}
          </>
        )}
      </section>

      {/* ── From the cleaner, when there is anything ── */}
      {(entry.note !== null || entry.purchasedOn !== null) && (
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>From the cleaner</h3>
          {entry.purchasedOn !== null && <p className={styles.fieldValue}>Bought on {entry.purchasedOn}</p>}
          {entry.note !== null && <p className={styles.message}>{entry.note}</p>}
        </section>
      )}

      {/* ── History ── */}
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>History</h3>
        {entry.history === null ? (
          <Absent label="No history on record" />
        ) : (
          <ol className={styles.history}>
            {entry.history.map((event, i) => (
              <li key={i}>
                <span className={styles.historyWhen}>
                  <SentAt iso={event.at} />
                </span>
                <span className={styles.historyWhat}>{describe(event)}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <p className={styles.docId}>
        Entry <span className={styles.mono}>{entry.id}</span>
      </p>
    </div>
  );
}

/** Where a name comes from, when it is not simply the current one. */
function NameNotes({ entry }: { entry: CostEntryView }) {
  const notes: string[] = [];
  const { property, cleaner } = entry;
  if (property.state === "missing" && property.id !== null) {
    notes.push("This property no longer exists; its name is the one recorded with the entry.");
  } else if (property.state === "unreadable") {
    notes.push("The property’s current name could not be read; this is the one recorded with the entry.");
  } else if (property.state === "found" && property.nameAtEntry !== null && property.name !== property.nameAtEntry) {
    notes.push(`Logged under the property name “${property.nameAtEntry}”.`);
  }
  if (cleaner.state === "missing" && cleaner.id !== null) {
    notes.push("This cleaner no longer exists; the name is the one recorded with the entry.");
  } else if (cleaner.state === "unreadable") {
    notes.push("The cleaner’s current name could not be read; this is the one recorded with the entry.");
  }
  if (notes.length === 0) return null;
  return (
    <>
      {notes.map((note) => (
        <p key={note} className={styles.note}>
          {note}
        </p>
      ))}
    </>
  );
}

/** Who did it: the cleaner by name, or "an admin" — one shared PIN, so never which one. */
function actorOf(event: HistoryEventView): string {
  if (event.actor?.role === "cleaner") return event.actor.name ?? "the cleaner";
  if (event.actor?.role === "admin") return "an admin";
  return "someone not recorded";
}

function lineNumber(event: HistoryEventView): string {
  const index = event.line?.index;
  return typeof index === "number" ? String(index + 1) : "?";
}

/** One history event in words. An action this page does not know is shown as stored, marked. */
function describe(event: HistoryEventView): ReactNode {
  const by = actorOf(event);
  switch (event.action) {
    case "submitted":
      return (
        <>
          Sent by {by}
          {event.to !== null && <> · {statusWord(event.to)}</>}
        </>
      );
    case "approved":
    case "rejected":
    case "removed":
      return (
        <>
          {HISTORY_ACTION_LABELS[event.action]} by {by}
          {event.from !== null && <> · was {statusWord(event.from)}</>}
          {event.reason !== null && <span className={styles.historyReason}>“{event.reason}”</span>}
        </>
      );
    case "line_corrected":
      return (
        <>
          Line {lineNumber(event)} corrected by {by}: <s>{lineText(event.line?.before)}</s> → {lineText(event.line?.after)}
        </>
      );
    case "line_added":
      return (
        <>
          Line {lineNumber(event)} added by {by}: {lineText(event.line?.after)}
        </>
      );
    default:
      return (
        <span className={`${styles.badge} ${styles.badgeOdd}`} title="Not an action this page knows">
          {event.action ?? "No action recorded"}
        </span>
      );
  }
}

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** A refusal's detail, with what it means for a signed-out admin. */
function failureDetail(failure: Extract<CostResult<unknown>, { ok: false }>): string | undefined {
  const parts = failure.detail ? [sentence(failure.detail)] : [];
  if (failure.status === 401 || failure.status === 403) parts.push(SESSION_HINT, "Nothing was changed.");
  if (failure.code === "ENTRY_CHANGED") parts.push("Use Refresh at the top of the page.");
  return parts.join(" ") || undefined;
}
