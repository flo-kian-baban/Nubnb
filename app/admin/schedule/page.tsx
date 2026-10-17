"use client";

/**
 * Schedule (the cleaning schedule, phase 1, Kian's rulings of 2026-10-14): each property's turnover, made two days
 * before an Airbnb reservation's checkout from the calendar copy, who is on it, and whether it is done.
 *
 * One block per checkout day, a row per job: the property, its checkout time and whether the next guest arrives the
 * same day, the cleaners on it (a tick once each has marked it cleaned), and its state in one badge — Needs a
 * cleaner, Assigned, 1 of 2 done, Done, Removed by the office, or Booking changed. Assign opens Nubnb's own picker:
 * only active cleaners, never handymen (ruling 2); a cleaner who marked the job stays on it. A job whose booking moved
 * offers its cleaners to the job at the new checkout in one click, when that job is on the page; nothing is carried
 * over by itself.
 *
 * A mark whose cleaning the office deleted or removed stays, "removed by the office", and that cleaner cannot mark the
 * job again; Reopen, beside their name, lets them, after Nubnb's own question (Kian's ruling of 2026-10-14, night).
 *
 * Refresh calendars fetches every calendar, writes the copy and makes and watches the jobs from it; so does the day's
 * first admin page or cleaner app, in the background (Kian's ruling of 2026-10-14, night: no scheduled job). One
 * refresh runs at a time: pressed during one, it says so and starts nothing. The line under the toolbar says when the
 * calendars were last read, in amber past 24 hours, and names any calendar the last run could not read.
 *
 * No home tile: the home's four tiles are fixed (Kian's ruling of 2026-10-02). Every control is Nubnb's own (Kian's
 * ruling of 2026-10-10).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Check, RefreshCw, RotateCcw, UserPlus, Users } from "lucide-react";
import { refreshCalendarsNow, useCalendarsRefreshed, useCalendarsRefreshing } from "@/app/lib/calendar-refresh-client";
import { AdminHeader } from "../components/AdminHeader";
import { PageHead } from "../components/PageHead";
import { AdminSelect } from "../components/AdminSelect";
import { useAsk } from "../components/AskDialog";
import { DateRangeField, type DatePreset } from "../components/DateRangeField";
import { PinGate } from "../components/PinGate";
import { NoticeBanner, useNotice } from "../components/Notice";
import { Dialog, Tick } from "../property/editor/controls";
import ed from "../property/editor/editor.module.css";
import shared from "../page.module.css";
import styles from "./page.module.css";
import { fetchSchedule, mergeJob, reopenJobFor, setJobCleaners, type ScheduleAnswer } from "@/app/lib/schedule-client";
import { addDays, dayText, isDay, minutesBetween } from "@/app/lib/availability/days";
import { changeWords, isSameDay, type AssigneeView, type JobView, type TeamMember } from "@/app/lib/schedule/model";

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

/** A booking that changed after a cleaner had marked the job: their cleaning stays, for an admin to decide (Kian's answer of 2026-10-14). */
const changedAfterMark = (job: JobView) => !!job.change && job.assignees.some((a) => a.markedAt !== null && a.markedAt <= (job.change?.at ?? ""));

/** A mark whose cleaning the office deleted or removed: it stays, and that cleaner cannot mark the job again until it is reopened. */
const isRemoved = (a: AssigneeView) => a.removedAt !== null;
/** Who a removed mark can be reopened for: an active cleaner, on a job whose booking is unchanged. */
const canReopen = (job: JobView, a: AssigneeView) => job.status === "open" && isRemoved(a) && a.state === "found" && a.status === "active";

