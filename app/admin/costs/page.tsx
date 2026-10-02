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
 * An approved entry may already be in a PDF an owner holds. So a PDF is
 * recorded before it is downloaded, and the page sets every recorded PDF
 * beside the ledger as it now stands: a list of the property's PDFs saying
 * which still match, a mark on each entry that has changed since the newest
 * PDF covering its day, and the same in the entry pane. An entry deleted
 * outright (dispatch 23H) has no row left to mark, so the ledger says, per
 * PDF, that it lists an entry since deleted.
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
 * the property's owner, and pending entries have not been checked. The
 * page says so, and asks, when pending entries fall in the period. Both files
 * are made in the browser and never leave it except as the download. The PDF
 * is downloaded only once the server has recorded it, and carries the
 * record's time as its "Generated" time; the Excel file is the admins' own
 * and is not recorded.
 *
 * "Could not load" is never "nothing here": a failed read shows no table, no
 * totals and no export, so it can never produce an empty report.
 *
 * ── Approved automatically (dispatch 24, Kian's decision of 2026-09-30) ──
 * A receipt under $200.00 as sent is approved as it arrives, and counts in
 * its ledger at once. It stays in the queue, in its own group at the top,
 * until an admin marks it Seen — one at a time, or all at once — or
 * corrects, removes or rejects it. Above the queue, a "Worth a look" panel
 * names any cleaner whose receipts cluster under the line (costs/patterns.ts),
 * with a link to the queue filtered to them. A handyman's work entry
 * (kind `work`) is marked as such on its row, has no receipt, and needs an
 * admin's approval whatever its amount.
 *
 * ── The property's page (dispatches 23D and 23F) ──
 * Since dispatch 23F the property's page is /admin/property: its costs by
 * month, its income lines, the statement's details and its finishing, with
 * the statement preview beside — the one place an admin works on a
 * property. This page keeps the queue and the ledger for any dates: a
 * ledger links to the property's page, and the property's page links back
 * here for the dates and exports the month does not cover. The entry pane
 * reads one property's statements (GET /api/admin/properties/[id]/statements)
 * to say which statement an entry went into, so an entry opened in the
 * queue reaches its property and its statement too.
 *
 * ── What needs review first (Kian, 2026-10-02) ──
 * The entries come straight under the filters, and "Totals for what is
 * shown" sits at the bottom of the page. In the queue the table is grouped:
 * receipts approved automatically that nobody has looked at, then entries
 * waiting for a decision, then — last — the rejected and removed ones, which
 * are decided and only kept on record. The table is one line per entry:
 * Sent · Property · Logged by · Total (items and tax in its tooltip) ·
 * Status · Receipt; the property takes the width that is left, and the entry
 * pane opens beside it only when an entry is opened.
 *
 * The filters, the view and the open entry are mirrored into the URL
 * (?property=, ?status=, ?kind=, ?cleaner=, ?from=, ?to=, ?view=, ?entry=),
 * so a reload keeps them.
 */

import { Fragment, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, Eye, FileSpreadsheet, FileText, ImageIcon, Pencil, Receipt, RefreshCw, Search } from "lucide-react";
import { AdminHeader } from "../components/AdminHeader";
import { AdminSelect } from "../components/AdminSelect";
import { DateRangeField } from "../components/DateRangeField";
import { PinGate } from "../components/PinGate";
import { NoticeBanner, useNotice, type Notice } from "../components/Notice";
import { fetchCosts, markEntrySeen, recordPdfExport } from "@/app/lib/costs-client";
import { fetchPropertyStatements } from "@/app/lib/reports-client";
import {
  ENTRY_STATUSES,
  ENTRY_STATUS_LABELS,
  awaitingLook,
  countsInTotals,
  formatCents,
  isEntryKind,
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
  countedItems,
  deletedSincePdf,
  entryPdfState,
  inQueue,
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
  type Totals,
} from "@/app/lib/costs/report";
import { splitText, watchList, worthALookText } from "@/app/lib/costs/patterns";
import { pdfFor } from "@/app/lib/costs/pdf";
import { workbookFor } from "@/app/lib/costs/xlsx";
import { Absent, FieldText } from "../leads/lead-display";
import { EntryStatusBadge, KindBadge, SentAt, quantityText, whenText } from "./cost-display";
import { EntryPane, type PropertyStatementsState } from "./EntryPane";
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
    const kind = params.get("kind");
    return {
      propertyId: params.get("property") ?? "",
      status: isEntryStatus(status) ? status : status === "all" ? "" : NEEDS_ATTENTION,
      from: day("from"),
      to: day("to"),
      kind: isEntryKind(kind) ? kind : "",
      cleanerId: params.get("cleaner") ?? "",
    };
  });
  const [view, setView] = useState<View>(() => (params.get("view") === "items" ? "items" : "entries"));
  const [selectedId, setSelectedId] = useState<string | null>(() => params.get("entry"));
  const detailRef = useRef<HTMLElement>(null);
  const { notice, show, clear } = useNotice();
  /** True while a PDF is being recorded, before it is downloaded. */
  const [recording, setRecording] = useState(false);
  /** The entry being marked seen, or "all" while the group is; null otherwise. */
  const [marking, setMarking] = useState<string | null>(null);
  /** Each property's statements, read once when one of its entries is open (dispatch 23D); absent means loading. */
  const [statementsByProperty, setStatementsByProperty] = useState<Record<string, PropertyStatementsState>>({});
  /** The properties whose statements have been asked for, so the read is made once; cleared on Refresh. */
  const requestedStatements = useRef(new Set<string>());
  const loadStatements = useCallback((propertyId: string) => {
    requestedStatements.current.add(propertyId);
    fetchPropertyStatements(propertyId).then((result) => {
      setStatementsByProperty((prev) => ({
        ...prev,
        [propertyId]: result.ok ? { kind: "ready", data: result.data } : { kind: "error", title: result.title, detail: result.detail, status: result.status },
      }));
    });
  }, []);

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
    set("kind", filters.kind);
    set("cleaner", filters.cleanerId);
    set("view", view === "items" && filters.propertyId !== "" ? "items" : null);
    set("entry", selectedId);
    if (url.href !== window.location.href) window.history.replaceState(null, "", url.href);
  }, [filters, view, selectedId]);

  const reload = () => {
    clear();
    setList({ kind: "loading" });
    setStatementsByProperty({});
    requestedStatements.current.clear();
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

  /** An entry deleted outright (dispatch 23H): it leaves the list, the pane closes, and the page says what went. */
  const dropEntry = useCallback(
    (id: string, done: Notice) => {
      setList((prev) => (prev.kind === "ready" ? { ...prev, entries: prev.entries.filter((entry) => entry.id !== id) } : prev));
      setSelectedId(null);
      show(done);
    },
    [show],
  );

  const entries = useMemo(() => (list.kind === "ready" ? list.entries : []), [list]);
  const known = list.kind === "ready" ? list.properties : null;
  const visible = useMemo(() => entries.filter((entry) => matchesFilters(entry, filters)), [entries, filters]);
  /** In the queue: the entries approved automatically that no admin has looked at, shown as their own group (dispatch 24). */
  const unseen = useMemo(() => (filters.status === NEEDS_ATTENTION ? visible.filter(awaitingLook) : []), [visible, filters.status]);
  /**
   * The table's groups. In the queue (2026-10-02): what needs review first —
   * approved automatically and not looked at, then waiting for a decision —
   * and the rejected and removed entries, decided and kept on record, last.
   * Anywhere else, one list, newest first.
   */
  const groups = useMemo(() => {
    if (filters.status !== NEEDS_ATTENTION) return [{ key: "all", entries: visible }];
    const decided = (entry: CostEntryView) => entry.status === "rejected" || entry.status === "removed";
    return [
      { key: "unseen", entries: unseen },
      { key: "decide", entries: visible.filter((entry) => !awaitingLook(entry) && !decided(entry)) },
      { key: "decided", entries: visible.filter((entry) => !awaitingLook(entry) && decided(entry)) },
    ].filter((group) => group.entries.length > 0);
  }, [visible, unseen, filters.status]);
  /** In the queue: how many entries wait for an admin — a look or a decision. */
  const toReview = groups.filter((group) => group.key === "unseen" || group.key === "decide").reduce((sum, group) => sum + group.entries.length, 0);
  /** Every cleaner and handyman an entry names, A to Z, for the filter. */
  const people = useMemo(() => {
    const byId = new Map<string, string>();
    for (const entry of entries) if (entry.cleaner.id !== null && !byId.has(entry.cleaner.id)) byId.set(entry.cleaner.id, cleanerLabel(entry));
    return [...byId.entries()].sort((a, b) => a[1].localeCompare(b[1], "en-CA"));
  }, [entries]);
  const kindCounts = useMemo(
    () => ({
      receipt: entries.filter((e) => e.kind !== "work" && e.kind !== "office").length,
      work: entries.filter((e) => e.kind === "work").length,
      office: entries.filter((e) => e.kind === "office").length,
    }),
    [entries],
  );
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
  const waiting = oneProperty
    ? entries.filter((entry) => entry.property.id === filters.propertyId && entry.status === "pending").length
    : 0;
  const selected = selectedId === null ? null : (entries.find((entry) => entry.id === selectedId) ?? null);
  const today = torontoDayOf(new Date());

  /** The open entry's property has its statements read once (dispatch 23D). */
  const selectedPropertyId = selected?.property.id ?? null;
  useEffect(() => {
    if (selectedPropertyId !== null && selectedPropertyId !== "" && !requestedStatements.current.has(selectedPropertyId)) loadStatements(selectedPropertyId);
  }, [selectedPropertyId, loadStatements, attempt]);
  /** Every cleaner's last 90 days, read from the entries (dispatch 24); the ones worth a look head the queue. */
  const patterns = useMemo(() => watchList(entries, today), [entries, today]);
  const worthALook = useMemo(() => patterns.filter((pattern) => pattern.worthALook), [patterns]);

  const setFilter = (change: Partial<CostFilters>) => setFilters((was) => ({ ...was, ...change }));

  /** Mark one entry, or every entry in the group, as seen: one call each, the list changing only to what the server returns. */
  const markSeen = async (targets: CostEntryView[]) => {
    if (marking !== null || targets.length === 0) return;
    clear();
    setMarking(targets.length === 1 ? targets[0].id : "all");
    let done = 0;
    let failed: string | null = null;
    for (const entry of targets) {
      const result = await markEntrySeen(entry.id, { seen: entry.history?.length ?? 0 });
      if (result.ok) {
        replaceEntry(result.data.entry);
        done += 1;
      } else {
        failed = result.unknown ? `${result.title} It may or may not have been saved: Refresh to see.` : `${result.title}${result.detail ? ` ${result.detail}` : ""}`;
        break;
      }
    }
    setMarking(null);
    if (failed !== null) {
      show({ tone: "error", title: `Marked ${done} of ${targets.length} as seen, then stopped.`, detail: failed });
    } else {
      show({ tone: "success", title: targets.length === 1 ? "Marked as seen." : `Marked ${done} entries as seen.`, detail: "Each is still approved and counts in its ledger; it has left the queue." });
    }
  };

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

    // A PDF goes to the owner, and an entry in it can still be corrected or
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
      {/* ── Header ── the shared one; this page's action is Refresh */}
      <AdminHeader current="costs" title={(ledger ? "Ledger" : "Costs")}>
        <button type="button" className={shared.btnGhost} onClick={reload} disabled={list.kind === "loading"}>
          <RefreshCw size={15} aria-hidden />
          <span>Refresh</span>
        </button>
      </AdminHeader>

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
                  Costs ledger · approved entries ·{" "}
                  <button type="button" className={styles.linkButton} onClick={() => setFilter({ status: NEEDS_ATTENTION })}>
                    Review queue{waiting > 0 ? ` (${waiting} waiting)` : ""}
                  </button>
                  {propertyName !== null && (
                    <>
                      {" · "}
                      <Link href={`/admin/property?id=${encodeURIComponent(filters.propertyId)}&tab=costs`} prefetch={false} className={styles.linkButton} title="The property's page: its costs by month, income, statement and preview">
                        Property page
                      </Link>
                    </>
                  )}
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
              <p
                className={styles.modeLine}
                title={
                  filters.status === NEEDS_ATTENTION
                    ? "Everything not yet approved, and every receipt approved automatically (under $200.00) that nobody has looked at. Approve an entry and it moves to its property's ledger; mark an automatic one seen and it leaves the queue; reject or remove an entry and it stays here, marked, at the bottom."
                    : undefined
                }
              >
                {filters.status === NEEDS_ATTENTION ? (
                  <>
                    <strong>Review queue</strong>
                    {oneProperty && <> · {propertyName ?? "Unknown property"}</>} · {toReview === 0 ? "nothing to review" : `${toReview} to review`}
                    {oneProperty && (
                      <>
                        {" · "}
                        <button type="button" className={styles.linkButton} onClick={() => setFilter({ status: "approved" })} title="Its approved entries, with the dates, totals and both exports">
                          Ledger
                        </button>
                      </>
                    )}
                  </>
                ) : (
                  <>Every entry, whatever its status.</>
                )}
              </p>
            )}

            {/* ── Worth a look (dispatch 24): only when the rule fires, only in the queue ── */}
            {filters.status === NEEDS_ATTENTION && worthALook.length > 0 && (
              <section className={styles.watchPanel} aria-label="Worth a look" role="status">
                <h2 className={styles.watchTitle}>
                  <AlertTriangle size={15} aria-hidden />
                  <span>Worth a look</span>
                </h2>
                <p className={styles.note}>
                  Receipts under $200.00 are approved automatically. In the last 90 days these cleaners’ receipts cluster just under
                  that line, or split one day’s spend into several receipts. A reading of the record, not a finding: open their
                  entries and decide.
                </p>
                <ul className={styles.watchList}>
                  {worthALook.map((pattern) => (
                    <li key={pattern.cleanerId}>
                      <span>{worthALookText(pattern)}</span>
                      {pattern.splits.length > 0 && (
                        <ul className={styles.watchSplits}>
                          {pattern.splits.map((split) => (
                            <li key={`${split.day}-${split.propertyId ?? ""}`}>{splitText(split)}</li>
                          ))}
                        </ul>
                      )}
                      <button
                        type="button"
                        className={styles.linkButton}
                        onClick={() => setFilter({ cleanerId: pattern.cleanerId, kind: "receipt" })}
                        disabled={filters.cleanerId === pattern.cleanerId}
                      >
                        {filters.cleanerId === pattern.cleanerId ? "Showing their entries" : "Show their entries in the queue"}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* ── Filters ── */}
            <section className={styles.filters} aria-label="Filters">
              <div className={styles.filterRow}>
                <AdminSelect
                  label="Property"
                  className={styles.propertySelect}
                  value={filters.propertyId}
                  onChange={(propertyId) => setFilter({ propertyId })}
                  groups={[
                    {
                      options: [
                        { value: "", label: "All properties" },
                        ...(oneProperty && propertyName === null ? [{ value: filters.propertyId, label: "Unknown property" }] : []),
                      ],
                    },
                    { label: "With cost entries", options: properties.withEntries.map(([id, label]) => ({ value: id, label })) },
                    { label: "No cost entries yet", options: properties.withoutEntries.map(([id, label]) => ({ value: id, label })) },
                  ]}
                />
                <AdminSelect
                  label="Status"
                  value={filters.status}
                  onChange={(status) => setFilter({ status })}
                  groups={[
                    {
                      options: [
                        {
                          value: NEEDS_ATTENTION,
                          label: `Needs attention (${inScope.filter(inQueue).length})`,
                        },
                        { value: "", label: `All statuses (${inScope.length})` },
                        ...ENTRY_STATUSES.map((status) => ({
                          value: status,
                          label: `${ENTRY_STATUS_LABELS[status]} (${statusCounts.get(status) ?? 0})`,
                        })),
                      ],
                    },
                  ]}
                />
                <AdminSelect
                  label="Kind"
                  value={filters.kind}
                  onChange={(kind) => setFilter({ kind })}
                  groups={[
                    {
                      options: [
                        { value: "", label: "Every kind" },
                        { value: "receipt", label: `Receipts (${kindCounts.receipt})` },
                        { value: "work", label: `Work (${kindCounts.work})` },
                        { value: "office", label: `Added by the office (${kindCounts.office})` },
                      ],
                    },
                  ]}
                />
                <AdminSelect
                  label="Logged by"
                  value={filters.cleanerId}
                  onChange={(cleanerId) => setFilter({ cleanerId })}
                  groups={[
                    {
                      options: [
                        { value: "", label: "Everyone" },
                        ...(filters.cleanerId !== "" && !people.some(([id]) => id === filters.cleanerId) ? [{ value: filters.cleanerId, label: "Unknown account" }] : []),
                        ...people.map(([id, label]) => ({ value: id, label })),
                      ],
                    },
                  ]}
                />
                <DateRangeField
                  label="Dates"
                  from={filters.from}
                  to={filters.to}
                  max={today}
                  onChange={(range) => setFilter(range)}
                  presets={RANGE_PRESETS.map((preset) => ({ ...preset, ...presetRange(preset.key, today) }))}
                  note="Dates are the day an entry was sent, in Toronto time."
                />
                <span className={shared.resultCount}>
                  {visible.length} of {inScope.length}
                </span>
              </div>
            </section>

            {/* ── A ledger's line: its totals and its two exports, over its entries ── */}
            {ledger && (
              /* On the property's page: one line, and the two exports beside it. */
              <section className={styles.summaryRow} aria-label="Totals">
                <span className={styles.summaryText}>
                  {visible.length === 0
                    ? "No approved costs in these dates."
                    : `${totals.all.entries === 1 ? "1 approved entry" : `${totals.all.entries} approved entries`} · ${formatCents(totals.all.approvedCents)}${totals.all.approvedTaxCents > 0 ? ` · tax ${formatCents(totals.all.approvedTaxCents)}` : ""}`}
                  {totals.all.unreadable > 0 && <span className={styles.noteWarn}> · {totals.all.unreadable} cannot be added up</span>}
                </span>
                {propertyName !== null && (
                  <span className={styles.formRow}>
                    <button type="button" className={styles.btnGhost} disabled={recording} onClick={() => exportReport("xlsx")} title="Approved entries in these dates, as a workbook">
                      <FileSpreadsheet size={15} aria-hidden />
                      <span>Excel</span>
                    </button>
                    <button type="button" className={styles.btnGhost} disabled={recording} onClick={() => exportReport("pdf")} title="For the owner: approved entries in these dates, no names. Recorded, so a later correction shows against it.">
                      <FileText size={15} aria-hidden />
                      <span>{recording ? "Recording…" : "PDF"}</span>
                    </button>
                  </span>
                )}
              </section>
            )}

            {/* ── The property's PDFs that list an entry since deleted outright (dispatch 23H) ── */}
            {ledger &&
              deletedSincePdf(pdfs.records, entries, filters.propertyId).map(({ record, printed }) => (
                <p key={record.id} className={styles.noteWarn} role="status">
                  The PDF exported {whenText(record.createdAt)} for {periodLabel(record.from, record.to)} lists{" "}
                  {printed.length === 1 ? "an entry" : `${printed.length} entries`} since deleted, at{" "}
                  {formatCents(printed.reduce((sum, entry) => sum + entry.totalCents, 0))}: whoever received it holds a total that includes{" "}
                  {printed.length === 1 ? "it" : "them"}.
                </p>
              ))}

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

            <div className={`${styles.layout} ${selectedId === null ? styles.layoutWide : styles.layoutOpen}`}>
              {/* ── List ── */}
              <section className={styles.listPane} aria-label={showing === "items" ? "Items bought" : "Entries"}>
                {visible.length === 0 && ledger ? (
                  <div className={shared.empty}>
                    <Receipt size={48} strokeWidth={1} />
                    <h2>No approved costs in these dates</h2>
                    {waiting > 0 && (
                      <p>
                        <button type="button" className={styles.linkButton} onClick={() => setFilter({ status: NEEDS_ATTENTION })}>
                          {waiting === 1 ? "1 entry is" : `${waiting} entries are`} waiting in the review queue
                        </button>
                      </p>
                    )}
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
                    {/* One line per entry: every column as wide as its widest entry, the property — or, for one
                        property, who logged it — taking what is left (2026-10-02). */}
                    <table className={`${shared.table} ${styles.entryTable}`}>
                      <thead>
                        <tr>
                          <th className={styles.colFit}>Sent</th>
                          {/* With one property chosen every row is that property's: its name is in the heading or the filter. */}
                          {!oneProperty && <th className={styles.colFlex}>Property</th>}
                          <th className={oneProperty ? styles.colFlex : styles.colFit}>Logged by</th>
                          <th className={`${styles.colFit} ${styles.num}`}>Total</th>
                          <th className={styles.colFit}>Status</th>
                          <th className={`${styles.colFit} ${styles.colCenter} ${styles.colReceipt}`}>Receipt</th>
                        </tr>
                      </thead>
                      <tbody>
                        {groups.map((group) => (
                          <Fragment key={group.key}>
                            {/* In the queue, each group under its heading: what needs review first, the decided last. */}
                            {group.key !== "all" && (
                              <tr className={styles.groupRow}>
                                <td colSpan={oneProperty ? 5 : 6}>
                                  <span className={styles.groupTitle}>
                                    {group.key === "unseen" ? "Approved automatically, not yet looked at" : group.key === "decide" ? "Needs a decision" : "Rejected or removed"} ({group.entries.length})
                                  </span>
                                  {group.key === "unseen" && (
                                    <button
                                      type="button"
                                      className={styles.btnGhost}
                                      disabled={marking !== null}
                                      onClick={() => markSeen(unseen)}
                                      title="Each already counts in its ledger. Seen takes it out of the queue; so does correcting, removing or rejecting it."
                                    >
                                      <Eye size={14} aria-hidden />
                                      <span>{marking === "all" ? "Marking…" : `Mark all ${unseen.length} as seen`}</span>
                                    </button>
                                  )}
                                  {group.key === "decided" && <span className={styles.note}>Kept on record; counted nowhere.</span>}
                                </td>
                              </tr>
                            )}
                            {group.entries.map((entry) => (
                              <EntryRow
                                key={entry.id}
                                entry={entry}
                                isOpen={entry.id === selectedId}
                                showProperty={!oneProperty}
                                pdf={pdfStates.get(entry.id) ?? null}
                                seen={group.key === "unseen" ? { marking: marking !== null, busy: marking === entry.id, onSeen: () => markSeen([entry]) } : null}
                                onOpen={open}
                              />
                            ))}
                          </Fragment>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              {/* ── The open entry: beside the list only when one is open, so the table has the width otherwise ── */}
              {selectedId !== null && (
                <aside ref={detailRef} className={styles.detailPane} aria-label="Entry">
                  {selected ? (
                    <EntryPane
                      key={selected.id}
                      entry={selected}
                      pdf={pdfStates.get(selected.id) ?? null}
                      pattern={selected.cleaner.id === null ? null : (patterns.find((pattern) => pattern.cleanerId === selected.cleaner.id) ?? null)}
                      statements={selected.property.id === null ? null : (statementsByProperty[selected.property.id] ?? { kind: "loading" })}
                      onChanged={replaceEntry}
                      onDeleted={dropEntry}
                      onClose={closePane}
                    />
                  ) : (
                    <div className={styles.detailState}>
                      <p>This entry is not in the list. It may have been opened from an old link.</p>
                      <button type="button" className={styles.btnGhost} onClick={closePane}>
                        Close
                      </button>
                    </div>
                  )}
                </aside>
              )}
            </div>

            {/* ── Totals for what is shown, and the reports: at the bottom, under the entries (Kian, 2026-10-02) ── */}
            {!ledger && (
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
                      Approved entries only. The PDF is for the owner and names no cleaner; each PDF is recorded, so a
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
            )}
          </>
        )}
      </main>
    </div>
  );
}

/**
 * One entry, one line (2026-10-02): when it was sent, the property (cut to
 * the column, its whole name on hover), who logged it with a one-word kind,
 * the total with its PDF mark under it, the status, and whether a receipt
 * photo came with it. A click anywhere opens it in the pane.
 */
function EntryRow({
  entry,
  isOpen,
  showProperty,
  pdf,
  seen,
  onOpen,
}: {
  entry: CostEntryView;
  isOpen: boolean;
  showProperty: boolean;
  pdf: EntryPdfState | null;
  /** In the queue's first group: the Seen button, and whether a mark is under way. */
  seen: { marking: boolean; busy: boolean; onSeen: () => void } | null;
  onOpen: (id: string) => void;
}) {
  const property = propertyLabel(entry);
  const who = cleanerLabel(entry);
  return (
    <tr className={`${styles.row} ${isOpen ? styles.rowOpen : ""} ${countsInTotals(entry.status) ? "" : styles.rowOut}`} onClick={() => onOpen(entry.id)}>
      <td className={`${styles.whenCell} ${styles.colFit}`}>
        <button
          type="button"
          className={styles.rowButton}
          aria-current={isOpen ? "true" : undefined}
          onClick={(e) => {
            e.stopPropagation();
            onOpen(entry.id);
          }}
        >
          <SentAt iso={entry.createdAt} />
        </button>
      </td>
      {showProperty && (
        <td className={`${styles.colFlex} ${styles.textCell}`}>
          <span className={styles.oneLine} title={property}>
            {property}
          </span>
        </td>
      )}
      <td className={`${showProperty ? styles.colFit : styles.colFlex} ${styles.textCell}`}>
        <span className={styles.who}>
          <span className={styles.oneLine} title={who}>
            {who}
          </span>
          <span className={styles.kindSlot}>
            <KindBadge kind={entry.kind} compact />
          </span>
        </span>
      </td>
      <td className={`${styles.colFit} ${styles.num}`}>
        <TotalCell entry={entry} />
        {/* Under the total it is about, so it is in view wherever the total is. */}
        <PdfMark state={pdf} />
      </td>
      <td className={styles.colFit}>
        <span className={styles.statusCell}>
          <EntryStatusBadge status={entry.status} auto={entry.autoApproved !== null} />
          {seen && (
            <button
              type="button"
              className={styles.lineAction}
              disabled={seen.marking}
              onClick={(e) => {
                e.stopPropagation();
                seen.onSeen();
              }}
              aria-label="Mark as seen"
            >
              {seen.busy ? "Marking…" : "Seen"}
            </button>
          )}
        </span>
      </td>
      <td className={`${styles.colFit} ${styles.colCenter} ${styles.colReceipt}`}>
        {entry.receipts !== null && entry.receipts.length > 0 ? (
          <ImageIcon size={16} className={styles.receiptIcon} aria-label="Receipt photo" />
        ) : entry.kind === "work" ? (
          <span className={styles.muted} title="A handyman's work entry has no receipt" aria-label="No receipt: handyman work">
            —
          </span>
        ) : entry.kind === "office" ? (
          <span className={styles.muted} title="Added by the office: a description and an amount, no receipt" aria-label="No receipt: added by the office">
            —
          </span>
        ) : (
          <Absent label="None" />
        )}
      </td>
    </tr>
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

/** An entry's total as it now counts, marked when corrected; struck through when it does not count. Its items and tax are its tooltip. */
function TotalCell({ entry }: { entry: CostEntryView }) {
  const now = entry.linesNow;
  if (now.kind !== "ok") {
    return (
      <span className={`${styles.badge} ${styles.badgeOdd}`} title={now.reason}>
        Cannot add up
      </span>
    );
  }
  const tax = now.taxShape === "in-lines" ? "tax among the items (sent before tax was its own field)" : now.taxCents === null ? "no tax" : `tax ${formatCents(now.taxCents)}`;
  return (
    <span className={styles.totalCell} title={`Items ${formatCents(now.itemsCents)} · ${tax}`}>
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
