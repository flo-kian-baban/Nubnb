"use client";

/**
 * Costs: what cleaners spent, receipt by receipt, per house — and its review
 * and reports.
 *
 * One read on opening, GET /api/admin/cost-entries (the whole collection:
 * nothing can silently drop out), and everything else — filters, totals, the
 * items bought for a house, the Excel and PDF reports — is worked out here
 * from that one answer, so it costs no further function call. A review is one
 * call; opening a receipt is one call for its 60-second link; a PDF is one
 * call, to record it.
 *
 * ── The queue and the ledgers (dispatch 21) ──
 * The page opens as the review queue: everything not yet approved — pending,
 * rejected, removed — over all time, so nothing awaiting a decision is
 * hidden on arrival. Approving an entry takes it out of the queue and into
 * its property's ledger: the same page with the property chosen and the
 * status set to approved, which the admin property list links to. Rejected
 * and removed entries never reach a ledger; they stay in the queue, marked.
 * Queue and ledger read the same entries from the same one call.
 *
 * A ledger opens for any property, whether or not it has an entry yet: the
 * answer carries every property's name, so the page names the property and
 * shows its date range and both exports at once.
 *
 * ── After approval (Kian's ruling of 2026-09-30) ──
 * An approved entry stays correctable and removable, from its ledger as from
 * anywhere: the entry pane is the same. Removing it takes it out of the
 * ledger, its totals and its exports, and it stays in the queue, marked.
 *
 * An approved entry may already be in a PDF a co-owner holds. So a PDF is
 * recorded before it is downloaded, and the page sets every recorded PDF
 * beside the ledger as it now stands: a list of the property's PDFs saying
 * which still match, a mark on each entry that has changed since the newest
 * PDF covering its day, and the same in the entry pane.
 *
 * ── What counts ──
 * Approved and pending entries count in totals, shown apart; rejected and
 * removed ones stay in the table, marked, and count nowhere. An entry whose
 * lines cannot be read is counted apart and never added in. Amounts are the
 * lines as they now stand, corrections applied, plus the tax (linesNow).
 *
 * ── Dates ──
 * The day an entry was sent, in Toronto time; the app records no purchase
 * date.
 *
 * ── Reports ──
 * One property over the dates chosen, approved entries only: the PDF goes to
 * the property's co-owners, and pending entries have not been checked. The
 * page says so, and asks, when pending entries fall in the period. Both files
 * are made in the browser and never leave it except as the download. The PDF
 * is downloaded only once the server has recorded it, and carries the
 * record's time as its "Generated" time; the Excel file is the admins' own
 * and is not recorded.
 *
 * "Could not load" is never "nothing here": a failed read shows no table, no
 * totals and no export, so it can never produce an empty report.
 *
 * The filters, the view and the open entry are mirrored into the URL
 * (?property=, ?status=, ?from=, ?to=, ?view=, ?entry=), so a reload keeps them.
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  FileSpreadsheet,
  FileText,
  Home,
  ImageIcon,
  Pencil,
  Receipt,
  RefreshCw,
  Search,
} from "lucide-react";
import { PinGate } from "../components/PinGate";
import { NoticeBanner, useNotice } from "../components/Notice";
import { fetchCosts, recordPdfExport } from "@/app/lib/costs-client";
import {
  ENTRY_STATUSES,
  ENTRY_STATUS_LABELS,
  countsInTotals,
  formatCents,
  isEntryStatus,
  type CostEntryView,
  type PropertyNameView,
  type ReportExportView,
} from "@/app/lib/cleaners/model";
import {
  NEEDS_ATTENTION,
  RANGE_PRESETS,
  buildReport,
  cleanerLabel,
  comparePdf,
  countedItems,
  entryPdfState,
  entryRef,
  isDay,
  matchesFilters,
  periodLabel,
  presetRange,
  propertyLabel,
  readPdfRecords,
  reportFileName,
  shortDay,
  torontoDayOf,
  totalsByProperty,
  type CostFilters,
  type EntryPdfState,
  type PdfComparison,
  type Totals,
} from "@/app/lib/costs/report";
import { pdfFor } from "@/app/lib/costs/pdf";
import { workbookFor } from "@/app/lib/costs/xlsx";
import { Absent, FieldText } from "../leads/lead-display";
import { EntryStatusBadge, SentAt, quantityText, statusWord, whenText } from "./cost-display";
import { EntryPane } from "./EntryPane";
import shared from "../page.module.css";
import styles from "./page.module.css";

type ListState =
  | { kind: "loading" }
  | {
      kind: "ready";
      entries: CostEntryView[];
      /** Every recorded PDF. */
      exports: ReportExportView[];
      /** Every property's current name; null when they could not be read. */
      properties: PropertyNameView[] | null;
    }
  | { kind: "error"; title: string; detail?: string; status: number };

type View = "entries" | "items";

const SESSION_HINT = "Your admin session may have expired — reload and sign in again.";

export default function CostsPage() {
  return (
    <PinGate>
      {/* useSearchParams needs a boundary on a statically rendered page. */}
      <Suspense fallback={null}>
        <Costs />
      </Suspense>
    </PinGate>
  );
}

