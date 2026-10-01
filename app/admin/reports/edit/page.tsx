"use client";

/**
 * The statement editor (dispatch 23B; the Payment Summary of dispatch 23E):
 * one property, one month, the fields on the left in the document's order
 * and the PDF alive on the right.
 *
 * ── The draft ──
 * The reference, the date, the lines, the fee, the carried balance and the
 * notes are the draft's; "Report For" is the property's record, saved on
 * its own through its route so the unit's info shows the same; the
 * recorded costs come from the ledger and cannot be edited here. A line is
 * a description, its dates, a quantity and a rate, and the amount is
 * quantity × rate (Kian's ruling of 2026-10-01). The fee's amount is the
 * rate on the base — prefilled from the revenue lines — until the admin
 * types an amount, which is then "overwritten"; the label is prefilled
 * "NuBNB 20% Net of $9,539.78" until the admin edits it. The carried balance
 * is offered from the previous month's closing figure and never applied by
 * code. Every change is saved whole 800 ms after the last keystroke with
 * the revision the page loaded; a different stored revision (another
 * admin, another tab) is refused and the page reloads the draft as it is
 * stored, saying so.
 *
 * ── The live PDF ──
 * The statement writer runs here, 300 ms after the last change, and the
 * bytes go into an <iframe> through a Blob URL; two frames are kept and
 * swapped when the new one has loaded, so the page never flashes blank.
 * This is the real document: the finish step runs the same pure function
 * on the same frozen inputs, and the page proves it after finishing by
 * running the writer on the frozen object the server returned and
 * comparing the SHA-256 with the stored object's. A statement finished
 * before dispatch 23E is drawn by the writer of its time.
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
import { DateRangeField } from "../../components/DateRangeField";
import { PinGate } from "../../components/PinGate";
import { NoticeBanner, useNotice } from "../../components/Notice";
import { fetchStatementBundle, fetchStatementLink, finishStatement, saveDraft, setReportFor as saveReportFor, type DraftPayload, type LinePayload, type StatementBundle } from "@/app/lib/reports-client";
import { formatCents } from "@/app/lib/cleaners/model";
import { torontoDayOf } from "@/app/lib/costs/report";
import {
  STATEMENT_LIMITS,
  addMonths,
  displayRef,
  feeComputed,
  isClosedMonth,
  isDayText,
  isMonth,
  lineAmount,
  lineFromIncomeRow,
  monthLabel,
  rangeText,
  rateText,
  type Carried,
  type Fee,
  type Line,
  type MonthlyReportView,
  type ReportFor,
} from "@/app/lib/reports/model";
import {
  buildStatement,
  carriedSuggestion,
  closingWords,
  feeLabelFor,
  feeRateSuggestion,
  lineDetailsText,
  previousStatement,
  printedLines,
  referenceSuggestion,
  statementOf,
  statementSums,
  type AnyStatement,
  type FinishClaim,
} from "@/app/lib/reports/statement";
import { statementPdf } from "@/app/lib/reports/statement-pdf";
import { SentAt, amountField, readAmount, whenText } from "../../costs/cost-display";
import shared from "../../page.module.css";
import styles from "../page.module.css";

/** A line as typed. */
interface LineDraft {
  id: string;
  description: string;
  from: string;
  to: string;
  quantity: string;
  rate: string;
  /** Present on a line loaded with what a row written before dispatch 23D carried; saved back as loaded. */
  details?: { source?: Line["source"]; reference?: string | null };
}
/** The fee as typed. The three flags say what the admin has taken over; what they have not follows the lines. */
interface FeeDraft {
  label: string;
  rate: string;
  base: string;
  amount: string;
  baseEdited: boolean;
  amountEdited: boolean;
  labelEdited: boolean;
}
interface CarriedDraft {
  label: string;
  amount: string;
  fromReportId: string | null;
}
interface Typed {
  reference: string;
  reportDate: string;
  lines: LineDraft[];
  fee: FeeDraft | null;
  carried: CarriedDraft | null;
  notes: string;
}
interface ReportForDraft {
  name: string;
  address: string;
}

type Load = { kind: "loading" } | { kind: "ready"; bundle: StatementBundle } | { kind: "error"; title: string; detail?: string; status: number };
type SaveState = { kind: "saved"; at: string } | { kind: "saving" } | { kind: "unsaved" } | { kind: "failed"; reason: string } | { kind: "none" };

const SESSION_HINT = "Your admin session may have expired — reload and sign in again.";
/** If a viewer has not said "load" by then, the frames swap anyway: a viewer that never says so would otherwise show nothing. */
const PREVIEW_SWAP_FALLBACK_MS = 1500;
const newId = () => (typeof crypto.randomUUID === "function" ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).slice(0, 36);

/** "20" or "12.5" from basis points, for the rate field. */
const rateField = (bp: number | null) => (bp === null ? "" : rateText(bp).replace("%", ""));
/** Basis points from "20" or "12.5"; null when it is not a rate. */
function readRate(typed: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(typed.trim());
  if (!match) return null;
  const bp = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return bp > 10_000 ? null : bp;
}
const centsOf = (amount: string) => Math.round(Number(amount.replace("-", "")) * 100) * (amount.startsWith("-") ? -1 : 1);

function lineDraftOf(line: Line): LineDraft {
  const details: LineDraft["details"] = {};
  if (line.source !== undefined) details.source = line.source;
  if ("reference" in line) details.reference = line.reference ?? null;
  return { id: line.id, description: line.description, from: line.from ?? "", to: line.to ?? "", quantity: String(line.quantity), rate: amountField(line.rateCents), ...(Object.keys(details).length > 0 ? { details } : {}) };
}

