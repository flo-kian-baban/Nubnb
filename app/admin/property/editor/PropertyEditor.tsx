"use client";

/**
 * The property editor (dispatch 30, Kian's rulings of 2026-10-10): creating
 * and editing a property on their own pages, /admin/property/new and
 * /admin/property/edit?id=…, with no native browser control anywhere on them.
 *
 *   Head      back to Properties; the title; Unlisted when it is; the
 *             property's page and its public page, when it has one
 *   Rail      every section, in three groups — Import, Listing, Nubnb only —
 *             each one click away, each marked complete, missing n, "n to
 *             check" after an import, or "n" refused by the server
 *   Panel     the chosen section alone, its missing fields named in its head
 *   Header    Save, the page's action, with the unsaved state beside it
 *
 * ── What is edited ──
 * One draft: the property document as it will be sent, and the three things
 * kept apart from it in their own collections — unlisted, the name cleaners
 * see, the statements record. `held` is what the server holds as far as the
 * page knows; the page is dirty when the draft differs from it.
 *
 * ── Save ──
 * An open row edit is applied or refused first; then the fields the server
 * would refuse a property without are checked, and the first one missing is
 * pointed at; then the statements record is checked. Only then is anything
 * written, in the dispatch-29 order: unlisted first on an edit, the document,
 * the name for cleaners, the statements record, the image mirror. A new
 * property becomes its own edit page once created.
 *
 * ── Leaving ──
 * A click on a link that leaves the page with unsaved changes opens Nubnb's
 * dialog. The browser's own prompt is a native confirm dialog and is not
 * used (§35.3 of the design doc); unsaved changes are kept in the tab's
 * session storage and restored on return to the same page in the same tab,
 * while the stored document is still what it was.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowLeft, BedDouble, Brush, CalendarDays, Check, Eye, ExternalLink, FileText, Home, ImageIcon, Link2, ListChecks, Lock, MapPin, RefreshCw, ScrollText, Sparkles, Star, Tag } from "lucide-react";
import type { Property } from "@/app/types/property";
import type { ExtractionSummary, ScrapeFieldStatus } from "@/app/types/scrape";
import { AdminHeader } from "../../components/AdminHeader";
import { NoticeBanner, useNotice, type Notice } from "../../components/Notice";
import { PinGate } from "../../components/PinGate";
import {
  addProperty,
  getAdminProperty,
  getCleanerFacingName,
  getManagement,
  setCleanerFacingName,
  setManagement,
  setUnlisted,
  updateProperty,
  type MutationIssue,
} from "@/app/lib/firebase/properties";
import { hasPriceDivergence, nightlyPrice } from "@/app/lib/price";
import { normalizeAirbnbUrl } from "@/app/lib/api/validate";
import { describeErrorBody, describeHttpFailure, readErrorBody } from "@/app/lib/api/http-failure";
import { toSlug } from "@/app/lib/slug";
import { ActionBar, Dialog } from "./controls";
import {
  GROUP_LABELS,
  SECTIONS,
  clockTime,
  MIRROR_FIELDS,
  draftFromStored,
  emptyManagement,
  fingerprint,
  forgetKeptDraft,
  isSectionId,
  issueSection,
  keepDraft,
  managementFromRecord,
  managementPayload,
  missingFields,
  newPropertyDraft,
  propertyPayload,
  readKeptDraft,
  sectionStates,
  serializeDraft,
  type EditorDraft,
  type ManagementDraft,
  type SectionGroup,
  type SectionId,
  type SectionState,
} from "./model";
import { useRowEdits } from "./row-edits";
import type { LoadState, RowEdit, SectionContext } from "./shared";
import { BasicsSection, HighlightsSection, LocationSection, PhotosSection, ReviewsSection, RulesSection, SpaceSection, type MapsTool } from "./sections-listing";
import { OffersSection } from "./sections-offers";
import { CalendarSection, CleanersSection, StatementsSection, StatusSection } from "./sections-internal";
import { AirbnbTitleSection } from "./section-airbnb-title";
import { ImportSection, type ImportTool } from "./sections-import";
import { CALENDAR_MISMATCH_TEXT } from "@/app/lib/listing-identity";
import shared from "../../page.module.css";
import styles from "./editor.module.css";

const SESSION_HINT = "Your admin session may have expired. Open the admin in a new tab to sign in again, then save — your entries here are kept.";

type Mode = { mode: "new" } | { mode: "edit"; id: string };

interface PageProps {
  mode: Mode;
  /** The section the address bar asked for. */
  section: string | null;
  /** The page was reached from a create: say so, and how the mirror went. */
  created: boolean;
  mirror: string | null;
  /** "warn" when the create answered a warning about its links (dispatch 34: a calendar for another Airbnb room). */
  links?: string | null;
}