/** A job's state, once: what the badge says. */
function stateOf(job: JobView): { label: string; tone: "needs" | "assigned" | "partial" | "done" | "removed" | "changed" } {
  if (job.status === "booking-changed") return { label: `Booking changed · ${changeWords(job.change)}${changedAfterMark(job) ? " after it was marked" : ""}`, tone: "changed" };
  if (job.cleanerIds.length === 0) return { label: "Needs a cleaner", tone: "needs" };
  if (job.assignees.some(isRemoved)) return { label: "Removed by the office", tone: "removed" };
  const marked = job.assignees.filter((a) => a.cleaningId !== null).length;
  if (marked === 0) return { label: "Assigned", tone: "assigned" };
  if (marked < job.cleanerIds.length) return { label: `${marked} of ${job.cleanerIds.length} done`, tone: "partial" };
  return { label: "Done", tone: "done" };
}

/**
 * What a link asks for (the property list's Cleaning cell, Kian's rulings of 2026-10-15): `?property=` picks the
 * property, and `?from=`, a day, reads from it to the furthest job instead of from a week back.
 */
function linkFromUrl(): { property: string; from: string | undefined } {
  const params = typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search);
  const from = params.get("from");
  return { property: params.get("property") ?? "", from: isDay(from) ? from : undefined };
}

function Schedule() {
  const [link] = useState(linkFromUrl);
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [propertyId, setPropertyId] = useState(link.property);
  const [cleanerId, setCleanerId] = useState("");
  const [needsOnly, setNeedsOnly] = useState(false);
  const refreshing = useCalendarsRefreshing();
  const [assigning, setAssigning] = useState<{ job: JobView; picked: string[] } | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const { notice, show, clear } = useNotice();
  const { ask, dialog } = useAsk();

  /** What a read answered: the page's jobs, or why there are none to show. */
  const take = useCallback((result: Awaited<ReturnType<typeof fetchSchedule>>) => {
    if (!result.ok) {
      setLoaded({ kind: "error", title: result.title, detail: result.detail, status: result.status });
      return;
    }
    setLoaded({ kind: "ready", answer: result.data });
    setRange({ from: result.data.from, to: result.data.to });
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

  const team = useMemo(() => answer?.team ?? [], [answer]);
  const active = useMemo(() => team.filter((member) => member.role === "cleaner" && member.status === "active"), [team]);

  const saveAssign = async () => {
    if (!assigning || saving) return;
    const { job, picked } = assigning;
    setSaving(job.id);
    const result = await setJobCleaners(job.id, picked, job.history.length);
    setSaving(null);
    if (!result.ok) {
      show(result.unknown ? { tone: "warning", title: "Who is on the job may or may not have been saved. Reload to see.", detail: result.title } : { tone: "error", title: result.title, detail: result.detail });
      return;
    }
    setAssigning(null);
    replaceJob(mergeJob(job, result.data.job, team));
    if (result.data.changed) show({ tone: "success", title: `Saved who is on ${job.property.name ?? "the job"} · ${dayText(job.checkout)}.` });
  };

  /** A moved booking's cleaners, put on the job at its new checkout: one click, the admin's (ruling 2). */
  const sameCleanersTo = async (from: JobView, target: JobView) => {
    if (saving) return;
    const wanted = [...new Set([...target.cleanerIds, ...from.cleanerIds.filter((cid) => active.some((member) => member.id === cid))])];
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

  const propertyGroups = useMemo(() => {
    if (!answer) return [];
    const names = new Map(answer.jobs.map((job) => [job.propertyId, job.property.name ?? job.propertyNameAtCreation ?? job.propertyId]));
    // A property a link asked for with no job in these days: named as such, so the filter never reads "All properties" while it is on.
    const linked = propertyId !== "" && !names.has(propertyId) ? [{ value: propertyId, label: "This property: no checkouts in these days" }] : [];
    return [{ options: [{ value: "", label: "All properties" }, ...linked, ...[...names].sort((a, b) => a[1].localeCompare(b[1], "en-CA")).map(([value, label]) => ({ value, label }))] }];
  }, [answer, propertyId]);
  const cleanerGroups = useMemo(() => [{ options: [{ value: "", label: "All cleaners" }, ...team.filter((member) => member.role === "cleaner").map((member) => ({ value: member.id, label: `${member.name ?? "Unnamed"}${member.status === "active" ? "" : " (deactivated)"}` }))] }], [team]);

  return (
    <div className={shared.container}>
      <AdminHeader current="schedule" />

      <main className={shared.main}>
        {/* Refresh calendars is the tag in the navigation, on every admin page (Kian's rulings of 2026-10-17). */}
        <PageHead title="Schedule" />

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

            <CopyLine answer={loaded.answer} onRefresh={refresh} refreshing={refreshing} />

            {byDay.length === 0 ? (
              <p className={styles.empty}>{loaded.answer.jobs.length === 0 ? "No checkouts in these days." : "No job matches."}</p>
            ) : (
              byDay.map(([day, jobs]) => (
                <section key={day} className={styles.day} aria-label={dayHeading(day)}>
                  <h2 className={styles.dayTitle}>
                    {dayHeading(day)}
                    {day === loaded.answer.today && <span className={styles.today}>Today</span>}
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
                            moveTarget={job.change?.kind === "moved" && job.change.movedTo ? (loaded.answer.jobs.find((other) => other.id === `${job.propertyId}_${job.change?.movedTo?.end}`) ?? null) : null}
                            saving={saving}
                            onAssign={() => setAssigning({ job, picked: [...job.cleanerIds] })}
                            onSameTo={sameCleanersTo}
                            onReopen={reopen}
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              ))
            )}
          </>
        )}
      </main>

      {assigning && (
        <AssignDialog
          job={assigning.job}
          picked={assigning.picked}
          active={active}
          team={team}
          othersThatDay={(cid) => (answer ? answer.jobs.filter((other) => other.checkout === assigning.job.checkout && other.id !== assigning.job.id && other.cleanerIds.includes(cid)).length : 0)}
          busy={saving === assigning.job.id}
          onToggle={(cid) => setAssigning((prev) => (prev ? { ...prev, picked: prev.picked.includes(cid) ? prev.picked.filter((x) => x !== cid) : [...prev.picked, cid] } : prev))}
          onClose={() => setAssigning(null)}
          onSave={saveAssign}
        />
      )}
      {dialog}
    </div>
  );
}

/** A copy older than this reads in amber (Kian's ruling of 2026-10-14, night). */
const STALE_AFTER_MINUTES = 24 * 60;

/** When the calendars were last read, in amber past 24 hours, and the calendars that run could not read: one line. */
function CopyLine({ answer, onRefresh, refreshing }: { answer: ScheduleAnswer; onRefresh: () => void; refreshing: boolean }) {
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
    <p className={`${styles.status} ${stale || failed.length > 0 ? styles.statusAlert : ""}`} role="status">
      <strong>Calendars read {clock(refreshedAt)}</strong>
      {stale && " · jobs for checkouts since then may be missing"}
      {failed.length > 0 && ` · ${plural(failed.length, "calendar", "calendars")} not read: ${failed.map((f) => f.name).join(", ")}`}
    </p>
  );
}

