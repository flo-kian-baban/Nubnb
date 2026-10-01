"use client";

/**
 * A property's page (dispatch 23F, Kian's ruling of 2026-10-01): the one
 * place an admin works on a property. Everything about it, bound to a month
 * the admin picks — back for past months, forward to the current one.
 *
 *   Left, four tabs:
 *     Costs    log a cost, and the month's approved entries (each opens here)
 *     Income   the month's lines
 *     Details  Report For, the fee and its rate, the carried balance, notes
 *     Finish   the reference and date, finish the statement, download this
 *              month's PDF and any earlier version
 *   Right, the statement preview, always visible, on every tab.
 *
 * ── The preview shows the month as it stands ──
 * Before anything is created, the preview is what the statement would be:
 * the approved costs already recorded, nothing typed yet, the totals. There
 * is no Create button. A draft is created when the admin first types
 * something, and saves itself as it did in the editor: whole, 800 ms after
 * the last change, with the revision the page loaded (dispatch 23B).
 *
 * ── Reads ──
 * Two, on opening: every cost entry with the recorded cost PDFs
 * (GET /api/admin/cost-entries, the costs page's read) and the property's
 * statements — its reports whole, its drafts whole, its downloads and its
 * record (GET /api/admin/properties/[id]/statements). Every month is then
 * worked out here from those two answers; moving between months costs no
 * call. A save, a finish, a download and a review each change the page only
 * to what the server returns.
 *
 * ── Where things went ──
 * The statement editor (/admin/reports/edit) and the tracker (/admin/reports)
 * of dispatches 23B–23E are gone: the editor's fields are the tabs here, its
 * live PDF is the preview, and the tracker is a panel on the admin home
 * under the Statements tile. The costs ledger for any dates stays at
 * /admin/costs?property=&status=approved, a link away from the Costs tab.
 *
 * The month, the tab and the open entry are mirrored into the address bar
 * (?id=&month=&tab=&entry=), so a reload keeps them.
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { AdminHeader } from "../components/AdminHeader";
import { AdminSelect } from "../components/AdminSelect";
import { PinGate } from "../components/PinGate";
import { NoticeBanner, useNotice, type Notice } from "../components/Notice";
import { STATE_CLASS } from "../components/StatementsPanel";
import { fetchCosts } from "@/app/lib/costs-client";
import { fetchPropertyStatements, fetchStatementLink, finishStatement, saveDraft, setReportFor as saveReportFor, type PropertyStatements } from "@/app/lib/reports-client";
import { formatCents, type CostEntryView, type CostsView, type ReportExportView } from "@/app/lib/cleaners/model";
import { torontoDayOf } from "@/app/lib/costs/report";
import {
  STATEMENT_LIMITS,
  addMonths,
  currentReports,
  displayRef,
  inStatementScope,
  isClosedMonth,
  isDayText,
  isMonth,
  monthLabel,
  monthOfDay,
  type MonthlyReportView,
  type PropertyManagementView,
  type ReportDownloadView,
  type ReportFor,
  type StatementDraftView,
} from "@/app/lib/reports/model";
import { STATEMENT_STATE_LABELS, buildStatement, previousStatement, propertyMonthState, propertyMonths, statementOf, type AnyStatement, type FinishClaim, type PropertyMonthRow, type StatementState } from "@/app/lib/reports/statement";
import { statementPdf } from "@/app/lib/reports/statement-pdf";
import type { PropertyStatementsState } from "../costs/EntryPane";
import { CostsTab } from "./CostsTab";
import { DetailsTab } from "./DetailsTab";
import { FinishTab, type SaveState } from "./FinishTab";
import { IncomeTab } from "./IncomeTab";
import { fromReport, fromStored, revenueOf, sha256Hex, suggestedTyped, toDraft, toPayload, type ReportForDraft, type Typed } from "./statement-form";
import shared from "../page.module.css";
import styles from "./page.module.css";

type Read<T> = { kind: "loading" } | { kind: "ready"; data: T } | { kind: "error"; title: string; detail?: string; status: number };
type Tab = "costs" | "income" | "details" | "finish";
const TABS: { key: Tab; label: string }[] = [
  { key: "costs", label: "Costs" },
  { key: "income", label: "Income" },
  { key: "details", label: "Details" },
  { key: "finish", label: "Finish" },
];
const isTab = (value: string | null): value is Tab => TABS.some((tab) => tab.key === value);

const SESSION_HINT = "Your admin session may have expired — reload and sign in again.";
/** If a viewer has not said "load" by then, the frames swap anyway: a viewer that never says so would otherwise show nothing. */
const PREVIEW_SWAP_FALLBACK_MS = 1500;

