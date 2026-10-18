"use client";

/**
 * The Costs page's Month tab (the Costs page, round 1): pick a month, then one row per property with anything for it,
 * from the month's money (dispatch 37A) as each property's statement preview shows it: what the statement charges for
 * costs — the month's own, late costs from earlier months, adjustments — what waits for a decision, and the cleanings
 * with no amount that go on it; a totals row; each row opens the property's page at that month. One read of the
 * month (GET /api/admin/cost-entries/month), again on Refresh or another month.
 *
 * It opens on the month before today's: the one being settled.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { fetchCostsMonth } from "@/app/lib/costs-client";
import { formatCents } from "@/app/lib/cleaners/model";
import { addMonths, monthLabel } from "@/app/lib/reports/model";
import type { CostsMonth, CostsMonthRow, Part } from "@/app/lib/costs/month-view";
import styles from "./MonthTab.module.css";

/** The answer for one ask (a month, a Refresh, a Retry): until the answer for the current ask comes, the month is loading. */
type State = { key: string } & ({ kind: "ready"; data: CostsMonth } | { kind: "error"; title: string; detail?: string });

const STANDING_WORDS: Record<CostsMonthRow["standing"], string> = { finished: "Finished", correcting: "Being corrected", open: "Open" };

/** A part's figure, quiet when there is none. */
function PartCell({ part, warn = false }: { part: Part; warn?: boolean }) {
  if (part.count === 0) return <td className={`${styles.num} ${styles.muted}`}>—</td>;
  return (
    <td className={`${styles.num} ${warn ? styles.warn : ""}`}>
      {formatCents(part.cents)}
      <span className={styles.count}>{part.count}</span>
    </td>
  );
}

export function MonthTab({ today, attempt }: { today: string; attempt: number }) {
  const thisMonth = today.slice(0, 7);
  const [month, setMonth] = useState(() => addMonths(thisMonth, -1));
  const [answer, setAnswer] = useState<State | null>(null);
  const [again, setAgain] = useState(0);
  const key = `${month}|${attempt}|${again}`;

  useEffect(() => {
    let cancelled = false;
    fetchCostsMonth(month).then((result) => {
      if (cancelled) return;
      setAnswer(result.ok ? { key: `${month}|${attempt}|${again}`, kind: "ready", data: result.data } : { key: `${month}|${attempt}|${again}`, kind: "error", title: result.title, detail: result.detail });
    });
    return () => {
      cancelled = true;
    };
  }, [month, attempt, again]);
  const state = answer !== null && answer.key === key ? answer : ({ kind: "loading" } as const);

  const label = monthLabel(month);
  return (
    <section className={styles.block} aria-label="Month">
      <div className={styles.bar}>
        <button type="button" className={styles.step} onClick={() => setMonth(addMonths(month, -1))} aria-label="The month before">
          <ChevronLeft size={16} aria-hidden />
        </button>
        <h2 className={styles.month}>{label}</h2>
        <button type="button" className={styles.step} onClick={() => setMonth(addMonths(month, 1))} disabled={month >= thisMonth} aria-label="The month after">
          <ChevronRight size={16} aria-hidden />
        </button>
        <span className={styles.caption}>Each property&apos;s {label} statement, as its preview shows it: costs only.</span>
      </div>

      {state.kind === "loading" ? (
        <p className={styles.muted}>Loading {label}…</p>
      ) : state.kind === "error" ? (
        <div className={styles.error} role="alert">
          <p>
            Could not load {label}: it is not empty, it has not loaded. {state.title}
            {state.detail ? ` ${state.detail}` : ""}
          </p>
          <button type="button" className={styles.retry} onClick={() => setAgain((n) => n + 1)}>
            <RefreshCw size={14} aria-hidden />
            <span>Retry</span>
          </button>
        </div>
      ) : state.data.rows.length === 0 ? (
        <p className={styles.muted}>No property has costs, late costs, adjustments, waiting entries or cleanings with no amount for {label}.</p>
      ) : (
        <div className={styles.scroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Property</th>
                <th className={styles.num}>Its own costs</th>
                <th className={styles.num}>From earlier months</th>
                <th className={styles.num}>Adjustments</th>
                <th className={styles.num}>Charged in all</th>
                <th className={styles.num}>Waiting for a decision</th>
                <th className={styles.num}>No amount yet</th>
              </tr>
            </thead>
            <tbody>
              {state.data.rows.map((row) => (
                <tr key={row.propertyId}>
                  <td className={styles.name}>
                    <Link href={`/admin/property?id=${encodeURIComponent(row.propertyId)}&month=${month}&tab=costs`} prefetch={false} className={styles.link}>
                      {row.name}
                    </Link>
                    <span className={styles.sub}>
                      {row.publicName && row.publicName !== row.name ? `${row.publicName} · ` : ""}
                      <span className={row.standing === "open" ? undefined : styles.tag}>{STANDING_WORDS[row.standing]}</span>
                      {row.unreadable.length > 0 && <span className={styles.warn}> · {row.unreadable.length === 1 ? "1 entry" : `${row.unreadable.length} entries`} cannot be added up</span>}
                    </span>
                  </td>
                  <PartCell part={row.own} />
                  <PartCell part={row.late} warn />
                  <PartCell part={row.adjustments} warn />
                  <td className={`${styles.num} ${styles.strong}`}>{formatCents(row.chargedCents)}</td>
                  <PartCell part={row.waiting} warn />
                  <td className={`${styles.num} ${row.noAmount > 0 ? styles.warn : styles.muted}`}>{row.noAmount > 0 ? row.noAmount : "—"}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td className={styles.strong}>
                  {state.data.rows.length === 1 ? "1 property" : `${state.data.rows.length} properties`}
                  <span className={styles.sub}>{state.data.quiet === 1 ? "1 other has nothing" : `${state.data.quiet} others have nothing`}</span>
                </td>
                <PartCell part={state.data.totals.own} />
                <PartCell part={state.data.totals.late} />
                <PartCell part={state.data.totals.adjustments} />
                <td className={`${styles.num} ${styles.strong}`}>{formatCents(state.data.totals.chargedCents)}</td>
                <PartCell part={state.data.totals.waiting} />
                <td className={`${styles.num} ${styles.strong}`}>{state.data.totals.noAmount > 0 ? state.data.totals.noAmount : "—"}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}
