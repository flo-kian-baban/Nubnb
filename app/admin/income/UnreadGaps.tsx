"use client";

/**
 * The rows of the month's files that became no line (Kian's ruling of 2026-11-01): the first gap on the Income page.
 * A row with no confirmation code, in a currency other than CAD, with no listing, no amount or no type is listed with
 * its amount in its own currency and why, until an admin decides it:
 *   - Place with a typed line: the line is typed on the property's statement for the row's month as any line is
 *     (its page's Income tab); here the admin names the property and that line, and Nubnb records which line holds it.
 *   - Not Nubnb's money: with a reason, recorded with who and when.
 * Each asks first in Nubnb's own dialog. Nothing here writes a statement: the typed line is what reaches the owner.
 */

import { useState } from "react";
import Link from "next/link";
import { AdminSelect } from "../components/AdminSelect";
import type { Question } from "../components/AskDialog";
import { formatCents } from "@/app/lib/cleaners/model";
import { torontoDayOf } from "@/app/lib/costs/report";
import { monthLabel, rangeText, type Line } from "@/app/lib/reports/model";
import { UNREAD_REASON_MAX, normaliseTitle, shortDay, unreadAmountWords, type EarningsUnreadView, type TitleLinkView } from "@/app/lib/income/model";
import { decideUnread, type IncomeResult } from "@/app/lib/income-client";
import styles from "./page.module.css";

type Options = { options: { value: string; label: string; hint?: string }[] }[];

interface Props {
  month: string;
  /** The month's rows not decided yet. */
  rows: EarningsUnreadView[];
  links: TitleLinkView[];
  /** The month's statements, for the typed lines a row can be placed with. */
  statements: { propertyId: string; lines: Line[] }[];
  propertyOptions: Options;
  names: Map<string, string>;
  fileNames: Map<string, string>;
  busy: string | null;
  setBusy: (busy: string | null) => void;
  ask: (question: Question) => Promise<boolean>;
  clear: () => void;
  show: (notice: { tone: "success" | "error" | "warning" | "info"; title: string; detail?: string }) => void;
  failed: (result: Extract<IncomeResult<unknown>, { ok: false }>, reloads: boolean) => void;
  onDecided: (row: EarningsUnreadView) => void;
}

/** "Nov 26 · Adjustment · Pine Loft · HM8…": the row as the file gives it. */
function rowWords(row: EarningsUnreadView): string {
  return [shortDay(row.payoutDate), row.type || "no type", row.listingTitle || "no listing", row.confirmationCode || null, rangeText(row.stay.start, row.stay.end) || null].filter(Boolean).join(" · ");
}

