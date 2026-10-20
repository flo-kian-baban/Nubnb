"use client";

/**
 * Availability (dispatch 22, 2026-09-30): the answer for a caller, and the
 * list of what needs pushing.
 *
 * Two views on one page, mirrored into the URL (?view=search|attention):
 *
 *   Search    an admin types the caller's dates, party, city, bedrooms,
 *             type and budget, and gets what fits, then what nearly fits
 *             with the reason in the caller's words, then the year-blocked
 *             apart. Every row shows the nights asked for as a strip.
 *   Attention every property ranked by the empty nights it could sell at
 *             its listed minimum, times its nightly price (Kian's ruling),
 *             with the raw empty count beside it; the fully booked and the
 *             blocked-for-the-period listed apart, never hidden. One plain
 *             line at its top says what the list is and is not.
 *
 * The page never fetches a feed. It reads the stored copy once
 * (GET /api/admin/availability) and the property list once (the same
 * Firestore read the admin home makes), and every search and every ranking
 * is worked out here from those. "Refresh now" fetches every feed on the
 * server and hands back the new copy; the day's first admin page or cleaner
 * app does the same in the background (Kian's ruling of 2026-10-14, night:
 * no scheduled job), and while one refresh runs, the button starts nothing
 * and says so. Every screen says when the calendars were last read, and
 * turns amber past 24 hours or when a calendar could not be read.
 *
 * "Could not load" is never "nothing here": a failed read shows no results
 * and no ranking.
 *
 * ── Round 1 (the audit of 2026-10-19; Kian's rulings K1–K5) ──
 * - K1: a search row's stay total is nights × nightly + the cleaning fee,
 *   "before taxes", as one line ("2 nights × $99 + $100 cleaning = $298 before
 *   taxes"; "no cleaning fee set" when none), with a Copy control for that
 *   line. Each value is an admin-set price; the sum is the only arithmetic.
 * - K2: opening the page on a copy more than three hours old starts the same
 *   background refresh the Schedule starts (R1, the same lease); the page
 *   watches the run and shows its result when it ends.
 * - K3: "Not on Airbnb · checked Sep 30": each mark shows its check date.
 * - K4: a stay shorter than the listed minimum is a near miss, "minimum n
 *   nights", never a fit.
 * - K5: unlisted properties carry "Not on the site" in both views.
 * - A row whose calendar copy is older than the run, or failed, carries
 *   "calendar read <day, time>". The tables fit beside the navigation at 1440
 *   and 1280. Edit opens the property's edit page. The page reads the slice of
 *   each property it needs (GET /api/admin/availability/properties), not the
 *   whole admin list.
 */

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  AlertTriangle,
  BedDouble,
  Building2,
  CalendarSearch,
  Check,
  Copy,
  ExternalLink,
  MapPin,
  Pencil,
  RefreshCw,
  Search,
  Users,
} from "lucide-react";
import { AdminHeader } from "../components/AdminHeader";
import { PageHead } from "../components/PageHead";
import { AdminSelect } from "../components/AdminSelect";
import { DateRangeField } from "../components/DateRangeField";
import { PinGate } from "../components/PinGate";
import { NoticeBanner, useNotice } from "../components/Notice";
import { fetchAvailability, fetchAvailabilityProperties, type AvailabilityData } from "@/app/lib/availability-client";
import { refreshCalendarsNow, useCalendarRunWatched, useCalendarsRead, useCalendarsRefreshed, useCalendarsRefreshing, watchCalendarRun } from "@/app/lib/calendar-refresh-client";
import { rowMarks, type RowMark } from "@/app/lib/availability/marks";
import { addDays, dayText, isDay, rangeText, torontoDay, weekendStay } from "@/app/lib/availability/days";
import { BEDROOM_OPTIONS, isBedroomsFilter, searchProperties, stayLine } from "@/app/lib/availability/search";
import { HORIZONS, attentionList, freshness, isHorizon, type Horizon } from "@/app/lib/availability/attention";
import { HORIZON_DAYS, isReadable } from "@/app/lib/availability/snapshot";
import type {
  AttentionRow,
  AvailabilityProperty,
  AvailabilitySnapshot,
  BedroomsFilter,
  NightState,
  Reason,
  SearchQuery,
  SearchRow,
} from "@/app/lib/availability/types";
import shared from "../page.module.css";
import styles from "./page.module.css";

type View = "search" | "attention";

type Read<T> = { kind: "loading" } | { kind: "ready"; data: T } | { kind: "error"; title: string; detail?: string; status: number };

const GUEST_OPTIONS = [{ value: "", label: "Any guests" }, ...Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: `${i + 1} ${i === 0 ? "guest" : "guests"}` }))];

const dollars = (n: number) => `$${Math.round(n).toLocaleString("en-CA")}`;
const plural = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

/** When the calendars were last read, "Oct 14, 21:13", in Toronto time: the same words the Schedule uses. */
const readText = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));

/** How the last read began (Kian's ruling of 2026-10-14, night: no scheduled job). "hourly" is the never-deployed function's, kept for a copy it may have written. */
const SOURCE_WORDS: Record<AvailabilitySnapshot["run"]["source"], string> = { daily: "on the day's first visit", manual: "by hand", schedule: "hourly" };

/** "Tue 14:00", in Toronto time. */
const clockText = (iso: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso));

