"use client";

/**
 * The four figures on the admin home (Kian's rulings of 2026-10-17, admin home, replacing those of 2026-10-02),
 * left to right, each a way to where the work is:
 *
 *   Statements due              → opens the statements panel     blocked · ready · finished
 *   Costs to review             → the costs queue                act on it
 *   New leads                   → the inbox, filtered to new     act on it
 *   Turnovers in the next 2 days → the Schedule                  how many need a cleaner
 *
 * Every figure is a count; none is an amount of money. The units count moved to the property table's header.
 *
 * Statements due counts every statement owed: the month due and every month past due, each blocked (Finish would
 * refuse it: its property has no Report For name) or ready; finished is the month due's finished statements. The
 * figures are `statementFigures`'s (app/lib/home/next-step.ts), over `reportingStatus` — the rule the list's
 * Statement column, its Next step and the panel use. A click opens the statements panel under the tiles (dispatch
 * 23F), the cross-property view, with a month control and one row per property; the panel and the list read the same
 * answer the tile does, GET /api/admin/monthly-reports, held by the page (`useStatements`). Which month the panel
 * shows is kept in the address bar (?statements=yyyy-mm) so a reload keeps it open.
 *
 * Turnovers counts the open cleaning jobs with a checkout today or tomorrow, and of them those with nobody on them,
 * from the read the list's Cleaning column makes (GET /api/admin/property-status), held by the page.
 *
 * "To review" is the pending entries plus, since dispatch 24, the receipts approved automatically that no admin has
 * looked at: what the queue holds for an admin. Its detail line counts the two, and names when a cleaner is worth a
 * look (costs/patterns.ts), in the same words as the queue.
 *
 * Each tile shows its own read's state, so a failed read is shown as a failure, never as 0.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight, ClipboardCheck, FileText, Inbox, Receipt } from "lucide-react";
import { fetchLeads } from "@/app/lib/leads-client";
import { fetchCosts } from "@/app/lib/costs-client";
import { fetchTracker, type TrackerData } from "@/app/lib/reports-client";
import { isMonth, lastClosedMonth, type ReportDownloadView } from "@/app/lib/reports/model";
import { reportingCounts, type ReportingStatus } from "@/app/lib/reports/statement";
import { StatementsPanel } from "./StatementsPanel";
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
  /** The tracker's read, held by the page (`useStatements`). */
  statements: StatementsRead;
  /** Every property's status from that read, by property ID — the same map the list's column draws; null until it has loaded. */
  statuses: Map<string, ReportingStatus> | null;
  /** Today, yyyy-mm-dd in Toronto. */
  today: string;
  /** Every statement owed, blocked and ready, and the month due's finished (`statementFigures`); null until the tracker has loaded. */
  figures: { due: number; blocked: number; ready: number; finished: number } | null;
  /** The jobs with a checkout today or tomorrow (`turnoverFigures`), from the page's status read. */
  turnovers: Read<{ count: number; needCleaner: number; from: string; to: string }>;
}

export function DashboardStats({ statements: read, statuses, today, figures, turnovers }: DashboardStatsProps) {
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

  /** Statements past due, for the tile's colour: red while any is. */
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
      {statements.kind === "error" ? (
        <Tile onClick={togglePanel} open={false} icon={<AlertTriangle size={20} />} value="Unavailable" label="Statements could not be read" detail={`${statements.title} Click to try again.`} tone="alert" />
      ) : (
        <Tile
          onClick={togglePanel}
          open={panelMonth !== null}
          icon={<FileText size={20} />}
          value={figures ? figures.due : "…"}
          label="Statements due"
          detail={figures ? `${figures.blocked} blocked · ${figures.ready} ready · ${figures.finished} finished` : null}
          tone={figures && statementCounts ? (figures.blocked > 0 || statementCounts.pastDue > 0 ? "alert" : figures.due > 0 ? "accent" : undefined) : undefined}
          busy={statements.kind === "loading"}
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

      {turnovers.kind === "error" ? (
        <FailedTile href="/admin/schedule" label="Turnovers could not be read" title={turnovers.title} />
      ) : (
        <Tile
          href="/admin/schedule"
          icon={<ClipboardCheck size={20} />}
          value={turnovers.kind === "ready" ? turnovers.data.count : "…"}
          label="Turnovers in the next 2 days"
          detail={
            turnovers.kind === "ready"
              ? turnovers.data.needCleaner > 0
                ? `${plural(turnovers.data.needCleaner, "needs a cleaner", "need a cleaner")}`
                : turnovers.data.count === 0
                  ? "None today or tomorrow"
                  : "Each has a cleaner"
              : null
          }
          tone={turnovers.kind === "ready" && turnovers.data.needCleaner > 0 ? "accent" : undefined}
          busy={turnovers.kind === "loading"}
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
