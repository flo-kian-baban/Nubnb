"use client";

/**
 * Income (dispatch 27, Kian's rulings of 2026-10-04): the one place income
 * comes in for all properties, beside Costs. One month at a time, the month
 * Airbnb paid it out; it opens on the month whose statements are being
 * written (the previous one).
 *
 *   Upload     the month's Airbnb transaction CSV. The upload types are a
 *              list (income/model.ts, INCOME_CHANNELS), so another channel
 *              is another entry there and another reader.
 *   Gaps       shown without anyone looking for them: titles not linked to a
 *              property, with their rows and total and a way to link them;
 *              properties with a check-in in the month on their calendar and
 *              no line for the month; linked titles missing from the month's
 *              file.
 *   To review  the proposed lines, by property: accept, edit and accept, or
 *              reject, one at a time, or accept a property's lines together.
 *              Rejected lines, and lines accepted and since removed from the
 *              statement, can be proposed again.
 *   By property  each property's lines for the month as its statement holds
 *              them, linking to its page.
 *   Titles     every listing title in the month's lines, its link, and a way
 *              to change a link.
 *
 * ── The same lines ──
 * An accepted line is an ordinary line of the property's statement draft,
 * which is what the property page's Income tab shows and the statement
 * prints; "By property" reads those drafts. Nothing is copied between the
 * two pages.
 *
 * One read on opening and on each month (GET /api/admin/income); each
 * decision is one call, and the page takes what the server answers. An
 * upload is followed by one read of the month. The month is mirrored into
 * the address bar (?month=).
 */

import { Fragment, Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, ChevronLeft, ChevronRight, FileText, RefreshCw, Upload } from "lucide-react";
import { AdminHeader } from "../components/AdminHeader";
import { AdminSelect } from "../components/AdminSelect";
import { PinGate } from "../components/PinGate";
import { NoticeBanner, useNotice } from "../components/Notice";
import { amountField, readAmount } from "../costs/cost-display";
import { formatCents } from "@/app/lib/cleaners/model";
import { torontoDayOf } from "@/app/lib/costs/report";
import { STATEMENTS_FROM_DEFAULT, STATEMENT_LIMITS, addMonths, dateText, isMonth, lastClosedMonth, monthLabel, monthOfDay, monthsBetween } from "@/app/lib/reports/model";
import { INCOME_CHANNEL_LABELS, proposedLabel, shortDay, type EarningsLineView, type EarningsUploadView } from "@/app/lib/income/model";
import { monthView, suggestedProperty, type ReviewGroup, type TitleRow } from "@/app/lib/income/month";
import { acceptIncomeLines, decideIncomeLine, fetchIncomeMonth, fetchUploadFileLink, linkTitle, uploadIncomeFile, type IncomeMonth, type IncomeResult } from "@/app/lib/income-client";
import shared from "../page.module.css";
import styles from "./page.module.css";

type Read<T> = { kind: "loading" } | { kind: "ready"; data: T } | { kind: "error"; title: string; detail?: string; status: number };

const SESSION_HINT = "Your admin session may have expired — reload and sign in again.";
/** The one upload type today (Kian, dispatch 27: built so others can be added). */
const CHANNEL = "airbnb" as const;

/** The line being edited before it is accepted. */
interface Editing {
  id: string;
  description: string;
  amount: string;
}

export default function IncomePage() {
  return (
    <PinGate>
      <Suspense fallback={null}>
        <IncomePageInner />
      </Suspense>
    </PinGate>
  );
}