export default function PropertyPage() {
  return (
    <PinGate>
      <Suspense fallback={null}>
        <PropertyPageInner />
      </Suspense>
    </PinGate>
  );
}

/** A month's state in a few words, for the month list. */
function stateWords(state: StatementState, inScope: boolean): string {
  switch (state.kind) {
    case "finished":
      return `finished · ${displayRef(state.report)}`;
    case "draft":
      return state.superseding ? "correction in progress" : "draft";
    case "outstanding":
      return inScope ? "past due" : "no statement expected";
    case "open":
      return inScope ? "open, not yet due" : "no statement expected";
  }
}

function PropertyPageInner() {
  const params = useSearchParams();
  const propertyId = params.get("id") ?? "";
  const valid = /^[A-Za-z0-9_-]{1,64}$/.test(propertyId);
  const today = torontoDayOf(new Date());
  const thisMonth = monthOfDay(today);
  const [month, setMonth] = useState(() => {
    const wanted = params.get("month");
    return isMonth(wanted) ? wanted : thisMonth;
  });
  const [tab, setTab] = useState<Tab>(() => {
    const wanted = params.get("tab");
    return isTab(wanted) ? wanted : "costs";
  });
  const [entryId, setEntryId] = useState<string | null>(() => params.get("entry"));
  const [costs, setCosts] = useState<Read<CostsView>>({ kind: "loading" });
  const [statements, setStatements] = useState<Read<PropertyStatements>>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const { notice, show, clear } = useNotice();

  // ── The two reads ──
  useEffect(() => {
    if (!valid) return;
    let cancelled = false;
    fetchCosts().then((result) => {
      if (cancelled) return;
      setCosts(result.ok ? { kind: "ready", data: result.data } : { kind: "error", title: result.title, detail: result.detail, status: result.status });
    });
    fetchPropertyStatements(propertyId).then((result) => {
      if (cancelled) return;
      setStatements(result.ok ? { kind: "ready", data: result.data } : { kind: "error", title: result.title, detail: result.detail, status: result.status });
    });
    return () => {
      cancelled = true;
    };
  }, [propertyId, valid, attempt]);

  // ── The address bar ──
  useEffect(() => {
    const url = new URL(window.location.href);
    const set = (key: string, value: string | null) => (value === null || value === "" ? url.searchParams.delete(key) : url.searchParams.set(key, value));
    set("month", month);
    set("tab", tab === "costs" ? null : tab);
    set("entry", entryId);
    if (url.href !== window.location.href) window.history.replaceState(null, "", url.href);
  }, [month, tab, entryId]);

  const reload = useCallback(() => {
    clear();
    setCosts({ kind: "loading" });
    setStatements({ kind: "loading" });
    setAttempt((n) => n + 1);
  }, [clear]);

  // ── What the page holds, after a write ──
  const onDraftSaved = useCallback((draft: StatementDraftView) => {
    setStatements((prev) => (prev.kind === "ready" ? { kind: "ready", data: { ...prev.data, drafts: prev.data.drafts.some((d) => d.id === draft.id) ? prev.data.drafts.map((d) => (d.id === draft.id ? draft : d)) : [...prev.data.drafts, draft] } } : prev));
  }, []);
  const onReportFinished = useCallback((report: MonthlyReportView) => {
    setStatements((prev) =>
      prev.kind === "ready"
        ? {
            kind: "ready",
            data: {
              ...prev.data,
              reports: [report, ...prev.data.reports],
              drafts: prev.data.drafts.map((d) => (d.propertyId === report.propertyId && d.month === report.month ? { ...d, finishedAs: report.id, finishedRevision: report.draftRevision, updatedAt: report.finishedAt } : d)),
            },
          }
        : prev,
    );
  }, []);
  const onManagement = useCallback((record: PropertyManagementView) => {
    setStatements((prev) => (prev.kind === "ready" ? { kind: "ready", data: { ...prev.data, management: record } } : prev));
  }, []);
  const onDownloaded = useCallback((record: ReportDownloadView) => {
    setStatements((prev) => (prev.kind === "ready" ? { kind: "ready", data: { ...prev.data, downloads: [...prev.data.downloads, record] } } : prev));
  }, []);
  const onEntryChanged = useCallback((entry: CostEntryView) => {
    setCosts((prev) => (prev.kind === "ready" ? { kind: "ready", data: { ...prev.data, entries: prev.data.entries.map((e) => (e.id === entry.id ? entry : e)) } } : prev));
  }, []);
  const onEntryAdded = useCallback((entry: CostEntryView) => {
    setCosts((prev) => (prev.kind === "ready" ? { kind: "ready", data: { ...prev.data, entries: [entry, ...prev.data.entries] } } : prev));
  }, []);
  const onExportRecorded = useCallback((record: ReportExportView) => {
    setCosts((prev) => (prev.kind === "ready" ? { kind: "ready", data: { ...prev.data, exports: [record, ...prev.data.exports] } } : prev));
  }, []);

  const data = statements.kind === "ready" ? statements.data : null;
  const costData = costs.kind === "ready" ? costs.data : null;

  // ── The months ──
  const draftLikes = useMemo(() => (data ? data.drafts.map((d) => ({ propertyId: d.propertyId, month: d.month, updatedAt: d.updatedAt, finishedAs: d.finishedAs, superseding: d.supersedes !== null })) : []), [data]);
  const months = useMemo(() => (data ? propertyMonths({ propertyId, today, management: data.management, reports: data.reports, drafts: draftLikes }) : null), [data, draftLikes, propertyId, today]);
  const monthNow = useMemo(() => (data ? propertyMonthState({ propertyId, month, today, reports: data.reports, drafts: draftLikes }) : null), [data, draftLikes, propertyId, month, today]);
  const inScope = data ? inStatementScope(data.management, month) : true;
  /** The months the control lists: the property's, and the chosen one when it is earlier than any of them. */
  const monthOptions = useMemo(() => {
    if (!months || !monthNow) return [];
    const rows: PropertyMonthRow[] = months.rows.some((row) => row.month === month) ? months.rows : [...months.rows, { month, state: monthNow.state, reports: monthNow.reports, inScope }].sort((a, b) => b.month.localeCompare(a.month));
    return rows.map((row) => ({ value: row.month, label: `${monthLabel(row.month)} · ${stateWords(row.state, row.inScope)}` }));
  }, [months, monthNow, month, inScope]);

  const propertyName = data?.propertyName ?? costData?.properties?.find((p) => p.id === propertyId)?.name ?? null;

  if (!valid) {
    return (
      <div className={shared.container}>
        <AdminHeader current="properties" title="Property" />
        <main className={shared.main}>
          <div className={`${shared.empty} ${shared.loadError}`} role="alert">
            <AlertTriangle size={48} strokeWidth={1} />
            <h2>Which property?</h2>
            <p>Open one from the list: the address needs a property ID.</p>
            <Link href="/admin" prefetch={false} className={shared.btnPrimary}>
              Go to Properties
            </Link>
          </div>
        </main>
      </div>
    );
  }

  const failed = costs.kind === "error" ? costs : statements.kind === "error" ? statements : null;
  const loading = costs.kind === "loading" || statements.kind === "loading";

  return (
    <div className={shared.container}>
      <AdminHeader current="properties" title={propertyName ?? "Property"}>
        <button type="button" className={shared.btnGhost} onClick={reload} disabled={loading}>
          <RefreshCw size={15} aria-hidden />
          <span>Refresh</span>
        </button>
      </AdminHeader>

      <main className={shared.main}>
        <NoticeBanner notice={notice} onDismiss={clear} className={shared.pageNotice} />

        {failed ? (
          <div className={`${shared.empty} ${shared.loadError}`} role="alert">
            <AlertTriangle size={48} strokeWidth={1} />
            <h2>Could not load the property</h2>
            <p>
              It has not loaded.
              {(failed.status === 401 || failed.status === 403) && ` ${SESSION_HINT}`}
            </p>
            <code className={shared.loadErrorDetail}>
              {failed.title}
              {failed.detail ? ` ${failed.detail}` : ""}
            </code>
            <button type="button" className={shared.btnPrimary} onClick={reload}>
              <RefreshCw size={18} />
              <span>Retry</span>
            </button>
          </div>
        ) : loading || !data || !costData || !months || !monthNow ? (
          <div className={shared.loading}>
            <div className={shared.spinner} />
            <p>Loading the property…</p>
          </div>
        ) : (
          <>
            {/* ── The head: the property, the month, its state ── */}
            <div className={styles.head}>
              <h2 className={styles.title}>{data.propertyName}</h2>
              <div className={styles.monthRow}>
                <button type="button" className={styles.monthStep} aria-label="Previous month" onClick={() => setMonth((m) => addMonths(m, -1))}>
                  <ChevronLeft size={18} aria-hidden />
                </button>
                <AdminSelect label="Month" className={styles.monthSelect} value={month} onChange={setMonth} groups={[{ options: monthOptions }]} />
                <button type="button" className={styles.monthStep} aria-label="Next month" disabled={month >= thisMonth} onClick={() => setMonth((m) => addMonths(m, 1))}>
                  <ChevronRight size={18} aria-hidden />
                </button>
              </div>
              <div className={styles.headState}>
                {inScope || monthNow.state.kind === "draft" || monthNow.state.kind === "finished" ? (
                  <span className={`${shared.stateBadge} ${STATE_CLASS[monthNow.state.kind]}`}>{monthNow.state.kind === "draft" && monthNow.state.superseding ? "Correction in progress" : STATEMENT_STATE_LABELS[monthNow.state.kind]}</span>
                ) : (
                  <span className={`${shared.stateBadge} ${shared.stateOpen}`}>No statement expected</span>
                )}
                {months.outstanding.length > 0 && (
                  <span className={styles.noteWarn} role="status">
                    Past due:{" "}
                    {months.outstanding.map((m, i) => {
                      const row = months.rows.find((x) => x.month === m);
                      return (
                        <span key={m}>
                          {i > 0 && ", "}
                          <button type="button" className={styles.linkButton} onClick={() => setMonth(m)} disabled={m === month}>
                            {monthLabel(m)}
                          </button>
                          {row?.state.kind === "draft" && " (draft)"}
                        </span>
                      );
                    })}
                  </span>
                )}
              </div>
            </div>

            <MonthWork
              key={`${month}:${attempt}`}
              propertyId={propertyId}
              propertyName={data.propertyName}
              month={month}
              today={today}
              tab={tab}
              onTab={setTab}
              entryId={entryId}
              onEntry={setEntryId}
              entries={costData.entries}
              exports={costData.exports}
              reports={data.reports}
              draft={data.drafts.find((d) => d.month === month) ?? null}
              management={data.management}
              downloads={data.downloads}
              statementsState={{ kind: "ready", data }}
              unreadable={data.unreadable.reports + data.unreadable.drafts}
              show={show}
              clear={clear}
              onReload={reload}
              onDraftSaved={onDraftSaved}
              onReportFinished={onReportFinished}
              onManagement={onManagement}
              onDownloaded={onDownloaded}
              onEntryChanged={onEntryChanged}
              onEntryAdded={onEntryAdded}
              onExportRecorded={onExportRecorded}
            />
          </>
        )}
      </main>
    </div>
  );
}