export function UnreadGaps({ month, rows, links, statements, propertyOptions, names, fileNames, busy, setBusy, ask, clear, show, failed, onDecided }: Props) {
  const [property, setProperty] = useState<Record<string, string>>({});
  const [line, setLine] = useState<Record<string, string>>({});
  const [reason, setReason] = useState<Record<string, string>>({});
  /** The property a row's title is linked to, if any: the place it starts from. */
  const linked = (row: EarningsUnreadView) => links.find((l) => l.platform === row.platform && l.title === normaliseTitle(row.listingTitle) && l.propertyId !== null)?.propertyId ?? "";
  const propertyOf = (row: EarningsUnreadView) => property[row.id] ?? linked(row);
  const typedLines = (propertyId: string) => statements.find((s) => s.propertyId === propertyId)?.lines.filter((l) => l.platformLineId === undefined) ?? [];

  const place = async (row: EarningsUnreadView) => {
    const propertyId = propertyOf(row);
    const chosen = typedLines(propertyId).find((l) => l.id === line[row.id]);
    if (busy || !propertyId || !chosen) return;
    const name = names.get(propertyId) ?? "the property";
    const yes = await ask({
      title: `Place this row with “${chosen.description}” on ${name}'s ${monthLabel(month)} statement?`,
      lines: [`The row: ${rowWords(row)}, ${unreadAmountWords(row)}, ${row.why}.`, `The typed line: ${formatCents(chosen.amountCents)}. It is what the statement prints; Nubnb records that it holds this row, and the row leaves the gaps.`],
      confirm: "Place it",
    });
    if (!yes) return;
    clear();
    setBusy(`unread:${row.id}`);
    const result = await decideUnread(row.id, { action: "place", seen: row.history.length, propertyId, lineId: chosen.id });
    setBusy(null);
    if (!result.ok) {
      failed(result, result.status === 409);
      return;
    }
    onDecided(result.data.unread);
    show({ tone: "success", title: `Placed on ${name}'s ${monthLabel(month)} statement with “${chosen.description}”, ${formatCents(chosen.amountCents)}.` });
  };

  const notOurs = async (row: EarningsUnreadView) => {
    const why = (reason[row.id] ?? "").replace(/\s+/g, " ").trim();
    if (busy || why === "") return;
    const yes = await ask({ title: "Mark this row not Nubnb's money?", lines: [`${rowWords(row)}, ${unreadAmountWords(row)}, ${row.why}.`, `Reason: “${why}”. It is recorded with your name, and the row leaves the gaps.`], confirm: "Mark it" });
    if (!yes) return;
    clear();
    setBusy(`unread:${row.id}`);
    const result = await decideUnread(row.id, { action: "not-ours", seen: row.history.length, reason: why });
    setBusy(null);
    if (!result.ok) {
      failed(result, result.status === 409);
      return;
    }
    onDecided(result.data.unread);
    show({ tone: "success", title: "Marked not Nubnb's money.", detail: `Reason: “${why}”.` });
  };

  return (
    <div className={styles.gapGroup} data-gap="unread">
      <h3 className={styles.gapHead} title="Kian's ruling of 2026-11-01: a row of the file that becomes no line is a gap until it is placed with a typed line or marked not Nubnb's money.">
        Rows not read from the file · {rows.length}
      </h3>
      <ul className={styles.gapList}>
        {rows.map((row) => {
          const propertyId = propertyOf(row);
          const lines = propertyId ? typedLines(propertyId) : [];
          const lineOptions = [{ options: [{ value: "", label: lines.length === 0 ? "No typed line yet" : "Choose its typed line" }, ...lines.map((l) => ({ value: l.id, label: `${l.description} · ${formatCents(l.amountCents)}` }))] }];
          const working = busy === `unread:${row.id}`;
          return (
            <li key={row.id} className={styles.gapItem} data-unread={row.id}>
              <span className={styles.gapWhat}>{rowWords(row)}</span>
              <span className={styles.gapFigures}>
                {unreadAmountWords(row)} · {row.why} · {fileNames.get(row.uploadId) ?? "a file"}, row {row.fileRow}
              </span>
              <span className={styles.linkForm}>
                <AdminSelect label={`Property for the row of ${shortDay(row.payoutDate)}, ${unreadAmountWords(row)}`} className={styles.propertySelect} value={propertyId} onChange={(value) => setProperty((was) => ({ ...was, [row.id]: value }))} groups={propertyOptions} searchable />
                {propertyId !== "" && <AdminSelect label={`Typed line for the row of ${shortDay(row.payoutDate)}, ${unreadAmountWords(row)}`} className={styles.propertySelect} value={line[row.id] ?? ""} onChange={(value) => setLine((was) => ({ ...was, [row.id]: value }))} groups={lineOptions} disabled={lines.length === 0} />}
                <button type="button" className={styles.btnGhost} disabled={busy !== null || propertyId === "" || !lines.some((l) => l.id === line[row.id])} onClick={() => void place(row)}>
                  {working ? "Placing…" : "Place with this line"}
                </button>
              </span>
              {propertyId !== "" && lines.length === 0 && (
                <span className={styles.muted}>
                  No typed line on its {monthLabel(month)} statement yet:{" "}
                  <Link href={`/admin/property?id=${encodeURIComponent(propertyId)}&month=${month}`} prefetch={false} className={styles.linkButton}>
                    type it there
                  </Link>
                  , then refresh this page.
                </span>
              )}
              <span className={styles.linkForm}>
                <input className={`${styles.textInput} ${styles.reasonInput}`} aria-label={`Why the row of ${shortDay(row.payoutDate)}, ${unreadAmountWords(row)}, is not Nubnb's money`} placeholder="Why it is not Nubnb's money" maxLength={UNREAD_REASON_MAX} value={reason[row.id] ?? ""} onChange={(e) => setReason((was) => ({ ...was, [row.id]: e.target.value }))} disabled={busy !== null} />
                <button type="button" className={styles.btnGhost} disabled={busy !== null || (reason[row.id] ?? "").trim() === ""} onClick={() => void notOurs(row)}>
                  {working ? "Marking…" : "Not Nubnb's money"}
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The month's rows that were decided, one line each: where each went, or why it is not Nubnb's money, with who and when. */
export function UnreadDecided({ rows, names }: { rows: EarningsUnreadView[]; names: Map<string, string> }) {
  if (rows.length === 0) return null;
  return (
    <ul className={styles.decidedList} aria-label="Rows not read, decided">
      {rows.map((row) => {
        const d = row.decision;
        if (!d) return null;
        const who = `${d.actor.name ?? "an admin"}, ${shortDay(torontoDayOf(new Date(d.at)))}`;
        return (
          <li key={row.id} className={styles.note}>
            {rowWords(row)}, {unreadAmountWords(row)}: {d.kind === "placed" ? `placed on ${names.get(d.propertyId) ?? "a deleted property"}'s ${monthLabel(d.month)} statement with “${d.description}”, ${formatCents(d.amountCents)}` : `not Nubnb's money: “${d.reason}”`} ({who})
          </li>
        );
      })}
    </ul>
  );
}
