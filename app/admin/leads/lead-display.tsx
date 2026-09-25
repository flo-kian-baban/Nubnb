/**
 * How the inbox shows a stored value.
 *
 * The rule throughout: a field the document does not have is shown as absent,
 * in words, and an empty string is shown as empty. Neither is ever a blank —
 * a blank cell reads as data.
 */

import {
  LEAD_SOURCE_LABELS,
  LEAD_STATUS_LABELS,
  isLeadStatus,
  type LeadSource,
  type LeadStatus,
  type NotificationState,
} from "@/app/lib/leads";
import styles from "./page.module.css";

export function Absent({ label = "Not recorded" }: { label?: string }) {
  return <span className={styles.absent}>{label}</span>;
}

/** Stored text, or an explicit marker when it is absent or empty. */
export function FieldText({ value }: { value: string | null }) {
  if (value === null) return <Absent />;
  if (value.trim() === "") return <Absent label="Empty" />;
  return <>{value}</>;
}

const SOURCE_CLASS: Record<LeadSource, string> = {
  property: styles.badgeStay,
  partner: styles.badgePartner,
  fund: styles.badgeFund,
  general: styles.badgeGeneral,
  unknown: styles.badgeUnknown,
};

export function SourceBadge({ source }: { source: LeadSource }) {
  return (
    <span className={`${styles.badge} ${SOURCE_CLASS[source]}`}>{LEAD_SOURCE_LABELS[source]}</span>
  );
}

const STATUS_CLASS: Record<LeadStatus, string> = {
  new: styles.badgeNew,
  answered: styles.badgeAnswered,
  closed: styles.badgeClosed,
};

/** A stored status. One outside the three is shown as stored, marked as unexpected. */
export function StatusBadge({ status }: { status: string | null }) {
  if (status === null) return <Absent />;
  if (isLeadStatus(status)) {
    return (
      <span className={`${styles.badge} ${STATUS_CLASS[status]}`}>{LEAD_STATUS_LABELS[status]}</span>
    );
  }
  return (
    <span
      className={`${styles.badge} ${styles.badgeOdd}`}
      title="Not one of new, answered or closed"
    >
      {status.trim() === "" ? "Empty" : status}
    </span>
  );
}

/**
 * The list's flag for a lead the team may never have heard about. Nothing is
 * shown for a lead that was emailed, or for one from before notifications
 * were recorded — the detail pane says which.
 */
export function NotificationFlag({ state }: { state: NotificationState }) {
  if (state === "failed") {
    return (
      <span className={`${styles.badge} ${styles.badgeUnnotified}`} title="The notification email failed">
        Not notified
      </span>
    );
  }
  if (state === "pending" || state === "unexpected") {
    return (
      <span
        className={`${styles.badge} ${styles.badgeOdd}`}
        title="No record that the notification email was sent"
      >
        Unconfirmed
      </span>
    );
  }
  return null;
}

/** A stored timestamp in the operator's local time. One that does not parse is shown as stored. */
export function When({ iso }: { iso: string | null }) {
  if (iso === null) return <Absent />;
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) {
    return <span title="Not a recognisable date">{iso.trim() === "" ? <Absent label="Empty" /> : iso}</span>;
  }
  return (
    <time dateTime={iso} title={iso}>
      {new Date(time).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" })}
    </time>
  );
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A yyyy-mm-dd stay date as a calendar date. Built from its parts rather than
 * parsed, which would read it as UTC midnight and show the day before in
 * Toronto. Anything else is shown exactly as stored.
 */
export function StayDate({ value }: { value: unknown }) {
  if (value === undefined || value === null) return <Absent />;
  if (typeof value !== "string") return <>{JSON.stringify(value)}</>;

  const match = ISO_DATE.exec(value);
  if (match) {
    const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const date = new Date(y, m - 1, d);
    // 2026-02-31 would roll over into March; show that as stored instead.
    if (date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d) {
      return (
        <time dateTime={value} title={value}>
          {date.toLocaleDateString("en-CA", {
            weekday: "short",
            month: "short",
            day: "numeric",
            year: "numeric",
          })}
        </time>
      );
    }
  }
  return value.trim() === "" ? <Absent label="Empty" /> : <>{value}</>;
}
