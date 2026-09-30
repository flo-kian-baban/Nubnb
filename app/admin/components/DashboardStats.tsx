"use client";

/**
 * The four figures on the admin home (2026-09-30), each a link to where the
 * work is:
 *
 *   New leads                → the inbox, filtered to new     act on it
 *   Costs to review          → the costs queue                act on it
 *   Leads, last 30 days      → the inbox                      how demand is going
 *   Cleaning costs, <month>  → the costs page, this month     what cleaning is costing
 *
 * They replace four figures about the catalogue — total properties, average
 * nightly price, bedrooms, property types — that nothing could be done about
 * from here. The count of properties stays beside the list's filters. The
 * average price went for a plainer reason too: prices are set by admins and
 * no code computes one, an average included.
 *
 * Two reads, the same two the inbox and the costs page make on opening: the
 * lead list and the cost list. Each pair of tiles shows its own read's
 * state, so a failed read is shown as a failure, never as 0.
 *
 * "To review" is the pending entries: the ones still waiting for a decision.
 * (The queue's default view is wider — everything not approved — because
 * rejected and removed entries stay there, marked.) The month is the Toronto
 * calendar month, by the day each entry was sent, and it adds up what the
 * ledger adds up: approved and pending entries, as `countsInTotals` says.
 */

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight, CalendarDays, Inbox, Receipt, Wallet } from "lucide-react";
import { fetchLeads } from "@/app/lib/leads-client";
import { fetchCosts } from "@/app/lib/costs-client";
import { mayBeUnnotified, type LeadSummary } from "@/app/lib/leads";
import { ENTRY_TIME_ZONE, countsInTotals, dayIn, formatCents, type CostEntryView } from "@/app/lib/cleaners/model";
import { sentDay } from "@/app/lib/costs/report";
import styles from "../page.module.css";

type Read<T> = { kind: "loading" } | { kind: "ready"; data: T } | { kind: "error"; title: string };

const DAY_MS = 86_400_000;

/** What the lead list says: new ones (and how many of those nobody was told about), and the last two 30-day windows. */
function leadFigures(leads: LeadSummary[], now: number) {
  const fresh = leads.filter((lead) => lead.status === "new");
  const untold = fresh.filter((lead) => mayBeUnnotified(lead.notification)).length;
  const at = (lead: LeadSummary) => Date.parse(lead.createdAt ?? "");
  const since30 = now - 30 * DAY_MS;
  const since60 = now - 60 * DAY_MS;
  const last30 = leads.filter((lead) => {
    const t = at(lead);
    return Number.isFinite(t) && t >= since30;
  }).length;
  const previous30 = leads.filter((lead) => {
    const t = at(lead);
    return Number.isFinite(t) && t >= since60 && t < since30;
  }).length;
  return { fresh: fresh.length, untold, last30, previous30 };
}

const centsOf = (entry: CostEntryView) => (entry.linesNow.kind === "ok" ? entry.linesNow.totalCents : 0);

/** What the cost list says: what waits for a decision, and what this month has cost so far. */
function costFigures(entries: CostEntryView[]) {
  const pending = entries.filter((entry) => entry.status === "pending");
  const today = dayIn(ENTRY_TIME_ZONE);
  const month = today.slice(0, 7);
  const thisMonth = entries.filter((entry) => countsInTotals(entry.status) && (sentDay(entry.createdAt) ?? "").startsWith(month));
  return {
    pending: pending.length,
    pendingCents: pending.reduce((sum, entry) => sum + centsOf(entry), 0),
    /** Pending entries whose lines cannot be read: their amount is not in `pendingCents`. */
    pendingUnreadable: pending.filter((entry) => entry.linesNow.kind !== "ok").length,
    monthCents: thisMonth.reduce((sum, entry) => sum + centsOf(entry), 0),
    monthEntries: thisMonth.length,
    monthPendingCents: thisMonth.filter((entry) => entry.status === "pending").reduce((sum, entry) => sum + centsOf(entry), 0),
    monthStart: `${month}-01`,
    today,
  };
}

const monthName = (): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: ENTRY_TIME_ZONE, month: "long" }).format(new Date());

const plural = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

