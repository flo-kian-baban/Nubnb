"use client";

/**
 * Costs: what cleaners spent, receipt by receipt, per house — and its review
 * and reports.
 *
 * One read on opening, GET /api/admin/cost-entries (the whole collection:
 * nothing can silently drop out), and everything else — filters, totals, the
 * items bought for a house, the Excel and PDF reports — is worked out here
 * from that one answer, so it costs no further function call. A review is one
 * call; opening a receipt is one call for its 60-second link.
 *
 * ── What counts ──
 * Approved and pending entries count in totals, shown apart; rejected and
 * removed ones stay in the table, marked, and count nowhere. An entry whose
 * lines cannot be read is counted apart and never added in. Amounts are the
 * lines as they now stand, corrections applied (linesNow).
 *
 * ── Dates ──
 * The day an entry was sent, in Toronto time; the app records no purchase
 * date. The page opens on all time, so nothing is hidden on arrival.
 *
 * ── Reports ──
 * One property over the dates chosen, approved entries only: the PDF goes to
 * the property's co-owners, and pending entries have not been checked. The
 * page says so, and asks, when pending entries fall in the period. Both files
 * are made in the browser and never leave it except as the download.
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
import { fetchCostEntries } from "@/app/lib/costs-client";
import {
  ENTRY_STATUSES,
  ENTRY_STATUS_LABELS,
  countsInTotals,
  formatCents,
  isEntryStatus,
  type CostEntryView,
} from "@/app/lib/cleaners/model";
import {
  RANGE_PRESETS,
  buildReport,
  cleanerLabel,
  countedItems,
  isDay,
  matchesFilters,
  periodLabel,
  presetRange,
  propertyLabel,
  reportFileName,
  shortDay,
  torontoDayOf,
  totalsByProperty,
  type CostFilters,
  type Totals,
} from "@/app/lib/costs/report";
import { pdfFor } from "@/app/lib/costs/pdf";
import { workbookFor } from "@/app/lib/costs/xlsx";
import { Absent, FieldText } from "../leads/lead-display";
import { EntryStatusBadge, SentAt, quantityText } from "./cost-display";
import { EntryPane } from "./EntryPane";
import shared from "../page.module.css";
import styles from "./page.module.css";

type ListState =
  | { kind: "loading" }
  | { kind: "ready"; entries: CostEntryView[] }
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
    const status = params.get("status");
    return {
      propertyId: params.get("property") ?? "",
      status: isEntryStatus(status) ? status : "",
      from: day("from"),
      to: day("to"),
    };
  });
  const [view, setView] = useState<View>(() => (params.get("view") === "items" ? "items" : "entries"));
  const [selectedId, setSelectedId] = useState<string | null>(() => params.get("entry"));
  const detailRef = useRef<HTMLElement>(null);
  const { notice, show, clear } = useNotice();

  useEffect(() => {
    let cancelled = false;
    fetchCostEntries().then((result) => {
      if (cancelled) return;
      setList(
        result.ok
          ? { kind: "ready", entries: result.data }
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
    set("status", filters.status);
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
        ? { kind: "ready", entries: prev.entries.map((entry) => (entry.id === stored.id ? stored : entry)) }
        : prev,
    );
  }, []);

  const closePane = useCallback(() => setSelectedId(null), []);

  const entries = useMemo(() => (list.kind === "ready" ? list.entries : []), [list]);
  const visible = useMemo(() => entries.filter((entry) => matchesFilters(entry, filters)), [entries, filters]);
  const totals = useMemo(() => totalsByProperty(visible), [visible]);
  const items = useMemo(() => countedItems(visible), [visible]);
  const statusCounts = useMemo(() => {
    const counts = new Map<string | null, number>();
    for (const entry of entries) counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1);
    return counts;
  }, [entries]);
  const properties = useMemo(() => {
    const byId = new Map<string, string>();
    for (const entry of entries) if (entry.property.id !== null) byId.set(entry.property.id, propertyLabel(entry));
    return [...byId.entries()].sort((a, b) => a[1].localeCompare(b[1], "en-CA"));
  }, [entries]);

  const oneProperty = filters.propertyId !== "";
  const showing: View = oneProperty ? view : "entries";
  const selected = selectedId === null ? null : (entries.find((entry) => entry.id === selectedId) ?? null);
  const today = torontoDayOf(new Date());
  const activePreset = RANGE_PRESETS.find((preset) => {
    const range = presetRange(preset.key, today);
    return range.from === filters.from && range.to === filters.to;
  })?.key;

  const setFilter = (change: Partial<CostFilters>) => setFilters((was) => ({ ...was, ...change }));

  const exportReport = (kind: "pdf" | "xlsx") => {
    if (list.kind !== "ready" || !oneProperty) return;
    clear();
    const built = buildReport(list.entries, filters.propertyId, filters.from, filters.to, new Date());
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

    const bytes = kind === "pdf" ? pdfFor(report) : workbookFor(report);
    const type = kind === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = reportFileName(report, kind);
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);

    show({
      tone: "success",
      title: `Downloaded the ${kind === "pdf" ? "PDF" : "Excel file"} for ${report.propertyName}.`,
      detail: `${periodLabel(report.from, report.to)} · ${report.entries.length === 1 ? "1 approved entry" : `${report.entries.length} approved entries`} · ${formatCents(report.totalCents)}${pendingLeftOut > 0 ? ` · ${pendingLeftOut} pending left out` : ""}`,
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
            <h1>Costs</h1>
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
        ) : entries.length === 0 ? (
          <div className={shared.empty}>
            <Receipt size={48} strokeWidth={1} />
            <h2>No cost entries yet</h2>
            <p>Receipts that cleaners send from their app appear here.</p>
          </div>
        ) : (
          <>
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
                  {properties.map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
                <select
                  className={shared.filterSelect}
                  aria-label="Status"
                  value={filters.status}
                  onChange={(e) => setFilter({ status: e.target.value })}
                >
                  <option value="">All statuses ({entries.length})</option>
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
                  {visible.length} of {entries.length}
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
                <p className={styles.note}>Nothing to add up: no entries match these filters.</p>
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
                {oneProperty ? (
                  <>
                    <span className={styles.exportLabel}>Report for this property and these dates:</span>
                    <button type="button" className={styles.btnGhost} onClick={() => exportReport("xlsx")}>
                      <FileSpreadsheet size={15} aria-hidden />
                      <span>Excel</span>
                    </button>
                    <button type="button" className={styles.btnGhost} onClick={() => exportReport("pdf")}>
                      <FileText size={15} aria-hidden />
                      <span>PDF</span>
                    </button>
                    <span className={styles.note}>Approved entries only. The PDF is for co-owners and names no cleaner.</span>
                  </>
                ) : (
                  <span className={styles.note}>Choose a property to download its report as Excel or PDF.</span>
                )}
              </div>
            </section>

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
                {visible.length === 0 ? (
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
                          <th>Property</th>
                          <th>Cleaner</th>
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
                              <td className={styles.nameCell}>{propertyLabel(entry)}</td>
                              <td className={`${styles.nameCell} ${styles.cleanerCell}`}>{cleanerLabel(entry)}</td>
                              <td className={styles.num}>
                                <TotalCell entry={entry} />
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
                  <EntryPane key={selected.id} entry={selected} onChanged={replaceEntry} onClose={closePane} />
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
