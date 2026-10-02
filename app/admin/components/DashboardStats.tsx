"use client";

/**
 * The four figures on the admin home (Kian's ruling of 2026-10-02), left to
 * right, each a way to where the work is:
 *
 *   Units                → the property list below          what the platform holds
 *   Costs to review      → the costs queue                  act on it
 *   New leads            → the inbox, filtered to new       act on it
 *   Statements past due  → opens the statements panel       which statements are owed
 *
 * Every figure is a count; none is an amount of money. They replace seven
 * (2026-09-30 to 2026-10-01): Leads in the last 30 days, Cleaning costs this
 * month and the two availability figures (Empty nights, Free this weekend)
 * are gone from the home. The Availability page still has both views.
 *
 * Units is every property document the page already holds — the list under
 * the tiles, delisted ones included (they stay listed, by Kian's ruling).
 *
 * The Statements tile is the one that stays on the page (dispatch 23F,
 * Kian's ruling of 2026-10-01): a click opens the statements panel under
 * the tiles — the cross-property view that was the Reports section — with
 * a month control, one row per property and each row the way into that
 * property's page for that month. Its figure is the statements past due in
 * Nubnb's cycle (dispatch 23G: months two or more back with no finished
 * statement), its detail the previous month's due and finished — every
 * number from `reportingStatus`, the rule the property list's column and
 * the panel use. The panel and the list read the same answer the tile does,
 * GET /api/admin/monthly-reports, held by the page (`useStatements`), so
 * neither costs a call more. Which month the panel shows is kept in the
 * address bar (?statements=yyyy-mm) so a reload keeps it open.
 *
 * Three reads besides the property list: the lead list, the cost list and
 * the tracker, the same ones the inbox, the costs page and the panel make.
 * Each tile shows its own read's state, so a failed read is shown as a
 * failure, never as 0.
 *
 * "To review" is the pending entries plus, since dispatch 24, the receipts
 * approved automatically that no admin has looked at: what the queue holds
 * for an admin. (The queue's default view is wider still — rejected and
 * removed entries stay there, marked.) Its detail line counts the two, and
 * names when a cleaner is worth a look (costs/patterns.ts), in the same
 * words as the queue.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight, Building2, FileText, Inbox, Receipt } from "lucide-react";
import { fetchLeads } from "@/app/lib/leads-client";
import { fetchCosts } from "@/app/lib/costs-client";
import { fetchTracker, type TrackerData } from "@/app/lib/reports-client";
import { isMonth, lastClosedMonth, monthLabel, type ReportDownloadView } from "@/app/lib/reports/model";
import { reportingCounts, type ReportingStatus } from "@/app/lib/reports/statement";
import { StatementsPanel } from "./StatementsPanel";
import type { Property } from "@/app/types/property";
import { mayBeUnnotified, type LeadSummary } from "@/app/lib/leads";
import { ENTRY_TIME_ZONE, awaitingLook, dayIn, type CostEntryView } from "@/app/lib/cleaners/model";
import { watchList } from "@/app/lib/costs/patterns";
import styles from "../page.module.css";

export type Read<T> = { kind: "loading" } | { kind: "ready"; data: T } | { kind: "error"; title: string };

/**
 * The tracker's one read (GET /api/admin/monthly-reports), held by the admin
 * home for the Statements tile, the panel and the property list's column.
 * Refresh reads it again and keeps what is shown until the answer comes; a
 * download link made from the panel adds its record without a read.
 */
export function useStatements() {
  const [statements, setStatements] = useState<Read<TrackerData>>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetchTracker().then((result) => {
      if (cancelled) return;
      setRefreshing(false);
      setStatements(result.ok ? { kind: "ready", data: result.data } : { kind: "error", title: result.title });
    });
    return () => {
      cancelled = true;
    };
  }, [attempt]);
  const refresh = useCallback(() => {
    setRefreshing(true);
    setStatements((prev) => (prev.kind === "error" ? { kind: "loading" } : prev));
    setAttempt((n) => n + 1);
  }, []);
  const downloaded = useCallback((record: ReportDownloadView) => {
    setStatements((prev) => (prev.kind === "ready" ? { kind: "ready", data: { ...prev.data, downloads: [...prev.data.downloads, record] } } : prev));
  }, []);
  return { statements, refresh, refreshing, downloaded };
}
export type StatementsRead = ReturnType<typeof useStatements>;

