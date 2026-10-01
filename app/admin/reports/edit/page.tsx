"use client";

/**
 * The statement editor (dispatch 23B, plan §2.5): one property, one month,
 * the fields on the left and the PDF alive on the right.
 *
 * ── The draft ──
 * Income rows, the fee and the notes are the admin's; the costs are read
 * from the ledger and cannot be edited here. Every change is saved whole
 * 800 ms after the last keystroke with the revision the page loaded; a
 * different stored revision (another admin, another tab) is refused and
 * the page reloads the draft as it is stored, saying so. Nothing typed is
 * lost to a refresh: the draft is on the server.
 *
 * ── The live PDF ──
 * The statement writer runs here, 300 ms after the last change, and the
 * bytes go into an <iframe> through a Blob URL; two frames are kept and
 * swapped when the new one has loaded, so the page never flashes blank.
 * This is the real document: the finish step runs the same pure function
 * on the same frozen inputs, and the page proves it after finishing by
 * running the writer on the frozen object the server returned and
 * comparing the SHA-256 with the stored object's.
 *
 * ── Finishing and correcting ──
 * Finish sends the page's claim; the server rebuilds the statement and
 * refuses unless that is what is stored. A finished month is read-only,
 * with Download PDF and "Correct this statement…", which asks for the
 * reason and reopens the draft with `supersedes` naming the report.
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, ArrowDown, ArrowUp, Download, Lock, Plus, RefreshCw, Trash2 } from "lucide-react";
import { AdminHeader } from "../../components/AdminHeader";
import { AdminSelect } from "../../components/AdminSelect";
import { PinGate } from "../../components/PinGate";
import { NoticeBanner, useNotice } from "../../components/Notice";
import { fetchStatementBundle, fetchStatementLink, finishStatement, saveDraft, type DraftPayload, type StatementBundle } from "@/app/lib/reports-client";
import { formatCents } from "@/app/lib/cleaners/model";
import { isDay, shortDay } from "@/app/lib/costs/report";
import {
  INCOME_SOURCES,
  INCOME_SOURCE_LABELS,
  STATEMENT_LIMITS,
  isIncomeSource,
  isMonth,
  monthLabel,
  reportRef,
  type IncomeRow,
  type MonthlyReportView,
} from "@/app/lib/reports/model";
import { buildStatement, closingWords, preparedFor, statementOf, type FinishClaim, type Statement } from "@/app/lib/reports/statement";
import { statementPdf } from "@/app/lib/reports/statement-pdf";
import { SentAt, amountField, readAmount, whenText } from "../../costs/cost-display";
import shared from "../../page.module.css";
import styles from "../page.module.css";

/** An income row as typed. */
interface IncomeDraft {
  id: string;
  source: string;
  label: string;
  reference: string;
  from: string;
  to: string;
  amount: string;
}
interface FeeDraft {
  label: string;
  amount: string;
}
interface Typed {
  income: IncomeDraft[];
  fee: FeeDraft | null;
  notes: string;
}

type Load = { kind: "loading" } | { kind: "ready"; bundle: StatementBundle } | { kind: "error"; title: string; detail?: string; status: number };
type SaveState = { kind: "saved"; at: string } | { kind: "saving" } | { kind: "unsaved" } | { kind: "failed"; reason: string } | { kind: "none" };

const SESSION_HINT = "Your admin session may have expired — reload and sign in again.";
/** If a viewer has not said "load" by then, the frames swap anyway: a viewer that never says so would otherwise show nothing. */
const PREVIEW_SWAP_FALLBACK_MS = 1500;
const newId = () => (typeof crypto.randomUUID === "function" ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).slice(0, 36);

function fromStored(income: IncomeRow[], fee: { label: string; amountCents: number } | null, notes: string | null): Typed {
  return {
    income: income.map((row) => ({ id: row.id, source: row.source, label: row.label, reference: row.reference ?? "", from: row.from ?? "", to: row.to ?? "", amount: amountField(row.amountCents) })),
    fee: fee ? { label: fee.label, amount: amountField(fee.amountCents) } : null,
    notes: notes ?? "",
  };
}