function JobRow(props: { job: JobView; moveTarget: JobView | null; saving: string | null; onAssign: () => void; onSameTo: (from: JobView, target: JobView) => void; onReopen: (job: JobView, a: AssigneeView) => void }) {
  const { job, moveTarget, saving, onAssign, onSameTo, onReopen } = props;
  const state = stateOf(job);
  const name = job.property.name ?? job.propertyNameAtCreation ?? "Unknown property";
  const unread = job.calendar.status === "failed";
  return (
    <tr>
      <td>
        <Link href={`/admin/property?id=${encodeURIComponent(job.propertyId)}`} prefetch={false} className={styles.property}>
          {name}
        </Link>
        {job.property.state === "missing" && <span className={styles.muted}> · deleted</span>}
        {unread && <span className={styles.warn}> · calendar not read since {job.calendar.failedSince ? clock(job.calendar.failedSince) : "the last run"}</span>}
      </td>
      <td className={styles.turnover}>
        <span>{job.property.checkOut ?? "Checkout"}</span>
        {isSameDay(job) ? (
          <span className={styles.sameDay} title={`The next guest checks in the same day${job.property.checkIn ? `, ${job.property.checkIn}` : ""}`}>
            Same day
          </span>
        ) : (
          <span className={styles.muted}>{job.nextCheckIn ? `next guest ${dayText(job.nextCheckIn)}` : "no next guest yet"}</span>
        )}
      </td>
      <td>
        {job.assignees.length === 0 ? (
          <span className={styles.muted}>—</span>
        ) : (
          <span className={styles.chips}>
            {job.assignees.map((a) => {
              const removed = isRemoved(a);
              const done = a.cleaningId !== null && !removed;
              const title = removed
                ? `Marked cleaned ${a.markedAt ? clock(a.markedAt) : ""}; removed by the office ${a.removedAt ? clock(a.removedAt) : ""}${a.removedBy?.name ? ` (${a.removedBy.name})` : ""}`
                : done
                  ? `Marked cleaned ${a.markedAt ? clock(a.markedAt) : ""}`
                  : `Assigned ${clock(a.assignedAt)}`;
              return (
                <span key={a.cleanerId} className={styles.chipLine}>
                  <span className={`${styles.chip} ${done ? styles.chipDone : ""} ${removed ? styles.chipRemoved : ""}`} title={title}>
                    {done && <Check size={12} aria-label="Marked cleaned" />}
                    {a.name ?? "Unnamed"}
                    {a.state === "missing" ? " (deleted)" : a.status && a.status !== "active" ? " (deactivated)" : ""}
                    {removed && <span className={styles.chipNote}> removed by the office</span>}
                    {done && a.cleaning && a.cleaning.status === "logged" && a.cleaning.amountCents === null && <span className={styles.chipNote}> no amount</span>}
                  </span>
                  {canReopen(job, a) && (
                    <button type="button" className={styles.chipAction} onClick={() => onReopen(job, a)} disabled={saving !== null} aria-label={`Reopen for ${a.name ?? "this cleaner"}`}>
                      <RotateCcw size={12} aria-hidden />
                      Reopen
                    </button>
                  )}
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
        {job.status === "open" ? (
          <button type="button" className={shared.btnGhost} onClick={onAssign} disabled={saving !== null}>
            <UserPlus size={14} aria-hidden />
            <span>{job.cleanerIds.length === 0 ? "Assign" : "Change"}</span>
          </button>
        ) : moveTarget && moveTarget.status === "open" && job.cleanerIds.some((cid) => !moveTarget.cleanerIds.includes(cid)) ? (
          <button type="button" className={shared.btnGhost} onClick={() => onSameTo(job, moveTarget)} disabled={saving !== null}>
            <span>Same cleaners to {dayText(moveTarget.checkout)}</span>
          </button>
        ) : null}
      </td>
    </tr>
  );
}

function AssignDialog(props: {
  job: JobView;
  picked: string[];
  active: TeamMember[];
  team: TeamMember[];
  othersThatDay: (cleanerId: string) => number;
  busy: boolean;
  onToggle: (cleanerId: string) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const { job, picked, active, team, othersThatDay, busy, onToggle, onClose, onSave } = props;
  // Active cleaners, and anyone already on the job who no longer is (they can be taken off, not put back).
  const onJob = job.assignees.filter((a) => !active.some((member) => member.id === a.cleanerId));
  const name = job.property.name ?? job.propertyNameAtCreation ?? "the property";
  return (
    <Dialog
      title={`Who cleans ${name} · ${dayText(job.checkout)}`}
      onClose={onClose}
      actions={
        <>
          <button type="button" className={`${ed.btn} ${ed.btnGhost}`} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className={`${ed.btn} ${ed.btnPrimary}`} onClick={onSave} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      {active.length === 0 && onJob.length === 0 ? (
        <p>No active cleaner. Add one on the Team page.</p>
      ) : (
        <ul className={styles.pickList}>
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
    </Dialog>
  );
}
