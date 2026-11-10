"use client";

/**
 * Schedule (the cleaning schedule, phase 1, Kian's rulings of 2026-10-14): each property's turnover, made two days
 * before an Airbnb reservation's checkout from the calendar copy, who is on it, and whether it is done.
 *
 * One block per checkout day, a row per job: the property, its checkout time and whether the next guest arrives the
 * same day, the cleaners on it (a tick once each has marked it cleaned), and its state in one badge — Needs a
 * cleaner, Assigned, Not marked, 1 of 2 done, Done, Removed by the office, or Booking changed. Assign opens Nubnb's
 * own picker: only active cleaners, never handymen (ruling 2); a cleaner who marked the job stays on it. A job whose
 * booking moved offers its cleaners to the job at the new checkout in one click, when that job is on the page; nothing
 * is carried over by itself.
 *
 * Round 1 (the Schedule audit of 2026-10-18; Kian's rulings R1, R2, R3 and R5 of 2026-10-19):
 *   - It opens on today: today and the days ahead first, the days before folded under "Earlier", one line that counts
 *     what needs something there; a filter, or a link to a past day, opens it.
 *   - A job with nobody on it is red on its checkout day and after, amber before, by the rule the home's Cleaning
 *     cell uses too (needsCleanerNow). A job whose checkout passed with someone on it who has not marked it cleaned
 *     (and whose mark the office did not remove) reads "Not marked", red.
 *   - A booking-changed job's cleaners can be taken off it ("Take off": the server already accepted it); nobody is
 *     added to it (R2). Save with nobody unticked says "Nobody was taken off" and sends nothing (Kian's instruction of
 *     2026-11-01; it used to close without a word). Such a job's turnover column never says "Same day" (isSameDay).
 *   - The picker says who the property's regular cleaner is, and offers "Make Ana the regular cleaner for this
 *     property" (R5): the job sync puts them on its next jobs. Jobs already made are not changed. It asks first, in
 *     Nubnb's own dialog and the edit page's words (regularCleanerQuestion), then saves.
 *   - When the page opens on a copy more than three hours old, its read starts the calendars' refresh (R1); the page
 *     watches the run and reads its days again when it ends, with no reload. The same happens when the day's first
 *     visit, or any run another trigger started, ends while the page is open.
 *
 * A mark whose cleaning the office deleted or removed stays, "removed by the office", and that cleaner cannot mark the
 * job again; Reopen, beside their name, lets them, after Nubnb's own question (Kian's ruling of 2026-10-14, night).
 *
 * Refresh calendars is the tag in the navigation (Kian's rulings of 2026-10-17), one run at a time. The line under the
 * toolbar says when the calendars were last read, in amber past 24 hours, and names any calendar the last run could
 * not read. Every control is Nubnb's own (Kian's ruling of 2026-10-10).
 *
 * The cleaning flow (Kian's rulings of 2026-11-01):
 *   - "Add a job" (C): any property, with or without a calendar, any date, any active cleaner or nobody yet, a tier
 *     (short by default), a label (Build 2) and the job's own amount when typed (B). The calendar never touches it.
 *   - "Change cleaner" (D): one swap, logged; the old cleaner's app drops the job and the new one's shows it.
 *   - "Record as cleaned" (E): on a job whose day has come, for its cleaner, not yet marked: the same cleaning,
 *     amount, statement line and pay as their own mark; the history names the admin.
 *   - "Amount…" (B), in the row's menu: the job's own amount, which beats the cleaning price; locked once a mark's
 *     cleaning counts its money.
 *   - A mark with a note (F) reads "Cleaned · needs a decision" in amber; the note stands under the cleaner's chip
 *     with Approve at cleaning price, Amount… and Decline; the cleaner's app is never told the outcome.
 *
 * Build 2 (Kian's rulings of 2026-11-02 and 2026-11-03):
 *   - A job has one cleaner: Assign is a single choice (one cleaner, or nobody); Change cleaner swaps the one.
 *   - Any number of jobs can be added on one property and day, each with its label, cleaner and amount.
 *   - "Delete…", in the row's menu: one question ("Delete this job? It can't be undone."); the job and its cleaning
 *     go, unless the cleaning is counted in a payment or printed on a statement (refused, the reason in one sentence).
 *   - One word per state: "needs an amount", "needs a decision", "cleaning price".
 */

import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import Link from "next/link";
import { AlertTriangle, Check, ChevronDown, ChevronRight, ClipboardCheck, Plus, RefreshCw, Repeat, RotateCcw, Search, UserMinus, UserPlus, Users } from "lucide-react";
import { refreshCalendarsNow, useCalendarRunWatched, useCalendarsRead, useCalendarsRefreshed, useCalendarsRefreshing, watchCalendarRun } from "@/app/lib/calendar-refresh-client";
import { AdminHeader } from "../components/AdminHeader";
import { PageHead } from "../components/PageHead";
import { AdminSelect } from "../components/AdminSelect";
import { useAsk } from "../components/AskDialog";
import { DateRangeField, type DatePreset } from "../components/DateRangeField";
import { PinGate } from "../components/PinGate";
import { NoticeBanner, useNotice } from "../components/Notice";
import { RowMenu } from "../components/RowMenu";
import { Dialog, Tick } from "../property/editor/controls";
import ed from "../property/editor/editor.module.css";
import shared from "../page.module.css";
import styles from "./page.module.css";
import { addJobByHand, decideJobExtra, deleteJob, fetchAmountStart, fetchRegularCleaner, fetchSchedule, mergeJob, recordJobCleaned, reopenJobFor, setJobAmountOf, setJobCleaners, setRegularCleanerOf, swapJobCleaner, withCleaning, type PriceOutcome, type PriceSent, type RecordedOnAdd, type RegularCleanerAnswer, type ScheduleAnswer } from "@/app/lib/schedule-client";
import { fetchAvailabilityProperties } from "@/app/lib/availability-client";
import { addDays, dayText, isDay, minutesBetween, nightsBetween } from "@/app/lib/availability/days";
import { CREATE_DAYS_AHEAD, DEFAULT_JOB_LABEL, JOB_LABEL_MAX, NOBODY_TAKEN_OFF, changeWords, isSameDay, jobLabel, jobState, takenOff, type AssigneeView, type JobView, type StoredJob, type TeamMember } from "@/app/lib/schedule/model";
import { ADDED_JOB_FROM_DAY, FLOOR_WORDS, JOB_LABEL_CHOICES, NOTHING_TYPED, OTHER_LABEL, RECENT_UNITS, addedJobDayProblem, addedJobLastDay, amountStart, amountWords, canRecordOnAdd, chosenLabel, recentUnitIds, unitOrder, type LastTyped, type UnitChoice } from "@/app/lib/schedule/add-job";
import { PriceField } from "./PriceField";
import { JobPriceBlock, useJobPrice } from "./JobPrice";
import { jobPriceTag, jobPriceTagText } from "@/app/lib/schedule/job-price";
import { regularCleanerQuestion } from "@/app/lib/schedule/regular";
import { ADD_JOB_NOT_TRACKED, NOT_TRACKED } from "@/app/lib/schedule/tracking";
import { AMOUNT_SOURCE_WORDS, TIER_NIGHTS, TIER_WORDS, jobNights, jobTier, type CleaningPrices, type PresetKind } from "@/app/lib/cleanings/prices";
import { amountField, countsWords, readAmountCents } from "@/app/lib/cleanings/model";
import { formatCents } from "@/app/lib/cleaners/model";

type Loaded = { kind: "loading" } | { kind: "ready"; answer: ScheduleAnswer } | { kind: "error"; title: string; detail?: string; status: number };

export default function SchedulePage() {
  return (
    <PinGate>
      <Schedule />
    </PinGate>
  );
}

/** "Wed, Oct 14". */
const dayHeading = (day: string) => new Intl.DateTimeFormat("en-CA", { weekday: "short", month: "short", day: "numeric" }).format(new Date(`${day}T12:00:00`));
const clock = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A mark whose cleaning the office deleted or removed: it stays, and that cleaner cannot mark the job again until it is reopened. */
const isRemoved = (a: AssigneeView) => a.removedAt !== null;
/** Who a removed mark can be reopened for: an active cleaner, on a job whose booking is unchanged. */
const canReopen = (job: JobView, a: AssigneeView) => job.status === "open" && isRemoved(a) && a.state === "found" && a.status === "active";
/** Someone on the job who has not marked it cleaned (a mark the office removed is a mark). */
const unmarked = (job: JobView) => job.assignees.filter((a) => a.cleaningId === null);

/**
 * What a link asks for (the property list's Cleaning cell and Next step, Kian's rulings of 2026-10-15 and R3): `?property=`
 * picks the property, `?cleaner=` picks the cleaner (the Team page's jobs count, 2026-10-19), and `?from=`, a day, reads
 * from it to the furthest job instead of from a week back.
 */
function linkFromUrl(): { property: string; cleaner: string; from: string | undefined } {
  const params = typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search);
  const from = params.get("from");
  const id = (value: string | null) => (value !== null && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : "");
  return { property: id(params.get("property")), cleaner: id(params.get("cleaner")), from: isDay(from) ? from : undefined };
}

type Picking = { job: JobView; picked: string[]; mode: "assign" | "take-off" };

