"use client";

import { useState, useEffect, useMemo, useRef, useCallback, type MouseEvent } from "react";
import { useRouter } from "next/navigation";
import { Property } from "@/app/types/property";
import { getPropertiesResult, deleteProperty } from "@/app/lib/firebase/properties";
import { PinGate } from "./components/PinGate";
import { NoticeBanner, useNotice } from "./components/Notice";
import { AdminHeader } from "./components/AdminHeader";
import { PageHead } from "./components/PageHead";
import { DashboardStats, useStatements, type Read } from "./components/DashboardStats";
import { AdminSelect } from "./components/AdminSelect";
import { ReportingStatusCell } from "./components/StatementStatus";
import { CleaningCell, IncomeCell, NextStepCell, UnknownCell } from "./components/PropertyColumns";
import { torontoDayOf } from "@/app/lib/costs/report";
import { reportingStatuses, type ReportingTone } from "@/app/lib/reports/statement";
import { fetchPropertyStatus, type PropertyStatusResult } from "@/app/lib/property-status-client";
import { incomeStanding, type IncomeStanding, type IncomeTone } from "@/app/lib/income/standing";
import { cleaningStanding, type CleaningStanding, type CleaningTone, type HomeJob } from "@/app/lib/schedule/standing";
import { byAttention, byNextCheckout, CHIPS, rowView, statementFigures, turnoverFigures, type ChipKey, type RowView } from "@/app/lib/home/next-step";
import { entryHref, queueLabel, writeQueue } from "@/app/lib/home/property-queue";
import { useCalendarsRefreshed } from "@/app/lib/calendar-refresh-client";
import { Dialog } from "./property/editor/controls";
import styles from "./page.module.css";
import ed from "./property/editor/editor.module.css";
import { Plus, Edit2, Trash2, Search, LayoutGrid, AlertTriangle, RefreshCw, MapPin, ArrowUpDown, X } from "lucide-react";
import Link from "next/link";

/** The list's three orders (Kian's rulings of 2026-10-17, admin home): Needs attention first by default. */
type SortOption = "attention" | "next-checkout" | "address";

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: "attention", label: "Needs attention" },
  { value: "next-checkout", label: "Next checkout" },
  { value: "address", label: "Address" },
];

/** Accents and case set aside, so "Étobicoke" and "etobicoke" are the same word. */
const fold = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/**
 * Everything a property can be found by, as one folded string: the name the list shows (its cleaner-facing name,
 * usually the address), its public title, location, city, area, province, type, tag and slug.
 */
function searchText(p: Property, internalName: string | undefined): string {
  return fold(
    [internalName, p.name, p.location, p.addressDetails?.city, p.addressDetails?.area, p.addressDetails?.state, p.type, p.propertyTypeTag, p.slug]
      .filter(Boolean)
      .join(" "),
  );
}

/** Every word typed must appear somewhere in the property's text, in any order: "basement markham" finds a basement in Markham. */
function matchesSearch(text: string, query: string): boolean {
  return fold(query)
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => text.includes(word));
}

/** Distinct values of one field with how many properties carry each, A to Z. */
function counted(properties: Property[], field: (p: Property) => string | undefined): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const p of properties) {
    const value = field(p);
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => a.value.localeCompare(b.value, "en-CA"));
}

/** The search, the city, the chip and the sort the address bar carries when the page opens; nothing on the server. */
function filtersFromUrl() {
  const params = typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search);
  const sort = params.get("sort");
  const show = params.get("show");
  return {
    q: params.get("q") ?? "",
    city: params.get("city") ?? "all",
    show: CHIPS.some((chip) => chip.key === show) ? (show as ChipKey) : null,
    sort: SORT_OPTIONS.some((option) => option.value === sort) ? (sort as SortOption) : ("attention" as SortOption),
  };
}

/** A cell's tone as the Needs attention sort weighs it: red 2, amber 1, anything else 0. */
const SEVERITY: Partial<Record<ReportingTone | IncomeTone | CleaningTone, number>> = { problem: 2, warning: 1 };
const worstOf = (tones: (ReportingTone | IncomeTone | CleaningTone | undefined)[]) => Math.max(0, ...tones.map((tone) => (tone === undefined ? 0 : (SEVERITY[tone] ?? 0))));