/** The typed rows as the writer and the server take them; a row whose amount cannot be read is left out and named. */
function toRows(typed: Typed): { rows: IncomeRow[]; fee: { label: string; amountCents: number } | null; problems: string[] } {
  const rows: IncomeRow[] = [];
  const problems: string[] = [];
  typed.income.forEach((row, i) => {
    const amount = readAmount(row.amount);
    const cents = amount === null ? null : Math.round(Number(amount.replace("-", "")) * 100) * (amount.startsWith("-") ? -1 : 1);
    if (cents === null || cents === 0 || !isIncomeSource(row.source) || row.label.trim() === "") {
      problems.push(`Income row ${i + 1}: ${row.label.trim() === "" ? "describe it" : "check the amount"}`);
      return;
    }
    rows.push({ id: row.id, source: row.source, label: row.label.trim(), reference: row.reference.trim() || null, from: isDay(row.from) ? row.from : null, to: isDay(row.to) ? row.to : null, amountCents: cents });
  });
  let fee: { label: string; amountCents: number } | null = null;
  if (typed.fee) {
    const amount = readAmount(typed.fee.amount);
    if (amount === null || amount.startsWith("-") || typed.fee.label.trim() === "") problems.push("Management fee: a label and an amount, zero or more");
    else fee = { label: typed.fee.label.trim(), amountCents: Math.round(Number(amount) * 100) };
  }
  return { rows, fee, problems };
}