/** What the server holds, as far as the page knows: the three things saved apart from the document, and their load states. */
interface Loaded {
  stored: Property | null;
  unlisted: boolean;
  cleanerName: string;
  cleanerNameState: LoadState;
  management: ManagementDraft;
  managementState: LoadState;
}

type Read = { kind: "loading" } | { kind: "error"; title: string; status: number } | { kind: "ready"; loaded: Loaded };

/** The page: the PIN gate, the read, then the editor. */
export function PropertyEditorPage(props: PageProps) {
  return (
    <PinGate>
      <Loader {...props} />
    </PinGate>
  );
}

function Loader(props: PageProps) {
  const { mode } = props;
  const id = mode.mode === "edit" ? mode.id : null;
  const [read, setRead] = useState<Read>(() =>
    id === null
      ? { kind: "ready", loaded: { stored: null, unlisted: false, cleanerName: "", cleanerNameState: "none", management: emptyManagement(), managementState: "none" } }
      : { kind: "loading" },
  );
  const [attempt, setAttempt] = useState(0);
  const retry = () => {
    setRead({ kind: "loading" });
    setAttempt((n) => n + 1);
  };

  useEffect(() => {
    if (id === null) return;
    let cancelled = false;
    Promise.all([getAdminProperty(id), getCleanerFacingName(id), getManagement(id)]).then(([property, name, management]) => {
      if (cancelled) return;
      if (!property.ok) {
        setRead({ kind: "error", title: property.error, status: property.status });
        return;
      }
      setRead({
        kind: "ready",
        loaded: {
          stored: property.data.property,
          unlisted: property.data.unlisted,
          cleanerName: name.ok ? (name.data ?? "") : "",
          cleanerNameState: name.ok ? "ready" : "unavailable",
          management: management.ok ? managementFromRecord(management.data) : emptyManagement(),
          managementState: management.ok ? "ready" : "unavailable",
        },
      });
    });
    return () => {
      cancelled = true;
    };
  }, [id, attempt]);

  if (read.kind === "loading") {
    return (
      <div className={shared.container}>
        <AdminHeader current="properties" title="Property" />
        <main className={shared.main}>
          <div className={shared.loading}>
            <div className={shared.spinner} />
            <p>Loading the property…</p>
          </div>
        </main>
      </div>
    );
  }

  if (read.kind === "error") {
    const gone = read.status === 404;
    return (
      <div className={shared.container}>
        <AdminHeader current="properties" title="Property" />
        <main className={shared.main}>
          <div className={`${shared.empty} ${shared.loadError}`} role="alert">
            <AlertTriangle size={48} strokeWidth={1} />
            <h2>{gone ? "No property has this ID" : "Could not load the property"}</h2>
            <p>{gone ? "It may have been deleted. The list shows what exists." : `It has not loaded.${read.status === 401 || read.status === 403 ? " Your admin session may have expired — reload and sign in again." : ""}`}</p>
            {!gone && <code className={shared.loadErrorDetail}>{read.title}</code>}
            {gone ? (
              <Link href="/admin" prefetch={false} className={shared.btnPrimary}>
                Go to Properties
              </Link>
            ) : (
              <button type="button" className={shared.btnPrimary} onClick={retry}>
                <RefreshCw size={18} aria-hidden />
                <span>Retry</span>
              </button>
            )}
          </div>
        </main>
      </div>
    );
  }

  return <Editor key={`${id ?? "new"}:${attempt}`} id={id} loaded={read.loaded} initialSection={props.section} created={props.created} mirror={props.mirror} links={props.links ?? null} />;
}

// ─── The editor ───────────────────────────────────────────────

interface EditorProps {
  id: string | null;
  loaded: Loaded;
  initialSection: string | null;
  created: boolean;
  mirror: string | null;
  links: string | null;
}

/** What the page knows the server holds, in the draft's shape. */
const heldDraft = (held: Loaded, property: Partial<Property>): EditorDraft => ({ property, unlisted: held.unlisted, cleanerName: held.cleanerName, management: held.management });

const rowEditSection = (edit: RowEdit): SectionId => (edit.kind === "offer" ? "offers" : edit.kind === "highlight" ? "highlights" : "rules");

/** The rail's icon for each section. */
const SECTION_ICON: Record<SectionId, typeof Home> = {
  import: Link2,
  photos: ImageIcon,
  basics: Home,
  location: MapPin,
  space: BedDouble,
  highlights: Sparkles,
  offers: ListChecks,
  rules: ScrollText,
  reviews: Star,
  status: Eye,
  cleaners: Brush,
  statements: FileText,
  calendar: CalendarDays,
  airbnbTitle: Tag,
};

/** Which section a field is in, for pointing at it. */
function sectionOfField(field: string): SectionId | null {
  if (field === "unlisted" || field === "management.excluded") return "status";
  if (field.startsWith("management.")) return "statements";
  if (field === "cleanerName") return "cleaners";
  if (field.startsWith("coordinates")) return "location";
  return issueSection(field) ?? null;
}