/** What the lead list says: the new ones, and how many of those nobody was told about. */
function leadFigures(leads: LeadSummary[]) {
  const fresh = leads.filter((lead) => lead.status === "new");
  const untold = fresh.filter((lead) => mayBeUnnotified(lead.notification)).length;
  return { fresh: fresh.length, untold };
}

/** What the cost list says waits for an admin: counts of entries, never their amounts. */
function costFigures(entries: CostEntryView[]) {
  const today = dayIn(ENTRY_TIME_ZONE);
  return {
    pending: entries.filter((entry) => entry.status === "pending").length,
    /** Approved automatically and not yet looked at (dispatch 24). */
    unseen: entries.filter(awaitingLook).length,
    /** Cleaners the pattern rule names. */
    worthALook: watchList(entries, today).filter((pattern) => pattern.worthALook).length,
  };
}

const plural = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

interface TileProps {
  /** Where the tile leads; with `onClick` instead, the tile is a button that opens something on this page. */
  href?: string;
  onClick?: () => void;
  /** For a button tile: whether what it opens is open. */
  open?: boolean;
  icon: ReactNode;
  value: ReactNode;
  label: string;
  detail?: string | null;
  tone?: "accent" | "alert";
  busy?: boolean;
}

function Tile({ href, onClick, open, icon, value, label, detail, tone, busy }: TileProps) {
  const toneClass = tone === "accent" ? styles.statCardAccent : tone === "alert" ? styles.statCardAlert : "";
  const body = (
    <>
      <div className={styles.statIcon}>{icon}</div>
      <div className={styles.statContent}>
        <span className={styles.statValue}>{value}</span>
        <span className={styles.statLabel}>{label}</span>
        {detail && <span className={styles.statDetail}>{detail}</span>}
      </div>
      <ArrowRight size={16} className={styles.statArrow} aria-hidden />
    </>
  );
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={`${styles.statCard} ${styles.statCardButton} ${toneClass} ${open ? styles.statCardOpen : ""}`} aria-busy={busy || undefined} aria-expanded={open}>
        {body}
      </button>
    );
  }
  return (
    <Link href={href ?? "/admin"} prefetch={false} className={`${styles.statCard} ${toneClass}`} aria-busy={busy || undefined}>
      {body}
    </Link>
  );
}

/** A tile for a read that failed: what could not be read, and the reason. */
function FailedTile({ href, label, title }: { href: string; label: string; title: string }) {
  return <Tile href={href} icon={<AlertTriangle size={20} />} value="Unavailable" label={label} detail={title} tone="alert" />;
}

interface DashboardStatsProps {
  /** The property list the page holds; null until it has loaded, or when it could not. */
  properties: Property[] | null;
  /** Why the property list could not be read; null when it was, or while it loads. */
  propertiesError: string | null;
  /** The tracker's read, held by the page (`useStatements`). */
  statements: StatementsRead;
  /** Every property's status from that read, by property ID — the same map the list's column draws; null until it has loaded. */
  statuses: Map<string, ReportingStatus> | null;
  /** Today, yyyy-mm-dd in Toronto. */
  today: string;
}

