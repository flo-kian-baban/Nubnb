/**
 * How the costs page shows a stored value, and reads what an admin types.
 *
 * The inbox's rule holds: a field the document does not have is said in
 * words, never left blank, and a value outside what is expected is shown as
 * stored, marked. Times are shown in Toronto time, the zone the page's date
 * filters use.
 */

import { Wrench } from "lucide-react";
import {
  ENTRY_STATUS_LABELS,
  formatCents,
  isEntryStatus,
  type EntryStatus,
  type LineView,
} from "@/app/lib/cleaners/model";
import { REPORT_TIME_ZONE } from "@/app/lib/costs/report";
import { Absent } from "../leads/lead-display";
import styles from "./page.module.css";

const STATUS_CLASS: Record<EntryStatus, string> = {
  pending: styles.badgePending,
  approved: styles.badgeApproved,
  rejected: styles.badgeRejected,
  removed: styles.badgeRemoved,
};

/**
 * A stored status. One outside the four is shown as stored, marked as
 * unexpected. `auto` marks an entry that was approved automatically
 * (dispatch 24): "Approved · auto" while it is approved, and a small "auto"
 * beside any later status, so the record stays visible.
 */
export function EntryStatusBadge({ status, auto = false }: { status: string | null; auto?: boolean }) {
  if (status === null) return <Absent />;
  if (isEntryStatus(status)) {
    return (
      <span className={`${styles.badge} ${STATUS_CLASS[status]}`} title={auto ? "Approved automatically: under $200.00 as sent" : undefined}>
        {ENTRY_STATUS_LABELS[status]}
        {auto && <span className={styles.badgeAuto}>· auto</span>}
      </span>
    );
  }
  return (
    <span className={`${styles.badge} ${styles.badgeOdd}`} title="Not one of pending, approved, rejected or removed">
      {status.trim() === "" ? "Empty" : status}
    </span>
  );
}

/** A work entry's mark (dispatch 24): nothing on a receipt; a stored kind outside the two shown as stored, marked. */
export function KindBadge({ kind }: { kind: string }) {
  if (kind === "receipt") return null;
  if (kind === "work") {
    return (
      <span className={`${styles.badge} ${styles.badgeWork}`} title="A handyman's work, at the price logged: no receipt">
        <Wrench size={11} aria-hidden /> Work
      </span>
    );
  }
  return (
    <span className={`${styles.badge} ${styles.badgeOdd}`} title="Not one of receipt or work">
      {kind.trim() === "" ? "Empty kind" : kind}
    </span>
  );
}

/** A status in a sentence: "pending", or a stored value as it is. */
export function statusWord(status: string | null): string {
  if (status === null) return "no status";
  return isEntryStatus(status) ? ENTRY_STATUS_LABELS[status].toLowerCase() : status;
}

const torontoTime = new Intl.DateTimeFormat("en-CA", {
  timeZone: REPORT_TIME_ZONE,
  dateStyle: "medium",
  timeStyle: "short",
});

const torontoTimeToTheSecond = new Intl.DateTimeFormat("en-CA", {
  timeZone: REPORT_TIME_ZONE,
  dateStyle: "medium",
  timeStyle: "medium",
});

/**
 * A stored timestamp, in Toronto time. One that does not parse is shown as
 * stored. `seconds` writes the time to the second, for the times PDFs were
 * exported: two made in the same minute must not read alike.
 */
export function SentAt({ iso, seconds = false }: { iso: string | null; seconds?: boolean }) {
  if (iso === null) return <Absent />;
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) {
    return <span title="Not a recognisable date">{iso.trim() === "" ? <Absent label="Empty" /> : iso}</span>;
  }
  return (
    <time dateTime={iso} title={iso}>
      {(seconds ? torontoTimeToTheSecond : torontoTime).format(time)}
    </time>
  );
}

/**
 * When a PDF was exported, as words for a sentence or a tooltip, in Toronto
 * time and to the second: "Sep 30, 2026, 11:42:07 a.m.". A timestamp that
 * does not parse is given as stored.
 */
export function whenText(iso: string | null): string {
  if (iso === null) return "at a time not recorded";
  const time = Date.parse(iso);
  return Number.isFinite(time) ? torontoTimeToTheSecond.format(time) : iso;
}

/** A quantity as text: a number as it is; anything else as stored. */
export function quantityText(quantity: number | string | null): string {
  if (quantity === null) return "—";
  return String(quantity);
}

/** An amount as stored: whole cents as dollars; anything else as stored. */
export function amountText(cents: number | string | null): string {
  if (cents === null) return "no amount";
  return typeof cents === "number" && Number.isSafeInteger(cents) ? formatCents(cents) : String(cents);
}

/** A line in one run of text, for the history: "Bleach 3.6 L · 2 · $7.98". */
export function lineText(line: LineView | null | undefined): string {
  if (!line) return "nothing recorded";
  return `${line.name ?? "no name"} · ${quantityText(line.quantity)} · ${amountText(line.lineTotalCents)}`;
}

/** Whole cents as the amount field shows them: 3798 → "37.98", -500 → "-5.00". */
export function amountField(cents: number): string {
  const abs = Math.abs(cents);
  const digits = `${(abs - (abs % 100)) / 100}.${String(abs % 100).padStart(2, "0")}`;
  return cents < 0 ? `-${digits}` : digits;
}

/**
 * An amount as typed, in the form the server reads — "7.98", "-5.00" — or
 * null if it is not one. "$8", "8", "-5" and "1,234.5" are all read; the
 * string is taken apart, never passed through a float.
 */
export function readAmount(typed: string): string | null {
  const match = /^(-?)(\d{0,6})(?:\.(\d{0,2}))?$/.exec(typed.replace(/[\s$,]/g, ""));
  if (!match || (match[2] === "" && (match[3] ?? "") === "")) return null;
  const whole = match[2].replace(/^0+(?=\d)/, "") || "0";
  const cents = (match[3] ?? "").padEnd(2, "0");
  const negative = match[1] === "-" && !(whole === "0" && cents === "00");
  return `${negative ? "-" : ""}${whole}.${cents}`;
}

/** A quantity as typed, in the form the server reads — "2", "1.5" — or null. It must be more than 0. */
export function readQuantity(typed: string): string | null {
  const match = /^(\d{1,5})(?:\.(\d{1,3}))?$/.exec(typed.trim());
  if (!match) return null;
  const whole = match[1].replace(/^0+(?=\d)/, "");
  const text = match[2] ? `${whole}.${match[2]}` : whole;
  return Number(text) > 0 ? text : null;
}