/** The stored fee as typed: what the admin had taken over is told from what the stored figures say. */
function feeDraftOf(fee: Fee, revenueCents: number): FeeDraft {
  const label = feeLabelFor(fee.rateBasisPoints, fee.baseCents);
  return {
    label: fee.label,
    rate: rateField(fee.rateBasisPoints),
    base: amountField(fee.baseCents),
    amount: amountField(fee.amountCents),
    baseEdited: fee.baseCents !== revenueCents,
    amountEdited: fee.overwritten,
    labelEdited: fee.label !== label,
  };
}

function fromStored(draft: { reference: string; reportDate: string; lines: Line[]; fee: Fee | null; carried: Carried | null; notes: string | null }, today: string): Typed {
  const revenue = draft.lines.filter((line) => line.amountCents > 0).reduce((sum, line) => sum + line.amountCents, 0);
  return {
    reference: draft.reference,
    reportDate: draft.reportDate || today,
    lines: draft.lines.map(lineDraftOf),
    fee: draft.fee ? feeDraftOf(draft.fee, revenue) : null,
    carried: draft.carried ? { label: draft.carried.label, amount: amountField(draft.carried.amountCents), fromReportId: draft.carried.fromReportId } : null,
    notes: draft.notes ?? "",
  };
}

/** A finished report's content as typed, for the read-only view and for a correction. */
function fromReport(report: MonthlyReportView, today: string): Typed {
  const lines = report.legacy ? report.income.map(lineFromIncomeRow) : report.lines;
  return fromStored({ reference: report.reference, reportDate: report.reportDate, lines, fee: report.fee, carried: report.carried, notes: report.notes }, today);
}

/** The fee as it stands: the base and the amount that follow the lines, filled in; the computed amount beside. */
function feeNow(fee: FeeDraft, revenueCents: number): { rateBp: number | null; baseCents: number | null; computedCents: number | null; amountCents: number | null; label: string } {
  const rateBp = fee.rate.trim() === "" ? null : readRate(fee.rate);
  const baseText = fee.baseEdited ? readAmount(fee.base) : amountField(revenueCents);
  const baseCents = baseText === null || baseText.startsWith("-") ? null : centsOf(baseText);
  const computedCents = baseCents === null ? null : feeComputed(baseCents, rateBp);
  const amountText = fee.amountEdited ? readAmount(fee.amount) : computedCents === null ? null : amountField(computedCents);
  const amountCents = amountText === null || amountText.startsWith("-") ? null : centsOf(amountText);
  const label = fee.labelEdited ? fee.label : feeLabelFor(rateBp, baseCents ?? 0);
  return { rateBp, baseCents, computedCents, amountCents, label };
}

/** The typed draft as the writer and the server take it; a field that cannot be read is named. */
function toDraft(typed: Typed): { lines: Line[]; fee: Fee | null; carried: Carried | null; problems: string[] } {
  const lines: Line[] = [];
  const problems: string[] = [];
  typed.lines.forEach((line, i) => {
    const rate = readAmount(line.rate);
    const quantity = /^\d{1,4}$/.test(line.quantity.trim()) ? Number(line.quantity.trim()) : 0;
    const from = line.from.trim() || null;
    const to = line.to.trim() || null;
    if (line.description.trim() === "" || rate === null || rate === "0.00" || quantity < 1 || (from !== null && !isDayText(from)) || (to !== null && !isDayText(to)) || (from && to && to < from)) {
      problems.push(`Line ${i + 1}: ${line.description.trim() === "" ? "describe it" : rate === null || rate === "0.00" ? "check the rate" : quantity < 1 ? "the quantity is a whole number, 1 or more" : "check the dates"}`);
      return;
    }
    const rateCents = centsOf(rate);
    const out: Line = { id: line.id, description: line.description.trim(), from, to, quantity, rateCents, amountCents: lineAmount(quantity, rateCents) };
    if (line.details?.source !== undefined) out.source = line.details.source;
    if (line.details && "reference" in line.details) out.reference = line.details.reference ?? null;
    lines.push(out);
  });
  const revenue = lines.filter((line) => line.amountCents > 0).reduce((sum, line) => sum + line.amountCents, 0);
  let fee: Fee | null = null;
  if (typed.fee) {
    const now = feeNow(typed.fee, revenue);
    if ((typed.fee.rate.trim() !== "" && now.rateBp === null) || now.baseCents === null || now.amountCents === null || now.label.trim() === "") {
      problems.push("Management fee: a rate in percent or an amount, a base, and a label");
    } else {
      fee = { label: now.label.trim(), rateBasisPoints: now.rateBp, baseCents: now.baseCents, computedCents: now.computedCents, amountCents: now.amountCents, overwritten: now.amountCents !== now.computedCents };
    }
  }
  let carried: Carried | null = null;
  if (typed.carried) {
    const amount = readAmount(typed.carried.amount);
    if (amount === null || typed.carried.label.trim() === "") problems.push("Carried balance: a label and an amount");
    else carried = { label: typed.carried.label.trim(), amountCents: centsOf(amount), fromReportId: typed.carried.fromReportId };
  }
  return { lines, fee, carried, problems };
}

