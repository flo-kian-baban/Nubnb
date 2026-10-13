"use client";

/**
 * Finishing a month's empty statements together, from the Statements panel
 * (dispatch 36, Kian's rulings of 2026-10-12). Each property still gets its
 * own statement, PDF and reference, the reference suggested from its last
 * one and editable here. Nothing finishes while any Airbnb title in the
 * month's file is neither linked nor set aside; the dialog says which, with
 * the way to the Income page. Properties left off the list are listed under
 * it, each with why, each a way to its page for the month.
 *
 * The list is the server's (GET /api/admin/monthly-reports/empty), read when
 * the dialog opens; the finish checks every property again.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { NoticeBanner, type Notice } from "./Notice";
import { StandingBadge, propertyMonthHref } from "./StatementStatus";
import { Dialog, TextInput, Tick } from "../property/editor/controls";
import { fetchEmptyMonth, finishEmptyMonth } from "@/app/lib/reports-client";
import { formatCents } from "@/app/lib/cleaners/model";
import { monthLabel, monthName, STATEMENT_LIMITS } from "@/app/lib/reports/model";
import type { EmptyFinishOutcome, EmptyMonth } from "@/app/lib/reports/empty";
import ed from "../property/editor/editor.module.css";
import styles from "./StatementsPanel.module.css";

const SESSION_HINT = "Your admin session may have expired — reload and sign in again.";

interface Props {
  month: string;
  onClose: () => void;
  /** Statements were finished (or may have been): the outcome, so the panel says it and reads again. */
  onFinished: (outcome: { results: EmptyFinishOutcome[]; names: Map<string, string> } | { unknown: Notice }) => void;
}