async function mirrorImages(id: string): Promise<{ ok: true } | { ok: false; detail: string }> {
  try {
    const res = await fetch("/api/mirror-property-images", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    if (!res.ok) {
      const failure = await describeHttpFailure(res, "Images were not mirrored");
      return { ok: false, detail: failure.title };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : "The mirroring request failed." };
  }
}

const MIRROR_FAILED = "The property itself is saved and its previously mirrored images are unchanged. Save again to retry, or run scripts/mirror-images.mjs.";

function Editor({ id, loaded, initialSection, created, mirror, links }: EditorProps) {
  const router = useRouter();
  const mode: "new" | "edit" = id === null ? "new" : "edit";
  const { notice, show, clear } = useNotice();

  // ── What the server holds, and what is typed ──
  const [stored, setStored] = useState<Property | null>(loaded.stored);
  const [held, setHeld] = useState<Loaded>(loaded);
  const [heldProperty, setHeldProperty] = useState<Partial<Property>>(() => (loaded.stored ? draftFromStored(loaded.stored) : newPropertyDraft()));
  const [draft, setDraft] = useState<EditorDraft>(() => heldDraft(loaded, loaded.stored ? draftFromStored(loaded.stored) : newPropertyDraft()));
  const setProperty = useCallback((update: (prev: Partial<Property>) => Partial<Property>) => setDraft((prev) => ({ ...prev, property: update(prev.property) })), []);
  const serialized = useMemo(() => serializeDraft(draft), [draft]);
  const heldSerialized = useMemo(() => serializeDraft(heldDraft(held, heldProperty)), [held, heldProperty]);
  const dirty = serialized !== heldSerialized;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // ── The section ──
  const [section, setSection] = useState<SectionId>(() => (isSectionId(initialSection) ? initialSection : mode === "new" ? "import" : "photos"));
  useEffect(() => {
    const url = new URL(window.location.href);
    const wanted = section === (mode === "new" ? "import" : "photos") ? null : section;
    if (wanted === null) url.searchParams.delete("section");
    else url.searchParams.set("section", wanted);
    url.searchParams.delete("created");
    url.searchParams.delete("mirror");
    url.searchParams.delete("links");
    if (url.href !== window.location.href) window.history.replaceState(null, "", url.href);
  }, [section, mode]);

  // ── Marks: what the server refused, what the import left to check, what is missing ──
  const [issues, setIssues] = useState<MutationIssue[]>([]);
  const [fieldStatus, setFieldStatus] = useState<ScrapeFieldStatus | null>(null);
  const [attempted, setAttempted] = useState(false);
  const states = useMemo(() => sectionStates(draft, fieldStatus, issues), [draft, fieldStatus, issues]);

  // ── Saving ──
  const [saving, setSaving] = useState<"idle" | "saving" | "mirroring">("idle");
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  // ── Leaving, and unsaved work kept in the tab ──
  const [leaveTo, setLeaveTo] = useState<string | null>(null);
  const leavingRef = useRef(false);
  const [restored, setRestored] = useState<string | null>(null);

  const rows = useRowEdits(draft.property, stored, setProperty);

  // The page was reached from a create (dispatch 30): say so once.
  useEffect(() => {
    if (!created) return;
    if (mirror === "failed") show({ tone: "warning", title: "Created — but the images were not mirrored.", detail: MIRROR_FAILED });
    else if (links === "warn") show({ tone: "warning", title: "Created — but check the links.", items: [CALENDAR_MISMATCH_TEXT] });
    else show({ tone: "success", title: "Created." });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Unsaved changes kept in this tab: restored when the stored document is still what it was.
  useEffect(() => {
    const kept = readKeptDraft(id);
    if (!kept) return;
    if (kept.base === fingerprint(heldSerialized)) {
      setDraft(kept.draft);
      setRestored(kept.at);
    } else {
      forgetKeptDraft(id);
      show({ tone: "info", title: "Unsaved changes from earlier were not restored: the property changed since." });
    }
    // Once, on opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (leavingRef.current) return;
    if (!dirty) {
      forgetKeptDraft(id);
      return;
    }
    const timer = window.setTimeout(() => keepDraft(id, { at: new Date().toISOString(), base: fingerprint(heldSerialized), draft }), 300);
    return () => window.clearTimeout(timer);
  }, [dirty, draft, heldSerialized, id]);

  // A click on a link that leaves this page with unsaved changes asks first, in Nubnb's own dialog.
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (!dirtyRef.current || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      event.preventDefault();
      event.stopPropagation();
      setLeaveTo(url.pathname + url.search + url.hash);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  const leave = () => {
    if (!leaveTo) return;
    leavingRef.current = true;
    forgetKeptDraft(id);
    router.push(leaveTo);
  };

  // ── Pointing at a field: its section opens, it scrolls into view, the keyboard goes to it ──
  const pointAt = useCallback(
    (field: string) => {
      const target = sectionOfField(field);
      if (target) setSection(target);
      window.setTimeout(() => {
        const el = document.querySelector<HTMLElement>(`[data-field="${field}"]`) ?? document.querySelector<HTMLElement>(`[data-field^="${field}."]`);
        if (!el) return;
        el.scrollIntoView({ block: "center" });
        const focusable = el.matches("input, textarea, button") ? el : el.querySelector<HTMLElement>("input:not([type=file]), textarea, button");
        focusable?.focus({ preventScroll: true });
      }, 60);
    },
    [],
  );

  const goTo = useCallback((next: SectionId) => setSection(next), []);

  // ── Save ──
  const save = useCallback(async () => {
    if (saving !== "idle") return;
    clear();

    // An open row edit is part of what is saved: apply it, or point at what is wrong and save nothing.
    const applied = rows.commitForSave(draft.property);
    if ("problem" in applied) {
      if (rows.rowEdit) setSection(rowEditSection(rows.rowEdit));
      window.setTimeout(() => document.querySelector<HTMLElement>("[data-row-edit] input")?.focus(), 60);
      show({ tone: "error", title: `Not saved — ${applied.problem}` });
      return;
    }
    const current: EditorDraft = applied.data === draft.property ? draft : { ...draft, property: applied.data };
    if (current !== draft) setDraft(current);

    // The fields the server would refuse a property without.
    setAttempted(true);
    const blocking = missingFields(current).filter((m) => m.blocking);
    if (blocking.length > 0) {
      show({ tone: "error", title: `Not saved — ${blocking.length === 1 ? "a required field is" : `${blocking.length} required fields are`} empty.`, items: blocking.map((m) => m.label) });
      pointAt(blocking[0].field);
      return;
    }

    // The statements record, before anything is written.
    const management = managementPayload(current.management);
    if ("problem" in management) {
      setIssues([{ path: management.field, message: management.problem }]);
      show({ tone: "error", title: `Not saved — ${management.problem}` });
      pointAt(management.field);
      return;
    }

    setSaving("saving");
    setIssues([]);
    const payload = propertyPayload(current, stored);
    let unlistedHeld = held.unlisted;

    // Unlisted first on an edit (dispatch 24): the property leaves the public site before any other change is published.
    if (id !== null && current.unlisted !== held.unlisted) {
      const shown = await setUnlisted(id, current.unlisted);
      if (!shown.ok) {
        setSaving("idle");
        show({ tone: "error", title: `Not saved — ${shown.error}`, detail: shown.status === 401 || shown.status === 403 ? SESSION_HINT : "Nothing was saved. Your entries are kept; save again to retry." });
        return;
      }
      unlistedHeld = shown.data.unlisted;
      setHeld((prev) => ({ ...prev, unlisted: shown.data.unlisted }));
    }

    const result = id !== null ? await updateProperty(id, payload) : await addProperty(payload as Omit<Property, "id">, { unlisted: current.unlisted });
    if (!result.ok) {
      setSaving("idle");
      setIssues(result.issues);
      show({
        tone: "error",
        title: result.issues.length > 0 ? `Not saved — ${result.issues.length === 1 ? "1 field" : `${result.issues.length} fields`} refused by the server.` : `Not saved — ${result.error}`,
        detail:
          result.status === 401 || result.status === 403
            ? SESSION_HINT
            : result.status === 0
              ? "The request never reached the server. Your entries are kept; check your connection and try again."
              : result.issues.length > 0
                ? "The refused fields are marked in their sections. Nothing you typed has been lost."
                : `HTTP ${result.status}. Your entries are kept.`,
      });
      if (result.issues.length > 0) pointAt(result.issues[0].path);
      return;
    }
    const savedId = id ?? result.data.id;
    /** The same listing or calendar on another property, or a calendar for another room (dispatch 34): saved, and said. */
    const linkWarnings = result.data.warnings;

    // The document is saved. The draft's links and slug are now what was written.
    const settled: Partial<Property> = { ...current.property, price: payload.price, slug: payload.slug };
    for (const key of ["airbnbUrl", "googleMapsUrl", "icalUrl"] as const) {
      if (key in payload) settled[key] = payload[key];
      else delete settled[key];
    }
    if (id !== null) {
      setStored((prev) => (prev ? ({ ...prev, ...payload } as Property) : prev));
      setHeldProperty(settled);
      setHeld((prev) => ({ ...prev, unlisted: unlistedHeld }));
      setDraft((prev) => ({ ...prev, property: settled }));
    }

    // The name cleaners see, as its own write, when it changed.
    const warnings: Notice[] = linkWarnings.length > 0 ? [{ tone: "warning", title: "Saved — but check the links.", items: [...new Set(linkWarnings.map((w) => w.message))] }] : [];
    if (held.cleanerNameState !== "unavailable") {
      const typed = current.cleanerName.trim();
      if (typed !== held.cleanerName) {
        const named = await setCleanerFacingName(savedId, typed === "" ? null : typed);
        if (!named.ok) warnings.push({ tone: "warning", title: "Saved — but the name for cleaners was not.", detail: `${named.error} The property itself is saved. Save again to retry the name.` });
        else {
          setHeld((prev) => ({ ...prev, cleanerName: named.data.name ?? "" }));
          setDraft((prev) => ({ ...prev, cleanerName: named.data.name ?? "" }));
        }
      }
    }

    // The statements record, as its own write, when it changed.
    if (held.managementState !== "unavailable" && JSON.stringify(current.management) !== JSON.stringify(held.management)) {
      const kept = await setManagement(savedId, management.record);
      if (!kept.ok) warnings.push({ tone: "warning", title: "Saved — but the statements record was not.", detail: `${kept.error} The property itself is saved. Save again to retry.` });
      else setHeld((prev) => ({ ...prev, management: current.management }));
    }

    // The images, as a separate step after the save: a slow CDN must not fail a write that had nothing wrong with it.
    setSaving("mirroring");
    const mirrored = await mirrorImages(savedId);

    // The mirror writes the stored image fields; read the document again so the page holds what the server
    // holds and the next save sends those fields fresh. A failed re-read changes nothing: the save is done.
    if (id !== null) {
      const fresh = await getAdminProperty(id);
      if (fresh.ok) {
        const mirrorFields: Partial<Property> = {};
        for (const key of MIRROR_FIELDS) {
          const value = (fresh.data.property as unknown as Record<string, unknown>)[key];
          if (value !== undefined) (mirrorFields as Record<string, unknown>)[key] = value;
        }
        setStored(fresh.data.property);
        setHeldProperty((prev) => ({ ...prev, ...mirrorFields }));
        setDraft((prev) => ({ ...prev, property: { ...prev.property, ...mirrorFields } }));
      }
    }
    setSaving("idle");

    if (id === null) {
      leavingRef.current = true;
      forgetKeptDraft(null);
      router.replace(`/admin/property/edit?id=${encodeURIComponent(savedId)}&created=1${mirrored.ok ? "" : "&mirror=failed"}${linkWarnings.length > 0 ? "&links=warn" : ""}`);
      return;
    }

    setSavedAt(new Date());
    setAttempted(false);
    if (!mirrored.ok) show({ tone: "warning", title: "Saved — but the images were not mirrored.", detail: `${mirrored.detail} ${MIRROR_FAILED}` });
    else if (warnings.length > 0) show(warnings[0]);
    else show({ tone: "success", title: "Saved." });
  }, [saving, clear, rows, draft, stored, held, id, show, pointAt, router]);

  // Cmd/Ctrl+S saves.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  // ── The Airbnb import (the dispatch-29 flow) ──
  const [importing, setImporting] = useState(false);
  const [importNotice, setImportNotice] = useState<Notice | null>(null);
  const [summary, setSummary] = useState<ExtractionSummary | null>(null);
  const runImport = useCallback(async () => {
    const typed = (draft.property.airbnbUrl ?? "").trim();
    if (!typed || !typed.includes("airbnb")) {
      setImportNotice({ tone: "error", title: "Paste the Airbnb listing's link first." });
      return;
    }
    setImporting(true);
    setImportNotice(null);
    // The canonical listing URL, not whatever was pasted: a URL copied out of a search carries dates that change the page.
    const scrapeUrl = normalizeAirbnbUrl(typed);
    if (scrapeUrl !== typed) setProperty((prev) => ({ ...prev, airbnbUrl: scrapeUrl }));
    try {
      const res = await fetch("/api/scrape-airbnb", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: scrapeUrl }) });
      if (!res.ok) {
        const errData = await readErrorBody(res);
        const failure = describeErrorBody(errData, res.status, "Import failed");
        setFieldStatus(null);
        setSummary(null);
        setImportNotice({
          tone: "error",
          title: failure.title,
          detail: failure.detail,
          items: errData.evidence ? Object.entries(errData.evidence as Record<string, string | number>).map(([k, v]) => `${k}: ${v}`) : undefined,
        });
        return;
      }
      const result = await res.json();
      const data = result.data;
      const status: ScrapeFieldStatus = data.fieldStatus || {};
      const read: ExtractionSummary | null = data.extractionSummary || null;
      setFieldStatus(status);
      setSummary(read);
      // The import replaces the lists a row edit points into.
      rows.cancel();
      setProperty((prev) => ({
        ...prev,
        name: data.name || prev.name,
        description: data.description || prev.description,
        guests: data.guests || prev.guests,
        bedrooms: data.bedrooms || prev.bedrooms,
        beds: data.beds || prev.beds,
        bathrooms: data.bathrooms || prev.bathrooms,
        coverImage: data.coverImage || prev.coverImage,
        images: data.images?.length ? data.images : prev.images,
        propertyTypeTag: data.propertyTypeTag || prev.propertyTypeTag || "Entire home",
        highlights: data.highlights?.length ? data.highlights : prev.highlights,
        amenities: data.amenities?.length ? data.amenities.slice(0, 8) : prev.amenities,
        offers: data.offers?.length ? data.offers : prev.offers,
        // Location: the geocoder is the source of truth; the scraped value only fills an empty field.
        location: prev.location || data.location || "",
        // The price is not imported: whatever the admin has entered stands.
        price: prev.price,
        priceInfo: {
          nightly: prev.priceInfo?.nightly || 0,
          weekly: prev.priceInfo?.weekly || 0,
          monthly: prev.priceInfo?.monthly || 0,
          weekend: prev.priceInfo?.weekend || 0,
          cleaningFee: prev.priceInfo?.cleaningFee || 0,
          minNights: prev.priceInfo?.minNights || 1,
        },
        details: { checkIn: data.checkIn || prev.details?.checkIn || "4:00 PM", checkOut: data.checkOut || prev.details?.checkOut || "11:00 AM" },
        terms: {
          smokingAllowed: data.smokingAllowed ?? prev.terms?.smokingAllowed ?? false,
          petsAllowed: data.petsAllowed ?? prev.terms?.petsAllowed ?? false,
          partyAllowed: data.partyAllowed ?? prev.terms?.partyAllowed ?? false,
          childrenAllowed: prev.terms?.childrenAllowed ?? true,
          cancellationPolicy: prev.terms?.cancellationPolicy || "Flexible",
          rules: data.rules?.length ? data.rules : prev.terms?.rules || [],
        },
        reviews: data.reviews?.length ? data.reviews : prev.reviews || [],
        averageRating: data.averageRating || prev.averageRating || 0,
        totalReviewCount: data.totalReviewCount || prev.totalReviewCount || 0,
        airbnbUrl: scrapeUrl || prev.airbnbUrl || "",
      }));
      const warnings: string[] = Array.isArray(data.warnings) ? data.warnings : [];
      const incomplete = read ? read.defaulted + read.failed : 0;
      setImportNotice({
        tone: incomplete > 0 || warnings.length > 0 ? "warning" : "success",
        title: read ? `Imported "${data.name}" — ${read.extracted} of ${read.total} fields read, ${read.defaulted} defaulted, ${read.failed} not found${read["admin-entered"] ? `, ${read["admin-entered"]} for you to enter.` : "."}` : `Imported "${data.name}".`,
        detail: incomplete > 0 ? "The sections marked “to check” hold fields that were not read from the listing. Check every one before saving." : "Review the sections, then save.",
        items: warnings.length > 0 ? warnings : undefined,
      });
    } catch (err) {
      setFieldStatus(null);
      setSummary(null);
      setImportNotice({ tone: "error", title: err instanceof Error ? err.message : "Import failed. Try again.", detail: "Nothing was imported." });
    } finally {
      setImporting(false);
    }
  }, [draft.property.airbnbUrl, rows, setProperty]);
  const importer: ImportTool = { notice: importNotice, summary, importing, run: () => void runImport(), dismiss: () => setImportNotice(null) };

  // ── Get Location (the dispatch-29 flow) ──
  const [locating, setLocating] = useState(false);
  const [mapsNotice, setMapsNotice] = useState<Notice | null>(null);
  const locate = useCallback(async () => {
    const link = (draft.property.googleMapsUrl ?? "").trim();
    if (!link) {
      setMapsNotice({ tone: "error", title: "Paste a Google Maps link first." });
      return;
    }
    if (!link.includes("google") && !link.includes("goo.gl") && !link.includes("maps.app")) {
      setMapsNotice({ tone: "error", title: "That is not a Google Maps link." });
      return;
    }
    setLocating(true);
    setMapsNotice(null);
    try {
      const res = await fetch("/api/parse-google-maps", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: link }) });
      if (!res.ok) {
        const failure = await describeHttpFailure(res, "Could not read that Google Maps link");
        setMapsNotice({ tone: "error", title: failure.title, detail: failure.detail });
        return;
      }
      const result = await res.json();
      const data = result.data;
      setProperty((prev) => ({
        ...prev,
        coordinates: data.coordinates || prev.coordinates,
        location: data.location || prev.location,
        addressDetails: {
          city: data.addressDetails?.city || prev.addressDetails?.city || "",
          state: data.addressDetails?.state || prev.addressDetails?.state || "",
          area: data.addressDetails?.area || prev.addressDetails?.area || "",
          country: data.addressDetails?.country || prev.addressDetails?.country || "",
        },
        googleMapsUrl: link || prev.googleMapsUrl || "",
      }));
      const addr = data.addressDetails || {};
      const missing = (["city", "state", "area", "country"] as const).filter((k) => !addr[k]);
      const coords = `${data.lat?.toFixed(4)}, ${data.lng?.toFixed(4)}`;
      if (missing.length === 4) setMapsNotice({ tone: "error", title: `Coordinates set (${coords}) — but no address was resolved.`, detail: "City, province, area and country are blank. Fill them in before saving: an empty city drops the property out of the city filter." });
      else if (missing.length > 0) setMapsNotice({ tone: "warning", title: `Location partly resolved (${coords}).`, detail: `Not returned: ${missing.join(", ")}. Fill these in before saving.` });
      else setMapsNotice({ tone: "success", title: `Location set: ${[addr.city, addr.state, addr.area, addr.country].join(", ")} (${coords})` });
    } catch (err) {
      setMapsNotice({ tone: "error", title: err instanceof Error ? err.message : "Could not read the link." });
    } finally {
      setLocating(false);
    }
  }, [draft.property.googleMapsUrl, setProperty]);
  const maps: MapsTool = { notice: mapsNotice, locating, locate: () => void locate(), dismiss: () => setMapsNotice(null) };

  // ── Two stored prices (dispatch 29's warning, above every section) ──
  const priceConflict = useMemo(() => {
    if (!stored || !hasPriceDivergence(stored)) return null;
    return { base: stored.price as number, nightly: stored.priceInfo!.nightly, shown: nightlyPrice(stored) };
  }, [stored]);
  const pendingNightly = draft.property.priceInfo?.nightly ?? 0;

  // ── What the sections are handed ──
  const ctx = (sectionId: SectionId): SectionContext => ({
    mode,
    propertyId: id,
    draft,
    stored,
    setProperty,
    setDraft: setDraft as Dispatch<SetStateAction<EditorDraft>>,
    issues,
    fieldStatus,
    attempted,
    state: states[sectionId],
    show,
    goTo,
    rows,
    cleanerNameState: held.cleanerNameState,
    managementState: held.managementState,
  });

  const name = (draft.property.name ?? "").trim();
  const title = name || (mode === "new" ? "New property" : "Untitled property");
  const publicSlug = stored && !held.unlisted ? toSlug(stored.name) : null;

  const panel = (() => {
    switch (section) {
      case "import":
        return <ImportSection ctx={ctx("import")} importer={importer} />;
      case "photos":
        return <PhotosSection ctx={ctx("photos")} />;
      case "basics":
        return <BasicsSection ctx={ctx("basics")} />;
      case "location":
        return <LocationSection ctx={ctx("location")} maps={maps} />;
      case "space":
        return <SpaceSection ctx={ctx("space")} />;
      case "highlights":
        return <HighlightsSection ctx={ctx("highlights")} />;
      case "offers":
        return <OffersSection ctx={ctx("offers")} />;
      case "rules":
        return <RulesSection ctx={ctx("rules")} />;
      case "reviews":
        return <ReviewsSection ctx={ctx("reviews")} />;
      case "status":
        return <StatusSection ctx={ctx("status")} />;
      case "cleaners":
        return <CleanersSection ctx={ctx("cleaners")} />;
      case "statements":
        return <StatementsSection ctx={ctx("statements")} />;
      case "calendar":
        return <CalendarSection ctx={ctx("calendar")} />;
      case "airbnbTitle":
        return <AirbnbTitleSection ctx={ctx("airbnbTitle")} />;
    }
  })();

  return (
    <div className={shared.container}>
      <AdminHeader current="properties" title={mode === "new" ? "New property" : `Edit ${title}`} />

      <main className={shared.main}>
        {/* ── The head: the property, its links, and Save (Kian's ruling of 2026-10-15: no page's buttons in the
             navigation) ── */}
        <div className={styles.head}>
          <Link href="/admin" prefetch={false} className={styles.backLink}>
            <ArrowLeft size={14} aria-hidden /> Properties
          </Link>
          <div className={styles.titleRow}>
            <h2 className={`${styles.title} ${name ? "" : styles.titleEmpty}`}>{title}</h2>
            {draft.unlisted && (
              <span className={`${shared.stateBadge} ${shared.stateOpen}`} title="Not on the public site">
                Unlisted
              </span>
            )}
            {id !== null && (
              <div className={styles.headLinks}>
                <Link href={`/admin/property?id=${encodeURIComponent(id)}`} prefetch={false} className={shared.btnGhost} title="Costs, income and statements">
                  <FileText size={14} aria-hidden />
                  <span>Property page</span>
                </Link>
                {publicSlug && (
                  <a href={`/property/${publicSlug}`} target="_blank" rel="noopener" className={shared.btnGhost}>
                    <span>View on site</span>
                    <ExternalLink size={13} aria-hidden />
                  </a>
                )}
              </div>
            )}
            <div className={styles.saveBar}>
              <span className={`${styles.saveState} ${dirty ? styles.saveStateUnsaved : ""}`} aria-live="polite">
                {dirty ? (
                  <>
                    <span className={styles.saveDot} aria-hidden />
                    Unsaved changes
                  </>
                ) : savedAt ? (
                  <>
                    <Check size={13} aria-hidden />
                    Saved {clockTime(savedAt)}
                  </>
                ) : null}
              </span>
              <button type="button" className={shared.btnPrimary} onClick={() => void save()} disabled={saving !== "idle"} title="Save (⌘S)">
                {saving === "saving" ? "Saving…" : saving === "mirroring" ? "Saved — mirroring images…" : mode === "new" ? "Create property" : "Save"}
              </button>
            </div>
          </div>
        </div>

        <NoticeBanner notice={notice} onDismiss={clear} className={shared.pageNotice} />

        {restored && (
          <ActionBar
            actionLabel="Discard"
            onAction={() => {
              setDraft(heldDraft(held, heldProperty));
              rows.cancel();
              forgetKeptDraft(id);
              setRestored(null);
            }}
            onDismiss={() => setRestored(null)}
          >
            Unsaved changes from {clockTime(new Date(restored))} were restored. Save them, or discard them.
          </ActionBar>
        )}

        {priceConflict && (
          <div className={styles.priceWarning} role="status">
            <p className={styles.priceWarningHead}>
              <AlertTriangle size={16} aria-hidden /> This property stores two prices
            </p>
            <p className={styles.priceWarningBody}>
              Base price <b>${priceConflict.base.toLocaleString()}</b>, nightly <b>${priceConflict.nightly.toLocaleString()}</b>; renters see <b>${priceConflict.shown.toLocaleString()}</b>. Saving sets both to the nightly price,{" "}
              <b>${pendingNightly.toLocaleString()}</b>
              {pendingNightly === priceConflict.shown ? ", so nothing a renter sees changes." : `, changing what renters see from $${priceConflict.shown.toLocaleString()}.`}{" "}
              <button type="button" className={styles.linkBtn} onClick={() => goTo("space")}>
                Open Space &amp; price
              </button>
            </p>
          </div>
        )}

        <div className={styles.layout}>
          <nav className={styles.rail} aria-label="Sections">
            {(["import", "listing", "internal"] as SectionGroup[]).map((group) => (
              <div key={group} className={styles.railGroup}>
                <div className={`${styles.railGroupLabel} ${group === "internal" ? styles.railGroupInternal : ""}`}>
                  {group === "internal" && <Lock size={11} aria-hidden />}
                  {GROUP_LABELS[group]}
                </div>
                {SECTIONS.filter((s) => s.group === group).map((s) => {
                  const Icon = SECTION_ICON[s.id];
                  return (
                    <button key={s.id} type="button" className={`${styles.railItem} ${section === s.id ? styles.railItemActive : ""}`} aria-current={section === s.id ? "true" : undefined} onClick={() => goTo(s.id)}>
                      <span className={styles.railIcon} aria-hidden>
                        <Icon size={15} />
                      </span>
                      <span className={styles.railLabel}>{s.label}</span>
                      <Mark state={states[s.id]} />
                    </button>
                  );
                })}
              </div>
            ))}
          </nav>
          <div>{panel}</div>
        </div>
      </main>

      {leaveTo !== null && (
        <Dialog
          title="Leave this page?"
          onClose={() => setLeaveTo(null)}
          actions={
            <>
              <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => setLeaveTo(null)}>
                Stay
              </button>
              <button type="button" className={`${styles.btn} ${styles.btnGhost} ${styles.btnDanger}`} onClick={leave}>
                Leave without saving
              </button>
            </>
          }
        >
          <p>
            Your changes to <b>{title}</b> are not saved.
          </p>
        </Dialog>
      )}
    </div>
  );
}

/** The mark at the right of a rail row. */
function Mark({ state }: { state: SectionState }) {
  if (state.refused > 0) {
    return (
      <span className={`${styles.mark} ${styles.markRefused}`} title={`${state.refused} refused by the server`}>
        {state.refused} refused
      </span>
    );
  }
  if (state.toCheck > 0) {
    return (
      <span className={`${styles.mark} ${styles.markCheck}`} title={`${state.toCheck} ${state.toCheck === 1 ? "field was" : "fields were"} not read from the listing`}>
        {state.toCheck} to check
      </span>
    );
  }
  if (!state.checked) return null;
  if (state.missing.length > 0) {
    return (
      <span className={`${styles.mark} ${styles.markMissing}`} title={`Missing: ${state.missing.map((m) => m.label).join(", ")}`}>
        {state.missing.length}
      </span>
    );
  }
  return (
    <span className={`${styles.mark} ${styles.markOk}`} title="Complete">
      <Check size={12} strokeWidth={3} aria-hidden />
    </span>
  );
}

