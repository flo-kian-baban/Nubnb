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
 * ── One calculation (dispatch 37A) ──
 * Every figure the page shows for the month — the preview, the tabs' heads,
 * the revenue beside the fee's base, Finish, the Costs tab's lines and where
 * each is charged — is the month's money's (app/lib/money/month.ts; Kian's
 * ruling of 2026-10-13: no page computes its own). The page works out each
 * entry's statements once for the property, and which lines came from an
 * accepted Airbnb line from the property's lines (Kian's ruling M1).
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
import { AlertTriangle, ChevronLeft, ChevronRight, Pencil, RefreshCw } from "lucide-react";
import { AdminHeader } from "../components/AdminHeader";
import { AdminSelect } from "../components/AdminSelect";
import { PinGate } from "../components/PinGate";
import { NoticeBanner, useNotice, type Notice } from "../components/Notice";
import { ReportingStatusLine, StandingBadge } from "../components/StatementStatus";
import { fetchCosts } from "@/app/lib/costs-client";
import { deleteStatement, fetchPropertyStatements, fetchStatementLink, finishStatement, saveDraft, setReportFor as saveReportFor, type PropertyStatements, type StatementDeleted } from "@/app/lib/reports-client";
import { fetchPropertyIncome, type PropertyIncome } from "@/app/lib/income-client";
import { isCopied, platformLinesOf } from "@/app/lib/income/model";
import { printedPlatformLines, type PlatformLineInput } from "@/app/lib/reports/statement";
import { fetchDirect } from "@/app/lib/direct-client";
import { directLinesOf } from "@/app/lib/direct/model";
import { unpaidInMonth } from "@/app/lib/direct/periods";
import { DirectBlock, type DirectRead, type PrintedBy } from "./DirectBlock";
import { formatCents, type CostEntryView, type CostsView, type ReportExportView } from "@/app/lib/cleaners/model";
import { torontoDayOf } from "@/app/lib/costs/report";
import {
  STATEMENTS_FROM_DEFAULT,
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
import { STANDING_LABELS, laterReferences, moneyMonthsByProperty, previousStatement, propertyMonthState, propertyMonths, reportingStatus, statementOf, type FinishClaim, type PropertyMonthRow } from "@/app/lib/reports/statement";
import { airbnbLineIdsOf, costCharges, frozenStatement, monthMoney, type Charge } from "@/app/lib/money/month";
import { statementPdf } from "@/app/lib/reports/statement-pdf";
import { checkoutsInMonth, finishChecks, uncoveredStays, type IncomeFacts } from "@/app/lib/reports/checks";
import type { PropertyStatementsState } from "../costs/EntryPane";
import { CostsTab } from "./CostsTab";
import { DetailsTab } from "./DetailsTab";
import { FinishTab, type ReleaseRow, type SaveState } from "./FinishTab";
import { IncomeTab } from "./IncomeTab";
import { PdfPages } from "./PdfPages";
import { Dialog, Tick } from "./editor/controls";
import { fromReport, fromStored, heldPartsOf, savablePayload, sha256Hex, suggestedTyped, toDraft, toPayload, type HeldParts, type ReportForDraft, type Typed } from "./statement-form";
import shared from "../page.module.css";
import styles from "./page.module.css";
import { internalLabel } from "@/app/lib/property-names";
import ed from "./editor/editor.module.css";

type Read<T> = { kind: "loading" } | { kind: "ready"; data: T } | { kind: "error"; title: string; detail?: string; status: number };
/** What GET /api/admin/properties/[id]/income answers (dispatch 27; 37C): the property's lines from the platforms' files, their files' names, the titles no link names (dispatch 34), its titles, and the month's calendar stays. */
type FromFiles = PropertyIncome;

/**
 * What was typed in a month, kept while the admin works in another (dispatch 34, S10): a half-typed fee, balance
 * or date is never saved, so leaving the month used to lose it. `revision` is the draft's after the last save
 * from that month; the typing comes back only while the draft is still at it.
 */
interface KeptMonth {
  typed: Typed;
  revision: number;
}
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
  /** The property's direct arrangements and payments (part B, Kian's rulings of 2026-10-15): read beside the lines from the files. */
  const [direct, setDirect] = useState<DirectRead>({ kind: "loading" });
  const [directAttempt, setDirectAttempt] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const { notice, show, clear } = useNotice();
  /** Each month's typing, kept while another month is open (dispatch 34, S10); keyed by property and month. */
  const [keptMonths] = useState(() => new Map<string, KeptMonth>());

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

  // ── The lines from the files, with the month's calendar stays (dispatch 37C): read again on each month and after a change ──
  const [filesAttempt, setFilesAttempt] = useState(0);
  useEffect(() => {
    if (!valid) return;
    let cancelled = false;
    fetchPropertyIncome(propertyId, month).then((result) => {
      if (cancelled) return;
      setFromFiles(result.ok ? { kind: "ready", data: result.data } : { kind: "error", title: result.title, detail: result.detail, status: result.status });
    });
    return () => {
      cancelled = true;
    };
  }, [propertyId, valid, attempt, month, filesAttempt]);
  /** Read the lines from the files again, keeping what is shown until the answer comes (after an edit or a line sent back). */
  const rereadFiles = useCallback(() => setFilesAttempt((n) => n + 1), []);

  // ── The direct payments (part B): read again after each change, keeping what is shown until the answer comes ──
  useEffect(() => {
    if (!valid) return;
    let cancelled = false;
    fetchDirect(propertyId).then((result) => {
      if (cancelled) return;
      setDirect(result.ok ? { kind: "ready", data: result.data } : { kind: "error", title: result.title });
    });
    return () => {
      cancelled = true;
    };
  }, [propertyId, valid, attempt, directAttempt]);
  const rereadDirect = useCallback(() => setDirectAttempt((n) => n + 1), []);

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
    setDirect({ kind: "loading" });
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
  /** Every statement that charges each of the property's entries (dispatch 37A): one working-out for every month. */
  const charges = useMemo(() => (data && costData ? costCharges({ propertyId, entries: costData.entries, reports: data.reports, management: data.management }) : null), [data, costData, propertyId]);
  /** The statement lines that came from an accepted Airbnb line copied into a draft before dispatch 37C (Kian's ruling M1: a claw-back takes revenue off). */
  const airbnbLineIds = useMemo(() => airbnbLineIdsOf(fromFiles.kind === "ready" ? fromFiles.data.lines : []), [fromFiles]);
  /** The accepted lines read where they are stored (dispatch 37C, Kian's ruling M10), and the recorded direct payments (part B): the statements place them. */
  const platformLines = useMemo(() => [...platformLinesOf(fromFiles.kind === "ready" ? fromFiles.data.lines : []), ...directLinesOf(direct.kind === "ready" ? direct.data.payments.filter((p) => p.propertyId === propertyId) : [])], [fromFiles, direct, propertyId]);
  /** Which current finished statement prints each direct payment, and whether it is being corrected: a printed payment is locked (Kian's ruling). */
  const printedDirect = useMemo<PrintedBy>(() => {
    const out: PrintedBy = new Map();
    if (!data) return out;
    const current = currentReports(data.reports);
    for (const [lineId, at] of printedPlatformLines(current)) {
      const report = current.find((r) => r.id === at.reportId);
      out.set(lineId, { reference: report ? displayRef(report) : at.reportId, month: at.month, correcting: data.drafts.some((d) => d.finishedAs === null && d.supersedes?.reportId === at.reportId) });
    }
    return out;
  }, [data]);

  // ── The months ──
  /** The months this property has accepted income or approved costs in: owed whenever it was added (Kian's ruling of 2026-10-04). */
  const moneyMonths = useMemo(() => (data ? (moneyMonthsByProperty(data.drafts, costData?.entries ?? [], platformLines).get(propertyId) ?? []) : []), [data, costData, propertyId, platformLines]);
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

  // The address heads the page (Kian's rulings of 2026-10-15, evening): the cleaner-facing name, else the public title, which shows under it.
  const propertyName = data?.propertyName ?? internalLabel(costData?.properties?.find((p) => p.id === propertyId)) ?? null;
  const publicName = data?.publicName ?? null;

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
  /** The status line's figures, once everything it reads is in: the head shows it then. */
  const ready = !failed && !loading && data && costData && months && monthNow && status && charges ? { status } : null;

  return (
    <div className={shared.container}>
      <AdminHeader current="properties" title={propertyName ?? "Property"} />

      <main className={shared.main}>
        {/* ── The head: the property, what is due for it (dispatch 23G), and the page's own buttons (Kian's ruling of
            2026-10-15: none in the navigation), in every state, as they were in the header ── */}
        <div className={styles.head}>
          <div className={styles.titleBlock}>
            <h2 className={styles.title}>{propertyName ?? "Property"}</h2>
            {publicName !== null && publicName !== propertyName && <p className={styles.publicTitle} title="Its public title, on the site and on Airbnb">{publicName}</p>}
          </div>
          {ready && <ReportingStatusLine status={ready.status} current={month} onMonth={setMonth} />}
          <div className={styles.headActions}>
            <button type="button" className={shared.btnGhost} onClick={reload} disabled={loading}>
              <RefreshCw size={15} aria-hidden />
              <span>Refresh</span>
            </button>
            {/* The property's edit page (dispatch 30): its listing, photos and internal fields. */}
            <Link href={`/admin/property/edit?id=${encodeURIComponent(propertyId)}`} prefetch={false} className={shared.btnGhost} title="Edit the listing, its photos and its internal fields">
              <Pencil size={14} aria-hidden />
              <span>Edit property</span>
            </Link>
          </div>
        </div>

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
        ) : loading || !data || !costData || !months || !monthNow || !status || !charges ? (
          <div className={shared.loading}>
            <div className={shared.spinner} />
            <p>Loading the property…</p>
          </div>
        ) : (
          <>

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
                kept={keptMonths}
                charges={charges}
                airbnbLineIds={airbnbLineIds}
                platformLines={platformLines}
                onFilesChanged={rereadFiles}
                direct={direct}
                printedDirect={printedDirect}
                onDirectChanged={rereadDirect}
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
  /** Each month's typing, kept while another month is open (dispatch 34, S10). */
  kept: Map<string, KeptMonth>;
  /** Every statement that charges each of the property's entries (dispatch 37A). */
  charges: ReadonlyMap<string, Charge[]>;
  /** The statement lines that came from an accepted Airbnb line copied into a draft before dispatch 37C. */
  airbnbLineIds: ReadonlySet<string>;
  /** The property's accepted lines read where they are stored (dispatch 37C). */
  platformLines: PlatformLineInput[];
  /** An accepted line was edited or sent back on the Income tab: the lines are read again. */
  onFilesChanged: () => void;
  /** The property's direct arrangements and payments (part B). */
  direct: DirectRead;
  /** Which finished statement prints each direct payment: locked unless it is being corrected. */
  printedDirect: PrintedBy;
  /** A direct payment or arrangement changed: they are read again. */
  onDirectChanged: () => void;
}

/**
 * One month's work: what is typed for it, its saves, the statement as it
 * stands and the preview. Mounted fresh for each month (and after a reload),
 * so a month's typed state never bleeds into another's; a save still pending
 * when the admin moves on is sent as the component leaves.
 */
function MonthWork(props: MonthWorkProps) {
  const { propertyId, month, today, tab, entries, exports, reports, draft, management, downloads, show, clear, onReload, onDraftSaved, onReportFinished, onManagement, onDownloaded } = props;

  // ── The month's finished statement, if any (the month's money's rule) ──
  const finishedReport: MonthlyReportView | null = useMemo(() => frozenStatement(reports, month, draft), [reports, month, draft]);
  const readOnly = finishedReport !== null;
  const previous = useMemo(() => previousStatement(reports, month), [reports, month]);
  const versions = useMemo(() => propertyMonthState({ propertyId, month, today, inScope: true, reports, drafts: draft ? [{ propertyId, month, updatedAt: draft.updatedAt, finishedAs: draft.finishedAs, superseding: draft.supersedes !== null }] : [] }).reports, [propertyId, month, today, reports, draft]);

  // ── What is typed ──
  // A month left with typing that was not all saved (a half-typed fee, balance or date) comes back as it was typed,
  // while its draft is still at the revision that typing was saved against (dispatch 34, S10).
  const keptKey = `${propertyId}:${month}`;
  const restored = useMemo(() => {
    if (finishedReport) return null;
    const kept = props.kept.get(keptKey);
    return kept && kept.revision === (draft?.revision ?? 0) ? kept.typed : null;
    // Read once, as the month opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [typed, setTyped] = useState<Typed>(() => (finishedReport ? fromReport(finishedReport, today) : (restored ?? (draft ? fromStored(draft, today) : suggestedTyped(previous, management, month, today)))));
  const [reportFor, setReportFor] = useState<ReportForDraft>(() => ({ name: management?.reportFor?.name ?? "", address: management?.reportFor?.address ?? "" }));
  const [reportForState, setReportForState] = useState<"saved" | "saving" | "unsaved" | "failed">("saved");
  /** What the server holds in place of each part that can be half-typed: a save sends these for a part that does not read. */
  const heldRef = useRef<HeldParts>(draft && !finishedReport ? heldPartsOf(toPayload(propertyId, month, draft.revision, fromStored(draft, today), draft.supersedes)) : { fee: null, carried: null, reportDate: today });
  const [save, setSave] = useState<SaveState>(() => {
    if (!draft || finishedReport) return { kind: "none" };
    const heldBack = restored ? savablePayload(propertyId, month, draft.revision, restored, draft.supersedes, heldRef.current).heldBack : [];
    return { kind: "saved", at: draft.updatedAt, heldBack };
  });
  const [finishing, setFinishing] = useState(false);
  const [linking, setLinking] = useState<string | null>(null);
  const [verified, setVerified] = useState<{ ok: boolean; stored: string; computed: string } | null>(null);
  const savedRef = useRef<string>(JSON.stringify(restored ?? (draft && !finishedReport ? fromStored(draft, today) : null)));
  const typedRef = useRef(typed);
  typedRef.current = typed;
  const revisionRef = useRef(draft?.revision ?? 0);
  const supersedesRef = useRef<{ reportId: string; reason: string } | null>(draft && !finishedReport ? draft.supersedes : null);
  /** The last payload the server took, its revision aside: a save that would send the same again writes nothing. */
  const sentRef = useRef<string | null>(draft && !finishedReport ? JSON.stringify({ ...toPayload(propertyId, month, 0, fromStored(draft, today), draft.supersedes), revision: 0 }) : null);
  /** When the draft was last saved, for the state line after a change that wrote nothing. */
  const savedAtRef = useRef<string | null>(draft && !finishedReport ? draft.updatedAt : null);
  const saveTimer = useRef<number | null>(null);
  const reportForSavedRef = useRef<string>(JSON.stringify({ name: management?.reportFor?.name ?? "", address: management?.reportFor?.address ?? "" }));
  const reportForRef = useRef(reportFor);
  reportForRef.current = reportFor;
  const reportForTimer = useRef<number | null>(null);
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const supersedes = supersedesRef.current;

  // ── The statement as it stands ──
  const parsed = useMemo(() => toDraft(typed), [typed]);
  const shownReportFor: ReportFor | null = reportFor.name.trim() === "" ? null : { name: reportFor.name.trim(), address: reportFor.address };
  /** The month's money (dispatch 37A): the statement as it stands or as finished, its figures, and its costs. */
  const money = useMemo(() => {
    // A record not saved yet starts its statements where every property's do (dispatch 34, S18: it read "2026-10" and left September's costs out of the preview).
    const record = management ? { ...management, reportFor: shownReportFor } : shownReportFor ? { id: propertyId, schemaVersion: 0, propertyId, reportFor: shownReportFor, owners: [], statementsFrom: STATEMENTS_FROM_DEFAULT, statementsUntil: null, defaultFeeRateBasisPoints: null, defaultFee: null, setAt: "" } : null;
    return monthMoney({
      propertyId,
      propertyName: props.propertyName,
      month,
      entries,
      reports,
      // A finished month reads as stored; any other, as typed.
      draft: finishedReport ? draft : { reference: typed.reference.trim(), reportDate: typed.reportDate, lines: parsed.lines, fee: parsed.fee, carried: parsed.carried, notes: typed.notes.trim() || null, supersedes, finishedAs: null },
      management: record,
      airbnbLineIds: props.airbnbLineIds,
      charges: props.charges,
      platformLines: props.platformLines,
    });
    // shownReportFor is derived from reportFor; comparing the object would redraw on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propertyId, props.propertyName, month, entries, reports, parsed, typed.reference, typed.reportDate, typed.notes, supersedes, reportFor.name, reportFor.address, management, finishedReport, draft, props.airbnbLineIds, props.charges, props.platformLines]);
  /** The draft built as it stands; null while the month is finished and not being corrected. */
  const built = money.build;
  const statement = money.statement;
  /** The statement's lines read from the files, where they are stored (dispatch 37C): listed on the Income tab apart from the typed ones. */
  const fileLines = useMemo(() => (statement && !statement.legacy ? statement.lines.filter((line) => line.platformLineId !== undefined && line.source !== "direct") : []), [statement]);
  /** The direct payments the statement prints (part B): listed in the Income tab's Direct block. */
  const directLines = useMemo(() => (statement && !statement.legacy ? statement.lines.filter((line) => line.platformLineId !== undefined && line.source === "direct") : []), [statement]);
  /** The month's expected direct payments not fully received: Finish warns (part B). null while they are not read. */
  const directUnpaid = useMemo(() => (props.direct.kind === "ready" ? unpaidInMonth(props.direct.data.arrangements.filter((a) => a.propertyId === propertyId), props.direct.data.payments, month, today) : null), [props.direct, propertyId, month, today]);
  /** The figures the tabs show: the statement on screen (the correction's while one is written); and, beside a correction, the statement as sent. */
  const figures = money.correction ?? money.figures;
  const sentFigures = money.correcting ? money.figures : null;

  /**
   * The lines from the platforms' files (dispatch 27; 37C): the lines the statement reads where they are stored,
   * each with its stored line, its file and row; the copies of lines accepted before 37C, marked on the draft's
   * lines; how many of the month's lines wait on the Income page; and the month's calendar copies and the stays on
   * them no line covers (I8, I15). Read from the same earnings lines the Income page reads.
   */
  const files = useMemo(() => {
    const read = props.fromFiles;
    if (read.kind !== "ready") return { marks: new Map<string, string>(), pending: 0, failed: read.kind === "error", month, stored: new Map(), names: new Map<string, string>(), calendar: null };
    const names = new Map(read.data.uploads.map((u) => [u.id, u.name]));
    const marks = new Map<string, string>();
    for (const line of read.data.lines) {
      if (isCopied(line.decided) && line.decided.propertyId === propertyId) marks.set(line.decided.lineId, `${names.get(line.uploadId) ?? "a file"} · row ${line.fileRow}`);
    }
    const calendar = read.data.calendar && read.data.calendar.month === month ? { days: read.data.calendar.days, uncovered: uncoveredStays(read.data.calendar.stays, read.data.lines, month) } : null;
    return { marks, pending: read.data.lines.filter((line) => line.status === "proposed" && line.month === month).length, failed: false, month, stored: new Map(read.data.lines.map((line) => [line.id, line])), names, calendar };
  }, [props.fromFiles, propertyId, month]);

  /** What the files say about the month, for Finish's checks (dispatch 34; 37C): lines waiting, titles linked to no property, checkouts, the calendar's stays no line covers. */
  const incomeFacts = useMemo<IncomeFacts | null>(() => {
    const read = props.fromFiles;
    if (read.kind !== "ready") return null;
    return {
      waiting: files.pending,
      unlinked: read.data.unlinked.filter((title) => title.month === month),
      checkouts: checkoutsInMonth(read.data.lines, month),
      // Read only when the month's calendar copies exist: no copies is no check, never an all-clear (I8).
      ...(files.calendar && files.calendar.days.length > 0 ? { uncovered: files.calendar.uncovered } : {}),
    };
  }, [props.fromFiles, files.pending, files.calendar, month]);

  /** What Finish checks (dispatch 34, Kian's rulings of 2026-10-12): refused only without a Report For name; everything else warns. */
  const checks = useMemo(() => (built?.kind === "ok" && !readOnly ? finishChecks({ statement: built.statement, reports, entries, income: incomeFacts, today, revenueCents: figures?.revenueCents, ...(directUnpaid ? { direct: directUnpaid } : {}) }) : null), [built, readOnly, reports, entries, incomeFacts, today, figures, directUnpaid]);
  /** The later statements that adjusted or carried from the month's finished one: the Delete and Correct dialogs name them (Kian's ruling of 2026-10-12). */
  const later = useMemo(() => (finishedReport ? laterReferences(finishedReport, reports) : []), [finishedReport, reports]);
  const laterWords = later.map(({ report, adjusted, carried }) => `${displayRef(report)} (${monthLabel(report.month)}) ${[adjusted ? "adjusted its costs" : null, carried ? "carried its balance" : null].filter(Boolean).join(" and ")}`);

  // ── Save, 800 ms after the last change; the first save on a month with nothing stored creates the draft ──
  // What reads is saved; a fee, balance or date that does not read yet is sent as last saved and stays typed here (S10).
  // `force` writes even what is only suggested, for Finish on a month with nothing stored (dispatch 36, S22). Answers
  // whether the draft is stored.
  const doSave = useCallback(async (force = false): Promise<boolean> => {
    const current = typedRef.current;
    const key = JSON.stringify(current);
    if (key === savedRef.current && !(force && revisionRef.current === 0)) return revisionRef.current !== 0;
    const { payload, heldBack } = savablePayload(propertyId, month, revisionRef.current, current, supersedesRef.current, heldRef.current);
    const sent = JSON.stringify({ ...payload, revision: 0 });
    const empty = payload.lines.length === 0 && payload.fee === null && payload.carried === null && payload.notes === null && payload.reference === "" && payload.supersedes === null;
    // Nothing that reads has changed, or nothing is stored and nothing that reads is typed: no write, only the state.
    if (!(force && revisionRef.current === 0) && (sent === sentRef.current || (revisionRef.current === 0 && empty))) {
      savedRef.current = key;
      setSave(revisionRef.current === 0 || savedAtRef.current === null ? { kind: "none", heldBack } : { kind: "saved", at: savedAtRef.current, heldBack });
      return revisionRef.current !== 0;
    }
    setSave({ kind: "saving" });
    const result = await saveDraft(payload);
    if (result.ok) {
      savedRef.current = key;
      sentRef.current = sent;
      heldRef.current = heldPartsOf(payload);
      revisionRef.current = result.data.draft.revision;
      savedAtRef.current = result.data.draft.updatedAt;
      // A save sent as the admin left the month: the typing kept for it is now saved against this revision.
      const kept = props.kept.get(keptKey);
      if (kept) kept.revision = result.data.draft.revision;
      setSave({ kind: "saved", at: result.data.draft.updatedAt, heldBack });
      onDraftSaved(result.data.draft);
      return true;
    }
    if (result.code === "DRAFT_CHANGED" || result.code === "DRAFT_FINISHED") {
      show({ tone: "warning", title: result.code === "DRAFT_CHANGED" ? "This month's draft was changed elsewhere — another tab or another admin." : "This month's statement was finished meanwhile.", detail: "Your last change was not saved. The page reloads what is stored." });
      onReload();
      return false;
    }
    setSave({ kind: "failed", reason: `${result.title}${result.detail ? ` ${result.detail}` : ""}${result.status === 401 || result.status === 403 ? ` ${SESSION_HINT}` : ""}` });
    return false;
  }, [propertyId, month, show, onReload, onDraftSaved, props.kept, keptKey]);
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

  /** Send a save still waiting on its timer: the draft's and Report For's. */
  const flushPending = () => {
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
  };

  // The month's typing is kept for when the admin comes back to it (dispatch 34, S10): what was half-typed is not
  // saved, and would otherwise be lost. Opening the month takes it back out. A save still pending when the admin
  // moves to another month (or the page reloads its data) is sent now, not lost.
  useEffect(
    () => {
      props.kept.delete(keptKey);
      return () => {
        if (!readOnlyRef.current) props.kept.set(keptKey, { typed: typedRef.current, revision: revisionRef.current });
        flushPending();
      };
    },
    // Once per month opened: the month is the component's key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // ── The live PDF, 300 ms after the last change; PdfPages draws it (the old pages stay until the new ones are drawn) ──
  const [previewBytes, setPreviewBytes] = useState<Uint8Array | null>(null);
  useEffect(() => {
    if (!statement) return;
    const timer = window.setTimeout(() => setPreviewBytes(statementPdf(statement)), STATEMENT_LIMITS.PREVIEW_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [statement]);

  // ── The three questions, asked in Nubnb's own dialogs (Kian's ruling of 2026-10-12, dispatch 34) ──
  const [asking, setAsking] = useState<"finish" | "correct" | "delete" | null>(null);
  /** The one extra confirmation Finish asks for while any check warns. */
  const [acknowledged, setAcknowledged] = useState(false);
  const [reason, setReason] = useState("");

  // ── Finish ──
  /** The Finish button: what cannot be finished is said; otherwise the dialog asks, listing what Finish warns about. */
  const finish = async () => {
    if (built?.kind !== "ok" || finishing || readOnly) return;
    clear();
    const problems = [...parsed.problems, ...(typed.reference.trim() === "" ? ["Give the statement a reference, like Aug-321-John"] : []), ...(isDayText(typed.reportDate) ? [] : ["Give the statement a date"])];
    if (problems.length > 0) {
      show({ tone: "error", title: "The statement cannot be finished as it stands.", items: problems });
      return;
    }
    // Refused only without a Report For name (Kian's ruling of 2026-10-12); the server refuses it too.
    if (checks && checks.refusals.length > 0) {
      show({ tone: "error", title: "The statement cannot be finished.", items: checks.refusals.map((check) => check.text) });
      return;
    }
    // A month with nothing stored is finished straight away (dispatch 36, S22): what the page shows, its suggested
    // reference included, is saved first. An empty month needs no note on the owner's PDF (Kian's ruling of 2026-10-12).
    if (save.kind === "none" && revisionRef.current === 0 && reportForState === "saved") {
      const stored = await doSaveRef.current(true);
      if (!stored) {
        show({ tone: "error", title: "The draft could not be saved, so the statement was not finished." });
        return;
      }
    } else if (save.kind !== "saved" || revisionRef.current === 0 || reportForState !== "saved") {
      show({ tone: "warning", title: "Wait for the draft to save first.", detail: save.kind === "failed" ? save.reason : undefined });
      return;
    }
    setAcknowledged(false);
    setAsking("finish");
  };

  /** Finish and issue, once the dialog is answered. */
  const finishConfirmed = async () => {
    if (built?.kind !== "ok" || finishing || readOnly) return;
    setAsking(null);
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
  const correct = () => {
    if (!finishedReport || finishing) return;
    clear();
    setReason("");
    setAsking("correct");
  };

  /** Start the correction, once a reason is given: printed in full on the corrected statement (S12). */
  const correctConfirmed = async () => {
    if (!finishedReport || finishing) return;
    const why = reason.trim();
    if (why === "" || why.length > STATEMENT_LIMITS.REASON_MAX) return;
    setAsking(null);
    const next = fromReport(finishedReport, today);
    if (next.reference === "") next.reference = suggestedTyped(previous, management, month, today).reference;
    next.reportDate = today;
    const sup = { reportId: finishedReport.id, reason: why };
    setSave({ kind: "saving" });
    const payload = toPayload(propertyId, month, revisionRef.current, next, sup);
    const result = await saveDraft(payload);
    if (!result.ok) {
      setSave({ kind: "failed", reason: result.title });
      show({ tone: "error", title: result.title, detail: result.detail });
      return;
    }
    setTyped(next);
    savedRef.current = JSON.stringify(next);
    sentRef.current = JSON.stringify({ ...payload, revision: 0 });
    heldRef.current = heldPartsOf(payload);
    supersedesRef.current = sup;
    revisionRef.current = result.data.draft.revision;
    savedAtRef.current = result.data.draft.updatedAt;
    setVerified(null);
    setSave({ kind: "saved", at: result.data.draft.updatedAt, heldBack: [] });
    onDraftSaved(result.data.draft);
    show({ tone: "info", title: "Correcting the statement.", detail: "The lines, fee, balance and notes are copied from the finished statement; the recorded costs are read fresh. Finish it to replace the old one." });
  };

  // ── Delete (Kian's ruling of 2026-10-02): the confirmation names what is lost; the server does the rest ──
  const [deleting, setDeleting] = useState(false);
  /** The finished statement's download records, as the dialog names them and the server checks. */
  const seenDownloads = finishedReport ? downloads.filter((d) => d.reportId === finishedReport.id).map((d) => d.at).sort() : [];
  const replacedByThis = finishedReport?.supersedes ? reports.find((r) => r.id === finishedReport.supersedes!.reportId) : undefined;
  const remove = () => {
    if (!finishedReport || deleting || finishing) return;
    clear();
    setAsking("delete");
  };
  const removeConfirmed = async () => {
    if (!finishedReport || deleting || finishing) return;
    setAsking(null);
    setDeleting(true);
    const replaced = replacedByThis;
    const result = await deleteStatement(finishedReport.id, seenDownloads.length);
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
  /** The Costs tab's count: the month's approved costs, as its head counts them (T8). */
  const approvedInMonth = money.costTotals.count;

  return (
    <div className={styles.work}>
      <div className={styles.left}>
        {/* ── The tabs ── */}
        <div className={styles.tabs} role="tablist" aria-label="Property">
          {TABS.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={`${styles.tab} ${tab === t.key ? styles.tabActive : ""}`} onClick={() => props.onTab(t.key)}>
              {t.label}
              {t.key === "costs" && approvedInMonth !== null && approvedInMonth > 0 && <span className={styles.tabCount}>{approvedInMonth}</span>}
              {t.key === "income" && typed.lines.length + fileLines.length + directLines.length > 0 && <span className={styles.tabCount}>{typed.lines.length + fileLines.length + directLines.length}</span>}
            </button>
          ))}
        </div>

        {built?.kind === "unreadable" && (
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
              money={money}
              charges={props.charges}
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
          {tab === "income" && <IncomeTab typed={typed} readOnly={readOnly} figures={figures} sent={sentFigures} onChange={change} show={show} files={files} fileLines={fileLines} onFilesChanged={props.onFilesChanged} />}
          {tab === "income" && <DirectBlock propertyId={propertyId} month={month} today={today} read={props.direct} lines={directLines} printed={props.printedDirect} onChanged={props.onDirectChanged} show={show} />}
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
              carriedCents={finishedReport ? (finishedReport.legacy ? null : finishedReport.carried ? finishedReport.carriedCents : null) : built?.kind === "ok" && built.statement.carried ? built.statement.carried.amountCents : (parsed.carried?.amountCents ?? null)}
              reports={reports}
              month={month}
              carriedAdjustments={statement && !statement.legacy ? statement.carriedAdjustments : []}
              revenue={figures}
              heldBack={save.kind === "saved" || save.kind === "none" ? (save.heldBack ?? []) : []}
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
              payableCents={figures ? figures.payableCents : null}
              buildable={built?.kind === "ok"}
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
              checks={checks}
              onTab={props.onTab}
              today={today}
            />
          )}
        </div>
      </div>

      {/* ── The preview, alive on every tab ── */}
      <div className={styles.side}>
        <div className={styles.preview} aria-label="The statement as a PDF">
          <PdfPages bytes={statement ? previewBytes : null} label={`${monthLabel(month)} statement`} />
          {!statement && <div className={styles.previewEmpty}>{built?.kind === "unreadable" ? "No statement until every approved entry can be added up." : "No statement to show."}</div>}
        </div>
      </div>

      {/* ── Finish: what it warns about, and the one extra confirmation while anything does ── */}
      {asking === "finish" && built?.kind === "ok" && checks && (
        <Dialog
          title={`Finish and issue # ${typed.reference.trim()}?`}
          onClose={() => setAsking(null)}
          actions={
            <>
              <button type="button" className={`${ed.btn} ${ed.btnGhost}`} onClick={() => setAsking(null)}>
                Go back
              </button>
              <button type="button" className={`${ed.btn} ${ed.btnPrimary}`} disabled={checks.warnings.length > 0 && !acknowledged} onClick={() => void finishConfirmed()}>
                Finish and issue
              </button>
            </>
          }
        >
          <p>
            {props.propertyName}, {monthLabel(month)} · Your Revenue Share <b>{formatCents(built.statement.payableCents)}</b>
          </p>
          {checks.warnings.length > 0 && (
            <>
              <ul className={styles.dialogChecks}>
                {checks.warnings.map((check) => (
                  <li key={check.key}>{check.text}</li>
                ))}
              </ul>
              <label className={styles.dialogAck}>
                <Tick checked={acknowledged} onChange={() => setAcknowledged((was) => !was)} label={checks.warnings.length === 1 ? "Finish with this warning" : `Finish with these ${checks.warnings.length} warnings`} />
                <span>{checks.warnings.length === 1 ? "Finish with this warning" : `Finish with these ${checks.warnings.length} warnings`}</span>
              </label>
            </>
          )}
          <p>A finished statement is never edited: it is corrected or deleted.</p>
        </Dialog>
      )}

      {/* ── Correct: the reason the owner reads, in full ── */}
      {asking === "correct" && finishedReport && (
        <Dialog
          title={`Correct ${displayRef(finishedReport)}?`}
          onClose={() => setAsking(null)}
          initialFocus="none"
          actions={
            <>
              <button type="button" className={`${ed.btn} ${ed.btnGhost}`} onClick={() => setAsking(null)}>
                Cancel
              </button>
              <button type="button" className={`${ed.btn} ${ed.btnPrimary}`} disabled={reason.trim() === ""} onClick={() => void correctConfirmed()}>
                Start the correction
              </button>
            </>
          }
        >
          <p>It stays on record, marked replaced; a corrected statement is made beside it.</p>
          {laterWords.length > 0 && (
            <p>
              Later statements: {laterWords.join("; ")}. The correction prints only what is left after their adjustments{later.some((row) => row.carried) ? ", and the next open statement settles any change to the balance they carried" : ""}.
            </p>
          )}
          <label className={styles.fieldLabel} htmlFor="correct-reason">
            Why is it corrected? The owner reads this in full.
          </label>
          <textarea id="correct-reason" className={`${styles.textInput} ${styles.reasonInput}`} value={reason} maxLength={STATEMENT_LIMITS.REASON_MAX} rows={4} autoFocus onChange={(e) => setReason(e.target.value)} />
          <span className={styles.note}>
            {reason.length}/{STATEMENT_LIMITS.REASON_MAX}
          </span>
        </Dialog>
      )}

      {/* ── Delete: what is lost, in the ruled words ── */}
      {asking === "delete" && finishedReport && (
        <Dialog
          title={`Delete ${displayRef(finishedReport)}?`}
          onClose={() => setAsking(null)}
          actions={
            <>
              <button type="button" className={`${ed.btn} ${ed.btnGhost}`} onClick={() => setAsking(null)}>
                Keep it
              </button>
              <button type="button" className={`${ed.btn} ${ed.btnGhost} ${ed.btnDanger}`} onClick={() => void removeConfirmed()}>
                Delete statement
              </button>
            </>
          }
        >
          <p>
            {props.propertyName}, {monthLabel(month)}.
          </p>
          <p>
            {seenDownloads.length === 0
              ? "This statement was never downloaded."
              : `This statement was downloaded ${seenDownloads.length === 1 ? dayWords(seenDownloads[0], today) : `${seenDownloads.length} times, last ${dayWords(seenDownloads[seenDownloads.length - 1], today)}`}. Deleting it removes the record of what was sent.`}
          </p>
          {replacedByThis && <p>{displayRef(replacedByThis)}, which it replaced, becomes the month&apos;s statement again; the draft continues the correction.</p>}
          {laterWords.length > 0 && (
            <p>
              Later statements: {laterWords.join("; ")}. They stay as they are. Finished again, this month prints only what is left after their adjustments{later.some((row) => row.carried) ? "; the next open statement settles any change to the balance they carried" : ""}.
            </p>
          )}
          <p>Its PDF is deleted too. The month reopens as a draft holding everything the statement had.</p>
        </Dialog>
      )}
    </div>
  );
}
