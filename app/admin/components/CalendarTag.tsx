"use client";

/**
 * "Calendars read <time>" with a Refresh button, on every admin page (Kian's rulings of 2026-10-17, admin home): in
 * the left column, above the admin's name. Refresh reads every calendar and makes the jobs, the existing refresh with
 * its one-run-at-a-time rule. The time is the last copy's, aged by the server's clock: plain up to 24 hours, amber
 * past 24, red past 48, red when no calendar has ever been read.
 *
 * Below 1440 px the navigation is icons only (Kian's ruling of 2026-10-17, after his review): the tag shows its time
 * (or its day, when not today) and a Refresh icon, the whole sentence in its tooltip.
 *
 * While a run holds the lease (a first-visit refresh, another admin's press), the tag says so and looks again every
 * 15 seconds until it ends. A press while one runs is answered by the server: nothing else starts, and the tag says
 * it is already being read.
 */

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { fetchCalendarStatus, refreshCalendarsNow, useCalendarsRefreshed, useCalendarsRefreshing, type CalendarStatus } from "@/app/lib/calendar-refresh-client";
import styles from "./CalendarTag.module.css";

/** Amber past this many hours, red past the second (Kian's ruling). */
export const AMBER_AFTER_HOURS = 24;
export const RED_AFTER_HOURS = 48;
const HOUR_MS = 3_600_000;
const POLL_MS = 15_000;
const POLLS_MAX = 24;

export type TagTone = "plain" | "amber" | "red";

/** The tag's tone, from the copy's age in hours; null (never read) is red. */
export function tagTone(ageHours: number | null): TagTone {
  if (ageHours === null || !Number.isFinite(ageHours)) return "red";
  return ageHours > RED_AFTER_HOURS ? "red" : ageHours > AMBER_AFTER_HOURS ? "amber" : "plain";
}

const torontoDayOf = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));

/** "09:14" on the day it is now in Toronto, "Oct 15, 09:14" before it; short: "09:14", or "Oct 15" alone. */
function readTime(iso: string, nowMs: number): { full: string; short: string } {
  const at = Date.parse(iso);
  const clock = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(at));
  if (torontoDayOf(at) === torontoDayOf(nowMs)) return { full: clock, short: clock };
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", month: "short", day: "numeric" }).format(new Date(at));
  return { full: `${day}, ${clock}`, short: day };
}

const ago = (hours: number) => (hours < 1 ? "under an hour ago" : hours < 48 ? `${Math.floor(hours)} h ago` : `${Math.floor(hours / 24)} days ago`);

type Held = { kind: "loading" } | { kind: "ready"; data: CalendarStatus; at: number } | { kind: "error"; title: string };

export function CalendarTag() {
  const [held, setHeld] = useState<Held>({ kind: "loading" });
  const [said, setSaid] = useState<{ text: string; title: string } | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [polls, setPolls] = useState(0);
  const refreshing = useCalendarsRefreshing();

  const take = useCallback((result: Awaited<ReturnType<typeof fetchCalendarStatus>>) => {
    setHeld(result.ok ? { kind: "ready", data: result.data, at: Date.now() } : { kind: "error", title: result.title });
    setNowMs(Date.now());
  }, []);
  const load = useCallback(() => fetchCalendarStatus().then(take), [take]);

  useEffect(() => {
    let cancelled = false;
    fetchCalendarStatus().then((result) => {
      if (!cancelled) take(result);
    });
    const timer = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [take]);

  // A run another trigger started: look again until it ends.
  const runningElsewhere = held.kind === "ready" && held.data.running !== null && !refreshing;
  useEffect(() => {
    if (!runningElsewhere || polls >= POLLS_MAX) return;
    const timer = setTimeout(() => {
      setPolls((n) => n + 1);
      void load();
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [runningElsewhere, polls, load]);

  // Every refresh this page makes, from here or from a page's own control.
  useCalendarsRefreshed((outcome) => {
    if (outcome.ok) {
      const { snapshot, now } = outcome.data.availability;
      setHeld({ kind: "ready", data: { refreshedAt: snapshot?.refreshedAt ?? null, fetched: snapshot?.run.fetched ?? 0, failed: snapshot?.run.failed.length ?? 0, running: null, now }, at: Date.now() });
      setNowMs(Date.now());
      setSaid(outcome.data.jobs.failed ? { text: "Jobs not all made", title: `The calendars were read, but the job sync stopped (code ${outcome.data.jobs.failed}). Refresh again.` } : null);
    } else if (outcome.code === "REFRESH_RUNNING") {
      setSaid({ text: "Already being read", title: outcome.title });
      setPolls(0);
      void load();
    } else {
      setSaid({ text: outcome.unknown ? "May not have run" : "Could not refresh", title: [outcome.title, outcome.detail].filter(Boolean).join(" ") });
    }
  });

  const busy = refreshing || runningElsewhere;
  let text: string;
  /** What the icons-only navigation shows (below 1440 px): the time, or the day. */
  let short: string;
  let tone: TagTone = "plain";
  let title: string;
  if (held.kind === "loading") {
    text = "Calendars read …";
    short = "…";
    title = "Loading when the calendars were read";
  } else if (held.kind === "error") {
    text = "Calendars read —";
    short = "—";
    title = held.title;
  } else if (held.data.refreshedAt === null) {
    text = "Calendars never read";
    short = "Never";
    tone = "red";
    title = "No calendar has been read yet";
  } else {
    const serverNow = Date.parse(held.data.now) + Math.max(0, nowMs - held.at);
    const hours = (serverNow - Date.parse(held.data.refreshedAt)) / HOUR_MS;
    const read = readTime(held.data.refreshedAt, serverNow);
    tone = tagTone(hours);
    text = `Calendars read ${read.full}`;
    short = read.short;
    title = `${ago(hours)} · ${held.data.fetched} read${held.data.failed > 0 ? ` · ${held.data.failed} could not be` : ""}`;
  }
  if (busy) {
    text = "Reading calendars…";
    short = "…";
  }

  return (
    <div className={`${styles.tag} ${tone === "amber" ? styles.amber : tone === "red" ? styles.red : ""}`} data-tone={tone} role="status" aria-live="polite">
      <span className={styles.text} title={`${text} · ${title}`}>
        <span className={styles.dot} aria-hidden />
        <span className={styles.full}>{text}</span>
        <span className={styles.short} aria-hidden>
          {short}
        </span>
      </span>
      <span className={styles.row}>
        <button type="button" className={styles.refresh} onClick={() => void refreshCalendarsNow()} disabled={busy} aria-busy={busy || undefined} aria-label="Refresh calendars" title={said ? `${said.text}: ${said.title}` : "Read every calendar now and make the jobs"}>
          <RefreshCw size={12} aria-hidden className={busy ? styles.spin : undefined} />
          <span className={styles.refreshWord}>Refresh</span>
        </button>
        {said && (
          <span className={styles.said} title={said.title}>
            {said.text}
          </span>
        )}
      </span>
    </div>
  );
}