export default function AvailabilityPage() {
  return (
    <PinGate>
      {/* useSearchParams needs a boundary on a statically rendered page. */}
      <Suspense fallback={null}>
        <Availability />
      </Suspense>
    </PinGate>
  );
}

function Availability() {
  const params = useSearchParams();
  const { notice, show: showNotice, clear: dismissNotice } = useNotice();

  const [data, setData] = useState<Read<AvailabilityData>>({ kind: "loading" });
  const [loadedAt, setLoadedAt] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const refreshing = useCalendarsRefreshing();
  // Each property as availability reads it, named as the admin names it (Kian's rulings of 2026-10-15, evening).
  const [properties, setProperties] = useState<Read<AvailabilityProperty[]>>({ kind: "loading" });
  // The browser clock, read on load and once a minute, so the copy's age moves on while the page is open.
  const [nowMs, setNowMs] = useState(0);

  // ── What the address bar says ──
  const [view, setView] = useState<View>(() => (params.get("view") === "attention" ? "attention" : "search"));
  const [checkIn, setCheckIn] = useState(() => (isDay(params.get("in")) ? params.get("in")! : ""));
  const [checkOut, setCheckOut] = useState(() => (isDay(params.get("out")) ? params.get("out")! : ""));
  const [guests, setGuests] = useState(() => (/^([1-9]|1[0-2])$/.test(params.get("guests") ?? "") ? params.get("guests")! : ""));
  const [city, setCity] = useState(() => params.get("city") ?? "");
  const [bedrooms, setBedrooms] = useState<BedroomsFilter>(() => (isBedroomsFilter(params.get("beds")) ? (params.get("beds") as BedroomsFilter) : "any"));
  const [type, setType] = useState(() => params.get("type") ?? "");
  const [maxNightly, setMaxNightly] = useState(() => (/^\d{1,5}$/.test(params.get("max") ?? "") ? params.get("max")! : ""));
  const [query, setQuery] = useState(() => params.get("q") ?? "");
  const [horizon, setHorizon] = useState<Horizon>(() => (isHorizon(params.get("horizon")) ? (Number(params.get("horizon")) as Horizon) : 30));
  const [hideGone, setHideGone] = useState(() => params.get("gone") === "hide");

  useEffect(() => {
    let cancelled = false;
    fetchAvailability().then((result) => {
      if (cancelled) return;
      const at = Date.now();
      setLoadedAt(at);
      setNowMs(at);
      setData(result.ok ? { kind: "ready", data: result.data } : { kind: "error", title: result.title, detail: result.detail, status: result.status });
      // Opened on a stale copy (Kian's ruling K2): the server started the refresh after its answer, or one is under way;
      // watch it to its end and show what it read.
      if (result.ok && result.data.refresh) void watchCalendarRun(result.data.snapshot?.refreshedAt ?? null);
    });
    // The slice of each property this page needs (round 1), not the whole admin list.
    fetchAvailabilityProperties().then((result) => {
      if (cancelled) return;
      setProperties(result.ok ? { kind: "ready", data: result.data } : { kind: "error", title: result.title, detail: result.detail, status: result.status });
    });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  // A watched run ended (K2): read the copy again and say so; the results then show what it read.
  const watched = useCalendarRunWatched();
  useCalendarsRead(async (status) => {
    if (data.kind === "ready" && status.refreshedAt === data.data.snapshot?.refreshedAt) return;
    const again = await fetchAvailability();
    if (!again.ok) {
      showNotice({ tone: "warning", title: "The calendars were read, but the new copy could not be loaded. Press Refresh to try again.", detail: again.title });
      return;
    }
    const at = Date.now();
    setLoadedAt(at);
    setNowMs(at);
    setData({ kind: "ready", data: again.data });
    showNotice({ tone: "success", title: `Calendars read ${status.refreshedAt ? readText(status.refreshedAt) : "just now"}. The results show them.` });
  });

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  // Mirror everything into the address bar, so a reload or a shared link keeps the call's question.
  useEffect(() => {
    const url = new URL(window.location.href);
    const set = (key: string, value: string | null) => (value === null || value === "" ? url.searchParams.delete(key) : url.searchParams.set(key, value));
    set("view", view === "attention" ? "attention" : null);
    set("in", checkIn);
    set("out", checkOut);
    set("guests", guests);
    set("city", city);
    set("beds", bedrooms === "any" ? null : bedrooms);
    set("type", type);
    set("max", maxNightly);
    set("q", query);
    set("horizon", horizon === 30 ? null : String(horizon));
    set("gone", hideGone ? "hide" : null);
    if (url.href !== window.location.href) window.history.replaceState(null, "", url.href);
  }, [view, checkIn, checkOut, guests, city, bedrooms, type, maxNightly, query, horizon, hideGone]);

  const reload = () => {
    setData({ kind: "loading" });
    setProperties({ kind: "loading" });
    setAttempt((n) => n + 1);
  };

  // Refresh is the tag's in the navigation (Kian's rulings of 2026-10-17: on every admin page), one at a time; this
  // page takes the copy each refresh answers, from whichever control pressed it, and says what it read.
  const refreshNow = () => void refreshCalendarsNow();
  useCalendarsRefreshed((result) => {
    if (result.ok) {
      const at = Date.now();
      setLoadedAt(at);
      setNowMs(at);
      setData({ kind: "ready", data: result.data.availability });
      const { run } = result.data.availability.snapshot ?? { run: null };
      showNotice({
        tone: run && run.failed.length > 0 ? "warning" : "success",
        title: run ? `Every calendar fetched: ${run.fetched} read${run.failed.length ? `, ${run.failed.length} could not be` : ""}.` : "Refreshed.",
        detail: run && run.failed.length > 0 ? `Could not be read: ${run.failed.map((f) => f.name).join(", ")}. Their last good read is shown.` : undefined,
      });
    } else {
      showNotice({ tone: result.code === "REFRESH_RUNNING" ? "info" : "error", title: result.title, detail: result.detail });
    }
  });

  // ── What everything is worked out from ──
  const snapshot: AvailabilitySnapshot | null = data.kind === "ready" ? data.data.snapshot : null;
  const history = data.kind === "ready" ? data.data.history : null;
  const today = data.kind === "ready" && data.data.today ? data.data.today : torontoDay();
  // The server's clock, moved on by the time this page has been open.
  const nowIso = data.kind === "ready" ? new Date(Date.parse(data.data.now) + Math.max(0, nowMs - loadedAt)).toISOString() : data.kind === "loading" ? "" : "";

  const availProps: AvailabilityProperty[] = useMemo(
    () => (properties.kind === "ready" ? properties.data : []),
    [properties],
  );
  const inScope = useMemo(
    () => availProps.filter((p) => (city === "" || p.city === city) && (type === "" || p.type === type)),
    [availProps, city, type],
  );

  const searchQuery: SearchQuery = useMemo(
    () => ({
      checkIn: checkIn && checkOut && checkIn < checkOut ? checkIn : "",
      checkOut: checkIn && checkOut && checkIn < checkOut ? checkOut : "",
      guests: guests ? Number(guests) : null,
      city: city || null,
      bedrooms,
      type: type || null,
      maxNightly: maxNightly ? Number(maxNightly) : null,
      text: query,
    }),
    [checkIn, checkOut, guests, city, bedrooms, type, maxNightly, query],
  );
  const search = useMemo(() => searchProperties(snapshot, availProps, searchQuery, today), [snapshot, availProps, searchQuery, today]);
  const attention = useMemo(() => attentionList(snapshot, inScope, horizon, today, history), [snapshot, inScope, horizon, today, history]);
  const fresh = snapshot ? freshness(snapshot, nowIso) : null;

  const counts = useMemo(() => {
    const cities = new Map<string, number>();
    const types = new Map<string, number>();
    for (const p of availProps) {
      cities.set(p.city, (cities.get(p.city) ?? 0) + 1);
      types.set(p.type, (types.get(p.type) ?? 0) + 1);
    }
    const sorted = (m: Map<string, number>) => [...m.entries()].filter(([k]) => k).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return { cities: sorted(cities), types: sorted(types) };
  }, [availProps]);

  const anyPageCheck = useMemo(() => !!snapshot && Object.values(snapshot.properties).some((p) => p.airbnbPage), [snapshot]);
  const withFeed = snapshot ? Object.values(snapshot.properties).filter((p) => p.status !== "no-feed").length : 0;

  const thisWeekend = weekendStay(today);
  const nextWeekend = weekendStay(addDays(thisWeekend.checkOut, 1));
  const presets = [
    { key: "tonight", label: "Tonight", from: today, to: addDays(today, 1) },
    { key: "weekend", label: "This weekend", from: thisWeekend.checkIn, to: thisWeekend.checkOut },
    { key: "next-weekend", label: "Next weekend", from: nextWeekend.checkIn, to: nextWeekend.checkOut },
    { key: "week", label: "Next 7 nights", from: today, to: addDays(today, 7) },
    { key: "month", label: "Next 30 nights", from: today, to: addDays(today, 30) },
  ];

  const loading = data.kind === "loading" || properties.kind === "loading";
  const error = data.kind === "error" ? data : properties.kind === "error" ? properties : null;

  return (
    <div className={shared.container}>
      <AdminHeader current="availability" />

      <main className={shared.main}>
        {/* Refresh is the tag in the navigation, on every admin page (Kian's rulings of 2026-10-17). */}
        <PageHead title="Availability" />

        {notice && <NoticeBanner notice={notice} onDismiss={dismissNotice} className={shared.pageNotice} />}

        {loading ? (
          <div className={shared.loading}>
            <div className={shared.spinner} />
            <p>Loading availability…</p>
          </div>
        ) : error ? (
          /* A failed read is NOT an empty catalogue. */
          <div className={`${shared.empty} ${shared.loadError}`} role="alert">
            <AlertTriangle size={48} strokeWidth={1} />
            <h2>Could not load availability</h2>
            <p>
              {data.kind === "error" ? "The stored copy of the calendars" : "The property list"} could not be read, so this page cannot search or
              rank anything. Nothing here is empty; it has not loaded.
              {(error.status === 401 || error.status === 403) && " Your admin session may have expired: reload and sign in again."}
            </p>
            <code className={shared.loadErrorDetail}>
              {error.title}
              {"detail" in error && error.detail ? ` ${error.detail}` : ""}
            </code>
            <button type="button" className={shared.btnPrimary} onClick={reload}>
              <RefreshCw size={18} />
              <span>Retry</span>
            </button>
          </div>
        ) : (
          <>
            <div className={styles.tabs} role="tablist" aria-label="Availability views">
              <button type="button" role="tab" aria-selected={view === "search"} className={`${styles.tab} ${view === "search" ? styles.tabActive : ""}`} onClick={() => setView("search")}>
                Search
              </button>
              <button type="button" role="tab" aria-selected={view === "attention"} className={`${styles.tab} ${view === "attention" ? styles.tabActive : ""}`} onClick={() => setView("attention")}>
                Needs pushing{attention.ranked.length ? ` (${attention.ranked.length})` : ""}
              </button>
            </div>

            <StatusLine snapshot={snapshot} fresh={fresh} withFeed={withFeed} onRefresh={refreshNow} refreshing={refreshing} reading={watched} />

            {view === "search" ? (
              <SearchView
                snapshot={snapshot}
                result={search}
                query={searchQuery}
                today={today}
                presets={presets}
                counts={counts}
                controls={{ checkIn, checkOut, guests, city, bedrooms, type, maxNightly, query }}
                set={{ setCheckIn, setCheckOut, setGuests, setCity, setBedrooms, setType, setMaxNightly, setQuery }}
              />
            ) : (
              <AttentionView
                snapshot={snapshot}
                result={attention}
                horizon={horizon}
                setHorizon={setHorizon}
                city={city}
                setCity={setCity}
                type={type}
                setType={setType}
                counts={counts}
                hideGone={hideGone}
                setHideGone={setHideGone}
                anyPageCheck={anyPageCheck}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
}

// ─── How old the copy is ────────────────────────────────────────

function StatusLine({
  snapshot,
  fresh,
  withFeed,
  onRefresh,
  refreshing,
  reading,
}: {
  snapshot: AvailabilitySnapshot | null;
  fresh: ReturnType<typeof freshness> | null;
  withFeed: number;
  onRefresh: () => void;
  refreshing: boolean;
  /** A run started on open (K2) is being watched: its result replaces what is shown when it ends. */
  reading: boolean;
}) {
  if (!snapshot || !fresh) {
    return (
      <p className={`${styles.status} ${styles.statusAlert}`} role="status">
        <strong>No refresh has run yet.</strong> Nothing can be searched until the calendars are fetched.{" "}
        <button type="button" className={styles.statusLink} onClick={onRefresh} disabled={refreshing}>
          Refresh now
        </button>
      </p>
    );
  }
  const { run } = snapshot;
  const alert = fresh.stale || fresh.failed > 0;
  return (
    <p className={`${styles.status} ${alert ? styles.statusAlert : ""}`} role="status">
      <strong>Calendars read {readText(snapshot.refreshedAt)}</strong> · {SOURCE_WORDS[run.source]} · {run.fetched} of {withFeed} calendars read
      {run.failed.length > 0 && (
        <>
          {" "}
          · {plural(run.failed.length, "calendar", "calendars")} could not be read at {clockText(run.finishedAt)}: {run.failed.map((f) => f.name).join(", ")}; showing what was
          last read
        </>
      )}
      {snapshot.run.pagesChecked > 0 && <> · Airbnb pages checked</>}
      {reading ? (
        <>
          {" "}
          · <span className={styles.statusReading}>Reading the calendars now; the results change when they are read.</span>
        </>
      ) : (
        alert && (
          <>
            {" "}
            <button type="button" className={styles.statusLink} onClick={onRefresh} disabled={refreshing}>
              Refresh now
            </button>
          </>
        )
      )}
    </p>
  );
}

// ─── The search ─────────────────────────────────────────────────

interface Controls {
  checkIn: string;
  checkOut: string;
  guests: string;
  city: string;
  bedrooms: BedroomsFilter;
  type: string;
  maxNightly: string;
  query: string;
}

function SearchView({
  snapshot,
  result,
  query,
  today,
  presets,
  counts,
  controls,
  set,
}: {
  snapshot: AvailabilitySnapshot | null;
  result: ReturnType<typeof searchProperties>;
  query: SearchQuery;
  today: string;
  presets: { key: string; label: string; from: string; to: string }[];
  counts: { cities: [string, number][]; types: [string, number][] };
  controls: Controls;
  set: {
    setCheckIn: (v: string) => void;
    setCheckOut: (v: string) => void;
    setGuests: (v: string) => void;
    setCity: (v: string) => void;
    setBedrooms: (v: BedroomsFilter) => void;
    setType: (v: string) => void;
    setMaxNightly: (v: string) => void;
    setQuery: (v: string) => void;
  };
}) {
  const hasDates = !!(query.checkIn && query.checkOut);
  const shown = result.fits.length + result.near.length;
  const asked = [
    hasDates ? rangeText(query.checkIn, query.checkOut) : null,
    query.guests !== null ? plural(query.guests, "guest", "guests") : null,
    query.city,
    query.bedrooms !== "any" ? BEDROOM_OPTIONS.find((o) => o.value === query.bedrooms)?.label.toLowerCase() : null,
    query.type ? query.type.toLowerCase() : null,
    query.maxNightly !== null ? `up to $${query.maxNightly} a night` : null,
  ]
    .filter(Boolean)
    .join(", ");
  const runAt = snapshot?.refreshedAt ?? null;

  return (
    <>
      <section className={shared.toolbar} aria-label="What the caller wants">
        <div className={shared.toolbarRow}>
          <DateRangeField
            label="Dates"
            from={controls.checkIn}
            to={controls.checkOut}
            min={today}
            max={addDays(today, HORIZON_DAYS)}
            emptyText="Any dates"
            presets={presets}
            onChange={(range) => {
              set.setCheckIn(range.from);
              set.setCheckOut(range.to);
            }}
            note="Check-in to check-out. Nights are Toronto days; no calendar speaks past twelve months."
          />
          <AdminSelect label="Guests" icon={<Users size={14} />} value={controls.guests} onChange={set.setGuests} groups={[{ options: GUEST_OPTIONS }]} />
          <AdminSelect
            label="City"
            icon={<MapPin size={14} />}
            value={controls.city}
            onChange={set.setCity}
            groups={[{ options: [{ value: "", label: "All cities" }, ...counts.cities.map(([c, n]) => ({ value: c, label: `${c} (${n})` }))] }]}
          />
          <AdminSelect
            label="Bedrooms"
            icon={<BedDouble size={14} />}
            value={controls.bedrooms}
            onChange={(v) => set.setBedrooms(isBedroomsFilter(v) ? v : "any")}
            groups={[{ options: BEDROOM_OPTIONS.map((o) => ({ value: o.value, label: o.label })) }]}
          />
          <AdminSelect
            label="Type"
            icon={<Building2 size={14} />}
            value={controls.type}
            onChange={set.setType}
            groups={[{ options: [{ value: "", label: "All types" }, ...counts.types.map(([t, n]) => ({ value: t, label: `${t} (${n})` }))] }]}
          />
          <label className={styles.money}>
            <span className={styles.moneySign} aria-hidden>
              $
            </span>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              step={10}
              className={styles.moneyInput}
              placeholder="Up to, a night"
              aria-label="Nightly price, at most"
              value={controls.maxNightly}
              onChange={(e) => set.setMaxNightly(e.target.value.replace(/[^\d]/g, "").slice(0, 5))}
            />
          </label>
        </div>
        <div className={shared.toolbarRow}>
          <div className={shared.searchWrapper}>
            <Search size={16} className={shared.searchIcon} aria-hidden />
            <input
              type="search"
              className={shared.searchInput}
              placeholder="Search by name, area or what it offers (hot tub, parking)"
              aria-label="Search by name, area or what the property offers"
              value={controls.query}
              onChange={(e) => set.setQuery(e.target.value)}
            />
          </div>
          <span className={shared.resultCount}>
            {result.fits.length} {result.fits.length === 1 ? "fit" : "fits"} · {result.near.length} near
          </span>
          {hasDates && (
            <span className={styles.legend} aria-hidden>
              <span>
                <i className={`${styles.night} ${styles.nightOpen}`} />
                open
              </span>
              <span>
                <i className={`${styles.night} ${styles.nightReserved}`} />
                booked
              </span>
              <span>
                <i className={`${styles.night} ${styles.nightBlocked}`} />
                blocked
              </span>
            </span>
          )}
        </div>
      </section>

      {!snapshot ? (
        <div className={shared.empty}>
          <CalendarSearch size={48} strokeWidth={1} />
          <h2>Nothing to search yet</h2>
          <p>No refresh has run. Press Refresh now to fetch every calendar.</p>
        </div>
      ) : (
        <>
          {result.beyondWindow.length > 0 && (
            <p className={`${styles.note} ${styles.noteWarn}`}>
              {plural(result.beyondWindow.length, "property does", "properties do")} not open {result.beyondWindow.length === 1 ? "its" : "their"} calendar that
              far ahead and {result.beyondWindow.length === 1 ? "is" : "are"} not listed: {result.beyondWindow.map((p) => p.name).join(", ")}.
            </p>
          )}
          {result.unread.length > 0 && (
            <p className={`${styles.note} ${styles.noteWarn}`}>
              {plural(result.unread.length, "calendar has", "calendars have")} never been read and cannot answer: {result.unread.map((p) => p.name).join(", ")}.
            </p>
          )}

          <ResultGroup title="Fits" count={result.fits.length} fit hint={hasDates ? "every night open, and everything asked for" : "everything asked for"}>
            {result.fits.length === 0 ? (
              <p className={styles.groupEmpty}>Nothing fits exactly{asked ? ` (${asked})` : ""}.</p>
            ) : (
              <SearchTable rows={result.fits} hasDates={hasDates} nights={result.nights} runAt={runAt} />
            )}
          </ResultGroup>

          {(result.near.length > 0 || result.fits.length === 0) && (
            <ResultGroup
              title="Near misses"
              count={result.near.length}
              hint="at most two things off: dates within three days, up to two guests short, up to a quarter over budget, another city or type, or a stay under the listed minimum"
            >
              {result.near.length === 0 ? (
                shown === 0 && hasDates ? (
                  <div className={styles.groupEmpty}>
                    <p>
                      Nothing comes close{asked ? ` for ${asked}` : ""}.
                      {result.closest.length > 0 && " Closest:"}
                    </p>
                    {result.closest.length > 0 && (
                      <ul>
                        {result.closest.map((c) => (
                          <li key={c.property.id}>
                            {c.property.name}: {c.text} ({dollars(c.property.nightly)} a night, sleeps {c.property.guests})
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : (
                  <p className={styles.groupEmpty}>Nothing nearly fits either.</p>
                )
              ) : (
                <SearchTable rows={result.near} hasDates={hasDates} nights={result.nights} runAt={runAt} />
              )}
            </ResultGroup>
          )}

          {result.yearBlocked.length > 0 && (
            <details className={styles.folded}>
              <summary>Blocked for the whole year ({result.yearBlocked.length})</summary>
              <SearchTable rows={result.yearBlocked} hasDates={hasDates} nights={result.nights} runAt={runAt} />
            </details>
          )}
        </>
      )}
    </>
  );
}

function ResultGroup({ title, count, fit, hint, children }: { title: string; count: number; fit?: boolean; hint?: string; children: React.ReactNode }) {
  return (
    <section className={styles.group} aria-label={title}>
      <div className={styles.groupHead}>
        <h2 className={`${styles.groupTitle} ${fit ? styles.groupTitleFit : ""}`}>{title}</h2>
        <span className={styles.groupCount}>{count}</span>
        {hint && <span className={styles.groupHint}>· {hint}</span>}
      </div>
      {children}
    </section>
  );
}

/**
 * The search table (round 1): six columns, so it fits beside the navigation at 1440 and 1280. Sleeps, bedrooms and the
 * minimum sit under the property's name; the stay's one line and its Copy are in "For the stay".
 */
function SearchTable({ rows, hasDates, nights, runAt }: { rows: SearchRow[]; hasDates: boolean; nights: number; runAt: string | null }) {
  return (
    <div className={`${shared.tableContainer} ${styles.tableBox}`}>
      <table className={`${shared.table} ${styles.compact}`}>
        <thead>
          <tr>
            <th>Property</th>
            <th>Nightly</th>
            <th>{hasDates ? "The nights asked" : "Open, next 30"}</th>
            <th>Why it is here</th>
            {hasDates && <th>For the stay</th>}
            <th className={shared.actionsHeader}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.property.id}>
              <td>
                <PropertyCell property={row.property} facts />
              </td>
              <td className={`${styles.num} ${styles.strong}`}>{dollars(row.property.nightly)}</td>
              <td>{hasDates ? <NightStrip states={row.nights} days={row.nightDays} /> : <span className={styles.num}>{row.openNext30 ?? "—"} of 30</span>}</td>
              <td>
                <Reasons reasons={row.reasons} marks={rowMarks(row.property, row.feed, runAt)} />
              </td>
              {hasDates && (
                <td className={styles.stayCell}>
                  <StayCell nights={nights} property={row.property} />
                </td>
              )}
              <td className={shared.actionsCell}>
                <RowActions property={row.property} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Puts the line on the clipboard: the clipboard API first; when it refuses (an unfocused or insecure page, no permission),
 * the older copy command on a selection, which works in more places; "failed" only when both refuse.
 */
async function copyLine(line: string): Promise<"yes" | "failed"> {
  try {
    await navigator.clipboard.writeText(line);
    return "yes";
  } catch {
    /* fall through to the selection copy */
  }
  try {
    const box = document.createElement("textarea");
    box.value = line;
    box.setAttribute("readonly", "");
    box.style.position = "fixed";
    box.style.opacity = "0";
    document.body.appendChild(box);
    box.select();
    const ok = document.execCommand("copy");
    box.remove();
    return ok ? "yes" : "failed";
  } catch {
    return "failed";
  }
}

/**
 * The stay's total before taxes (Kian's ruling K1): the total in bold, the one line under it, and Copy, which puts that
 * line on the clipboard. Each value is an admin-set price; the sum is the only arithmetic (search.ts, stayLine).
 */
function StayCell({ nights, property }: { nights: number; property: AvailabilityProperty }) {
  const [copied, setCopied] = useState<"no" | "yes" | "failed">("no");
  const line = stayLine(nights, property);
  const total = line.slice(line.lastIndexOf("= ") + 2);
  const copy = async () => {
    setCopied(await copyLine(line));
    window.setTimeout(() => setCopied("no"), 1_800);
  };
  return (
    <div className={styles.stay}>
      <span className={`${styles.strong} ${styles.stayTotal}`}>{total}</span>
      <span className={styles.stayLine}>{line}</span>
      <button type="button" className={styles.copyBtn} onClick={() => void copy()} aria-label={`Copy: ${line}`} title="Copy this line">
        {copied === "yes" ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
        <span>{copied === "yes" ? "Copied" : copied === "failed" ? "Could not copy" : "Copy"}</span>
      </button>
    </div>
  );
}

function NightStrip({ states, days }: { states: NightState[]; days: string[] }) {
  const open = states.filter((s) => s === "open").length;
  const cls = (s: NightState) => (s === "open" ? styles.nightOpen : s === "reserved" ? styles.nightReserved : styles.nightBlocked);
  if (states.length > 45) {
    return (
      <span className={styles.stripText} style={{ marginLeft: 0 }}>
        {open} of {states.length} nights open
      </span>
    );
  }
  return (
    <span className={styles.strip} role="img" aria-label={`${open} of ${states.length} nights open`}>
      {states.map((s, i) => (
        <i key={days[i]} className={`${styles.night} ${cls(s)}`} title={`${dayText(days[i])}: ${s === "reserved" ? "booked" : s}`} />
      ))}
      {open < states.length && (
        <span className={styles.stripText}>
          {open} of {states.length}
        </span>
      )}
    </span>
  );
}

const MARK_CLASS: Record<RowMark["tone"], string> = { gone: styles.reasonGone, site: styles.reasonSite, stale: styles.reasonMiss };

/** The reasons, then the row's marks: "Not on the site" (K5), "Not on Airbnb · checked <day>" (K3), "calendar read <day, time>". */
function Reasons({ reasons, marks }: { reasons: Reason[]; marks: RowMark[] }) {
  return (
    <div className={styles.reasons}>
      {reasons.map((reason, i) => (
        <span key={i} className={`${styles.reason} ${reason.kind === "fits" ? styles.reasonFit : reason.miss ? styles.reasonMiss : ""}`}>
          {reason.text}
        </span>
      ))}
      {marks.map((mark, i) => (
        <span key={`m${i}`} className={`${styles.reason} ${MARK_CLASS[mark.tone]}`}>
          {mark.text}
        </span>
      ))}
    </div>
  );
}

/**
 * The picture and the name, the name a link to the property's public page; the public title under it (Kian's rulings of
 * 2026-10-15, evening); with `facts`, "Sleeps 4 · 2 bedrooms · min 2 nights" (round 1: the columns these were); notes,
 * when given, under that.
 */
function PropertyCell({ property, facts, notes }: { property: AvailabilityProperty; facts?: boolean; notes?: React.ReactNode }) {
  const name = <span className={shared.propertyName}>{property.name}</span>;
  return (
    <span className={shared.propertyCell}>
      <span className={shared.thumbWrapper}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={property.coverImage} alt="" className={shared.thumb} />
      </span>
      <span className={styles.nameBlock}>
        {property.slug ? (
          <a href={`/property/${property.slug}`} target="_blank" rel="noopener" className={styles.nameLink} title={`Open ${property.publicName || property.name} on the site`}>
            {name}
          </a>
        ) : (
          name
        )}
        {property.publicName && property.publicName !== property.name && <span className={styles.publicTitle}>{property.publicName}</span>}
        <span className={styles.sub}>
          {[property.area, property.city].filter(Boolean).join(" · ")}
          {facts && ` · sleeps ${property.guests} · ${property.bedrooms === 0 ? "studio" : plural(property.bedrooms, "bedroom", "bedrooms")} · min ${plural(property.minNights, "night", "nights")}`}
        </span>
        {notes}
      </span>
    </span>
  );
}

/** Airbnb, and Edit: the property's own edit page (round 1), not the admin home. Small, so the row fits. */
function RowActions({ property }: { property: AvailabilityProperty }) {
  return (
    <div className={styles.actions}>
      {property.airbnbUrl && (
        <a href={property.airbnbUrl} target="_blank" rel="noopener" className={styles.iconAction} title={`Open ${property.publicName || property.name} on Airbnb`} aria-label={`Open ${property.name} on Airbnb`}>
          <ExternalLink size={14} aria-hidden />
        </a>
      )}
      <Link href={`/admin/property/edit?id=${encodeURIComponent(property.id)}`} prefetch={false} className={styles.iconAction} title={`Edit ${property.name}`} aria-label={`Edit ${property.name}`}>
        <Pencil size={14} aria-hidden />
      </Link>
    </div>
  );
}

// ─── The attention list ─────────────────────────────────────────

function AttentionView({
  snapshot,
  result,
  horizon,
  setHorizon,
  city,
  setCity,
  type,
  setType,
  counts,
  hideGone,
  setHideGone,
  anyPageCheck,
}: {
  snapshot: AvailabilitySnapshot | null;
  result: ReturnType<typeof attentionList>;
  horizon: Horizon;
  setHorizon: (h: Horizon) => void;
  city: string;
  setCity: (v: string) => void;
  type: string;
  setType: (v: string) => void;
  counts: { cities: [string, number][]; types: [string, number][] };
  hideGone: boolean;
  setHideGone: (v: boolean) => void;
  anyPageCheck: boolean;
}) {
  const ranked = hideGone ? result.ranked.filter((row) => !row.airbnbGone) : result.ranked;
  const hidden = result.ranked.length - ranked.length;
  const runAt = snapshot?.refreshedAt ?? null;

  return (
    <>
      <p className={styles.caveat}>
        This list shows where nights are open. It does not know why, and it does not know whether anyone wanted them.
      </p>

      <section className={shared.toolbar} aria-label="Ranking">
        <div className={shared.toolbarRow}>
          <AdminSelect
            label="Horizon"
            icon={<CalendarSearch size={14} />}
            value={String(horizon)}
            onChange={(v) => setHorizon(isHorizon(v) ? (Number(v) as Horizon) : 30)}
            groups={[{ options: HORIZONS.map((h) => ({ value: String(h), label: `Next ${h} nights` })) }]}
          />
          <AdminSelect
            label="City"
            icon={<MapPin size={14} />}
            value={city}
            onChange={setCity}
            groups={[{ options: [{ value: "", label: "All cities" }, ...counts.cities.map(([c, n]) => ({ value: c, label: `${c} (${n})` }))] }]}
          />
          <AdminSelect
            label="Type"
            icon={<Building2 size={14} />}
            value={type}
            onChange={setType}
            groups={[{ options: [{ value: "", label: "All types" }, ...counts.types.map(([t, n]) => ({ value: t, label: `${t} (${n})` }))] }]}
          />
          {anyPageCheck && (
            <label className={styles.toggle}>
              <input type="checkbox" checked={hideGone} onChange={(e) => setHideGone(e.target.checked)} />
              <span>Hide properties whose Airbnb page is gone</span>
            </label>
          )}
          <span className={shared.resultCount}>
            {ranked.length} ranked{hidden ? ` · ${hidden} hidden` : ""}
          </span>
        </div>
      </section>

      {!snapshot ? (
        <div className={shared.empty}>
          <BedDouble size={48} strokeWidth={1} />
          <h2>Nothing to rank yet</h2>
          <p>No refresh has run. Press Refresh now to fetch every calendar.</p>
        </div>
      ) : (
        <>
          <p className={styles.totals}>
            Sellable empty nights in the next {horizon}: <strong>{dollars(ranked.reduce((s, r) => s + r.value, 0))}</strong> across{" "}
            {plural(ranked.filter((r) => r.sellable > 0).length, "property", "properties")}
            {" · "}every empty night counted: {dollars(ranked.reduce((s, r) => s + r.rawValue, 0))}
            {result.sinceDay ? ` · bookings counted since ${dayText(result.sinceDay)}` : " · no week of history yet, so nothing is said about recent bookings"}
          </p>

          {ranked.length === 0 ? (
            <p className={styles.groupEmpty}>Nothing has an empty night in the next {horizon}{hidden ? " once the hidden ones are set aside" : ""}.</p>
          ) : (
            <AttentionTable rows={ranked} ranked runAt={runAt} />
          )}

          {result.fullyBooked.length > 0 && (
            <details className={styles.folded}>
              <summary>Fully booked for the period ({result.fullyBooked.length})</summary>
              <AttentionTable rows={result.fullyBooked} runAt={runAt} />
            </details>
          )}
          {result.blockedAll.length > 0 && (
            <details className={styles.folded}>
              <summary>Blocked for the whole period ({result.blockedAll.length})</summary>
              <AttentionTable rows={result.blockedAll} runAt={runAt} />
            </details>
          )}
          {result.unread.length > 0 && (
            <details className={styles.folded}>
              <summary>Calendars never read ({result.unread.length})</summary>
              <AttentionTable rows={result.unread} runAt={runAt} />
            </details>
          )}
        </>
      )}
    </>
  );
}

/** The ranking (round 1): nine columns, the minimum under the property's name, so it fits at 1440 and 1280. */
function AttentionTable({ rows, ranked, runAt }: { rows: AttentionRow[]; ranked?: boolean; runAt: string | null }) {
  return (
    <div className={`${shared.tableContainer} ${styles.tableBox}`}>
      <table className={`${shared.table} ${styles.compact} ${styles.ranking}`}>
        <thead>
          <tr>
            <th className={styles.rank}>{ranked ? "#" : ""}</th>
            <th>Property</th>
            <th>Nightly</th>
            <th>Sellable</th>
            <th>Empty</th>
            <th>Longest run</th>
            <th>Booked / blocked</th>
            <th>Sellable × nightly</th>
            <th className={shared.actionsHeader}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <AttentionTr key={row.property.id} row={row} rank={ranked ? i + 1 : null} runAt={runAt} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AttentionTr({ row, rank, runAt }: { row: AttentionRow; rank: number | null; runAt: string | null }) {
  const readable = isReadable(row.feed);
  const notes: { text: string; tone?: "miss" | "gone" | "site" }[] = [];
  if (row.property.minNights > 1) notes.push({ text: `minimum ${plural(row.property.minNights, "night", "nights")}` });
  // The row's marks (K3, K5, the calendar's read), then its calendar's state and its week.
  for (const mark of rowMarks(row.property, row.feed, runAt)) notes.push({ text: mark.text, tone: mark.tone === "stale" ? "miss" : mark.tone });
  if (row.feed && !readable) notes.push({ text: row.feed.status === "no-feed" ? "no calendar on the property" : "calendar never read", tone: "miss" });
  if (row.recentBookings !== null) notes.push({ text: row.recentBookings === 0 ? "nothing booked in 7 days" : `${plural(row.recentBookings, "booking", "bookings")} in 7 days` });
  return (
    <tr>
      <td className={styles.rank}>{rank ?? ""}</td>
      <td>
        <PropertyCell
          property={row.property}
          notes={
            notes.length > 0 ? (
              <span className={`${styles.reasons} ${styles.reasonsUnder}`}>
                {notes.map((note, i) => (
                  <span key={i} className={`${styles.reason} ${note.tone === "gone" ? styles.reasonGone : note.tone === "site" ? styles.reasonSite : note.tone === "miss" ? styles.reasonMiss : ""}`}>
                    {note.text}
                  </span>
                ))}
              </span>
            ) : null
          }
        />
      </td>
      <td className={`${styles.num} ${styles.strong}`}>{dollars(row.property.nightly)}</td>
      <td className={`${styles.num} ${styles.strong}`}>{readable ? row.sellable : "—"}</td>
      <td className={styles.num}>{readable ? row.empty : "—"}</td>
      <td className={styles.num}>{readable ? row.longestRun : "—"}</td>
      <td className={styles.num}>{readable ? `${row.booked} / ${row.blocked}` : "—"}</td>
      <td className={`${styles.num} ${styles.strong}`}>
        {readable ? dollars(row.value) : "—"}
        {readable && row.rawValue !== row.value && <span className={styles.sub}>{dollars(row.rawValue)} counting every empty night</span>}
      </td>
      <td className={shared.actionsCell}>
        <RowActions property={row.property} />
      </td>
    </tr>
  );
}
