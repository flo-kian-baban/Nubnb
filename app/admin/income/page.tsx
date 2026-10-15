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
 *              property, with their rows and total and a way to link them,
 *              and, when the evidence agrees, the property a title may be,
 *              renamed (M14: offered, never applied); properties with a
 *              check-in in the month on their calendar and no line for the
 *              month, saying how many days' calendar copies were read (I8);
 *              active titles missing from the month's file.
 *   To review  the proposed lines, by property: accept, edit and accept, or
 *              reject, one at a time, or a property's together (N2). A line
 *              whose row type Nubnb does not recognise needs a decision of its
 *              own. A line that may duplicate one on the statement says so
 *              (I2); a property that owes no statement says so (I5).
 *   Accepted   the lines accepted, read where they are stored (Kian's ruling
 *              M10): each can be edited, or sent back for review, until a
 *              finished statement prints it. A line accepted for a month
 *              already finished goes on the next open statement (M11).
 *   By property  each property's lines for the month as its statement holds
 *              them, linking to its page; its figures the month's money's
 *              (dispatch 37A): revenue with Airbnb's part (a claw-back takes
 *              revenue off, Kian's ruling M1), typed expenses, what still
 *              waits apart, and a correction in progress said beside the
 *              statement as sent.
 *   Titles     every listing title in the month's lines, its link, and a way
 *              to change a link.
 *
 * ── The same lines ──
 * An accepted line is read where it is stored (dispatch 37C): the property
 * page's Income tab lists the same lines, the statement prints them, and "By
 * property" reads the statements as they stand. Nothing is copied between
 * the two pages.
 *
 * ── Titles ──
 * Link makes a title the property's active title, the one its edit page sets
 * (M12); when the property has one already, it asks first. A title moves to
 * another property only while none of its lines is on a finished statement
 * (M13).
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
import { PageHead } from "../components/PageHead";
import { DirectSection } from "./DirectSection";
import { AdminSelect } from "../components/AdminSelect";
import { PinGate } from "../components/PinGate";
import { NoticeBanner, useNotice } from "../components/Notice";
import { amountField, readAmount } from "../costs/cost-display";
import { formatCents } from "@/app/lib/cleaners/model";
import { torontoDayOf } from "@/app/lib/costs/report";
import { STATEMENTS_FROM_DEFAULT, STATEMENT_LIMITS, addMonths, dateText, isMonth, lastClosedMonth, monthLabel, monthOfDay, monthRange, monthsBetween } from "@/app/lib/reports/model";
import { INCOME_CHANNEL_LABELS, isActiveTitle, isReadWhereStored, isSetAside, linkState, proposedLabel, shortDay, type EarningsLineView, type EarningsUploadView } from "@/app/lib/income/model";
import { linkOf, monthView, needsDecision, suggestedProperty, type ReviewGroup, type TitleRow } from "@/app/lib/income/month";
import { acceptIncomeLines, decideIncomeLine, editIncomeLine, fetchIncomeMonth, fetchUploadFileLink, linkTitle, rejectIncomeLines, setTitleAside, uploadIncomeFile, type IncomeMonth, type IncomeResult } from "@/app/lib/income-client";
import { useAsk } from "../components/AskDialog";
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

