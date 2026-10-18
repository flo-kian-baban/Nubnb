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
 *              and the property a title may be, renamed: when the evidence
 *              agrees (M14), or when exactly one active title is missing and
 *              exactly one new title is unlinked (Kian's ruling of
 *              2026-10-17), offered as one click, never applied by itself;
 *              properties with Airbnb stays on their calendar and no title,
 *              each with "Mark not paid through Nubnb's files" (Kian's ruling
 *              K2 of 2026-10-17); once the month has a file, properties with a
 *              check-in up to today and no line for the month, saying how
 *              many days' calendar copies were read (I8); active titles
 *              missing from the month's file.
 *   To review  Kian's ruling K1 of 2026-10-17: the lines held back for a
 *              decision of their own first, each with why; then the month's
 *              routine lines in one confirmation that names the lines, the
 *              properties and the total; then each property's routine lines,
 *              with its own Accept all. Each property says its Airbnb title,
 *              the month's revenue as it would stand (red below zero) and its
 *              statement's standing (the one function). Edit and Reject sit in
 *              a line's menu. Once nothing waits: how many properties have the
 *              month's money, ready and blocked, with the way to each.
 *   Accepted   the lines accepted, read where they are stored (Kian's ruling
 *              M10), one row per property, opened on click: each can be
 *              edited, or sent back for review, until a finished statement
 *              prints it. A line accepted for a month already finished goes on
 *              the next open statement (M11).
 *   By property  each property's lines for the month as its statement holds
 *              them, linking to its page; its figures the month's money's
 *              (dispatch 37A), and its statement in the standing's words.
 *   Titles     every listing title in the month's lines, its link, and a way
 *              to change a link; and the properties marked "not paid through
 *              Nubnb's files", each with Unmark.
 *
 * ── The same lines ──
 * An accepted line is read where it is stored (dispatch 37C): the property
 * page's Income tab lists the same lines, the statement prints them, and "By
 * property" reads the statements as they stand. Nothing is copied between
 * the two pages.
 *
 * ── Reads (Kian's ruling of 2026-10-17) ──
 * One read on opening, on each month and after each upload (GET
 * /api/admin/income). A decision takes what the server answers at once; the
 * month is read again only when the decisions settle (a pause of
 * SETTLE_MS), not after every click. The month and the property asked for are
 * mirrored into the address bar (?month=, ?property=).
 */

import { Fragment, Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, ChevronDown, ChevronLeft, ChevronRight, FileText, RefreshCw, Upload } from "lucide-react";
import { AdminHeader } from "../components/AdminHeader";
import { PageHead } from "../components/PageHead";
import { DirectSection } from "./DirectSection";
import { AdminSelect } from "../components/AdminSelect";
import { PinGate } from "../components/PinGate";
import { NoticeBanner, useNotice } from "../components/Notice";
import { RowMenu } from "../cleaners/RowMenu";
import { amountField, readAmount } from "../costs/cost-display";
import { formatCents } from "@/app/lib/cleaners/model";
import { torontoDayOf } from "@/app/lib/costs/report";
import { STATEMENTS_FROM_DEFAULT, STATEMENT_LIMITS, addMonths, dateText, isMonth, lastClosedMonth, monthLabel, monthName, monthOfDay, monthRange, monthsBetween } from "@/app/lib/reports/model";
import { INCOME_CHANNEL_LABELS, isActiveTitle, isReadWhereStored, isSetAside, linkState, proposedLabel, shortDay, type EarningsLineView, type EarningsUploadView } from "@/app/lib/income/model";
import { linkOf, monthView, needsDecision, owedNow, standingWords, suggestedProperty, type HeldLine, type MonthStandingView, type ReviewGroup, type TitleRow } from "@/app/lib/income/month";
import { acceptIncomeLines, acceptMonthLines, decideIncomeLine, editIncomeLine, fetchIncomeMonth, fetchUploadFileLink, linkTitle, rejectIncomeLines, setIncomeSource, setTitleAside, uploadIncomeFile, type IncomeMonth, type IncomeResult } from "@/app/lib/income-client";
import { useAsk } from "../components/AskDialog";
import shared from "../page.module.css";
import styles from "./page.module.css";

type Read<T> = { kind: "loading" } | { kind: "ready"; data: T } | { kind: "error"; title: string; detail?: string; status: number };

const SESSION_HINT = "Your admin session may have expired — reload and sign in again.";
/** The one upload type today (Kian, dispatch 27: built so others can be added). */
const CHANNEL = "airbnb" as const;
/** How long the decisions must pause before the month is read again (Kian's ruling of 2026-10-17: not after every click). */
const SETTLE_MS = 2500;

/** The line being edited before it is accepted, or after. */
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

/** A statement's standing as a badge: amber while owed, green when finished, quiet otherwise. */
function StandingBadge({ view }: { view: MonthStandingView }) {
  const tone = view.standing === "finished" ? styles.badgeDone : owedNow(view.standing) ? (view.reportFor ? styles.badgeWarn : styles.badgeBlocked) : "";
  return <span className={`${styles.badge} ${tone}`}>{standingWords(view)}</span>;
}

function IncomePageInner() {
  const params = useSearchParams();
  const today = torontoDayOf(new Date());
  const thisMonth = monthOfDay(today);
  const [month, setMonth] = useState(() => {
    const wanted = params.get("month");
    return isMonth(wanted) && wanted <= thisMonth ? wanted : lastClosedMonth(today);
  });
  /** The property the page was opened for (the home's and the property page's review links): brought into view once its read is in. */
  const focusRef = useRef<string | null>(params.get("property"));
  const [read, setRead] = useState<Read<IncomeMonth>>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [changing, setChanging] = useState<string | null>(null);
  /** The accepted lines' properties opened (folded to one row each otherwise). */
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const fileRef = useRef<HTMLInputElement>(null);
  const settleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { notice, show, clear } = useNotice();
  /** Questions in Nubnb's own dialog (Kian's ruling of 2026-10-12: no native browser dialogs in the admin). */
  const { ask, dialog } = useAsk();

  // ── The read: on opening, on each month, on Refresh, after an upload, and when the decisions settle ──
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

  const cancelSettle = useCallback(() => {
    if (settleRef.current) clearTimeout(settleRef.current);
    settleRef.current = null;
  }, []);
  useEffect(() => cancelSettle, [cancelSettle]);

  const changeMonth = (next: string) => {
    cancelSettle();
    clear();
    setEditing(null);
    setChanging(null);
    setOpened(new Set());
    setRead({ kind: "loading" });
    setMonth(next);
  };
  const reload = useCallback(() => {
    cancelSettle();
    clear();
    setRead({ kind: "loading" });
    setAttempt((n) => n + 1);
  }, [clear, cancelSettle]);
  /** Read the month again now, keeping what is shown until the answer comes. */
  const reread = useCallback(() => {
    cancelSettle();
    setAttempt((n) => n + 1);
  }, [cancelSettle]);
  /** Read the month again once the decisions pause (Kian's ruling of 2026-10-17): each decision takes the server's answer at once. */
  const settleSoon = useCallback(() => {
    cancelSettle();
    settleRef.current = setTimeout(() => {
      settleRef.current = null;
      setAttempt((n) => n + 1);
    }, SETTLE_MS);
  }, [cancelSettle]);

  const data = read.kind === "ready" ? read.data : null;
  const view = useMemo(() => (data ? monthView({ ...data, month, today: data.today }) : null), [data, month]);
  const renames = useMemo(() => new Map((data?.renames ?? []).map((r) => [`${r.platform}|${r.title}`, r])), [data]);
  // Each property by the name the admin shows: its cleaner-facing name, usually the address, else its public title (Kian's
  // rulings of 2026-10-15, evening). Titles are still matched against the public title (`suggestedProperty`).
  const names = useMemo(() => new Map((data?.properties ?? []).map((p) => [p.id, p.internalName ?? p.name])), [data]);
  const uploadName = useMemo(() => new Map((data?.uploads ?? []).map((u) => [u.id, u.file.name])), [data]);
  // The address, with the public title as a grey second line the search matches too (search everywhere matches both).
  const propertyOptions = useMemo(
    () => [{ options: [{ value: "", label: "Choose a property" }, ...(data?.properties ?? []).map((p) => ({ value: p.id, label: p.internalName ?? p.name, ...(p.internalName && p.internalName !== p.name ? { hint: p.name } : {}) }))] }],
    [data],
  );
  const monthOptions = useMemo(() => [{ options: monthsBetween(STATEMENTS_FROM_DEFAULT < month ? STATEMENTS_FROM_DEFAULT : month, thisMonth).reverse().map((m) => ({ value: m, label: monthLabel(m) })) }], [month, thisMonth]);
  /** The month in words: alone in this year, with its year otherwise. */
  const monthWords = month.slice(0, 4) === today.slice(0, 4) ? monthName(month) : monthLabel(month);

  // ── The property asked for: brought into view once, and lit for a moment ──
  useEffect(() => {
    const id = focusRef.current;
    if (!id || !view) return;
    focusRef.current = null;
    const target = document.querySelector(`[data-property="${CSS.escape(id)}"]`);
    if (!target) return;
    target.scrollIntoView({ block: "center" });
    target.classList.add(styles.flash);
    setTimeout(() => target.classList.remove(styles.flash), 2400);
  }, [view]);

  /** Lines the server answered with, put in place of what is shown. */
  const takeLines = (lines: EarningsLineView[]) => {
    const byId = new Map(lines.map((line) => [line.id, line]));
    setRead((prev) => (prev.kind === "ready" ? { kind: "ready", data: { ...prev.data, lines: prev.data.lines.map((line) => byId.get(line.id) ?? line) } } : prev));
  };

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

  // ── The month's routine lines in one confirmation (Kian's ruling K1 of 2026-10-17) ──
  const acceptOnePass = async () => {
    if (busy || !view || view.onePass.lines === 0) return;
    const pass = view.onePass;
    const yes = await ask({
      title: `Accept ${plural(pass.lines, "line", "lines")} for ${plural(pass.properties, "property", "properties")}?`,
      lines: [
        `${formatCents(pass.amountCents)} in ${monthLabel(month)}, each line as Airbnb's file has it.`,
        view.held.length > 0 ? `${plural(view.held.length, "line held", "lines held")} for a decision ${view.held.length === 1 ? "is" : "are"} left out, each decided on its own.` : null,
      ],
      confirm: `Accept ${plural(pass.lines, "line", "lines")}`,
    });
    if (!yes) return;
    clear();
    setBusy("one-pass");
    const result = await acceptMonthLines({ month, groups: pass.groups, expected: { lines: pass.lines, properties: pass.properties, amountCents: pass.amountCents } });
    setBusy(null);
    if (!result.ok) {
      failed(result, result.status === 409);
      return;
    }
    takeLines(result.data.lines);
    setEditing(null);
    const later = Object.values(result.data.statementMonths).filter((m) => m !== month);
    show({
      tone: "success",
      title: `${plural(result.data.lines.length, "line", "lines")} accepted for ${plural(pass.properties, "property", "properties")}.`,
      detail: later.length > 0 ? `${plural(later.length, "property's", "properties'")} ${monthLabel(month)} ${later.length === 1 ? "is" : "are"} finished: ${later.length === 1 ? "its lines go" : "their lines go"} on the next open statement, with the day paid printed.` : `On their ${monthLabel(month)} statements.`,
    });
    settleSoon();
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
    takeLines(result.data.lines);
    setEditing(null);
    const goesOn = result.data.statementMonth;
    show({
      tone: "success",
      title: `${plural(result.data.lines.length, "line", "lines")} accepted for ${group.name}.`,
      detail: goesOn === month ? `On its ${monthLabel(month)} statement.` : `${monthLabel(month)} is finished: on its ${monthLabel(goesOn)} statement, with the day paid printed.`,
    });
    settleSoon();
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
    takeLines(result.data.lines);
    show({ tone: "success", title: `${plural(result.data.lines.length, "line", "lines")} rejected for ${group.name}.` });
    settleSoon();
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
    takeLines([result.data.line]);
    setEditing(null);
    show({ tone: "success", title: "Saved. The line's history keeps what it said before." });
    settleSoon();
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
    takeLines([result.data.line]);
    show({ tone: "success", title: action === "reject" ? "Rejected. It stays listed, and can be proposed again." : "Proposed again: it waits for review." });
    settleSoon();
  };

  // ── Link a title, or change its link ──
  /** `offered`: from an offer that already says what happens (a rename, or the pair), so it asks nothing more. */
  const link = async (row: TitleRow, propertyId: string, offered = false) => {
    if (busy || propertyId === "" || !data) return;
    const name = names.get(propertyId) ?? "the property";
    // The property's active title, if any (Kian's ruling: one per property): asked first (M12), unless offered.
    const active = data.links.find((l) => l.platform === row.platform && l.propertyId === propertyId && isActiveTitle(l) && l.title !== row.title) ?? null;
    const elsewhere = row.link && row.link.propertyId !== null && row.link.propertyId !== propertyId ? (names.get(row.link.propertyId) ?? "a deleted property") : null;
    if ((active && !offered) || elsewhere) {
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
    // The server's answer, in place: the link, and the property's title before it now a previous one. Lines sent back
    // by a move (M13) are known only to the server: read the month now.
    const next = result.data.link;
    setRead((prev) => {
      if (prev.kind !== "ready") return prev;
      const links = prev.data.links
        .filter((l) => l.id !== next.id)
        .map((l) => (result.data.previous !== null && l.platform === next.platform && l.propertyId === next.propertyId && l.title === result.data.previous ? { ...l, active: false } : l));
      return { kind: "ready", data: { ...prev.data, links: [...links, next].sort((a, b) => a.title.localeCompare(b.title)) } };
    });
    if (result.data.sentBack > 0) reread();
    else settleSoon();
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
    // Its lines were rejected by the server: read the month now.
    reread();
    show({ tone: "success", title: `"${row.title}" is set aside as not a Nubnb property.`, detail: result.data.rejected > 0 ? `${plural(result.data.rejected, "line was", "lines were")} rejected.` : undefined });
  };

  // ── A property not paid through Nubnb's files (Kian's ruling K2 of 2026-10-17) ──
  const markSource = async (propertyId: string, notThroughFiles: boolean) => {
    if (busy || !data) return;
    const name = names.get(propertyId) ?? "the property";
    if (notThroughFiles) {
      const yes = await ask({
        title: `Is ${name} not paid through Nubnb's files?`,
        lines: ["Its Airbnb stays then leave the gaps here, and Finish stops warning about them.", "A title linked to it later works as before; Unmark is under Titles."],
        confirm: "Mark not paid through Nubnb's files",
      });
      if (!yes) return;
    }
    clear();
    setBusy(`source:${propertyId}`);
    const result = await setIncomeSource(propertyId, { notThroughFiles, expected: !notThroughFiles });
    setBusy(null);
    if (!result.ok) {
      failed(result, result.status === 409);
      return;
    }
    // The server's answer is the whole change: nothing else in the month moves.
    setRead((prev) => {
      if (prev.kind !== "ready") return prev;
      const others = prev.data.notThroughFiles.filter((id) => id !== propertyId);
      return { kind: "ready", data: { ...prev.data, notThroughFiles: result.data.notThroughFiles ? [...others, propertyId] : others } };
    });
    show({ tone: "success", title: result.data.notThroughFiles ? `${name} is marked not paid through Nubnb's files.` : `${name} is no longer marked: its Airbnb stays are looked for in the files again.` });
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
  const propertyHref = (propertyId: string, tab?: string) => `/admin/property?id=${encodeURIComponent(propertyId)}&month=${month}${tab ? `&tab=${tab}` : ""}`;
  const groupOf = (propertyId: string) => view?.review.find((group) => group.propertyId === propertyId) ?? null;

  const loading = read.kind === "loading";
  const gapCount = view ? view.gaps.unlinked.length + view.gaps.untitled.length + view.gaps.checkIns.length + view.gaps.missing.length : 0;
  const toReview = view ? view.review.reduce((n, g) => n + g.lines.length, 0) : 0;
  const locked = busy !== null || editing !== null;

  /** A line's row: the day paid, its words with its file and row in the tooltip, its amount (as accepted or edited, the file's beside it when they differ), and its actions. */
  const lineRow = (line: EarningsLineView, actions: ReactNode, opts: { label?: string; amountCents?: number; under?: ReactNode } = {}) => {
    const amountCents = opts.amountCents ?? line.amountCents;
    return (
      <tr key={line.id}>
        <td className={styles.cellWhen} title={fromText(line)}>
          {shortDay(line.payoutDate)}
        </td>
        <td className={`${styles.cellWhat} ${styles.colFlex}`} title={`From ${fromText(line)}`}>
          {opts.label ?? proposedLabel(line)}
          {line.status === "proposed" && needsDecision(line) && (
            <span className={`${styles.badge} ${styles.badgeWarn} ${styles.inlineBadge}`} title={`Airbnb's row type “${line.type}” is not one Nubnb recognises: accept it as a line, edited if need be, or reject it.`}>
              Needs a decision
            </span>
          )}
          <span className={styles.cellSub}>{lineSub(line)}</span>
          {opts.under}
        </td>
        <td className={styles.num}>
          <span className={amountCents < 0 ? styles.negative : undefined}>{formatCents(amountCents)}</span>
          {amountCents !== line.amountCents && <span className={styles.cellSub}>in the file {formatCents(line.amountCents)}</span>}
        </td>
        <td className={styles.colFit}>
          <div className={styles.actions}>{actions}</div>
        </td>
      </tr>
    );
  };

  /** A proposed line's edit form, in place of its row. */
  const editRow = (group: ReviewGroup, line: EarningsLineView) =>
    editing?.id === line.id ? (
      <tr key={line.id} className={styles.editRow}>
        <td className={styles.cellWhen}>{shortDay(line.payoutDate)}</td>
        <td colSpan={3}>
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
    ) : null;

  /** A proposed line's actions: Accept (white on a held line, its own decision; quiet on a routine one), and Edit and Reject in its menu. */
  const proposedActions = (group: ReviewGroup, line: EarningsLineView, held = false) => (
    <>
      <button type="button" className={held ? styles.btnApprove : styles.btnGhost} disabled={locked} onClick={() => accept(group, [{ id: line.id }], `accept:${line.id}`)}>
        {busy === `accept:${line.id}` ? "Accepting…" : "Accept"}
      </button>
      <RowMenu
        label={`More for ${proposedLabel(line)}`}
        disabled={locked}
        items={[
          { label: "Edit", onSelect: () => setEditing({ id: line.id, description: proposedLabel(line), amount: amountField(line.amountCents) }) },
          { label: "Reject", onSelect: () => void decide(line, "reject"), danger: true },
        ]}
      />
    </>
  );

  /** A property's row over its lines: its address and Airbnb title, its figures, its statement, and what it does. */
  const groupHead = (group: ReviewGroup, opts: { figure: ReactNode; actions: ReactNode; reasons?: ReactNode }) => (
    <tr className={styles.groupRow} data-property={group.propertyId}>
      <td colSpan={4}>
        <div className={styles.groupInner}>
          <span className={styles.groupName}>
            <Link href={propertyHref(group.propertyId)} prefetch={false} className={`${styles.groupTitle} ${styles.linkButton}`}>
              {group.name}
            </Link>
            {group.titles.length > 0 && <span className={styles.groupTitles}>{group.titles.join(" · ")}</span>}
          </span>
          <span className={styles.groupFigure}>{opts.figure}</span>
          {group.revenueCents !== null && (
            <span className={`${styles.groupFigure} ${group.revenueCents < 0 ? styles.negative : ""}`} title="The month's revenue as it would stand with every line under its titles accepted, as its page figures it">
              {monthWords} revenue {formatCents(group.revenueCents)}
            </span>
          )}
          {group.standing && <StandingBadge view={group.standing} />}
          {group.finished && (
            <span className={`${styles.badge} ${styles.badgeWarn}`} title="A finished statement is never touched: a line accepted now goes on the next open statement, with the day paid printed (Kian's ruling M11).">
              {monthLabel(month)} finished · goes on the next
            </span>
          )}
          <span className={styles.groupAction}>{opts.actions}</span>
        </div>
        {opts.reasons}
      </td>
    </tr>
  );

  /** The held lines by property, in the held list's order. */
  const heldByProperty = useMemo(() => {
    const out: { propertyId: string; lines: HeldLine[] }[] = [];
    for (const held of view?.held ?? []) {
      const last = out[out.length - 1];
      if (last && last.propertyId === held.propertyId) last.lines.push(held);
      else out.push({ propertyId: held.propertyId, lines: [held] });
    }
    return out;
  }, [view]);

  /** The accepted lines by property, A to Z. */
  const acceptedByProperty = useMemo(() => {
    const map = new Map<string, EarningsLineView[]>();
    for (const line of view?.accepted ?? []) {
      if (line.decided?.status !== "accepted") continue;
      map.set(line.decided.propertyId, [...(map.get(line.decided.propertyId) ?? []), line]);
    }
    return [...map.entries()].map(([propertyId, lines]) => ({ propertyId, name: names.get(propertyId) ?? "A deleted property", lines })).sort((a, b) => a.name.localeCompare(b.name));
  }, [view, names]);

  const toggleOpened = (propertyId: string) =>
    setOpened((prev) => {
      const next = new Set(prev);
      if (next.has(propertyId)) next.delete(propertyId);
      else next.add(propertyId);
      return next;
    });

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
            {data.uploads.length > 0 &&
              (() => {
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
                      {view.gaps.unlinked.map((row) => {
                        // A rename the evidence agrees on (M14), else the pair (one missing, one new): offered as one click, never applied by itself.
                        const rename = renames.get(`${row.platform}|${row.title}`);
                        const pair = !rename && view.pair && view.pair.platform === row.platform && view.pair.title === row.title ? view.pair : null;
                        const offer = rename ? { propertyId: rename.propertyId, fromTitle: rename.fromTitle, why: rename.evidence.map((e) => e.text).join(" ") } : pair ? { propertyId: pair.propertyId, fromTitle: pair.fromTitle, why: "Its title is the one missing from this month's file, and this is the month's one new title." } : null;
                        const offerName = offer ? (names.get(offer.propertyId) ?? "a property") : null;
                        return (
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
                            {offer && (
                              <span className={styles.rename}>
                                <span>
                                  May be <strong>{offerName}</strong>
                                  {offer.fromTitle ? <>, renamed from “{offer.fromTitle}”</> : null}:
                                </span>
                                <span className={styles.muted}>
                                  {offer.why}
                                  {offer.fromTitle ? ` “${offer.fromTitle}” stays its previous title, so older files still match.` : ""}
                                </span>
                                <button type="button" className={styles.btnApprove} disabled={busy !== null} onClick={() => link(row, offer.propertyId, true)}>
                                  {busy === `link:${row.title}` ? "Saving…" : `Make it ${offerName}'s title`}
                                </button>
                              </span>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}

                {view.gaps.untitled.length > 0 && (
                  <div className={styles.gapGroup}>
                    <h3 className={styles.gapHead} title="Kian's ruling K2 of 2026-10-17: each property with Airbnb bookings is linked to a title from an uploaded file, or marked not paid through Nubnb's files.">
                      Airbnb bookings, no title · {view.gaps.untitled.length}
                    </h3>
                    <ul className={styles.gapList}>
                      {view.gaps.untitled.map((row) => (
                        <li key={row.propertyId} className={styles.gapItem} data-property={row.propertyId}>
                          <Link href={propertyHref(row.propertyId)} prefetch={false} className={styles.linkButton}>
                            {row.name}
                          </Link>
                          <span className={styles.gapFigures}>{plural(row.stays, "stay", "stays")} on its calendar in {monthLabel(month)}</span>
                          <span className={styles.linkForm}>
                            <Link href={`/admin/property/edit?id=${encodeURIComponent(row.propertyId)}&section=airbnbTitle`} prefetch={false} className={styles.btnGhost}>
                              Set its title
                            </Link>
                            <button type="button" className={styles.btnGhost} disabled={busy !== null} onClick={() => void markSource(row.propertyId, true)}>
                              {busy === `source:${row.propertyId}` ? "Marking…" : "Mark not paid through Nubnb's files"}
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
                          <Link href={propertyHref(row.propertyId)} prefetch={false} className={styles.linkButton}>
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

            {/* ── To review (Kian's ruling K1 of 2026-10-17): the held lines, the one confirmation, then each property's ── */}
            <section className={styles.block} aria-label="To review">
              <div className={styles.blockHead}>
                <h2 className={styles.blockTitle}>To review</h2>
                <span className={styles.blockFigure}>
                  {toReview} to review · {view.accepted.length} accepted · {view.rejected.length} rejected
                </span>
              </div>

              {/* Once nothing waits: the month's statements, and the way to each (the hand-off to Finish). */}
              {toReview === 0 && view.statements.properties > 0 && (
                <div className={styles.handoff} role="status">
                  <span>
                    <strong>
                      {plural(view.statements.properties, "property has", "properties have")} {monthWords} money
                    </strong>
                    {view.statements.notDue > 0 && view.statements.notDue === view.statements.properties ? (
                      <> · not due yet</>
                    ) : (
                      <>
                        {" "}
                        · {view.statements.ready} ready · {view.statements.blocked} blocked
                        {view.statements.finished > 0 && <> · {view.statements.finished} finished</>}
                        {view.statements.notDue > 0 && <> · {view.statements.notDue} not due yet</>}
                      </>
                    )}
                  </span>
                  <span className={styles.handoffLinks}>
                    <Link href="/admin/report-for" prefetch={false} className={styles.linkButton}>
                      Report For sheet
                    </Link>
                    <Link href="/admin?show=ready" prefetch={false} className={styles.linkButton}>
                      Statements ready
                    </Link>
                  </span>
                </div>
              )}

              {toReview === 0 && view.rejected.length === 0 && view.removed.length === 0 && view.accepted.length === 0 ? (
                <p className={styles.empty}>{data.lines.length === 0 ? "Nothing proposed for this month." : view.gaps.unlinked.length > 0 ? "Nothing to review under a linked title. Link the titles above." : "Everything for this month is decided."}</p>
              ) : (
                <>
                  {/* ── Held for a decision of its own, each with why ── */}
                  {view.held.length > 0 && (
                    <div className={styles.heldBlock}>
                      <h3 className={styles.heldTitle}>
                        Held for a decision · {plural(view.held.length, "line", "lines")}
                        <span className={styles.muted}> · each decided on its own, outside the one confirmation</span>
                      </h3>
                      <div className={shared.tableContainer}>
                        <div className={styles.tableScroll}>
                          <table className={shared.table} aria-label="Held for a decision">
                            <tbody>
                              {heldByProperty.map(({ propertyId, lines }) => {
                                const group = groupOf(propertyId);
                                if (!group) return null;
                                // A property held as a whole (it owes no statement, or its month would go below zero): its lines with no reason of their own are decided together.
                                const together = group.holds.length > 0 ? lines.filter((h) => h.reasons.every((r) => r.key === "no-statement" || r.key === "below-zero")) : [];
                                return (
                                  <Fragment key={propertyId}>
                                    {groupHead(group, {
                                      figure: `${plural(lines.length, "line", "lines")} held · ${formatCents(lines.reduce((sum, h) => sum + h.line.amountCents, 0))}`,
                                      actions:
                                        together.length > 1 ? (
                                          <button type="button" className={styles.btnGhost} disabled={locked} onClick={() => accept(group, together.map((h) => ({ id: h.line.id })), `held-all:${propertyId}`)}>
                                            {busy === `held-all:${propertyId}` ? "Accepting…" : `Accept all ${together.length}`}
                                          </button>
                                        ) : null,
                                      reasons: group.holds.length > 0 ? <p className={styles.holdWhy}>{group.holds.map((r) => r.text).join(" ")}</p> : null,
                                    })}
                                    {lines.map((held) =>
                                      editRow(group, held.line) ??
                                      lineRow(held.line, proposedActions(group, held.line, true), {
                                        under: (
                                          <span className={styles.reasons}>
                                            {held.reasons
                                              .filter((r) => r.key !== "no-statement" && r.key !== "below-zero")
                                              .map((r) => (
                                                <span key={r.key + r.text} className={styles.reason}>
                                                  {r.text}
                                                </span>
                                              ))}
                                          </span>
                                        ),
                                      }),
                                    )}
                                  </Fragment>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* ── The month's routine lines in one confirmation ── */}
                  {view.onePass.lines > 0 && (
                    <div className={styles.onePass}>
                      <span className={styles.onePassText}>
                        <strong>
                          {plural(view.onePass.lines, "line", "lines")} for {plural(view.onePass.properties, "property", "properties")}
                        </strong>{" "}
                        · {formatCents(view.onePass.amountCents)}
                        {view.held.length > 0 && <span className={styles.muted}> · {view.held.length} held above</span>}
                      </span>
                      <button type="button" className={styles.btnApprove} disabled={locked} onClick={() => void acceptOnePass()}>
                        {busy === "one-pass" ? "Accepting…" : `Accept ${plural(view.onePass.lines, "line", "lines")}`}
                      </button>
                    </div>
                  )}

                  <div className={shared.tableContainer}>
                    <div className={styles.tableScroll}>
                      <table className={shared.table}>
                        <thead>
                          <tr>
                            <th className={styles.colFit}>Paid</th>
                            <th>Line</th>
                            <th className={styles.num}>Amount</th>
                            <th className={styles.colFit} aria-label="Actions" />
                          </tr>
                        </thead>
                        <tbody>
                          {/* ── Each property's routine lines, with its own Accept all ── */}
                          {view.review
                            .filter((group) => group.routine.length > 0)
                            .map((group) => (
                              <Fragment key={group.propertyId}>
                                {groupHead(group, {
                                  figure: (
                                    <>
                                      {plural(group.routine.length, "line", "lines")} · {formatCents(group.routine.reduce((sum, line) => sum + line.amountCents, 0))}
                                      {group.routine.length < group.lines.length && <span className={styles.muted}> · {group.lines.length - group.routine.length} held above</span>}
                                    </>
                                  ),
                                  actions: (
                                    <span className={styles.actions}>
                                      <button type="button" className={styles.btnGhost} disabled={locked} onClick={() => accept(group, group.routine.map((line) => ({ id: line.id })), `group:${group.propertyId}`)}>
                                        {busy === `group:${group.propertyId}` ? "Accepting…" : group.routine.length === 1 ? "Accept" : `Accept all ${group.routine.length}`}
                                      </button>
                                      <RowMenu label={`More for ${group.name}`} disabled={locked} items={[{ label: group.lines.length === 1 ? "Reject the line" : `Reject all ${group.lines.length} lines`, onSelect: () => void rejectAll(group), danger: true }]} />
                                    </span>
                                  ),
                                })}
                                {group.routine.map((line) =>
                                  editRow(group, line) ??
                                  lineRow(line, proposedActions(group, line), {
                                    under: view.warnings.get(line.id)?.map((said) => (
                                      <span key={said} className={`${styles.cellSub} ${styles.noteWarn}`}>
                                        {said}
                                      </span>
                                    )),
                                  }),
                                )}
                              </Fragment>
                            ))}

                          {/* ── Accepted: one row per property, opened on click ── */}
                          {acceptedByProperty.length > 0 && (
                            <tr className={styles.groupRow}>
                              <td colSpan={4}>
                                <div className={styles.groupInner}>
                                  <span className={styles.groupTitle}>Accepted · {view.accepted.length}</span>
                                  <span className={styles.groupFigure}>{formatCents(view.accepted.reduce((sum, line) => sum + (line.decided?.status === "accepted" ? line.decided.amountCents : 0), 0))}</span>
                                </div>
                              </td>
                            </tr>
                          )}
                          {acceptedByProperty.map(({ propertyId, name, lines }) => {
                            const open = opened.has(propertyId);
                            const total = lines.reduce((sum, line) => sum + (line.decided?.status === "accepted" ? line.decided.amountCents : 0), 0);
                            const lockedCount = lines.filter((line) => data.locked[line.id]).length;
                            const editedCount = lines.filter((line) => line.history.some((h) => h.action === "edited") || (line.decided?.status === "accepted" && line.decided.edited)).length;
                            return (
                              <Fragment key={`accepted-${propertyId}`}>
                                <tr className={styles.foldRow} data-property={propertyId}>
                                  <td colSpan={4}>
                                    <button type="button" className={styles.foldButton} aria-expanded={open} onClick={() => toggleOpened(propertyId)}>
                                      <ChevronDown size={15} aria-hidden className={open ? styles.chevronOpen : styles.chevron} />
                                      <span className={styles.foldName}>{name}</span>
                                      <span className={styles.groupFigure}>
                                        {plural(lines.length, "line", "lines")} · {formatCents(total)}
                                        {editedCount > 0 && ` · ${editedCount} edited`}
                                        {lockedCount > 0 && ` · ${lockedCount} on a finished statement`}
                                      </span>
                                    </button>
                                  </td>
                                </tr>
                                {open &&
                                  lines.map((line) => {
                                    if (line.decided?.status !== "accepted") return null;
                                    const decided = line.decided;
                                    const lock = data.locked[line.id] ?? null;
                                    if (editing?.id === line.id) {
                                      return (
                                        <tr key={line.id} className={styles.editRow}>
                                          <td className={styles.cellWhen}>{shortDay(line.payoutDate)}</td>
                                          <td colSpan={3}>
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
                                        <span className={styles.muted} title="Accepted before dispatch 37C and copied into its draft: changed on the property's page.">
                                          In its draft
                                        </span>
                                      ) : lock ? (
                                        <span className={styles.muted} title="A finished statement prints it. Correct that statement on the property's page to change it.">
                                          Locked · {monthLabel(lock.month)} ({lock.reference})
                                        </span>
                                      ) : (
                                        <>
                                          <button type="button" className={styles.btnGhost} disabled={locked} onClick={() => setEditing({ id: line.id, description: decided.description, amount: amountField(decided.amountCents) })}>
                                            Edit
                                          </button>
                                          <button type="button" className={styles.btnGhost} disabled={locked} onClick={() => decide(line, "propose-again")}>
                                            {busy === `propose-again:${line.id}` ? "Sending back…" : "Send back"}
                                          </button>
                                        </>
                                      ),
                                      { label: `${decided.description}${line.history.some((h) => h.action === "edited") ? " · edited since accepted" : ""}`, amountCents: decided.amountCents },
                                    );
                                  })}
                              </Fragment>
                            );
                          })}

                          {view.removed.length > 0 && (
                            <>
                              <tr className={styles.groupRow}>
                                <td colSpan={4}>
                                  <div className={styles.groupInner}>
                                    <span className={styles.groupTitle}>Accepted before 37C, since removed from the statement · {view.removed.length}</span>
                                  </div>
                                </td>
                              </tr>
                              {view.removed.map((line) =>
                                lineRow(
                                  line,
                                  <button type="button" className={styles.btnGhost} disabled={locked} onClick={() => decide(line, "propose-again")}>
                                    {busy === `propose-again:${line.id}` ? "Proposing…" : "Propose again"}
                                  </button>,
                                  { label: line.decided?.status === "accepted" ? `${line.decided.description} → ${names.get(line.decided.propertyId) ?? "a deleted property"}` : undefined },
                                ),
                              )}
                            </>
                          )}

                          {view.rejected.length > 0 && (
                            <>
                              <tr className={styles.groupRow}>
                                <td colSpan={4}>
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
                                    <button type="button" className={styles.btnGhost} disabled={locked} onClick={() => decide(line, "propose-again")}>
                                      {busy === `propose-again:${line.id}` ? "Proposing…" : "Propose again"}
                                    </button>
                                  ),
                                  { label: `${proposedLabel(line)} · ${line.listingTitle}` },
                                ),
                              )}
                            </>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
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
                          <th className={styles.num} title="Lines under its titles still to review: in no statement until accepted">
                            Waiting
                          </th>
                          <th className={styles.colFit}>Statement</th>
                        </tr>
                      </thead>
                      <tbody>
                        {view.byProperty.map((row) => (
                          <tr key={row.propertyId} data-property={row.propertyId}>
                            <td className={styles.cellWhat}>
                              {row.name === null ? (
                                <span className={styles.muted}>A deleted property ({row.propertyId.slice(0, 6)})</span>
                              ) : (
                                <Link href={propertyHref(row.propertyId)} prefetch={false} className={styles.linkButton}>
                                  {row.name}
                                </Link>
                              )}
                            </td>
                            <td className={styles.num}>{row.lines}</td>
                            <td className={styles.num}>{row.fromFile}</td>
                            <td className={styles.num}>
                              <span className={row.revenueCents < 0 ? styles.negative : undefined}>{formatCents(row.revenueCents)}</span>
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
                              {row.correction ? (
                                <span className={`${styles.badge} ${styles.badgeDone}`}>Finished · correcting</span>
                              ) : row.standing ? (
                                // Its statement in the standing's words, leading to where it is done: Details while blocked, else Finish.
                                <Link href={propertyHref(row.propertyId, owedNow(row.standing.standing) && !row.standing.reportFor ? "details" : "finish")} prefetch={false} className={styles.badgeLink}>
                                  <StandingBadge view={row.standing} />
                                </Link>
                              ) : (
                                <span className={`${styles.badge} ${row.finished ? styles.badgeDone : ""}`}>{row.finished ? "Finished" : "Not finished"}</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </section>

            {/* ── Titles: every title in the month's lines, and its link; the properties not paid through Nubnb's files ── */}
            {(view.titles.length > 0 || view.marked.length > 0) && (
              <details className={`${styles.block} ${styles.titles}`}>
                <summary className={styles.blockHead}>
                  <h2 className={styles.blockTitle}>Titles · {view.titles.length}</h2>
                  <span className={styles.blockFigure}>
                    {view.titles.filter((t) => t.link && !isSetAside(t.link)).length} linked
                    {view.titles.some((t) => isSetAside(t.link)) && <> · {view.titles.filter((t) => isSetAside(t.link)).length} not a Nubnb property</>} · {formatCents(view.titles.reduce((sum, t) => sum + t.amountCents, 0))} as in the file
                    {view.marked.length > 0 && <> · {plural(view.marked.length, "property", "properties")} not paid through Nubnb&rsquo;s files</>}
                  </span>
                </summary>
                {view.titles.length > 0 && (
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
                )}
                {view.marked.length > 0 && (
                  <div className={styles.markedList}>
                    <h3 className={styles.gapHead}>Not paid through Nubnb&rsquo;s files · {view.marked.length}</h3>
                    <ul className={styles.gapList}>
                      {view.marked.map((row) => (
                        <li key={row.propertyId} className={styles.gapItem}>
                          <Link href={propertyHref(row.propertyId)} prefetch={false} className={styles.linkButton}>
                            {row.name}
                          </Link>
                          <span className={styles.linkForm}>
                            <button type="button" className={styles.btnGhost} disabled={busy !== null} onClick={() => void markSource(row.propertyId, false)}>
                              {busy === `source:${row.propertyId}` ? "Unmarking…" : "Unmark"}
                            </button>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </details>
            )}
          </>
        ) : null}
      </main>
      {dialog}
    </div>
  );
}
