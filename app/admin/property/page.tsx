"use client";

/**
 * A property's page (dispatch 23F, Kian's ruling of 2026-10-01): the one
 * place an admin works on a property. Everything about it, bound to a month
 * the admin picks — back for past months, forward to the current one.
 *
 *   Left, the month picker with the month's state, then four tabs, Income
 *   first and open by default (Kian, 2026-10-01):
 *     Income   the month's lines
 *     Costs    log a cost, and the month's approved entries (each opens here)
 *     Details  Report For, the fee and its rate, the carried balance, notes
 *     Finish   the reference and date, finish the statement, download this
 *              month's PDF and any earlier version, and the release status of
 *              the four months before the current one, it, and the two after
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
 * call. Beside them, never holding the page up, the property's lines from
 * the platforms' files (GET /api/admin/properties/[id]/income, dispatch 27):
 * the Income tab marks a line accepted from a file with its file and row,
 * and counts the month's lines still waiting on the Income page. A save, a finish, a download and a review each change the page only
 * to what the server returns.
 *
 * ── Where things went ──
 * The statement editor (/admin/reports/edit) and the tracker (/admin/reports)
 * of dispatches 23B–23E are gone: the editor's fields are the tabs here, its
 * live PDF is the preview, and the tracker is a panel on the admin home
 * under the Statements tile. The costs ledger for any dates stays at
 * /admin/costs?property=&status=approved, a link away from the Costs tab.
 *
 * ── The head says what is due (dispatch 23G) ──
 * Beside the name, the property's status in Nubnb's cycle — the months past
 * due, the previous month when it is due, or the month that says it is done
 * — each a way to that month; `reportingStatus` decides it, as for the
 * property list's column and the home's tile and panel. The month control's
 * badge is that month's standing, by the same rule.
 *
 * ── Deleting a finished statement (Kian's ruling of 2026-10-02) ──
 * The Finish tab offers "Delete statement…" beside "Correct this
 * statement…". The confirmation names what is lost — whether and when the
 * statement was downloaded; the server deletes the report, its PDF and its
 * download records, and answers the draft reopened with everything the
 * statement held, which the month then shows, editable, to be finished again.
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
import { ReportingStatusLine, StandingBadge } from "../components/StatementStatus";
import { fetchCosts } from "@/app/lib/costs-client";
import { deleteStatement, fetchPropertyStatements, fetchStatementLink, finishStatement, saveDraft, setReportFor as saveReportFor, type PropertyStatements, type StatementDeleted } from "@/app/lib/reports-client";
import { fetchPropertyIncome } from "@/app/lib/income-client";
import type { EarningsLineView } from "@/app/lib/income/model";
import { formatCents, type CostEntryView, type CostsView, type ReportExportView } from "@/app/lib/cleaners/model";
import { torontoDayOf } from "@/app/lib/costs/report";
import {
  STATEMENT_LIMITS,
  addMonths,
  currentReports,
  displayRef,
  inStatementScope, isExcludedFromReporting,
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
import { STANDING_LABELS, buildStatement, moneyMonthsByProperty, previousStatement, propertyMonthState, propertyMonths, reportingStatus, statementOf, type AnyStatement, type FinishClaim, type PropertyMonthRow } from "@/app/lib/reports/statement";
import { statementPdf } from "@/app/lib/reports/statement-pdf";
import type { PropertyStatementsState } from "../costs/EntryPane";
import { CostsTab } from "./CostsTab";
import { DetailsTab } from "./DetailsTab";
import { FinishTab, type ReleaseRow, type SaveState } from "./FinishTab";
import { IncomeTab } from "./IncomeTab";
import { PdfPages } from "./PdfPages";
import { fromReport, fromStored, sha256Hex, suggestedTyped, toDraft, toPayload, type ReportForDraft, type Typed } from "./statement-form";
import shared from "../page.module.css";
import styles from "./page.module.css";

type Read<T> = { kind: "loading" } | { kind: "ready"; data: T } | { kind: "error"; title: string; detail?: string; status: number };
/** What GET /api/admin/properties/[id]/income answers (dispatch 27): the property's lines from the platforms' files, and their files' names. */
type FromFiles = { lines: EarningsLineView[]; uploads: { id: string; name: string; month: string }[] };
type Tab = "costs" | "income" | "details" | "finish";
const TABS: { key: Tab; label: string }[] = [
  { key: "income", label: "Income" },
  { key: "costs", label: "Costs" },
  { key: "details", label: "Details" },
  { key: "finish", label: "Finish" },
];
const isTab = (value: string | null): value is Tab => TABS.some((tab) => tab.key === value);

