"use client";

/**
 * A team member's page (Build 3 of the UX audit, Kian's rulings of 2026-11-02 and 2026-11-03; CLEANER-COSTS-DESIGN.md
 * §70), replacing the pay view: for any cleaner or handyman, one page where an admin sees, month by month, what they
 * did, what Nubnb owes them and why, and pays them on payday in a few clicks. It lives on the Team page, at
 * /admin/cleaners?person={id}&month={yyyy-mm}, drawn from what that page already holds — the team, the cost list, every
 * payment — plus two reads of its own: their jobs of the month on screen, and what their missing amounts start from.
 *
 * ── Paydays (Kian's rulings) ──
 * Paydays are the 1st and the 15th. "A payday pays everything counted and dated before it, minus payments: the 15th
 * covers up to the 14th, the 1st up to the last day of the previous month. The balance stays a running total; anything
 * decided late joins the next payday." Item dates: a cleaning by its job's day; a receipt or work entry by the day it
 * was sent. The arithmetic is app/lib/pay/payday.ts over the one function's rows (balance.ts).
 *
 * ── The head (item 1) ──
 * Name and role; "Owed now" (everything counted, minus payments: the running balance); "Due on <next payday>" (counted
 * and dated before it, minus payments), or "Paid ahead $X", or "Settled". Pay: the amount filled with what is due on
 * the payday just passed or today, editable; the method; the date; one "Pay" button. It asks once if anything dated
 * before that payday still needs an amount or a decision; the PAYMENTS_CHANGED guard and "Pay $X ahead?" stay.
 *
 * ── Needs you (item 2) ──
 * Every item of theirs that needs an amount or a decision, each with its action inline: the amount typed (the cleaning
 * price or the job's amount fills the field; "Last typed" is a placeholder, never a value; an empty field saves
 * nothing); a noted cleaning approved at the cleaning price, at an amount, or declined, with the note shown; a receipt
 * or work entry approved or rejected with a reason, with a photo link for receipts. The same server routes and history
 * as the Costs page and the Cleanings tab, which stay as they are.
 *
 * ── The month (items 3, 4, 5) ──
 * A month switcher; above the calendar the month's figures (app/lib/pay/month.ts); each day of the calendar shows the
 * person's jobs (unit, label, done or not), receipts and work (amount, status), payments, and the 1st and the 15th
 * marked with what was due; clicking a day lists its items. The dated list (what counts, what was paid, what changed)
 * defaults to the month on screen. Desktop at 1280 and 1440 only.
 *
 * Nothing here is optimistic: a payment appears, or is marked deleted, a cleaning's amount changes and an entry's state
 * changes as the server stored them. The cleaner app shows no pay (Kian's ruling of 2026-10-16).
 */

import { useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { AdminSelect } from "../components/AdminSelect";
import { DateRangeField } from "../components/DateRangeField";
import type { Notice } from "../components/Notice";
import type { Question } from "../components/AskDialog";
import { CLEANER_ROLE_LABELS, CLEANER_STATUS_LABELS, formatCents, isCleanerRole, isCleanerStatus, type CleanerSummary, type CostEntryView } from "@/app/lib/cleaners/model";
import { amountField, readAmountCents, type CleaningView } from "@/app/lib/cleanings/model";
import { fieldStart, missingAmountStart, type CleaningPrices } from "@/app/lib/cleanings/prices";
import { changeCleaning, decideCleaningExtra, fetchAmountStarts, fetchReceiptLink, setEntryStatus } from "@/app/lib/costs-client";
import { longDay, shortDay } from "@/app/lib/costs/report";
import { balanceWords, changeWords, dayWords, memberPay, rowItemWords, type PayChange, type PayRow } from "@/app/lib/pay/balance";
import { paydayQuestions } from "@/app/lib/pay/checks";
import { calendarOf, jobsWords, monthSummary, type DayItem, type PersonJob } from "@/app/lib/pay/month";
import { PAYMENT_METHOD_LABELS, PAYMENT_METHODS, earliestPaymentDay, paymentsSeen, type PaymentMethod, type PaymentView } from "@/app/lib/pay/model";
import { dueOn, dueWords, lastPayday, nextPayday, paydayWords } from "@/app/lib/pay/payday";
import { deletePayment, recordPayment } from "@/app/lib/pay-client";
import { fetchMemberMonth, type RegularProperty } from "@/app/lib/cleaners-client";
import { addMonths, monthLabel } from "@/app/lib/reports/model";
import shared from "../page.module.css";
import styles from "./page.module.css";

interface PersonPageProps {
  member: CleanerSummary;
  cleanings: readonly CleaningView[];
  entries: readonly CostEntryView[];
  payments: readonly PaymentView[];
  /** Payments that could not be read, anyone's: the balance is then never shown as whole. */
  unreadablePayments: number;
  /** The properties they are the regular cleaner for and their open jobs from today on; null while that read is out or failed. */
  schedule: { regular: RegularProperty[]; upcoming: number } | null;
  today: string;
  /** The month on screen, yyyy-mm. */
  month: string;
  onMonth: (month: string) => void;
  onBack: () => void;
  /** Read the team, the cost list and the payments again: the Team page's Refresh, in this page's head. */
  onRefresh: () => void;
  /** A payment as the server stored it, recorded or deleted. */
  onPayment: (payment: PaymentView) => void;
  /** A cleaning as the server stored it after an amount was typed or a note decided here. */
  onCleaning: (cleaning: CleaningView) => void;
  /** A receipt or work entry as the server stored it after a decision here. */
  onEntry: (entry: CostEntryView) => void;
  show: (notice: Notice) => void;
  clear: () => void;
  ask: (question: Question) => Promise<boolean>;
}

/** Shown struck through: it counted once, or would have, and does not now. */
const STRUCK: readonly PayRow["state"][] = ["removed", "rejected", "nubnb-card", "moved", "deleted"];

/** The change a row's note already tells, by its first words: it is not told twice. */
const NOTE_TELLS: Partial<Record<PayRow["state"], string>> = { removed: "Removed", rejected: "Rejected", "nubnb-card": "Marked paid with Nubnb's card", moved: "Given to " };

/** A plain click, which opens in place; any other (a new tab, a new window) is left to the browser. */
export const plainClick = (event: MouseEvent) => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

/** "300", "$1,240.5", "300.00" → "300.00"; null when it is not dollars and cents. */
function amountText(typed: string): string | null {
  const match = /^\$?(\d{1,6})(?:\.(\d{1,2}))?$/.exec(typed.replace(/[\s,]/g, ""));
  return match ? `${Number(match[1])}.${(match[2] ?? "0").padEnd(2, "0")}` : null;
}

/** What the missing amounts start from: read once for the person's waiting cleanings; "failed" leaves every field empty, and says so. */
type Starts = { kind: "none" } | { kind: "loading" } | { kind: "ready"; prices: Record<string, CleaningPrices>; jobs: Record<string, { nights: number; cleaners: number }> } | { kind: "failed"; title: string };

/** The person's jobs of a month: read once per month opened; a failed read is said, never shown as no jobs. */
type JobsState = { kind: "loading" } | { kind: "ready"; jobs: PersonJob[] } | { kind: "failed"; title: string };

/** The property's name as the admin shows it. */
const propertyWords = (c: CleaningView) => c.property.internalName ?? c.property.name ?? c.propertyNameAtEntry ?? "Unknown property";
const entryProperty = (e: CostEntryView) => e.property.internalName ?? e.property.name ?? e.property.nameAtEntry ?? "Unknown property";

const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(" ");

/** The earliest month the switcher reaches: before the first payments, nothing of a person's is dated. */
const FIRST_MONTH = "2026-01";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function PersonPage({ member, cleanings, entries, payments, unreadablePayments, schedule, today, month, onMonth, onBack, onRefresh, onPayment, onCleaning, onEntry, show, clear, ask }: PersonPageProps) {
  const name = member.name !== null && member.name.trim() !== "" ? member.name : "this team member";
  const pay = useMemo(() => memberPay(member.id, { cleanings, entries, payments }), [member.id, cleanings, entries, payments]);
  const rows = pay.rows;

  // ── The paydays ──
  const next = nextPayday(today);
  const last = lastPayday(today);
  const dueNext = useMemo(() => dueOn(next, rows), [next, rows]);
  const dueLast = useMemo(() => dueOn(last, rows), [last, rows]);
  const owed = balanceWords(pay.balanceCents);
  const nextWords = dueWords(dueNext.dueCents, pay.balanceCents);

  // ── Pay: the amount follows what is due on the payday just passed or today until the admin types in it ──
  const fill = dueLast.dueCents > 0 ? amountField(dueLast.dueCents) : "";
  const [amountTyped, setAmountTyped] = useState<string | null>(null);
  const amount = amountTyped ?? fill;
  const [day, setDay] = useState(today);
  const [method, setMethod] = useState<PaymentMethod>("e-transfer");
  /** The one write in flight: paying, deleting the payment with this ID, saving or deciding the item with this ID, or "all". */
  const [busy, setBusy] = useState<string | null>(null);

  // ── Needs you: their cleanings with no amount, their noted cleanings, their receipts and work not yet decided ──
  const waitingCleanings = useMemo(() => cleanings.filter((c) => c.cleanerId === member.id && c.status === "logged" && c.amountCents === null).sort((a, b) => a.day.localeCompare(b.day) || a.createdAt.localeCompare(b.createdAt)), [cleanings, member.id]);
  const notedCleanings = useMemo(() => cleanings.filter((c) => c.cleanerId === member.id && c.status === "logged" && c.extra?.status === "asked" && c.amountCents !== null).sort((a, b) => a.day.localeCompare(b.day) || a.createdAt.localeCompare(b.createdAt)), [cleanings, member.id]);
  const waitingEntries = useMemo(() => rows.filter((row) => row.state === "waiting").map((row) => ({ row, entry: entries.find((e) => e.id === row.id) })).filter((x): x is { row: PayRow; entry: CostEntryView } => x.entry !== undefined).sort((a, b) => (a.row.day ?? "").localeCompare(b.row.day ?? "") || (a.row.at ?? "").localeCompare(b.row.at ?? "")), [rows, entries]);
  const flagged = useMemo(() => new Set(entries.filter((e) => (e.possibleDuplicates?.length ?? 0) > 0).map((e) => e.id)), [entries]);
  const differs = useMemo(() => new Set(entries.filter((e) => e.totalDiffers !== undefined).map((e) => e.id)), [entries]);
  /** Decided or saved here: kept in the list, with what was done, until the page is refreshed. */
  const [doneHere, setDoneHere] = useState<Map<string, { day: string; item: string; words: string }>>(new Map());
  const [starts, setStarts] = useState<Starts>({ kind: "none" });
  const startsAsked = useRef<Set<string>>(new Set());
  const [typing, setTyping] = useState<Record<string, string>>({});
  const [approveAt, setApproveAt] = useState<Record<string, string>>({});
  /** The entry whose rejection reason is being typed, and the reason. */
  const [rejecting, setRejecting] = useState<{ id: string; reason: string } | null>(null);
  const wanted = useMemo(() => {
    const properties = [...new Set(waitingCleanings.map((c) => c.propertyId))];
    const jobs = [...new Set(cleanings.filter((c) => properties.includes(c.propertyId) && c.status === "logged" && c.jobId !== null && (c.amountCents === null || c.amountFrom === "typed")).map((c) => c.jobId as string))];
    return { properties, jobs };
  }, [waitingCleanings, cleanings]);
  const wantedKey = `${wanted.properties.join(",")}|${wanted.jobs.join(",")}`;
  useEffect(() => {
    if (wanted.properties.length === 0) {
      setStarts((prev) => (prev.kind === "ready" ? prev : { kind: "none" }));
      return;
    }
    if (starts.kind === "ready" && wanted.properties.every((id) => id in starts.prices || startsAsked.current.has(`p:${id}`)) && wanted.jobs.every((id) => id in starts.jobs || startsAsked.current.has(`j:${id}`))) return;
    let cancelled = false;
    setStarts({ kind: "loading" });
    for (const id of wanted.properties) startsAsked.current.add(`p:${id}`);
    for (const id of wanted.jobs) startsAsked.current.add(`j:${id}`);
    fetchAmountStarts(wanted.properties.slice(0, 40), wanted.jobs.slice(0, 200)).then((result) => {
      if (cancelled) return;
      setStarts(result.ok ? { kind: "ready", prices: result.data.prices, jobs: result.data.jobs } : { kind: "failed", title: result.title });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the IDs, not the arrays: read again only when the set grows
  }, [wantedKey]);
  const startOf = (c: CleaningView) => (starts.kind === "ready" ? missingAmountStart(starts.prices[c.propertyId] ?? null, cleanings, starts.jobs, c) : null);
  /** What a field holds: what was typed, else what it opened with — the cleaning price or the job's amount; a recommendation is a placeholder only (never save a suggestion). */
  const fieldOf = (c: CleaningView) => typing[c.id] ?? fieldStart(startOf(c)).value;
  const fieldWords = (c: CleaningView): string => {
    if (starts.kind === "loading") return "Reading what it starts from…";
    if (starts.kind === "failed") return "Could not read what it starts from: type the amount.";
    const start = startOf(c);
    return start ? fieldStart(start).words : "";
  };

  // ── The month: their jobs, read once per month opened ──
  const [jobsByMonth, setJobsByMonth] = useState<Record<string, JobsState>>({});
  const [jobsAttempt, setJobsAttempt] = useState(0);
  /** The months whose jobs were read: each once while the page is open, or again on Try again. */
  const monthsRead = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (monthsRead.current.has(month)) return;
    monthsRead.current.add(month);
    let cancelled = false;
    fetchMemberMonth(member.id, month).then((result) => {
      if (cancelled) {
        monthsRead.current.delete(month);
        return;
      }
      if (!result.ok) monthsRead.current.delete(month);
      setJobsByMonth((was) => ({ ...was, [month]: result.ok ? { kind: "ready", jobs: result.data.jobs } : { kind: "failed", title: result.title } }));
    });
    return () => {
      cancelled = true;
    };
  }, [member.id, month, jobsAttempt]);
  const jobsState = useMemo<JobsState>(() => jobsByMonth[month] ?? { kind: "loading" }, [jobsByMonth, month]);
  const jobs = useMemo(() => (jobsState.kind === "ready" ? jobsState.jobs : []), [jobsState]);
  const myCleanings = useMemo(() => cleanings.filter((c) => c.cleanerId === member.id), [cleanings, member.id]);
  const summary = useMemo(() => monthSummary(month, rows, myCleanings, jobs, today), [month, rows, myCleanings, jobs, today]);
  const weeks = useMemo(() => calendarOf(month, rows, jobs, today), [month, rows, jobs, today]);
  const [picked, setPicked] = useState<string | null>(null);
  const [scope, setScope] = useState<"month" | "all">("month");
  const changeMonth = (to: string) => {
    onMonth(to);
    setPicked(null);
    setScope("month");
  };
  const newest = addMonths(today.slice(0, 7), 1);
  const olderMonth = month > FIRST_MONTH ? addMonths(month, -1) : null;
  const newerMonth = month < newest ? addMonths(month, 1) : null;
  const pickedDay = picked === null ? null : weeks.flat().find((d) => d.day === picked) ?? null;
  const listRows = scope === "month" ? rows.filter((row) => row.day !== null && row.day.slice(0, 7) === month) : rows;

  const failed = (result: { title: string; detail?: string; unknown: boolean }, what: string) =>
    show(result.unknown ? { tone: "warning", title: `It may or may not have been ${what}. Refresh to see what is on record.`, detail: result.title } : { tone: "error", title: result.title, detail: result.detail });
  const keep = (id: string, day: string, item: string, words: string) => setDoneHere((was) => new Map(was).set(id, { day, item, words }));

  /** One cleaning's amount saved through the Cleanings tab's route: the server's copy replaces the page's. An empty field saves nothing. */
  const saveOne = async (c: CleaningView): Promise<boolean> => {
    if (fieldOf(c).trim() === "") return false;
    const cents = readAmountCents(fieldOf(c));
    if (cents === null) {
      show({ tone: "error", title: `Type the amount for ${propertyWords(c)}, ${shortDay(c.day)}: dollars and cents above $0.00, like 65.00.` });
      return false;
    }
    const result = await changeCleaning(c.id, { seen: c.history.length, amount: amountField(cents), reason: null });
    if (!result.ok) {
      failed(result, "saved");
      return false;
    }
    onCleaning({ ...result.data.cleaning, cleaner: c.cleaner, property: c.property });
    keep(c.id, c.day, `Cleaning · ${propertyWords(c)}`, `Saved ${formatCents(cents)} · Counted`);
    return true;
  };
  const saveAmount = async (c: CleaningView) => {
    if (busy !== null) return;
    clear();
    setBusy(c.id);
    const ok = await saveOne(c);
    setBusy(null);
    if (ok) show({ tone: "success", title: `Saved ${formatCents(readAmountCents(fieldOf(c)) ?? 0)} for the cleaning at ${propertyWords(c)} on ${dayWords(c.day)}.`, detail: "Owed now and the dues follow it." });
  };
  const saveAll = async () => {
    if (busy !== null) return;
    const ready = waitingCleanings.filter((c) => fieldOf(c).trim() !== "");
    if (ready.length === 0) return;
    clear();
    setBusy("all");
    let saved = 0;
    for (const c of ready) {
      if (!(await saveOne(c))) break;
      saved += 1;
    }
    setBusy(null);
    if (saved === ready.length) show({ tone: "success", title: `Saved ${saved === 1 ? "1 amount" : `${saved} amounts`}.`, detail: "Owed now and the dues follow them." });
    else if (saved > 0) show({ tone: "warning", title: `Saved ${saved} of ${ready.length} amounts; the rest were not sent.`, detail: "Fix the one that failed and press Save all again." });
  };

  /** A noted cleaning decided here, through the Cleanings tab's route: at the cleaning price it arrived with, at an amount, or declined. */
  const decideNote = async (c: CleaningView, decision: "approve" | "decline", at: string | null) => {
    if (busy !== null) return;
    let amountSent: string | undefined;
    if (at !== null) {
      const cents = readAmountCents(at);
      if (cents === null) {
        show({ tone: "error", title: `Type the amount to approve at: dollars and cents above $0.00, like 65.00.` });
        return;
      }
      amountSent = amountField(cents);
    }
    clear();
    setBusy(c.id);
    const result = await decideCleaningExtra(c.id, { seen: c.history.length, decision, ...(amountSent !== undefined ? { amount: amountSent } : {}), reason: null });
    setBusy(null);
    if (!result.ok) {
      failed(result, "decided");
      return;
    }
    const stored = result.data.cleaning;
    onCleaning({ ...stored, cleaner: c.cleaner, property: c.property });
    const words = decision === "decline" ? `Declined · ${stored.amountCents === null ? "nothing" : formatCents(stored.amountCents)} counts · Counted` : `Approved at ${stored.amountCents === null ? "no amount" : formatCents(stored.amountCents)} · Counted`;
    keep(c.id, c.day, `Cleaning · ${propertyWords(c)}`, words);
    show({ tone: "success", title: `${decision === "decline" ? "Declined" : "Approved"} the note on ${propertyWords(c)}, ${dayWords(c.day)}.`, detail: "Owed now and the dues follow it." });
  };

  /** A receipt or work entry decided here, through the Costs page's route: approved, or rejected with a reason the cleaner sees. */
  const decideEntry = async (row: PayRow, e: CostEntryView, status: "approved" | "rejected", reason: string | null) => {
    if (busy !== null) return;
    if (status === "rejected" && (reason === null || reason.trim() === "")) {
      show({ tone: "error", title: "A rejection needs a reason: the cleaner sees it in their app." });
      return;
    }
    clear();
    setBusy(e.id);
    const result = await setEntryStatus(e.id, { status, reason: status === "rejected" ? (reason as string).trim() : null, seen: e.history?.length ?? 0 });
    setBusy(null);
    if (!result.ok) {
      failed(result, status === "approved" ? "approved" : "rejected");
      return;
    }
    onEntry({ ...result.data.entry, cleaner: e.cleaner, property: e.property });
    setRejecting(null);
    keep(e.id, row.day ?? today, rowItemWords(row), status === "approved" ? `Approved${row.amountCents !== null ? ` ${formatCents(row.amountCents)}` : ""} · Counted` : `Rejected: “${(reason as string).trim()}”`);
    show({ tone: "success", title: `${status === "approved" ? "Approved" : "Rejected"} the ${e.kind === "work" ? "work" : "receipt"} at ${entryProperty(e)}, sent ${row.day ? dayWords(row.day) : "on an unknown day"}.`, detail: status === "approved" ? "Owed now and the dues follow it." : "The cleaner sees the reason in their app." });
  };

  /** The receipt's photo, in a new tab, through the Costs page's 60-second link. */
  const openPhoto = async (e: CostEntryView) => {
    const tab = window.open("", "_blank", "noopener");
    const result = await fetchReceiptLink(e.id);
    if (!result.ok) {
      tab?.close();
      show({ tone: "error", title: result.title, detail: result.detail });
      return;
    }
    if (tab) tab.location.href = result.data.url;
    else window.open(result.data.url, "_blank", "noopener");
  };

  const record = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy !== null) return;
    const text = amountText(amount);
    if (text === null) {
      show({ tone: "error", title: "Type the amount as dollars and cents, like 300.00." });
      return;
    }
    if (text === "0.00") {
      show({ tone: "error", title: "A payment is more than $0.00." });
      return;
    }
    // Asked once when anything dated before the payday still needs an amount or a decision; K2 before paying more than is owed.
    for (const question of paydayQuestions(rows, last, paydayWords(last), pay, Math.round(Number(text) * 100), name)) {
      if (!(await ask(question))) return;
    }
    clear();
    setBusy("record");
    const result = await recordPayment({ memberId: member.id, amount: text, day, method, note: null, seen: paymentsSeen(payments, member.id) });
    setBusy(null);
    if (!result.ok) {
      show(result.unknown ? { tone: "warning", title: "The payment may or may not have been recorded. Refresh to see before recording it again.", detail: result.title } : { tone: "error", title: result.title, detail: result.detail ?? "Nothing was recorded." });
      return;
    }
    const stored = result.data.payment;
    onPayment(stored);
    // The field follows what is still due again: nothing when the payday is settled.
    setAmountTyped(null);
    show({ tone: "success", title: `Paid ${name} ${formatCents(stored.amountCents)} on ${dayWords(stored.day)} (${PAYMENT_METHOD_LABELS[stored.method].toLowerCase()}).` });
  };

  const remove = async (payment: PaymentView) => {
    if (busy !== null) return;
    const yes = await ask({
      title: `Delete ${name}'s payment of ${formatCents(payment.amountCents)} on ${dayWords(payment.day)} (${PAYMENT_METHOD_LABELS[payment.method].toLowerCase()}, recorded by ${payment.recordedBy.name ?? "an admin"})?`,
      lines: [`It stays in ${name}'s history, marked deleted by you, and stops counting as paid.`],
      confirm: "Delete payment",
      danger: true,
    });
    if (!yes) return;
    clear();
    setBusy(payment.id);
    const result = await deletePayment(payment.id, payment.history.length);
    setBusy(null);
    if (!result.ok) {
      show(result.unknown ? { tone: "warning", title: "The payment may or may not have been deleted. Refresh to see.", detail: result.title } : { tone: "error", title: result.title, detail: result.detail ?? "Nothing was deleted." });
      return;
    }
    onPayment(result.data.payment);
    // The amount field clears (Build 2, item 6): the deleted figure is not re-offered.
    setAmountTyped("");
    show({ tone: "success", title: `Deleted the payment of ${formatCents(payment.amountCents)} on ${dayWords(payment.day)}.`, detail: `It stays in ${name}'s history, struck through, and no longer counts as paid.` });
  };

  const role = isCleanerRole(member.role) ? CLEANER_ROLE_LABELS[member.role] : (member.role ?? "No role");
  const status = isCleanerStatus(member.status) ? CLEANER_STATUS_LABELS[member.status] : (member.status ?? "No status");
  const needsCount = waitingCleanings.length + notedCleanings.length + waitingEntries.length;
  const fieldsReady = waitingCleanings.filter((c) => fieldOf(c).trim() !== "").length;

  return (
    <>
      {/* ── Who, and the page's own button (Kian's ruling of 2026-10-15: none in the navigation) ── */}
      <div className={styles.payTop}>
        <div className={styles.payWho}>
          <a
            href="/admin/cleaners"
            className={styles.payBack}
            onClick={(event) => {
              if (!plainClick(event)) return;
              event.preventDefault();
              onBack();
            }}
          >
            <ChevronLeft size={16} aria-hidden />
            <span>Team</span>
          </a>
          <h2 className={styles.payTitle}>{name}</h2>
          <p className={styles.payMeta}>
            {role} · {status}
          </p>
          {member.role !== "handyman" && (
            <p className={styles.payMeta} data-schedule>
              {schedule === null ? (
                "Regular cleaner for: … · jobs ahead: …"
              ) : (
                <>
                  Regular cleaner for:{" "}
                  {schedule.regular.length === 0
                    ? "no property"
                    : schedule.regular.map((p, i) => (
                        <span key={p.propertyId}>
                          {i > 0 && ", "}
                          <Link href={`/admin/property?id=${encodeURIComponent(p.propertyId)}`} prefetch={false} className={styles.payLink}>
                            {p.name}
                          </Link>
                        </span>
                      ))}
                  {" · "}
                  <Link href={`/admin/schedule?cleaner=${encodeURIComponent(member.id)}`} prefetch={false} className={styles.payLink}>
                    {schedule.upcoming === 1 ? "1 job ahead" : `${schedule.upcoming} jobs ahead`}
                  </Link>
                </>
              )}
            </p>
          )}
        </div>
        <button type="button" className={shared.btnGhost} onClick={onRefresh} disabled={busy !== null}>
          <RefreshCw size={15} aria-hidden />
          <span>Refresh</span>
        </button>
      </div>

      {/* ── Owed now, Due on the next payday, and Pay (item 1) ── */}
      <div className={styles.personHead}>
        <div className={cx(styles.payFigure, owed.tone === "ahead" && styles.payFigureWarn)} data-figure="owed">
          <span className={styles.payFigureLabel}>Owed now</span>
          <span className={styles.payFigureValue}>{owed.tone === "owed" ? formatCents(pay.balanceCents) : owed.words}</span>
          <span className={styles.payFigureDetail}>everything counted, minus payments{needsCount > 0 ? ` · ${needsCount === 1 ? "1 item needs" : `${needsCount} items need`} you below` : ""}</span>
        </div>
        <div className={cx(styles.payFigure, nextWords.tone === "ahead" && styles.payFigureWarn)} data-figure="due">
          <span className={styles.payFigureLabel}>Due on {paydayWords(next)}</span>
          <span className={styles.payFigureValue}>{nextWords.words}</span>
          <span className={styles.payFigureDetail}>counted and dated up to {paydayWords(dueNext.cutoff)}, minus payments</span>
        </div>
        <form className={cx(styles.payFigure, styles.payBox)} onSubmit={record} noValidate aria-labelledby="person-pay-title" data-figure="pay">
          <span id="person-pay-title" className={styles.payFigureLabel}>
            Pay · {dueLast.dueCents > 0 ? `due on ${paydayWords(last)}: ${formatCents(dueLast.dueCents)}` : `nothing due on ${paydayWords(last)}`}
          </span>
          <div className={styles.payBoxRow}>
            <label className={styles.payField}>
              <span className={shared.srOnly}>Amount ($)</span>
              <input type="text" inputMode="decimal" autoComplete="off" placeholder="0.00" aria-label="Amount ($)" className={cx(styles.payInput, styles.payBoxAmount)} value={amount} onChange={(event) => setAmountTyped(event.target.value)} disabled={busy !== null} />
            </label>
            <div className={styles.payField}>
              <AdminSelect label="Method" value={method} onChange={(value) => setMethod(value as PaymentMethod)} groups={[{ options: PAYMENT_METHODS.map((value) => ({ value, label: PAYMENT_METHOD_LABELS[value] })) }]} disabled={busy !== null} />
            </div>
            <div className={styles.payField}>
              <DateRangeField label="Date paid" single from={day} to={day} max={today} min={earliestPaymentDay(today)} onChange={(chosen) => setDay(chosen.from)} />
            </div>
            <button type="submit" className={cx(shared.btnPrimary, styles.payBoxButton)} disabled={busy !== null}>
              {busy === "record" ? "Paying…" : "Pay"}
            </button>
          </div>
          <span className={styles.payFigureDetail}>
            {paydayWords(last)} covers up to {paydayWords(dueLast.cutoff)}
            {amountTyped !== null && amountTyped !== fill ? " · the amount is yours" : dueLast.dueCents > 0 ? " · filled with what is due" : ""}
          </span>
        </form>
      </div>
      {(pay.cannotAddUp > 0 || unreadablePayments > 0) && (
        <ul className={styles.payNotes}>
          {pay.cannotAddUp > 0 && <li className={styles.payWarn}>{pay.cannotAddUp === 1 ? "1 entry cannot" : `${pay.cannotAddUp} entries cannot`} add up and {pay.cannotAddUp === 1 ? "is" : "are"} left out: the figures are not whole.</li>}
          {unreadablePayments > 0 && <li className={styles.payWarn}>{unreadablePayments === 1 ? "1 payment" : `${unreadablePayments} payments`} could not be read and {unreadablePayments === 1 ? "is" : "are"} left out: the figures are not whole.</li>}
        </ul>
      )}

      {/* ── Needs you (item 2): every item that needs an amount or a decision, each with its action inline ── */}
      {(needsCount > 0 || doneHere.size > 0) && (
        <section className={styles.notCounted} aria-labelledby="person-needs-title">
          <h2 id="person-needs-title" className={styles.codeEditorTitle}>
            Needs you · {needsCount}
          </h2>
          <p className={styles.notCountedNote}>
            {needsCount > 0 ? "Not in Owed now or the dues until decided. Each action is the Costs page's and the Cleanings tab's own." : "Everything is decided: what was saved or decided here is in Owed now and the dues."}
          </p>
          <table className={cx(styles.waitingTable, styles.needsTable)} aria-label="Needs you">
            <thead>
              <tr>
                <th>Day</th>
                <th>Item</th>
                <th>What it needs</th>
                <th className={styles.payCol}>Action</th>
              </tr>
            </thead>
            <tbody>
              {waitingCleanings.map((c) => {
                const start = startOf(c);
                const opens = fieldStart(start);
                return (
                  <tr key={`amount:${c.id}`}>
                    <td className={styles.payDay}>{dayWords(c.day)}</td>
                    <td>Cleaning · {propertyWords(c)}</td>
                    <td>
                      <span className={styles.needsWord}>Needs an amount</span>
                      {c.note && <span className={styles.needsNote}>Note: “{c.note}”</span>}
                    </td>
                    <td className={styles.payCol}>
                      <form
                        className={styles.waitingForm}
                        onSubmit={(event) => {
                          event.preventDefault();
                          void saveAmount(c);
                        }}
                      >
                        <span className={styles.waitingField}>
                          <input className={cx(styles.payInput, styles.waitingInput)} inputMode="decimal" autoComplete="off" aria-label={`Amount for ${propertyWords(c)}, ${shortDay(c.day)}, ${name}`} title={fieldWords(c)} placeholder={opens.placeholder} value={fieldOf(c)} onChange={(e) => setTyping((was) => ({ ...was, [c.id]: e.target.value }))} disabled={busy !== null} />
                          <span className={styles.waitingWords} data-start={start?.kind ?? starts.kind}>
                            {fieldWords(c)}
                          </span>
                        </span>
                        <button type="submit" className={cx(styles.rowAction, styles.waitingSave)} disabled={busy !== null || fieldOf(c).trim() === ""}>
                          {busy === c.id ? "Saving…" : "Save"}
                        </button>
                      </form>
                    </td>
                  </tr>
                );
              })}
              {notedCleanings.map((c) => (
                <tr key={`note:${c.id}`}>
                  <td className={styles.payDay}>{dayWords(c.day)}</td>
                  <td>
                    Cleaning · {propertyWords(c)}
                    {c.amountCents !== null && <span className={styles.needsAmount}> · {formatCents(c.amountCents)}</span>}
                  </td>
                  <td>
                    <span className={styles.needsWord}>Needs a decision</span>
                    <span className={styles.needsNote}>“{c.extra?.reason}”</span>
                  </td>
                  <td className={styles.payCol}>
                    <form
                      className={styles.decideRow}
                      onSubmit={(event) => {
                        event.preventDefault();
                        if ((approveAt[c.id] ?? "").trim() !== "") void decideNote(c, "approve", approveAt[c.id]);
                      }}
                    >
                      <button type="button" className={cx(styles.rowAction, styles.decidePrimary)} disabled={busy !== null || c.amountCents === null} onClick={() => void decideNote(c, "approve", null)} title={c.amountCents === null ? "No cleaning price to approve at: type an amount" : `Approve at ${formatCents(c.amountCents)}, the cleaning price it arrived with`}>
                        {busy === c.id ? "Saving…" : "Approve at cleaning price"}
                      </button>
                      <input className={cx(styles.payInput, styles.waitingInput)} inputMode="decimal" autoComplete="off" aria-label={`Approve ${propertyWords(c)}, ${shortDay(c.day)} at this amount`} placeholder="0.00" value={approveAt[c.id] ?? ""} onChange={(e) => setApproveAt((was) => ({ ...was, [c.id]: e.target.value }))} disabled={busy !== null} />
                      <button type="submit" className={styles.rowAction} disabled={busy !== null || (approveAt[c.id] ?? "").trim() === ""}>
                        Approve at this amount
                      </button>
                      <button type="button" className={styles.rowAction} disabled={busy !== null || c.amountCents === null} onClick={() => void decideNote(c, "decline", null)} title={c.amountCents === null ? "No cleaning price to fall back on: approve at an amount" : "The cleaning price counts"}>
                        Decline
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
              {waitingEntries.map(({ row, entry }) => (
                <tr key={`entry:${row.id}`}>
                  <td className={styles.payDay}>{row.day ? dayWords(row.day) : <span className={styles.payWarn}>No date</span>}</td>
                  <td>
                    {rowItemWords(row)}
                    {row.amountCents !== null && <span className={styles.needsAmount}> · {formatCents(row.amountCents)}</span>}
                  </td>
                  <td>
                    <span className={styles.needsWord}>Needs a decision</span>
                    {flagged.has(row.id) && <span className={styles.needsNote}>Flagged as a possible second send</span>}
                    {differs.has(row.id) && <span className={styles.needsNote}>The total differs from the receipt</span>}
                    {entry.note && <span className={styles.needsNote}>Note: “{entry.note}”</span>}
                  </td>
                  <td className={styles.payCol}>
                    {rejecting?.id === row.id ? (
                      <form
                        className={styles.decideRow}
                        onSubmit={(event) => {
                          event.preventDefault();
                          void decideEntry(row, entry, "rejected", rejecting.reason);
                        }}
                      >
                        <input className={cx(styles.payInput, styles.reasonInput)} type="text" autoComplete="off" aria-label={`Reason for rejecting ${rowItemWords(row)}`} placeholder="Why, for the cleaner" maxLength={500} value={rejecting.reason} onChange={(e) => setRejecting({ id: row.id, reason: e.target.value })} disabled={busy !== null} />
                        <button type="submit" className={cx(styles.rowAction, styles.rowActionDanger)} disabled={busy !== null || rejecting.reason.trim() === ""}>
                          {busy === row.id ? "Saving…" : "Reject"}
                        </button>
                        <button type="button" className={styles.rowAction} disabled={busy !== null} onClick={() => setRejecting(null)}>
                          Cancel
                        </button>
                      </form>
                    ) : (
                      <div className={styles.decideRow}>
                        <button type="button" className={cx(styles.rowAction, styles.decidePrimary)} disabled={busy !== null} onClick={() => void decideEntry(row, entry, "approved", null)}>
                          {busy === row.id ? "Saving…" : "Approve"}
                        </button>
                        <button type="button" className={cx(styles.rowAction, styles.rowActionDanger)} disabled={busy !== null} onClick={() => setRejecting({ id: row.id, reason: "" })}>
                          Reject…
                        </button>
                        {row.kind === "receipt" && (entry.receipts?.length ?? 0) > 0 && (
                          <button type="button" className={styles.rowAction} disabled={busy !== null} onClick={() => void openPhoto(entry)}>
                            Receipt photo
                          </button>
                        )}
                        <Link href={`/admin/costs?entry=${encodeURIComponent(row.id)}`} prefetch={false} className={styles.payLink}>
                          Costs page
                        </Link>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {[...doneHere.entries()].map(([id, done]) => (
                <tr key={`done:${id}`} className={styles.doneRow}>
                  <td className={styles.payDay}>{dayWords(done.day)}</td>
                  <td>{done.item}</td>
                  <td colSpan={2}>
                    <span className={styles.waitingSaved}>{done.words}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {waitingCleanings.length > 1 && (
            <div className={styles.waitingAll}>
              <button type="button" className={cx(shared.btnPrimary, styles.createBtn)} onClick={() => void saveAll()} disabled={busy !== null || fieldsReady === 0}>
                {busy === "all" ? "Saving…" : `Save all (${fieldsReady})`}
              </button>
              <span className={styles.notCountedNote}>Each amount is saved as typed, one cleaning at a time; a field left empty saves nothing.</span>
            </div>
          )}
        </section>
      )}

      {/* ── The month: switcher, summary (item 4), calendar (item 3), the day picked, the dated list (item 5) ── */}
      <section className={styles.monthSection} aria-labelledby="person-month-title">
        <div className={styles.monthHead}>
          <nav className={styles.monthNav} aria-label="Month">
            <button type="button" className={styles.monthButton} onClick={() => olderMonth && changeMonth(olderMonth)} disabled={!olderMonth} aria-label={olderMonth ? `Older: ${monthLabel(olderMonth)}` : "No older month"}>
              <ChevronLeft size={16} aria-hidden />
            </button>
            <h2 id="person-month-title" className={styles.monthTitle} aria-live="polite">
              {monthLabel(month)}
            </h2>
            <button type="button" className={styles.monthButton} onClick={() => newerMonth && changeMonth(newerMonth)} disabled={!newerMonth} aria-label={newerMonth ? `Newer: ${monthLabel(newerMonth)}` : "No newer month"}>
              <ChevronRight size={16} aria-hidden />
            </button>
          </nav>
          {jobsState.kind === "loading" && <span className={styles.monthNote}>Reading their jobs…</span>}
          {jobsState.kind === "failed" && (
            <span className={cx(styles.monthNote, styles.payWarn)}>
              Their jobs for this month could not be read: the calendar shows cleanings, receipts, work and payments only, and no job counts as Not marked.{" "}
              <button
                type="button"
                className={styles.payLinkButton}
                onClick={() => {
                  setJobsByMonth((was) => ({ ...was, [month]: { kind: "loading" } }));
                  setJobsAttempt((n) => n + 1);
                }}
              >
                Try again
              </button>
            </span>
          )}
        </div>

        <dl className={styles.summary} aria-label={`${monthLabel(month)} summary`}>
          <div className={styles.summaryTile}>
            <dt>Jobs done</dt>
            <dd>{summary.jobsDone}</dd>
            <dd className={styles.summaryDetail}>{jobsWords(summary)}</dd>
          </div>
          <div className={styles.summaryTile}>
            <dt>Notes sent</dt>
            <dd>{summary.notesSent}</dd>
          </div>
          <div className={styles.summaryTile}>
            <dt>Cleanings counted</dt>
            <dd>{formatCents(summary.cleanings.cents)}</dd>
            <dd className={styles.summaryDetail}>
              {summary.cleanings.count === 1 ? "1 cleaning" : `${summary.cleanings.count} cleanings`}
              {summary.cleanings.averageCents !== null && ` · ${formatCents(summary.cleanings.averageCents)} per cleaning`}
            </dd>
          </div>
          <div className={styles.summaryTile}>
            <dt>Receipts approved</dt>
            <dd>{formatCents(summary.receipts.cents)}</dd>
            <dd className={styles.summaryDetail}>
              {summary.receipts.count === 1 ? "1 receipt" : `${summary.receipts.count} receipts`}
              {summary.receipts.cardCents > 0 && ` · ${formatCents(summary.receipts.cardCents)} more on Nubnb's card, not owed`}
            </dd>
          </div>
          <div className={styles.summaryTile}>
            <dt>Work approved</dt>
            <dd>{formatCents(summary.work.cents)}</dd>
            <dd className={styles.summaryDetail}>{summary.work.count === 1 ? "1 entry" : `${summary.work.count} entries`}</dd>
          </div>
          <div className={styles.summaryTile}>
            <dt>Paid in the month</dt>
            <dd>{formatCents(summary.paidCents)}</dd>
          </div>
          <div className={cx(styles.summaryTile, summary.owedAtEndCents < 0 && styles.summaryWarn)}>
            <dt>Owed at month end</dt>
            <dd>{summary.owedAtEndCents < 0 ? `Paid ahead ${formatCents(-summary.owedAtEndCents)}` : summary.owedAtEndCents === 0 ? "Settled" : formatCents(summary.owedAtEndCents)}</dd>
          </div>
        </dl>

        <div className={styles.calendar} role="grid" aria-label={`${monthLabel(month)}: ${name}'s jobs, receipts, work and payments by day`}>
          <div className={styles.calendarHead} role="row">
            {WEEKDAYS.map((w) => (
              <span key={w} role="columnheader" className={styles.calendarWeekday}>
                {w}
              </span>
            ))}
          </div>
          {weeks.map((week, i) => (
            <div key={i} className={styles.calendarWeek} role="row">
              {week.map((d) => {
                const listed = d.items.filter((item) => item.kind !== "payday");
                const shown = listed.slice(0, 4);
                return (
                  <div
                    key={d.day}
                    role="gridcell"
                    className={cx(styles.dayCell, !d.inMonth && styles.dayOut, d.isToday && styles.dayToday, d.payday !== null && styles.dayPayday, picked === d.day && styles.dayPicked)}
                    onClick={() => setPicked(d.day)}
                  >
                    <button type="button" className={styles.dayButton} onClick={() => setPicked(d.day)} aria-label={`${longDay(d.day)}: ${listed.length === 1 ? "1 item" : `${listed.length} items`}${d.payday ? ", payday" : ""}`} aria-pressed={picked === d.day}>
                      <span className={styles.dayNumber}>{Number(d.day.slice(8))}</span>
                      {d.payday && <span className={styles.dayPaydayMark}>Payday · {d.payday.dueCents > 0 ? `${d.payday.past ? "was due" : "due"} ${formatCents(d.payday.dueCents)}` : "Settled"}</span>}
                    </button>
                    <ul className={styles.dayItems}>
                      {shown.map((item) => (
                        <li key={`${item.kind}:${item.id}`} className={cx(styles.dayItem, styles[`tone_${item.tone}`])} title={`${item.words} · ${item.state}`}>
                          <span className={styles.dayItemWords}>{item.words}</span>
                          <span className={styles.dayItemState}>
                            {item.state}
                            {item.amountCents !== null && item.kind !== "payment" && item.kind !== "payday" && ` · ${formatCents(item.amountCents)}`}
                          </span>
                        </li>
                      ))}
                      {listed.length > shown.length && <li className={cx(styles.dayItem, styles.dayMore)}>+{listed.length - shown.length} more</li>}
                    </ul>
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {pickedDay && (
          <section className={styles.dayPanel} aria-labelledby="person-day-title">
            <div className={styles.dayPanelHead}>
              <h3 id="person-day-title" className={styles.dayPanelTitle}>
                {longDay(pickedDay.day)} · {pickedDay.items.filter((item) => item.kind !== "payday").length === 1 ? "1 item" : `${pickedDay.items.filter((item) => item.kind !== "payday").length} items`}
              </h3>
              <button type="button" className={styles.payLinkButton} onClick={() => setPicked(null)}>
                Close
              </button>
            </div>
            {pickedDay.items.length === 0 ? (
              <p className={styles.notCountedNote}>Nothing on this day.</p>
            ) : (
              <ul className={styles.dayPanelList}>
                {pickedDay.items.map((item: DayItem) => (
                  <li key={`${item.kind}:${item.id}`} className={cx(styles.dayPanelItem, styles[`tone_${item.tone}`])}>
                    <span className={styles.dayPanelWords}>{item.words}</span>
                    <span className={styles.dayPanelState}>
                      {item.state}
                      {item.amountCents !== null && item.kind !== "payment" && item.kind !== "payday" && ` · ${formatCents(item.amountCents)}`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {/* ── The dated list: what counts, what was paid, what changed, in the month on screen ── */}
        <div className={styles.listHead}>
          <h3 className={styles.listTitle}>{scope === "month" ? `${monthLabel(month)}: what counts, what was paid, what changed` : "All time: what counts, what was paid, what changed"}</h3>
          <button type="button" className={styles.payLinkButton} onClick={() => setScope(scope === "month" ? "all" : "month")}>
            {scope === "month" ? "Show all time" : `Show ${monthLabel(month)} only`}
          </button>
        </div>
        {listRows.length === 0 ? (
          <p className={styles.payEmpty}>Nothing in {scope === "month" ? monthLabel(month) : "their history"}.</p>
        ) : (
          <div className={cx(shared.tableContainer, styles.tableScroll)}>
            <table className={shared.table}>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Item</th>
                  <th className={styles.payCol}>Earned</th>
                  <th className={styles.payCol}>Paid</th>
                  <th>
                    <span className={shared.srOnly}>What happened</span>
                  </th>
                  <th className={shared.actionsHeader}>
                    <span className={shared.srOnly}>Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {listRows.map((row) => (
                  <tr key={`${row.kind}:${row.id}`}>
                    <td className={styles.payDay}>{row.day ? dayWords(row.day) : <span className={styles.payWarn}>No date</span>}</td>
                    <td className={styles.payItem}>{rowItemWords(row)}</td>
                    <td className={styles.payCol}>{row.kind === "payment" ? null : <Amount row={row} counted={row.earnedCents} />}</td>
                    <td className={styles.payCol}>{row.kind === "payment" ? <Amount row={row} counted={row.paidCents} /> : null}</td>
                    <td className={styles.payWhat}>
                      <RowNotes row={row} />
                    </td>
                    <td className={styles.actionCell}>
                      {row.payment && row.payment.status === "recorded" && (
                        <button type="button" className={cx(styles.rowAction, styles.rowActionDanger)} disabled={busy !== null} onClick={() => row.payment && remove(row.payment)}>
                          {busy === row.id ? "Deleting…" : "Delete…"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

/** What it adds now; the amount struck through when it no longer counts; muted while it waits; a dash with none. */
function Amount({ row, counted }: { row: PayRow; counted: number | null }) {
  if (counted !== null) return <>{formatCents(counted)}</>;
  if (row.amountCents === null) return <span className={styles.muted}>—</span>;
  if (STRUCK.includes(row.state)) return <s className={styles.payStruck}>{formatCents(row.amountCents)}</s>;
  return <span className={styles.muted}>{formatCents(row.amountCents)}</span>;
}

/** Its state now, then what changed it, each change after a payment that may have included it marked in amber. */
function RowNotes({ row }: { row: PayRow }) {
  const last = row.changes[row.changes.length - 1];
  const tells = NOTE_TELLS[row.state];
  const told = tells !== undefined && last !== undefined && last.words.startsWith(tells) ? last : null;
  const others = row.changes.filter((change) => change !== told);
  return (
    <>
      {row.note !== null && (
        <span className={cx(styles.payLine, (row.state === "cannot-add-up" || row.state === "unknown") && styles.payWarn)}>
          {row.note}
          {told && <AfterPayment change={told} />}
        </span>
      )}
      {others.map((change, i) => (
        <span key={i} className={styles.payLine}>
          {changeWords(change)}
          <AfterPayment change={change} />
        </span>
      ))}
    </>
  );
}

function AfterPayment({ change }: { change: PayChange }) {
  if (change.afterPayment === null) return null;
  return <span className={styles.payAmber}> · after the payment of {dayWords(change.afterPayment.day)}</span>;
}