/** How many days a month has: "2026-10" → 31. */
const monthsDays = (month: string) => Number(monthRange(month).to.slice(8));

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
  /** Questions in Nubnb's own dialog (Kian's ruling of 2026-10-12: no native browser dialogs in the admin). */
  const { ask, dialog } = useAsk();

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
  const view = useMemo(() => (data ? monthView({ ...data, month }) : null), [data, month]);
  const renames = useMemo(() => new Map((data?.renames ?? []).map((r) => [`${r.platform}|${r.title}`, r])), [data]);
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

  // ── Accept, edit and accept, accept a property's lines (read where they are stored, Kian's ruling M10) ──
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
    const byId = new Map(result.data.lines.map((line) => [line.id, line]));
    setRead((prev) => (prev.kind === "ready" ? { kind: "ready", data: { ...prev.data, lines: prev.data.lines.map((line) => byId.get(line.id) ?? line) } } : prev));
    setEditing(null);
    const goesOn = result.data.statementMonth;
    show({
      tone: "success",
      title: `${plural(result.data.lines.length, "line", "lines")} accepted for ${group.name}.`,
      detail: goesOn === month ? `On its ${monthLabel(month)} statement.` : `${monthLabel(month)} is finished: on its ${monthLabel(goesOn)} statement, with the day paid printed.`,
    });
    // The statements place accepted lines: read the month again for By property.
    reread();
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

  // ── Reject a property's lines together (N2) ──
  const rejectAll = async (group: ReviewGroup) => {
    if (busy) return;
    const yes = await ask({
      title: `Reject ${group.lines.length === 1 ? "the line" : `all ${group.lines.length} lines`} for ${group.name}?`,
      lines: [`${formatCents(group.amountCents)} in ${monthLabel(month)}. They stay listed under Rejected, and each can be proposed again.`],
      confirm: group.lines.length === 1 ? "Reject" : `Reject all ${group.lines.length}`,
      danger: true,
    });
    if (!yes) return;
    clear();
    setBusy(`reject-all:${group.propertyId}`);
    const result = await rejectIncomeLines(group.lines.map((line) => line.id));
    setBusy(null);
    if (!result.ok) {
      failed(result, result.status === 409);
      return;
    }
    const byId = new Map(result.data.lines.map((line) => [line.id, line]));
    setRead((prev) => (prev.kind === "ready" ? { kind: "ready", data: { ...prev.data, lines: prev.data.lines.map((line) => byId.get(line.id) ?? line) } } : prev));
    show({ tone: "success", title: `${plural(result.data.lines.length, "line", "lines")} rejected for ${group.name}.` });
  };

  // ── An accepted line: edited, or sent back for review (M10: until a finished statement prints it) ──
  const saveAccepted = (line: EarningsLineView) => async (event: FormEvent) => {
    event.preventDefault();
    if (!editing || editing.id !== line.id || line.decided?.status !== "accepted") return;
    const description = editing.description.normalize("NFC").replace(/\s+/g, " ").trim();
    const amount = readAmount(editing.amount);
    const problems = [
      description === "" || description.length > STATEMENT_LIMITS.LINE_DESCRIPTION_MAX ? `Describe the line, in at most ${STATEMENT_LIMITS.LINE_DESCRIPTION_MAX} characters.` : null,
      amount === null || amount === "0.00" ? "Check the amount: dollars and cents other than 0.00, negative for money taken back." : null,
    ].filter((p): p is string => p !== null);
    if (problems.length > 0 || amount === null) {
      show({ tone: "error", title: "The line was not saved.", items: problems });
      return;
    }
    const sent: { seen: number; description?: string; amount?: string } = { seen: line.history.length };
    if (description !== line.decided.description) sent.description = description;
    if (amount !== amountField(line.decided.amountCents)) sent.amount = amount;
    if (sent.description === undefined && sent.amount === undefined) {
      setEditing(null);
      return;
    }
    if (busy) return;
    clear();
    setBusy(`edit:${line.id}`);
    const result = await editIncomeLine(line.id, sent);
    setBusy(null);
    if (!result.ok) {
      failed(result, result.status === 409);
      return;
    }
    const next = result.data.line;
    setRead((prev) => (prev.kind === "ready" ? { kind: "ready", data: { ...prev.data, lines: prev.data.lines.map((l) => (l.id === next.id ? next : l)) } } : prev));
    setEditing(null);
    show({ tone: "success", title: "Saved. The line's history keeps what it said before." });
    reread();
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
    show({ tone: "success", title: action === "reject" ? "Rejected. It stays listed, and can be proposed again." : "Proposed again: it waits for review." });
    if (action === "propose-again") reread();
  };

  // ── Link a title, or change its link ──
  const link = async (row: TitleRow, propertyId: string) => {
    if (busy || propertyId === "" || !data) return;
    const name = names.get(propertyId) ?? "the property";
    // The property's active title, if any (Kian's ruling: one per property): asked first (M12).
    const active = data.links.find((l) => l.platform === row.platform && l.propertyId === propertyId && isActiveTitle(l) && l.title !== row.title) ?? null;
    const elsewhere = row.link && row.link.propertyId !== null && row.link.propertyId !== propertyId ? (names.get(row.link.propertyId) ?? "a deleted property") : null;
    if (active || elsewhere) {
      const yes = await ask({
        title: `Make “${row.title}” ${name}'s Airbnb title?`,
        lines: [
          active ? `Its title now is “${active.title}”. That one stays its previous title, so older files still match.` : null,
          elsewhere ? `“${row.title}” moves from ${elsewhere}. Its lines accepted there and not yet on a finished statement go back for review; a title with a line on a finished statement does not move.` : null,
        ],
        confirm: "Make it its title",
      });
      if (!yes) return;
    }
    clear();
    setBusy(`link:${row.title}`);
    const result = await linkTitle({ channel: row.platform, title: row.title, propertyId, expected: linkState(row.link) });
    setBusy(null);
    if (!result.ok) {
      failed(result, result.status === 409);
      return;
    }
    setChanging(null);
    show({
      tone: "success",
      title: `“${row.title}” is ${name}'s Airbnb title.`,
      detail: [result.data.previous ? `“${result.data.previous}” is now its previous title.` : null, result.data.sentBack > 0 ? `${plural(result.data.sentBack, "line went", "lines went")} back for review.` : null].filter(Boolean).join(" ") || undefined,
    });
    reread();
  };

  // ── Set a title aside: not a Nubnb property (dispatch 36, Kian's ruling of 2026-10-12) ──
  const setAside = async (row: TitleRow) => {
    if (busy) return;
    const proposed = data ? data.lines.filter((line) => line.platform === row.platform && line.listingTitle === row.title && line.status === "proposed").length : 0;
    const yes = await ask({
      title: `Is “${row.title}” not a Nubnb property?`,
      lines: [`It stays listed here, marked, and leaves the gaps.${proposed > 0 ? ` Its ${plural(proposed, "proposed line", "proposed lines")} ${proposed === 1 ? "is" : "are"} rejected, and so are its lines in later files.` : " Its lines in later files are rejected."}`, "Linking it to a property later is a link like any other."],
      confirm: "Not a Nubnb property",
    });
    if (!yes) return;
    clear();
    setBusy(`aside:${row.title}`);
    const result = await setTitleAside({ channel: row.platform, title: row.title, expected: linkState(row.link) });
    setBusy(null);
    if (!result.ok) {
      failed(result, result.status === 409);
      return;
    }
    reread();
    show({ tone: "success", title: `"${row.title}" is set aside as not a Nubnb property.`, detail: result.data.rejected > 0 ? `${plural(result.data.rejected, "line was", "lines were")} rejected.` : undefined });
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

  /** A proposed or decided line's row in the review table; an accepted line shows its amount as accepted or edited, the file's beside it when they differ. */
  const lineRow = (line: EarningsLineView, actions: ReactNode, label?: string, amountCents: number = line.amountCents) => (
    <tr key={line.id}>
      <td className={styles.cellWhen}>{shortDay(line.payoutDate)}</td>
      <td className={`${styles.cellWhat} ${styles.colFlex}`}>
        {label ?? proposedLabel(line)}
        {line.status === "proposed" && needsDecision(line) && (
          <span className={`${styles.badge} ${styles.badgeWarn} ${styles.inlineBadge}`} title={`Airbnb's row type “${line.type}” is not one Nubnb recognises: accept it as a line, edited if need be, or reject it.`}>
            Needs a decision
          </span>
        )}
        <span className={styles.cellSub}>{lineSub(line)}</span>
        {view?.warnings.get(line.id)?.map((said) => (
          <span key={said} className={`${styles.cellSub} ${styles.noteWarn}`}>
            {said}
          </span>
        ))}
      </td>
      <td className={styles.cellWhen}>{fromText(line)}</td>
      <td className={styles.num}>
        {formatCents(amountCents)}
        {amountCents !== line.amountCents && <span className={styles.cellSub}>in the file {formatCents(line.amountCents)}</span>}
      </td>
      <td className={styles.colFit}>
        <div className={styles.actions}>{actions}</div>
      </td>
    </tr>
  );

  return (
    <div className={shared.container}>
      <AdminHeader current="income" />

      <main className={shared.main}>
        {/* The page's own buttons, in its head (Kian's ruling of 2026-10-15: none in the navigation). */}
        <PageHead title="Income">
          <button type="button" className={shared.btnGhost} onClick={reload} disabled={loading}>
            <RefreshCw size={15} aria-hidden />
            <span>Refresh</span>
          </button>
        </PageHead>

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
                      {item.read.balanced ? `Adds up${item.read.checkedBy === "day" ? ", day by day" : ""} · ${formatCents(item.read.paidOutCents)}` : "Does not add up"}
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

            {/* ── The calendar copies the check-ins are read from (I8): never an all-clear when days are missing ── */}
            {data.uploads.length > 0 && (() => {
              const daysInMonth = monthsDays(month);
              const inMonth = data.calendar.days.filter((d) => d.startsWith(month)).length;
              return inMonth < daysInMonth ? (
                <p className={styles.noteWarn}>
                  Calendar copies kept for {inMonth} of {monthLabel(month)}&rsquo;s {daysInMonth} days: check-ins on the other days are not checked, so no gap below is not an all-clear.
                </p>
              ) : null;
            })()}

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
                            <button type="button" className={styles.btnGhost} disabled={busy !== null} onClick={() => void setAside(row)}>
                              {busy === `aside:${row.title}` ? "Setting aside…" : "Not a Nubnb property"}
                            </button>
                          </span>
                          {(() => {
                            // A rename the evidence agrees on (M14): offered, never applied without an admin.
                            const rename = renames.get(`${row.platform}|${row.title}`);
                            if (!rename) return null;
                            const name = names.get(rename.propertyId) ?? "a property";
                            return (
                              <span className={styles.rename}>
                                <span>
                                  May be <strong>{name}</strong>
                                  {rename.fromTitle ? <>, renamed from “{rename.fromTitle}”</> : null}:
                                </span>
                                <span className={styles.muted}>{rename.evidence.map((e) => e.text).join(" ")}</span>
                                <button type="button" className={styles.btnApprove} disabled={busy !== null} onClick={() => link(row, rename.propertyId)}>
                                  {busy === `link:${row.title}` ? "Saving…" : `Make it ${name}'s title`}
                                </button>
                              </span>
                            );
                          })()}
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
              {toReview === 0 && view.rejected.length === 0 && view.removed.length === 0 && view.accepted.length === 0 ? (
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
                                    {group.undecided > 0 && <span className={styles.noteWarn}> · {group.undecided} {group.undecided === 1 ? "needs" : "need"} a decision</span>}
                                  </span>
                                  <span className={styles.groupAction}>
                                    {group.finished && (
                                      <span className={`${styles.badge} ${styles.badgeWarn}`} title="A finished statement is never touched: a line accepted now goes on the next open statement, with the day paid printed (Kian's ruling M11).">
                                        {monthLabel(month)} finished · goes on the next
                                      </span>
                                    )}
                                    {(() => {
                                      // Lines of a row type Nubnb does not recognise are decided one by one, never with the rest.
                                      const known = group.lines.filter((line) => !needsDecision(line));
                                      return known.length > 0 ? (
                                        <button type="button" className={styles.btnApprove} disabled={busy !== null || editing !== null} onClick={() => accept(group, known.map((line) => ({ id: line.id })), `group:${group.propertyId}`)}>
                                          {busy === `group:${group.propertyId}` ? "Accepting…" : known.length === 1 ? "Accept" : `Accept all ${known.length}`}
                                        </button>
                                      ) : null;
                                    })()}
                                    {group.lines.length > 1 && (
                                      <button type="button" className={styles.btnReject} disabled={busy !== null || editing !== null} onClick={() => void rejectAll(group)}>
                                        {busy === `reject-all:${group.propertyId}` ? "Rejecting…" : `Reject all ${group.lines.length}`}
                                      </button>
                                    )}
                                  </span>
                                </div>
                                {group.noStatement && <p className={styles.noteWarn}>{group.noStatement}</p>}
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
                                      <button type="submit" className={styles.btnApprove} disabled={busy !== null}>
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
                                    <button type="button" className={styles.btnApprove} disabled={busy !== null || editing !== null} onClick={() => accept(group, [{ id: line.id }], `accept:${line.id}`)}>
                                      {busy === `accept:${line.id}` ? "Accepting…" : "Accept"}
                                    </button>
                                    <button type="button" className={styles.btnGhost} disabled={busy !== null || editing !== null} onClick={() => setEditing({ id: line.id, description: proposedLabel(line), amount: amountField(line.amountCents) })}>
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

                        {view.accepted.length > 0 && (
                          <>
                            <tr className={styles.groupRow}>
                              <td colSpan={5}>
                                <div className={styles.groupInner}>
                                  <span className={styles.groupTitle}>Accepted · {view.accepted.length}</span>
                                  <span className={styles.groupFigure}>{formatCents(view.accepted.reduce((sum, line) => sum + (line.decided?.status === "accepted" ? line.decided.amountCents : 0), 0))}</span>
                                </div>
                              </td>
                            </tr>
                            {view.accepted.map((line) => {
                              if (line.decided?.status !== "accepted") return null;
                              const decided = line.decided;
                              const lock = data.locked[line.id] ?? null;
                              const where = `${names.get(decided.propertyId) ?? "a deleted property"}${lock ? ` · on ${monthLabel(lock.month)}'s statement (${lock.reference}), locked` : ""}`;
                              if (editing?.id === line.id) {
                                return (
                                  <tr key={line.id} className={styles.editRow}>
                                    <td className={styles.cellWhen}>{shortDay(line.payoutDate)}</td>
                                    <td colSpan={4}>
                                      <form className={styles.editFields} onSubmit={saveAccepted(line)} aria-label="Edit the accepted line">
                                        <input className={`${styles.textInput} ${styles.descriptionInput}`} aria-label="Description" value={editing.description} maxLength={STATEMENT_LIMITS.LINE_DESCRIPTION_MAX} onChange={(e) => setEditing({ ...editing, description: e.target.value })} autoFocus />
                                        <input className={`${styles.textInput} ${styles.amountInput}`} aria-label="Amount" inputMode="decimal" value={editing.amount} onChange={(e) => setEditing({ ...editing, amount: e.target.value })} />
                                        <button type="submit" className={styles.btnApprove} disabled={busy !== null}>
                                          {busy === `edit:${line.id}` ? "Saving…" : "Save"}
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
                                );
                              }
                              return lineRow(
                                line,
                                !isReadWhereStored(line) ? (
                                  <span className={styles.muted} title="Accepted before dispatch 37C and copied into its draft: changed on the property's page.">In its draft</span>
                                ) : lock ? (
                                  <span className={styles.muted} title="A finished statement prints it. Correct that statement on the property's page to change it.">Locked</span>
                                ) : (
                                  <>
                                    <button type="button" className={styles.btnGhost} disabled={busy !== null || editing !== null} onClick={() => setEditing({ id: line.id, description: decided.description, amount: amountField(decided.amountCents) })}>
                                      Edit
                                    </button>
                                    <button type="button" className={styles.btnGhost} disabled={busy !== null || editing !== null} onClick={() => decide(line, "propose-again")}>
                                      {busy === `propose-again:${line.id}` ? "Sending back…" : "Send back"}
                                    </button>
                                  </>
                                ),
                                `${decided.description} → ${where}${line.history.some((h) => h.action === "edited") ? " · edited since accepted" : ""}`,
                                decided.amountCents,
                              );
                            })}
                          </>
                        )}

                        {view.removed.length > 0 && (
                          <>
                            <tr className={styles.groupRow}>
                              <td colSpan={5}>
                                <div className={styles.groupInner}>
                                  <span className={styles.groupTitle}>Accepted before 37C, since removed from the statement · {view.removed.length}</span>
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
                                // A set-aside title's lines stay rejected (Kian's ruling of 2026-10-12): linking the title comes first.
                                isSetAside(linkOf(data.links, line.platform, line.listingTitle)) ? (
                                  <span className={styles.muted}>Not a Nubnb property</span>
                                ) : (
                                  <button type="button" className={styles.btnGhost} disabled={busy !== null || editing !== null} onClick={() => decide(line, "propose-again")}>
                                    {busy === `propose-again:${line.id}` ? "Proposing…" : "Propose again"}
                                  </button>
                                ),
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

            {/* ── Direct: money received outside Airbnb, for every property (part B, Kian's rulings of 2026-10-15) ── */}
            <DirectSection month={month} properties={data.properties} show={show} onRecorded={reread} />

            {/* ── By property: the statements' lines, figured by the month's money as the property page figures them (dispatch 37A) ── */}
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
                          <th className={styles.num}>of which Airbnb</th>
                          <th className={styles.num}>of which direct</th>
                          <th className={styles.num}>Expenses</th>
                          <th className={styles.num} title="Lines under its titles still to review: in no statement until accepted">Waiting</th>
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
                            <td className={styles.num}>
                              {formatCents(row.revenueCents)}
                              {row.correction && <span className={styles.muted}> · correction {formatCents(row.correction.revenueCents)}</span>}
                            </td>
                            <td className={styles.num}>{row.airbnbCents === 0 ? <span className={styles.muted}>—</span> : formatCents(row.airbnbCents)}</td>
                            <td className={styles.num}>{row.directCents === 0 ? <span className={styles.muted}>—</span> : formatCents(row.directCents)}</td>
                            <td className={styles.num}>
                              {formatCents(row.expensesCents)}
                              {row.correction && row.correction.expensesCents !== row.expensesCents && <span className={styles.muted}> · correction {formatCents(row.correction.expensesCents)}</span>}
                            </td>
                            <td className={styles.num}>{row.waitingCents === 0 ? <span className={styles.muted}>—</span> : <span className={styles.muted}>{formatCents(row.waitingCents)}</span>}</td>
                            <td className={styles.colFit}>
                              <span className={`${styles.badge} ${row.finished ? styles.badgeDone : ""}`}>{row.correction ? "Finished · correcting" : row.finished ? "Finished" : "Draft"}</span>
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
                    {view.titles.filter((t) => t.link && !isSetAside(t.link)).length} linked
                    {view.titles.some((t) => isSetAside(t.link)) && <> · {view.titles.filter((t) => isSetAside(t.link)).length} not a Nubnb property</>} · {formatCents(view.titles.reduce((sum, t) => sum + t.amountCents, 0))} as in the file
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
                                ) : isSetAside(row.link) ? (
                                  <span className={styles.muted}>Not a Nubnb property</span>
                                ) : row.link ? (
                                  <>
                                    {names.get(row.link.propertyId ?? "") ?? "a deleted property"}
                                    {!isActiveTitle(row.link) && <span className={styles.muted}> · a previous title</span>}
                                  </>
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
                                        if (row.link) setChoice(row, row.link.propertyId ?? "");
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
      {dialog}
    </div>
  );
}
