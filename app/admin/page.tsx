"use client";

import { useState, useEffect, useMemo, useRef, type MouseEvent } from "react";
import { useRouter } from "next/navigation";
import { Property } from "@/app/types/property";
import { getPropertiesResult, deleteProperty, addProperty } from "@/app/lib/firebase/properties";
import { nightlyPrice } from "@/app/lib/price";
import { PropertyForm } from "./components/PropertyForm";
import { PinGate } from "./components/PinGate";
import { NoticeBanner, useNotice } from "./components/Notice";
import { AdminHeader } from "./components/AdminHeader";
import { DashboardStats } from "./components/DashboardStats";
import { AdminSelect } from "./components/AdminSelect";
import styles from "./page.module.css";
import {
  Plus,
  Edit2,
  Trash2,
  Search,
  LayoutGrid,
  AlertTriangle,
  RefreshCw,
  Receipt,
  MapPin,
  Building2,
  BedDouble,
  ArrowUpDown,
  X,
} from "lucide-react";
import Link from "next/link";

type SortOption = "default" | "name-asc" | "price-asc" | "price-desc" | "beds-desc";
type BedsFilter = "all" | "0" | "1" | "2" | "3" | "4+";

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: "default", label: "Default order" },
  { value: "name-asc", label: "Name: A → Z" },
  { value: "price-asc", label: "Price: low → high" },
  { value: "price-desc", label: "Price: high → low" },
  { value: "beds-desc", label: "Bedrooms: most first" },
];

/** Exact bedroom counts, the way an admin thinks of a property ("the 3-bedroom in Markham"), with 4+ as one bucket. */
const BEDS_OPTIONS: { value: BedsFilter; label: string; match: (bedrooms: number) => boolean }[] = [
  { value: "all", label: "Any bedrooms", match: () => true },
  { value: "0", label: "Studio", match: (n) => n === 0 },
  { value: "1", label: "1 bedroom", match: (n) => n === 1 },
  { value: "2", label: "2 bedrooms", match: (n) => n === 2 },
  { value: "3", label: "3 bedrooms", match: (n) => n === 3 },
  { value: "4+", label: "4+ bedrooms", match: (n) => n >= 4 },
];