function Schedule() {
  const [link] = useState(linkFromUrl);
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [propertyId, setPropertyId] = useState(link.property);
  const [cleanerId, setCleanerId] = useState(link.cleaner);
  const [needsOnly, setNeedsOnly] = useState(false);
  /** "Earlier" opened or closed by the admin; null until they do, when filters and the link decide. */
  const [earlierChosen, setEarlierChosen] = useState<boolean | null>(null);
  const refreshing = useCalendarsRefreshing();
  const watched = useCalendarRunWatched();
  const [assigning, setAssigning] = useState<Picking | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  /** The cleaning flow's dialogs (2026-11-01): one open at a time. */
  const [adding, setAdding] = useState(false);
  const [swapping, setSwapping] = useState<JobView | null>(null);
  const [recording, setRecording] = useState<JobView | null>(null);
  const [pricing, setPricing] = useState<JobView | null>(null);
  const [extraAt, setExtraAt] = useState<{ job: JobView; a: AssigneeView } | null>(null);
  /** Every unit for Add a job's search: read when the form first opens, kept for the next opens (one read per property). */
  const [units, setUnits] = useState<UnitsState>({ kind: "loading" });
  const unitsAsked = useRef(false);
  /** The job just added: its row is marked and brought into view once the days it is in are read (2026-11-06). */
  const [fresh, setFresh] = useState<string | null>(null);
  const shownFresh = useRef<string | null>(null);
  const { notice, show, clear } = useNotice();
  const { ask, dialog } = useAsk();

  /** What a read answered: the page's jobs, or why there are none to show. A run the read started is watched to its end. */
  const take = useCallback((result: Awaited<ReturnType<typeof fetchSchedule>>) => {
    if (!result.ok) {
      setLoaded({ kind: "error", title: result.title, detail: result.detail, status: result.status });
      return;
    }
    setLoaded({ kind: "ready", answer: result.data });
    setRange({ from: result.data.from, to: result.data.to });
    if (result.data.refresh) void watchCalendarRun(result.data.calendar.refreshedAt);
  }, []);

  const load = useCallback(async (from?: string, to?: string) => take(await fetchSchedule(from, to)), [take]);

  // The first read: the server's default days, from a week back to the furthest job, or from the day a link asks for.
  useEffect(() => {
    let cancelled = false;
    fetchSchedule(link.from).then((result) => {
      if (!cancelled) take(result);
    });
    return () => {
      cancelled = true;
    };
  }, [take, link.from]);

  const answer = loaded.kind === "ready" ? loaded.answer : null;
  const today = answer?.today ?? null;

  const presets: DatePreset[] = useMemo(() => {
    if (!today) return [];
    return [
      { key: "around", label: "Past week and next 2 days", from: addDays(today, -7), to: addDays(today, 2) },
      { key: "ahead", label: "Today and next 2 days", from: today, to: addDays(today, 2) },
      { key: "month", label: "Past 30 days", from: addDays(today, -30), to: today },
    ];
  }, [today]);

  const shown = useMemo(() => {
    if (!answer) return [];
    return answer.jobs.filter(
      (job) =>
        (propertyId === "" || job.propertyId === propertyId) &&
        (cleanerId === "" || job.cleanerIds.includes(cleanerId)) &&
        (!needsOnly || (job.status === "open" && job.cleanerIds.length === 0)),
    );
  }, [answer, propertyId, cleanerId, needsOnly]);

  const byDay = useMemo(() => {
    const days = new Map<string, JobView[]>();
    for (const job of shown) days.set(job.checkout, [...(days.get(job.checkout) ?? []), job]);
    return [...days.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [shown]);
  const earlierDays = useMemo(() => (today ? byDay.filter(([day]) => day < today) : []), [byDay, today]);
  const aheadDays = useMemo(() => (today ? byDay.filter(([day]) => day >= today) : byDay), [byDay, today]);
  /** What needs something among the earlier days, counted on the folded line. */
  const earlierCounts = useMemo(() => {
    const jobs = earlierDays.flatMap(([, list]) => list);
    const states = today ? jobs.map((job) => jobState(job, today).tone) : [];
    return { jobs: jobs.length, notMarked: states.filter((t) => t === "notMarked").length, nobody: states.filter((t) => t === "needsNow").length, removed: states.filter((t) => t === "removed").length };
  }, [earlierDays, today]);
  const filtering = propertyId !== "" || cleanerId !== "" || needsOnly;
  const earlierOpen = earlierChosen ?? (filtering || (link.from !== undefined && today !== null && link.from < today));

  const needsCount = useMemo(() => (answer ? answer.jobs.filter((job) => job.status === "open" && job.cleanerIds.length === 0).length : 0), [answer]);

  // Refresh is the tag's in the navigation (Kian's rulings of 2026-10-17: on every admin page), one at a time; this
  // page says what each refresh did, from whichever control pressed it, and reads its jobs again.
  const refresh = () => {
    clear();
    void refreshCalendarsNow();
  };
  useCalendarsRefreshed(async (result) => {
    if (!result.ok) {
      if (result.code === "REFRESH_RUNNING") show({ tone: "info", title: result.title, detail: result.detail });
      else show(result.unknown ? { tone: "warning", title: "The refresh may or may not have run. Reload to see.", detail: result.title } : { tone: "error", title: result.title, detail: result.detail });
      return;
    }
    const { jobs } = result.data;
    show(
      jobs.failed
        ? { tone: "warning", title: "The calendars were read, but the jobs could not all be made.", detail: `The sync stopped (code ${jobs.failed}). Refresh again.` }
        : { tone: "success", title: jobs.created + jobs.changed === 0 ? "Calendars read. No job changed." : `Calendars read. ${plural(jobs.created, "job", "jobs")} made, ${jobs.changed} changed.` },
    );
    await load(range?.from, range?.to);
  });
  // A run this page did not press ended (the read on open, R1; the day's first visit; another admin's press): the
  // days again, with no reload.
  useCalendarsRead(async (status) => {
    if (!answer || status.refreshedAt === answer.calendar.refreshedAt) return;
    await load(range?.from, range?.to);
    show({ tone: "success", title: `Calendars read ${status.refreshedAt ? clock(status.refreshedAt) : ""}. The schedule shows them.` });
  });

  const team = useMemo(() => answer?.team ?? [], [answer]);
  const active = useMemo(() => team.filter((member) => member.role === "cleaner" && member.status === "active"), [team]);

  /** What a price saved with the cleaner did, in one sentence for the notice (2026-11-06); '' when it changed nothing. */
  const priceWords = (job: JobView, outcome: PriceOutcome | null | undefined): string => {
    if (!outcome) return "";
    if (outcome.cleaningPriceSaved) return ` ${formatCents(outcome.cleaningPriceSaved.cents)} is now this unit’s ${TIER_WORDS[outcome.cleaningPriceSaved.tier]} cleaning price.`;
    if (!outcome.amountChanged) return "";
    return outcome.amountCents === null ? ` Its price: the ${TIER_WORDS[jobTier(job)]} cleaning price.` : ` Its price: ${formatCents(outcome.amountCents)}, set on the job.`;
  };

  /** Assign saved: who is on the job and, when it was changed, its price, in one request (2026-11-06). */
  const saveAssign = async (price?: PriceSent) => {
    if (!assigning || saving) return;
    const { job, picked } = assigning;
    setSaving(job.id);
    const result = await setJobCleaners(job.id, picked, job.history.length, price);
    setSaving(null);
    if (!result.ok) {
      show(result.unknown ? { tone: "warning", title: price ? "Who is on the job and its price may or may not have been saved. Reload to see." : "Who is on the job may or may not have been saved. Reload to see.", detail: result.title } : { tone: "error", title: result.title, detail: result.detail });
      return;
    }
    setAssigning(null);
    // A unit cleaning price saved, or a waiting cleaning that followed the price: the page reads its days again.
    if (result.data.price?.cleaningPriceSaved || (result.data.price?.cleaningsChanged ?? 0) > 0) await load(range?.from, range?.to);
    else replaceJob(mergeJob(job, result.data.job, team));
    if (result.data.changed) show({ tone: "success", title: `Saved who is on ${job.property.name ?? "the job"} · ${dayText(job.checkout)}.${priceWords(job, result.data.price)}` });
  };

  /** A moved booking's cleaner, put on the job at its new checkout while it has nobody: one click, the admin's (ruling 2). */
  const sameCleanersTo = async (from: JobView, target: JobView) => {
    if (saving) return;
    const wanted = target.cleanerIds.length > 0 ? target.cleanerIds : from.cleanerIds.filter((cid) => active.some((member) => member.id === cid)).slice(0, 1);
    if (wanted.length === 0) return;
    setSaving(target.id);
    const result = await setJobCleaners(target.id, wanted, target.history.length);
    setSaving(null);
    if (!result.ok) {
      show(result.unknown ? { tone: "warning", title: "Who is on the job may or may not have been saved. Reload to see.", detail: result.title } : { tone: "error", title: result.title, detail: result.detail });
      return;
    }
    replaceJob(mergeJob(target, result.data.job, team));
    show({ tone: "success", title: `Put them on ${target.property.name ?? "the job"} · ${dayText(target.checkout)}.` });
  };

  /** A mark removed by the office, reopened for its cleaner: they can mark the job cleaned again (Kian's ruling of 2026-10-14, night). */
  const reopen = async (job: JobView, a: AssigneeView) => {
    if (saving) return;
    const who = a.name ?? "this cleaner";
    const where = `${job.property.name ?? job.propertyNameAtCreation ?? "the property"} · ${dayText(job.checkout)}`;
    const yes = await ask({
      title: `Reopen ${where} for ${who}?`,
      lines: [`${who} can mark it cleaned again. Their mark logs a new cleaning at once.`],
      confirm: "Reopen",
    });
    if (!yes) return;
    setSaving(job.id);
    const result = await reopenJobFor(job.id, a.cleanerId, job.history.length);
    setSaving(null);
    if (!result.ok) {
      show(result.unknown ? { tone: "warning", title: "The job may or may not have been reopened. Reload to see.", detail: result.title } : { tone: "error", title: result.title, detail: result.detail });
      return;
    }
    replaceJob(mergeJob(job, result.data.job, team));
    show({ tone: "success", title: `Reopened ${where} for ${who}.` });
  };

  const replaceJob = (next: JobView) => setLoaded((prev) => (prev.kind === "ready" ? { kind: "ready", answer: { ...prev.answer, jobs: prev.answer.jobs.map((job) => (job.id === next.id ? next : job)) } } : prev));
  const dropJob = (id: string) => setLoaded((prev) => (prev.kind === "ready" ? { kind: "ready", answer: { ...prev.answer, jobs: prev.answer.jobs.filter((job) => job.id !== id) } } : prev));

  /**
   * Delete a job (Kian's ruling of 2026-11-03, Build 2, item 2): one question, no reason asked; the job and its cleaning
   * go, unless the cleaning is counted in a payment or printed on a statement, when the server refuses with the reason.
   */
  const remove = async (job: JobView) => {
    if (saving) return;
    const where = `${job.property.name ?? job.propertyNameAtCreation ?? "the property"} · ${dayText(job.checkout)} · ${jobLabel(job)}`;
    const marked = job.assignees.filter((a) => a.cleaningId !== null);
    const yes = await ask({
      title: "Delete this job? It can't be undone.",
      lines: [where, marked.length > 0 ? `${marked.map((a) => a.name ?? a.nameAtAssignment ?? "a cleaner").join(", ")} marked it: the cleaning goes with it.` : job.cleanerIds.length > 0 ? `${job.assignees.map((a) => a.name ?? "a cleaner").join(", ")} is on it: it leaves their app.` : null],
      confirm: "Delete",
      danger: true,
    });
    if (!yes) return;
    setSaving(job.id);
    const result = await deleteJob(job.id, job.history.length);
    setSaving(null);
    if (!result.ok) {
      // The one sentence the server refuses with, as the notice's title.
      show(result.unknown ? { tone: "warning", title: "The job may or may not have been deleted. Reload to see.", detail: result.title } : { tone: "error", title: result.title, detail: result.detail });
      return;
    }
    dropJob(job.id);
    show({ tone: "success", title: `Deleted ${where}.`, detail: result.data.deleted.cleanings > 0 ? `${result.data.deleted.cleanings === 1 ? "Its cleaning went" : "Its cleanings went"} with it.` : undefined });
  };
  const unknownOrError = (result: { unknown: boolean; title: string; detail?: string }, what: string) => show(result.unknown ? { tone: "warning", title: `${what} may or may not have been saved. Reload to see.`, detail: result.title } : { tone: "error", title: result.title, detail: result.detail });

  /**
   * A job added by hand (ruling C), shown wherever its day is (Kian's instruction of 2026-11-06): the page reads its
   * days again, widened to the new job's day, or moved to it when widening would pass the read's 92 days; "Earlier"
   * opens for a past day; a filter that would hide it comes off; its row is marked and scrolled into view.
   */
  const onAdded = async ({ job, unitName, recorded }: Added) => {
    setAdding(false);
    const day = job.checkout;
    let from = range?.from;
    let to = range?.to;
    if (range && (day < range.from || day > range.to)) {
      const wideFrom = day < range.from ? day : range.from;
      const wideTo = day > range.to ? day : range.to;
      if (nightsBetween(wideFrom, wideTo) <= SCHEDULE_READ_DAYS) [from, to] = [wideFrom, wideTo];
      else [from, to] = [addDays(day, -7), addDays(day, CREATE_DAYS_AHEAD)];
    }
    if (propertyId !== "" && propertyId !== job.propertyId) setPropertyId("");
    if (cleanerId !== "" && !job.cleanerIds.includes(cleanerId)) setCleanerId("");
    if (needsOnly && job.cleanerIds.length > 0) setNeedsOnly(false);
    if (today !== null && day < today) setEarlierChosen(true);
    await load(from, to);
    setFresh(job.id);
    const where = `${unitName} · ${dayText(day)} · ${jobLabel(job)}`;
    if (!recorded) {
      show({ tone: "success", title: `Added ${where}.` });
      return;
    }
    const who = recorded.cleanings.map((made) => job.assignments[made.cleanerId]?.nameAtAssignment ?? "the cleaner").join(", ");
    const amounts = recorded.cleanings.map((made) => (made.amountCents === null ? "needs an amount" : formatCents(made.amountCents))).join(", ");
    show({ tone: "success", title: `Added ${where} and recorded it as cleaned for ${who} (${amounts}).`, detail: `It ${countsWords(day, recorded.statementMonth)} and counts in their pay, as their own mark would.` });
  };
  // The job just added, brought into view once its row is on the page (once).
  useEffect(() => {
    if (fresh === null || shownFresh.current === fresh || loaded.kind !== "ready") return;
    const row = document.querySelector(`[data-job-id="${CSS.escape(fresh)}"]`);
    if (!row) return;
    shownFresh.current = fresh;
    row.scrollIntoView({ block: "center" });
  }, [fresh, loaded]);
  /** Add a job opened: every unit for its search is read the first time, and kept; a failed read is tried again on the next open. */
  const openAdd = () => {
    setAdding(true);
    if (unitsAsked.current) return;
    unitsAsked.current = true;
    setUnits({ kind: "loading" });
    fetchAvailabilityProperties().then((result) => {
      if (result.ok) setUnits({ kind: "ready", list: result.data.map((p) => ({ id: p.id, name: p.name || p.id, publicName: p.publicName })) });
      else {
        unitsAsked.current = false;
        setUnits({ kind: "error", title: result.title });
      }
    });
  };
  /** The recent units, when the form opens: this browser's picks, then the properties of the jobs added by hand on the page. */
  const recentUnits = useMemo(() => (adding ? recentUnitIds(readPicked(), (answer?.jobs ?? []).filter((job) => job.origin === "admin").map((job) => ({ propertyId: job.propertyId, createdAt: job.createdAt }))) : []), [adding, answer]);
  /** The units not tracked by Nubnb (Kian's ruling of 2026-11-10): tagged in Add a job's search, refused when picked. */
  const untracked = useMemo(() => new Set(answer?.untracked ?? []), [answer]);

  /** Change cleaner (ruling D): one swap, with the job's price when it was changed (2026-11-06), saved; the row read as the server answered. */
  const swap = async (job: JobView, from: string, to: string, price?: PriceSent) => {
    if (saving) return;
    setSaving(job.id);
    const result = await swapJobCleaner(job.id, from, to, job.history.length, price);
    setSaving(null);
    if (!result.ok) {
      unknownOrError(result, price ? "Who is on the job and its price" : "Who is on the job");
      return;
    }
    setSwapping(null);
    if (result.data.price?.cleaningPriceSaved || (result.data.price?.cleaningsChanged ?? 0) > 0) await load(range?.from, range?.to);
    else replaceJob(mergeJob(job, result.data.job, team));
    show({ tone: "success", title: `${result.data.to ?? "The new cleaner"} is on ${job.property.name ?? "the job"} · ${dayText(job.checkout)} in place of ${result.data.from ?? "the cleaner before"}.${priceWords(job, result.data.price)}` });
  };

  /** Record as cleaned (ruling E): the cleanings their own marks would make, by the admin. */
  const record = async (job: JobView, cleanerIds: string[]) => {
    if (saving) return;
    setSaving(job.id);
    const result = await recordJobCleaned(job.id, cleanerIds, job.history.length);
    setSaving(null);
    if (!result.ok) {
      show(result.unknown ? { tone: "warning", title: "The job may or may not have been recorded cleaned. Reload to see; recording again never counts a cleaning twice.", detail: result.title } : { tone: "error", title: result.title, detail: result.detail });
      return;
    }
    setRecording(null);
    let next = mergeJob(job, result.data.job, team);
    for (const made of result.data.cleanings) next = withCleaning(next, made.cleanerId, { amountCents: made.amountCents, status: "logged", extra: null });
    replaceJob(next);
    const who = result.data.cleanings.map((made) => next.assignees.find((a) => a.cleanerId === made.cleanerId)?.name ?? "a cleaner").join(", ");
    const amounts = result.data.cleanings.map((made) => (made.amountCents === null ? "needs an amount" : formatCents(made.amountCents))).join(", ");
    show({ tone: "success", title: `Recorded ${job.property.name ?? "the job"} · ${dayText(job.checkout)} as cleaned for ${who} (${amounts}).`, detail: `It ${countsWords(job.checkout, result.data.statementMonth)} and counts in their pay, as their own mark would.` });
  };

  /** The job's own amount (ruling B), set, changed or cleared. */
  const price = async (job: JobView, amount: string | null) => {
    if (saving) return;
    setSaving(job.id);
    const result = await setJobAmountOf(job.id, amount, job.history.length);
    setSaving(null);
    if (!result.ok) {
      unknownOrError(result, "The job’s amount");
      return;
    }
    setPricing(null);
    if (result.data.cleaningsChanged > 0) await load(range?.from, range?.to);
    else replaceJob(mergeJob(job, result.data.job, team));
    if (result.data.changed) show({ tone: "success", title: amount === null ? `Cleared the amount on ${job.property.name ?? "the job"} · ${dayText(job.checkout)}: the cleaning price applies.` : `${job.property.name ?? "The job"} · ${dayText(job.checkout)}: $${amount} on the job${result.data.cleaningsChanged > 0 ? `, and its cleaning follows it` : ""}.` });
  };

  /** The extra a cleaner asked for (ruling F): approved at its amount or a new one, or declined, from the row. */
  const decideExtra = async (job: JobView, a: AssigneeView, decision: "approve" | "decline", amount?: string) => {
    if (saving || !a.cleaning || a.cleaningId === null) return;
    setSaving(job.id);
    const result = await decideJobExtra(a.cleaningId, decision, amount, a.cleaning.seen);
    setSaving(null);
    if (!result.ok) {
      unknownOrError(result, "The decision");
      return;
    }
    setExtraAt(null);
    replaceJob(withCleaning(job, a.cleanerId, { extra: decision === "approve" ? "approved" : "declined", amountCents: result.data.cleaning.amountCents, amountFrom: amount !== undefined ? "typed" : a.cleaning.amountFrom, seen: result.data.cleaning.history.length }));
    show({ tone: "success", title: `${decision === "approve" ? "Approved" : "Declined"} the note from ${a.name ?? "the cleaner"} on ${job.property.name ?? "the job"} · ${dayText(job.checkout)}: ${result.data.cleaning.amountCents === null ? "it still needs an amount" : `${formatCents(result.data.cleaning.amountCents)} counts`}.`, detail: `It ${countsWords(job.checkout, result.data.statementMonth)}.` });
  };

  const propertyGroups = useMemo(() => {
    if (!answer) return [];
    const names = new Map(answer.jobs.map((job) => [job.propertyId, job.property.name ?? job.propertyNameAtCreation ?? job.propertyId]));
    // A property a link asked for with no job in these days: named as such, so the filter never reads "All properties" while it is on.
    const linked = propertyId !== "" && !names.has(propertyId) ? [{ value: propertyId, label: "This property: no checkouts in these days" }] : [];
    return [{ options: [{ value: "", label: "All properties" }, ...linked, ...[...names].sort((a, b) => a[1].localeCompare(b[1], "en-CA")).map(([value, label]) => ({ value, label }))] }];
  }, [answer, propertyId]);
  const cleanerGroups = useMemo(() => [{ options: [{ value: "", label: "All cleaners" }, ...team.filter((member) => member.role === "cleaner").map((member) => ({ value: member.id, label: `${member.name ?? "Unnamed"}${member.status === "active" ? "" : " (deactivated)"}` }))] }], [team]);

  const dayBlock = ([day, jobs]: [string, JobView[]], ready: ScheduleAnswer) => (
    <section key={day} className={styles.day} aria-label={dayHeading(day)}>
      <h2 className={styles.dayTitle}>
        {dayHeading(day)}
        {day === ready.today && <span className={styles.today}>Today</span>}
      </h2>
      <div className={shared.tableContainer}>
        <table className={`${shared.table} ${styles.jobs}`}>
          <thead>
            <tr>
              <th>Property</th>
              <th>Turnover</th>
              <th>Cleaners</th>
              <th>State</th>
              <th className={shared.actionsHeader}>
                <span className={shared.srOnly}>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <JobRow
                key={job.id}
                job={job}
                prices={ready.prices[job.propertyId] ?? null}
                fresh={job.id === fresh}
                today={ready.today}
                moveTarget={job.change?.kind === "moved" && job.change.movedTo ? (ready.jobs.find((other) => other.id === `${job.propertyId}_${job.change?.movedTo?.end}`) ?? null) : null}
                saving={saving}
                onAssign={() => setAssigning({ job, picked: [...job.cleanerIds], mode: "assign" })}
                onTakeOff={() => setAssigning({ job, picked: [...job.cleanerIds], mode: "take-off" })}
                onSameTo={sameCleanersTo}
                onReopen={reopen}
                onSwap={() => setSwapping(job)}
                onRecord={() => setRecording(job)}
                onAmount={() => setPricing(job)}
                onDelete={() => void remove(job)}
                onExtra={(a, decision) => (decision === "amount" ? setExtraAt({ job, a }) : void decideExtra(job, a, decision))}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );

  return (
    <div className={shared.container}>
      <AdminHeader current="schedule" />

      <main className={shared.main}>
        {/* Refresh calendars is the tag in the navigation, on every admin page (Kian's rulings of 2026-10-17). Add a job is this page's own (ruling C). */}
        <PageHead title="Schedule">
          <button type="button" className={shared.btnPrimary} onClick={openAdd} disabled={loaded.kind !== "ready"}>
            <Plus size={16} aria-hidden />
            <span>Add a job</span>
          </button>
        </PageHead>

        {notice && <NoticeBanner notice={notice} onDismiss={clear} className={shared.pageNotice} />}

        {loaded.kind === "loading" ? (
          <div className={shared.loading}>
            <div className={shared.spinner} />
            <p>Loading the schedule…</p>
          </div>
        ) : loaded.kind === "error" ? (
          <div className={`${shared.empty} ${shared.loadError}`} role="alert">
            <AlertTriangle size={48} strokeWidth={1} />
            <h2>Could not load the schedule</h2>
            <p>Nothing here is empty; it has not loaded.{(loaded.status === 401 || loaded.status === 403) && " Your admin session may have expired: reload and sign in again."}</p>
            <code className={shared.loadErrorDetail}>
              {loaded.title}
              {loaded.detail ? ` ${loaded.detail}` : ""}
            </code>
            <button type="button" className={shared.btnPrimary} onClick={() => void load(range?.from, range?.to)}>
              <RefreshCw size={18} />
              <span>Retry</span>
            </button>
          </div>
        ) : (
          <>
            <div className={shared.toolbar}>
              <div className={shared.toolbarRow}>
                <DateRangeField label="Checkout days" from={range?.from ?? ""} to={range?.to ?? ""} onChange={(next) => next.from && next.to && void load(next.from, next.to)} presets={presets} />
                <AdminSelect label="Property" value={propertyId} onChange={setPropertyId} groups={propertyGroups} />
                <AdminSelect label="Cleaner" value={cleanerId} onChange={setCleanerId} groups={cleanerGroups} icon={<Users size={14} aria-hidden />} />
                <button type="button" className={`${styles.toggle} ${needsOnly ? styles.toggleOn : ""}`} aria-pressed={needsOnly} onClick={() => setNeedsOnly((on) => !on)}>
                  Needs a cleaner · {needsCount}
                </button>
              </div>
            </div>

            <CopyLine answer={loaded.answer} onRefresh={refresh} refreshing={refreshing} reading={watched} />

            {byDay.length === 0 ? (
              <p className={styles.empty}>{loaded.answer.jobs.length === 0 ? "No checkouts in these days." : "No job matches."}</p>
            ) : (
              <>
                {earlierDays.length > 0 && (
                  <section className={styles.earlier} aria-label="Earlier">
                    <button type="button" className={styles.earlierToggle} aria-expanded={earlierOpen} onClick={() => setEarlierChosen(!earlierOpen)}>
                      {earlierOpen ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
                      <span className={styles.earlierTitle}>Earlier</span>
                      <span className={styles.muted}>
                        {dayText(earlierDays[0][0])} – {dayText(earlierDays[earlierDays.length - 1][0])} · {plural(earlierCounts.jobs, "job", "jobs")}
                      </span>
                      {earlierCounts.notMarked > 0 && <span className={styles.earlierAlert}>{earlierCounts.notMarked} not marked</span>}
                      {earlierCounts.nobody > 0 && <span className={styles.earlierAlert}>{earlierCounts.nobody} with nobody on it</span>}
                      {earlierCounts.removed > 0 && <span className={styles.earlierWarn}>{earlierCounts.removed} removed by the office</span>}
                    </button>
                    {earlierOpen && <div className={styles.earlierDays}>{earlierDays.map((entry) => dayBlock(entry, loaded.answer))}</div>}
                  </section>
                )}
                {aheadDays.length === 0 ? <p className={styles.empty}>No checkout today or ahead{filtering ? " matches" : " in these days"}.</p> : aheadDays.map((entry) => dayBlock(entry, loaded.answer))}
              </>
            )}
          </>
        )}
      </main>

      {assigning && (
        <AssignDialog
          picking={assigning}
          prices={answer?.prices[assigning.job.propertyId] ?? null}
          active={active}
          team={team}
          othersThatDay={(cid) => (answer ? answer.jobs.filter((other) => other.checkout === assigning.job.checkout && other.id !== assigning.job.id && other.cleanerIds.includes(cid)).length : 0)}
          busy={saving === assigning.job.id}
          // One cleaner per job (Build 2): Assign picks one, or nobody; Take off (a changed booking) unticks whoever is on it.
          onToggle={(cid) => setAssigning((prev) => (prev ? { ...prev, picked: prev.mode === "take-off" ? (prev.picked.includes(cid) ? prev.picked.filter((x) => x !== cid) : [...prev.picked, cid]) : prev.picked.includes(cid) ? [] : [cid] } : prev))}
          onClose={() => setAssigning(null)}
          onSave={(price) => void saveAssign(price)}
          onRegularSaved={(title) => show({ tone: "success", title })}
        />
      )}
      {adding && <AddJobDialog units={units} recent={recentUnits} untracked={untracked} active={active} today={today ?? ""} busy={saving === "add"} onClose={() => setAdding(false)} onAdded={(added) => void onAdded(added)} setBusy={(on) => setSaving(on ? "add" : null)} show={show} />}
      {swapping && <SwapDialog job={swapping} prices={answer?.prices[swapping.propertyId] ?? null} active={active} busy={saving === swapping.id} onClose={() => setSwapping(null)} onSwap={(from, to, price) => void swap(swapping, from, to, price)} />}
      {recording && <RecordDialog job={recording} busy={saving === recording.id} onClose={() => setRecording(null)} onRecord={(ids) => void record(recording, ids)} />}
      {pricing && <AmountDialog title={`Amount on ${pricing.property.name ?? "the job"} · ${dayText(pricing.checkout)} · ${jobLabel(pricing)}`} words={`What a mark on this job takes instead of the property’s ${TIER_WORDS[jobTier(pricing)]} cleaning price. Leave it empty to clear it.`} initial={pricing.amountCents === null ? "" : amountField(pricing.amountCents)} allowEmpty busy={saving === pricing.id} confirm="Save" onClose={() => setPricing(null)} onSave={(amount) => void price(pricing, amount)} />}
      {extraAt && <AmountDialog title={`Approve the note from ${extraAt.a.name ?? "the cleaner"} at a new amount`} words={`The note: “${extraAt.a.note ?? ""}”. The amount it arrived with: ${extraAt.a.cleaning?.amountCents === null ? "none yet" : formatCents(extraAt.a.cleaning?.amountCents ?? 0)}.`} initial={extraAt.a.cleaning?.amountCents == null ? "" : amountField(extraAt.a.cleaning.amountCents)} allowEmpty={false} busy={saving === extraAt.job.id} confirm="Approve at this amount" onClose={() => setExtraAt(null)} onSave={(amount) => void decideExtra(extraAt.job, extraAt.a, "approve", amount ?? undefined)} />}
      {dialog}
    </div>
  );
}

/** The most days one read of the Schedule takes (GET /api/admin/cleaning-jobs: at most 92). */
const SCHEDULE_READ_DAYS = 92;

/** A copy older than this reads in amber (Kian's ruling of 2026-10-14, night). */
const STALE_AFTER_MINUTES = 24 * 60;

/** When the calendars were last read, in amber past 24 hours, and the calendars that run could not read: one line. */
function CopyLine({ answer, onRefresh, refreshing, reading }: { answer: ScheduleAnswer; onRefresh: () => void; refreshing: boolean; reading: boolean }) {
  const { refreshedAt, failed } = answer.calendar;
  if (!refreshedAt) {
    return (
      <p className={`${styles.status} ${styles.statusAlert}`} role="status">
        <strong>No calendar has been read yet.</strong>{" "}
        <button type="button" className={styles.statusLink} onClick={onRefresh} disabled={refreshing}>
          Refresh calendars
        </button>
      </p>
    );
  }
  const age = minutesBetween(refreshedAt, answer.now);
  const stale = !Number.isFinite(age) || age > STALE_AFTER_MINUTES;
  return (
    <p className={`${styles.status} ${(stale && !reading) || failed.length > 0 ? styles.statusAlert : ""}`} role="status">
      <strong>Calendars read {clock(refreshedAt)}</strong>
      {reading ? " · reading them again now; the schedule follows when it is done" : stale && " · jobs for checkouts since then may be missing"}
      {failed.length > 0 && ` · ${plural(failed.length, "calendar", "calendars")} not read: ${failed.map((f) => f.name).join(", ")}`}
    </p>
  );
}

function JobRow(props: {
  job: JobView;
  /** The unit's cleaning prices (2026-11-06: the job's price beside the cleaner chip). */
  prices: CleaningPrices | null;
  /** Just added: marked until the page is reloaded or another job is added. */
  fresh: boolean;
  today: string;
  moveTarget: JobView | null;
  saving: string | null;
  onAssign: () => void;
  onTakeOff: () => void;
  onSameTo: (from: JobView, target: JobView) => void;
  onReopen: (job: JobView, a: AssigneeView) => void;
  onSwap: () => void;
  onRecord: () => void;
  onAmount: () => void;
  onDelete: () => void;
  onExtra: (a: AssigneeView, decision: "approve" | "decline" | "amount") => void;
}) {
  const { job, prices, fresh, today, moveTarget, saving, onAssign, onTakeOff, onSameTo, onReopen, onSwap, onRecord, onAmount, onDelete, onExtra } = props;
  /** The job's price beside the cleaner chip (2026-11-06): "$80.00 · short", "$95.00 · set on the job". */
  const tag = jobPriceTag(job, prices);
  const tagSpan = tag && <span className={`${styles.priceTag} ${tag.cents === null ? styles.priceTagNone : ""}`}>{jobPriceTagText(tag)}</span>;
  const state = jobState(job, today);
  const name = job.property.name ?? job.propertyNameAtCreation ?? "Unknown property";
  const unread = job.calendar.status === "failed";
  const takeOff = job.status !== "open" && unmarked(job).length > 0;
  // One cleaner per job (Build 2): a moved booking's cleaner goes to the new job only while it has nobody.
  const sameTo = job.status !== "open" && moveTarget !== null && moveTarget.status === "open" && moveTarget.cleanerIds.length === 0 && job.cleanerIds.length > 0;
  const tier = jobTier(job);
  const nights = jobNights(job);
  /** Someone on it, not marked, not removed: who Change cleaner swaps and Record as cleaned records (rulings D and E). */
  const open = job.status === "open";
  const canSwap = open && job.assignees.some((a) => a.cleaningId === null);
  const canRecord = open && job.checkout <= today && job.assignees.some((a) => a.cleaningId === null);
  /** The job's amount is locked once a mark's cleaning counts its money (ruling B). */
  const amountLocked = job.assignees.some((a) => a.cleaning !== null && a.cleaning.status === "logged" && a.cleaning.amountCents !== null && a.cleaning.extra !== "asked");
  return (
    <tr data-job-id={job.id} className={fresh ? styles.rowFresh : undefined}>
      <td>
        <Link href={`/admin/property?id=${encodeURIComponent(job.propertyId)}`} prefetch={false} className={styles.property}>
          {name}
        </Link>
        {job.property.state === "missing" && <span className={styles.muted}> · deleted</span>}
        {unread && <span className={styles.warn}> · calendar not read since {job.calendar.failedSince ? clock(job.calendar.failedSince) : "the last run"}</span>}
        {job.origin === "admin" && <span className={styles.muted}> · added by hand</span>}
        {fresh && <span className={styles.freshNote}> · just added</span>}
      </td>
      <td>
        <span className={styles.turnover}>
          {/* The job's label (Build 2): "Turnover" on the calendar's, the admin's words on one added by hand. */}
          <span className={styles.jobLabel}>{jobLabel(job)}</span>
          {job.origin !== "admin" && <span>{job.property.checkOut ?? "Checkout"}</span>}
          {isSameDay(job) ? (
            <span className={styles.sameDay} title={`The next guest checks in the same day${job.property.checkIn ? `, ${job.property.checkIn}` : ""}`}>
              Same day
            </span>
          ) : job.origin === "admin" ? null : (
            <span className={styles.muted}>{job.nextCheckIn ? `next guest ${dayText(job.nextCheckIn)}` : "no next guest yet"}</span>
          )}
          {/* The job's tier (ruling A), and its own amount when set (ruling B). */}
          <span className={styles.tierNote} title={`${TIER_WORDS[tier]}: ${TIER_NIGHTS[tier]}`}>
            {job.origin === "admin" ? `${TIER_WORDS[tier]} job` : `${nights === 1 ? "1 night" : `${nights} nights`} · ${TIER_WORDS[tier]}`}
          </span>
        </span>
      </td>
      <td>
        {job.assignees.length === 0 ? (
          <span className={styles.cleanerCell}>
            <span className={styles.muted}>—</span>
            {tagSpan}
          </span>
        ) : (
          <span className={styles.chips}>
            {job.assignees.map((a, index) => {
              const removed = isRemoved(a);
              const done = a.cleaningId !== null && !removed;
              const title = removed
                ? `Marked cleaned ${a.markedAt ? clock(a.markedAt) : ""}; removed by the office ${a.removedAt ? clock(a.removedAt) : ""}${a.removedBy?.name ? ` (${a.removedBy.name})` : ""}`
                : done
                  ? `Marked cleaned ${a.markedAt ? clock(a.markedAt) : ""}`
                  : `Assigned ${clock(a.assignedAt)}${a.assignedBy.role === "system" && a.assignedBy.name ? ` by the ${a.assignedBy.name}` : ""}`;
              return (
                <span key={a.cleanerId} className={styles.chipLine}>
                  <span className={`${styles.chip} ${done ? styles.chipDone : ""} ${removed ? styles.chipRemoved : ""}`} title={title}>
                    {done && <Check size={12} aria-label="Marked cleaned" />}
                    {a.name ?? "Unnamed"}
                    {a.state === "missing" ? " (deleted)" : a.status && a.status !== "active" ? " (deactivated)" : ""}
                    {removed && <span className={styles.chipNote}> removed by the office</span>}
                    {done && a.cleaning && a.cleaning.status === "logged" && a.cleaning.amountCents === null && <span className={styles.chipNote}> needs an amount</span>}
                    {done && a.cleaning?.extra === "asked" && <span className={styles.chipNote}> needs a decision</span>}
                  </span>
                  {index === 0 && tagSpan}
                  {canReopen(job, a) && (
                    <button type="button" className={styles.chipAction} onClick={() => onReopen(job, a)} disabled={saving !== null} aria-label={`Reopen for ${a.name ?? "this cleaner"}`}>
                      <RotateCcw size={12} aria-hidden />
                      Reopen
                    </button>
                  )}
                  {/* The cleaner's note on their mark (ruling F; Build 2's one word): "Needs a decision" with the note's words, and the three decisions. */}
                  {done && a.note && a.cleaning?.extra !== "asked" && <span className={styles.chipWords}>note: “{a.note}”</span>}
                  {done && a.cleaning?.extra === "asked" && a.cleaning.status === "logged" && (
                    <span className={`${styles.chipWords} ${styles.chipExtra}`}>
                      Needs a decision: “{a.note ?? ""}” · {a.cleaning.amountCents === null ? "needs an amount" : `${formatCents(a.cleaning.amountCents)} ${a.cleaning.amountFrom ? AMOUNT_SOURCE_WORDS[a.cleaning.amountFrom] : ""}`}
                      <span className={styles.chipActions}>
                        <button type="button" className={styles.chipAction} onClick={() => onExtra(a, "approve")} disabled={saving !== null || a.cleaning.amountCents === null} title="Approve at the cleaning price it arrived with (one click)">
                          Approve at cleaning price
                        </button>
                        <button type="button" className={styles.chipAction} onClick={() => onExtra(a, "amount")} disabled={saving !== null} title="Approve at a new amount">
                          Amount…
                        </button>
                        <button type="button" className={styles.chipAction} onClick={() => onExtra(a, "decline")} disabled={saving !== null || a.cleaning.amountCents === null} title="Decline: the cleaning price counts">
                          Decline
                        </button>
                      </span>
                    </span>
                  )}
                  {done && a.cleaning?.extra && a.cleaning.extra !== "asked" && <span className={styles.chipWords}>note {a.cleaning.extra}</span>}
                </span>
              );
            })}
          </span>
        )}
      </td>
      <td>
        <span className={`${styles.state} ${styles[`state_${state.tone}`]}`}>{state.label}</span>
      </td>
      <td className={styles.actions}>
        <span className={styles.actionStack}>
          <span className={styles.actionRow}>
            {/* One cleaner per job (Build 2): Assign while nobody is on it; Change cleaner once someone is, until they mark. */}
            {job.status === "open" && job.cleanerIds.length === 0 && (
              <button type="button" className={shared.btnGhost} onClick={onAssign} disabled={saving !== null}>
                <UserPlus size={14} aria-hidden />
                <span>Assign</span>
              </button>
            )}
            {canSwap && (
              <button type="button" className={shared.btnGhost} onClick={onSwap} disabled={saving !== null} title="The cleaner off, another on, in one step">
                <Repeat size={14} aria-hidden />
                <span>Change cleaner</span>
              </button>
            )}
            {canRecord && (
              <button type="button" className={shared.btnGhost} onClick={onRecord} disabled={saving !== null} title="Mark it cleaned for its cleaner, exactly as their own mark would">
                <ClipboardCheck size={14} aria-hidden />
                <span>Record as cleaned</span>
              </button>
            )}
            {/* The rest behind "⋯" (Kian's ruling of 2026-11-03: the amount from the row's menu, not a button on every row). */}
            <RowMenu
              label={`More for ${name} · ${dayText(job.checkout)}`}
              disabled={saving !== null}
              triggerClassName={`${shared.btnGhost} ${styles.menuTrigger}`}
              items={[
                ...(open && job.cleanerIds.length > 0 ? [{ label: "Who cleans…", onSelect: onAssign }] : []),
                ...(open ? [{ label: job.amountCents === null ? "Amount…" : `Amount… (${formatCents(job.amountCents)} on the job)`, onSelect: onAmount, disabled: amountLocked, title: amountLocked ? "Its cleaning already counts its money: change the amount on the Cleanings tab" : "The job's own amount, which a mark takes instead of the cleaning price" }] : []),
                { label: "Delete…", danger: true, onSelect: onDelete },
              ]}
            />
          </span>
          {sameTo && moveTarget && (
            <button type="button" className={shared.btnGhost} onClick={() => onSameTo(job, moveTarget)} disabled={saving !== null}>
              <span>Same cleaner to {dayText(moveTarget.checkout)}</span>
            </button>
          )}
          {takeOff && (
            <button type="button" className={shared.btnGhost} onClick={onTakeOff} disabled={saving !== null}>
              <UserMinus size={14} aria-hidden />
              <span>Take off</span>
            </button>
          )}
        </span>
      </td>
    </tr>
  );
}

function AssignDialog(props: {
  picking: Picking;
  /** The unit's cleaning prices: "Price for this job" (2026-11-06). */
  prices: CleaningPrices | null;
  active: TeamMember[];
  team: TeamMember[];
  othersThatDay: (cleanerId: string) => number;
  busy: boolean;
  onToggle: (cleanerId: string) => void;
  onClose: () => void;
  /** Save: who is on it and, when changed, its price (2026-11-06; never in take-off). */
  onSave: (price?: PriceSent) => void;
  onRegularSaved: (title: string) => void;
}) {
  const { picking, prices, active, team, othersThatDay, busy, onToggle, onClose, onSave, onRegularSaved } = props;
  const { job, picked, mode } = picking;
  const name = job.property.name ?? job.propertyNameAtCreation ?? "the property";
  // Active cleaners, and anyone already on the job who no longer is (they can be taken off, not put back).
  const onJob = job.assignees.filter((a) => !active.some((member) => member.id === a.cleanerId));

  // The property's regular cleaner (Kian's ruling R5): read when the picker opens, one read.
  const [regular, setRegular] = useState<{ kind: "loading" } | { kind: "ready"; data: RegularCleanerAnswer } | { kind: "error"; title: string }>({ kind: "loading" });
  const [regularBusy, setRegularBusy] = useState(false);
  const [regularSaid, setRegularSaid] = useState<string | null>(null);
  /** Take off's own line: "Nobody was taken off" after a Save with nobody unticked, until a tick changes. */
  const [takeOffSaid, setTakeOffSaid] = useState<string | null>(null);
  const { ask, dialog: question } = useAsk();
  /** "Price for this job" (Kian's instruction of 2026-11-06), below the cleaner choice; not in take-off. */
  const price = useJobPrice(job, prices);
  const [priceSaid, setPriceSaid] = useState<string | null>(null);
  useEffect(() => {
    if (mode !== "assign") return;
    let cancelled = false;
    fetchRegularCleaner(job.propertyId).then((result) => {
      if (!cancelled) setRegular(result.ok ? { kind: "ready", data: result.data } : { kind: "error", title: result.title });
    });
    return () => {
      cancelled = true;
    };
  }, [job.propertyId, mode]);
  const current = regular.kind === "ready" ? regular.data.regular : null;
  /** The one active cleaner ticked, when they are not already the regular cleaner. */
  const candidate = picked.length === 1 && regular.kind === "ready" && current?.cleanerId !== picked[0] ? (active.find((member) => member.id === picked[0]) ?? null) : null;
  /** Save: one cleaner, or nobody (Build 2: a job has one cleaner, so there is no second to ask about), and its price when changed. */
  const save = async () => {
    if (busy) return;
    const sent = price.toSend();
    if (sent.kind === "bad") {
      setPriceSaid(sent.problem);
      return;
    }
    setPriceSaid(null);
    onSave(sent.kind === "send" ? { price: sent.price, saveCleaningPrice: sent.saveCleaningPrice } : undefined);
  };
  const makeRegular = async () => {
    if (!candidate || regularBusy) return;
    if (!(await ask(regularCleanerQuestion(candidate.name, name)))) return;
    setRegularBusy(true);
    const result = await setRegularCleanerOf(job.propertyId, candidate.id);
    setRegularBusy(false);
    if (!result.ok) {
      setRegularSaid(result.unknown ? `It may or may not have been saved: ${result.title}` : `${result.title}${result.detail ? ` ${result.detail}` : ""}`);
      return;
    }
    setRegular((prev) => (prev.kind === "ready" ? { kind: "ready", data: { ...prev.data, regular: { cleanerId: candidate.id, name: candidate.name, state: "found", role: "cleaner", status: "active", assigns: true, setAt: new Date().toISOString() } } } : prev));
    setRegularSaid(null);
    onRegularSaved(`${candidate.name ?? "They"} ${candidate.name ? "is" : "are"} the regular cleaner for ${name}: the next jobs made for it go to them.`);
  };

  // While Nubnb asks before setting the regular cleaner, its question stands in for the picker: one dialog open at a
  // time, so Escape answers only the question. The picker comes back as it was left, ticks and all. The key mounts each
  // afresh, so the keyboard starts on the button that does nothing, as in every question.
  if (question) return <Fragment key="question">{question}</Fragment>;

  if (mode === "take-off") {
    return (
      <Dialog
        title={`Take a cleaner off ${name} · ${dayText(job.checkout)}`}
        onClose={onClose}
        actions={
          <>
            <button type="button" className={`${ed.btn} ${ed.btnGhost}`} onClick={onClose} disabled={busy}>
              Cancel
            </button>
            {/* Nobody unticked: say so and send nothing, rather than close without a word (Kian's instruction of 2026-11-01). */}
            <button type="button" className={`${ed.btn} ${ed.btnPrimary}`} onClick={() => (takenOff(job, picked).length === 0 ? setTakeOffSaid(NOBODY_TAKEN_OFF) : onSave(undefined))} disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </button>
          </>
        }
      >
        <div className={styles.dialogBody}>
          <p className={styles.muted}>The booking changed ({changeWords(job.change)?.toLowerCase()}): nobody is added to this job. Untick a cleaner to take them off; it leaves their app. A cleaner who marked it stays on it.</p>
          <ul className={styles.pickList}>
            {job.assignees.map((a) => (
              <li key={a.cleanerId} className={styles.pickRow}>
                <Tick
                  checked={picked.includes(a.cleanerId)}
                  onChange={() => {
                    setTakeOffSaid(null);
                    onToggle(a.cleanerId);
                  }}
                  label={`${a.name ?? "Unnamed"} on this job`}
                  disabled={busy || a.cleaningId !== null}
                  title={a.cleaningId !== null ? "Marked it cleaned: stays on it" : undefined}
                />
                <span className={styles.pickName}>{a.name ?? "Unnamed"}</span>
                <span className={styles.muted}>{a.cleaningId !== null ? "marked it cleaned" : ""}</span>
              </li>
            ))}
          </ul>
          {takeOffSaid && (
            <p className={styles.warn} role="status">
              {takeOffSaid}
            </p>
          )}
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      title={`Who cleans ${name} · ${dayText(job.checkout)}`}
      onClose={onClose}
      actions={
        <>
          <button type="button" className={`${ed.btn} ${ed.btnGhost}`} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className={`${ed.btn} ${ed.btnPrimary}`} onClick={() => void save()} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <div className={styles.dialogBody}>
        <p className={styles.muted}>One cleaner per job: tick who cleans it, or Nobody. For a second cleaner, add another job on the same day.</p>
        {active.length === 0 && onJob.length === 0 ? (
          <p>No active cleaner. Add one on the Team page.</p>
        ) : (
          <ul className={styles.pickList}>
            {/* Nobody: the job stays, with nobody on it, until someone is picked. */}
            <li className={styles.pickRow}>
              <Tick checked={picked.length === 0} onChange={() => picked.length > 0 && onToggle(picked[0])} label="Nobody on this job" disabled={busy || job.assignees.some((a) => a.cleaningId !== null)} title={job.assignees.some((a) => a.cleaningId !== null) ? "Marked it cleaned: stays on it" : undefined} />
              <span className={styles.pickName}>Nobody</span>
              <span className={styles.muted}>{picked.length === 0 ? "needs a cleaner" : ""}</span>
            </li>
            {active.map((member) => {
              const onIt = job.assignees.find((a) => a.cleanerId === member.id);
              const marked = onIt?.cleaningId ?? null;
              const others = othersThatDay(member.id);
              return (
                <li key={member.id} className={styles.pickRow}>
                  <Tick checked={picked.includes(member.id)} onChange={() => onToggle(member.id)} label={`${member.name ?? "Unnamed"} on this job`} disabled={busy || marked !== null} title={marked ? "Marked it cleaned: stays on it" : undefined} />
                  <span className={styles.pickName}>{member.name ?? "Unnamed"}</span>
                  <span className={styles.muted}>{marked ? (onIt && isRemoved(onIt) ? "marked it cleaned · removed by the office" : "marked it cleaned") : others > 0 ? `${plural(others, "other job", "other jobs")} that day` : ""}</span>
                </li>
              );
            })}
            {onJob.map((a) => (
              <li key={a.cleanerId} className={styles.pickRow}>
                <Tick checked={picked.includes(a.cleanerId)} onChange={() => picked.includes(a.cleanerId) && onToggle(a.cleanerId)} label={`${a.name ?? "Unnamed"} on this job`} disabled={busy || a.cleaningId !== null || !picked.includes(a.cleanerId)} />
                <span className={styles.pickName}>{a.name ?? "Unnamed"}</span>
                <span className={styles.muted}>{team.some((member) => member.id === a.cleanerId) ? "deactivated" : "deleted"}</span>
              </li>
            ))}
          </ul>
        )}
        <JobPriceBlock job={job} prices={prices} price={price} busy={busy} said={priceSaid} />
        <div className={styles.regular}>
          <span className={styles.regularLine}>
            {regular.kind === "loading"
              ? "Regular cleaner: …"
              : regular.kind === "error"
                ? `Regular cleaner: could not be read (${regular.title})`
                : current
                  ? `Regular cleaner: ${current.name ?? "Unnamed"}${current.state === "missing" ? " (deleted): new jobs here have nobody on them" : !current.assigns ? " (deactivated): new jobs here have nobody on them" : ""}`
                  : regular.data.unreadable
                    ? "Regular cleaner: its record could not be read"
                    : "No regular cleaner"}
          </span>
          {candidate && (
            <button type="button" className={styles.statusLink} onClick={() => void makeRegular()} disabled={regularBusy || busy}>
              {regularBusy ? "Saving…" : `Make ${candidate.name ?? "them"} the regular cleaner for this property`}
            </button>
          )}
          {regularSaid && (
            <span className={styles.warn} role="alert">
              {regularSaid}
            </span>
          )}
        </div>
      </div>
    </Dialog>
  );
}

// ─── The cleaning flow's dialogs (Kian's rulings of 2026-11-01) ───

type UnitsState = { kind: "loading" } | { kind: "ready"; list: UnitChoice[] } | { kind: "error"; title: string };
type AmountStart = { kind: "none" } | { kind: "loading"; propertyId: string } | { kind: "ready"; propertyId: string; prices: CleaningPrices | null; lastTyped: LastTyped } | { kind: "error"; propertyId: string; title: string };
/** A job just added, with the name the form picked it by (the address the admin lists show). */
type Added = { job: StoredJob; unitName: string; recorded: RecordedOnAdd | null };

/** The units this browser picked in "Add a job" before, newest first: a convenience kept in this browser only (it may be empty). */
const PICKED_KEY = "nubnb.admin.add-job.picked";
function readPicked(): string[] {
  try {
    const raw = window.localStorage.getItem(PICKED_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((id): id is string => typeof id === "string").slice(0, RECENT_UNITS) : [];
  } catch {
    return [];
  }
}
function rememberPicked(id: string) {
  try {
    window.localStorage.setItem(PICKED_KEY, JSON.stringify([id, ...readPicked().filter((other) => other !== id)].slice(0, RECENT_UNITS)));
  } catch {
    /* not kept: the next open starts from the Schedule's added jobs */
  }
}

/** The property, found by typing (the UX pass of 2026-11-06): any part of its address or public title, recent first. No dropdown to open. */
function PropertySearch({ units, recent, untracked, picked, onPick, disabled, inputRef }: { units: UnitsState; recent: string[]; untracked: ReadonlySet<string>; picked: UnitChoice | null; onPick: (unit: UnitChoice | null) => void; disabled: boolean; inputRef: RefObject<HTMLInputElement | null> }) {
  const id = useId();
  const [query, setQuery] = useState(picked?.name ?? "");
  const [open, setOpen] = useState(false);
  const [activeRaw, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const order = useMemo(() => (units.kind === "ready" ? unitOrder(units.list, picked && query === picked.name ? "" : query, recent) : { recent: [], rest: [] }), [units, query, recent, picked]);
  const flat = useMemo(() => [...order.recent, ...order.rest], [order]);
  const active = Math.min(activeRaw, Math.max(0, flat.length - 1));
  const ready = units.kind === "ready";

  // A press outside closes the list.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);
  // The highlighted row stays in view.
  useEffect(() => {
    if (open) document.getElementById(`${id}-unit-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, id]);

  const choose = (unit: UnitChoice) => {
    setQuery(unit.name);
    setOpen(false);
    onPick(unit);
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    const count = Math.max(1, flat.length);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(ready);
        return;
      }
      setActive((index) => (event.key === "ArrowDown" ? (index + 1) % count : (index - 1 + count) % count));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (open && flat[active]) choose(flat[active]);
    } else if (event.key === "Escape" && open) {
      // The list closes; the dialog stays (it closes on any Escape that reaches the window).
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    } else if (event.key === "Tab") setOpen(false);
  };
  const option = (unit: UnitChoice, index: number) => (
    <div key={unit.id} id={`${id}-unit-${index}`} role="option" aria-selected={index === active} className={`${styles.unitOption} ${index === active ? styles.unitOptionActive : ""}`} onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => choose(unit)}>
      <span className={styles.unitName}>{unit.name}</span>
      {unit.publicName && unit.publicName !== unit.name && <span className={styles.unitTitle}>{unit.publicName}</span>}
      {untracked.has(unit.id) && <span className={styles.unitNote}>{NOT_TRACKED}</span>}
    </div>
  );
  return (
    <div ref={rootRef} className={styles.unitSearch}>
      <span className={styles.unitInputWrap}>
        <Search size={15} className={styles.unitIcon} aria-hidden />
        <input
          ref={inputRef}
          className={styles.unitInput}
          role="combobox"
          aria-label="Property"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={`${id}-units`}
          aria-activedescendant={open && flat[active] ? `${id}-unit-${active}` : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder={units.kind === "loading" ? "Loading the properties…" : units.kind === "error" ? "The properties could not be read" : "Type an address or a title"}
          value={query}
          disabled={disabled || !ready}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setOpen(true);
            if (picked && e.target.value !== picked.name) onPick(null);
          }}
          onClick={() => setOpen(ready)}
          onKeyDown={onKey}
        />
      </span>
      {picked && picked.publicName && picked.publicName !== picked.name && !open && <span className={styles.unitPickedTitle}>{picked.publicName}</span>}
      {open && ready && (
        <div id={`${id}-units`} role="listbox" aria-label="Properties" className={styles.unitList}>
          {flat.length === 0 ? (
            <p className={styles.unitEmpty}>No property matches “{query.trim()}”.</p>
          ) : (
            <>
              {order.recent.length > 0 && (
                <div role="group" aria-label="Recent">
                  <div className={styles.unitGroup}>Recent</div>
                  {order.recent.map((unit, index) => option(unit, index))}
                </div>
              )}
              {order.rest.length > 0 && (
                <div role="group" aria-label="All properties">
                  <div className={styles.unitGroup}>All properties</div>
                  {order.rest.map((unit, index) => option(unit, order.recent.length + index))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Add a job (ruling C), the UX pass of 2026-11-06: one column — Property (found by typing), Day (back to the statements
 * floor), Cleaner, Label (quick choices), Amount (the property's cleaning price, one tap to its others), and "Already
 * cleaned" on a day that has come, which adds the job and records it cleaned in one step.
 */
function AddJobDialog(props: { units: UnitsState; recent: string[]; untracked: ReadonlySet<string>; active: TeamMember[]; today: string; busy: boolean; onClose: () => void; onAdded: (added: Added) => void; setBusy: (on: boolean) => void; show: (notice: { tone: "error" | "warning"; title: string; detail?: string }) => void }) {
  const { units, recent, untracked, active, today, busy, onClose, onAdded, setBusy, show } = props;
  const searchRef = useRef<HTMLInputElement>(null);
  const [unit, setUnit] = useState<UnitChoice | null>(null);
  const [day, setDay] = useState(today);
  const [cleanerId, setCleanerId] = useState("");
  /** Its label (Build 2), from the quick choices; "Other" opens a text field. */
  const [labelChoice, setLabelChoice] = useState<string>(DEFAULT_JOB_LABEL);
  const [otherLabel, setOtherLabel] = useState("");
  /** The tier the amount's price came from: short-term unless another price was tapped. */
  const [tier, setTier] = useState<PresetKind>("short");
  const [amount, setAmount] = useState("");
  const [start, setStart] = useState<AmountStart>({ kind: "none" });
  const [alreadyCleaned, setAlreadyCleaned] = useState(false);
  const [said, setSaid] = useState<string | null>(null);

  // The keyboard starts in the property's search: the first thing to do.
  useEffect(() => {
    if (units.kind === "ready") searchRef.current?.focus();
  }, [units.kind]);

  /** The pick the latest read is for: an answer for an earlier pick is dropped. */
  const pickedRef = useRef<string | null>(null);
  /** A property picked (or the pick cleared by typing): its cleaning prices, and what was last typed there where it has none. */
  const pick = (next: UnitChoice | null) => {
    // A unit not tracked by Nubnb is refused at the pick (Kian's ruling of 2026-11-10), in the server's own words.
    if (next && untracked.has(next.id)) {
      setUnit(null);
      setAmount("");
      setTier("short");
      pickedRef.current = null;
      setStart({ kind: "none" });
      setSaid(ADD_JOB_NOT_TRACKED);
      return;
    }
    setSaid(null);
    setUnit(next);
    setAmount("");
    setTier("short");
    pickedRef.current = next?.id ?? null;
    if (!next) {
      setStart({ kind: "none" });
      return;
    }
    setStart({ kind: "loading", propertyId: next.id });
    fetchAmountStart(next.id).then((result) => {
      if (pickedRef.current !== next.id) return;
      if (!result.ok) {
        setStart({ kind: "error", propertyId: next.id, title: result.title });
        return;
      }
      const opening = amountStart(result.data.prices, result.data.lastTyped);
      setStart({ kind: "ready", propertyId: next.id, prices: result.data.prices, lastTyped: result.data.lastTyped });
      setTier(opening.tier);
      setAmount(opening.field.value);
    });
  };

  const prices = start.kind === "ready" ? start.prices : null;
  const lastTyped = start.kind === "ready" ? start.lastTyped : NOTHING_TYPED;
  const cents = amount.trim() === "" ? null : readAmountCents(amount);
  const words = start.kind === "loading" ? "Reading its cleaning price…" : start.kind === "error" ? "Its cleaning price could not be read: type the amount, or leave it empty." : start.kind === "ready" ? amountWords(prices, lastTyped, tier, cents, amount.trim() === "") : "";
  const offerCleaned = canRecordOnAdd(day, today);
  const recordNow = offerCleaned && alreadyCleaned;
  const cleanerName = active.find((m) => m.id === cleanerId)?.name ?? null;

  const save = async () => {
    if (busy) return;
    const label = chosenLabel(labelChoice, otherLabel);
    const problems = [
      unit === null ? "Pick the property." : null,
      addedJobDayProblem(day),
      label === null ? "Type the label for Other." : null,
      amount.trim() !== "" && cents === null ? "The amount is dollars and cents above $0.00, like 75.00, or empty." : null,
      recordNow && cleanerId === "" ? "Already cleaned needs the cleaner who cleaned it." : null,
    ].filter((x): x is string => x !== null);
    if (problems.length > 0 || unit === null) {
      setSaid(problems.join(" "));
      return;
    }
    setSaid(null);
    setBusy(true);
    const result = await addJobByHand({ propertyId: unit.id, checkout: day, cleanerId: cleanerId === "" ? null : cleanerId, tier, amount: cents === null ? null : amountField(cents), label, alreadyCleaned: recordNow });
    setBusy(false);
    if (!result.ok) {
      if (result.unknown) show({ tone: "warning", title: recordNow ? "The job may or may not have been added and recorded. Reload to see." : "The job may or may not have been added. Reload to see.", detail: result.title });
      else setSaid(`${result.title}${result.detail ? ` ${result.detail}` : ""}`);
      return;
    }
    rememberPicked(unit.id);
    onAdded({ job: result.data.job, unitName: unit.name, recorded: result.data.recorded });
  };

  return (
    <Dialog
      title="Add a job"
      onClose={onClose}
      initialFocus="none"
      actions={
        <>
          <button type="button" className={`${ed.btn} ${ed.btnGhost}`} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className={`${ed.btn} ${ed.btnPrimary}`} onClick={() => void save()} disabled={busy || units.kind !== "ready"}>
            {busy ? "Adding…" : recordNow ? "Add and record as cleaned" : "Add the job"}
          </button>
        </>
      }
    >
      <div className={`${styles.dialogBody} ${styles.addForm}`}>
        <div className={styles.dialogField}>
          <span className={styles.dialogLabel}>Property</span>
          <PropertySearch units={units} recent={recent} untracked={untracked} picked={unit} onPick={pick} disabled={busy} inputRef={searchRef} />
        </div>
        <div className={styles.dialogField}>
          <span className={styles.dialogLabel}>Day</span>
          <DateRangeField label="Day" single from={day} to={day} min={ADDED_JOB_FROM_DAY} max={addedJobLastDay(today)} note={FLOOR_WORDS} className={styles.fieldFull} onChange={(range) => range.from && setDay(range.from)} />
        </div>
        <div className={styles.dialogField}>
          <span className={styles.dialogLabel}>Cleaner</span>
          <AdminSelect label="Cleaner" className={ed.selectFull} value={cleanerId} onChange={setCleanerId} groups={[{ options: [{ value: "", label: "Nobody yet" }, ...active.map((m) => ({ value: m.id, label: m.name ?? "Unnamed" }))] }]} disabled={busy} />
        </div>
        <div className={styles.dialogField}>
          <span className={styles.dialogLabel} id="add-job-label">
            Label
          </span>
          <div className={styles.labelChoices} role="radiogroup" aria-labelledby="add-job-label">
            {[...JOB_LABEL_CHOICES, OTHER_LABEL].map((choice) => (
              <button key={choice} type="button" role="radio" aria-checked={labelChoice === choice} className={`${styles.choice} ${labelChoice === choice ? styles.choiceOn : ""}`} onClick={() => setLabelChoice(choice)} disabled={busy}>
                {choice}
              </button>
            ))}
          </div>
          {labelChoice === OTHER_LABEL && <input className={styles.textInput} value={otherLabel} maxLength={JOB_LABEL_MAX} placeholder="The label, like Windows" onChange={(e) => setOtherLabel(e.target.value)} disabled={busy} aria-label="Other label" />}
        </div>
        <div className={styles.dialogField}>
          <span className={styles.dialogLabel}>Amount ($)</span>
          <PriceField
            id="add-job-amount"
            label="Amount"
            state={start.kind}
            prices={prices}
            lastTyped={lastTyped}
            tier={tier}
            amount={amount}
            onChange={(next) => {
              setTier(next.tier);
              setAmount(next.amount);
            }}
            words={words}
            emptyPlaceholder="Pick the property first"
            disabled={busy}
          />
        </div>
        {offerCleaned && (
          <div className={styles.cleanedRow}>
            <Tick checked={alreadyCleaned} onChange={() => setAlreadyCleaned((on) => !on)} label="Already cleaned" disabled={busy} />
            <span className={styles.pickName}>Already cleaned</span>
            {/* With nobody picked, the refusal comes once, on Add (one sentence, said once). */}
            {alreadyCleaned && cleanerId !== "" && <span className={styles.muted}>Recorded for {cleanerName ?? "them"} as it is added.</span>}
          </div>
        )}
        <p className={styles.muted}>Goes to the cleaner’s app like any job.</p>
        {said && (
          <p className={styles.warn} role="alert">
            {said}
          </p>
        )}
      </div>
    </Dialog>
  );
}

/** Change cleaner (ruling D; one cleaner per job since Build 2): the cleaner comes off (not yet marked), another goes on, in one step. */
function SwapDialog({ job, prices, active, busy, onClose, onSwap }: { job: JobView; prices: CleaningPrices | null; active: TeamMember[]; busy: boolean; onClose: () => void; onSwap: (from: string, to: string, price?: PriceSent) => void }) {
  const name = job.property.name ?? job.propertyNameAtCreation ?? "the property";
  const leaving = job.assignees.filter((a) => a.cleaningId === null);
  const from = leaving[0]?.cleanerId ?? "";
  const [to, setTo] = useState("");
  const [said, setSaid] = useState<string | null>(null);
  const choices = active.filter((m) => !job.cleanerIds.includes(m.id));
  /** "Price for this job" (Kian's instruction of 2026-11-06), below the cleaner choice. */
  const price = useJobPrice(job, prices);
  const [priceSaid, setPriceSaid] = useState<string | null>(null);
  const change = () => {
    if (from === "" || to === "") {
      setSaid("Pick who comes off and who goes on.");
      return;
    }
    const sent = price.toSend();
    if (sent.kind === "bad") {
      setPriceSaid(sent.problem);
      return;
    }
    setPriceSaid(null);
    onSwap(from, to, sent.kind === "send" ? { price: sent.price, saveCleaningPrice: sent.saveCleaningPrice } : undefined);
  };
  return (
    <Dialog
      title={`Change the cleaner on ${name} · ${dayText(job.checkout)}`}
      onClose={onClose}
      actions={
        <>
          <button type="button" className={`${ed.btn} ${ed.btnGhost}`} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={`${ed.btn} ${ed.btnPrimary}`}
            onClick={change}
            disabled={busy || choices.length === 0}
          >
            {busy ? "Saving…" : "Change cleaner"}
          </button>
        </>
      }
    >
      <div className={styles.dialogBody}>
        <div className={styles.dialogRow}>
          <div className={styles.dialogField}>
            <span className={styles.dialogLabel}>Off the job</span>
            <span className={styles.pickName}>{leaving[0]?.name ?? "Unnamed"}</span>
          </div>
          <div className={styles.dialogField}>
            <span className={styles.dialogLabel}>On the job</span>
            <AdminSelect label="On the job" value={to} onChange={setTo} placeholder={choices.length === 0 ? "No other active cleaner" : "Pick the cleaner"} groups={[{ options: choices.map((m) => ({ value: m.id, label: m.name ?? "Unnamed" })) }]} disabled={busy || choices.length === 0} />
          </div>
        </div>
        <JobPriceBlock job={job} prices={prices} price={price} busy={busy} said={priceSaid} />
        <p className={styles.muted}>One step, logged. The job leaves the first cleaner’s app and shows in the second’s. A cleaner who marked it stays on it.</p>
        {said && (
          <p className={styles.warn} role="alert">
            {said}
          </p>
        )}
      </div>
    </Dialog>
  );
}

/** Record as cleaned (ruling E; one cleaner per job since Build 2): for the job's cleaner, not yet marked. */
function RecordDialog({ job, busy, onClose, onRecord }: { job: JobView; busy: boolean; onClose: () => void; onRecord: (cleanerIds: string[]) => void }) {
  const name = job.property.name ?? job.propertyNameAtCreation ?? "the property";
  const open = job.assignees.filter((a) => a.cleaningId === null);
  const picked = open.slice(0, 1).map((a) => a.cleanerId);
  return (
    <Dialog
      title={`Record ${name} · ${dayText(job.checkout)} as cleaned?`}
      onClose={onClose}
      actions={
        <>
          <button type="button" className={`${ed.btn} ${ed.btnGhost}`} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className={`${ed.btn} ${ed.btnPrimary}`} onClick={() => onRecord(picked)} disabled={busy || picked.length === 0}>
            {busy ? "Recording…" : "Record as cleaned"}
          </button>
        </>
      }
    >
      <div className={styles.dialogBody}>
        <p className={styles.muted}>It counts exactly as if the cleaner marked it: the same amount, statement line and pay. The job’s history names you.</p>
        <p>
          Record for <strong>{open[0]?.name ?? "Unnamed"}</strong> · {jobLabel(job)}
        </p>
      </div>
    </Dialog>
  );
}

/** One amount, typed (rulings B and F): the job's own amount, or the amount an extra is approved at. */
function AmountDialog({ title, words, initial, allowEmpty, busy, confirm, onClose, onSave }: { title: string; words: string; initial: string; allowEmpty: boolean; busy: boolean; confirm: string; onClose: () => void; onSave: (amount: string | null) => void }) {
  const [amount, setAmount] = useState(initial);
  const [said, setSaid] = useState<string | null>(null);
  const save = () => {
    if (amount.trim() === "") {
      if (allowEmpty) onSave(null);
      else setSaid("Type the amount: dollars and cents above $0.00, like 75.00.");
      return;
    }
    const cents = readAmountCents(amount);
    if (cents === null) {
      setSaid("Type the amount: dollars and cents above $0.00, like 75.00.");
      return;
    }
    onSave(amountField(cents));
  };
  return (
    <Dialog
      title={title}
      onClose={onClose}
      actions={
        <>
          <button type="button" className={`${ed.btn} ${ed.btnGhost}`} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className={`${ed.btn} ${ed.btnPrimary}`} onClick={save} disabled={busy}>
            {busy ? "Saving…" : confirm}
          </button>
        </>
      }
    >
      <div className={styles.dialogBody}>
        <p className={styles.muted}>{words}</p>
        <label className={styles.dialogField}>
          <span className={styles.dialogLabel}>Amount ($)</span>
          <input
            className={styles.amountInput}
            inputMode="decimal"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              setSaid(null);
            }}
            onKeyDown={(e) => e.key === "Enter" && save()}
            disabled={busy}
            aria-label="Amount"
          />
        </label>
        {said && (
          <p className={styles.warn} role="alert">
            {said}
          </p>
        )}
      </div>
    </Dialog>
  );
}