const SESSION_HINT = "Your admin session may have expired — reload and sign in again.";

export default function PropertyPage() {
  return (
    <PinGate>
      <Suspense fallback={null}>
        <PropertyPageInner />
      </Suspense>
    </PinGate>
  );
}

/** A month in a few words, for the month list: its standing, then what is stored ("due · draft", "finished · # Sep-321-John"). */
function monthWords(row: Pick<PropertyMonthRow, "state" | "standing" | "reports">): string {
  const live = row.reports.find((r) => r.replacedBy === null)?.report;
  const standing = row.standing === "finished" && live ? `finished · ${displayRef(live)}` : STANDING_LABELS[row.standing].toLowerCase();
  if (row.state.kind !== "draft") return standing;
  return `${standing} · ${row.state.superseding ? "correction in progress" : "draft"}`;
}

/** "3 October", or "3 October 2025" outside the current year: the day a download was made, in Toronto. */
function dayWords(iso: string, today: string): string {
  const [y, m, d] = torontoDayOf(new Date(iso)).split("-").map(Number);
  const month = new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-CA", { month: "long", timeZone: "UTC" });
  return `${d} ${month}${String(y) === today.slice(0, 4) ? "" : ` ${y}`}`;
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
    return isTab(wanted) ? wanted : "income";
  });
  const [entryId, setEntryId] = useState<string | null>(() => params.get("entry"));
  const [costs, setCosts] = useState<Read<CostsView>>({ kind: "loading" });
  const [statements, setStatements] = useState<Read<PropertyStatements>>({ kind: "loading" });
  /** The lines from the platforms' files under this property (dispatch 27): read beside the two, never in their way. */
  const [fromFiles, setFromFiles] = useState<Read<FromFiles>>({ kind: "loading" });
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
    fetchPropertyIncome(propertyId).then((result) => {
      if (cancelled) return;
      setFromFiles(result.ok ? { kind: "ready", data: result.data } : { kind: "error", title: result.title, detail: result.detail, status: result.status });
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
    set("tab", tab === "income" ? null : tab);
    set("entry", entryId);
    if (url.href !== window.location.href) window.history.replaceState(null, "", url.href);
  }, [month, tab, entryId]);

  const reload = useCallback(() => {
    clear();
    setCosts({ kind: "loading" });
    setStatements({ kind: "loading" });
    setFromFiles({ kind: "loading" });
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
  /** An entry deleted outright (dispatch 23H): it leaves the page's list. */
  const onEntryDeleted = useCallback((id: string) => {
    setCosts((prev) => (prev.kind === "ready" ? { kind: "ready", data: { ...prev.data, entries: prev.data.entries.filter((e) => e.id !== id) } } : prev));
  }, []);
  const onEntryAdded = useCallback((entry: CostEntryView) => {
    setCosts((prev) => (prev.kind === "ready" ? { kind: "ready", data: { ...prev.data, entries: [entry, ...prev.data.entries] } } : prev));
  }, []);
  const onExportRecorded = useCallback((record: ReportExportView) => {
    setCosts((prev) => (prev.kind === "ready" ? { kind: "ready", data: { ...prev.data, exports: [record, ...prev.data.exports] } } : prev));
  }, []);
  /** Bumped when a statement is deleted, so the month's work is mounted afresh from the reopened draft. */
  const [generation, setGeneration] = useState(0);
  const onStatementDeleted = useCallback((answer: StatementDeleted) => {
    const { reportId } = answer.deleted;
    setStatements((prev) =>
      prev.kind === "ready"
        ? {
            kind: "ready",
            data: {
              ...prev.data,
              reports: prev.data.reports.filter((r) => r.id !== reportId),
              downloads: prev.data.downloads.filter((d) => d.reportId !== reportId),
              drafts: prev.data.drafts.some((d) => d.id === answer.draft.id) ? prev.data.drafts.map((d) => (d.id === answer.draft.id ? answer.draft : d)) : [...prev.data.drafts, answer.draft],
              management: answer.management ?? prev.data.management,
            },
          }
        : prev,
    );
    setGeneration((n) => n + 1);
  }, []);

  const data = statements.kind === "ready" ? statements.data : null;
  const costData = costs.kind === "ready" ? costs.data : null;

  // ── The months ──
  /** The months this property has accepted income or approved costs in: owed whenever it was added (Kian's ruling of 2026-10-04). */
  const moneyMonths = useMemo(() => (data ? (moneyMonthsByProperty(data.drafts, costData?.entries ?? []).get(propertyId) ?? []) : []), [data, costData, propertyId]);
  const draftLikes = useMemo(() => (data ? data.drafts.map((d) => ({ propertyId: d.propertyId, month: d.month, updatedAt: d.updatedAt, finishedAs: d.finishedAs, superseding: d.supersedes !== null })) : []), [data]);
  const months = useMemo(() => (data ? propertyMonths({ propertyId, today, management: data.management, createdMonth: data.createdMonth ?? null, moneyMonths, reports: data.reports, drafts: draftLikes }) : null), [data, draftLikes, moneyMonths, propertyId, today]);
  const inScope = data ? inStatementScope(data.management, month, data.createdMonth ?? null, moneyMonths) : true;
  const monthNow = useMemo(() => (data ? propertyMonthState({ propertyId, month, today, inScope, excluded: isExcludedFromReporting(data.management), reports: data.reports, drafts: draftLikes }) : null), [data, draftLikes, propertyId, month, today, inScope]);
  /** The property's status in the cycle (dispatch 23G): the head's line, by the rule the list, the panel and the tile use. */
  const status = useMemo(() => (data ? reportingStatus({ propertyId, today, management: data.management, createdMonth: data.createdMonth ?? null, moneyMonths, reports: data.reports }) : null), [data, moneyMonths, propertyId, today]);
  /** The months the control lists: the property's, and the chosen one when it is earlier than any of them. */
  const monthOptions = useMemo(() => {
    if (!months || !monthNow) return [];
    const rows: PropertyMonthRow[] = months.rows.some((row) => row.month === month) ? months.rows : [...months.rows, { month, ...monthNow, inScope }].sort((a, b) => b.month.localeCompare(a.month));
    return rows.map((row) => ({ value: row.month, label: `${monthLabel(row.month)} · ${monthWords(row)}` }));
  }, [months, monthNow, month, inScope]);

  /** The Finish tab's release status: the four months before the current one, it, and the two after (Kian, 2026-10-01). */
  const releases = useMemo<ReleaseRow[]>(() => {
    if (!data) return [];
    return [-4, -3, -2, -1, 0, 1, 2].map((offset) => {
      const m = addMonths(thisMonth, offset);
      const one = propertyMonthState({ propertyId, month: m, today, inScope: inStatementScope(data.management, m, data.createdMonth ?? null, moneyMonths), excluded: isExcludedFromReporting(data.management), reports: data.reports, drafts: draftLikes });
      return { month: m, state: one.state, standing: one.standing, live: one.reports.find((r) => r.replacedBy === null)?.report ?? null, upcoming: m > thisMonth };
    });
  }, [data, draftLikes, moneyMonths, propertyId, today, thisMonth]);

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
        ) : loading || !data || !costData || !months || !monthNow || !status ? (
          <div className={shared.loading}>
            <div className={shared.spinner} />
            <p>Loading the property…</p>
          </div>
        ) : (
          <>
            {/* ── The head: the property, and what is due for it (dispatch 23G) ── */}
            <div className={styles.head}>
              <h2 className={styles.title}>{data.propertyName}</h2>
              <ReportingStatusLine status={status} current={month} onMonth={setMonth} />
            </div>

            {/* ── The month and its state over the tabs, the preview beside both. The bar is outside MonthWork,
                 which is remounted with each month, so the arrows keep focus as the admin steps through months. ── */}
            <div className={styles.layout}>
              <div className={styles.monthBar}>
                <div className={styles.monthRow}>
                  <button type="button" className={styles.monthStep} aria-label="Previous month" onClick={() => setMonth((m) => addMonths(m, -1))}>
                    <ChevronLeft size={18} aria-hidden />
                  </button>
                  <AdminSelect label="Month" className={styles.monthSelect} value={month} onChange={setMonth} groups={[{ options: monthOptions }]} />
                  <button type="button" className={styles.monthStep} aria-label="Next month" disabled={month >= thisMonth} onClick={() => setMonth((m) => addMonths(m, 1))}>
                    <ChevronRight size={18} aria-hidden />
                  </button>
                </div>
                <StandingBadge standing={monthNow.standing} />
              </div>

              <MonthWork
                key={`${month}:${attempt}:${generation}`}
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
                onEntryDeleted={onEntryDeleted}
                onEntryAdded={onEntryAdded}
                onExportRecorded={onExportRecorded}
                onStatementDeleted={onStatementDeleted}
                releases={releases}
                onMonth={setMonth}
                fromFiles={fromFiles}
              />
            </div>
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
  onEntryDeleted: (id: string) => void;
  onEntryAdded: (entry: CostEntryView) => void;
  onExportRecorded: (record: ReportExportView) => void;
  /** A finished statement was deleted: the server's answer, with the draft reopened. */
  onStatementDeleted: (answer: StatementDeleted) => void;
  /** The Finish tab's release status, worked out by the page from every month's reports and drafts. */
  releases: ReleaseRow[];
  /** Opens another month: the page owns the month. */
  onMonth: (month: string) => void;
  /** The property's lines from the platforms' files (dispatch 27), for the Income tab's marks and its count to review. */
  fromFiles: Read<FromFiles>;
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
  const versions = useMemo(() => propertyMonthState({ propertyId, month, today, inScope: true, reports, drafts: draft ? [{ propertyId, month, updatedAt: draft.updatedAt, finishedAs: draft.finishedAs, superseding: draft.supersedes !== null }] : [] }).reports, [propertyId, month, today, reports, draft]);

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

  /**
   * The lines from the platforms' files (dispatch 27): which of the month's lines an admin accepted from a
   * file, and its file and row; and how many of the month's lines wait on the Income page. Read from the
   * same earnings lines the Income page reads; the lines themselves are the draft's.
   */
  const files = useMemo(() => {
    const read = props.fromFiles;
    if (read.kind !== "ready") return { marks: new Map<string, string>(), pending: 0, failed: read.kind === "error", month };
    const names = new Map(read.data.uploads.map((u) => [u.id, u.name]));
    const marks = new Map<string, string>();
    for (const line of read.data.lines) {
      if (line.decided?.status === "accepted" && line.decided.propertyId === propertyId) marks.set(line.decided.lineId, `${names.get(line.uploadId) ?? "a file"} · row ${line.fileRow}`);
    }
    return { marks, pending: read.data.lines.filter((line) => line.status === "proposed" && line.month === month).length, failed: false, month };
  }, [props.fromFiles, propertyId, month]);

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

  // ── The live PDF, 300 ms after the last change; PdfPages draws it (the old pages stay until the new ones are drawn) ──
  const [previewBytes, setPreviewBytes] = useState<Uint8Array | null>(null);
  useEffect(() => {
    if (!statement) return;
    const timer = window.setTimeout(() => setPreviewBytes(statementPdf(statement)), STATEMENT_LIMITS.PREVIEW_DELAY_MS);
    return () => window.clearTimeout(timer);
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
      "A finished statement is never edited; a mistake in it is corrected with a replacing statement, or the statement is deleted.",
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

  // ── Delete (Kian's ruling of 2026-10-02): the confirmation names what is lost; the server does the rest ──
  const [deleting, setDeleting] = useState(false);
  const remove = async () => {
    if (!finishedReport || deleting || finishing) return;
    const seen = downloads.filter((d) => d.reportId === finishedReport.id).map((d) => d.at).sort();
    const replaced = finishedReport.supersedes ? reports.find((r) => r.id === finishedReport.supersedes!.reportId) : undefined;
    const question = [
      `Delete ${displayRef(finishedReport)}, ${props.propertyName}, ${monthLabel(month)}?`,
      seen.length === 0
        ? "This statement was never downloaded."
        : `This statement was downloaded ${seen.length === 1 ? dayWords(seen[0], today) : `${seen.length} times, last ${dayWords(seen[seen.length - 1], today)}`}. Deleting it removes the record of what was sent.`,
      replaced ? `${displayRef(replaced)}, which it replaced, becomes the month's statement again; the draft continues the correction.` : null,
      "Its PDF is deleted too. The month reopens as a draft holding everything the statement had.",
    ]
      .filter(Boolean)
      .join("\n");
    if (!window.confirm(question)) return;
    clear();
    setDeleting(true);
    const result = await deleteStatement(finishedReport.id, seen.length);
    setDeleting(false);
    if (!result.ok) {
      if (result.code === "DOWNLOADED_SINCE" || result.code === "DRAFT_CHANGED" || result.code === "REPORT_NOT_FOUND" || result.code === "CORRECTION_IN_PROGRESS" || result.code === "REPORT_REPLACED") {
        show({ tone: "warning", title: result.title, detail: `${result.detail ?? ""} The page reloads what is stored.` });
        onReload();
        return;
      }
      show(result.unknown ? { tone: "warning", title: "The statement may or may not have been deleted. Reload to see what is on record.", detail: result.title } : { tone: "error", title: result.title, detail: result.detail });
      return;
    }
    const { deleted } = result.data;
    show({
      tone: deleted.pdf === "left" ? "warning" : "success",
      title: replaced
        ? `Deleted ${displayRef(finishedReport)}. ${displayRef(replaced)} is ${monthLabel(month)}'s statement again; the correction continues as a draft.`
        : `Deleted ${displayRef(finishedReport)}. ${monthLabel(month)} is a draft again.`,
      detail: [
        deleted.pdf === "left" ? "Its PDF could not be deleted from storage and is left there, unlisted." : null,
        result.data.management ? "Report For is set back to what the statement printed." : null,
      ]
        .filter(Boolean)
        .join(" ") || undefined,
    });
    props.onStatementDeleted(result.data);
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
    <div className={styles.work}>
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
              onEntryDeleted={props.onEntryDeleted}
              onEntryAdded={props.onEntryAdded}
              onExportRecorded={props.onExportRecorded}
              show={show}
            />
          )}
          {tab === "income" && <IncomeTab typed={typed} readOnly={readOnly} sums={sums} onChange={change} show={show} files={files} />}
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
              deleting={deleting}
              onDelete={remove}
              linking={linking}
              onDownload={download}
              verified={verified}
              downloadsOf={downloadsOf}
              releases={props.releases}
              onMonth={props.onMonth}
            />
          )}
        </div>
      </div>

      {/* ── The preview, alive on every tab ── */}
      <div className={styles.side}>
        <div className={styles.preview} aria-label="The statement as a PDF">
          <PdfPages bytes={statement ? previewBytes : null} label={`${monthLabel(month)} statement`} />
          {!statement && <div className={styles.previewEmpty}>{built.kind === "unreadable" ? "No statement until every approved entry can be added up." : "No statement to show."}</div>}
        </div>
      </div>
    </div>
  );
}