/** Accents and case set aside, so "Étobicoke" and "etobicoke" are the same word. */
const fold = (text: string) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/** Everything a property can be found by, as one folded string: name, location, city, area, province, type, tag and slug. */
function searchText(p: Property): string {
  return fold(
    [p.name, p.location, p.addressDetails?.city, p.addressDetails?.area, p.addressDetails?.state, p.type, p.propertyTypeTag, p.slug]
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

/** The search, filters and sort the address bar carries when the page opens; nothing on the server. */
function filtersFromUrl() {
  const params = typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search);
  const beds = params.get("beds");
  const sort = params.get("sort");
  return {
    q: params.get("q") ?? "",
    city: params.get("city") ?? "all",
    type: params.get("type") ?? "all",
    beds: BEDS_OPTIONS.some((option) => option.value === beds) ? (beds as BedsFilter) : "all",
    sort: SORT_OPTIONS.some((option) => option.value === sort) ? (sort as SortOption) : "default",
  };
}

/** A property's costs: its ledger, with its date range and both exports (dispatch 21). */
const costsHref = (id: string) => `/admin/costs?property=${encodeURIComponent(id)}&status=approved`;

export default function AdminPage() {
  const router = useRouter();
  const [properties, setProperties] = useState<Property[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  // null = the read succeeded. A failed read must never render as "no properties
  // yet", which invites re-creating records that already exist.
  const [loadError, setLoadError] = useState<string | null>(null);
  // A Firestore read that never settles (unreachable project) leaves the SDK
  // retrying forever. Say so rather than spinning silently. Purely advisory —
  // the read is not cancelled.
  const [isSlowLoad, setIsSlowLoad] = useState(false);
  const { notice, show: showNotice, clear: clearNotice } = useNotice();
  const [editingProperty, setEditingProperty] = useState<Property | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);

  // Search, filters and sort (2026-09-30). They start from the address bar
  // and are written back to it (?q=&city=&type=&beds=&sort=), so a reload or
  // a shared link keeps them, as on the costs page.
  const [initial] = useState(filtersFromUrl);
  const [searchQuery, setSearchQuery] = useState(initial.q);
  const [cityFilter, setCityFilter] = useState(initial.city);
  const [typeFilter, setTypeFilter] = useState(initial.type);
  const [bedsFilter, setBedsFilter] = useState<BedsFilter>(initial.beds);
  const [sortBy, setSortBy] = useState<SortOption>(initial.sort);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const url = new URL(window.location.href);
    const set = (key: string, value: string, off: string) =>
      value === off ? url.searchParams.delete(key) : url.searchParams.set(key, value);
    set("q", searchQuery.trim(), "");
    set("city", cityFilter, "all");
    set("type", typeFilter, "all");
    set("beds", bedsFilter, "all");
    set("sort", sortBy, "default");
    if (url.href !== window.location.href) window.history.replaceState(null, "", url.href);
  }, [searchQuery, cityFilter, typeFilter, bedsFilter, sortBy]);

  // "/" puts the cursor in the search, as long as nothing else is being typed into.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey || isFormOpen) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (!searchRef.current) return;
      event.preventDefault();
      searchRef.current.focus();
      searchRef.current.select();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isFormOpen]);

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
        setProperties(result.data);
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

  // What the filters offer, each option with its count.
  const cities = useMemo(() => counted(properties, (p) => p.addressDetails?.city), [properties]);
  const propertyTypes = useMemo(() => counted(properties, (p) => p.type), [properties]);
  const bedroomOptions = useMemo(
    () => BEDS_OPTIONS.map((option) => ({ ...option, count: properties.filter((p) => option.match(p.bedrooms ?? 0)).length })),
    [properties],
  );
  const searchable = useMemo(() => new Map(properties.map((p) => [p.id, searchText(p)])), [properties]);

  // Searched, filtered, then sorted.
  const filteredProperties = useMemo(() => {
    const beds = BEDS_OPTIONS.find((option) => option.value === bedsFilter) ?? BEDS_OPTIONS[0];
    const result = properties.filter(
      (p) =>
        matchesSearch(searchable.get(p.id) ?? "", searchQuery) &&
        (cityFilter === "all" || p.addressDetails?.city === cityFilter) &&
        (typeFilter === "all" || p.type === typeFilter) &&
        beds.match(p.bedrooms ?? 0),
    );

    switch (sortBy) {
      // Sorted on the nightly price, which is what the list shows and what
      // renters see. Sorting on the legacy `price` field put one listing in
      // the order of a $239 stay while it advertised $699.
      case "price-asc":
        result.sort((a, b) => nightlyPrice(a) - nightlyPrice(b));
        break;
      case "price-desc":
        result.sort((a, b) => nightlyPrice(b) - nightlyPrice(a));
        break;
      case "name-asc":
        result.sort((a, b) => a.name.localeCompare(b.name, "en-CA"));
        break;
      case "beds-desc":
        result.sort((a, b) => (b.bedrooms ?? 0) - (a.bedrooms ?? 0) || a.name.localeCompare(b.name, "en-CA"));
        break;
      default:
        break;
    }

    return result;
  }, [properties, searchable, searchQuery, cityFilter, typeFilter, bedsFilter, sortBy]);

  /** What is narrowing the list right now, each with a way to take it off. */
  const activeFilters: { key: string; label: string; clear: () => void }[] = [];
  if (searchQuery.trim() !== "") activeFilters.push({ key: "q", label: `“${searchQuery.trim()}”`, clear: () => setSearchQuery("") });
  if (cityFilter !== "all") activeFilters.push({ key: "city", label: cityFilter, clear: () => setCityFilter("all") });
  if (typeFilter !== "all") activeFilters.push({ key: "type", label: typeFilter, clear: () => setTypeFilter("all") });
  if (bedsFilter !== "all") {
    activeFilters.push({ key: "beds", label: BEDS_OPTIONS.find((option) => option.value === bedsFilter)?.label ?? bedsFilter, clear: () => setBedsFilter("all") });
  }
  const clearFilters = () => {
    setSearchQuery("");
    setCityFilter("all");
    setTypeFilter("all");
    setBedsFilter("all");
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Are you sure you want to delete "${name}"?`)) return;

    clearNotice();
    const result = await deleteProperty(id);
    if (result.ok) {
      showNotice({ tone: "success", title: `Deleted "${name}".` });
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

  const handleEdit = (property: Property) => {
    setEditingProperty(property);
    setIsFormOpen(true);
  };

  /**
   * Clicking a property opens its costs. The name and the Costs control are
   * real links, for the keyboard and for opening in a new tab; a click
   * anywhere else on the row goes to the same place. A click on a control is
   * that control's own, and one that ends a text selection is not a click.
   */
  const openCosts = (event: MouseEvent<HTMLTableRowElement>, id: string) => {
    if ((event.target as HTMLElement).closest("a, button")) return;
    if (window.getSelection()?.toString()) return;
    router.push(costsHref(id));
  };

  const handleAddNew = () => {
    setEditingProperty(null);
    setIsFormOpen(true);
  };

  const handleSaveContent = () => {
    setIsFormOpen(false);
    fetchProperties();
  };

  const handleSeedDatabase = async () => {
    if (confirm("Are you sure you want to seed the database with mock properties? This will add them to Firestore.")) {
      setIsLoading(true);
      const { properties: staticProps } = await import("@/app/data/properties");
      const failures: string[] = [];
      for (const p of staticProps) {
        const { id: _id, ...dataToSave } = p;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await addProperty(dataToSave as any);
        if (!result.ok) {
          failures.push(`${p.name}: ${result.error}`);
        }
      }
      if (failures.length > 0) {
        showNotice({
          tone: "error",
          title: `${failures.length} of ${staticProps.length} seed properties failed to save.`,
          items: failures.slice(0, 5),
        });
      }
      await fetchProperties();
    }
  };

  const getTypeBadgeClass = (type: string) => {
    switch (type.toLowerCase()) {
      case "condo": return styles.badgeCondo;
      case "house": return styles.badgeHouse;
      case "basement": return styles.badgeBasement;
      default: return styles.badgeDefault;
    }
  };

  return (
    <PinGate>
    <div className={styles.container}>
      {/* ── Header ── the shared one; this page's action is Add Property */}
      <AdminHeader current="properties">
        <button type="button" className={styles.btnPrimary} onClick={handleAddNew}>
          <Plus size={16} aria-hidden />
          <span>Add Property</span>
        </button>
      </AdminHeader>

      <main className={styles.main}>
        {/* ── Notices (deletes, seeding) ── */}
        <NoticeBanner notice={notice} onDismiss={clearNotice} className={styles.pageNotice} />

        {/* ── The four figures: each a link to where the work is (components/DashboardStats.tsx) ── */}
        <DashboardStats />

        {/* ── Search, filters and sort (2026-09-30) ──
            Search matches every word typed against the name, location, city,
            area, type and slug. The filters narrow by city, type and bedrooms,
            each option with its count; sort stands apart on the right. What is
            active shows as chips under the bar, each removable, with the count
            of what is left. "/" puts the cursor in the search. */}
        {!isLoading && properties.length > 0 && (
          <section className={styles.toolbar} aria-label="Search, filters and sort">
            <div className={styles.toolbarRow}>
              <div className={styles.searchWrapper}>
                <Search size={16} className={styles.searchIcon} aria-hidden />
                <input
                  ref={searchRef}
                  type="search"
                  className={styles.searchInput}
                  placeholder="Search by name, area, city or type"
                  aria-label="Search properties by name, area, city or type"
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

              <div className={styles.filterGroup}>
                <AdminSelect
                  label="City"
                  icon={<MapPin size={14} />}
                  value={cityFilter}
                  onChange={setCityFilter}
                  groups={[{ options: [{ value: "all", label: "All cities" }, ...cities.map((c) => ({ value: c.value, label: `${c.value} (${c.count})` }))] }]}
                />
                <AdminSelect
                  label="Type"
                  icon={<Building2 size={14} />}
                  value={typeFilter}
                  onChange={setTypeFilter}
                  groups={[{ options: [{ value: "all", label: "All types" }, ...propertyTypes.map((t) => ({ value: t.value, label: `${t.value} (${t.count})` }))] }]}
                />
                <AdminSelect
                  label="Bedrooms"
                  icon={<BedDouble size={14} />}
                  value={bedsFilter}
                  onChange={(value) => setBedsFilter(value as BedsFilter)}
                  groups={[{ options: bedroomOptions.map((o) => ({ value: o.value, label: o.value === "all" ? o.label : `${o.label} (${o.count})` })) }]}
                />
              </div>

              <AdminSelect
                className={styles.sortSelect}
                label="Sort"
                icon={<ArrowUpDown size={14} />}
                value={sortBy}
                onChange={(value) => setSortBy(value as SortOption)}
                groups={[{ options: SORT_OPTIONS }]}
              />
            </div>

            <div className={styles.toolbarStatus}>
              <span className={styles.resultCount} aria-live="polite">
                {activeFilters.length === 0
                  ? `${properties.length} properties`
                  : `${filteredProperties.length} of ${properties.length}`}
              </span>
              {activeFilters.map((filter) => (
                <button key={filter.key} type="button" className={styles.chip} onClick={filter.clear} aria-label={`Remove ${filter.label}`}>
                  <span>{filter.label}</span>
                  <X size={12} aria-hidden />
                </button>
              ))}
              {activeFilters.length > 1 && (
                <button type="button" className={styles.clearAll} onClick={clearFilters}>
                  Clear all
                </button>
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
            <button className={styles.btnPrimary} onClick={handleAddNew}>
              <Plus size={18} />
              <span>Create Property</span>
            </button>
          </div>
        ) : filteredProperties.length === 0 ? (
          <div className={styles.empty}>
            <Search size={48} strokeWidth={1} />
            <h2>No matching properties</h2>
            <p>Nothing matches {activeFilters.map((filter) => filter.label).join(" · ")}. Try fewer words, or another city, type or bedroom count.</p>
            <button type="button" className={styles.btnGhost} onClick={clearFilters}>
              <X size={15} aria-hidden />
              <span>Clear search and filters</span>
            </button>
          </div>
        ) : (
          <div className={`${styles.tableContainer} ${styles.tableScroll}`}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Property</th>
                  <th>Location</th>
                  <th>Type</th>
                  <th>Beds</th>
                  <th>Price / Night</th>
                  <th className={styles.actionsHeader}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredProperties.map((p) => (
                  <tr
                    key={p.id}
                    className={styles.propertyRow}
                    onClick={(event) => openCosts(event, p.id)}
                    aria-label={`Open the costs for ${p.name}`}
                  >
                    <td>
                      {/* The picture and the name are one link to the property's costs. Not prefetched:
                          every row in view would ask the server for the costs page before anyone clicked. */}
                      <Link href={costsHref(p.id)} prefetch={false} className={styles.propertyCell}>
                        <span className={styles.thumbWrapper}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={p.coverImage} alt="" className={styles.thumb} />
                        </span>
                        <span className={styles.propertyName}>{p.name}</span>
                      </Link>
                    </td>
                    <td><span className={styles.locationText}>{p.location}</span></td>
                    <td>
                      <span className={`${styles.typeBadge} ${getTypeBadgeClass(p.type)}`}>
                        {p.type}
                      </span>
                    </td>
                    <td><span className={styles.bedsText}>{p.bedrooms}</span></td>
                    <td><span className={styles.priceText}>${nightlyPrice(p).toLocaleString()} {p.currency}</span></td>
                    {/* A click in this cell that misses a control does nothing: it is beside Delete. */}
                    <td className={styles.actionsCell} onClick={(event) => event.stopPropagation()} title="">
                      <div className={styles.actionsFlex}>
                        <Link
                          href={costsHref(p.id)}
                          prefetch={false}
                          className={styles.rowAction}
                          title={`Costs for ${p.name}: its ledger, dates and exports`}
                        >
                          <Receipt size={14} aria-hidden />
                          <span>Costs</span>
                        </Link>
                        <button type="button" className={styles.rowAction} onClick={() => handleEdit(p)} title={`Edit ${p.name}`}>
                          <Edit2 size={14} aria-hidden />
                          <span>Edit</span>
                        </button>
                        <button
                          type="button"
                          className={styles.iconBtnDelete}
                          onClick={() => handleDelete(p.id, p.name)}
                          title="Delete"
                          aria-label={`Delete ${p.name}`}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>

      {isFormOpen && (
        <PropertyForm
          initialData={editingProperty || undefined}
          onClose={() => setIsFormOpen(false)}
          onSave={handleSaveContent}
        />
      )}
    </div>
    </PinGate>
  );
}
