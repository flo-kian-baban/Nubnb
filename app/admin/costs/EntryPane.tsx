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
 * ── Items, tax, total (dispatch 21) ──
 * Under the receipt: the items bought, then the tax, then the total, each
 * apart and unmistakable. Tax is its own field on an entry sent since
 * dispatch 21 and can be corrected here; an older entry keeps whatever tax
 * the cleaner typed as a line among its items, is shown as such, and its
 * tax line is corrected like any other line. The two are told apart by the
 * stored field, never by a line's name.
 *
 * ── After approval (Kian's ruling of 2026-09-30) ──
 * Nothing above depends on the entry's status: an approved entry is
 * corrected, or removed, exactly as a pending one is, and the pane says so.
 * An approved entry may already be in a PDF a co-owner holds, so the pane
 * lists every PDF the entry went out in, with what each printed for it, says
 * plainly when the newest PDF for its day no longer matches it, and sets each
 * PDF in the history at the point it was made, so what came after it is
 * plain to see.
 *
 * ── Approved automatically, and work (dispatch 24) ──
 * An entry approved automatically says so, with the rule it met, and offers
 * Seen while no admin has looked at it; correcting, removing or rejecting it
 * counts as seen. Under it, the cleaner's last 90 days in words, the
 * $150–200 band always named. A handyman's work entry shows "Work done" in
 * place of "Items bought": the description in full and the one amount, both
 * correctable as a line; no line is added to it, and it has no receipt.
 *
 * Changes are not optimistic. Each sends the length of the history this pane
 * shows, and the server refuses it if the entry changed since — another
 * admin, say. The pane changes only to the entry the server returns. An
 * answer that does not say whether a change landed is reported as such.
 */

import { useState, type FormEvent, type ReactNode } from "react";
import { AlertTriangle, Ban, Check, Eye, Plus, Trash2, X } from "lucide-react";
import { NoticeBanner, useNotice, type Notice } from "../components/Notice";
import { changeEntryLine, changeEntryTax, markEntrySeen, setEntryStatus, type CostResult, type EntryChange } from "@/app/lib/costs-client";
import {
  ENTRY_STATUS_LABELS,
  HISTORY_ACTION_LABELS,
  LIMITS,
  awaitingLook,
  formatCents,
  type CostEntryView,
  type HistoryEventView,
  type LineNow,
  type ReviewStatus,
} from "@/app/lib/cleaners/model";
import { distributionText, splitText, type CleanerPattern } from "@/app/lib/costs/patterns";
import {
  cleanerLabel,
  propertyLabel,
  shortDay,
  type EntryPdfState,
  type PdfAppearance,
  type PdfRecord,
} from "@/app/lib/costs/report";
import { Absent, FieldText } from "../leads/lead-display";
import {
  EntryStatusBadge,
  KindBadge,
  SentAt,
  amountField,
  amountText,
  lineText,
  quantityText,
  readAmount,
  readQuantity,
  statusWord,
  whenText,
} from "./cost-display";
import { ReceiptImage } from "./ReceiptImage";
import styles from "./page.module.css";

interface EntryPaneProps {
  entry: CostEntryView;
  /** The PDFs this entry went out in, and how it stands beside the newest for its day; null when it was never in one. */
  pdf: EntryPdfState | null;
  /** The cleaner's last 90 days (dispatch 24); null when they sent nothing in the window. */
  pattern: CleanerPattern | null;
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
  approved: "It counts in its property’s ledger, totals and reports. It can still be corrected or removed.",
  rejected: "The cleaner sees the reason in their app. It no longer counts in totals or reports, and stays in the review queue, marked.",
  removed: "It has left its property’s ledger, totals and reports, and stays in the review queue, marked.",
};

export function EntryPane({ entry, pdf, pattern, onChanged, onClose }: EntryPaneProps) {
  /** What is being saved, for its button's label; null when nothing is. */
  const [saving, setSaving] = useState<ReviewStatus | "line" | "tax" | "seen" | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [draft, setDraft] = useState<LineDraft | null>(null);
  /** The tax being corrected, as typed; null when it is not. */
  const [taxDraft, setTaxDraft] = useState<string | null>(null);
  const { notice, show, clear } = useNotice();

  /** The history length this pane shows; null when there is no history to add to. */
  const seen = entry.history?.length ?? null;
  const reviewable = seen !== null;
  const busy = saving !== null;
  const now = entry.linesNow;
  const work = entry.kind === "work";
  const unseen = awaitingLook(entry);
  /** The amount the auto-approval rule saw, as stored; null when the record is not in the written shape. */
  const autoTotal = typeof entry.autoApproved?.totalCents === "number" ? entry.autoApproved.totalCents : null;
  /**
   * The PDF to go by still lists this approved entry, so taking the entry out
   * of the ledger makes that PDF wrong: said before the admin does it.
   */
  const listedIn = entry.status === "approved" && pdf !== null && pdf.latest !== "not-listed" ? pdf.lastListed.record : null;
  const leavesPdf = listedIn
    ? ` It is in the PDF exported ${whenText(listedIn.createdAt)}: that PDF will no longer match the ledger.`
    : "";

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
        `Remove this entry? It stays in the record, marked removed, and stops counting in totals and reports. Approving it later counts it again.${leavesPdf}`,
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

  const markSeen = async () => {
    if (busy || seen === null) return;
    clear();
    setSaving("seen");
    const result = await markEntrySeen(entry.id, { seen });
    setSaving(null);
    settle(result, (change) =>
      change.changed
        ? { tone: "success", title: "Marked as seen.", detail: "It is still approved and counts in its ledger; it has left the review queue." }
        : { tone: "info", title: "Nothing was changed: an admin had already looked at it." },
    );
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

  const saveTax = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (taxDraft === null || busy || seen === null) return;
    const typed = taxDraft.trim();
    const tax = typed === "" ? null : readAmount(typed);
    if (typed !== "" && (tax === null || tax.startsWith("-"))) {
      show({ tone: "error", title: "The tax was not saved.", items: ["Check the tax: dollars and cents as printed, like 12.71, or empty for none."] });
      return;
    }
    clear();
    setSaving("tax");
    const result = await changeEntryTax(entry.id, { tax, seen });
    setSaving(null);
    const saved = settle(result, (change) =>
      change.changed
        ? { tone: "success", title: "Tax corrected.", detail: "What it was before stays in the history." }
        : { tone: "info", title: "Nothing was changed: the tax already said that." },
    );
    if (saved) setTaxDraft(null);
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
            {cleanerLabel(entry)} <KindBadge kind={entry.kind} /> · sent <SentAt iso={entry.createdAt} />
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
          <EntryStatusBadge status={entry.status} auto={entry.autoApproved !== null} />
          <span className={styles.statusSince}>
            since <SentAt iso={entry.statusChangedAt} />
          </span>
        </div>
        {entry.autoApproved !== null && (
          <p className={unseen ? styles.autoNote : styles.statusNote}>
            {unseen
              ? "Approved automatically: under $200.00, and no admin has looked at it. It counts in the ledger now. Correct it, remove it, or mark it seen."
              : "Approved automatically: under $200.00 as sent."}
            {autoTotal !== null && ` The rule saw ${formatCents(autoTotal)}.`}
          </p>
        )}
        {entry.status === "rejected" && (
          <p className={styles.reasonText}>
            Reason, as the cleaner sees it: <FieldText value={entry.statusReason} />
          </p>
        )}
        {entry.status === "removed" && (
          <p className={styles.statusNote}>
            Removed: it stays in the record and in the review queue, marked, and does not count in totals or reports.
            Approve it to count it again.
          </p>
        )}
        {entry.status === "rejected" && (
          <p className={styles.statusNote}>Rejected: it does not count in totals or reports.</p>
        )}
        {entry.status === "approved" && reviewable && (
          <p className={styles.statusNote}>
            Approved: it counts in its property’s ledger and reports. It can still be corrected or removed; every
            change is recorded in the history below, and nothing is erased.
          </p>
        )}

        {reviewable ? (
          <div className={styles.actions}>
            {unseen && (
              <button type="button" className={styles.btnApprove} disabled={busy} onClick={markSeen}>
                <Eye size={15} aria-hidden />
                <span>{saving === "seen" ? "Saving…" : "Seen"}</span>
              </button>
            )}
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
            {leavesPdf !== "" && <p className={styles.noteWarn}>{leavesPdf.trim()}</p>}
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

      {/* ── The PDFs it went out in, when there are any ── */}
      {pdf !== null && <PdfSection entry={entry} pdf={pdf} />}

      {/* ── Receipt ── */}
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Receipt</h3>
        {entry.receipts !== null && entry.receipts.length > 0 ? (
          <ReceiptImage key={entry.id} entryId={entry.id} />
        ) : work ? (
          <p className={styles.note}>No receipt: handyman work. The description and the price are what the handyman logged.</p>
        ) : (
          <Absent label="No receipt on record" />
        )}
      </section>

      {/* ── Items, then tax, then total — or the work done ── */}
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>{work ? "Work done" : "Items bought"}</h3>
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
                    <th>{work ? "Description" : "Item"}</th>
                    <th>Qty (reference)</th>
                    <th className={styles.num}>{work ? "Price" : "Line total as printed"}</th>
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
                    <td colSpan={2}>Items</td>
                    <td className={styles.num}>{formatCents(now.itemsCents)}</td>
                  </tr>
                  <tr className={styles.taxRow}>
                    <td />
                    <td colSpan={2}>
                      Tax
                      {now.taxShape === "in-lines" && (
                        <span className={styles.note}> · sent before tax was its own field: any tax is a line among the items above</span>
                      )}
                      {now.taxShape === "field" && reviewable && taxDraft === null && (
                        <button
                          type="button"
                          className={styles.lineAction}
                          disabled={busy}
                          onClick={() => {
                            clear();
                            setTaxDraft(now.taxCents === null ? "" : amountField(now.taxCents));
                          }}
                          aria-label="Correct the tax"
                        >
                          Correct
                        </button>
                      )}
                    </td>
                    <td className={styles.num}>
                      {now.taxShape === "in-lines" ? "in items" : now.taxCents === null ? "none" : formatCents(now.taxCents)}
                    </td>
                  </tr>
                  <tr className={styles.totalRow}>
                    <td />
                    <td colSpan={2}>Total</td>
                    <td className={styles.num}>{formatCents(now.totalCents)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            {now.corrected && (
              <p className={styles.note}>The {work ? "handyman" : "cleaner"} sent {formatCents(now.sentTotalCents)}; corrections are above.</p>
            )}
            <p className={styles.note}>
              {work
                ? "The description and the price are as the handyman logged them, corrections applied. Tax can be recorded if an invoice carries it. The total is the price plus the tax."
                : "Each amount is what the receipt prints for that line, for all of that item together. Quantities are for reference and are never multiplied. The total is the items plus the tax."}
            </p>

            {taxDraft !== null && (
              <form className={styles.inlineForm} onSubmit={saveTax} aria-label="Tax editor">
                <p className={styles.editorTitle}>Correct the tax</p>
                <label className={styles.editorField}>
                  <span className={styles.fieldLabel}>Tax as printed ($)</span>
                  <input
                    className={styles.textInput}
                    inputMode="decimal"
                    placeholder="12.71, or empty for none"
                    value={taxDraft}
                    onChange={(e) => setTaxDraft(e.target.value)}
                    disabled={busy}
                    autoFocus
                  />
                </label>
                <div className={styles.formRow}>
                  <button type="submit" className={styles.btnApprove} disabled={busy}>
                    {saving === "tax" ? "Saving…" : "Save tax"}
                  </button>
                  <button type="button" className={styles.btnGhost} disabled={busy} onClick={() => setTaxDraft(null)}>
                    Cancel
                  </button>
                </div>
              </form>
            )}

            {draft ? (
              <form className={styles.inlineForm} onSubmit={saveLine} aria-label="Line editor">
                <p className={styles.editorTitle}>
                  {draft.index === null ? "Add a line" : `Correct line ${draft.index + 1}`}
                </p>
                <div className={styles.editorGrid}>
                  <label className={styles.editorField}>
                    <span className={styles.fieldLabel}>{work ? "Description" : "Item"}</span>
                    <input
                      className={styles.textInput}
                      value={draft.name}
                      maxLength={work ? LIMITS.WORK_DESCRIPTION_MAX : LIMITS.LINE_NAME_MAX}
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
                    <span className={styles.fieldLabel}>{work ? "Price ($)" : "Line total as printed ($)"}</span>
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
              reviewable &&
              !work && (
                <button type="button" className={styles.btnGhost} disabled={busy} onClick={add}>
                  <Plus size={15} aria-hidden />
                  <span>Add a line</span>
                </button>
              )
            )}
          </>
        )}
      </section>

      {/* ── The cleaner's last 90 days (dispatch 24) ── */}
      {!work && (
        <section className={styles.section} aria-label="This cleaner's last 90 days">
          <h3 className={styles.sectionTitle}>{cleanerLabel(entry)}, last 90 days</h3>
          {pattern === null ? (
            <p className={styles.note}>No receipts in the last 90 days.</p>
          ) : (
            <>
              <p className={pattern.worthALook ? styles.noteWarn : styles.note}>{distributionText(pattern)}</p>
              {pattern.splits.length > 0 && (
                <ul className={styles.watchSplits}>
                  {pattern.splits.map((split) => (
                    <li key={`${split.day}-${split.propertyId ?? ""}`}>Same-day split: {splitText(split)}</li>
                  ))}
                </ul>
              )}
              {pattern.worthALook && <p className={styles.noteWarn}>Worth a look: {pattern.reasons.join("; ")}.</p>}
            </>
          )}
        </section>
      )}

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
            {timeline(entry.history, pdf).map((item, i) =>
              item.kind === "event" ? (
                <li key={i}>
                  <span className={styles.historyWhen}>
                    <SentAt iso={item.event.at} />
                  </span>
                  <span className={styles.historyWhat}>{describe(item.event)}</span>
                </li>
              ) : (
                /* Not an event of the entry's own: a PDF, set where it was made, so what came after it is plain. */
                <li key={i} className={styles.historyPdf}>
                  <span className={styles.historyWhen}>
                    <SentAt iso={item.appearance.record.createdAt} seconds />
                  </span>
                  <span className={styles.historyWhat}>
                    <span className={`${styles.badge} ${styles.badgePdfTag}`}>PDF</span> Went out in a PDF for{" "}
                    {periodText(item.appearance.record)}, shown at {formatCents(item.appearance.printed.totalCents)}
                  </span>
                </li>
              ),
            )}
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

/** A PDF's period in a few words: "1 Sep 2026 – 30 Sep 2026", or one day alone. */
function periodText(record: PdfRecord): string {
  return record.from === record.to ? shortDay(record.from) : `${shortDay(record.from)} – ${shortDay(record.to)}`;
}

type TimelineItem = { kind: "event"; event: HistoryEventView } | { kind: "pdf"; appearance: PdfAppearance };

/**
 * The entry's history with each PDF it went out in set at the point it was
 * made: a PDF made when the history held n events comes after the n-th. The
 * history itself is shown whole, in its stored order.
 */
function timeline(history: HistoryEventView[], pdf: EntryPdfState | null): TimelineItem[] {
  const oldestFirst = [...(pdf?.appearances ?? [])].reverse();
  const items: TimelineItem[] = [];
  history.forEach((event, index) => {
    for (const appearance of oldestFirst) {
      if (appearance.printed.historyLength === index) items.push({ kind: "pdf", appearance });
    }
    items.push({ kind: "event", event });
  });
  for (const appearance of oldestFirst) {
    if (appearance.printed.historyLength >= history.length) items.push({ kind: "pdf", appearance });
  }
  return items;
}

/** What a PDF printed as an entry's tax: the amount, or why there is none. */
function printedTax(entry: CostEntryView, cents: number | null): string {
  if (cents !== null) return `tax ${formatCents(cents)}`;
  return entry.taxShape === "in-lines" ? "tax in items" : "no tax";
}

/** How the entry stands now beside one PDF, in a few words. */
function sinceText(since: PdfAppearance["since"]): string {
  switch (since.kind) {
    case "same":
      return "still the same";
    case "corrected":
      return "corrected since, the amounts unchanged";
    case "amount-changed":
      return `now ${formatCents(since.nowTotalCents)}`;
    case "left":
      return `${statusWord(since.status)} since`;
    case "unreadable":
      return "cannot be added up now";
    case "missing":
      return "no longer on record";
  }
}

/** How many of an entry's PDFs the pane lists, newest first; every one is still set in the history. */
const PDFS_LISTED = 3;

/**
 * The PDFs an entry went out in, newest first, with what each printed for
 * it — and, when the newest PDF for its day no longer says what the entry
 * says, a plain statement of that: someone may be holding it.
 */
function PdfSection({ entry, pdf }: { entry: CostEntryView; pdf: EntryPdfState }) {
  const { record, printed } = pdf.lastListed;
  const when = whenText(record.createdAt);
  const was = formatCents(printed.totalCents);
  const nowTotal = entry.linesNow.kind === "ok" ? formatCents(entry.linesNow.totalCents) : "an amount that cannot be worked out";
  const alert =
    pdf.latest === "amount-changed"
      ? `Changed since it went out in a PDF. The PDF exported ${when} shows this entry at ${was}; it now adds up to ${nowTotal}. Whoever received that PDF holds the old figure: export the PDF again for the same dates.`
      : pdf.latest === "left"
        ? `This entry is ${statusWord(entry.status)}, but the PDF exported ${when} still lists it at ${was}. Whoever received that PDF holds a total that includes it: export the PDF again for the same dates.`
        : pdf.latest === "unreadable" || pdf.latest === "missing"
          ? `The PDF exported ${when} shows this entry at ${was}, and it cannot be compared now.`
          : null;
  return (
    <section className={styles.section} aria-label="PDFs it went out in">
      <h3 className={styles.sectionTitle}>PDFs it went out in</h3>
      {alert !== null && (
        <p className={styles.pdfAlert} role="status">
          <AlertTriangle size={15} aria-hidden />
          <span>{alert}</span>
        </p>
      )}
      {pdf.latest === "corrected" && (
        <p className={styles.note}>
          Corrected after the PDF exported {when}, without changing an amount: what was bought may read differently
          there.
        </p>
      )}
      {pdf.latest === "not-listed" && <p className={styles.note}>A newer PDF covering its day does not list it.</p>}
      <ul className={styles.pdfList}>
        {pdf.appearances.slice(0, PDFS_LISTED).map((appearance) => (
          <li key={appearance.record.id}>
            <span className={styles.pdfWhen}>
              Exported <SentAt iso={appearance.record.createdAt} seconds /> · {periodText(appearance.record)}
            </span>
            <span className={styles.pdfSaid}>
              showed {formatCents(appearance.printed.totalCents)} (items {formatCents(appearance.printed.itemsCents)},{" "}
              {printedTax(entry, appearance.printed.taxCents)}) · {sinceText(appearance.since)}
            </span>
          </li>
        ))}
      </ul>
      {pdf.appearances.length > PDFS_LISTED && (
        <p className={styles.note}>
          and {pdf.appearances.length - PDFS_LISTED} earlier{" "}
          {pdf.appearances.length - PDFS_LISTED === 1 ? "PDF" : "PDFs"}, each set in the history below and listed in
          the property’s ledger.
        </p>
      )}
    </section>
  );
}

/** Who did it: the cleaner or handyman by name, "an admin" (one shared PIN, so never which one), or the rule. */
function actorOf(event: HistoryEventView): string {
  if (event.actor?.role === "cleaner") return event.actor.name ?? "the cleaner";
  if (event.actor?.role === "handyman") return event.actor.name ?? "the handyman";
  if (event.actor?.role === "admin") return "an admin";
  if (event.actor?.role === "system") return "the rule";
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
          {event.actor?.role === "system" ? "Approved automatically" : `${HISTORY_ACTION_LABELS[event.action]} by ${by}`}
          {event.from !== null && <> · was {statusWord(event.from)}</>}
          {event.reason !== null && <span className={styles.historyReason}>“{event.reason}”</span>}
        </>
      );
    case "seen":
      return <>Marked as seen by {by}</>;
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
    case "tax_corrected":
      return (
        <>
          Tax corrected by {by}: <s>{amountText(event.tax?.before ?? null)}</s> → {amountText(event.tax?.after ?? null)}
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