interface MonthWorkProps {
  propertyId: string;
  propertyName: string;
  month: string;
  today: string;
  tab: Tab;
  onTab: (tab: Tab) => void;
  entryId: string | null;
  onEntry: (id: string | null) => void;
  entries: CostEntryView[];
  exports: ReportExportView[];
  reports: MonthlyReportView[];
  draft: StatementDraftView | null;
  management: PropertyManagementView | null;
  downloads: ReportDownloadView[];
  statementsState: PropertyStatementsState;
  unreadable: number;
  show: (notice: Notice) => void;
  clear: () => void;
  onReload: () => void;
  onDraftSaved: (draft: StatementDraftView) => void;
  onReportFinished: (report: MonthlyReportView) => void;
  onManagement: (record: PropertyManagementView) => void;
  onDownloaded: (record: ReportDownloadView) => void;
  onEntryChanged: (entry: CostEntryView) => void;
  onEntryAdded: (entry: CostEntryView) => void;
  onExportRecorded: (record: ReportExportView) => void;
}

/**
 * One month's work: what is typed for it, its saves, the statement as it
 * stands and the preview. Mounted fresh for each month (and after a reload),
 * so a month's typed state never bleeds into another's; a save still pending
 * when the admin moves on is sent as the component leaves.
 */
function MonthWork(props: MonthWorkProps) {
  const { propertyId, month, today, tab, entries, exports, reports, draft, management, downloads, show, clear, onReload, onDraftSaved, onReportFinished, onManagement, onDownloaded } = props;

  // ── The month's finished statement, if any ──
  const live = useMemo(() => currentReports(reports).filter((r) => r.month === month).sort((a, b) => b.finishedAt.localeCompare(a.finishedAt))[0] ?? null, [reports, month]);
  const finishedReport: MonthlyReportView | null = draft ? (draft.finishedAs !== null ? (reports.find((r) => r.id === draft.finishedAs) ?? live) : null) : live;
  const readOnly = finishedReport !== null;
  const previous = useMemo(() => previousStatement(reports, month), [reports, month]);
  const versions = useMemo(() => propertyMonthState({ propertyId, month, today, reports, drafts: draft ? [{ propertyId, month, updatedAt: draft.updatedAt, finishedAs: draft.finishedAs, superseding: draft.supersedes !== null }] : [] }).reports, [propertyId, month, today, reports, draft]);

  // ── What is typed ──
  const [typed, setTyped] = useState<Typed>(() => (finishedReport ? fromReport(finishedReport, today) : draft ? fromStored(draft, today) : suggestedTyped(previous, management, month, today)));
  const [reportFor, setReportFor] = useState<ReportForDraft>(() => ({ name: management?.reportFor?.name ?? "", address: management?.reportFor?.address ?? "" }));
  const [reportForState, setReportForState] = useState<"saved" | "saving" | "unsaved" | "failed">("saved");
  const [save, setSave] = useState<SaveState>(() => (draft && !finishedReport ? { kind: "saved", at: draft.updatedAt } : { kind: "none" }));
  const [finishing, setFinishing] = useState(false);
  const [linking, setLinking] = useState<string | null>(null);
  const [verified, setVerified] = useState<{ ok: boolean; stored: string; computed: string } | null>(null);
  const savedRef = useRef<string>(JSON.stringify(draft && !finishedReport ? fromStored(draft, today) : null));
  const typedRef = useRef(typed);
  typedRef.current = typed;
  const revisionRef = useRef(draft?.revision ?? 0);
  const supersedesRef = useRef<{ reportId: string; reason: string } | null>(draft && !finishedReport ? draft.supersedes : null);
  const saveTimer = useRef<number | null>(null);
  const reportForSavedRef = useRef<string>(JSON.stringify({ name: management?.reportFor?.name ?? "", address: management?.reportFor?.address ?? "" }));
  const reportForRef = useRef(reportFor);
  reportForRef.current = reportFor;
  const reportForTimer = useRef<number | null>(null);
  const supersedes = supersedesRef.current;

  // ── The statement as it stands ──
  const parsed = useMemo(() => toDraft(typed), [typed]);
  const shownReportFor: ReportFor | null = reportFor.name.trim() === "" ? null : { name: reportFor.name.trim(), address: reportFor.address };
  const built = useMemo(() => {
    const record = management ? { ...management, reportFor: shownReportFor } : shownReportFor ? { id: propertyId, schemaVersion: 0, propertyId, reportFor: shownReportFor, owners: [], statementsFrom: "2026-10", statementsUntil: null, defaultFeeRateBasisPoints: null, defaultFee: null, setAt: "" } : null;
    return buildStatement({
      propertyId,
      propertyName: props.propertyName,
      month,
      entries,
      reports,
      draft: { reference: typed.reference.trim(), reportDate: typed.reportDate, lines: parsed.lines, fee: parsed.fee, carried: parsed.carried, notes: typed.notes.trim() || null, supersedes },
      management: record,
    });
    // shownReportFor is derived from reportFor; comparing the object would redraw on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propertyId, props.propertyName, month, entries, reports, parsed, typed.reference, typed.reportDate, typed.notes, supersedes, reportFor.name, reportFor.address, management]);
  const statement: AnyStatement | null = useMemo(() => {
    if (finishedReport) return statementOf(finishedReport, reports);
    return built.kind === "ok" ? built.statement : null;
  }, [finishedReport, reports, built]);
  /** The figures the tabs show: the frozen statement's once finished, else the live build's. */
  const sums = finishedReport ? (finishedReport.legacy ? null : finishedReport) : built.kind === "ok" ? built.statement : null;
  const revenueCents = useMemo(() => revenueOf(parsed.lines), [parsed.lines]);

  // ── Save, 800 ms after the last change; the first save on a month with nothing stored creates the draft ──
  const doSave = useCallback(async () => {
    const current = typedRef.current;
    const key = JSON.stringify(current);
    if (key === savedRef.current) return;
    setSave({ kind: "saving" });
    const result = await saveDraft(toPayload(propertyId, month, revisionRef.current, current, supersedesRef.current));
    if (result.ok) {
      savedRef.current = key;
      revisionRef.current = result.data.draft.revision;
      setSave({ kind: "saved", at: result.data.draft.updatedAt });
      onDraftSaved(result.data.draft);
      return;
    }
    if (result.code === "DRAFT_CHANGED" || result.code === "DRAFT_FINISHED") {
      show({ tone: "warning", title: result.code === "DRAFT_CHANGED" ? "This month's draft was changed elsewhere — another tab or another admin." : "This month's statement was finished meanwhile.", detail: "Your last change was not saved. The page reloads what is stored." });
      onReload();
      return;
    }
    setSave({ kind: "failed", reason: `${result.title}${result.detail ? ` ${result.detail}` : ""}${result.status === 401 || result.status === 403 ? ` ${SESSION_HINT}` : ""}` });
  }, [propertyId, month, show, onReload, onDraftSaved]);
  const doSaveRef = useRef(doSave);
  doSaveRef.current = doSave;

  const change = (next: Typed) => {
    if (readOnly) return;
    setTyped(next);
    setSave({ kind: "unsaved" });
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      void doSaveRef.current();
    }, STATEMENT_LIMITS.SAVE_DELAY_MS);
  };

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
      onManagement(result.data.record);
      return;
    }
    setReportForState("failed");
    show({ tone: "error", title: result.title, detail: result.detail });
  }, [propertyId, show, onManagement]);
  const doSaveReportForRef = useRef(doSaveReportFor);
  doSaveReportForRef.current = doSaveReportFor;
  const changeReportFor = (next: ReportForDraft) => {
    if (readOnly) return;
    setReportFor(next);
    setReportForState("unsaved");
    if (reportForTimer.current !== null) window.clearTimeout(reportForTimer.current);
    reportForTimer.current = window.setTimeout(() => {
      reportForTimer.current = null;
      void doSaveReportForRef.current();
    }, STATEMENT_LIMITS.SAVE_DELAY_MS);
  };

  // A save still pending when the admin moves to another month (or the page reloads its data) is sent now, not lost.
  useEffect(
    () => () => {
      if (saveTimer.current !== null) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = null;
        void doSaveRef.current();
      }
      if (reportForTimer.current !== null) {
        window.clearTimeout(reportForTimer.current);
        reportForTimer.current = null;
        void doSaveReportForRef.current();
      }
    },
    [],
  );

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
    if (built.kind !== "ok" || finishing || readOnly) return;
    clear();
    const problems = [...parsed.problems, ...(typed.reference.trim() === "" ? ["Give the statement a reference, like Aug-321-John"] : []), ...(isDayText(typed.reportDate) ? [] : ["Give the statement a date"])];
    if (problems.length > 0) {
      show({ tone: "error", title: "The statement cannot be finished as it stands.", items: problems });
      return;
    }
    if (save.kind !== "saved" || revisionRef.current === 0 || reportForState !== "saved") {
      show({ tone: "warning", title: save.kind === "none" ? "Nothing is saved yet: type a line, a fee or a note first." : "Wait for the draft to save first.", detail: save.kind === "failed" ? save.reason : undefined });
      return;
    }
    const pending = built.statement.pendingLeftOut;
    const question = [
      `Finish and issue # ${typed.reference.trim()} for ${props.propertyName}, ${monthLabel(month)}?`,
      `Your Revenue Share: ${formatCents(built.statement.payableCents)}.`,
      pending > 0 ? `${pending === 1 ? "1 entry" : `${pending} entries`} sent in ${monthLabel(month)} ${pending === 1 ? "is" : "are"} still pending and ${pending === 1 ? "is" : "are"} not in it.` : null,
      "A finished statement is never edited; a mistake in it is corrected with a replacing statement.",
    ]
      .filter(Boolean)
      .join("\n");
    if (!window.confirm(question)) return;
    setFinishing(true);
    const claim: FinishClaim = built.claim;
    const result = await finishStatement({ propertyId, month, draftRevision: revisionRef.current, ...claim });
    setFinishing(false);
    if (!result.ok) {
      if (result.code === "STATEMENT_CHANGED" || result.code === "DRAFT_CHANGED") {
        show({ tone: "warning", title: result.title, detail: `${result.detail ?? ""} The page reloads what is stored.` });
        onReload();
        return;
      }
      show(result.unknown ? { tone: "warning", title: "The statement may or may not have been finished. Reload to see what is on record.", detail: result.title } : { tone: "error", title: result.title, detail: result.detail });
      return;
    }
    const { report } = result.data;
    const computed = await sha256Hex(statementPdf(statementOf(report, [...reports, report])));
    setVerified({ ok: computed === report.pdf.sha256, stored: report.pdf.sha256, computed });
    setTyped(fromReport(report, today));
    savedRef.current = JSON.stringify(fromReport(report, today));
    onReportFinished(report);
    show({ tone: "success", title: `Finished · ${displayRef(report)}.`, detail: computed === report.pdf.sha256 ? "The PDF stored is byte for byte the one the page shows: its SHA-256 matches." : "The stored PDF's SHA-256 does not match the page's. Download it and check before sending." });
  };

  // ── Correct ──
  const correct = async () => {
    if (!finishedReport || finishing) return;
    const reason = window.prompt(`Correct ${displayRef(finishedReport)}? It stays on record, marked replaced, and a corrected statement is made beside it. Why is it corrected? (the owner reads this)`)?.trim();
    if (!reason) return;
    if (reason.length > STATEMENT_LIMITS.REASON_MAX) {
      show({ tone: "error", title: `The reason can be at most ${STATEMENT_LIMITS.REASON_MAX} characters.` });
      return;
    }
    clear();
    const next = fromReport(finishedReport, today);
    if (next.reference === "") next.reference = suggestedTyped(previous, management, month, today).reference;
    next.reportDate = today;
    const sup = { reportId: finishedReport.id, reason };
    setSave({ kind: "saving" });
    const result = await saveDraft(toPayload(propertyId, month, revisionRef.current, next, sup));
    if (!result.ok) {
      setSave({ kind: "failed", reason: result.title });
      show({ tone: "error", title: result.title, detail: result.detail });
      return;
    }
    setTyped(next);
    savedRef.current = JSON.stringify(next);
    supersedesRef.current = sup;
    revisionRef.current = result.data.draft.revision;
    setVerified(null);
    setSave({ kind: "saved", at: result.data.draft.updatedAt });
    onDraftSaved(result.data.draft);
    show({ tone: "info", title: "Correcting the statement.", detail: "The lines, fee, balance and notes are copied from the finished statement; the recorded costs are read fresh. Finish it to replace the old one." });
  };

  // ── Download ──
  const download = async (reportId: string) => {
    if (linking !== null) return;
    setLinking(reportId);
    const result = await fetchStatementLink(reportId);
    setLinking(null);
    if (!result.ok) {
      show({ tone: "error", title: result.title, detail: result.detail });
      return;
    }
    window.open(result.data.url, "_blank", "noopener");
    onDownloaded(result.data.download);
    show({ tone: "success", title: `PDF opened; the link works for ${result.data.seconds} seconds.` });
  };
  const downloadsOf = (reportId: string) => {
    const at = downloads.filter((d) => d.reportId === reportId).map((d) => d.at).sort();
    return { count: at.length, last: at[at.length - 1] ?? null };
  };

  const monthOpen = !isClosedMonth(month, today);
  const approvedInMonth = built.kind === "ok" ? built.statement.costs.filter((c) => c.group === "month").length : null;

  return (
    <div className={styles.layout}>
      <div className={styles.left}>
        {/* ── The tabs ── */}
        <div className={styles.tabs} role="tablist" aria-label="Property">
          {TABS.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={`${styles.tab} ${tab === t.key ? styles.tabActive : ""}`} onClick={() => props.onTab(t.key)}>
              {t.label}
              {t.key === "costs" && approvedInMonth !== null && approvedInMonth > 0 && <span className={styles.tabCount}>{approvedInMonth}</span>}
              {t.key === "income" && typed.lines.length > 0 && <span className={styles.tabCount}>{typed.lines.length}</span>}
            </button>
          ))}
        </div>

        {built.kind === "unreadable" && (
          <p className={styles.noteWarn} role="alert">
            An approved entry this statement would carry cannot be added up ({built.entryIds.join(", ")}). Open it under Costs; no statement can be made until it reads.
          </p>
        )}
        {props.unreadable > 0 && <p className={styles.noteWarn}>{props.unreadable} stored {props.unreadable === 1 ? "document is" : "documents are"} not in the written shape and left out.</p>}

        <div className={styles.body}>
          {tab === "costs" && (
            <CostsTab
              propertyId={propertyId}
              propertyName={props.propertyName}
              month={month}
              today={today}
              entries={entries}
              exports={exports}
              statement={statement}
              finishedReport={finishedReport}
              statements={props.statementsState}
              openEntryId={props.entryId}
              onOpenEntry={props.onEntry}
              onEntryChanged={props.onEntryChanged}
              onEntryAdded={props.onEntryAdded}
              onExportRecorded={props.onExportRecorded}
              show={show}
            />
          )}
          {tab === "income" && <IncomeTab typed={typed} readOnly={readOnly} sums={sums} onChange={change} />}
          {tab === "details" && (
            <DetailsTab
              typed={typed}
              readOnly={readOnly}
              onChange={change}
              reportFor={reportFor}
              reportForState={reportForState}
              onReportFor={changeReportFor}
              finishedReport={finishedReport}
              previous={previous}
              management={management}
              revenueCents={revenueCents}
              carriedCents={parsed.carried?.amountCents ?? null}
            />
          )}
          {tab === "finish" && (
            <FinishTab
              month={month}
              monthOpen={monthOpen}
              typed={typed}
              readOnly={readOnly}
              onChange={change}
              finishedReport={finishedReport}
              versions={versions}
              supersedes={readOnly ? null : supersedes}
              save={save}
              reportForState={reportForState}
              payableCents={sums ? sums.payableCents : null}
              buildable={built.kind === "ok"}
              finishing={finishing}
              onFinish={finish}
              onCorrect={correct}
              linking={linking}
              onDownload={download}
              verified={verified}
              downloadsOf={downloadsOf}
            />
          )}
        </div>
      </div>

      {/* ── The preview, alive on every tab ── */}
      <div>
        <div className={styles.preview} aria-label="The statement as a PDF">
          <iframe ref={frameA} className={`${styles.previewFrame} ${shown === "a" ? "" : styles.previewHidden}`} title="Statement PDF" />
          <iframe ref={frameB} className={`${styles.previewFrame} ${shown === "b" ? "" : styles.previewHidden}`} title="Statement PDF, next" />
          {!statement && <div className={styles.previewEmpty}>{built.kind === "unreadable" ? "No statement until every approved entry can be added up." : "No statement to show."}</div>}
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
          {readOnly ? "The finished statement, drawn from the frozen record." : "The statement as it stands, redrawn as you type. What you see is what Finish stores."}
        </p>
      </div>
    </div>
  );
}
