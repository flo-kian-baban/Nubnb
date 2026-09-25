"use client";

/**
 * The lead inbox: every contact submission, newest first.
 *
 * Reads go through /api/leads behind the admin session; firestore.rules
 * denies the browser any access to contact_submissions. The one write — a
 * status change — is made from the detail pane.
 *
 * The status and source filters and the open lead are mirrored into the URL
 * (?status=, ?source=, ?lead=), so the dashboard can link straight to the new
 * leads and a reload reopens the same lead. The search box is not: it changes
 * on every keystroke.
 *
 * No pagination. The whole collection is one response; with three documents,
 * paging would only hide leads.
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, ArrowLeft, Home, Inbox, RefreshCw, Search, SlidersHorizontal } from "lucide-react";
import { PinGate } from "../components/PinGate";
import { fetchLeads, type LeadResult } from "@/app/lib/leads-client";
import {
  LEAD_SOURCES,
  LEAD_SOURCE_LABELS,
  LEAD_STATUSES,
  LEAD_STATUS_LABELS,
  isLeadSource,
  isLeadStatus,
  isRecordedSource,
  matchesLeadSearch,
  type LeadSource,
  type LeadStatus,
  type LeadSummary,
} from "@/app/lib/leads";
import { LeadDetailPane } from "./LeadDetailPane";
import { FieldText, SourceBadge, StatusBadge, When } from "./lead-display";
import shared from "../page.module.css";
import styles from "./page.module.css";

type ListState =
  | { kind: "loading" }
  | { kind: "ready"; leads: LeadSummary[] }
  | ({ kind: "error" } & Extract<LeadResult<unknown>, { ok: false }>);

export default function LeadsPage() {
  return (
    <PinGate>
      {/* useSearchParams needs a boundary on a statically rendered page. */}
      <Suspense fallback={null}>
        <LeadInbox />
      </Suspense>
    </PinGate>
  );
}