export function DashboardStats({ properties, propertiesError, statements: read, statuses, today }: DashboardStatsProps) {
  const [leads, setLeads] = useState<Read<ReturnType<typeof leadFigures>>>({ kind: "loading" });
  const [costs, setCosts] = useState<Read<ReturnType<typeof costFigures>>>({ kind: "loading" });
  const { statements, refresh: refreshStatements, refreshing, downloaded } = read;
  /** The panel's month when it is open, from the address bar; null while it is closed. */
  const [panelMonth, setPanelMonth] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const wanted = new URLSearchParams(window.location.search).get("statements");
    return isMonth(wanted) ? wanted : null;
  });

  // The panel's month in the address bar, so a reload keeps the panel open where it was.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (panelMonth === null) url.searchParams.delete("statements");
    else url.searchParams.set("statements", panelMonth);
    if (url.href !== window.location.href) window.history.replaceState(null, "", url.href);
  }, [panelMonth]);

  /** The tile's figures: every property's status, counted; whatever month the panel shows. */
  const statementCounts = useMemo(() => (statuses ? reportingCounts([...statuses.values()]) : null), [statuses]);
  const previousMonth = lastClosedMonth(today);
  const togglePanel = () => {
    if (statements.kind === "error") refreshStatements();
    setPanelMonth((was) => (was === null ? previousMonth : null));
  };

  useEffect(() => {
    let cancelled = false;
    fetchLeads().then((result) => {
      if (cancelled) return;
      setLeads(result.ok ? { kind: "ready", data: leadFigures(result.data) } : { kind: "error", title: result.title });
    });
    fetchCosts().then((result) => {
      if (cancelled) return;
      setCosts(result.ok ? { kind: "ready", data: costFigures(result.data.entries) } : { kind: "error", title: result.title });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
    <section className={styles.statsGrid} aria-label="At a glance">
      {propertiesError !== null ? (
        <FailedTile href="#properties" label="Units could not be read" title={propertiesError} />
      ) : (
        <Tile
          href="#properties"
          icon={<Building2 size={20} />}
          value={properties !== null ? properties.length : "…"}
          label="Units"
          busy={properties === null}
        />
      )}

      {costs.kind === "error" ? (
        <FailedTile href="/admin/costs" label="Costs to review could not be read" title={costs.title} />
      ) : (
        <Tile
          href="/admin/costs"
          icon={<Receipt size={20} />}
          value={costs.kind === "ready" ? costs.data.pending + costs.data.unseen : "…"}
          label="Costs to review"
          detail={
            costs.kind === "ready"
              ? [
                  costs.data.pending === 0 ? null : `${costs.data.pending} pending`,
                  costs.data.unseen === 0 ? null : `${costs.data.unseen} approved automatically, not yet seen`,
                  costs.data.worthALook === 0 ? null : `${plural(costs.data.worthALook, "cleaner", "cleaners")} worth a look`,
                ]
                  .filter(Boolean)
                  .join(" · ") || "Nothing waiting"
              : null
          }
          tone={costs.kind === "ready" && (costs.data.worthALook > 0 ? "alert" : costs.data.pending + costs.data.unseen > 0 ? "accent" : undefined) || undefined}
          busy={costs.kind === "loading"}
        />
      )}

      {leads.kind === "error" ? (
        <FailedTile href="/admin/leads?status=new" label="New leads could not be read" title={leads.title} />
      ) : (
        <Tile
          href="/admin/leads?status=new"
          icon={<Inbox size={20} />}
          value={leads.kind === "ready" ? leads.data.fresh : "…"}
          label="New leads"
          detail={
            leads.kind === "ready"
              ? leads.data.untold > 0
                ? `${plural(leads.data.untold, "of them was", "of them were")} never emailed to you`
                : leads.data.fresh === 0
                  ? "Nothing waiting"
                  : "Waiting for an answer"
              : null
          }
          tone={leads.kind === "ready" && leads.data.fresh > 0 ? "accent" : undefined}
          busy={leads.kind === "loading"}
        />
      )}

      {statements.kind === "error" ? (
        <Tile onClick={togglePanel} open={false} icon={<AlertTriangle size={20} />} value="Unavailable" label="Statements could not be read" detail={`${statements.title} Click to try again.`} tone="alert" />
      ) : (
        <Tile
          onClick={togglePanel}
          open={panelMonth !== null}
          icon={<FileText size={20} />}
          value={statementCounts ? statementCounts.pastDue : "…"}
          label="Statements past due"
          detail={
            statementCounts
              ? statementCounts.owed === 0 && statementCounts.pastDue === 0
                ? "None due yet"
                : `${monthLabel(previousMonth)}: ${statementCounts.due} due · ${statementCounts.finished} finished`
              : null
          }
          tone={statementCounts ? (statementCounts.pastDue > 0 ? "alert" : statementCounts.due > 0 ? "accent" : undefined) : undefined}
          busy={statements.kind === "loading"}
        />
      )}
    </section>

    {/* ── The statements panel (dispatch 23F): the tracker, under its tile ── */}
    {panelMonth !== null && statements.kind === "ready" && statuses && (
      <StatementsPanel
        data={statements.data}
        statuses={statuses}
        month={panelMonth}
        today={today}
        onMonth={setPanelMonth}
        onClose={() => setPanelMonth(null)}
        onRefresh={refreshStatements}
        refreshing={refreshing}
        onDownloaded={downloaded}
      />
    )}
    </>
  );
}
