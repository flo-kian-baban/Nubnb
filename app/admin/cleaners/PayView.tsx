"use client";

/**
 * A team member's pay (Team pay, Kian's rulings of 2026-10-15; TEAM-PAY-PLAN.md §4), opened from their name or
 * "Pay" on the Team page. It lives on the Team page, at /admin/cleaners?pay={id}, and is drawn from what that page
 * already holds — the team, the cost list, every payment and the team's schedule — so opening a person reads nothing
 * more, except what their missing amounts start from (below), read once when they have any.
 *
 * At the top, who they are: role, status, the properties they are the regular cleaner for and their jobs ahead (the
 * Team page, round 1, 2026-10-19), a cleaner's last 90 days of receipts in words, and the account's history in words —
 * never a code: the server blanks a code change's old and new codes before they leave it (Kian's ruling K5). Then their
 * Earned, Paid and Balance over all time (ruling 3: no pay periods; overpaid in amber).
 *
 * ── Not counted yet (the Team page audit's one change, 2026-10-19) ──
 * Their cleanings with no amount, each with an amount field and Save, plus "Save all"; and their receipts and work
 * waiting for review, linked to the Costs page. Each field opens as the Cleanings tab's does (Kian's ruling of
 * 2026-10-19, the second round; prices.ts `missingAmountStart`): the property's preset for the tier when it has one,
 * else "Last typed for <short-term|long-term>: $X", else empty; a share of a job with several cleaners is never
 * prefilled. Nothing is charged until Save or Save all: each save is the Cleanings tab's own route and history rules
 * (PATCH /api/admin/cleanings/[id], one event per cleaning), and the saved cleaning replaces the page's copy, so
 * Earned and Balance follow without a reload.
 *
 * ── Record a payment (ruling 2; Kian's rulings K1 and K2 of 2026-10-19) ──
 * The amount, the day paid, how, and a note, in Nubnb's own controls. Before it is sent, Nubnb asks (pay/checks.ts):
 * while anything of theirs is not counted, naming the counts and that the balance does not include them (K1); and
 * when the payment is larger than the balance, "This pays $X more than <name> is owed. Record it as an advance?" (K2).
 * Both still allowed. After a payment is deleted, the amount field refills with that payment's amount.
 *
 * Then a date filter, with what was earned and paid in it and the balance at its start and end, over every item and
 * payment of theirs by date, newest first: counted or not, with what changed each and when, and a change after a
 * payment that may have included it in amber (§3). A deleted payment stays listed, struck through (ruling 4).
 *
 * The figures and the list come from the one function, app/lib/pay/balance.ts. The cleaner app shows no pay (Kian's
 * ruling of 2026-10-16). Nothing here is optimistic: a payment appears, or is marked deleted, and a cleaning's amount
 * changes, as the server stored it.
 */

import { useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from "react";
import Link from "next/link";
import { ChevronLeft, RefreshCw } from "lucide-react";
import { AdminSelect } from "../components/AdminSelect";
import { DateRangeField, type DatePreset } from "../components/DateRangeField";
import type { Notice } from "../components/Notice";
import type { Question } from "../components/AskDialog";
import { CLEANER_ROLE_LABELS, CLEANER_STATUS_LABELS, accountEventWords, formatCents, isCleanerRole, isCleanerStatus, type CleanerSummary, type CostEntryView } from "@/app/lib/cleaners/model";
import { amountField, readAmountCents, type CleaningView } from "@/app/lib/cleanings/model";
import { missingAmountStart, recommendationWords, waitingHint, type CleaningPrices } from "@/app/lib/cleanings/prices";
import { changeCleaning, fetchAmountStarts } from "@/app/lib/costs-client";
import { inRange, presetRange, shortDay } from "@/app/lib/costs/report";
import { balanceWords, changeWords, dayWords, memberPay, rowItemWords, type PayChange, type PayRow } from "@/app/lib/pay/balance";
import { notCountedWords, recordQuestions } from "@/app/lib/pay/checks";
import { PAYMENT_METHOD_LABELS, PAYMENT_METHODS, earliestPaymentDay, type PaymentMethod, type PaymentView } from "@/app/lib/pay/model";
import { deletePayment, recordPayment } from "@/app/lib/pay-client";
import type { RegularProperty } from "@/app/lib/cleaners-client";
import shared from "../page.module.css";
import styles from "./page.module.css";

interface PayViewProps {
  member: CleanerSummary;
  cleanings: readonly CleaningView[];
  entries: readonly CostEntryView[];
  payments: readonly PaymentView[];
  /** Payments that could not be read, anyone's: the balance is then never shown as whole. */
  unreadablePayments: number;
  /** The properties they are the regular cleaner for and their open jobs from today on; null while that read is out or failed. */
  schedule: { regular: RegularProperty[]; upcoming: number } | null;
  /** A cleaner's last 90 days of receipts in words; null for a handyman or while unread. */
  patternWords: string | null;
  today: string;
  onBack: () => void;
  /** Read the team, the cost list and the payments again: the Team page's Refresh, in this page's head. */
  onRefresh: () => void;
  /** A payment as the server stored it, recorded or deleted. */
  onPayment: (payment: PaymentView) => void;
  /** A cleaning as the server stored it after its amount was typed here. */
  onCleaning: (cleaning: CleaningView) => void;
  show: (notice: Notice) => void;
  clear: () => void;
  ask: (question: Question) => Promise<boolean>;
}

/** Shown struck through: it counted once, or would have, and does not now. */
const STRUCK: readonly PayRow["state"][] = ["removed", "rejected", "nubnb-card", "moved", "deleted"];

/** The change a row's note already tells, by its first words: it is not told twice. */
const NOTE_TELLS: Partial<Record<PayRow["state"], string>> = { removed: "Removed", rejected: "Rejected", "nubnb-card": "Marked paid with Nubnb's card", moved: "Given to " };

/** A balance inside a sentence: "$60.00 owed", "$40.00 overpaid", "settled". */
const balanceInline = (cents: number) => (cents === 0 ? "settled" : balanceWords(cents).words);

/** `day` moved back `days` days. */
const daysBefore = (day: string, days: number) => new Date(Date.parse(`${day}T12:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

/** A plain click, which opens in place; any other (a new tab, a new window) is left to the browser. */
export const plainClick = (event: MouseEvent) => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

/** "300", "$1,240.5", "300.00" → "300.00"; null when it is not dollars and cents. */
function amountText(typed: string): string | null {
  const match = /^\$?(\d{1,6})(?:\.(\d{1,2}))?$/.exec(typed.replace(/[\s,]/g, ""));
  return match ? `${Number(match[1])}.${(match[2] ?? "0").padEnd(2, "0")}` : null;
}

/** What the missing amounts start from: read once for the person's waiting cleanings; "failed" leaves every field empty, and says so. */
type Starts = { kind: "none" } | { kind: "loading" } | { kind: "ready"; prices: Record<string, CleaningPrices>; jobs: Record<string, { nights: number; cleaners: number }> } | { kind: "failed"; title: string };

/** The property's name as the admin shows it. */
const propertyWords = (c: CleaningView) => c.property.internalName ?? c.property.name ?? c.propertyNameAtEntry ?? "Unknown property";

export function PayView({ member, cleanings, entries, payments, unreadablePayments, schedule, patternWords, today, onBack, onRefresh, onPayment, onCleaning, show, clear, ask }: PayViewProps) {
  const name = member.name !== null && member.name.trim() !== "" ? member.name : "this team member";
  const [range, setRange] = useState(() => presetRange("this-month", today));
  const pay = useMemo(() => memberPay(member.id, { cleanings, entries, payments }, range), [member.id, cleanings, entries, payments, range]);
  const [amount, setAmount] = useState(() => (pay.balanceCents > 0 ? (pay.balanceCents / 100).toFixed(2) : ""));
  const [day, setDay] = useState(today);
  const [method, setMethod] = useState<PaymentMethod>("e-transfer");
  const [note, setNote] = useState("");
  /** The one write in flight: recording, deleting the payment with this ID, saving the cleaning with this ID, or "all". */
  const [busy, setBusy] = useState<string | null>(null);

  // ── Not counted yet: their cleanings with no amount, and what each field starts from ──
  const waitingCleanings = useMemo(() => cleanings.filter((c) => c.cleanerId === member.id && c.status === "logged" && c.amountCents === null).sort((a, b) => a.day.localeCompare(b.day) || a.createdAt.localeCompare(b.createdAt)), [cleanings, member.id]);
  const waitingEntries = useMemo(() => pay.rows.filter((row) => row.state === "waiting"), [pay.rows]);
  const [starts, setStarts] = useState<Starts>({ kind: "none" });
  /** The properties and jobs already asked for, so a set that only shrank is not read again. */
  const startsAsked = useRef<Set<string>>(new Set());
  const [typing, setTyping] = useState<Record<string, string>>({});
  /** Typed and saved here: kept in the list, with what was saved, until the page is refreshed. */
  const [savedHere, setSavedHere] = useState<Map<string, { cents: number; statementMonth: string }>>(new Map());
  /** The waiting rows shown: the cleanings still with no amount, and those saved here (their amount now on them), by day. */
  const waitingRows = useMemo(() => {
    const ids = new Set(waitingCleanings.map((c) => c.id));
    return [...waitingCleanings, ...cleanings.filter((c) => c.cleanerId === member.id && savedHere.has(c.id) && !ids.has(c.id))].sort((a, b) => a.day.localeCompare(b.day) || a.createdAt.localeCompare(b.createdAt));
  }, [waitingCleanings, cleanings, savedHere, member.id]);
  // The properties of the waiting cleanings, and the jobs of those and of the typed job cleanings there: the rule needs
  // a job's stay and cleaner count to pick the tier and to count only one-cleaner jobs (never a share).
  const wanted = useMemo(() => {
    const properties = [...new Set(waitingCleanings.map((c) => c.propertyId))];
    const jobs = [...new Set(cleanings.filter((c) => properties.includes(c.propertyId) && c.status === "logged" && c.jobId !== null && (c.amountCents === null || c.amountFrom === "typed")).map((c) => c.jobId as string))];
    return { properties, jobs };
  }, [waitingCleanings, cleanings]);
  const wantedKey = `${wanted.properties.join(",")}|${wanted.jobs.join(",")}`;
  useEffect(() => {
    if (wanted.properties.length === 0) {
      // Nothing waits now; what was read stays, for the rows saved here.
      setStarts((prev) => (prev.kind === "ready" ? prev : { kind: "none" }));
      return;
    }
    // Read once per set of properties and jobs; a set that only shrank (a row saved) is already covered.
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
  const startOf = (c: CleaningView) => {
    if (starts.kind !== "ready") return null;
    return missingAmountStart(starts.prices[c.propertyId] ?? null, cleanings, starts.jobs, c);
  };
  /** What a field holds: what was typed, else what it opened with — the preset, or the recommendation (Kian's ruling: confirmed by Enter, Save or Save all). */
  const fieldOf = (c: CleaningView) => {
    if (typing[c.id] !== undefined) return typing[c.id];
    const start = startOf(c);
    return start && (start.kind === "preset" || start.kind === "recommendation") ? amountField(start.cents) : "";
  };
  const fieldWords = (c: CleaningView): string => {
    if (starts.kind === "loading") return "Reading what it starts from…";
    if (starts.kind === "failed") return "Could not read what it starts from: type the amount.";
    const start = startOf(c);
    if (!start) return "";
    const job = c.jobId !== null ? (starts.kind === "ready" ? starts.jobs[c.jobId] ?? null : null) : null;
    if (start.kind === "preset") return `${start.tier === "long" ? "Long-term" : "Short-term"} preset: ${formatCents(start.cents)}`;
    if (start.kind === "recommendation") return recommendationWords(start.tier, start.cents);
    if (start.kind === "split") return waitingHint(starts.kind === "ready" ? starts.prices[c.propertyId] ?? null : null, job);
    return "No preset and nothing typed for this property yet: type the amount.";
  };

  const failed = (result: { title: string; detail?: string; unknown: boolean }, what: string) =>
    show(result.unknown ? { tone: "warning", title: `The cleaning may or may not have been ${what}. Refresh to see what is on record.`, detail: result.title } : { tone: "error", title: result.title, detail: result.detail });

  /** One cleaning's amount saved through the Cleanings tab's route: the server's copy replaces the page's. */
  const saveOne = async (c: CleaningView): Promise<boolean> => {
    const cents = readAmountCents(fieldOf(c));
    if (cents === null) {
      show({ tone: "error", title: `Type the amount for ${propertyWords(c)}, ${shortDay(c.day)}: dollars and cents above $0.00, like 60.00.` });
      return false;
    }
    const result = await changeCleaning(c.id, { seen: c.history.length, amount: amountField(cents), reason: null });
    if (!result.ok) {
      failed(result, "saved");
      return false;
    }
    onCleaning({ ...result.data.cleaning, cleaner: c.cleaner, property: c.property });
    setSavedHere((was) => new Map(was).set(c.id, { cents, statementMonth: result.data.statementMonth }));
    return true;
  };
  const saveAmount = async (c: CleaningView) => {
    if (busy !== null) return;
    clear();
    setBusy(c.id);
    const ok = await saveOne(c);
    setBusy(null);
    if (ok) show({ tone: "success", title: `Saved ${formatCents(readAmountCents(fieldOf(c)) ?? 0)} for the cleaning at ${propertyWords(c)} on ${dayWords(c.day)}.`, detail: "Earned and Balance follow it." });
  };
  /** Every waiting cleaning with an amount in its field, saved one after another, each its own request and history event; a failure stops there. */
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
    if (saved === ready.length) show({ tone: "success", title: `Saved ${saved === 1 ? "1 amount" : `${saved} amounts`}.`, detail: "Earned and Balance follow them." });
    else if (saved > 0) show({ tone: "warning", title: `Saved ${saved} of ${ready.length} amounts; the rest were not sent.`, detail: "Fix the one that failed and press Save all again." });
  };

  const presets: DatePreset[] = [
    { key: "this-month", label: "This month", ...presetRange("this-month", today) },
    { key: "last-month", label: "Last month", ...presetRange("last-month", today) },
    { key: "last-90", label: "Last 90 days", from: daysBefore(today, 89), to: today },
    { key: "all-time", label: "All time", from: "", to: "" },
  ];

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
    // Kian's rulings K1 and K2 of 2026-10-19: ask first while anything is not counted, and before paying more than is owed.
    for (const question of recordQuestions(pay, Math.round(Number(text) * 100), name)) {
      if (!(await ask(question))) return;
    }
    clear();
    setBusy("record");
    const result = await recordPayment({ memberId: member.id, amount: text, day, method, note: note.trim() === "" ? null : note });
    setBusy(null);
    if (!result.ok) {
      show(
        result.unknown
          ? { tone: "warning", title: "The payment may or may not have been recorded. Refresh to see before recording it again.", detail: result.title }
          : { tone: "error", title: result.title, detail: result.detail ?? "Nothing was recorded." },
      );
      return;
    }
    const stored = result.data.payment;
    onPayment(stored);
    setAmount("");
    setNote("");
    show({
      tone: "success",
      title: `Recorded ${formatCents(stored.amountCents)} paid to ${name} on ${dayWords(stored.day)}.`,
      detail: inRange(stored.day, range.from, range.to) ? undefined : "It is outside the dates shown below.",
    });
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
      show(
        result.unknown
          ? { tone: "warning", title: "The payment may or may not have been deleted. Refresh to see.", detail: result.title }
          : { tone: "error", title: result.title, detail: result.detail ?? "Nothing was deleted." },
      );
      return;
    }
    onPayment(result.data.payment);
    // The amount field refills with that payment's amount (the Team page, round 1), so a correction is not retyped.
    setAmount(amountField(payment.amountCents));
    show({ tone: "success", title: `Deleted the payment of ${formatCents(payment.amountCents)} on ${dayWords(payment.day)}.`, detail: `It stays in ${name}'s history, struck through, and no longer counts as paid. The amount field holds ${formatCents(payment.amountCents)} again.` });
  };

  const balance = balanceWords(pay.balanceCents);
  const role = isCleanerRole(member.role) ? CLEANER_ROLE_LABELS[member.role] : (member.role ?? "No role");
  const status = isCleanerStatus(member.status) ? CLEANER_STATUS_LABELS[member.status] : (member.status ?? "No status");
  const parts = [
    pay.parts.cleaningsCents !== 0 ? `cleanings ${formatCents(pay.parts.cleaningsCents)}` : null,
    pay.parts.receiptsCents !== 0 ? `receipts ${formatCents(pay.parts.receiptsCents)}` : null,
    pay.parts.workCents !== 0 ? `work ${formatCents(pay.parts.workCents)}` : null,
  ].filter((part): part is string => part !== null);
  const rows = pay.rows.filter((row) => inRange(row.day, range.from, range.to));
  const inDates = pay.range;
  const notCounted = notCountedWords(pay);
  const fieldsReady = waitingCleanings.filter((c) => fieldOf(c).trim() !== "").length;
  const history = member.history ?? [];

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
            {role} · {status} · <span className={styles.mono}>ID {member.id}</span>
          </p>
          {/* The schedule (the Team page, round 1): the properties they are the regular cleaner for, and their jobs ahead. */}
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
          {patternWords !== null && <p className={styles.payMeta}>Last 90 days: {patternWords}</p>}
          {history.length > 0 && (
            <details className={styles.payHistory}>
              <summary>Account history · {history.length}</summary>
              <ul>
                {history.map((event, i) => (
                  <li key={i}>{accountEventWords(event)}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
        <button type="button" className={shared.btnGhost} onClick={onRefresh} disabled={busy !== null}>
          <RefreshCw size={15} aria-hidden />
          <span>Refresh</span>
        </button>
      </div>

      {/* ── Earned, Paid, Balance: all time ── */}
      <div className={styles.payFigures}>
        <div className={styles.payFigure}>
          <span className={styles.payFigureLabel}>Earned</span>
          <span className={styles.payFigureValue}>{formatCents(pay.earnedCents)}</span>
          {parts.length > 0 && <span className={styles.payFigureDetail}>{parts.join(" · ")}</span>}
        </div>
        <div className={styles.payFigure}>
          <span className={styles.payFigureLabel}>Paid</span>
          <span className={styles.payFigureValue}>{formatCents(pay.paidCents)}</span>
        </div>
        <div className={`${styles.payFigure} ${balance.tone === "overpaid" ? styles.payFigureWarn : ""}`}>
          <span className={styles.payFigureLabel}>Balance</span>
          <span className={styles.payFigureValue}>
            {balance.tone === "owed" ? `${formatCents(pay.balanceCents)} owed to ${name}` : balance.tone === "overpaid" ? `Overpaid ${formatCents(-pay.balanceCents)}` : "Settled"}
          </span>
          {notCounted.length > 0 && <span className={`${styles.payFigureDetail} ${styles.payWarn}`}>not counting what waits below</span>}
        </div>
      </div>
      {(pay.cannotAddUp > 0 || unreadablePayments > 0) && (
        <ul className={styles.payNotes}>
          {pay.cannotAddUp > 0 && <li className={styles.payWarn}>{pay.cannotAddUp === 1 ? "1 entry cannot" : `${pay.cannotAddUp} entries cannot`} add up and {pay.cannotAddUp === 1 ? "is" : "are"} left out: the balance is not whole.</li>}
          {unreadablePayments > 0 && <li className={styles.payWarn}>{unreadablePayments === 1 ? "1 payment" : `${unreadablePayments} payments`} could not be read and {unreadablePayments === 1 ? "is" : "are"} left out: the balance is not whole.</li>}
        </ul>
      )}

      {/* ── Not counted yet (the audit's one change): amounts typed here, reviews linked ── */}
      {(waitingRows.length > 0 || waitingEntries.length > 0) && (
        <section className={styles.notCounted} aria-labelledby="pay-not-counted-title">
          <h2 id="pay-not-counted-title" className={styles.codeEditorTitle}>
            Not counted yet · {waitingCleanings.length + waitingEntries.length}
          </h2>
          <p className={styles.notCountedNote}>{notCounted.length > 0 ? `${notCounted.map((part, i) => (i === 0 ? part[0].toUpperCase() + part.slice(1) : part)).join(", and ")}. The balance above does not include them.` : "Everything is counted now: the amounts saved here are in Earned and Balance."}</p>
          {waitingRows.length > 0 && (
            <>
              <table className={styles.waitingTable} aria-label="Cleanings with no amount">
                <thead>
                  <tr>
                    <th>Day</th>
                    <th>Property</th>
                    <th className={styles.payCol}>Amount ($)</th>
                  </tr>
                </thead>
                <tbody>
                  {waitingRows.map((c) => {
                    const start = startOf(c);
                    const saved = savedHere.get(c.id);
                    return (
                      <tr key={c.id}>
                        <td className={styles.payDay}>{dayWords(c.day)}</td>
                        <td>{propertyWords(c)}</td>
                        <td className={styles.payCol}>
                          {saved ? (
                            <span className={styles.waitingSaved}>Saved {formatCents(saved.cents)} · counted</span>
                          ) : (
                            <form
                              className={styles.waitingForm}
                              onSubmit={(event) => {
                                event.preventDefault();
                                void saveAmount(c);
                              }}
                            >
                              <span className={styles.waitingField}>
                                <input
                                  className={`${styles.payInput} ${styles.waitingInput}`}
                                  inputMode="decimal"
                                  autoComplete="off"
                                  aria-label={`Amount for ${propertyWords(c)}, ${shortDay(c.day)}, ${name}`}
                                  placeholder="60.00"
                                  title={fieldWords(c)}
                                  value={fieldOf(c)}
                                  onChange={(e) => setTyping((was) => ({ ...was, [c.id]: e.target.value }))}
                                  disabled={busy !== null}
                                />
                                <span className={styles.waitingWords} data-start={start?.kind ?? starts.kind}>
                                  {fieldWords(c)}
                                </span>
                              </span>
                              <button type="submit" className={`${styles.rowAction} ${styles.waitingSave}`} disabled={busy !== null || fieldOf(c).trim() === ""}>
                                {busy === c.id ? "Saving…" : "Save"}
                              </button>
                            </form>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {waitingCleanings.filter((c) => !savedHere.has(c.id)).length > 1 && (
                <div className={styles.waitingAll}>
                  <button type="button" className={`${shared.btnPrimary} ${styles.createBtn}`} onClick={() => void saveAll()} disabled={busy !== null || fieldsReady === 0}>
                    {busy === "all" ? "Saving…" : `Save all (${fieldsReady})`}
                  </button>
                  <span className={styles.notCountedNote}>Each amount is saved as typed, one cleaning at a time; a field left empty is skipped.</span>
                </div>
              )}
            </>
          )}
          {waitingEntries.length > 0 && (
            <ul className={styles.waitingEntries} aria-label="Receipts and work waiting for review">
              {waitingEntries.map((row) => (
                <li key={row.id}>
                  {rowItemWords(row)}
                  {row.amountCents !== null && ` · ${formatCents(row.amountCents)}`}
                  {row.day && ` · sent ${dayWords(row.day)}`} ·{" "}
                  <Link href={`/admin/costs?entry=${encodeURIComponent(row.id)}`} prefetch={false} className={styles.payLink}>
                    Review on the Costs page
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* ── Record a payment (ruling 2) ── */}
      <form className={styles.codeEditor} onSubmit={record} noValidate aria-labelledby="pay-record-title">
        <h2 id="pay-record-title" className={styles.codeEditorTitle}>
          Record a payment
        </h2>
        <div className={styles.payForm}>
          <label className={styles.payField}>
            <span className={styles.createLabel}>Amount ($)</span>
            <input type="text" inputMode="decimal" autoComplete="off" placeholder="0.00" className={styles.payInput} value={amount} onChange={(event) => setAmount(event.target.value)} disabled={busy !== null} />
          </label>
          <div className={styles.payField}>
            <span className={styles.createLabel}>Date paid</span>
            <DateRangeField label="Date paid" single from={day} to={day} max={today} min={earliestPaymentDay(today)} onChange={(picked) => setDay(picked.from)} />
          </div>
          <div className={styles.payField}>
            <span className={styles.createLabel}>Method</span>
            <AdminSelect label="Method" value={method} onChange={(value) => setMethod(value as PaymentMethod)} groups={[{ options: PAYMENT_METHODS.map((value) => ({ value, label: PAYMENT_METHOD_LABELS[value] })) }]} disabled={busy !== null} />
          </div>
          <label className={`${styles.payField} ${styles.payNoteField}`}>
            <span className={styles.createLabel}>Note</span>
            <input type="text" autoComplete="off" placeholder="Optional" maxLength={500} className={styles.payInput} value={note} onChange={(event) => setNote(event.target.value)} disabled={busy !== null} />
          </label>
          <button type="submit" className={`${shared.btnPrimary} ${styles.createBtn}`} disabled={busy !== null}>
            {busy === "record" ? "Recording…" : "Record"}
          </button>
        </div>
      </form>

      {/* ── The dates, and what fell in them ── */}
      <div className={styles.payFilter}>
        <DateRangeField label="Dates" from={range.from} to={range.to} max={today} presets={presets} onChange={setRange} note="Cleanings by the day cleaned, receipts and work by the day sent, payments by the day paid." />
        {inDates && (
          <p className={styles.payRange}>
            In these dates: earned {formatCents(inDates.earnedCents)} · paid {formatCents(inDates.paidCents)}
            {inDates.from !== "" && ` · balance ${balanceInline(inDates.balanceBeforeCents)} at the start`}
            {inDates.to !== "" && `${inDates.from !== "" ? "," : " · balance"} ${balanceInline(inDates.balanceAtEndCents)} at the end`}
          </p>
        )}
      </div>

      {/* ── Every item and payment, newest first ── */}
      {rows.length === 0 ? (
        <p className={styles.payEmpty}>Nothing in these dates.</p>
      ) : (
        <div className={`${shared.tableContainer} ${styles.tableScroll}`}>
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
              {rows.map((row) => (
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
                      <button type="button" className={`${styles.rowAction} ${styles.rowActionDanger}`} disabled={busy !== null} onClick={() => row.payment && remove(row.payment)}>
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
        <span className={`${styles.payLine} ${row.state === "cannot-add-up" || row.state === "unknown" ? styles.payWarn : ""}`}>
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