function Costs() {
  const params = useSearchParams();

  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [filters, setFilters] = useState<CostFilters>(() => {
    const day = (key: string) => {
      const value = params.get(key) ?? "";
      return isDay(value) ? value : "";
    };
    // The queue by default; "all" in the URL means every status.
    const status = params.get("status");
    return {
      propertyId: params.get("property") ?? "",
      status: isEntryStatus(status) ? status : status === "all" ? "" : NEEDS_ATTENTION,
      from: day("from"),
      to: day("to"),
    };
  });
  const [view, setView] = useState<View>(() => (params.get("view") === "items" ? "items" : "entries"));
  const [selectedId, setSelectedId] = useState<string | null>(() => params.get("entry"));
  const detailRef = useRef<HTMLElement>(null);
  const { notice, show, clear } = useNotice();
  /** True while a PDF is being recorded, before it is downloaded. */
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchCosts().then((result) => {
      if (cancelled) return;
      setList(
        result.ok
          ? { kind: "ready", ...result.data }
          : { kind: "error", title: result.title, detail: result.detail, status: result.status },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  // Mirror the filters, the view and the open entry into the address bar.
  useEffect(() => {
    const url = new URL(window.location.href);
    const set = (key: string, value: string | null) =>
      value === null || value === "" ? url.searchParams.delete(key) : url.searchParams.set(key, value);
    set("property", filters.propertyId);
    set("status", filters.status === "" ? "all" : filters.status === NEEDS_ATTENTION ? null : filters.status);
    set("from", filters.from);
    set("to", filters.to);
    set("view", view === "items" && filters.propertyId !== "" ? "items" : null);
    set("entry", selectedId);
    if (url.href !== window.location.href) window.history.replaceState(null, "", url.href);
  }, [filters, view, selectedId]);

  const reload = () => {
    clear();
    setList({ kind: "loading" });
    setAttempt((n) => n + 1);
  };

  const open = (id: string) => {
    setSelectedId(id);
    // On a narrow screen the pane sits below the list; bring it into view.
    requestAnimationFrame(() => detailRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  };

  const replaceEntry = useCallback((stored: CostEntryView) => {
    setList((prev) =>
      prev.kind === "ready"
        ? { ...prev, entries: prev.entries.map((entry) => (entry.id === stored.id ? stored : entry)) }
        : prev,
    );
  }, []);

  const closePane = useCallback(() => setSelectedId(null), []);

  const entries = useMemo(() => (list.kind === "ready" ? list.entries : []), [list]);
  const known = list.kind === "ready" ? list.properties : null;
  const visible = useMemo(() => entries.filter((entry) => matchesFilters(entry, filters)), [entries, filters]);
  const totals = useMemo(() => totalsByProperty(visible), [visible]);
  const items = useMemo(() => countedItems(visible), [visible]);
  /** What the counts beside each status are taken from: the chosen property's entries, or every entry. */
  const inScope = useMemo(
    () => (filters.propertyId === "" ? entries : entries.filter((entry) => entry.property.id === filters.propertyId)),
    [entries, filters.propertyId],
  );
  const statusCounts = useMemo(() => {
    const counts = new Map<string | null, number>();
    for (const entry of inScope) counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1);
    return counts;
  }, [inScope]);
  /**
   * Every property the page can name, A to Z: those that exist now, whether or
   * not they have an entry, and those only an entry still names. `withEntries`
   * says which have any entry, so the filter can list them first.
   */
  const properties = useMemo(() => {
    const byId = new Map<string, string>();
    for (const property of known ?? []) byId.set(property.id, property.name?.trim() || "Unnamed property");
    const withEntries = new Set<string>();
    for (const entry of entries) {
      if (entry.property.id === null) continue;
      withEntries.add(entry.property.id);
      if (!byId.has(entry.property.id)) byId.set(entry.property.id, propertyLabel(entry));
    }
    const sorted = [...byId.entries()].sort((a, b) => a[1].localeCompare(b[1], "en-CA"));
    return {
      names: byId,
      withEntries: sorted.filter(([id]) => withEntries.has(id)),
      withoutEntries: sorted.filter(([id]) => !withEntries.has(id)),
    };
  }, [entries, known]);

  /** The recorded PDFs that can be compared, newest first. */
  const pdfs = useMemo(() => readPdfRecords(list.kind === "ready" ? list.exports : []), [list]);
  /** Each entry that went out in a PDF, with how it stands beside the newest PDF for its day. */
  const pdfStates = useMemo(() => {
    const states = new Map<string, EntryPdfState>();
    if (pdfs.records.length === 0) return states;
    for (const entry of entries) {
      const state = entryPdfState(entry, pdfs.records);
      if (state) states.set(entry.id, state);
    }
    return states;
  }, [entries, pdfs]);

  const oneProperty = filters.propertyId !== "";
  /** One property's approved entries: its ledger (dispatch 21). */
  const ledger = oneProperty && filters.status === "approved";
  const showing: View = oneProperty ? view : "entries";
  /** The chosen property's name; null when no property on record, and no entry, has that ID. */
  const propertyName = oneProperty ? (properties.names.get(filters.propertyId) ?? null) : null;
  /** The chosen property's PDFs, newest first, each beside the ledger as it now stands. */
  const propertyPdfs = useMemo(
    () =>
      oneProperty
        ? pdfs.records.filter((record) => record.propertyId === filters.propertyId).map((record) => comparePdf(record, entries))
        : [],
    [oneProperty, filters.propertyId, pdfs, entries],
  );
  const waiting = oneProperty
    ? entries.filter((entry) => entry.property.id === filters.propertyId && entry.status === "pending").length
    : 0;
  const selected = selectedId === null ? null : (entries.find((entry) => entry.id === selectedId) ?? null);
  const today = torontoDayOf(new Date());
  const activePreset = RANGE_PRESETS.find((preset) => {
    const range = presetRange(preset.key, today);
    return range.from === filters.from && range.to === filters.to;
  })?.key;

  const setFilter = (change: Partial<CostFilters>) => setFilters((was) => ({ ...was, ...change }));

  const exportReport = async (kind: "pdf" | "xlsx") => {
    if (list.kind !== "ready" || !oneProperty || propertyName === null || recording) return;
    clear();
    const built = buildReport(list.entries, filters.propertyId, filters.from, filters.to, new Date(), propertyName);
    if (built.kind === "unreadable") {
      show({
        tone: "error",
        title: "This report cannot be made while an approved entry in it cannot be read.",
        detail: `Open ${built.entryIds.length === 1 ? "entry" : "entries"} ${built.entryIds.join(", ")} to see why. Nothing was downloaded.`,
      });
      return;
    }
    const { report, pendingLeftOut } = built;
    if (
      pendingLeftOut > 0 &&
      !window.confirm(
        `${pendingLeftOut === 1 ? "1 entry" : `${pendingLeftOut} entries`} in this period ${pendingLeftOut === 1 ? "is" : "are"} still pending review and ${pendingLeftOut === 1 ? "is" : "are"} not in the report, which holds approved entries only. Download it anyway?`,
      )
    ) {
      return;
    }

    // A PDF goes to co-owners, and an entry in it can still be corrected or
    // removed afterwards. So it is recorded first — which entries, and how long
    // each one's history was — and downloaded only once the record is stored.
    let printed = report;
    if (kind === "pdf") {
      const seen = new Map(list.entries.map((entry) => [entry.id, entry.history?.length ?? 0]));
      setRecording(true);
      const result = await recordPdfExport({
        propertyId: report.propertyId,
        from: report.from,
        to: report.to,
        entries: report.entries.map((entry) => ({ id: entry.id, seen: seen.get(entry.id) ?? 0 })),
      });
      setRecording(false);
      if (!result.ok) {
        show(
          result.unknown
            ? {
                tone: "warning",
                title: "The PDF was not downloaded. Its record may or may not have been made: Refresh to see what is on record.",
                detail: result.title,
              }
            : {
                tone: "error",
                title: `The PDF was not downloaded. ${result.title}`,
                detail: [result.detail, result.status === 401 || result.status === 403 ? SESSION_HINT : null]
                  .filter(Boolean)
                  .join(" "),
              },
        );
        return;
      }
      const record = result.data.export;
      setList((prev) => (prev.kind === "ready" ? { ...prev, exports: [record, ...prev.exports] } : prev));
      // The PDF says what the record says: the record's time, and the name it took for the property.
      printed = {
        ...report,
        generatedAt: new Date(record.createdAt ?? report.generatedAt),
        propertyName: record.propertyNameAtExport ?? report.propertyName,
      };
    }

    const bytes = kind === "pdf" ? pdfFor(printed) : workbookFor(printed);
    const type = kind === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = reportFileName(printed, kind);
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);

    show({
      tone: "success",
      title: `Downloaded the ${kind === "pdf" ? "PDF" : "Excel file"} for ${printed.propertyName}.`,
      detail: `${periodLabel(report.from, report.to)} · ${report.entries.length === 1 ? "1 approved entry" : `${report.entries.length} approved entries`} · ${formatCents(report.totalCents)}${pendingLeftOut > 0 ? ` · ${pendingLeftOut} pending left out` : ""}${kind === "pdf" ? " · recorded, so a later correction shows against it" : ""}`,
    });
  };

  return (
    <div className={shared.container}>
      {/* ── Header ── */}
      <header className={shared.header}>
        <div className={shared.headerInner}>
          <div className={shared.headerLeft}>
            <Link href="/" className={shared.backBtn}>
              <Home size={16} />
              <span>View Site</span>
            </Link>
            <div className={shared.headerDivider} />
            <Link href="/admin" className={shared.backBtn}>
              <ArrowLeft size={16} />
              <span>Properties</span>
            </Link>
            <div className={shared.headerDivider} />
            <h1>{ledger ? "Ledger" : "Costs"}</h1>
          </div>

          <div className={shared.headerRight}>
            <button type="button" className={styles.btnGhost} onClick={reload} disabled={list.kind === "loading"}>
              <RefreshCw size={15} />
              <span>Refresh</span>
            </button>
          </div>
        </div>
      </header>

      <main className={shared.main}>
        <NoticeBanner notice={notice} onDismiss={clear} className={shared.pageNotice} />

        {list.kind === "loading" ? (
          <div className={shared.loading}>
            <div className={shared.spinner} />
            <p>Loading cost entries…</p>
          </div>
        ) : list.kind === "error" ? (
          /* A failed read is NOT an empty list: no table, no totals, no report. */
          <div className={`${shared.empty} ${shared.loadError}`} role="alert">
            <AlertTriangle size={48} strokeWidth={1} />
            <h2>Could not load cost entries</h2>
            <p>
              It is not empty — it has not loaded.
              {(list.status === 401 || list.status === 403) && ` ${SESSION_HINT}`}
            </p>
            <code className={shared.loadErrorDetail}>
              {list.title}
              {list.detail ? ` ${list.detail}` : ""}
            </code>
            <button type="button" className={shared.btnPrimary} onClick={reload}>
              <RefreshCw size={18} />
              <span>Retry</span>
            </button>
          </div>
        ) : entries.length === 0 && !oneProperty ? (
          /* A property's ledger is shown even with no entry anywhere: its name, its dates and its exports. */
          <div className={shared.empty}>
            <Receipt size={48} strokeWidth={1} />
            <h2>No cost entries yet</h2>
            <p>Receipts that cleaners send from their app appear here.</p>
          </div>
        ) : (
          <>
            {/* ── The queue, or a ledger ── */}
            {ledger ? (
              <div className={styles.ledgerHead}>
                <h2 className={styles.ledgerTitle}>{propertyName ?? "Unknown property"}</h2>
                <p className={styles.modeLine}>
                  <strong>Costs ledger</strong> · approved entries only, the ones that count. An approved entry can
                  still be corrected or removed: open it. This property’s pending, rejected and removed entries are in
                  the{" "}
                  <button type="button" className={styles.linkButton} onClick={() => setFilter({ status: NEEDS_ATTENTION })}>
                    review queue{waiting > 0 ? ` (${waiting} waiting)` : ""}
                  </button>
                  .
                </p>
                {propertyName === null && (
                  <p className={styles.noteWarn} role="alert">
                    {known === null
                      ? "The property names could not be read, so this ledger cannot be named or exported. Refresh to try again."
                      : "No property with this ID is on record, and no cost entry names it."}
                  </p>
                )}
              </div>
            ) : (
              <p className={styles.modeLine}>
                {filters.status === NEEDS_ATTENTION ? (
                  <>
                    <strong>Review queue</strong>
                    {oneProperty && <> · {propertyName ?? "Unknown property"}</>} · everything not yet approved. Approve
                    an entry and it moves to its property’s ledger; reject or remove it and it stays here, marked.
                    {oneProperty && (
                      <>
                        {" "}
                        Approved entries are in{" "}
                        <button type="button" className={styles.linkButton} onClick={() => setFilter({ status: "approved" })}>
                          its ledger
                        </button>
                        .
                      </>
                    )}
                  </>
                ) : (
                  <>Every entry, whatever its status.</>
                )}
              </p>
            )}

            {/* ── Filters ── */}
            <section className={styles.filters} aria-label="Filters">
              <div className={styles.filterRow}>
                <select
                  className={shared.filterSelect}
                  aria-label="Property"
                  value={filters.propertyId}
                  onChange={(e) => setFilter({ propertyId: e.target.value })}
                >
                  <option value="">All properties</option>
                  {oneProperty && propertyName === null && <option value={filters.propertyId}>Unknown property</option>}
                  {properties.withEntries.length > 0 && (
                    <optgroup label="With cost entries">
                      {properties.withEntries.map(([id, label]) => (
                        <option key={id} value={id}>
                          {label}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {properties.withoutEntries.length > 0 && (
                    <optgroup label="No cost entries yet">
                      {properties.withoutEntries.map(([id, label]) => (
                        <option key={id} value={id}>
                          {label}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
                <select
                  className={shared.filterSelect}
                  aria-label="Status"
                  value={filters.status}
                  onChange={(e) => setFilter({ status: e.target.value })}
                >
                  <option value={NEEDS_ATTENTION}>
                    Needs attention ({inScope.filter((entry) => entry.status !== "approved").length})
                  </option>
                  <option value="">All statuses ({inScope.length})</option>
                  {ENTRY_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {ENTRY_STATUS_LABELS[status]} ({statusCounts.get(status) ?? 0})
                    </option>
                  ))}
                </select>
                <label className={styles.dateField}>
                  <span>From</span>
                  <input
                    type="date"
                    className={styles.dateInput}
                    value={filters.from}
                    max={filters.to || undefined}
                    onChange={(e) => setFilter({ from: e.target.value })}
                  />
                </label>
                <label className={styles.dateField}>
                  <span>To</span>
                  <input
                    type="date"
                    className={styles.dateInput}
                    value={filters.to}
                    min={filters.from || undefined}
                    onChange={(e) => setFilter({ to: e.target.value })}
                  />
                </label>
                <span className={shared.resultCount}>
                  {visible.length} of {inScope.length}
                </span>
              </div>
              <div className={styles.presetRow} role="group" aria-label="Dates">
                {RANGE_PRESETS.map((preset) => (
                  <button
                    key={preset.key}
                    type="button"
                    className={`${styles.preset} ${activePreset === preset.key ? styles.presetActive : ""}`}
                    aria-pressed={activePreset === preset.key}
                    onClick={() => setFilter(presetRange(preset.key, today))}
                  >
                    {preset.label}
                  </button>
                ))}
                <span className={styles.presetNote}>Dates are the day a receipt was sent, in Toronto time.</span>
              </div>
            </section>

            {/* ── Totals for what is shown, and the reports ── */}
            <section className={styles.totals} aria-label="Totals">
              <div className={styles.totalsHead}>
                <h2 className={styles.totalsTitle}>Totals for what is shown</h2>
                <span className={styles.totalsRange}>
                  {filters.from === "" && filters.to === ""
                    ? "All time"
                    : `${filters.from ? shortDay(filters.from) : "the start"} to ${filters.to ? shortDay(filters.to) : "today"}`}
                </span>
              </div>
              {visible.length === 0 ? (
                <p className={styles.note}>
                  {ledger
                    ? "Nothing to add up: this property has no approved costs in these dates."
                    : "Nothing to add up: no entries match these filters."}
                </p>
              ) : (
                <div className={styles.tableScroll}>
                  <table className={styles.totalsTable}>
                    <thead>
                      <tr>
                        <th>Property</th>
                        <th className={styles.num}>Entries</th>
                        <th className={styles.num}>Approved</th>
                        <th className={styles.num}>Pending</th>
                        <th className={styles.num}>Counted</th>
                        <th className={styles.num}>of which tax</th>
                        <th>Not counted</th>
                      </tr>
                    </thead>
                    <tbody>
                      {totals.rows.map((row) => (
                        <TotalsRow key={row.propertyId ?? ""} label={row.label} totals={row} />
                      ))}
                      {totals.rows.length > 1 && <TotalsRow label="All shown" totals={totals.all} strong />}
                    </tbody>
                  </table>
                </div>
              )}
              <div className={styles.exportRow}>
                {oneProperty && propertyName !== null ? (
                  <>
                    <span className={styles.exportLabel}>Report for this property and these dates:</span>
                    <button type="button" className={styles.btnGhost} disabled={recording} onClick={() => exportReport("xlsx")}>
                      <FileSpreadsheet size={15} aria-hidden />
                      <span>Excel</span>
                    </button>
                    <button type="button" className={styles.btnGhost} disabled={recording} onClick={() => exportReport("pdf")}>
                      <FileText size={15} aria-hidden />
                      <span>{recording ? "Recording…" : "PDF"}</span>
                    </button>
                    <span className={styles.note}>
                      Approved entries only. The PDF is for co-owners and names no cleaner; each PDF is recorded, so a
                      later correction shows against it.
                    </span>
                  </>
                ) : oneProperty ? (
                  <span className={styles.note}>This property cannot be named, so no report can be made for it.</span>
                ) : (
                  <span className={styles.note}>Choose a property to download its report as Excel or PDF.</span>
                )}
              </div>
            </section>

            {/* ── The PDFs that went out for this property, against the ledger now ── */}
            {oneProperty && <PdfExports comparisons={propertyPdfs} unreadable={pdfs.unreadable} onOpen={open} />}

            {oneProperty && (
              <div className={styles.tabs} role="tablist" aria-label="Show">
                <button
                  type="button"
                  role="tab"
                  aria-selected={showing === "entries"}
                  className={`${styles.tab} ${showing === "entries" ? styles.tabActive : ""}`}
                  onClick={() => setView("entries")}
                >
                  Entries
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={showing === "items"}
                  className={`${styles.tab} ${showing === "items" ? styles.tabActive : ""}`}
                  onClick={() => setView("items")}
                >
                  Items bought
                </button>
              </div>
            )}

            <div className={styles.layout}>
              {/* ── List ── */}
              <section className={styles.listPane} aria-label={showing === "items" ? "Items bought" : "Entries"}>
                {visible.length === 0 && ledger ? (
                  <div className={shared.empty}>
                    <Receipt size={48} strokeWidth={1} />
                    <h2>No approved costs in these dates</h2>
                    <p>
                      An entry for this property appears here once it is approved in the review queue
                      {waiting > 0 ? `, where ${waiting === 1 ? "1 is" : `${waiting} are`} waiting` : ""}.
                    </p>
                  </div>
                ) : visible.length === 0 ? (
                  <div className={shared.empty}>
                    <Search size={48} strokeWidth={1} />
                    <h2>No entries match these filters</h2>
                    <p>Try another property, status or dates.</p>
                  </div>
                ) : showing === "items" ? (
                  <ItemsTable rows={items} selectedId={selectedId} onOpen={open} />
                ) : (
                  <div className={`${shared.tableContainer} ${styles.tableScroll}`}>
                    <table className={shared.table}>
                      <thead>
                        <tr>
                          <th>Sent</th>
                          {/* With one property chosen every row is that property's: its name is in the heading or the filter. */}
                          {!oneProperty && <th>Property</th>}
                          <th>Cleaner</th>
                          <th className={styles.num}>Items</th>
                          <th className={styles.num}>Tax</th>
                          <th className={styles.num}>Total</th>
                          <th>Status</th>
                          <th>Receipt</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visible.map((entry) => {
                          const isOpen = entry.id === selectedId;
                          return (
                            <tr
                              key={entry.id}
                              className={`${styles.row} ${isOpen ? styles.rowOpen : ""} ${countsInTotals(entry.status) ? "" : styles.rowOut}`}
                              onClick={() => open(entry.id)}
                            >
                              <td className={styles.whenCell}>
                                <button
                                  type="button"
                                  className={styles.rowButton}
                                  aria-current={isOpen ? "true" : undefined}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    open(entry.id);
                                  }}
                                >
                                  <SentAt iso={entry.createdAt} />
                                </button>
                              </td>
                              {!oneProperty && <td className={styles.nameCell}>{propertyLabel(entry)}</td>}
                              <td className={`${styles.nameCell} ${styles.cleanerCell}`}>{cleanerLabel(entry)}</td>
                              <td className={styles.num}>
                                {entry.linesNow.kind === "ok" ? formatCents(entry.linesNow.itemsCents) : <Absent />}
                              </td>
                              <td className={styles.num}>
                                {entry.linesNow.kind === "ok" ? <TaxText now={entry.linesNow} /> : <Absent />}
                              </td>
                              <td className={styles.num}>
                                <TotalCell entry={entry} />
                                {/* Under the total it is about, so it is in view wherever the total is. */}
                                <PdfMark state={pdfStates.get(entry.id) ?? null} />
                              </td>
                              <td>
                                <EntryStatusBadge status={entry.status} />
                              </td>
                              <td>
                                {entry.receipts !== null && entry.receipts.length > 0 ? (
                                  <ImageIcon size={16} className={styles.receiptIcon} aria-label="Receipt photo" />
                                ) : (
                                  <Absent label="None" />
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              {/* ── The open entry ── */}
              <aside ref={detailRef} className={styles.detailPane} aria-label="Entry">
                {selected ? (
                  <EntryPane
                    key={selected.id}
                    entry={selected}
                    pdf={pdfStates.get(selected.id) ?? null}
                    onChanged={replaceEntry}
                    onClose={closePane}
                  />
                ) : selectedId !== null ? (
                  <div className={styles.detailState}>
                    <p>This entry is not in the list. It may have been opened from an old link.</p>
                    <button type="button" className={styles.btnGhost} onClick={closePane}>
                      Close
                    </button>
                  </div>
                ) : (
                  <div className={styles.detailState}>
                    <Receipt size={28} strokeWidth={1.5} />
                    <p>Select an entry to see its receipt, items and history.</p>
                  </div>
                )}
              </aside>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

/** One row of the totals: what counts, apart, and what does not, in words. */
function TotalsRow({ label, totals, strong = false }: { label: string; totals: Totals; strong?: boolean }) {
  const notCounted = [
    totals.rejected > 0 ? `${totals.rejected} rejected` : null,
    totals.removed > 0 ? `${totals.removed} removed` : null,
    totals.unknownStatus > 0 ? `${totals.unknownStatus} with an unknown status` : null,
  ].filter(Boolean);
  return (
    <tr className={strong ? styles.totalsAll : undefined}>
      <td>{label}</td>
      <td className={styles.num}>{totals.entries}</td>
      <td className={styles.num}>{formatCents(totals.approvedCents)}</td>
      <td className={styles.num}>{formatCents(totals.pendingCents)}</td>
      <td className={styles.num}>{formatCents(totals.approvedCents + totals.pendingCents)}</td>
      <td className={styles.num}>{formatCents(totals.approvedTaxCents + totals.pendingTaxCents)}</td>
      <td>
        {notCounted.length > 0 ? notCounted.join(", ") : <span className={styles.muted}>None</span>}
        {totals.unreadable > 0 && (
          <span className={styles.noteWarn}>
            {" "}
            + {totals.unreadable} that cannot be added up
          </span>
        )}
      </td>
    </tr>
  );
}

/** An entry's tax in words or figures: the amount, "none", or "in items" on an entry sent before tax was its own field. */
export function TaxText({ now }: { now: Extract<CostEntryView["linesNow"], { kind: "ok" }> }) {
  if (now.taxShape === "in-lines") return <span className={styles.muted} title="Sent before tax was its own field: any tax is a line among the items">in items</span>;
  if (now.taxCents === null) return <span className={styles.muted}>none</span>;
  return <>{formatCents(now.taxCents)}</>;
}

/** An entry's total as it now counts, marked when corrected; struck through when it does not count. */
function TotalCell({ entry }: { entry: CostEntryView }) {
  const now = entry.linesNow;
  if (now.kind !== "ok") {
    return (
      <span className={`${styles.badge} ${styles.badgeOdd}`} title={now.reason}>
        Cannot add up
      </span>
    );
  }
  return (
    <span className={styles.totalCell}>
      {now.corrected && (
        <span
          className={styles.correctedMark}
          title={`Corrected; sent as ${formatCents(now.sentTotalCents)}`}
          aria-label={`Corrected; sent as ${formatCents(now.sentTotalCents)}`}
        >
          <Pencil size={12} aria-hidden />
        </span>
      )}
      <span className={countsInTotals(entry.status) ? undefined : styles.struck}>{formatCents(now.totalCents)}</span>
    </span>
  );
}

/**
 * How an entry stands beside the newest PDF covering its day, in words under
 * its total: nothing when it was never in a PDF, a quiet word while that PDF
 * still says what the entry says, and a marked one when it no longer does.
 */
function PdfMark({ state }: { state: EntryPdfState | null }) {
  if (state === null) return null;
  const { printed, record } = state.lastListed;
  const was = `The PDF exported ${whenText(record.createdAt)} shows this entry at ${formatCents(printed.totalCents)}`;
  switch (state.latest) {
    case "same":
      return (
        <span className={styles.pdfMark} title={`${was}. Nothing has changed since.`}>
          in PDF
        </span>
      );
    case "corrected":
      return (
        <span className={styles.pdfMark} title={`${was}. It was corrected since, without changing an amount.`}>
          corrected since PDF
        </span>
      );
    case "amount-changed":
      return (
        <span className={`${styles.pdfMark} ${styles.pdfMarkWarn}`} title={`${was}. It now adds up differently.`}>
          changed since PDF
        </span>
      );
    case "left":
      return (
        <span className={`${styles.pdfMark} ${styles.pdfMarkWarn}`} title={`${was}, and that PDF still lists it.`}>
          still in a PDF
        </span>
      );
    case "unreadable":
    case "missing":
      return (
        <span className={`${styles.pdfMark} ${styles.pdfMarkWarn}`} title={`${was}. It cannot be compared now.`}>
          cannot compare with PDF
        </span>
      );
    case "not-listed":
      return (
        <span className={styles.pdfMark} title={`${was}. A newer PDF for its day does not list it.`}>
          in an earlier PDF
        </span>
      );
  }
}

/** One change between a PDF and the ledger now, in words. */
function changeText(change: PdfComparison["changes"][number]): string {
  const was = formatCents(change.printed.totalCents);
  switch (change.since.kind) {
    case "amount-changed":
      return `${was} in the PDF, now ${formatCents(change.since.nowTotalCents)}`;
    case "left":
      return `${was} in the PDF; ${statusWord(change.since.status)} since, so it no longer counts`;
    case "corrected":
      return `corrected since, the amounts unchanged (${was})`;
    case "unreadable":
      return `${was} in the PDF; it cannot be added up now`;
    case "missing":
      return `${was} in the PDF; no such entry is on record now`;
  }
}

/**
 * The PDFs exported for one property, newest first, each beside the ledger
 * as it now stands over the PDF's own period. A PDF that no longer matches
 * says why, entry by entry; the references are the ones the PDF prints.
 *
 * The newest PDF is always listed, and so is every PDF that no longer
 * matches and has no newer PDF to replace it. The older ones that ask
 * nothing of anyone — still matching, or replaced — are folded away until
 * asked for, so a year of monthly PDFs does not push the entries down.
 */
function PdfExports({
  comparisons,
  unreadable,
  onOpen,
}: {
  comparisons: PdfComparison[];
  unreadable: number;
  onOpen: (id: string) => void;
}) {
  /** A newer PDF that covers the whole of an older one's period and still matches: the one to go by. */
  const replacement = (index: number) =>
    comparisons
      .slice(0, index)
      .find(
        (newer) =>
          newer.verdict !== "differs" &&
          newer.record.from <= comparisons[index].record.from &&
          newer.record.to >= comparisons[index].record.to,
      );
  const needsLooking = (index: number) => comparisons[index].verdict === "differs" && !replacement(index);
  const stale = comparisons.filter((_, index) => needsLooking(index)).length;
  const [showAll, setShowAll] = useState(false);
  const foldable = comparisons.filter((_, index) => index > 0 && !needsLooking(index)).length;

  return (
    <section className={styles.totals} aria-label="PDFs exported">
      <div className={styles.totalsHead}>
        <h2 className={styles.totalsTitle}>PDFs exported for this property</h2>
        <span className={styles.totalsRange}>what a co-owner may hold, beside the ledger now</span>
      </div>
      {comparisons.length === 0 ? (
        <p className={styles.note}>
          None yet. Each PDF exported from here is recorded, so that a correction or removal made afterwards shows
          against it.
        </p>
      ) : (
        <>
          {stale > 0 && (
            <p className={styles.pdfAlert} role="status">
              <AlertTriangle size={15} aria-hidden />
              <span>
                {stale === 1 ? "A PDF exported for this property no longer matches" : `${stale} PDFs exported for this property no longer match`}{" "}
                its ledger, and no newer PDF replaces {stale === 1 ? "it" : "them"}. Whoever received{" "}
                {stale === 1 ? "it" : "one"} holds figures that have since changed: export the PDF again for the same
                dates.
              </span>
            </p>
          )}
          <div className={styles.tableScroll}>
            <table className={`${styles.totalsTable} ${styles.pdfTable}`}>
              <thead>
                <tr>
                  <th>Exported</th>
                  <th>Period</th>
                  <th className={styles.num}>Entries</th>
                  <th className={styles.num}>Total in the PDF</th>
                  <th>Beside the ledger now</th>
                </tr>
              </thead>
              <tbody>
                {comparisons.map((comparison, index) => {
                  if (!showAll && index > 0 && !needsLooking(index)) return null;
                  const { record, changes, added, verdict } = comparison;
                  const newer = verdict === "differs" ? replacement(index) : undefined;
                  return (
                    <tr key={record.id}>
                      <td className={styles.whenCell}>
                        <SentAt iso={record.createdAt} seconds />
                      </td>
                      <td className={styles.whenCell}>
                        {record.from === record.to ? shortDay(record.from) : `${shortDay(record.from)} – ${shortDay(record.to)}`}
                      </td>
                      <td className={styles.num}>{record.entries.length}</td>
                      <td className={styles.num}>{formatCents(record.totalCents)}</td>
                      <td>
                        {verdict === "matches" ? (
                          <span className={styles.pdfOk}>Matches</span>
                        ) : verdict === "wording" ? (
                          <span className={`${styles.badge} ${styles.badgePdfNote}`}>Amounts match</span>
                        ) : (
                          <span className={`${styles.badge} ${styles.badgePdfWarn}`}>No longer matches</span>
                        )}
                        {(changes.length > 0 || added.length > 0) && (
                          <ul className={styles.pdfChanges}>
                            {changes.map((change) => (
                              <li key={change.printed.entryId}>
                                <button
                                  type="button"
                                  className={styles.linkButton}
                                  onClick={() => onOpen(change.printed.entryId)}
                                  title="Open this entry"
                                >
                                  {entryRef(change.printed.entryId)}
                                </button>{" "}
                                {changeText(change)}
                              </li>
                            ))}
                            {added.map((entry) => (
                              <li key={entry.id}>
                                <button type="button" className={styles.linkButton} onClick={() => onOpen(entry.id)} title="Open this entry">
                                  {entryRef(entry.id)}
                                </button>{" "}
                                approved since, so not in the PDF
                                {entry.linesNow.kind === "ok" ? ` (${formatCents(entry.linesNow.totalCents)})` : ""}
                              </li>
                            ))}
                          </ul>
                        )}
                        {verdict === "differs" && (
                          <span className={styles.pdfNow}>
                            These dates now add up to{" "}
                            {comparison.nowTotalCents === null ? "an amount that cannot be worked out" : formatCents(comparison.nowTotalCents)}{" "}
                            over {comparison.nowEntries === 1 ? "1 entry" : `${comparison.nowEntries} entries`}.
                            {newer && <> The PDF exported {whenText(newer.record.createdAt)} covers them and replaces this one.</>}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {foldable > 0 && (
            <button type="button" className={styles.linkButton} onClick={() => setShowAll((all) => !all)}>
              {showAll
                ? "Show only the newest PDF and any that need looking at"
                : `Show all ${comparisons.length} PDFs: ${foldable} older ${foldable === 1 ? "one still matches or has" : "ones still match or have"} been replaced`}
            </button>
          )}
        </>
      )}
      {unreadable > 0 && (
        <p className={styles.noteWarn}>
          {unreadable === 1
            ? "1 PDF record on file cannot be read, so it is not compared here. It may be one of this property’s."
            : `${unreadable} PDF records on file cannot be read, so they are not compared here. Some may be this property’s.`}
        </p>
      )}
    </section>
  );
}

/** Every line that counts, for one house: what was bought, and what each line cost as printed. */
function ItemsTable({
  rows,
  selectedId,
  onOpen,
}: {
  rows: ReturnType<typeof countedItems>;
  selectedId: string | null;
  onOpen: (id: string) => void;
}) {
  if (rows.length === 0) {
    return (
      <div className={shared.empty}>
        <Search size={48} strokeWidth={1} />
        <h2>No items that count</h2>
        <p>The entries shown are rejected, removed, or cannot be read.</p>
      </div>
    );
  }
  const total = rows.reduce((sum, row) => sum + row.line.lineTotalCents, 0);
  return (
    <div className={`${shared.tableContainer} ${styles.tableScroll}`}>
      <table className={shared.table}>
        <thead>
          <tr>
            <th>Sent</th>
            <th>Item</th>
            <th>Qty (reference)</th>
            <th className={styles.num}>Line total as printed</th>
            <th>Entry</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={`${row.entryId}-${row.line.index}`}
              className={`${styles.row} ${row.entryId === selectedId ? styles.rowOpen : ""}`}
              onClick={() => onOpen(row.entryId)}
            >
              <td className={styles.whenCell}>{row.day ? shortDay(row.day) : <Absent />}</td>
              <td className={styles.nameCell}>
                <FieldText value={row.line.name} />
                {row.line.origin === "added" && (
                  <span className={`${styles.badge} ${styles.badgeAdded}`}>Added by admin</span>
                )}
                {row.line.earlier.length > 0 && (
                  <span className={`${styles.badge} ${styles.badgeCorrected}`}>Corrected</span>
                )}
              </td>
              <td>{quantityText(row.line.quantity)}</td>
              <td className={styles.num}>{formatCents(row.line.lineTotalCents)}</td>
              <td>
                <EntryStatusBadge status={row.status} />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className={styles.totalsAll}>
            <td />
            <td>Total, {rows.length === 1 ? "1 line" : `${rows.length} lines`}</td>
            <td />
            <td className={styles.num}>{formatCents(total)}</td>
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