function LeadInbox() {
  const params = useSearchParams();

  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<LeadStatus | "all">(() => {
    const value = params.get("status");
    return isLeadStatus(value) ? value : "all";
  });
  const [sourceFilter, setSourceFilter] = useState<LeadSource | "all">(() => {
    const value = params.get("source");
    return isLeadSource(value) && isRecordedSource(value) ? value : "all";
  });
  const [selectedId, setSelectedId] = useState<string | null>(() => params.get("lead"));
  const detailRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetchLeads().then((result) => {
      if (cancelled) return;
      setList(result.ok ? { kind: "ready", leads: result.data } : { ...result, kind: "error" });
    });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  // Mirror the filters and the open lead into the address bar.
  useEffect(() => {
    const url = new URL(window.location.href);
    const set = (key: string, value: string | null) =>
      value === null ? url.searchParams.delete(key) : url.searchParams.set(key, value);
    set("status", statusFilter === "all" ? null : statusFilter);
    set("source", sourceFilter === "all" ? null : sourceFilter);
    set("lead", selectedId);
    if (url.href !== window.location.href) window.history.replaceState(null, "", url.href);
  }, [statusFilter, sourceFilter, selectedId]);

  const reload = () => {
    setList({ kind: "loading" });
    setAttempt((n) => n + 1);
  };

  const open = (id: string) => {
    setSelectedId(id);
    // On a narrow screen the pane sits below the list; bring it into view.
    requestAnimationFrame(() => detailRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  };

  const handleStatusChanged = useCallback((id: string, status: LeadStatus) => {
    setList((prev) =>
      prev.kind === "ready"
        ? { kind: "ready", leads: prev.leads.map((l) => (l.id === id ? { ...l, status } : l)) }
        : prev,
    );
  }, []);

  const handleClose = useCallback(() => setSelectedId(null), []);

  const leads = useMemo(() => (list.kind === "ready" ? list.leads : []), [list]);

  const visible = useMemo(
    () =>
      leads.filter(
        (lead) =>
          (statusFilter === "all" || lead.status === statusFilter) &&
          (sourceFilter === "all" || lead.source === sourceFilter) &&
          matchesLeadSearch(lead, query),
      ),
    [leads, statusFilter, sourceFilter, query],
  );

  const statusCounts = useMemo(() => countBy(leads, (l) => l.status), [leads]);
  const sourceCounts = useMemo(() => countBy(leads, (l) => l.source), [leads]);

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
            <h1>Leads</h1>
          </div>

          <div className={shared.headerRight}>
            <button
              type="button"
              className={styles.btnGhost}
              onClick={reload}
              disabled={list.kind === "loading"}
            >
              <RefreshCw size={15} />
              <span>Refresh</span>
            </button>
          </div>
        </div>
      </header>

      <main className={shared.main}>
        {list.kind === "loading" ? (
          <div className={shared.loading}>
            <div className={shared.spinner} />
            <p>Loading leads…</p>
          </div>
        ) : list.kind === "error" ? (
          /* A failed read is NOT an empty inbox. */
          <div className={`${shared.empty} ${shared.loadError}`} role="alert">
            <AlertTriangle size={48} strokeWidth={1} />
            <h2>Could not load leads</h2>
            <p>
              The inbox could not be read, so this page cannot show what is in it. It is not
              empty — it has not loaded.
              {(list.status === 401 || list.status === 403) &&
                " Your admin session may have expired — reload and sign in again."}
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
        ) : (
          <>
            {/* ── Search & Filters ── */}
            <section className={shared.toolbar}>
              <div className={shared.searchWrapper}>
                <Search size={16} className={shared.searchIcon} />
                <input
                  type="search"
                  className={shared.searchInput}
                  placeholder="Search by name, email or property…"
                  aria-label="Search leads by name, email or property"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>

              <div className={shared.filterGroup}>
                <div className={shared.filterItem}>
                  <SlidersHorizontal size={14} className={shared.filterIcon} />
                  <select
                    className={shared.filterSelect}
                    aria-label="Filter by status"
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value as LeadStatus | "all")}
                  >
                    <option value="all">All statuses</option>
                    {LEAD_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {LEAD_STATUS_LABELS[s]} ({statusCounts.get(s) ?? 0})
                      </option>
                    ))}
                  </select>
                </div>

                <div className={shared.filterItem}>
                  <select
                    className={shared.filterSelect}
                    aria-label="Filter by source"
                    value={sourceFilter}
                    onChange={(e) => setSourceFilter(e.target.value as LeadSource | "all")}
                  >
                    <option value="all">All sources</option>
                    {LEAD_SOURCES.map((s) =>
                      isRecordedSource(s) ? (
                        <option key={s} value={s}>
                          {LEAD_SOURCE_LABELS[s]} ({sourceCounts.get(s) ?? 0})
                        </option>
                      ) : (
                        <option
                          key={s}
                          value={s}
                          disabled
                          title="The contact form does not yet record that a message came from the Fund page"
                        >
                          {LEAD_SOURCE_LABELS[s]} (not recorded yet)
                        </option>
                      ),
                    )}
                  </select>
                </div>

                <span className={shared.resultCount}>
                  {visible.length} of {leads.length}
                </span>
              </div>
            </section>

            <div className={styles.layout}>
              {/* ── List ── */}
              <section className={styles.listPane} aria-label="Leads">
                {leads.length === 0 ? (
                  <div className={shared.empty}>
                    <Inbox size={48} strokeWidth={1} />
                    <h2>No leads yet</h2>
                    <p>The contact form has not stored any submissions.</p>
                  </div>
                ) : visible.length === 0 ? (
                  <div className={shared.empty}>
                    <Search size={48} strokeWidth={1} />
                    <h2>No matching leads</h2>
                    <p>Try another status, source or search.</p>
                  </div>
                ) : (
                  <div className={`${shared.tableContainer} ${styles.tableScroll}`}>
                    <table className={shared.table}>
                      <thead>
                        <tr>
                          <th>From</th>
                          <th>Received</th>
                          <th>Subject</th>
                          <th>Source</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visible.map((lead) => {
                          const isOpen = lead.id === selectedId;
                          return (
                            <tr
                              key={lead.id}
                              className={`${styles.row} ${isOpen ? styles.rowOpen : ""}`}
                              onClick={() => open(lead.id)}
                            >
                              <td>
                                <button
                                  type="button"
                                  className={styles.rowButton}
                                  aria-current={isOpen ? "true" : undefined}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    open(lead.id);
                                  }}
                                >
                                  <FieldText value={lead.name} />
                                </button>
                                <span className={styles.subline}>
                                  <FieldText value={lead.email} />
                                </span>
                              </td>
                              <td className={styles.whenCell}>
                                <When iso={lead.createdAt} />
                              </td>
                              <td className={styles.subjectCell}>
                                <FieldText value={lead.subject} />
                              </td>
                              <td>
                                <SourceBadge source={lead.source} />
                                {lead.source === "stay" && (
                                  <span className={styles.subline}>
                                    <FieldText value={lead.propertyName} />
                                  </span>
                                )}
                              </td>
                              <td>
                                <StatusBadge status={lead.status} />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              {/* ── Detail ── */}
              <aside ref={detailRef} className={styles.detailPane} aria-label="Lead">
                {selectedId ? (
                  <LeadDetailPane
                    key={selectedId}
                    id={selectedId}
                    onStatusChanged={handleStatusChanged}
                    onClose={handleClose}
                  />
                ) : (
                  <div className={styles.detailState}>
                    <Inbox size={28} strokeWidth={1.5} />
                    <p>Select a lead to read it.</p>
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

function countBy<T>(items: T[], key: (item: T) => string | null): Map<string | null, number> {
  const counts = new Map<string | null, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return counts;
}