function toPayload(propertyId: string, month: string, revision: number, typed: Typed, supersedes: { reportId: string; reason: string } | null): DraftPayload {
  return {
    propertyId,
    month,
    revision,
    income: typed.income.map((row) => ({ id: row.id, source: row.source, label: row.label.trim(), reference: row.reference.trim() || null, from: isDay(row.from) ? row.from : null, to: isDay(row.to) ? row.to : null, amount: readAmount(row.amount) ?? row.amount })),
    fee: typed.fee ? { label: typed.fee.label.trim(), amount: readAmount(typed.fee.amount) ?? typed.fee.amount } : null,
    notes: typed.notes.trim() || null,
    supersedes,
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export default function EditPage() {
  return (
    <PinGate>
      <Suspense fallback={null}>
        <Editor />
      </Suspense>
    </PinGate>
  );
}

function Editor() {
  const params = useSearchParams();
  const propertyId = params.get("property") ?? "";
  const month = params.get("month") ?? "";
  const valid = /^[A-Za-z0-9_-]{1,64}$/.test(propertyId) && isMonth(month);

  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [typed, setTyped] = useState<Typed>({ income: [], fee: null, notes: "" });
  const [revision, setRevision] = useState(0);
  const [supersedes, setSupersedes] = useState<{ reportId: string; reason: string } | null>(null);
  const [finishedAs, setFinishedAs] = useState<string | null>(null);
  const [save, setSave] = useState<SaveState>({ kind: "none" });
  const [finishing, setFinishing] = useState(false);
  const [linking, setLinking] = useState(false);
  const [verified, setVerified] = useState<{ ok: boolean; stored: string; computed: string } | null>(null);
  const { notice, show, clear } = useNotice();
  /** What was last saved or loaded, to know whether a save is needed. */
  const savedRef = useRef<string>("");
  const typedRef = useRef(typed);
  typedRef.current = typed;
  const revisionRef = useRef(revision);
  revisionRef.current = revision;
  const supersedesRef = useRef(supersedes);
  supersedesRef.current = supersedes;
  const saveTimer = useRef<number | null>(null);

  // ── Load ──
  useEffect(() => {
    if (!valid) return;
    let cancelled = false;
    fetchStatementBundle(propertyId, month).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setLoad({ kind: "error", title: result.title, detail: result.detail, status: result.status });
        return;
      }
      const bundle = result.data;
      const draft = bundle.draft;
      const initial = draft ? fromStored(draft.income, draft.fee, draft.notes) : { income: [], fee: bundle.management?.defaultFee ? { label: bundle.management.defaultFee.label, amount: amountField(bundle.management.defaultFee.amountCents) } : null, notes: "" };
      setTyped(initial);
      savedRef.current = JSON.stringify(draft ? initial : null);
      setRevision(draft?.revision ?? 0);
      setSupersedes(draft?.supersedes ?? null);
      setFinishedAs(draft?.finishedAs ?? null);
      setSave(draft ? { kind: "saved", at: draft.updatedAt } : { kind: "none" });
      setVerified(null);
      setLoad({ kind: "ready", bundle });
    });
    return () => {
      cancelled = true;
    };
  }, [propertyId, month, valid, attempt]);

  const reload = useCallback(() => {
    clear();
    setLoad({ kind: "loading" });
    setAttempt((n) => n + 1);
  }, [clear]);

  const bundle = load.kind === "ready" ? load.bundle : null;
  const finishedReport = useMemo<MonthlyReportView | null>(() => (bundle && finishedAs ? (bundle.reports.find((r) => r.id === finishedAs) ?? null) : null), [bundle, finishedAs]);
  const readOnly = finishedAs !== null;

  // ── The statement as it stands, from what is typed ──
  const parsed = useMemo(() => toRows(typed), [typed]);
  const built = useMemo(() => {
    if (!bundle) return null;
    return buildStatement({ propertyId, propertyName: bundle.propertyName, month, entries: bundle.entries, reports: bundle.reports, draft: { income: parsed.rows, fee: parsed.fee, notes: typed.notes.trim() || null, supersedes }, management: bundle.management });
  }, [bundle, propertyId, month, parsed, typed.notes, supersedes]);
  const statement: Statement | null = useMemo(() => {
    if (finishedReport && bundle) return statementOf(finishedReport, bundle.reports);
    return built && built.kind === "ok" ? built.statement : null;
  }, [finishedReport, bundle, built]);

  // ── Save, 800 ms after the last change ──
  const doSave = useCallback(async () => {
    const current = typedRef.current;
    const key = JSON.stringify(current);
    if (key === savedRef.current) return;
    setSave({ kind: "saving" });
    const result = await saveDraft(toPayload(propertyId, month, revisionRef.current, current, supersedesRef.current));
    if (result.ok) {
      savedRef.current = key;
      setRevision(result.data.draft.revision);
      setSave({ kind: "saved", at: result.data.draft.updatedAt });
      return;
    }
    if (result.code === "DRAFT_CHANGED") {
      show({ tone: "warning", title: "This draft was changed elsewhere — another tab or another admin.", detail: "Your last change was not saved. The draft is reloaded as it is stored." });
      setAttempt((n) => n + 1);
      setLoad({ kind: "loading" });
      return;
    }
    setSave({ kind: "failed", reason: `${result.title}${result.detail ? ` ${result.detail}` : ""}${result.status === 401 || result.status === 403 ? ` ${SESSION_HINT}` : ""}` });
  }, [propertyId, month, show]);

  const change = (next: Typed) => {
    if (readOnly) return;
    setTyped(next);
    setSave({ kind: "unsaved" });
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void doSave(), STATEMENT_LIMITS.SAVE_DELAY_MS);
  };
  useEffect(() => () => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
  }, []);

  // ── The live PDF, 300 ms after the last change, double-buffered ──
  // The new bytes go into the hidden frame; when it has loaded (or, in a
  // browser whose viewer never says so, after a moment) the frames swap, so
  // the page never flashes blank between versions. A browser with no inline
  // PDF viewer is told so and offered the PDF in a tab.
  const frameA = useRef<HTMLIFrameElement>(null);
  const frameB = useRef<HTMLIFrameElement>(null);
  const [shown, setShown] = useState<"a" | "b">("a");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [viewerInline, setViewerInline] = useState(true);
  const urlsRef = useRef<{ a: string | null; b: string | null }>({ a: null, b: null });
  useEffect(() => {
    setViewerInline(typeof navigator.pdfViewerEnabled === "boolean" ? navigator.pdfViewerEnabled : true);
  }, []);
  useEffect(() => {
    if (!statement) return;
    const timer = window.setTimeout(() => {
      const bytes = statementPdf(statement);
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
      setPreviewUrl(url);
      const target = shown === "a" ? "b" : "a";
      const frame = (target === "a" ? frameA : frameB).current;
      if (!frame) return;
      let swapped = false;
      const swap = () => {
        if (swapped) return;
        swapped = true;
        frame.removeEventListener("load", swap);
        setShown(target);
        const old = urlsRef.current[shown];
        if (old) window.setTimeout(() => URL.revokeObjectURL(old), 1000);
        urlsRef.current[target] = url;
      };
      frame.addEventListener("load", swap);
      window.setTimeout(swap, PREVIEW_SWAP_FALLBACK_MS);
      frame.src = `${url}#toolbar=0&navpanes=0&view=FitH`;
    }, STATEMENT_LIMITS.PREVIEW_DELAY_MS);
    return () => window.clearTimeout(timer);
    // `shown` is read at draw time on purpose: the frame to draw into is the hidden one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statement]);

  // ── Finish ──
  const finish = async () => {
    if (!bundle || !built || built.kind !== "ok" || finishing || readOnly) return;
    clear();
    if (parsed.problems.length > 0) {
      show({ tone: "error", title: "The statement cannot be finished as it stands.", items: parsed.problems });
      return;
    }
    if (save.kind !== "saved" || revision === 0) {
      show({ tone: "warning", title: "Wait for the draft to save first.", detail: save.kind === "failed" ? save.reason : undefined });
      return;
    }
    const pending = built.statement.pendingLeftOut;
    const question = [
      `Finish and freeze the statement for ${bundle.propertyName}, ${monthLabel(month)}?`,
      `Closing figure: ${closingWords(built.statement.payableCents).label} ${closingWords(built.statement.payableCents).amount}.`,
      pending > 0 ? `${pending === 1 ? "1 entry" : `${pending} entries`} sent in ${monthLabel(month)} ${pending === 1 ? "is" : "are"} still pending and ${pending === 1 ? "is" : "are"} not in it.` : null,
      "A finished statement is never edited; a mistake in it is corrected with a replacing statement.",
    ].filter(Boolean).join("\n");
    if (!window.confirm(question)) return;
    setFinishing(true);
    const claim: FinishClaim = built.claim;
    const result = await finishStatement({ propertyId, month, draftRevision: revision, ...claim });
    setFinishing(false);
    if (!result.ok) {
      if (result.code === "STATEMENT_CHANGED" || result.code === "DRAFT_CHANGED") {
        show({ tone: "warning", title: result.title, detail: `${result.detail ?? ""} The page reloads what is stored.` });
        reload();
        return;
      }
      show(result.unknown ? { tone: "warning", title: "The statement may or may not have been finished. Reload to see what is on record.", detail: result.title } : { tone: "error", title: result.title, detail: result.detail });
      return;
    }
    const { report } = result.data;
    // The proof: the writer on the returned frozen object, hashed, against the stored object's hash.
    const computed = await sha256Hex(statementPdf(statementOf(report, [...bundle.reports, report])));
    setVerified({ ok: computed === report.pdf.sha256, stored: report.pdf.sha256, computed });
    setLoad({ kind: "ready", bundle: { ...bundle, reports: [report, ...bundle.reports], draft: bundle.draft ? { ...bundle.draft, finishedAs: report.id } : null } });
    setFinishedAs(report.id);
    show({ tone: "success", title: `Finished · ref ${reportRef(report.id)}.`, detail: computed === report.pdf.sha256 ? "The PDF stored is byte for byte the one the page shows: its SHA-256 matches." : "The stored PDF's SHA-256 does not match the page's. Download it and check before sending." });
  };

  // ── Correct ──
  const correct = async () => {
    if (!bundle || !finishedReport || finishing) return;
    const reason = window.prompt(`Correct the statement ref ${reportRef(finishedReport.id)}? It stays on record, marked replaced, and a corrected statement is made beside it. Why is it corrected? (the co-owners read this)`)?.trim();
    if (!reason) return;
    if (reason.length > STATEMENT_LIMITS.REASON_MAX) {
      show({ tone: "error", title: `The reason can be at most ${STATEMENT_LIMITS.REASON_MAX} characters.` });
      return;
    }
    clear();
    const next = fromStored(finishedReport.income, finishedReport.fee, finishedReport.notes);
    const sup = { reportId: finishedReport.id, reason };
    setSave({ kind: "saving" });
    const result = await saveDraft(toPayload(propertyId, month, revision, next, sup));
    if (!result.ok) {
      setSave({ kind: "failed", reason: result.title });
      show({ tone: "error", title: result.title, detail: result.detail });
      return;
    }
    setTyped(next);
    savedRef.current = JSON.stringify(next);
    setSupersedes(sup);
    setFinishedAs(null);
    setVerified(null);
    setRevision(result.data.draft.revision);
    setSave({ kind: "saved", at: result.data.draft.updatedAt });
    show({ tone: "info", title: "Correcting the statement.", detail: "The income, fee and notes are copied from the finished statement; the costs are read fresh. Finish it to replace the old one." });
  };

  const download = async () => {
    if (!finishedReport || linking) return;
    setLinking(true);
    const result = await fetchStatementLink(finishedReport.id);
    setLinking(false);
    if (!result.ok) {
      show({ tone: "error", title: result.title, detail: result.detail });
      return;
    }
    window.open(result.data.url, "_blank", "noopener");
  };

  // ── Rows ──
  const setRow = (id: string, patch: Partial<IncomeDraft>) => change({ ...typed, income: typed.income.map((row) => (row.id === id ? { ...row, ...patch } : row)) });
  const move = (index: number, by: -1 | 1) => {
    const rows = [...typed.income];
    const [row] = rows.splice(index, 1);
    rows.splice(index + by, 0, row);
    change({ ...typed, income: rows });
  };
  const removeRow = (row: IncomeDraft) => {
    if ((row.label.trim() || row.amount.trim()) && !window.confirm("Remove this income row?")) return;
    change({ ...typed, income: typed.income.filter((r) => r.id !== row.id) });
  };
  const addRow = () => change({ ...typed, income: [...typed.income, { id: newId(), source: "airbnb", label: "", reference: "", from: "", to: "", amount: "" }] });

  if (!valid) {
    return (
      <div className={shared.container}>
        <AdminHeader current="reports" title="Statement" />
        <main className={shared.main}>
          <div className={`${shared.empty} ${shared.loadError}`} role="alert">
            <AlertTriangle size={48} strokeWidth={1} />
            <h2>Which statement?</h2>
            <p>Open one from the tracker: the address needs a property and a month (yyyy-mm).</p>
            <Link href="/admin/reports" prefetch={false} className={shared.btnPrimary}>Go to Reports</Link>
          </div>
        </main>
      </div>
    );
  }

  const stateLine =
    readOnly && finishedReport ? (
      <span className={styles.editorState}>
        <strong>Finished</strong> <SentAt iso={finishedReport.finishedAt} seconds /> · ref <span className={styles.mono}>{reportRef(finishedReport.id)}</span>
        {finishedReport.supersedes && <> · replaces ref {reportRef(finishedReport.supersedes.reportId)}</>}
      </span>
    ) : save.kind === "saving" ? (
      <span className={styles.editorState}>Saving…</span>
    ) : save.kind === "saved" ? (
      <span className={styles.editorState}>
        <strong>{supersedes ? "Correction" : "Draft"}</strong> · saved {whenText(save.at)}
      </span>
    ) : save.kind === "unsaved" ? (
      <span className={styles.editorState}>Draft · changed, saving shortly</span>
    ) : save.kind === "failed" ? (
      <span className={`${styles.editorState} ${styles.editorStateWarn}`}>Not saved: {save.reason}</span>
    ) : (
      <span className={styles.editorState}>Draft · nothing saved yet</span>
    );

  return (
    <div className={shared.container}>
      <AdminHeader current="reports" title="Statement">
        <Link href={`/admin/reports?month=${month}`} prefetch={false} className={shared.btnGhost}>
          Tracker
        </Link>
        <button type="button" className={shared.btnGhost} onClick={reload} disabled={load.kind === "loading"}>
          <RefreshCw size={15} aria-hidden />
          <span>Reload</span>
        </button>
      </AdminHeader>

      <main className={shared.main}>
        <NoticeBanner notice={notice} onDismiss={clear} className={shared.pageNotice} />

        {load.kind === "loading" ? (
          <div className={shared.loading}>
            <div className={shared.spinner} />
            <p>Loading the statement…</p>
          </div>
        ) : load.kind === "error" ? (
          <div className={`${shared.empty} ${shared.loadError}`} role="alert">
            <AlertTriangle size={48} strokeWidth={1} />
            <h2>Could not load the statement</h2>
            <p>
              It has not loaded.
              {(load.status === 401 || load.status === 403) && ` ${SESSION_HINT}`}
            </p>
            <code className={shared.loadErrorDetail}>
              {load.title}
              {load.detail ? ` ${load.detail}` : ""}
            </code>
            <button type="button" className={shared.btnPrimary} onClick={reload}>
              <RefreshCw size={18} />
              <span>Retry</span>
            </button>
          </div>
        ) : bundle ? (
          <>
            <div className={styles.editorHead}>
              <div>
                <h2 className={styles.editorTitle}>
                  {bundle.propertyName} · {monthLabel(month)}
                </h2>
                <p className={styles.note}>{statement ? preparedFor(statement) : null}</p>
              </div>
              <div className={styles.finishRow}>
                {stateLine}
                {readOnly && finishedReport && (
                  <>
                    <button type="button" className={styles.btnGhost} onClick={download} disabled={linking}>
                      <Download size={14} aria-hidden />
                      <span>{linking ? "Opening…" : "Download PDF"}</span>
                    </button>
                    <button type="button" className={styles.btnGhost} onClick={correct}>
                      Correct this statement…
                    </button>
                  </>
                )}
                {verified && (
                  <span className={verified.ok ? styles.verified : styles.noteWarn} title={`stored ${verified.stored}\ncomputed ${verified.computed}`}>
                    {verified.ok ? "✓ Stored PDF verified: SHA-256 matches" : "Stored PDF does not match the page"}
                  </span>
                )}
              </div>
            </div>

            {built && built.kind === "unreadable" && (
              <p className={styles.noteWarn} role="alert">
                An approved entry this statement would carry cannot be added up ({built.entryIds.join(", ")}). Open it in the ledger; no statement can be made until it reads.
              </p>
            )}
            {supersedes && !readOnly && (
              <p className={styles.note}>Correcting ref {reportRef(supersedes.reportId)}: “{supersedes.reason}”. Finishing makes a replacing statement; the old one stays on record, marked replaced.</p>
            )}

            <div className={styles.editorLayout}>
              <div className={styles.fields}>
                {/* ── Income ── */}
                <section className={styles.block} aria-label="Income">
                  <div className={styles.blockHead}>
                    <h3 className={styles.blockTitle}>Income</h3>
                    <span className={styles.blockTotal}>{statement ? formatCents(statement.incomeCents) : "—"}</span>
                  </div>
                  {typed.income.length === 0 && <p className={styles.note}>No income rows. Nothing is prefilled: what a platform paid is typed here, never read from the site.</p>}
                  {typed.income.map((row, i) => (
                    <div key={row.id} className={styles.incomeRow}>
                      <div className={styles.orderButtons}>
                        <button type="button" aria-label="Move up" disabled={readOnly || i === 0} onClick={() => move(i, -1)}>
                          <ArrowUp size={12} aria-hidden />
                        </button>
                        <button type="button" aria-label="Move down" disabled={readOnly || i === typed.income.length - 1} onClick={() => move(i, 1)}>
                          <ArrowDown size={12} aria-hidden />
                        </button>
                      </div>
                      <AdminSelect label={`Row ${i + 1} source`} value={row.source} onChange={(source) => setRow(row.id, { source })} groups={[{ options: INCOME_SOURCES.map((s) => ({ value: s, label: INCOME_SOURCE_LABELS[s] })) }]} />
                      <input className={`${styles.textInput} ${row.label.trim() === "" ? styles.inputInvalid : ""}`} placeholder="Description, e.g. Airbnb payout, stay 12–15 Sep" value={row.label} maxLength={STATEMENT_LIMITS.INCOME_LABEL_MAX} disabled={readOnly} onChange={(e) => setRow(row.id, { label: e.target.value })} aria-label={`Row ${i + 1} description`} />
                      <input className={styles.textInput} placeholder="Reference" value={row.reference} maxLength={STATEMENT_LIMITS.INCOME_REFERENCE_MAX} disabled={readOnly} onChange={(e) => setRow(row.id, { reference: e.target.value })} aria-label={`Row ${i + 1} reference`} />
                      <input className={`${styles.textInput} ${styles.amountInput} ${readAmount(row.amount) === null || readAmount(row.amount) === "0.00" ? styles.inputInvalid : ""}`} placeholder="0.00" inputMode="decimal" value={row.amount} disabled={readOnly} onChange={(e) => setRow(row.id, { amount: e.target.value })} onBlur={() => { const read = readAmount(row.amount); if (read && read !== row.amount) setRow(row.id, { amount: read }); }} aria-label={`Row ${i + 1} amount`} />
                      <button type="button" className={styles.removeBtn} aria-label={`Remove row ${i + 1}`} disabled={readOnly} onClick={() => removeRow(row)}>
                        <Trash2 size={14} aria-hidden />
                      </button>
                      <div className={styles.incomeDates}>
                        <span>Stay</span>
                        <input className={styles.textInput} type="date" value={row.from} disabled={readOnly} onChange={(e) => setRow(row.id, { from: e.target.value })} aria-label={`Row ${i + 1} stay from`} />
                        <span>to</span>
                        <input className={styles.textInput} type="date" value={row.to} disabled={readOnly} onChange={(e) => setRow(row.id, { to: e.target.value })} aria-label={`Row ${i + 1} stay to`} />
                      </div>
                    </div>
                  ))}
                  {!readOnly && (
                    <button type="button" className={`${styles.btnGhost} ${styles.btnSmall}`} onClick={addRow} disabled={typed.income.length >= STATEMENT_LIMITS.INCOME_ROWS_MAX}>
                      <Plus size={13} aria-hidden />
                      <span>Add row</span>
                    </button>
                  )}
                </section>

                {/* ── Fee ── */}
                <section className={styles.block} aria-label="Management fee">
                  <div className={styles.blockHead}>
                    <h3 className={styles.blockTitle}>Management fee</h3>
                    <span className={styles.blockTotal}>{statement ? formatCents(statement.feeCents) : "—"}</span>
                  </div>
                  {typed.fee ? (
                    <div className={styles.feeGrid}>
                      <div>
                        <label className={styles.fieldLabel} htmlFor="fee-label">Label (how you arrived at it)</label>
                        <input id="fee-label" className={styles.textInput} value={typed.fee.label} maxLength={STATEMENT_LIMITS.FEE_LABEL_MAX} disabled={readOnly} onChange={(e) => change({ ...typed, fee: { ...typed.fee!, label: e.target.value } })} placeholder="e.g. Management fee, 15 % of income" />
                      </div>
                      <div>
                        <label className={styles.fieldLabel} htmlFor="fee-amount">Amount ($)</label>
                        <input id="fee-amount" className={`${styles.textInput} ${styles.amountInput}`} inputMode="decimal" value={typed.fee.amount} disabled={readOnly} onChange={(e) => change({ ...typed, fee: { ...typed.fee!, amount: e.target.value } })} onBlur={() => { const read = readAmount(typed.fee?.amount ?? ""); if (read && typed.fee && read !== typed.fee.amount) change({ ...typed, fee: { ...typed.fee, amount: read } }); }} />
                      </div>
                      {!readOnly && (
                        <button type="button" className={`${styles.btnGhost} ${styles.btnSmall}`} onClick={() => change({ ...typed, fee: null })}>
                          No fee this month
                        </button>
                      )}
                    </div>
                  ) : (
                    <p className={styles.note}>
                      No fee this month.{" "}
                      {!readOnly && (
                        <button type="button" className={styles.linkButton} onClick={() => change({ ...typed, fee: bundle.management?.defaultFee ? { label: bundle.management.defaultFee.label, amount: amountField(bundle.management.defaultFee.amountCents) } : { label: "", amount: "" } })}>
                          Add a fee{bundle.management?.defaultFee ? ` (the property's default, ${formatCents(bundle.management.defaultFee.amountCents)})` : ""}
                        </button>
                      )}
                    </p>
                  )}
                  <p className={styles.note}>An amount you type, never a rate the code works out.</p>
                </section>

                {/* ── Costs, recorded ── */}
                <section className={`${styles.block} ${styles.recorded}`} aria-label="Costs">
                  <div className={styles.blockHead}>
                    <h3 className={styles.blockTitle}>Costs</h3>
                    <span className={styles.recordedTag}>
                      <Lock size={11} aria-hidden /> recorded · {statement ? formatCents(statement.costsCents) : "—"}
                    </span>
                  </div>
                  <p className={styles.note}>Approved entries of {monthLabel(month)} from the cost ledger, shown as recorded. Correct an entry in the ledger; the statement follows.</p>
                  {statement && statement.pendingLeftOut > 0 && (
                    <p className={styles.noteWarn} role="status">
                      {statement.pendingLeftOut === 1 ? "1 entry" : `${statement.pendingLeftOut} entries`} sent in {monthLabel(month)} {statement.pendingLeftOut === 1 ? "is" : "are"} pending. {statement.pendingLeftOut === 1 ? "It is" : "They are"} not in this statement.{" "}
                      <Link href={`/admin/costs?property=${encodeURIComponent(propertyId)}`} prefetch={false} className={styles.linkButton}>Review them first.</Link>
                    </p>
                  )}
                  {built && built.kind === "ok" && built.reportedElsewhere.length > 0 && (
                    <p className={styles.note}>{built.reportedElsewhere.length === 1 ? "1 entry of this month is" : `${built.reportedElsewhere.length} entries of this month are`} already in another current statement and {built.reportedElsewhere.length === 1 ? "is" : "are"} not repeated here.</p>
                  )}
                  <CostRows statement={statement} propertyId={propertyId} />
                </section>

                {/* ── Notes ── */}
                <section className={styles.block} aria-label="Notes to the owners">
                  <div className={styles.blockHead}>
                    <h3 className={styles.blockTitle}>Notes to the owners</h3>
                    <span className={styles.note}>{typed.notes.length}/{STATEMENT_LIMITS.NOTES_MAX}</span>
                  </div>
                  <textarea className={styles.textInput} value={typed.notes} maxLength={STATEMENT_LIMITS.NOTES_MAX} disabled={readOnly} onChange={(e) => change({ ...typed, notes: e.target.value })} placeholder="Anything the co-owners should know this month" aria-label="Notes to the owners" />
                </section>

                {/* ── Finish ── */}
                {!readOnly && (
                  <section className={styles.block} aria-label="Finish">
                    <div className={styles.finishRow}>
                      <button type="button" className={styles.btnPrimary} onClick={finish} disabled={finishing || !built || built.kind !== "ok"}>
                        {finishing ? "Finishing…" : "Finish and freeze…"}
                      </button>
                      <span className={styles.note}>
                        {statement ? `${closingWords(statement.payableCents).label}: ${closingWords(statement.payableCents).amount}.` : ""} A finished statement is never edited.
                      </span>
                    </div>
                  </section>
                )}
              </div>

              {/* ── The PDF, alive ── */}
              <div>
                <div className={styles.preview} aria-label="The statement as a PDF">
                  <iframe ref={frameA} className={`${styles.previewFrame} ${shown === "a" ? "" : styles.previewHidden}`} title="Statement PDF" />
                  <iframe ref={frameB} className={`${styles.previewFrame} ${shown === "b" ? "" : styles.previewHidden}`} title="Statement PDF, next" />
                </div>
                <p className={styles.previewNote}>
                  {!viewerInline && (
                    <>
                      This browser does not show PDFs inline.{" "}
                      {previewUrl && (
                        <a href={previewUrl} target="_blank" rel="noopener" className={styles.linkButton}>
                          Open the current PDF in a tab
                        </a>
                      )}
                      {" · "}
                    </>
                  )}
                  {readOnly ? "The finished statement, drawn from the frozen record." : "The real document, redrawn as you type. What you see is what Finish stores."}
                </p>
              </div>
            </div>
          </>
        ) : null}
      </main>
    </div>
  );
}

function CostRows({ statement, propertyId }: { statement: Statement | null; propertyId: string }) {
  if (!statement) return null;
  const rows = statement.costs;
  const month = rows.filter((r) => r.group === "month");
  const earlier = rows.filter((r) => r.group === "earlier");
  if (rows.length === 0 && statement.adjustments.length === 0) return <p className={styles.note}>No approved costs this month.</p>;
  const row = (r: Statement["costs"][number]) => (
    <tr key={r.entryId}>
      <td>{shortDay(r.day)}</td>
      <td>
        {r.kind === "work" ? "Work: " : ""}
        {r.description}
        {r.corrected ? " *" : ""}
      </td>
      <td className={styles.mono}>{r.ref}</td>
      <td className={styles.num}>{formatCents(r.totalCents)}</td>
      <td>
        <Link href={`/admin/costs?property=${encodeURIComponent(propertyId)}&status=approved&entry=${encodeURIComponent(r.entryId)}`} prefetch={false}>
          Open entry
        </Link>
      </td>
    </tr>
  );
  return (
    <table className={styles.costTable}>
      <thead>
        <tr>
          <th>Date</th>
          <th>What was bought / work done</th>
          <th>Ref</th>
          <th className={styles.num}>Total</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {month.map(row)}
        {earlier.length > 0 && (
          <tr className={styles.costGroup}>
            <td colSpan={5}>From earlier months, not previously reported</td>
          </tr>
        )}
        {earlier.map(row)}
        {statement.adjustments.length > 0 && (
          <tr className={styles.costGroup}>
            <td colSpan={5}>Adjustments to earlier statements</td>
          </tr>
        )}
        {statement.adjustments.map((a) => (
          <tr key={`adj-${a.entryId}`}>
            <td className={styles.mono}>{a.entryId.slice(0, 6)}</td>
            <td>
              Printed {formatCents(a.printedCents)} in ref {reportRef(a.statementId)}, now {a.nowCents === 0 ? "no longer in the ledger" : formatCents(a.nowCents)}
            </td>
            <td />
            <td className={styles.num}>{a.deltaCents < 0 ? `(${formatCents(-a.deltaCents)})` : formatCents(a.deltaCents)}</td>
            <td>
              <Link href={`/admin/costs?property=${encodeURIComponent(propertyId)}&status=all&entry=${encodeURIComponent(a.entryId)}`} prefetch={false}>
                Open entry
              </Link>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
