"use client";

/**
 * A property's income and statements, on its page (dispatch 23D, Kian's
 * ruling of 2026-09-30): the property's page is where an admin works, so
 * beside its costs it shows, for one chosen month, the income rows and the
 * statement, and across months which closed months are outstanding.
 *
 * Laid out for clarity (Kian, the same night): one month control, two
 * labelled blocks, the state said once as a badge, the controls carrying
 * the meaning, and no explanatory prose.
 *
 * ── The month ──
 * One control, defaulting to the current month, over both blocks; each
 * month in it says what it is. Beside it, one line: which closed months are
 * outstanding, or that none is.
 *
 * ── Income ──
 * Lines live in the month's draft, the same document the statement editor
 * saves; adding or removing one here saves the draft whole through the same
 * route, against the revision this page loaded, so an editor open in another
 * tab is never written over (DRAFT_CHANGED reloads). A finished month's lines
 * are shown frozen from the statement. A line added here is a description
 * and an amount: quantity 1, the rate the amount (dispatch 23E); the editor
 * has the full line. A line loaded from a row written before shows what
 * else it carried, kept as it is.
 *
 * ── Statement ──
 * The month's state, the way in (Create / Continue / Open, each the statement
 * editor), Download PDF when finished, and every finished statement of the
 * property under it.
 *
 * Reads one call, GET /api/admin/properties/[id]/statements, made by the
 * costs page and handed down; "Could not load" is never "nothing here".
 */

import { useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { AlertTriangle, Download, Plus, Trash2 } from "lucide-react";
import { AdminSelect } from "../components/AdminSelect";
import type { Notice } from "../components/Notice";
import { fetchStatementLink, saveDraft, type DraftPayload, type FeePayload, type LinePayload, type PropertyStatements } from "@/app/lib/reports-client";
import { formatCents } from "@/app/lib/cleaners/model";
import { torontoDayOf } from "@/app/lib/costs/report";
import { STATEMENT_LIMITS, displayRef, lineFromIncomeRow, monthLabel, monthOfDay, rateText, statementMonths, type Fee, type Line, type StatementDraftView } from "@/app/lib/reports/model";
import { STATEMENT_STATE_LABELS, closingWords, lineDetailsText, lineText, propertyMonths, type PropertyMonthRow } from "@/app/lib/reports/statement";
import { SentAt, amountField, readAmount, whenText } from "./cost-display";
import styles from "./page.module.css";

/** What the costs page knows about one property's statements. */
export type PropertyStatementsState = { kind: "loading" } | { kind: "ready"; data: PropertyStatements } | { kind: "error"; title: string; detail?: string; status: number };

interface Props {
  propertyId: string;
  statements: PropertyStatementsState;
  /** Read the property's statements again. */
  onReload: () => void;
  /** The data as it now stands, after a save or a download record. */
  onData: (data: PropertyStatements) => void;
  show: (notice: Notice) => void;
}

const newId = () => (typeof crypto.randomUUID === "function" ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).slice(0, 36);

/** A stored line as the draft route takes it: the rate as typed, the earlier fields exactly as loaded. */
function toPayloadLine(line: Line): LinePayload {
  const out: LinePayload = { id: line.id, description: line.description, from: line.from, to: line.to, quantity: line.quantity, rate: amountField(line.rateCents) };
  if (line.source !== undefined) out.source = line.source;
  if ('reference' in line) out.reference = line.reference ?? null;
  return out;
}

/** A stored fee as the draft route takes it, sent back as loaded. */
function toPayloadFee(fee: Fee | null): FeePayload | null {
  if (!fee) return null;
  return { label: fee.label, rate: fee.rateBasisPoints === null ? null : rateText(fee.rateBasisPoints).replace('%', ''), base: amountField(fee.baseCents), amount: fee.overwritten || fee.rateBasisPoints === null ? amountField(fee.amountCents) : null };
}

/** A month's state in a few words, for the month list. */
function stateWords(row: PropertyMonthRow): string {
  switch (row.state.kind) {
    case "finished":
      return `finished · ${displayRef(row.state.report)}`;
    case "draft":
      return row.state.superseding ? "correction in progress" : "draft";
    case "outstanding":
      return "outstanding";
    case "open":
      return "open, not yet due";
  }
}

const BADGE: Record<PropertyMonthRow["state"]["kind"], string> = {
  outstanding: styles.badgeOutstanding,
  open: styles.badgeOpen,
  draft: styles.badgeDraft,
  finished: styles.badgeFinished,
};

const money = (cents: number) => formatCents(cents);

export function PropertyPanel({ propertyId, statements, onReload, onData, show }: Props) {
  const today = torontoDayOf(new Date());
  const [month, setMonth] = useState(() => monthOfDay(today));
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [saving, setSaving] = useState(false);
  const [linking, setLinking] = useState<string | null>(null);

  const data = statements.kind === "ready" ? statements.data : null;
  const months = useMemo(
    () => (data ? propertyMonths({ propertyId, today, management: data.management, reports: data.reports, drafts: data.drafts.map((d) => ({ propertyId: d.propertyId, month: d.month, updatedAt: d.updatedAt, finishedAs: d.finishedAs, superseding: d.supersedes !== null })) }) : null),
    [data, propertyId, today],
  );
  const row = months?.rows.find((r) => r.month === month) ?? null;
  const draft: StatementDraftView | null = data?.drafts.find((d) => d.month === month) ?? null;
  const liveId = row?.state.kind === "finished" ? row.state.report.id : null;
  /** The month's current finished statement, whole (its income rows frozen), or null. */
  const finishedReport = liveId === null ? null : (data?.reports.find((r) => r.id === liveId) ?? null);
  const editor = (m: string) => `/admin/reports/edit?property=${encodeURIComponent(propertyId)}&month=${m}`;

  /** The lines shown: frozen from the finished statement (a legacy statement's rows as lines), else the draft's. */
  const rows: Line[] = finishedReport ? (finishedReport.legacy ? finishedReport.income.map(lineFromIncomeRow) : finishedReport.lines) : (draft?.lines ?? []);
  const incomeEditable = data !== null && finishedReport === null && (draft === null || draft.finishedAs === null);
  const incomeCents = rows.reduce((sum, r) => sum + r.amountCents, 0);

  /** Save the draft whole with these lines, against the revision loaded; the reference, date, fee, carried balance, notes and supersedes as stored (today's date and no fee on a first save; the editor offers the suggestions). */
  const saveRows = async (next: Line[], done: Notice) => {
    if (!data || saving) return false;
    setSaving(true);
    const payload: DraftPayload = {
      propertyId,
      month,
      revision: draft?.revision ?? 0,
      reference: draft?.reference ?? "",
      reportDate: draft?.reportDate || today,
      lines: next.map(toPayloadLine),
      fee: toPayloadFee(draft?.fee ?? null),
      carried: draft?.carried ? { label: draft.carried.label, amount: amountField(draft.carried.amountCents), fromReportId: draft.carried.fromReportId } : null,
      notes: draft?.notes ?? null,
      supersedes: draft?.supersedes ?? null,
    };
    const result = await saveDraft(payload);
    setSaving(false);
    if (result.ok) {
      const saved = result.data.draft;
      onData({ ...data, drafts: data.drafts.some((d) => d.id === saved.id) ? data.drafts.map((d) => (d.id === saved.id ? saved : d)) : [...data.drafts, saved] });
      show(done);
      return true;
    }
    if (result.code === "DRAFT_CHANGED" || result.code === "DRAFT_FINISHED") {
      show({ tone: "warning", title: result.code === "DRAFT_CHANGED" ? "This month's draft changed elsewhere. Nothing was saved; reloading it." : "This month's statement was finished meanwhile. Nothing was saved; reloading." });
      onReload();
      return false;
    }
    show(result.unknown ? { tone: "warning", title: "The row may or may not have been saved. Reload to see what is stored.", detail: result.title } : { tone: "error", title: result.title, detail: result.detail });
    return false;
  };

  const addRow = async (event: FormEvent) => {
    event.preventDefault();
    const text = label.normalize("NFC").replace(/\s+/g, " ").trim();
    const read = readAmount(amount);
    const problems = [text === "" ? "Describe the income." : null, read === null || read === "0.00" ? "Check the amount: like 800.00, or -120.00 for a refund." : null].filter((p): p is string => p !== null);
    if (problems.length > 0 || read === null) {
      show({ tone: "error", title: "Income not added.", items: problems });
      return;
    }
    const cents = Math.round(Number(read.replace("-", "")) * 100) * (read.startsWith("-") ? -1 : 1);
    const ok = await saveRows([...rows, { id: newId(), description: text, from: null, to: null, quantity: 1, rateCents: cents, amountCents: cents }], { tone: "success", title: `Line added: ${text}, ${money(cents)}.` });
    if (ok) {
      setLabel("");
      setAmount("");
    }
  };

  const removeRow = async (target: Line) => {
    if (!window.confirm(`Remove “${lineText(target)}” (${money(target.amountCents)}) from ${monthLabel(month)}?`)) return;
    await saveRows(rows.filter((r) => r.id !== target.id), { tone: "success", title: `Line removed: ${lineText(target)}.` });
  };

  const download = async (reportId: string) => {
    if (linking !== null || !data) return;
    setLinking(reportId);
    const result = await fetchStatementLink(reportId);
    setLinking(null);
    if (!result.ok) {
      show({ tone: "error", title: result.title, detail: result.detail });
      return;
    }
    window.open(result.data.url, "_blank", "noopener");
    onData({ ...data, downloads: [...data.downloads, result.data.download] });
    show({ tone: "success", title: `PDF opened; the link works for ${result.data.seconds} seconds.` });
  };

  if (statements.kind === "loading") {
    return (
      <section className={styles.panel} aria-label="Income and statements">
        <p className={styles.note}>Loading income and statements…</p>
      </section>
    );
  }
  if (statements.kind === "error" || !data || !months) {
    const title = statements.kind === "error" ? statements.title : "Not loaded";
    return (
      <section className={styles.panel} aria-label="Income and statements">
        <p className={styles.noteWarn} role="alert">
          <AlertTriangle size={14} aria-hidden /> Income and statements could not be loaded. {title}{" "}
          <button type="button" className={styles.linkButton} onClick={onReload}>
            Retry
          </button>
        </p>
      </section>
    );
  }

  const { from: firstMonth } = statementMonths(data.management);
  const finished = months.rows.filter((r) => r.reports.length > 0);
  const downloadsOf = (reportId: string) => data.downloads.filter((d) => d.reportId === reportId).map((d) => d.at).sort();
  const downloadTitle = (reportId: string) => {
    const d = downloadsOf(reportId);
    return d.length === 0 ? "Not downloaded yet" : `Downloaded ${d.length === 1 ? "once" : d.length === 2 ? "twice" : `${d.length} times`}, last ${whenText(d[d.length - 1])}`;
  };
  const stateLabel = (r: PropertyMonthRow) => (r.state.kind === "draft" && r.state.superseding ? "Correction in progress" : STATEMENT_STATE_LABELS[r.state.kind]);

  return (
    <section className={styles.panel} aria-label="Income and statements">
      {/* ── The month, and what is outstanding ── */}
      <div className={styles.panelMonth}>
        <AdminSelect
          label="Statement month"
          className={styles.monthSelect}
          value={month}
          onChange={setMonth}
          groups={[{ options: months.rows.map((r) => ({ value: r.month, label: `${monthLabel(r.month)} · ${stateWords(r)}` })) }]}
        />
        <span className={months.outstanding.length > 0 ? styles.noteWarn : styles.note} role="status">
          {months.outstanding.length === 0 ? (
            firstMonth > monthOfDay(today) ? `Nothing outstanding · statements from ${monthLabel(firstMonth)}` : "Nothing outstanding"
          ) : (
            <>
              Outstanding:{" "}
              {months.outstanding.map((m, i) => {
                const r = months.rows.find((x) => x.month === m);
                return (
                  <span key={m}>
                    {i > 0 && ", "}
                    <button type="button" className={styles.linkButton} onClick={() => setMonth(m)}>
                      {monthLabel(m)}
                    </button>
                    {r?.state.kind === "draft" && " (draft)"}
                  </span>
                );
              })}
            </>
          )}
        </span>
      </div>

      <div className={styles.panelGrid}>
        {/* ── Income ── */}
        <div className={styles.panelBlock} aria-label="Income">
          <div className={styles.panelHead}>
            <h3 className={styles.panelTitle}>Income</h3>
            <span className={styles.panelTotal}>{money(incomeCents)}</span>
          </div>
          {rows.length > 0 && (
            <ul className={styles.incomeList}>
              {rows.map((r) => {
                const detailsLine = lineDetailsText(r);
                return (
                  <li key={r.id} className={styles.incomeItem}>
                    <span className={styles.incomeLabel}>
                      {lineText(r)}
                      {r.quantity !== 1 && <span className={styles.incomeDetails}>{r.quantity} × {money(r.rateCents)}</span>}
                      {detailsLine !== "" && (
                        <span className={styles.incomeDetails} title="Recorded with this line before; kept as it is">
                          {detailsLine}
                        </span>
                      )}
                    </span>
                    <span className={`${styles.num} ${styles.incomeAmount}`}>{money(r.amountCents)}</span>
                    {incomeEditable ? (
                      <button type="button" className={styles.removeBtn} aria-label={`Remove ${lineText(r)}`} disabled={saving} onClick={() => removeRow(r)}>
                        <Trash2 size={13} aria-hidden />
                      </button>
                    ) : (
                      <span />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {finishedReport ? (
            <p className={styles.note}>
              {rows.length === 0 ? "No income. " : ""}In the finished statement.{" "}
              <Link href={editor(month)} prefetch={false} className={styles.linkButton}>
                Correct the statement
              </Link>
            </p>
          ) : incomeEditable ? (
            <form className={styles.incomeForm} onSubmit={addRow} aria-label="Add income">
              <input className={styles.textInput} placeholder="Description, e.g. Revenue - Airbnb" value={label} maxLength={STATEMENT_LIMITS.INCOME_LABEL_MAX} disabled={saving} onChange={(e) => setLabel(e.target.value)} aria-label="Income description" />
              <input className={`${styles.textInput} ${styles.num}`} placeholder="800.00" inputMode="decimal" value={amount} disabled={saving} onChange={(e) => setAmount(e.target.value)} aria-label="Income amount" />
              <button type="submit" className={styles.btnApprove} disabled={saving || rows.length >= STATEMENT_LIMITS.INCOME_ROWS_MAX}>
                <Plus size={14} aria-hidden />
                <span>{saving ? "Saving…" : "Add line"}</span>
              </button>
            </form>
          ) : null}
        </div>

        {/* ── Statement ── */}
        <div className={styles.panelBlock} aria-label="Statement">
          <div className={styles.panelHead}>
            <h3 className={styles.panelTitle}>Statement</h3>
            {row && <span className={`${styles.badge} ${BADGE[row.state.kind]}`}>{stateLabel(row)}</span>}
          </div>
          {row?.state.kind === "finished" && finishedReport && (
            <p className={styles.fieldValue}>
              <SentAt iso={row.state.report.finishedAt} /> · <span className={styles.mono}>{displayRef(row.state.report)}</span> · {closingWords(finishedReport.payableCents).label} {closingWords(finishedReport.payableCents).amount}
              {row.state.replaced > 0 && <span className={styles.muted}> · replaced ×{row.state.replaced}</span>}
            </p>
          )}
          {row?.state.kind === "draft" && (
            <p className={styles.fieldValue}>
              Saved <SentAt iso={row.state.savedAt} />
            </p>
          )}
          <div className={styles.formRow}>
            <Link href={editor(month)} prefetch={false} className={styles.btnApprove}>
              {row?.state.kind === "finished" ? "Open statement" : row?.state.kind === "draft" ? "Continue draft" : "Create statement"}
            </Link>
            {finishedReport && (
              <button type="button" className={styles.btnGhost} disabled={linking !== null} onClick={() => download(finishedReport.id)} title={downloadTitle(finishedReport.id)}>
                <Download size={14} aria-hidden />
                <span>{linking === finishedReport.id ? "Opening…" : "Download PDF"}</span>
              </button>
            )}
          </div>

          {finished.length > 0 && (
            <div className={styles.statementsAll}>
              <h4 className={styles.panelSub}>All statements</h4>
              <ul className={styles.statementList} aria-label="All statements">
                {finished.flatMap((r) =>
                  r.reports.map(({ report, replacedBy }) => (
                    <li key={report.id} className={styles.statementItem}>
                      <span>
                        {monthLabel(r.month)} <span className={styles.mono}>{displayRef(report)}</span>
                        {replacedBy && (
                          <span className={`${styles.badge} ${styles.badgeReplaced}`} title={`Replaced by ${displayRef(replacedBy)}: ${replacedBy.supersedes?.reason ?? ""}`}>
                            Replaced
                          </span>
                        )}
                      </span>
                      <span className={styles.num}>{formatCents(report.payableCents)}</span>
                      <span className={styles.formRow}>
                        <Link href={editor(r.month)} prefetch={false} className={styles.linkButton}>
                          Open
                        </Link>
                        <button type="button" className={styles.linkButton} disabled={linking !== null} onClick={() => download(report.id)} title={downloadTitle(report.id)}>
                          {linking === report.id ? "Opening…" : "PDF"}
                        </button>
                      </span>
                    </li>
                  )),
                )}
              </ul>
            </div>
          )}
          {(data.unreadable.reports > 0 || data.unreadable.drafts > 0) && (
            <p className={styles.noteWarn}>
              {data.unreadable.reports + data.unreadable.drafts} stored {data.unreadable.reports + data.unreadable.drafts === 1 ? "document is" : "documents are"} not in the written shape and left out.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