interface TileProps {
  href: string;
  icon: ReactNode;
  value: ReactNode;
  label: string;
  detail?: string | null;
  tone?: "accent" | "alert";
  busy?: boolean;
}

function Tile({ href, icon, value, label, detail, tone, busy }: TileProps) {
  const toneClass = tone === "accent" ? styles.statCardAccent : tone === "alert" ? styles.statCardAlert : "";
  return (
    <Link href={href} prefetch={false} className={`${styles.statCard} ${toneClass}`} aria-busy={busy || undefined}>
      <div className={styles.statIcon}>{icon}</div>
      <div className={styles.statContent}>
        <span className={styles.statValue}>{value}</span>
        <span className={styles.statLabel}>{label}</span>
        {detail && <span className={styles.statDetail}>{detail}</span>}
      </div>
      <ArrowRight size={16} className={styles.statArrow} aria-hidden />
    </Link>
  );
}

/** A tile for a read that failed: what could not be read, and the reason. */
function FailedTile({ href, label, title }: { href: string; label: string; title: string }) {
  return <Tile href={href} icon={<AlertTriangle size={20} />} value="Unavailable" label={label} detail={title} tone="alert" />;
}

export function DashboardStats() {
  const [leads, setLeads] = useState<Read<ReturnType<typeof leadFigures>>>({ kind: "loading" });
  const [costs, setCosts] = useState<Read<ReturnType<typeof costFigures>>>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetchLeads().then((result) => {
      if (cancelled) return;
      setLeads(result.ok ? { kind: "ready", data: leadFigures(result.data, Date.now()) } : { kind: "error", title: result.title });
    });
    fetchCosts().then((result) => {
      if (cancelled) return;
      setCosts(result.ok ? { kind: "ready", data: costFigures(result.data.entries) } : { kind: "error", title: result.title });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const month = monthName();

  return (
    <section className={styles.statsGrid} aria-label="At a glance">
      {leads.kind === "error" ? (
        <>
          <FailedTile href="/admin/leads?status=new" label="New leads could not be read" title={leads.title} />
          <FailedTile href="/admin/leads" label="Leads could not be read" title={leads.title} />
        </>
      ) : (
        <>
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
          <Tile
            href="/admin/leads"
            icon={<CalendarDays size={20} />}
            value={leads.kind === "ready" ? leads.data.last30 : "…"}
            label="Leads, last 30 days"
            detail={leads.kind === "ready" ? `${leads.data.previous30} in the 30 days before` : null}
            busy={leads.kind === "loading"}
          />
        </>
      )}

      {costs.kind === "error" ? (
        <>
          <FailedTile href="/admin/costs" label="Costs to review could not be read" title={costs.title} />
          <FailedTile href="/admin/costs" label={`Cleaning costs, ${month}, could not be read`} title={costs.title} />
        </>
      ) : (
        <>
          <Tile
            href="/admin/costs"
            icon={<Receipt size={20} />}
            value={costs.kind === "ready" ? costs.data.pending : "…"}
            label="Costs to review"
            detail={
              costs.kind === "ready"
                ? costs.data.pending === 0
                  ? "Nothing waiting"
                  : `${formatCents(costs.data.pendingCents)} waiting${costs.data.pendingUnreadable > 0 ? `, ${plural(costs.data.pendingUnreadable, "entry", "entries")} unreadable` : ""}`
                : null
            }
            tone={costs.kind === "ready" && costs.data.pending > 0 ? "accent" : undefined}
            busy={costs.kind === "loading"}
          />
          <Tile
            href={costs.kind === "ready" ? `/admin/costs?status=all&from=${costs.data.monthStart}&to=${costs.data.today}` : "/admin/costs"}
            icon={<Wallet size={20} />}
            value={costs.kind === "ready" ? formatCents(costs.data.monthCents) : "…"}
            label={`Cleaning costs, ${month}`}
            detail={
              costs.kind === "ready"
                ? costs.data.monthPendingCents > 0
                  ? `${plural(costs.data.monthEntries, "receipt", "receipts")} · ${formatCents(costs.data.monthPendingCents)} of it still to review`
                  : plural(costs.data.monthEntries, "receipt", "receipts")
                : null
            }
            busy={costs.kind === "loading"}
          />
        </>
      )}
    </section>
  );
}