/** "4 Oct, 16:20", Toronto time. */
function whenText(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("en-CA", { timeZone: "America/Toronto", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function IncomePageInner() {
  const params = useSearchParams();
  const today = torontoDayOf(new Date());
  const thisMonth = monthOfDay(today);
  const [month, setMonth] = useState(() => {
    const wanted = params.get("month");
    return isMonth(wanted) && wanted <= thisMonth ? wanted : lastClosedMonth(today);
  });
  const [read, setRead] = useState<Read<IncomeMonth>>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [changing, setChanging] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { notice, show, clear } = useNotice();

  // ── The read: on opening, on each month, on Refresh and after an upload ──
  useEffect(() => {
    let cancelled = false;
    fetchIncomeMonth(month).then((result) => {
      if (cancelled) return;
      setRead(result.ok ? { kind: "ready", data: result.data } : { kind: "error", title: result.title, detail: result.detail, status: result.status });
    });
    return () => {
      cancelled = true;
    };
  }, [month, attempt]);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("month", month);
    if (url.href !== window.location.href) window.history.replaceState(null, "", url.href);
  }, [month]);

  const changeMonth = (next: string) => {
    clear();
    setEditing(null);
    setChanging(null);
    setRead({ kind: "loading" });
    setMonth(next);
  };
  const reload = useCallback(() => {
    clear();
    setRead({ kind: "loading" });
    setAttempt((n) => n + 1);
  }, [clear]);
  /** Read the month again, keeping what is shown until the answer comes. */
  const reread = useCallback(() => setAttempt((n) => n + 1), []);

  const data = read.kind === "ready" ? read.data : null;
  const view = useMemo(() => (data ? monthView(data) : null), [data]);
  const names = useMemo(() => new Map((data?.properties ?? []).map((p) => [p.id, p.name])), [data]);
  const uploadName = useMemo(() => new Map((data?.uploads ?? []).map((u) => [u.id, u.file.name])), [data]);
  const propertyOptions = useMemo(() => [{ options: [{ value: "", label: "Choose a property" }, ...(data?.properties ?? []).map((p) => ({ value: p.id, label: p.name }))] }], [data]);
  const monthOptions = useMemo(() => [{ options: monthsBetween(STATEMENTS_FROM_DEFAULT < month ? STATEMENTS_FROM_DEFAULT : month, thisMonth).reverse().map((m) => ({ value: m, label: monthLabel(m) })) }], [month, thisMonth]);

  // ── What a write's failure says ──
  const failed = (result: Extract<IncomeResult<unknown>, { ok: false }>, reloads: boolean) => {
    if (result.unknown) {
      show({ tone: "warning", title: `${result.title} It may or may not have gone through; the page reads the month again.`, detail: result.detail });
      reread();
      return;
    }
    show({ tone: result.status === 409 ? "warning" : "error", title: result.title, detail: [result.detail, result.status === 401 || result.status === 403 ? SESSION_HINT : null].filter(Boolean).join(" ") || undefined });
    if (reloads) reread();
  };

  // ── Upload ──
  const upload = async (file: File) => {
    if (busy) return;
    clear();
    setBusy("upload");
    const result = await uploadIncomeFile(month, CHANNEL, file);
    setBusy(null);
    if (!result.ok) {
      if (result.code === "FILE_ALREADY_UPLOADED" && result.evidence) {
        const at = typeof result.evidence.uploadedAt === "string" ? whenText(result.evidence.uploadedAt) : "earlier";
        const was = typeof result.evidence.month === "string" && isMonth(result.evidence.month) ? monthLabel(result.evidence.month) : "a month";
        show({ tone: "warning", title: `This exact file was uploaded on ${at}, for ${was}. Nothing new was stored.` });
        return;
      }
      failed(result, false);
      return;
    }
    const { upload: done } = result.data;
    show({
      tone: done.read.balanced ? "success" : "warning",
      title: `Read ${plural(done.read.rows, "row", "rows")}: ${plural(done.added, "new line", "new lines")}, ${done.duplicates} already in.`,
      detail: done.read.balanced ? undefined : "The file does not add up: see the payouts named under it.",
    });
    reread();
  };

  // ── Accept, edit and accept, accept a property's lines ──
  const applyAccepted = (answer: { draft: { id: string; propertyId: string; revision: number; lines: IncomeMonth["statements"][number]["lines"] }; lines: EarningsLineView[] }) => {
    setRead((prev) => {
      if (prev.kind !== "ready") return prev;
      const byId = new Map(answer.lines.map((line) => [line.id, line]));
      const statement = { propertyId: answer.draft.propertyId, draftId: answer.draft.id, revision: answer.draft.revision, finished: false, lines: answer.draft.lines };
      const statements = prev.data.statements.some((s) => s.propertyId === statement.propertyId) ? prev.data.statements.map((s) => (s.propertyId === statement.propertyId ? statement : s)) : [...prev.data.statements, statement];
      return { kind: "ready", data: { ...prev.data, lines: prev.data.lines.map((line) => byId.get(line.id) ?? line), statements } };
    });
  };
  const accept = async (group: ReviewGroup, lines: { id: string; description?: string; amount?: string }[], key: string) => {
    if (busy) return;
    clear();
    setBusy(key);
    const result = await acceptIncomeLines({ propertyId: group.propertyId, month, lines });
    setBusy(null);
    if (!result.ok) {
      failed(result, result.status === 409);
      return;
    }
    applyAccepted(result.data);
    setEditing(null);
    show({ tone: "success", title: `${plural(result.data.lines.length, "line", "lines")} accepted into ${group.name}'s ${monthLabel(month)} statement.` });
  };
  const acceptEdited = (group: ReviewGroup, line: EarningsLineView) => async (event: FormEvent) => {
    event.preventDefault();
    if (!editing || editing.id !== line.id) return;
    const description = editing.description.normalize("NFC").replace(/\s+/g, " ").trim();
    const amount = readAmount(editing.amount);
    const problems = [
      description === "" || description.length > STATEMENT_LIMITS.LINE_DESCRIPTION_MAX ? `Describe the line, in at most ${STATEMENT_LIMITS.LINE_DESCRIPTION_MAX} characters.` : null,
      amount === null || amount === "0.00" ? "Check the amount: dollars and cents other than 0.00, negative for money taken back." : null,
    ].filter((p): p is string => p !== null);
    if (problems.length > 0 || amount === null) {
      show({ tone: "error", title: "The line was not accepted.", items: problems });
      return;
    }
    const sent: { id: string; description?: string; amount?: string } = { id: line.id };
    if (description !== proposedLabel(line)) sent.description = description;
    if (amount !== amountField(line.amountCents)) sent.amount = amount;
    await accept(group, [sent], `accept:${line.id}`);
  };

  // ── Reject, propose again ──
  const decide = async (line: EarningsLineView, action: "reject" | "propose-again") => {
    if (busy) return;
    clear();
    setBusy(`${action}:${line.id}`);
    const result = await decideIncomeLine(line.id, action);
    setBusy(null);
    if (!result.ok) {
      failed(result, result.status === 409);
      return;
    }
    const next = result.data.line;
    setRead((prev) => (prev.kind === "ready" ? { kind: "ready", data: { ...prev.data, lines: prev.data.lines.map((l) => (l.id === next.id ? next : l)) } } : prev));
    show({ tone: "success", title: action === "reject" ? "Rejected. It stays listed, and can be proposed again." : "Proposed again." });
  };

  // ── Link a title, or change its link ──
  const link = async (row: TitleRow, propertyId: string) => {
    if (busy || propertyId === "") return;
    clear();
    setBusy(`link:${row.title}`);
    const result = await linkTitle({ channel: row.platform, title: row.title, propertyId, expected: row.link?.propertyId ?? null });
    setBusy(null);
    if (!result.ok) {
      failed(result, result.status === 409);
      return;
    }
    const linked = result.data.link;
    setRead((prev) => (prev.kind === "ready" ? { kind: "ready", data: { ...prev.data, links: [...prev.data.links.filter((l) => l.id !== linked.id), linked].sort((a, b) => a.title.localeCompare(b.title)) } } : prev));
    setChanging(null);
    show({ tone: "success", title: `"${row.title}" is linked to ${names.get(propertyId) ?? "the property"}.` });
  };

  // ── The kept file ──
  const openFile = async (item: EarningsUploadView) => {
    if (busy) return;
    setBusy(`file:${item.id}`);
    const result = await fetchUploadFileLink(item.id);
    setBusy(null);
    if (!result.ok) {
      failed(result, false);
      return;
    }
    window.open(result.data.url, "_blank", "noopener");
  };

  const lineSub = (line: EarningsLineView) => [line.confirmationCode, line.stay.nights !== null ? plural(line.stay.nights, "night", "nights") : null].filter(Boolean).join(" · ");
  const fromText = (line: EarningsLineView) => `${uploadName.get(line.uploadId) ?? "an earlier file"} · row ${line.fileRow}`;
  const choiceFor = (row: TitleRow) => choices[`${row.platform}|${row.title}`] ?? (data ? (suggestedProperty(data.properties, row.title) ?? "") : "");
  const setChoice = (row: TitleRow, value: string) => setChoices((prev) => ({ ...prev, [`${row.platform}|${row.title}`]: value }));

  const loading = read.kind === "loading";
  const gapCount = view ? view.gaps.unlinked.length + view.gaps.checkIns.length + view.gaps.missing.length : 0;
  const toReview = view ? view.review.reduce((n, g) => n + g.lines.length, 0) : 0;

  /** A proposed or decided line's row in the review table. */
  const lineRow = (line: EarningsLineView, actions: ReactNode, label?: string) => (
    <tr key={line.id}>
      <td className={styles.cellWhen}>{shortDay(line.payoutDate)}</td>
      <td className={`${styles.cellWhat} ${styles.colFlex}`}>
        {label ?? proposedLabel(line)}
        <span className={styles.cellSub}>{lineSub(line)}</span>
      </td>
      <td className={styles.cellWhen}>{fromText(line)}</td>
      <td className={styles.num}>{formatCents(line.amountCents)}</td>
      <td className={styles.colFit}>
        <div className={styles.actions}>{actions}</div>
      </td>
    </tr>
  );

  return (
    <div className={shared.container}>
      <AdminHeader current="income">
        <button type="button" className={shared.btnGhost} onClick={reload} disabled={loading}>
          <RefreshCw size={15} aria-hidden />
          <span>Refresh</span>
        </button>
      </AdminHeader>

      <main className={shared.main}>
        <NoticeBanner notice={notice} onDismiss={clear} className={shared.pageNotice} />

        {/* ── The month, and the upload ── */}
        <div className={styles.bar}>
          <div className={styles.monthRow}>
            <button type="button" className={styles.monthStep} aria-label="Previous month" onClick={() => changeMonth(addMonths(month, -1))}>
              <ChevronLeft size={18} aria-hidden />
            </button>
            <AdminSelect label="Month" className={styles.monthSelect} value={month} onChange={changeMonth} groups={monthOptions} />
            <button type="button" className={styles.monthStep} aria-label="Next month" disabled={month >= thisMonth} onClick={() => changeMonth(addMonths(month, 1))}>
              <ChevronRight size={18} aria-hidden />
            </button>
          </div>
          <div className={styles.barEnd}>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              className={styles.fileInput}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void upload(file);
              }}
            />
            <button type="button" className={shared.btnPrimary} onClick={() => fileRef.current?.click()} disabled={busy !== null || !data} title={`${INCOME_CHANNEL_LABELS[CHANNEL]}'s transaction report for ${monthLabel(month)}, as a CSV`}>
              <Upload size={15} aria-hidden />
              <span>{busy === "upload" ? "Reading…" : `Upload ${INCOME_CHANNEL_LABELS[CHANNEL]} CSV`}</span>
            </button>
          </div>
        </div>

        {read.kind === "loading" ? (
          <div className={shared.loading}>
            <div className={shared.spinner} />
            <p>Loading {monthLabel(month)}…</p>
          </div>
        ) : read.kind === "error" ? (
          /* A failed read is NOT an empty month: no lines, no totals, no gaps. */
          <div className={`${shared.empty} ${shared.loadError}`} role="alert">
            <AlertTriangle size={48} strokeWidth={1} />
            <h2>Could not load {monthLabel(month)}</h2>
            <p>
              It is not empty — it has not loaded.
              {(read.status === 401 || read.status === 403) && ` ${SESSION_HINT}`}
            </p>
            <code className={shared.loadErrorDetail}>
              {read.title}
              {read.detail ? ` ${read.detail}` : ""}
            </code>
            <button type="button" className={shared.btnPrimary} onClick={reload}>
              <RefreshCw size={18} />
              <span>Retry</span>
            </button>
          </div>
        ) : data && view ? (
          <>
            {data.unreadable > 0 && <p className={styles.noteWarn}>{plural(data.unreadable, "stored document is", "stored documents are")} not in the written shape and left out.</p>}

            {/* ── The month's files ── */}
            <section className={styles.uploads} aria-label="Files">
              {data.uploads.length === 0 ? (
                <p className={styles.empty}>No {INCOME_CHANNEL_LABELS[CHANNEL]} file for {monthLabel(month)} yet.</p>
              ) : (
                data.uploads.map((item) => (
                  <div key={item.id} className={styles.uploadRow}>
                    <span className={styles.uploadName}>{item.file.name}</span>
                    <span>{whenText(item.uploadedAt)}</span>
                    <span>{plural(item.read.rows, "row", "rows")}</span>
                    <span>
                      {plural(item.added, "new line", "new lines")} · {item.duplicates} already in
                    </span>
                    <span className={item.read.balanced ? styles.ok : styles.noteWarn} title={`Payouts ${formatCents(item.read.paidOutCents)} · rows ${formatCents(item.read.amountCents)}`}>
                      {item.read.balanced ? `Adds up · ${formatCents(item.read.paidOutCents)}` : "Does not add up"}
                    </span>
                    <button type="button" className={styles.linkButton} onClick={() => openFile(item)} disabled={busy !== null} title="The file as uploaded, with the Guest and Details columns blanked. The link works for 60 seconds.">
                      <FileText size={13} aria-hidden />
                      File
                    </button>
                    {(!item.read.balanced || item.notRead.length > 0 || item.outsideMonth.length > 0) && (
                      <span className={styles.uploadNotes}>
                        {item.read.unbalanced.map((u) => (
                          <span key={u.row} className={styles.noteWarn}>
                            {u.row === 0 ? `Rows under no payout: ${formatCents(u.rowsCents)}` : `Payout on row ${u.row}: ${formatCents(u.paidOutCents)}, its rows ${formatCents(u.rowsCents)}`}
                          </span>
                        ))}
                        {item.notRead.map((n) => (
                          <span key={n.row} className={styles.noteWarn}>
                            Row {n.row}, {n.type || "no type"}, {formatCents(n.amountCents)}: not read — {n.why}.
                          </span>
                        ))}
                        {item.outsideMonth.map((o) => (
                          <span key={o.month} className={styles.note}>
                            {plural(o.rows, "row", "rows")} paid in {monthLabel(o.month)} ({formatCents(o.amountCents)}) left for that month&rsquo;s file.
                          </span>
                        ))}
                      </span>
                    )}
                  </div>
                ))
              )}
            </section>

            {/* ── Gaps, shown without anyone looking for them ── */}
            {gapCount > 0 && (
              <section className={styles.gapPanel} aria-label="Gaps" role="status">
                <h2 className={styles.gapTitle}>
                  <AlertTriangle size={15} aria-hidden />
                  <span>Gaps · {gapCount}</span>
                </h2>

                {view.gaps.unlinked.length > 0 && (
                  <div className={styles.gapGroup}>
                    <h3 className={styles.gapHead}>Not linked to a property · {view.gaps.unlinked.length}</h3>
                    <ul className={styles.gapList}>
                      {view.gaps.unlinked.map((row) => (
                        <li key={`${row.platform}|${row.title}`} className={styles.gapItem}>
                          <span className={styles.gapWhat}>{row.title}</span>
                          <span className={styles.gapFigures}>
                            {plural(row.rows, "row", "rows")} · {formatCents(row.amountCents)}
                          </span>
                          <span className={styles.linkForm}>
                            <AdminSelect label={`Property for ${row.title}`} className={styles.propertySelect} value={choiceFor(row)} onChange={(value) => setChoice(row, value)} groups={propertyOptions} searchable />
                            <button type="button" className={styles.btnGhost} disabled={busy !== null || choiceFor(row) === ""} onClick={() => link(row, choiceFor(row))}>
                              {busy === `link:${row.title}` ? "Linking…" : "Link"}
                            </button>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {view.gaps.checkIns.length > 0 && (
                  <div className={styles.gapGroup}>
                    <h3 className={styles.gapHead} title={`Read from the daily calendar copies ${data.calendar.days.length === 0 ? "(none kept for these days)" : data.calendar.days.map((d) => dateText(d)).join(", ")}`}>
                      Check-ins on the calendar, no income · {view.gaps.checkIns.length}
                      <span className={styles.muted}> · {plural(data.calendar.days.length, "daily calendar copy", "daily calendar copies")}</span>
                    </h3>
                    <ul className={styles.gapList}>
                      {view.gaps.checkIns.map((row) => (
                        <li key={row.propertyId} className={styles.gapItem}>
                          <Link href={`/admin/property?id=${encodeURIComponent(row.propertyId)}&month=${month}`} prefetch={false} className={styles.linkButton}>
                            {row.name}
                          </Link>
                          <span className={styles.gapFigures}>
                            {row.days.length === 1 ? "check-in" : "check-ins"} {row.days.map(shortDay).join(", ")}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {view.gaps.missing.length > 0 && (
                  <div className={styles.gapGroup}>
                    <h3 className={styles.gapHead}>Linked, not in this month&rsquo;s file · {view.gaps.missing.length}</h3>
                    <ul className={styles.gapList}>
                      {view.gaps.missing.map(({ link: l, name, lastSeen }) => (
                        <li key={l.id} className={styles.gapItem}>
                          <span className={styles.gapWhat}>{l.title}</span>
                          <span className={styles.gapFigures}>
                            → {name ?? "a deleted property"} · {lastSeen ? `last in ${monthLabel(lastSeen)}` : "never in a file"}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </section>
            )}

            {/* ── To review ── */}
            <section className={styles.block} aria-label="To review">
              <div className={styles.blockHead}>
                <h2 className={styles.blockTitle}>To review</h2>
                <span className={styles.blockFigure}>
                  {toReview} to review · {view.accepted.length} accepted · {view.rejected.length} rejected
                </span>
              </div>
              {toReview === 0 && view.rejected.length === 0 && view.removed.length === 0 ? (
                <p className={styles.empty}>{data.lines.length === 0 ? "Nothing proposed for this month." : view.gaps.unlinked.length > 0 ? "Nothing to review under a linked title. Link the titles above." : "Everything for this month is decided."}</p>
              ) : (
                <div className={shared.tableContainer}>
                  <div className={styles.tableScroll}>
                    <table className={shared.table}>
                      <thead>
                        <tr>
                          <th className={styles.colFit}>Paid</th>
                          <th>Line</th>
                          <th className={styles.colFit}>From</th>
                          <th className={styles.num}>Amount</th>
                          <th className={styles.colFit} aria-label="Actions" />
                        </tr>
                      </thead>
                      <tbody>
                        {view.review.map((group) => (
                          <Fragment key={group.propertyId}>
                            <tr className={styles.groupRow}>
                              <td colSpan={5}>
                                <div className={styles.groupInner}>
                                  <Link href={`/admin/property?id=${encodeURIComponent(group.propertyId)}&month=${month}`} prefetch={false} className={`${styles.groupTitle} ${styles.linkButton}`}>
                                    {group.name}
                                  </Link>
                                  <span className={styles.groupFigure}>
                                    {plural(group.lines.length, "line", "lines")} · {formatCents(group.amountCents)}
                                  </span>
                                  <span className={styles.groupAction}>
                                    {group.finished ? (
                                      <span className={`${styles.badge} ${styles.badgeWarn}`} title="A finished statement is never touched. Correct or delete it on the property's page first.">
                                        {monthLabel(month)} finished
                                      </span>
                                    ) : (
                                      <button type="button" className={styles.btnApprove} disabled={busy !== null || editing !== null} onClick={() => accept(group, group.lines.map((line) => ({ id: line.id })), `group:${group.propertyId}`)}>
                                        {busy === `group:${group.propertyId}` ? "Accepting…" : group.lines.length === 1 ? "Accept" : `Accept all ${group.lines.length}`}
                                      </button>
                                    )}
                                  </span>
                                </div>
                              </td>
                            </tr>
                            {group.lines.map((line) =>
                              editing?.id === line.id ? (
                                <tr key={line.id} className={styles.editRow}>
                                  <td className={styles.cellWhen}>{shortDay(line.payoutDate)}</td>
                                  <td colSpan={4}>
                                    <form className={styles.editFields} onSubmit={acceptEdited(group, line)} aria-label="Edit the line">
                                      <input className={`${styles.textInput} ${styles.descriptionInput}`} aria-label="Description" value={editing.description} maxLength={STATEMENT_LIMITS.LINE_DESCRIPTION_MAX} onChange={(e) => setEditing({ ...editing, description: e.target.value })} autoFocus />
                                      <input className={`${styles.textInput} ${styles.amountInput}`} aria-label="Amount" inputMode="decimal" value={editing.amount} onChange={(e) => setEditing({ ...editing, amount: e.target.value })} />
                                      <button type="submit" className={styles.btnApprove} disabled={busy !== null || group.finished}>
                                        {busy === `accept:${line.id}` ? "Accepting…" : "Accept"}
                                      </button>
                                      <button type="button" className={styles.btnGhost} onClick={() => setEditing(null)}>
                                        Cancel
                                      </button>
                                      <span className={styles.note}>
                                        From the file: {formatCents(line.amountCents)} · {fromText(line)}
                                      </span>
                                    </form>
                                  </td>
                                </tr>
                              ) : (
                                lineRow(
                                  line,
                                  <>
                                    <button type="button" className={styles.btnApprove} disabled={busy !== null || editing !== null || group.finished} onClick={() => accept(group, [{ id: line.id }], `accept:${line.id}`)}>
                                      {busy === `accept:${line.id}` ? "Accepting…" : "Accept"}
                                    </button>
                                    <button type="button" className={styles.btnGhost} disabled={busy !== null || editing !== null || group.finished} onClick={() => setEditing({ id: line.id, description: proposedLabel(line), amount: amountField(line.amountCents) })}>
                                      Edit
                                    </button>
                                    <button type="button" className={styles.btnReject} disabled={busy !== null || editing !== null} onClick={() => decide(line, "reject")}>
                                      {busy === `reject:${line.id}` ? "Rejecting…" : "Reject"}
                                    </button>
                                  </>,
                                )
                              ),
                            )}
                          </Fragment>
                        ))}

                        {view.removed.length > 0 && (
                          <>
                            <tr className={styles.groupRow}>
                              <td colSpan={5}>
                                <div className={styles.groupInner}>
                                  <span className={styles.groupTitle}>Accepted, since removed from the statement · {view.removed.length}</span>
                                </div>
                              </td>
                            </tr>
                            {view.removed.map((line) =>
                              lineRow(
                                line,
                                <button type="button" className={styles.btnGhost} disabled={busy !== null || editing !== null} onClick={() => decide(line, "propose-again")}>
                                  {busy === `propose-again:${line.id}` ? "Proposing…" : "Propose again"}
                                </button>,
                                line.decided?.status === "accepted" ? `${line.decided.description} → ${names.get(line.decided.propertyId) ?? "a deleted property"}` : undefined,
                              ),
                            )}
                          </>
                        )}

                        {view.rejected.length > 0 && (
                          <>
                            <tr className={styles.groupRow}>
                              <td colSpan={5}>
                                <div className={styles.groupInner}>
                                  <span className={styles.groupTitle}>Rejected · {view.rejected.length}</span>
                                </div>
                              </td>
                            </tr>
                            {view.rejected.map((line) =>
                              lineRow(
                                line,
                                <button type="button" className={styles.btnGhost} disabled={busy !== null || editing !== null} onClick={() => decide(line, "propose-again")}>
                                  {busy === `propose-again:${line.id}` ? "Proposing…" : "Propose again"}
                                </button>,
                                `${proposedLabel(line)} · ${line.listingTitle}`,
                              ),
                            )}
                          </>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </section>

            {/* ── By property: the statements' lines, as the property page shows them ── */}
            <section className={styles.block} aria-label="By property">
              <div className={styles.blockHead}>
                <h2 className={styles.blockTitle}>By property</h2>
                <span className={styles.blockFigure}>
                  {formatCents(view.byProperty.reduce((sum, row) => sum + row.revenueCents, 0))} revenue · {formatCents(view.byProperty.reduce((sum, row) => sum + row.expensesCents, 0))} expenses
                </span>
              </div>
              {view.byProperty.length === 0 ? (
                <p className={styles.empty}>No property has a line in its {monthLabel(month)} statement yet.</p>
              ) : (
                <div className={shared.tableContainer}>
                  <div className={styles.tableScroll}>
                    <table className={shared.table}>
                      <thead>
                        <tr>
                          <th>Property</th>
                          <th className={styles.num}>Lines</th>
                          <th className={styles.num}>From a file</th>
                          <th className={styles.num}>Revenue</th>
                          <th className={styles.num}>Expenses</th>
                          <th className={styles.colFit}>Statement</th>
                        </tr>
                      </thead>
                      <tbody>
                        {view.byProperty.map((row) => (
                          <tr key={row.propertyId}>
                            <td className={styles.cellWhat}>
                              {row.name === null ? (
                                <span className={styles.muted}>A deleted property ({row.propertyId.slice(0, 6)})</span>
                              ) : (
                                <Link href={`/admin/property?id=${encodeURIComponent(row.propertyId)}&month=${month}`} prefetch={false} className={styles.linkButton}>
                                  {row.name}
                                </Link>
                              )}
                            </td>
                            <td className={styles.num}>{row.lines}</td>
                            <td className={styles.num}>{row.fromFile}</td>
                            <td className={styles.num}>{formatCents(row.revenueCents)}</td>
                            <td className={styles.num}>{formatCents(row.expensesCents)}</td>
                            <td className={styles.colFit}>
                              <span className={`${styles.badge} ${row.finished ? styles.badgeDone : ""}`}>{row.finished ? "Finished" : "Draft"}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </section>

            {/* ── Titles: every title in the month's lines, and its link ── */}
            {view.titles.length > 0 && (
              <details className={`${styles.block} ${styles.titles}`}>
                <summary className={styles.blockHead}>
                  <h2 className={styles.blockTitle}>Titles · {view.titles.length}</h2>
                  <span className={styles.blockFigure}>
                    {view.titles.filter((t) => t.link).length} linked · {formatCents(view.titles.reduce((sum, t) => sum + t.amountCents, 0))}
                  </span>
                </summary>
                <div className={shared.tableContainer}>
                  <div className={styles.tableScroll}>
                    <table className={shared.table}>
                      <thead>
                        <tr>
                          <th>Title</th>
                          <th className={styles.num}>Rows</th>
                          <th className={styles.num}>Total</th>
                          <th>Property</th>
                          <th className={styles.colFit} aria-label="Actions" />
                        </tr>
                      </thead>
                      <tbody>
                        {view.titles.map((row) => {
                          const key = `${row.platform}|${row.title}`;
                          return (
                            <tr key={key}>
                              <td className={styles.cellWhat}>{row.title}</td>
                              <td className={styles.num}>{row.rows}</td>
                              <td className={styles.num}>{formatCents(row.amountCents)}</td>
                              <td className={styles.cellWhat}>
                                {changing === key ? (
                                  <AdminSelect label={`Property for ${row.title}`} className={styles.propertySelect} value={choiceFor(row)} onChange={(value) => setChoice(row, value)} groups={propertyOptions} searchable />
                                ) : row.link ? (
                                  (names.get(row.link.propertyId) ?? "a deleted property")
                                ) : (
                                  <span className={styles.noteWarn}>Not linked</span>
                                )}
                              </td>
                              <td className={styles.colFit}>
                                <div className={styles.actions}>
                                  {changing === key ? (
                                    <>
                                      <button type="button" className={styles.btnApprove} disabled={busy !== null || choiceFor(row) === "" || choiceFor(row) === row.link?.propertyId} onClick={() => link(row, choiceFor(row))}>
                                        {busy === `link:${row.title}` ? "Saving…" : row.link ? "Save" : "Link"}
                                      </button>
                                      <button type="button" className={styles.btnGhost} onClick={() => setChanging(null)}>
                                        Cancel
                                      </button>
                                    </>
                                  ) : (
                                    <button
                                      type="button"
                                      className={styles.btnGhost}
                                      disabled={busy !== null}
                                      onClick={() => {
                                        if (row.link) setChoice(row, row.link.propertyId);
                                        setChanging(key);
                                      }}
                                    >
                                      {row.link ? "Change" : "Link"}
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </details>
            )}
          </>
        ) : null}
      </main>
    </div>
  );
}