export function EmptyMonthDialog({ month, onClose, onFinished }: Props) {
  const [list, setList] = useState<EmptyMonth | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [references, setReferences] = useState<Map<string, string>>(new Map());
  const [busy, setBusy] = useState(false);
  const [reads, setReads] = useState(0);

  useEffect(() => {
    let live = true;
    fetchEmptyMonth(month).then((result) => {
      if (!live) return;
      if (!result.ok) {
        setNotice({ tone: "error", title: result.title, detail: [result.detail, result.status === 401 || result.status === 403 ? SESSION_HINT : null].filter(Boolean).join(" ") || undefined });
        return;
      }
      setList(result.data);
      setChosen(new Set(result.data.eligible.map((c) => c.propertyId)));
      setReferences(new Map(result.data.eligible.map((c) => [c.propertyId, c.reference ?? ""])));
    });
    return () => {
      live = false;
    };
  }, [month, reads]);

  const items = useMemo(() => (list?.eligible ?? []).filter((c) => chosen.has(c.propertyId)).map((c) => ({ propertyId: c.propertyId, reference: (references.get(c.propertyId) ?? "").trim() })), [list, chosen, references]);
  const missingReference = items.filter((item) => item.reference === "").length;
  const unsettled = list?.unsettled ?? [];
  const canFinish = list !== null && !busy && unsettled.length === 0 && items.length > 0 && missingReference === 0;

  const toggle = (propertyId: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(propertyId)) next.delete(propertyId);
      else next.add(propertyId);
      return next;
    });
  const allChosen = list !== null && list.eligible.length > 0 && list.eligible.every((c) => chosen.has(c.propertyId));

  const finish = async () => {
    if (!canFinish || !list) return;
    setBusy(true);
    setNotice(null);
    const result = await finishEmptyMonth(month, items);
    setBusy(false);
    if (result.ok) {
      onFinished({ results: result.data.results, names: new Map(list.eligible.map((c) => [c.propertyId, c.name])) });
      return;
    }
    const failure: Notice = { tone: "error", title: result.title, detail: [result.detail, result.status === 401 || result.status === 403 ? SESSION_HINT : null].filter(Boolean).join(" ") || undefined };
    if (result.unknown) {
      onFinished({ unknown: failure });
      return;
    }
    // Refused whole (a title unsettled since, the month not closed): nothing was finished; the list is read again.
    setNotice(failure);
    setList(null);
    setReads((n) => n + 1);
  };

  const count = items.length;
  return (
    <Dialog
      title={`Finish empty statements · ${monthLabel(month)}`}
      onClose={busy ? () => undefined : onClose}
      initialFocus="none"
      wide
      actions={
        <>
          <button type="button" className={`${ed.btn} ${ed.btnGhost}`} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className={`${ed.btn} ${ed.btnPrimary}`} onClick={finish} disabled={!canFinish}>
            {busy ? "Finishing…" : count === 1 ? "Finish 1 statement" : `Finish ${count} statements`}
          </button>
        </>
      }
    >
      <NoticeBanner notice={notice} className={styles.emptyNotice} />
      {list === null ? (
        notice === null && <p>Reading {monthLabel(month)}…</p>
      ) : (
        <>
          {unsettled.length > 0 && (
            <NoticeBanner
              className={styles.emptyNotice}
              notice={{
                tone: "warning",
                title: `Nothing can be finished: ${unsettled.length === 1 ? "1 title" : `${unsettled.length} titles`} in ${monthName(month)}'s Airbnb file ${unsettled.length === 1 ? "is" : "are"} neither linked nor set aside.`,
                items: unsettled.map((t) => `${t.title} · ${t.rows === 1 ? "1 row" : `${t.rows} rows`} · ${formatCents(t.amountCents)}`),
                action: { label: "Open the Income page", href: `/admin/income?month=${month}` },
              }}
            />
          )}

          {list.eligible.length === 0 ? (
            <p className={styles.emptyNone}>No property’s {monthName(month)} is empty and due.</p>
          ) : (
            <table className={styles.emptyTable}>
              <thead>
                <tr>
                  <th className={styles.emptyTick}>
                    <Tick
                      checked={allChosen}
                      label={allChosen ? "Choose none" : "Choose all"}
                      onChange={() => setChosen(allChosen ? new Set() : new Set(list.eligible.map((c) => c.propertyId)))}
                      disabled={busy}
                    />
                  </th>
                  <th>Property</th>
                  <th>Statement</th>
                  <th>Reference</th>
                </tr>
              </thead>
              <tbody>
                {list.eligible.map((c) => {
                  const on = chosen.has(c.propertyId);
                  const reference = references.get(c.propertyId) ?? "";
                  return (
                    <tr key={c.propertyId} className={on ? undefined : styles.emptyOff}>
                      <td className={styles.emptyTick}>
                        <Tick checked={on} label={`Finish ${c.name}`} onChange={() => toggle(c.propertyId)} disabled={busy} />
                      </td>
                      <td>
                        <Link href={propertyMonthHref(c.propertyId, month)} prefetch={false} className={styles.propertyLink}>
                          {c.name}
                        </Link>
                      </td>
                      <td>
                        <StandingBadge standing={c.standing} />
                      </td>
                      <td>
                        <TextInput
                          field={`reference.${c.propertyId}`}
                          value={reference}
                          onChange={(value) => setReferences((prev) => new Map(prev).set(c.propertyId, value))}
                          maxLength={STATEMENT_LIMITS.REFERENCE_MAX}
                          invalid={on && reference.trim() === ""}
                          placeholder="Reference"
                          aria-label={`Reference for ${c.name}`}
                          disabled={busy || !on}
                          className={styles.emptyRef}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {missingReference > 0 && <p className={styles.emptyWarn}>{missingReference === 1 ? "1 chosen statement has" : `${missingReference} chosen statements have`} no reference.</p>}

          {list.leftOut.length > 0 && (
            <section className={styles.emptyLeftOut} aria-label="Left out">
              <h3>Left out · {list.leftOut.length}</h3>
              <ul>
                {list.leftOut.map((row) => (
                  <li key={row.propertyId}>
                    <Link href={propertyMonthHref(row.propertyId, month)} prefetch={false} className={styles.propertyLink}>
                      {row.name}
                    </Link>
                    <span className={styles.note}>{row.why}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </Dialog>
  );
}