function toPayload(propertyId: string, month: string, revision: number, typed: Typed, supersedes: { reportId: string; reason: string } | null): DraftPayload {
  const parsed = toDraft(typed);
  const revenue = parsed.lines.filter((line) => line.amountCents > 0).reduce((sum, line) => sum + line.amountCents, 0);
  const fee = typed.fee ? feeNow(typed.fee, revenue) : null;
  return {
    propertyId,
    month,
    revision,
    reference: typed.reference.trim(),
    reportDate: typed.reportDate,
    lines: typed.lines.map((line): LinePayload => {
      const quantity = /^\d{1,4}$/.test(line.quantity.trim()) ? Number(line.quantity.trim()) : 1;
      const out: LinePayload = { id: line.id, description: line.description.trim(), from: line.from.trim() || null, to: line.to.trim() || null, quantity, rate: readAmount(line.rate) ?? line.rate };
      if (line.details?.source !== undefined) out.source = line.details.source;
      if (line.details && "reference" in line.details) out.reference = line.details.reference ?? null;
      return out;
    }),
    fee:
      typed.fee && fee
        ? {
            label: fee.label.trim(),
            rate: typed.fee.rate.trim() === "" ? null : typed.fee.rate.trim(),
            base: fee.baseCents === null ? (readAmount(typed.fee.base) ?? typed.fee.base) : amountField(fee.baseCents),
            amount: typed.fee.amountEdited || fee.rateBp === null ? (fee.amountCents === null ? (readAmount(typed.fee.amount) ?? typed.fee.amount) : amountField(fee.amountCents)) : null,
          }
        : null,
    carried: typed.carried ? { label: typed.carried.label.trim(), amount: readAmount(typed.carried.amount) ?? typed.carried.amount, fromReportId: typed.carried.fromReportId } : null,
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
  const today = torontoDayOf(new Date());

  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [typed, setTyped] = useState<Typed>({ reference: "", reportDate: today, lines: [], fee: null, carried: null, notes: "" });
  const [reportFor, setReportFor] = useState<ReportForDraft>({ name: "", address: "" });
  const [reportForState, setReportForState] = useState<"saved" | "saving" | "unsaved" | "failed">("saved");
  const [revision, setRevision] = useState(0);
  const [supersedes, setSupersedes] = useState<{ reportId: string; reason: string } | null>(null);
  const [finishedAs, setFinishedAs] = useState<string | null>(null);
  const [save, setSave] = useState<SaveState>({ kind: "none" });
  const [finishing, setFinishing] = useState(false);
  const [linking, setLinking] = useState(false);
  const [verified, setVerified] = useState<{ ok: boolean; stored: string; computed: string } | null>(null);
  const { notice, show, clear } = useNotice();
  const savedRef = useRef<string>("");
  const typedRef = useRef(typed);
  typedRef.current = typed;
  const revisionRef = useRef(revision);
  revisionRef.current = revision;
  const supersedesRef = useRef(supersedes);
  supersedesRef.current = supersedes;
  const saveTimer = useRef<number | null>(null);
  const reportForSavedRef = useRef<string>("");
  const reportForRef = useRef(reportFor);
  reportForRef.current = reportFor;
  const reportForTimer = useRef<number | null>(null);

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
      const previous = previousStatement(bundle.reports, month);
      let initial: Typed;
      if (draft) {
        initial = fromStored(draft, today);
      } else {
        const rate = feeRateSuggestion(previous, bundle.management);
        initial = {
          reference: referenceSuggestion(previous, month) ?? "",
          reportDate: today,
          lines: [],
          fee: rate === null ? null : { label: "", rate: rateField(rate), base: "", amount: "", baseEdited: false, amountEdited: false, labelEdited: false },
          carried: null,
          notes: "",
        };
      }
      setTyped(initial);
      savedRef.current = JSON.stringify(draft ? initial : null);
      const stored = bundle.management?.reportFor ?? null;
      const forDraft = { name: stored?.name ?? "", address: stored?.address ?? "" };
      setReportFor(forDraft);
      reportForSavedRef.current = JSON.stringify(forDraft);
      setReportForState("saved");
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
  }, [propertyId, month, valid, attempt, today]);

  const reload = useCallback(() => {
    clear();
    setLoad({ kind: "loading" });
    setAttempt((n) => n + 1);
  }, [clear]);

  const bundle = load.kind === "ready" ? load.bundle : null;
  const finishedReport = useMemo<MonthlyReportView | null>(() => (bundle && finishedAs ? (bundle.reports.find((r) => r.id === finishedAs) ?? null) : null), [bundle, finishedAs]);
  const readOnly = finishedAs !== null;
  const previous = useMemo(() => (bundle ? previousStatement(bundle.reports, month) : null), [bundle, month]);

  // ── The statement as it stands, from what is typed ──
  const parsed = useMemo(() => toDraft(typed), [typed]);
  const shownReportFor: ReportFor | null = reportFor.name.trim() === "" ? null : { name: reportFor.name.trim(), address: reportFor.address };
  const built = useMemo(() => {
    if (!bundle) return null;
    const management = bundle.management ? { ...bundle.management, reportFor: shownReportFor } : shownReportFor ? { id: propertyId, schemaVersion: 0, propertyId, reportFor: shownReportFor, owners: [], statementsFrom: "2026-10", statementsUntil: null, defaultFeeRateBasisPoints: null, defaultFee: null, setAt: "" } : null;
    return buildStatement({
      propertyId,
      propertyName: bundle.propertyName,
      month,
      entries: bundle.entries,
      reports: bundle.reports,
      draft: { reference: typed.reference.trim(), reportDate: typed.reportDate, lines: parsed.lines, fee: parsed.fee, carried: parsed.carried, notes: typed.notes.trim() || null, supersedes },
      management,
    });
    // shownReportFor is derived from reportFor; comparing the object would redraw on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bundle, propertyId, month, parsed, typed.reference, typed.reportDate, typed.notes, supersedes, reportFor.name, reportFor.address]);
  const statement: AnyStatement | null = useMemo(() => {
    if (finishedReport && bundle) return statementOf(finishedReport, bundle.reports);
    return built && built.kind === "ok" ? built.statement : null;
  }, [finishedReport, bundle, built]);
  /** The figures the head and the blocks show: the frozen statement's once finished, else the live build's. */
  const sums = useMemo(() => (finishedReport ? (finishedReport.legacy ? null : finishedReport) : built && built.kind === "ok" ? built.statement : null), [finishedReport, built]);
  const revenueCents = useMemo(() => statementSums(parsed.lines, [], [], null, null).incomeCents, [parsed.lines]);

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
    if (reportForTimer.current !== null) window.clearTimeout(reportForTimer.current);
  }, []);

  // ── "Report For", saved to the property's record 800 ms after the last change ──
  const doSaveReportFor = useCallback(async () => {
    const current = reportForRef.current;
    const key = JSON.stringify(current);
    if (key === reportForSavedRef.current) return;
    setReportForState("saving");
    const result = await saveReportFor(propertyId, current.name.trim() === "" ? null : { name: current.name.trim(), address: current.address });
    if (result.ok) {
      reportForSavedRef.current = key;
      setReportForState("saved");
      setLoad((prev) => (prev.kind === "ready" ? { kind: "ready", bundle: { ...prev.bundle, management: result.data.record } } : prev));
      return;
    }
    setReportForState("failed");
    show({ tone: "error", title: result.title, detail: result.detail });
  }, [propertyId, show]);
  const changeReportFor = (next: ReportForDraft) => {
    if (readOnly) return;
    setReportFor(next);
    setReportForState("unsaved");
    if (reportForTimer.current !== null) window.clearTimeout(reportForTimer.current);
    reportForTimer.current = window.setTimeout(() => void doSaveReportFor(), STATEMENT_LIMITS.SAVE_DELAY_MS);
  };

  // ── The live PDF, 300 ms after the last change, double-buffered ──
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
    const problems = [...parsed.problems, ...(typed.reference.trim() === "" ? ["Give the report a reference, like Aug-321-John"] : []), ...(isDayText(typed.reportDate) ? [] : ["Give the report a date"])];
    if (problems.length > 0) {
      show({ tone: "error", title: "The statement cannot be finished as it stands.", items: problems });
      return;
    }
    if (save.kind !== "saved" || revision === 0 || reportForState !== "saved") {
      show({ tone: "warning", title: "Wait for the draft to save first.", detail: save.kind === "failed" ? save.reason : undefined });
      return;
    }
    const pending = built.statement.pendingLeftOut;
    const question = [
      `Finish and issue # ${typed.reference.trim()} for ${bundle.propertyName}, ${monthLabel(month)}?`,
      `Your Revenue Share: ${formatCents(built.statement.payableCents)}.`,
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
    const computed = await sha256Hex(statementPdf(statementOf(report, [...bundle.reports, report])));
    setVerified({ ok: computed === report.pdf.sha256, stored: report.pdf.sha256, computed });
    setLoad({ kind: "ready", bundle: { ...bundle, reports: [report, ...bundle.reports], draft: bundle.draft ? { ...bundle.draft, finishedAs: report.id } : null } });
    setFinishedAs(report.id);
    setTyped(fromReport(report, today));
    show({ tone: "success", title: `Finished · ${displayRef(report)}.`, detail: computed === report.pdf.sha256 ? "The PDF stored is byte for byte the one the page shows: its SHA-256 matches." : "The stored PDF's SHA-256 does not match the page's. Download it and check before sending." });
  };

  // ── Correct ──
  const correct = async () => {
    if (!bundle || !finishedReport || finishing) return;
    const reason = window.prompt(`Correct ${displayRef(finishedReport)}? It stays on record, marked replaced, and a corrected statement is made beside it. Why is it corrected? (the owner reads this)`)?.trim();
    if (!reason) return;
    if (reason.length > STATEMENT_LIMITS.REASON_MAX) {
      show({ tone: "error", title: `The reason can be at most ${STATEMENT_LIMITS.REASON_MAX} characters.` });
      return;
    }
    clear();
    const next = fromReport(finishedReport, today);
    if (next.reference === "") next.reference = referenceSuggestion(previous, month) ?? "";
    next.reportDate = today;
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
    show({ tone: "info", title: "Correcting the statement.", detail: "The lines, fee, balance and notes are copied from the finished statement; the recorded costs are read fresh. Finish it to replace the old one." });
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

  // ── Lines ──
  const setLine = (id: string, patch: Partial<LineDraft>) => change({ ...typed, lines: typed.lines.map((line) => (line.id === id ? { ...line, ...patch } : line)) });
  const move = (index: number, by: -1 | 1) => {
    const lines = [...typed.lines];
    const [line] = lines.splice(index, 1);
    lines.splice(index + by, 0, line);
    change({ ...typed, lines });
  };
  const removeLine = (line: LineDraft) => {
    if ((line.description.trim() || line.rate.trim()) && !window.confirm("Remove this line?")) return;
    change({ ...typed, lines: typed.lines.filter((l) => l.id !== line.id) });
  };
  const addLine = () => change({ ...typed, lines: [...typed.lines, { id: newId(), description: "", from: "", to: "", quantity: "1", rate: "" }] });

  // ── Fee and carried balance ──
  const fee = typed.fee ? feeNow(typed.fee, revenueCents) : null;
  const setFee = (patch: Partial<FeeDraft>) => typed.fee && change({ ...typed, fee: { ...typed.fee, ...patch } });
  const suggestedCarried = useMemo(() => carriedSuggestion(previous), [previous]);
  const monthOpen = isMonth(month) && !isClosedMonth(month, today);
  const stateReference = finishedReport ? displayRef(finishedReport) : typed.reference.trim() ? `# ${typed.reference.trim()}` : null;
  /** A statement finished before the Payment Summary has no reference, date or Report For of its own: the read-only Report block is blank. */
  const legacyView = readOnly && finishedReport?.legacy === true;

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
        <strong>Finished</strong> <SentAt iso={finishedReport.finishedAt} seconds /> · <span className={styles.mono}>{displayRef(finishedReport)}</span>
        {finishedReport.supersedes && <> · replaces {displayRef(bundle?.reports.find((r) => r.id === finishedReport.supersedes!.reportId) ?? { id: finishedReport.supersedes.reportId })}</>}
      </span>
    ) : save.kind === "saving" || reportForState === "saving" ? (
      <span className={styles.editorState}>Saving…</span>
    ) : save.kind === "failed" ? (
      <span className={`${styles.editorState} ${styles.editorStateWarn}`}>Not saved: {save.reason}</span>
    ) : save.kind === "unsaved" || reportForState === "unsaved" ? (
      <span className={styles.editorState}>Draft · changed, saving shortly</span>
    ) : save.kind === "saved" ? (
      <span className={styles.editorState}>
        <strong>{supersedes ? "Correction" : "Draft"}</strong> · saved {whenText(save.at)}
      </span>
    ) : (
      <span className={styles.editorState}>Draft · nothing saved yet</span>
    );

  return (
    <div className={shared.container}>
      <AdminHeader current="reports" title="Statement">
        <Link href={`/admin/costs?property=${encodeURIComponent(propertyId)}&status=approved`} prefetch={false} className={shared.btnGhost} title="The property's page: its costs, lines and statements">
          Property
        </Link>
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
                <p className={styles.note}>{stateReference ?? "Payment Summary"}{sums ? ` · Your Revenue Share ${formatCents(sums.payableCents)}` : finishedReport?.legacy ? ` · ${closingWords(finishedReport.payableCents).label} ${closingWords(finishedReport.payableCents).amount}` : ""}</p>
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

            {monthOpen && !readOnly && (
              <p className={styles.openMonth} role="status">
                {monthLabel(month)} has not ended. It can be finished now; entries approved after that go into {monthLabel(addMonths(month, 1))}&rsquo;s statement.
              </p>
            )}
            {built && built.kind === "unreadable" && (
              <p className={styles.noteWarn} role="alert">
                An approved entry this statement would carry cannot be added up ({built.entryIds.join(", ")}). Open it in the ledger; no statement can be made until it reads.
              </p>
            )}
            {supersedes && !readOnly && (
              <p className={styles.note}>Correcting {displayRef(bundle.reports.find((r) => r.id === supersedes.reportId) ?? { id: supersedes.reportId })}: “{supersedes.reason}”. Finishing makes a replacing statement; the old one stays on record, marked replaced.</p>
            )}
            {finishedReport?.legacy && <p className={styles.note}>Finished before the Payment Summary layout; shown and downloaded as it was issued.</p>}

            <div className={styles.editorLayout}>
              <div className={styles.fields}>
                {/* ── Report ── */}
                <section className={styles.block} aria-label="Report">
                  <div className={styles.blockHead}>
                    <h3 className={styles.blockTitle}>Report</h3>
                    {!readOnly && reportForState === "failed" && <span className={styles.noteWarn}>Report For not saved</span>}
                  </div>
                  <div className={styles.reportGrid}>
                    <div>
                      <label className={styles.fieldLabel} htmlFor="reference">Reference</label>
                      <input id="reference" className={`${styles.textInput} ${!readOnly && typed.reference.trim() === "" ? styles.inputInvalid : ""}`} value={legacyView ? "" : typed.reference} maxLength={STATEMENT_LIMITS.REFERENCE_MAX} disabled={readOnly} placeholder={legacyView ? "" : "e.g. Aug-321-John"} onChange={(e) => change({ ...typed, reference: e.target.value })} />
                    </div>
                    <div>
                      <label className={styles.fieldLabel} htmlFor="report-date">Date</label>
                      <input id="report-date" type="date" className={`${styles.textInput} ${!readOnly && !isDayText(typed.reportDate) ? styles.inputInvalid : ""}`} value={legacyView ? "" : typed.reportDate} disabled={readOnly} onChange={(e) => change({ ...typed, reportDate: e.target.value })} />
                    </div>
                    <div>
                      <label className={styles.fieldLabel} htmlFor="report-for-name" title="Saved to the property; the unit's info shows the same">Report For</label>
                      <input id="report-for-name" className={styles.textInput} value={readOnly && finishedReport ? (finishedReport.reportFor?.name ?? "") : reportFor.name} maxLength={STATEMENT_LIMITS.REPORT_FOR_NAME_MAX} disabled={readOnly} placeholder="Name" onChange={(e) => changeReportFor({ ...reportFor, name: e.target.value })} />
                    </div>
                    <div>
                      <label className={styles.fieldLabel} htmlFor="report-for-address">Address</label>
                      <textarea id="report-for-address" className={`${styles.textInput} ${styles.addressInput}`} value={readOnly && finishedReport ? (finishedReport.reportFor?.address ?? "") : reportFor.address} maxLength={STATEMENT_LIMITS.REPORT_FOR_ADDRESS_MAX} disabled={readOnly} placeholder={"321-20 John St.\nToronto, ON, M5V 0G5"} rows={2} onChange={(e) => changeReportFor({ ...reportFor, address: e.target.value })} />
                    </div>
                  </div>
                </section>

                {/* ── Lines ── */}
                <section className={styles.block} aria-label="Lines">
                  <div className={styles.blockHead}>
                    <h3 className={styles.blockTitle}>Lines</h3>
                    <span className={styles.blockTotal}>{sums ? `${formatCents(sums.incomeCents)} revenue · ${formatCents(-sums.expensesCents)} expenses` : "—"}</span>
                  </div>
                  {typed.lines.length > 0 && (
                    <div className={styles.lineHead} aria-hidden>
                      <span />
                      <span>Description</span>
                      <span>Dates</span>
                      <span className={styles.num}>Qty</span>
                      <span className={styles.num}>Rate</span>
                      <span className={styles.num}>Amount</span>
                      <span />
                    </div>
                  )}
                  {typed.lines.map((line, i) => {
                    const rate = readAmount(line.rate);
                    const quantity = /^\d{1,4}$/.test(line.quantity.trim()) ? Number(line.quantity.trim()) : null;
                    const amount = rate !== null && quantity !== null && quantity >= 1 ? lineAmount(quantity, centsOf(rate)) : null;
                    const details = line.details ? lineDetailsText({ source: line.details.source, reference: line.details.reference ?? null }) : "";
                    return (
                      <div key={line.id} className={styles.lineRow}>
                        <div className={styles.orderButtons}>
                          <button type="button" aria-label="Move up" disabled={readOnly || i === 0} onClick={() => move(i, -1)}>
                            <ArrowUp size={12} aria-hidden />
                          </button>
                          <button type="button" aria-label="Move down" disabled={readOnly || i === typed.lines.length - 1} onClick={() => move(i, 1)}>
                            <ArrowDown size={12} aria-hidden />
                          </button>
                        </div>
                        <input className={`${styles.textInput} ${!readOnly && line.description.trim() === "" ? styles.inputInvalid : ""}`} placeholder="Revenue, or Expense - Cleaning" value={line.description} maxLength={STATEMENT_LIMITS.LINE_DESCRIPTION_MAX} disabled={readOnly} onChange={(e) => setLine(line.id, { description: e.target.value })} aria-label={`Line ${i + 1} description`} />
                        {readOnly ? (
                          <span className={styles.lineDates}>{line.from || line.to ? rangeText(line.from || null, line.to || null) : <span className={styles.muted}>No dates</span>}</span>
                        ) : (
                          <DateRangeField label={`Line ${i + 1} dates`} from={line.from} to={line.to} onChange={(range) => setLine(line.id, { from: range.from, to: range.to })} emptyText="No dates" className={styles.lineDates} />
                        )}
                        <input className={`${styles.textInput} ${styles.amountInput} ${!readOnly && (quantity === null || quantity < 1) ? styles.inputInvalid : ""}`} inputMode="numeric" value={line.quantity} disabled={readOnly} onChange={(e) => setLine(line.id, { quantity: e.target.value })} aria-label={`Line ${i + 1} quantity`} />
                        <input className={`${styles.textInput} ${styles.amountInput} ${!readOnly && (rate === null || rate === "0.00") ? styles.inputInvalid : ""}`} placeholder="0.00" inputMode="decimal" value={line.rate} disabled={readOnly} onChange={(e) => setLine(line.id, { rate: e.target.value })} onBlur={() => { const read = readAmount(line.rate); if (read && read !== line.rate) setLine(line.id, { rate: read }); }} aria-label={`Line ${i + 1} rate`} />
                        <span className={`${styles.num} ${styles.lineAmount}`} aria-label={`Line ${i + 1} amount`}>{amount === null ? "—" : formatCents(amount)}</span>
                        <button type="button" className={styles.removeBtn} aria-label={`Remove line ${i + 1}`} disabled={readOnly} onClick={() => removeLine(line)}>
                          <Trash2 size={14} aria-hidden />
                        </button>
                        {details !== "" && (
                          <p className={styles.incomeDetails} title="Recorded with this line before; kept as it is">
                            {details} <span className={styles.muted}>· recorded before</span>
                          </p>
                        )}
                      </div>
                    );
                  })}
                  {typed.lines.length === 0 && <p className={styles.note}>No lines yet.</p>}
                  {!readOnly && (
                    <button type="button" className={`${styles.btnGhost} ${styles.btnSmall}`} onClick={addLine} disabled={typed.lines.length >= STATEMENT_LIMITS.LINES_MAX}>
                      <Plus size={13} aria-hidden />
                      <span>Add line</span>
                    </button>
                  )}
                </section>

                {/* ── Recorded costs ── */}
                <section className={`${styles.block} ${styles.recorded}`} aria-label="Recorded costs">
                  <div className={styles.blockHead}>
                    <h3 className={styles.blockTitle}>Recorded costs</h3>
                    <span className={styles.recordedTag}>
                      <Lock size={11} aria-hidden /> from the ledger · {sums ? formatCents(-sums.recordedCents) : "—"}
                    </span>
                  </div>
                  {statement && !statement.legacy && statement.pendingLeftOut > 0 && (
                    <p className={styles.noteWarn} role="status">
                      {statement.pendingLeftOut === 1 ? "1 entry" : `${statement.pendingLeftOut} entries`} sent in {monthLabel(month)} {statement.pendingLeftOut === 1 ? "is" : "are"} pending and not in this statement.{" "}
                      <Link href={`/admin/costs?property=${encodeURIComponent(propertyId)}`} prefetch={false} className={styles.linkButton}>Review them.</Link>
                    </p>
                  )}
                  {built && built.kind === "ok" && built.reportedElsewhere.length > 0 && (
                    <p className={styles.note}>{built.reportedElsewhere.length === 1 ? "1 entry of this month is" : `${built.reportedElsewhere.length} entries of this month are`} already in another current statement and not repeated here.</p>
                  )}
                  <RecordedRows statement={statement} propertyId={propertyId} />
                </section>

                {/* ── Fee ── */}
                <section className={styles.block} aria-label="Management fee">
                  <div className={styles.blockHead}>
                    <h3 className={styles.blockTitle}>Management fee</h3>
                    <span className={styles.blockTotal}>{fee?.amountCents != null ? formatCents(-fee.amountCents) : "—"}</span>
                  </div>
                  {typed.fee && fee ? (
                    <div className={styles.feeGrid}>
                      <div>
                        <label className={styles.fieldLabel} htmlFor="fee-rate">Rate (%)</label>
                        <input id="fee-rate" className={`${styles.textInput} ${styles.amountInput} ${!readOnly && typed.fee.rate.trim() !== "" && fee.rateBp === null ? styles.inputInvalid : ""}`} inputMode="decimal" value={typed.fee.rate} disabled={readOnly} placeholder="20" onChange={(e) => setFee({ rate: e.target.value })} />
                      </div>
                      <div>
                        <label className={styles.fieldLabel} htmlFor="fee-base">Of (the base)</label>
                        <input id="fee-base" className={`${styles.textInput} ${styles.amountInput} ${!readOnly && fee.baseCents === null ? styles.inputInvalid : ""}`} inputMode="decimal" value={typed.fee.baseEdited ? typed.fee.base : amountField(revenueCents)} disabled={readOnly} onChange={(e) => setFee({ base: e.target.value, baseEdited: true })} onBlur={() => { if (!typed.fee) return; const read = readAmount(typed.fee.base); if (typed.fee.baseEdited && read && read !== typed.fee.base) setFee({ base: read }); }} />
                        {!readOnly && typed.fee.baseEdited && (
                          <button type="button" className={styles.linkButton} onClick={() => setFee({ base: "", baseEdited: false })}>Use the revenue sum, {formatCents(revenueCents)}</button>
                        )}
                      </div>
                      <div>
                        <label className={styles.fieldLabel} htmlFor="fee-amount">Amount</label>
                        <input id="fee-amount" className={`${styles.textInput} ${styles.amountInput} ${!readOnly && fee.amountCents === null ? styles.inputInvalid : ""}`} inputMode="decimal" value={typed.fee.amountEdited ? typed.fee.amount : fee.computedCents === null ? "" : amountField(fee.computedCents)} disabled={readOnly} placeholder={fee.computedCents === null ? "0.00" : undefined} onChange={(e) => setFee({ amount: e.target.value, amountEdited: true })} onBlur={() => { if (!typed.fee) return; const read = readAmount(typed.fee.amount); if (typed.fee.amountEdited && read && read !== typed.fee.amount) setFee({ amount: read }); }} />
                        {fee.computedCents !== null && fee.amountCents !== null && fee.amountCents !== fee.computedCents ? (
                          <span className={styles.noteWarn}>
                            overwritten · computed {formatCents(fee.computedCents)}
                            {!readOnly && (
                              <>
                                {" · "}
                                <button type="button" className={styles.linkButton} onClick={() => setFee({ amount: "", amountEdited: false })}>Use it</button>
                              </>
                            )}
                          </span>
                        ) : fee.computedCents !== null ? (
                          <span className={styles.note}>computed from the rate</span>
                        ) : null}
                      </div>
                      <div className={styles.feeLabelCell}>
                        <label className={styles.fieldLabel} htmlFor="fee-label">Label</label>
                        <input id="fee-label" className={`${styles.textInput} ${!readOnly && fee.label.trim() === "" ? styles.inputInvalid : ""}`} value={fee.label} maxLength={STATEMENT_LIMITS.FEE_LABEL_MAX} disabled={readOnly} onChange={(e) => setFee({ label: e.target.value, labelEdited: true })} />
                        {!readOnly && typed.fee.labelEdited && (
                          <button type="button" className={styles.linkButton} onClick={() => setFee({ label: "", labelEdited: false })}>Use the standard label</button>
                        )}
                      </div>
                      {!readOnly && (
                        <button type="button" className={`${styles.btnGhost} ${styles.btnSmall}`} onClick={() => change({ ...typed, fee: null })}>
                          No fee
                        </button>
                      )}
                    </div>
                  ) : (
                    <p className={styles.note}>
                      No fee.{" "}
                      {!readOnly && (
                        <button type="button" className={styles.linkButton} onClick={() => change({ ...typed, fee: { label: "", rate: rateField(feeRateSuggestion(previous, bundle.management)), base: "", amount: "", baseEdited: false, amountEdited: false, labelEdited: false } })}>
                          Add a fee
                        </button>
                      )}
                    </p>
                  )}
                </section>

                {/* ── Carried balance ── */}
                <section className={styles.block} aria-label="Carried balance">
                  <div className={styles.blockHead}>
                    <h3 className={styles.blockTitle}>Carried balance</h3>
                    <span className={styles.blockTotal}>{parsed.carried ? formatCents(-parsed.carried.amountCents) : "—"}</span>
                  </div>
                  {typed.carried ? (
                    <div className={styles.carriedGrid}>
                      <div>
                        <label className={styles.fieldLabel} htmlFor="carried-label">Label</label>
                        <input id="carried-label" className={`${styles.textInput} ${!readOnly && typed.carried.label.trim() === "" ? styles.inputInvalid : ""}`} value={typed.carried.label} maxLength={STATEMENT_LIMITS.CARRIED_LABEL_MAX} disabled={readOnly} placeholder="Balance From June" onChange={(e) => change({ ...typed, carried: { ...typed.carried!, label: e.target.value } })} />
                      </div>
                      <div>
                        <label className={styles.fieldLabel} htmlFor="carried-amount">Amount deducted</label>
                        <input id="carried-amount" className={`${styles.textInput} ${styles.amountInput} ${!readOnly && readAmount(typed.carried.amount) === null ? styles.inputInvalid : ""}`} inputMode="decimal" value={typed.carried.amount} disabled={readOnly} placeholder="359.96" onChange={(e) => change({ ...typed, carried: { ...typed.carried!, amount: e.target.value, fromReportId: null } })} onBlur={() => { const read = readAmount(typed.carried?.amount ?? ""); if (read && typed.carried && read !== typed.carried.amount) change({ ...typed, carried: { ...typed.carried, amount: read } }); }} />
                        <span className={styles.note}>{typed.carried.fromReportId ? "from the previous statement" : "typed"}</span>
                      </div>
                      {!readOnly && (
                        <button type="button" className={`${styles.btnGhost} ${styles.btnSmall}`} onClick={() => change({ ...typed, carried: null })}>
                          No balance
                        </button>
                      )}
                    </div>
                  ) : (
                    <p className={styles.note}>
                      {suggestedCarried && previous ? `${monthLabel(previous.month)} closed at ${formatCents(previous.payableCents)}. ` : "None. "}
                      {!readOnly && suggestedCarried && (
                        <button type="button" className={styles.linkButton} onClick={() => change({ ...typed, carried: { label: suggestedCarried.label, amount: amountField(suggestedCarried.amountCents), fromReportId: suggestedCarried.fromReportId } })}>
                          Carry it: {suggestedCarried.label} {formatCents(suggestedCarried.amountCents)}
                        </button>
                      )}
                      {!readOnly && (
                        <>
                          {suggestedCarried ? " · " : ""}
                          <button type="button" className={styles.linkButton} onClick={() => change({ ...typed, carried: { label: "", amount: "", fromReportId: null } })}>
                            Type a balance
                          </button>
                        </>
                      )}
                    </p>
                  )}
                </section>

                {/* ── Notes ── */}
                <section className={styles.block} aria-label="Notes">
                  <div className={styles.blockHead}>
                    <h3 className={styles.blockTitle}>Notes</h3>
                    <span className={styles.note}>{typed.notes.length}/{STATEMENT_LIMITS.NOTES_MAX}</span>
                  </div>
                  <textarea className={styles.textInput} value={typed.notes} maxLength={STATEMENT_LIMITS.NOTES_MAX} disabled={readOnly} onChange={(e) => change({ ...typed, notes: e.target.value })} placeholder="Printed at the foot, as typed" aria-label="Notes" />
                </section>

                {/* ── Finish ── */}
                {!readOnly && (
                  <section className={styles.block} aria-label="Finish">
                    <div className={styles.finishRow}>
                      <button type="button" className={styles.btnPrimary} onClick={finish} disabled={finishing || !built || built.kind !== "ok"}>
                        {finishing ? "Finishing…" : "Finish and issue…"}
                      </button>
                      <span className={styles.note}>
                        {sums ? `Your Revenue Share ${formatCents(sums.payableCents)}.` : ""} A finished statement is never edited.
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

/** The recorded costs as the document prints them: one line each, read-only, with the entry a click away. */
function RecordedRows({ statement, propertyId }: { statement: AnyStatement | null; propertyId: string }) {
  if (!statement) return null;
  const rows = statement.legacy
    ? []
    : printedLines({ lines: [], costs: statement.costs, adjustments: statement.adjustments, fee: null });
  if (statement.legacy) return <p className={styles.note}>{statement.costs.length === 0 && statement.adjustments.length === 0 ? "No recorded costs." : `${statement.costs.length + statement.adjustments.length} recorded, as the finished statement printed them.`}</p>;
  if (rows.length === 0) return <p className={styles.note}>No approved costs this month.</p>;
  return (
    <table className={styles.costTable}>
      <thead>
        <tr>
          <th>Description</th>
          <th className={styles.num}>Qty</th>
          <th className={styles.num}>Rate</th>
          <th className={styles.num}>Amount</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            <td>{row.description}</td>
            <td className={styles.num}>{row.quantity}</td>
            <td className={styles.num}>{formatCents(row.rateCents)}</td>
            <td className={styles.num}>{formatCents(row.amountCents)}</td>
            <td>
              {row.entryId && (
                <Link href={`/admin/costs?property=${encodeURIComponent(propertyId)}&status=${row.kind === "adjustment" ? "all" : "approved"}&entry=${encodeURIComponent(row.entryId)}`} prefetch={false}>
                  Open entry
                </Link>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