/**
 * A property's page (dispatch 23F): everything about it, bound to a month —
 * its costs, its income, the statement's details, and finishing — with the
 * statement preview beside. With no month in its address it opens on the
 * month due, the oldest owed and unfinished, else the current month (build
 * round 1 of the property page audit, 2026-10-17).
 */
const propertyHref = (id: string) => `/admin/property?id=${encodeURIComponent(id)}`;

/**
 * A property's edit page, and the page a new one is made on (dispatch 30,
 * Kian's ruling of 2026-10-10): their own pages, not a pop-up.
 */
const editHref = (id: string) => `/admin/property/edit?id=${encodeURIComponent(id)}`;
const NEW_HREF = "/admin/property/new";

export default function AdminPage() {
  // Everything under the PIN gate (as the property page): the statements read is admin-only, and the page's
  // reads start once the session exists (dispatch 23G moved that read up from the tiles into the page).
  return (
    <PinGate>
      <AdminHome />
    </PinGate>
  );
}

function AdminHome() {
  const router = useRouter();
  const [properties, setProperties] = useState<Property[]>([]);
  /** Which properties are unlisted (dispatch 24): read beside the documents, never inside one. */
  const [unlistedIds, setUnlistedIds] = useState<Set<string>>(new Set());
  /** The month each property was created (Firestore's create time): no statement is owed before it (Kian's ruling of 2026-10-03). */
  const [createdMonths, setCreatedMonths] = useState<Map<string, string | null>>(new Map());
  /**
   * The name the list shows for each property: its cleaner-facing name, usually the street address, else its public
   * title (Kian's rulings of 2026-10-15, evening: no internal list is titled by the Airbnb title). Read beside the
   * documents, never inside one.
   */
  const [internalNames, setInternalNames] = useState<Map<string, string>>(new Map());
  const nameOf = useCallback((p: Property) => internalNames.get(p.id) ?? p.name, [internalNames]);
  const [isLoading, setIsLoading] = useState(true);
  // null = the read succeeded. A failed read must never render as "no properties
  // yet", which invites re-creating records that already exist.
  const [loadError, setLoadError] = useState<string | null>(null);
  // A read that never settles (an unreachable project) would leave the page
  // waiting. Say so rather than spinning silently. Purely advisory — the read
  // is not cancelled.
  const [isSlowLoad, setIsSlowLoad] = useState(false);
  const { notice, show: showNotice, clear: clearNotice } = useNotice();

  // The statements read (GET /api/admin/monthly-reports), shared by the Statements tile, its panel and
  // the list's Statement column (dispatch 23G): every property's status by the one rule, `reportingStatus`.
  const statementsRead = useStatements();
  const today = torontoDayOf(new Date());
  const tracker = statementsRead.statements.kind === "ready" ? statementsRead.statements.data : null;
  const statuses = useMemo(() => {
    if (!tracker) return null;
    // The list's properties and the tracker's: the same documents; both are included, so a property
    // added since either read still has a status, with the month it was created from whichever read has it.
    const created = new Map(tracker.properties.map((p) => [p.id, p.createdMonth ?? null]));
    for (const [id, month] of createdMonths) if (month !== null) created.set(id, month);
    // The months with money in them (Kian's ruling of 2026-10-04) come from the tracker's read alone.
    const money = new Map(tracker.properties.map((p) => [p.id, p.moneyMonths ?? []]));
    const ids = new Map([...tracker.properties, ...properties].map((p) => [p.id, { id: p.id, createdMonth: created.get(p.id) ?? null, moneyMonths: money.get(p.id) ?? [] }]));
    return reportingStatuses({ today, properties: [...ids.values()], management: tracker.management, reports: tracker.reports });
  }, [tracker, properties, createdMonths, today]);
  /** The properties whose management record holds a Report For name: Finish refuses a statement without one (Kian's rulings of 2026-10-12). */
  const withReportFor = useMemo(
    () => (tracker ? new Set(tracker.management.filter((record) => (record.reportFor?.name ?? "").trim() !== "").map((record) => record.propertyId)) : null),
    [tracker],
  );
  /** The Statements due tile: every statement owed, blocked and ready (app/lib/home/next-step.ts). */
  const figures = useMemo(
    () => (statuses && withReportFor ? statementFigures([...statuses].map(([id, status]) => ({ status, hasReportFor: withReportFor.has(id) }))) : null),
    [statuses, withReportFor],
  );

  // The Income and Cleaning columns' read (Kian's rulings of 2026-10-15), with the calendar copy's facts and the jobs the
  // Turnovers tile counts (Kian's rulings of 2026-10-17): its own call, so a failure leaves the Statement column as it is
  // and shows only what it feeds as not known. Read again after a refresh of the calendars, keeping what is shown until
  // the answer comes.
  const [propertyStatus, setPropertyStatus] = useState<PropertyStatusResult | null>(null);
  const [statusAttempt, setStatusAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    fetchPropertyStatus().then((result) => {
      if (!cancelled) setPropertyStatus(result);
    });
    return () => {
      cancelled = true;
    };
  }, [statusAttempt]);
  useCalendarsRefreshed((outcome) => {
    if (outcome.ok) setStatusAttempt((n) => n + 1);
  });
  const statusData = propertyStatus?.ok ? propertyStatus.data : null;
  const statusFailed = propertyStatus && !propertyStatus.ok ? propertyStatus.title : null;
  const turnovers: Read<ReturnType<typeof turnoverFigures>> = statusData
    ? { kind: "ready", data: turnoverFigures(statusData.cleaning.jobs, statusData.today) }
    : statusFailed !== null
      ? { kind: "error", title: statusFailed }
      : { kind: "loading" };

  /**
   * Each property's cells, by the functions that decide them (app/lib/income/standing.ts, app/lib/schedule/standing.ts),
   * its next checkout, and its Next step (app/lib/home/next-step.ts) once the statements are read too.
   */
  const rows = useMemo(() => {
    if (!statusData) return null;
    const { income, cleaning, calendar, today: day } = statusData;
    const jobs = new Map<string, HomeJob[]>();
    for (const job of cleaning.jobs) jobs.set(job.propertyId, [...(jobs.get(job.propertyId) ?? []), job]);
    return new Map<string, { income: IncomeStanding; cleaning: CleaningStanding; nextCheckout: string | null; view: RowView | null }>(
      properties.map((p) => {
        const hasCalendarLink = (p.icalUrl ?? "").trim() !== "";
        const copy = calendar.properties[p.id];
        // Read: it has a link and the last refresh read it. Not in the copy (added since) is not read either.
        const calendarRead = hasCalendarLink && copy?.status === "ok";
        const own = jobs.get(p.id) ?? [];
        const status = statuses?.get(p.id);
        return [
          p.id,
          {
            income: incomeStanding(income, p.id),
            cleaning: cleaningStanding(own, { today: day, hasCalendar: hasCalendarLink, calendarRead }),
            nextCheckout: copy?.nextCheckout ?? null,
            view:
              status && withReportFor
                ? rowView({ propertyId: p.id, today: day, status, hasReportFor: withReportFor.has(p.id), incomeMonth: income.month, review: income.properties[p.id]?.review ?? 0, direct: income.direct[p.id] ?? null, jobs: own, hasCalendarLink, calendarRead })
                : null,
          },
        ];
      }),
    );
  }, [statusData, properties, statuses, withReportFor]);
  /** Why a Next step is not known: the read that failed. */
  const viewsFailed = statusFailed ?? (statementsRead.statements.kind === "error" ? statementsRead.statements.title : null);
  const viewsReady = rows !== null && statuses !== null && withReportFor !== null;

  // Search, the city, a chip and the sort (Kian's rulings of 2026-10-17). They start from the address bar and are
  // written back to it (?q=&city=&show=&sort=), so a reload or a shared link keeps them.
  const [initial] = useState(filtersFromUrl);
  const [searchQuery, setSearchQuery] = useState(initial.q);
  const [cityFilter, setCityFilter] = useState(initial.city);
  const [chip, setChip] = useState<ChipKey | null>(initial.show);
  const [sortBy, setSortBy] = useState<SortOption>(initial.sort);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const url = new URL(window.location.href);
    const set = (key: string, value: string, off: string) =>
      value === off ? url.searchParams.delete(key) : url.searchParams.set(key, value);
    set("q", searchQuery.trim(), "");
    set("city", cityFilter, "all");
    set("show", chip ?? "", "");
    set("sort", sortBy, "attention");
    for (const gone of ["type", "beds"]) url.searchParams.delete(gone);
    if (url.href !== window.location.href) window.history.replaceState(null, "", url.href);
  }, [searchQuery, cityFilter, chip, sortBy]);

  // "/" puts the cursor in the search, as long as nothing else is being typed into.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (!searchRef.current) return;
      event.preventDefault();
      searchRef.current.focus();
      searchRef.current.select();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    fetchProperties();
  }, []);

  const fetchProperties = async () => {
    setIsLoading(true);
    setIsSlowLoad(false);
    const slowTimer = setTimeout(() => setIsSlowLoad(true), 15_000);
    try {
      const result = await getPropertiesResult();
      if (result.ok) {
        setProperties(result.data.properties);
        setUnlistedIds(result.data.unlistedIds);
        setCreatedMonths(result.data.createdMonths);
        setInternalNames(result.data.internalNames);
        setLoadError(null);
      } else {
        setProperties([]);
        setLoadError(result.error);
      }
    } finally {
      clearTimeout(slowTimer);
      setIsSlowLoad(false);
      setIsLoading(false);
    }
  };

  // What the City filter offers, each option with its count.
  const cities = useMemo(() => counted(properties, (p) => p.addressDetails?.city), [properties]);
  const searchable = useMemo(() => new Map(properties.map((p) => [p.id, searchText(p, internalNames.get(p.id))])), [properties, internalNames]);

  /** Searched and narrowed to the city: what the chips count, so a chip's count is the rows it shows. */
  const searched = useMemo(
    () => properties.filter((p) => matchesSearch(searchable.get(p.id) ?? "", searchQuery) && (cityFilter === "all" || p.addressDetails?.city === cityFilter)),
    [properties, searchable, searchQuery, cityFilter],
  );
  const chipCounts = useMemo(() => {
    if (!viewsReady) return null;
    return new Map(CHIPS.map(({ key }) => [key, searched.filter((p) => rows!.get(p.id)?.view?.under[key]).length]));
  }, [viewsReady, searched, rows]);

  // Then the chip, then sorted.
  const filteredProperties = useMemo(() => {
    const result = chip && viewsReady ? searched.filter((p) => rows!.get(p.id)?.view?.under[chip]) : [...searched];
    const byName = (a: Property, b: Property) => nameOf(a).localeCompare(nameOf(b), "en-CA");
    if (sortBy === "next-checkout" && rows) {
      result.sort((a, b) => byNextCheckout({ nextCheckout: rows.get(a.id)?.nextCheckout ?? null, name: nameOf(a) }, { nextCheckout: rows.get(b.id)?.nextCheckout ?? null, name: nameOf(b) }));
    } else if (sortBy === "attention" && viewsReady) {
      const ranked = new Map(
        result.map((p) => {
          const row = rows!.get(p.id)!;
          return [p.id, { step: row.view!.step, worst: worstOf([statuses!.get(p.id)?.tone, row.income.tone, row.cleaning.tone]), name: nameOf(p) }];
        }),
      );
      result.sort((a, b) => byAttention(ranked.get(a.id)!, ranked.get(b.id)!));
    } else {
      // By address, and while what the other orders need is still being read.
      result.sort(byName);
    }
    return result;
  }, [searched, chip, viewsReady, rows, sortBy, statuses, nameOf]);

  // "Next property" on the property page (2026-10-17): the list as shown — its chip, search, city and order — kept in
  // this tab for the property page to walk, each property opening where its Next step is done (app/lib/home/property-queue.ts).
  useEffect(() => {
    if (isLoading || loadError) return;
    writeQueue({
      label: queueLabel({
        chip: chip ? (CHIPS.find((c) => c.key === chip)?.label ?? null) : null,
        search: searchQuery,
        city: cityFilter === "all" ? null : cityFilter,
        sort: SORT_OPTIONS.find((option) => option.value === sortBy)?.label ?? "",
      }),
      listHref: `${window.location.pathname}${window.location.search}`,
      entries: filteredProperties.map((p) => ({ id: p.id, name: nameOf(p), href: entryHref(p.id, rows?.get(p.id)?.view?.step.href) })),
    });
  }, [filteredProperties, rows, chip, searchQuery, cityFilter, sortBy, nameOf, isLoading, loadError]);

  const narrowed = searchQuery.trim() !== "" || cityFilter !== "all" || chip !== null;
  const clearFilters = () => {
    setSearchQuery("");
    setCityFilter("all");
    setChip(null);
  };
  const units = (n: number) => `${n} ${n === 1 ? "unit" : "units"}`;

  /** The property the Delete dialog asks about (Kian's ruling of 2026-10-12: no native browser dialogs anywhere in the admin). */
  const [askingDelete, setAskingDelete] = useState<{ id: string; name: string } | null>(null);

  const handleDelete = async (id: string, name: string) => {
    setAskingDelete(null);
    clearNotice();
    const result = await deleteProperty(id);
    if (result.ok) {
      showNotice({ tone: "success", title: `Deleted "${name}".` });
    } else if (result.code === "PROPERTY_HOLDS_RECORDS") {
      // Kian's ruling of 2026-10-12 (dispatch 34): it is never deleted; the way is Unlisted and Exclude from reporting.
      showNotice({ tone: "warning", title: `"${name}" was not deleted. ${result.error}`, detail: result.hint, action: { label: "Open its Status", href: `${editHref(id)}&section=status` } });
    } else {
      // Previously the return value was dropped, so an expired session looked
      // exactly like a UI glitch: the row simply stayed.
      showNotice({
        tone: "error",
        title: `Could not delete "${name}".`,
        detail:
          result.status === 401 || result.status === 403
            ? `${result.error} Your admin session may have expired — reload and sign in again.`
            : `${result.error}${result.status ? ` (HTTP ${result.status})` : ""}`,
      });
    }
    fetchProperties();
  };

  /**
   * A click on the row opens the property's page (Kian's rulings of 2026-10-17). The name is a real link, for the
   * keyboard and for opening in a new tab; a click anywhere else on the row goes to the same place. A click on a
   * cell's own link or a control is that one's, and one that ends a text selection is not a click.
   */
  const openPage = (event: MouseEvent<HTMLTableRowElement>, id: string) => {
    if ((event.target as HTMLElement).closest("a, button")) return;
    if (window.getSelection()?.toString()) return;
    router.push(propertyHref(id));
  };

  return (
    <div className={styles.container}>
      {/* ── The navigation: the column on the left, the same on every admin page ── */}
      <AdminHeader current="properties" />

      <main className={styles.main}>
        {/* ── Notices (deletes) ── */}
        <NoticeBanner notice={notice} onDismiss={clearNotice} className={styles.pageNotice} />

        {/* ── The four figures: each a way to where the work is (components/DashboardStats.tsx) ── */}
        <DashboardStats statements={statementsRead} statuses={statuses} today={today} figures={figures} turnovers={turnovers} />

        {/* ── The list's head and its one action (Kian's ruling of 2026-10-15: no page's buttons in the navigation);
            under the four tiles, which stay on top (Kian's ruling of 2026-10-02) ── */}
        <PageHead title="Properties">
          <Link href={NEW_HREF} prefetch={false} className={styles.btnPrimary}>
            <Plus size={16} aria-hidden />
            <span>Add Property</span>
          </Link>
        </PageHead>

        {/* ── Search, the city and the sort; under them, the chips that filter the list, each with its count (Kian's
            rulings of 2026-10-17). Search matches every word typed against the address, the public title, the
            location, city, area, type and slug. A chip shows the rows under it; pressed again, every row. "/" puts the
            cursor in the search. ── */}
        {!isLoading && properties.length > 0 && (
          <section className={styles.toolbar} aria-label="Search, filters and sort">
            <div className={styles.toolbarRow}>
              <div className={styles.searchWrapper}>
                <Search size={16} className={styles.searchIcon} aria-hidden />
                <input
                  ref={searchRef}
                  type="search"
                  className={styles.searchInput}
                  placeholder="Search by address, title or city"
                  aria-label="Search properties by address, title or city"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setSearchQuery("");
                  }}
                  autoComplete="off"
                  spellCheck={false}
                />
                {searchQuery ? (
                  <button
                    type="button"
                    className={styles.searchClear}
                    aria-label="Clear search"
                    onClick={() => {
                      setSearchQuery("");
                      searchRef.current?.focus();
                    }}
                  >
                    <X size={14} aria-hidden />
                  </button>
                ) : (
                  <kbd className={styles.searchKbd} aria-hidden>
                    /
                  </kbd>
                )}
              </div>

              <AdminSelect
                label="City"
                icon={<MapPin size={14} />}
                value={cityFilter}
                onChange={setCityFilter}
                groups={[{ options: [{ value: "all", label: "All cities" }, ...cities.map((c) => ({ value: c.value, label: `${c.value} (${c.count})` }))] }]}
              />

              <AdminSelect
                className={styles.sortSelect}
                label="Sort"
                icon={<ArrowUpDown size={14} />}
                value={sortBy}
                onChange={(value) => setSortBy(value as SortOption)}
                groups={[{ options: SORT_OPTIONS }]}
              />
            </div>

            <div className={styles.chipRow} role="group" aria-label="Show only">
              {CHIPS.map(({ key, label }) => {
                const on = chip === key;
                const count = chipCounts?.get(key);
                return (
                  <button
                    key={key}
                    type="button"
                    className={`${styles.filterChip} ${on ? styles.filterChipOn : ""}`}
                    aria-pressed={on}
                    disabled={chipCounts === null}
                    title={chipCounts === null ? (viewsFailed ?? "Loading") : undefined}
                    onClick={() => setChip(on ? null : key)}
                  >
                    <span>{label}</span>
                    <span className={styles.chipCount}>{count === undefined ? (viewsFailed ? "—" : "…") : count}</span>
                  </button>
                );
              })}
              {/* The Report For sheet (2026-10-17): a blocked statement is one with no Report For name; every name in one table. */}
              {chip === "blocked" && (
                <Link href="/admin/report-for?owes=1" prefetch={false} className={styles.chipLink}>
                  Fill in Report For in one table
                </Link>
              )}
            </div>
          </section>
        )}

        {/* ── Content ── */}
        {isLoading ? (
          <div className={styles.loading}>
            <div className={styles.spinner} />
            <p>Loading properties from Firebase…</p>
            {isSlowLoad && (
              <p className={styles.loadingSlow}>
                Firestore has not responded in 15 seconds. The read is still retrying — the list
                below is not empty, it has not loaded. Do not create properties until it does.
              </p>
            )}
          </div>
        ) : loadError ? (
          /* A failed read is NOT an empty database. Never offer "Create
             Property" here — the records may well already exist. */
          <div className={`${styles.empty} ${styles.loadError}`}>
            <AlertTriangle size={48} strokeWidth={1} />
            <h2>Could not load properties</h2>
            <p>
              The property list could not be read from Firestore, so this page cannot show what
              exists. Do not create properties from here until it loads — they may already exist.
            </p>
            <code className={styles.loadErrorDetail}>{loadError}</code>
            <button className={styles.btnPrimary} onClick={fetchProperties}>
              <RefreshCw size={18} />
              <span>Retry</span>
            </button>
          </div>
        ) : properties.length === 0 ? (
          <div className={styles.empty}>
            <LayoutGrid size={48} strokeWidth={1} />
            <h2>No properties yet</h2>
            <p>Get started by creating your first listing or seeding sample data.</p>
            <Link href={NEW_HREF} prefetch={false} className={styles.btnPrimary}>
              <Plus size={18} />
              <span>Create Property</span>
            </Link>
          </div>
        ) : filteredProperties.length === 0 ? (
          <div className={styles.empty}>
            <Search size={48} strokeWidth={1} />
            <h2>No matching properties</h2>
            <p>Nothing matches. Try fewer words, another city, or no chip.</p>
            <button type="button" className={styles.btnGhost} onClick={clearFilters}>
              <X size={15} aria-hidden />
              <span>Clear search and filters</span>
            </button>
          </div>
        ) : (
          <div className={`${styles.tableContainer} ${styles.tableScroll}`}>
            {/* The name takes what is left; every other column is as wide as its widest entry. */}
            <table className={`${styles.table} ${styles.propertyTable}`}>
              <thead>
                <tr>
                  {/* The units count (Kian's rulings of 2026-10-17: it moved here from the tiles). */}
                  <th aria-live="polite">{narrowed ? `${filteredProperties.length} of ${units(properties.length)}` : units(properties.length)}</th>
                  <th className={styles.colFit}>Statement</th>
                  <th className={styles.colFit}>Income</th>
                  <th className={styles.colFit}>Cleaning</th>
                  <th className={styles.colFit}>Next step</th>
                  {/* Named for a screen reader, not drawn: a visually hidden span here is absolutely placed and, when the table
                      scrolls, it escapes the table's box and widens the page. */}
                  <th className={`${styles.colFit} ${styles.colEnd}`} aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {filteredProperties.map((p) => {
                  const row = rows?.get(p.id);
                  return (
                    <tr key={p.id} className={styles.propertyRow} onClick={(event) => openPage(event, p.id)} aria-label={`Open ${nameOf(p)}`}>
                      <td>
                        {/* The picture and the name are one link to the property's page. Not prefetched:
                            every row in view would ask the server for the page before anyone clicked. */}
                        <Link href={propertyHref(p.id)} prefetch={false} className={styles.propertyCell}>
                          <span className={styles.thumbWrapper}>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={p.coverImage} alt="" className={styles.thumb} />
                          </span>
                          <span className={styles.propertyName}>{nameOf(p)}</span>
                          {unlistedIds.has(p.id) && (
                            <span className={`${styles.stateBadge} ${styles.stateOpen} ${styles.unlistedBadge}`} title="Not on the public site: hidden from the homepage, the map, its own page and the property API">
                              Unlisted
                            </span>
                          )}
                        </Link>
                      </td>
                      {/* The reporting cycle's status for the property, a link to its page at the month in question (dispatch 23G). */}
                      <td className={styles.colFit}>
                        {statuses?.get(p.id) ? (
                          <ReportingStatusCell propertyId={p.id} status={statuses.get(p.id)!} />
                        ) : statementsRead.statements.kind === "error" ? (
                          <span className={styles.locationText} title={statementsRead.statements.title}>—</span>
                        ) : (
                          <span className={styles.locationText} aria-busy>…</span>
                        )}
                      </td>
                      {/* The month due's income and the most pressing cleaning job (Kian's rulings of 2026-10-15), each a link to where the work is. */}
                      <td className={styles.colFit}>{row ? <IncomeCell propertyId={p.id} standing={row.income} /> : <UnknownCell failed={statusFailed} />}</td>
                      <td className={styles.colFit}>{row && statusData ? <CleaningCell propertyId={p.id} standing={row.cleaning} today={statusData.today} /> : <UnknownCell failed={statusFailed} />}</td>
                      {/* The one most pressing action (Kian's rulings of 2026-10-17). */}
                      <td className={styles.colFit}>{row?.view ? <NextStepCell step={row.view.step} /> : <UnknownCell failed={viewsFailed} />}</td>
                      {/* A click in this cell that misses a control does nothing: it is beside Delete. */}
                      <td className={`${styles.actionsCell} ${styles.colFit}`} onClick={(event) => event.stopPropagation()} title="">
                        <div className={styles.actionsFlex}>
                          <Link href={editHref(p.id)} prefetch={false} className={styles.iconBtn} title={`Edit ${nameOf(p)}`} aria-label={`Edit ${nameOf(p)}`}>
                            <Edit2 size={15} aria-hidden />
                          </Link>
                          <button
                            type="button"
                            className={styles.iconBtnDelete}
                            onClick={() => setAskingDelete({ id: p.id, name: nameOf(p) })}
                            title="Delete"
                            aria-label={`Delete ${nameOf(p)}`}
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </main>

      {/* ── Delete: Nubnb's own dialog (no native browser dialogs in the admin, Kian's ruling of 2026-10-12) ── */}
      {askingDelete && (
        <Dialog
          title={`Delete “${askingDelete.name}”?`}
          onClose={() => setAskingDelete(null)}
          actions={
            <>
              <button type="button" className={`${ed.btn} ${ed.btnGhost}`} onClick={() => setAskingDelete(null)}>
                Keep it
              </button>
              <button type="button" className={`${ed.btn} ${ed.btnGhost} ${ed.btnDanger}`} onClick={() => void handleDelete(askingDelete.id, askingDelete.name)}>
                Delete property
              </button>
            </>
          }
        >
          <p>Its listing, its owner record and its name for cleaners are deleted with it.</p>
          <p>A property with statements, drafts, income, Airbnb title links or costs is never deleted: mark it Unlisted and exclude it from reporting instead.</p>
        </Dialog>
      )}
    </div>
  );
}
