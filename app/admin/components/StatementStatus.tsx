"use client";

/**
 * How a statement's standing is drawn (dispatch 23G): one badge per
 * standing, in one set of words (`STANDING_LABELS`) and one set of tones,
 * wherever it appears — the property list's column, the property page's head
 * and month control, the Finish tab's release status and the home panel.
 * What the standing is, `monthStanding` and `reportingStatus` decide
 * (app/lib/reports/statement.ts); nothing here does.
 */

import Link from "next/link";
import { monthLabel, monthName } from "@/app/lib/reports/model";
import { STANDING_LABELS, type ReportingStatus, type Standing } from "@/app/lib/reports/statement";
import shared from "../page.module.css";
import styles from "./StatementStatus.module.css";

export const STANDING_CLASS: Record<Standing, string> = {
  finished: shared.stateFinished,
  due: shared.stateDue,
  pastDue: shared.statePastDue,
  open: shared.stateOpen,
  notExpected: shared.stateOpen,
};

/** The property's page for a month: where its statement is written. */
export const propertyMonthHref = (propertyId: string, month: string) => `/admin/property?id=${encodeURIComponent(propertyId)}&month=${month}`;

export function StandingBadge({ standing, label }: { standing: Standing; label?: string }) {
  return <span className={`${shared.stateBadge} ${STANDING_CLASS[standing]}`}>{label ?? STANDING_LABELS[standing]}</span>;
}

/**
 * The property list's cell: the property's status as one badge and the
 * month in question, by name alone (Kian, 2026-10-02: "month is enough"),
 * the whole cell a link to the property's page at that month. The tooltip
 * keeps the year. Nothing due yet is the quiet words alone (the month in the
 * tooltip), so the rows that need work are the ones with colour.
 */
export function ReportingStatusCell({ propertyId, status }: { propertyId: string; status: ReportingStatus }) {
  const more = status.pastDue.length - 1;
  const title = [
    `${STANDING_LABELS[status.standing]}: ${monthLabel(status.month)}`,
    status.pastDue.length > 1 ? `Past due: ${status.pastDue.map(monthLabel).join(", ")}` : null,
    status.tone === "problem" && status.previous.standing === "due" ? `Due: ${monthLabel(status.previous.month)}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <Link href={propertyMonthHref(propertyId, status.month)} prefetch={false} className={styles.cell} title={title}>
      {status.tone === "none" ? (
        <span className={styles.quiet}>{STANDING_LABELS[status.standing]}</span>
      ) : (
        <>
          <span className={styles.badgeSlot}>
            <StandingBadge standing={status.standing} />
          </span>
          <span className={styles.month}>
            {monthName(status.month)}
            {more > 0 && <span className={styles.more}> +{more}</span>}
          </span>
        </>
      )}
    </Link>
  );
}

/**
 * The property page's head: every month that needs work, each a way to it —
 * the past-due months oldest first, then the previous month when it is due;
 * or the one month that says the property is done, or not due yet.
 */
export function ReportingStatusLine({ status, current, onMonth }: { status: ReportingStatus; current: string; onMonth: (month: string) => void }) {
  const monthButton = (month: string) => (
    <button key={month} type="button" className={styles.monthLink} onClick={() => onMonth(month)} disabled={month === current} aria-current={month === current ? "true" : undefined}>
      {monthLabel(month)}
    </button>
  );
  const groups: { standing: Standing; months: string[] }[] =
    status.tone === "problem" || status.tone === "warning"
      ? [
          ...(status.pastDue.length > 0 ? [{ standing: "pastDue" as const, months: status.pastDue }] : []),
          ...(status.previous.standing === "due" ? [{ standing: "due" as const, months: [status.previous.month] }] : []),
        ]
      : [{ standing: status.standing, months: [status.month] }];
  return (
    <div className={styles.line} role="status" aria-label="Statements">
      {groups.map((group) => (
        <span key={group.standing} className={styles.group}>
          {status.tone === "none" ? <span className={styles.quiet}>{STANDING_LABELS[group.standing]}</span> : <StandingBadge standing={group.standing} />}
          <span className={styles.months}>
            {group.months.map((month, i) => (
              <span key={month}>
                {i > 0 && ", "}
                {monthButton(month)}
              </span>
            ))}
          </span>
        </span>
      ))}
    </div>
  );
}
