/**
 * The property editor's rules (dispatch 30), pure: what a draft is, what the
 * page starts from, which sections there are and what each is missing, what
 * is sent on Save, and how unsaved work is kept in the tab.
 *
 * Nothing here touches the network or the DOM. The save rules are the
 * dispatch-29 form's, moved here unchanged where they decide what is written:
 * the one price, the Airbnb link normalised only when typed, empty links left
 * out of a create, the slug made only when empty. An imported property opened
 * and saved untouched must leave its stored document byte-identical, and these
 * rules are what make that true.
 */

import type { Offer, Property } from "@/app/types/property";
import type { PropertyManagementView } from "@/app/lib/reports/model";
import { STATEMENTS_FROM_DEFAULT, isMonth, rateText } from "@/app/lib/reports/model";
import type { ManagementPayload, MutationIssue } from "@/app/lib/firebase/properties";
import { amountField } from "../../costs/cost-display";
import { nightlyPrice } from "@/app/lib/price";
import { normalizeAirbnbUrl } from "@/app/lib/api/validate";
import { toSlug } from "@/app/lib/slug";
import type { ScrapeFieldStatus } from "@/app/types/scrape";

// ─── Choices ──────────────────────────────────────────────────

export const GTA_CITIES = [
  "Toronto, ON", "Mississauga, ON", "Brampton, ON", "Markham, ON",
  "Vaughan, ON", "Richmond Hill, ON", "Oakville, ON", "Burlington, ON",
  "Pickering, ON", "Ajax, ON", "Whitby, ON", "Oshawa, ON", "Milton, ON",
  "Halton Hills, ON", "Aurora, ON", "Newmarket, ON", "King City, ON",
  "Whitchurch-Stouffville, ON", "East Gwillimbury, ON", "Georgina, ON",
  "Brock, ON", "Scugog, ON", "Uxbridge, ON", "Caledon, ON",
];

export const CANADIAN_PROVINCES = [
  "Alberta", "British Columbia", "Manitoba", "New Brunswick",
  "Newfoundland and Labrador", "Nova Scotia", "Ontario",
  "Prince Edward Island", "Quebec", "Saskatchewan",
  "Northwest Territories", "Nunavut", "Yukon",
];

export const PROPERTY_TYPES = ["House", "Apartment", "Villa", "Penthouse", "Estate", "Residence", "Ranch", "Condo", "Basement"];
export const PROPERTY_TYPE_TAGS = ["Entire home", "Entire condo", "Entire guest suite", "Private room", "Shared room"];

/** Mirrors ALLOWED_TYPES in /api/upload-image. SVG and HEIC are not accepted. */
export const ACCEPTED_IMAGE_TYPES = "image/jpeg,image/png,image/webp,image/avif";

/** The gallery is complete from this many photos, the cover counted. */
export const PHOTOS_WANTED = 6;
export const HIGHLIGHTS_MAX = 3;
export const STARS_MAX = 6;

// ─── Sections ─────────────────────────────────────────────────

export type SectionId =
  | "import"
  | "photos" | "basics" | "location" | "space" | "highlights" | "offers" | "rules" | "reviews"
  | "status" | "cleaners" | "statements" | "calendar";

export type SectionGroup = "import" | "listing" | "internal";

export interface SectionDef {
  id: SectionId;
  label: string;
  group: SectionGroup;
}

/** Every section, in rail order. Adding a section is adding a row here and a panel in the page. */
export const SECTIONS: readonly SectionDef[] = [
  { id: "import", label: "Airbnb", group: "import" },
  { id: "photos", label: "Photos", group: "listing" },
  { id: "basics", label: "Basics", group: "listing" },
  { id: "location", label: "Location", group: "listing" },
  { id: "space", label: "Space & price", group: "listing" },
  { id: "highlights", label: "Highlights", group: "listing" },
  { id: "offers", label: "Offers", group: "listing" },
  { id: "rules", label: "Rules", group: "listing" },
  { id: "reviews", label: "Reviews", group: "listing" },
  { id: "status", label: "Status", group: "internal" },
  { id: "cleaners", label: "Cleaners", group: "internal" },
  { id: "statements", label: "Statements", group: "internal" },
  { id: "calendar", label: "Calendar", group: "internal" },
];

export const GROUP_LABELS: Record<SectionGroup, string> = { import: "Import", listing: "Listing", internal: "Nubnb only" };

export const isSectionId = (value: string | null | undefined): value is SectionId => SECTIONS.some((s) => s.id === value);

/** Which section each scraped field lives in (the scraper's field names, app/types/scrape.ts). */
export const SCRAPE_FIELD_SECTION: Record<string, SectionId> = {
  name: "basics", description: "basics", location: "basics", propertyTypeTag: "basics",
  coverImage: "photos", images: "photos",
  checkIn: "location", checkOut: "location",
  guests: "space", bedrooms: "space", beds: "space", bathrooms: "space", price: "space",
  highlights: "highlights",
  amenities: "offers", offers: "offers",
  rules: "rules", petsAllowed: "rules", smokingAllowed: "rules", partyAllowed: "rules",
  reviews: "reviews", averageRating: "reviews", totalReviewCount: "reviews",
};

/** Human labels for the scrape report, keyed the same way. */
export const SCRAPE_FIELD_LABEL: Record<string, string> = {
  name: "Title", description: "Description", guests: "Max guests",
  bedrooms: "Bedrooms", beds: "Beds", bathrooms: "Bathrooms",
  location: "Display location", coverImage: "Cover photo", images: "Gallery",
  propertyTypeTag: "Property tag", highlights: "Highlights",
  amenities: "Top amenities", offers: "What this place offers",
  checkIn: "Check-in time", checkOut: "Check-out time", rules: "House rules",
  petsAllowed: "Pets allowed", smokingAllowed: "Smoking allowed",
  partyAllowed: "Parties allowed", price: "Price",
  averageRating: "Average rating", totalReviewCount: "Review count", reviews: "Reviews",
};

/** Operator-facing names for save-issue payload paths. */
export const ISSUE_LABEL: Record<string, string> = {
  slug: "URL slug", currency: "Currency", coordinates: "Coordinates",
  type: "Type", icalUrl: "Calendar link", airbnbUrl: "Airbnb listing URL",
  googleMapsUrl: "Google Maps link",
  "addressDetails.city": "City", "addressDetails.state": "Province", "addressDetails.area": "Area", "addressDetails.country": "Country",
  "details.checkIn": "Check-in time", "details.checkOut": "Check-out time",
  "priceInfo.nightly": "Nightly price", "priceInfo.weekly": "Weekly price",
  "priceInfo.monthly": "Monthly price", "priceInfo.weekend": "Weekend price",
  "priceInfo.cleaningFee": "Cleaning fee", "priceInfo.minNights": "Minimum nights",
  "terms.cancellationPolicy": "Cancellation policy", "terms.rules": "House rules",
};

/** Which section a save issue's payload path belongs to, by its first segment. */
export const ISSUE_SECTION: Record<string, SectionId> = {
  airbnbUrl: "import", googleMapsUrl: "location", icalUrl: "calendar",
  slug: "basics", name: "basics", location: "basics", type: "basics", propertyTypeTag: "basics", description: "basics",
  coverImage: "photos", images: "photos",
  coordinates: "location", addressDetails: "location", details: "location",
  price: "space", currency: "space", bedrooms: "space", beds: "space", bathrooms: "space", guests: "space", priceInfo: "space",
  highlights: "highlights", amenities: "offers", offers: "offers", terms: "rules",
  reviews: "reviews", averageRating: "reviews", totalReviewCount: "reviews",
};

export const issueSection = (path: string): SectionId | undefined => ISSUE_SECTION[path.split(".")[0]];

// ─── The draft ────────────────────────────────────────────────

/** The statements record as typed (dispatch 23B; "Report For" and the fee rate, 23E; excluded, 24). */
export interface ManagementDraft {
  reportForName: string;
  reportForAddress: string;
  owners: { name: string; email: string }[];
  /** yyyy-mm */
  from: string;
  until: string;
  /** "20" or "12.5"; '' for none. */
  feeRate: string;
  /** The default fee amount of dispatch 23B, as loaded; sent back unchanged, no longer shown. */
  legacyFee: { label: string; amount: string } | null;
  /** Excluded from reporting (dispatch 24): the property owes no statements. */
  excluded: boolean;
}

export function emptyManagement(): ManagementDraft {
  return { reportForName: "", reportForAddress: "", owners: [], from: STATEMENTS_FROM_DEFAULT, until: "", feeRate: "", legacyFee: null, excluded: false };
}

export function managementFromRecord(record: PropertyManagementView | null): ManagementDraft {
  if (!record) return emptyManagement();
  return {
    reportForName: record.reportFor?.name ?? "",
    reportForAddress: record.reportFor?.address ?? "",
    owners: record.owners.map((o) => ({ name: o.name, email: o.email ?? "" })),
    from: record.statementsFrom,
    until: record.statementsUntil ?? "",
    feeRate: record.defaultFeeRateBasisPoints === null ? "" : rateText(record.defaultFeeRateBasisPoints).replace("%", ""),
    legacyFee: record.defaultFee ? { label: record.defaultFee.label, amount: amountField(record.defaultFee.amountCents) } : null,
    excluded: record.excludedFromReporting === true,
  };
}

/**
 * Everything the page edits: the property document as it will be sent, and
 * the three things kept apart from it, in their own collections — whether it
 * is unlisted, the name cleaners see, the statements record.
 */
export interface EditorDraft {
  property: Partial<Property>;
  unlisted: boolean;
  /** '' means none. */
  cleanerName: string;
  management: ManagementDraft;
}

/** A new property, as the dispatch-29 form started one. */
export function newPropertyDraft(): Partial<Property> {
  return {
    name: "",
    slug: "",
    location: "",
    price: 0,
    currency: "CAD",
    bedrooms: 0,
    beds: 0,
    bathrooms: 0,
    guests: 0,
    coverImage: "",
    images: [],
    type: "",
    propertyTypeTag: "",
    highlights: [],
    amenities: [],
    offers: [],
    description: "",
    priceInfo: { nightly: 0, weekly: 0, monthly: 0, weekend: 0, cleaningFee: 0, minNights: 1 },
    addressDetails: { city: "", state: "", area: "", country: "" },
    details: { checkIn: "4:00 PM", checkOut: "11:00 AM" },
    terms: { smokingAllowed: false, petsAllowed: false, partyAllowed: false, childrenAllowed: false, cancellationPolicy: "Flexible", rules: [] },
    coordinates: [0, 0],
    reviews: [],
    averageRating: 0,
    totalReviewCount: 0,
    airbnbUrl: "",
    googleMapsUrl: "",
  };
}

/**
 * A stored property as the page starts editing it: the document itself,
 * with the nightly input seeded with the price renters see (dispatch 29's
 * rule: on a document whose nightly is 0 or missing the public surfaces fall
 * back to `price`, so saving untouched must leave every quoted price as it was).
 */
export function draftFromStored(property: Property): Partial<Property> {
  return {
    ...property,
    priceInfo: { ...(property.priceInfo ?? {}), nightly: nightlyPrice(property) } as Property["priceInfo"],
  };
}

/**
 * The draft as one string, for "has anything changed" and for the kept
 * draft's fingerprint. `coverImageStored` and `imagesStored` are left out:
 * the image mirror writes them after every save, so they are the server's,
 * never the admin's, and a page that counted them would read "changed" after
 * its own save.
 */
export const MIRROR_FIELDS = ["coverImageStored", "imagesStored"] as const;
export function serializeDraft(draft: EditorDraft): string {
  const property: Record<string, unknown> = { ...draft.property };
  for (const key of MIRROR_FIELDS) delete property[key];
  return JSON.stringify({ ...draft, property });
}

// ─── What is missing ──────────────────────────────────────────

export interface MissingField {
  section: SectionId;
  /** The `data-field` of the control, for pointing at it. */
  field: string;
  label: string;
  /** The server would refuse a save without it. */
  blocking: boolean;
}

const blank = (value: unknown) => typeof value !== "string" || value.trim() === "";
const notPositive = (value: unknown) => typeof value !== "number" || !(value > 0);

/**
 * Every field the page counts as missing, section by section, in page order.
 * Blocking ones are those the server refuses a property without (the create
 * schema's non-empty strings, a positive guest count and minimum stay, a
 * cover). The rest are the dispatch-29 counts, minus the unused prices and a
 * studio's zero bedrooms (§35.3).
 */
export function missingFields(draft: EditorDraft): MissingField[] {
  const p = draft.property;
  const out: MissingField[] = [];
  const add = (section: SectionId, field: string, label: string, blocking = false) => out.push({ section, field, label, blocking });

  // Photos
  if (blank(p.coverImage)) add("photos", "coverImage", "Cover photo", true);
  const photos = (blank(p.coverImage) ? 0 : 1) + (p.images?.length ?? 0);
  if (photos < PHOTOS_WANTED) add("photos", "images", `${PHOTOS_WANTED - photos} more ${PHOTOS_WANTED - photos === 1 ? "photo" : "photos"}`);

  // Basics
  if (blank(p.name)) add("basics", "name", "Title", true);
  if (blank(p.location)) add("basics", "location", "Display location", true);
  if (blank(p.type)) add("basics", "type", "Type", true);
  if (blank(p.propertyTypeTag)) add("basics", "propertyTypeTag", "Property tag", true);
  if (blank(p.description)) add("basics", "description", "Description", true);

  // Location
  const [lng, lat] = p.coordinates ?? [0, 0];
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) add("location", "coordinates", "Coordinates");
  if (blank(p.addressDetails?.city)) add("location", "addressDetails.city", "City", true);
  if (blank(p.addressDetails?.state)) add("location", "addressDetails.state", "Province", true);
  if (blank(p.addressDetails?.area)) add("location", "addressDetails.area", "Area", true);
  if (blank(p.addressDetails?.country)) add("location", "addressDetails.country", "Country", true);
  if (blank(p.details?.checkIn)) add("location", "details.checkIn", "Check-in time", true);
  if (blank(p.details?.checkOut)) add("location", "details.checkOut", "Check-out time", true);

  // Space & price
  if (notPositive(p.beds)) add("space", "beds", "Beds");
  if (notPositive(p.bathrooms)) add("space", "bathrooms", "Bathrooms");
  if (notPositive(p.guests)) add("space", "guests", "Max guests", true);
  if (notPositive(p.priceInfo?.nightly)) add("space", "priceInfo.nightly", "Nightly price");
  if (typeof p.priceInfo?.cleaningFee !== "number") add("space", "priceInfo.cleaningFee", "Cleaning fee");
  if (notPositive(p.priceInfo?.minNights) || !Number.isInteger(p.priceInfo?.minNights)) add("space", "priceInfo.minNights", "Minimum nights", true);

  // Highlights
  const highlights = p.highlights?.length ?? 0;
  if (highlights < HIGHLIGHTS_MAX) add("highlights", "highlights", `${HIGHLIGHTS_MAX - highlights} more ${HIGHLIGHTS_MAX - highlights === 1 ? "highlight" : "highlights"}`);

  // Offers
  if ((p.offers?.length ?? 0) === 0) add("offers", "offers", "At least one item");

  // Rules
  if (blank(p.terms?.cancellationPolicy)) add("rules", "terms.cancellationPolicy", "Cancellation policy", true);
  if ((p.terms?.rules?.length ?? 0) === 0) add("rules", "terms.rules", "A house rule");

  return out;
}

export interface SectionState {
  missing: MissingField[];
  /** Fields the import defaulted or could not read. */
  toCheck: number;
  /** Fields the server refused on the last save. */
  refused: number;
  /** Whether the section has anything to be complete about. */
  checked: boolean;
}

const CHECKED_SECTIONS: ReadonlySet<SectionId> = new Set<SectionId>(["photos", "basics", "location", "space", "highlights", "offers", "rules"]);

/** Each section's marks for the rail and the panel heads. */
export function sectionStates(draft: EditorDraft, fieldStatus: ScrapeFieldStatus | null, issues: MutationIssue[]): Record<SectionId, SectionState> {
  const states = {} as Record<SectionId, SectionState>;
  for (const s of SECTIONS) states[s.id] = { missing: [], toCheck: 0, refused: 0, checked: CHECKED_SECTIONS.has(s.id) };
  for (const missing of missingFields(draft)) states[missing.section].missing.push(missing);
  for (const [field, report] of Object.entries(fieldStatus ?? {})) {
    if (report.status === "extracted" || report.status === "admin-entered") continue;
    const section = SCRAPE_FIELD_SECTION[field];
    if (section) states[section].toCheck++;
  }
  for (const issue of issues) {
    const section = issueSection(issue.path);
    if (section) states[section].refused++;
  }
  return states;
}

// ─── What is sent ─────────────────────────────────────────────

/**
 * The document as Save sends it (the dispatch-29 rules, unchanged):
 *  - one price: the legacy `price` is written from the nightly input;
 *  - the Airbnb link is normalised when typed or changed, kept exactly as
 *    stored when not, and cleared with '' on an edit when emptied;
 *  - the Google Maps link likewise, trimmed when changed;
 *  - a create leaves out empty links (the create schema wants a URL or nothing);
 *  - the slug is made from the name only when there is none.
 */
export function propertyPayload(draft: EditorDraft, stored: Property | null): Partial<Property> {
  const data: Partial<Property> = { ...draft.property };
  const isEdit = stored !== null;

  data.price = data.priceInfo?.nightly ?? 0;

  // A link typed or changed is cleaned; one left as it was is sent exactly as
  // stored; one emptied on an edit that had one is cleared with ''. A link
  // that was never stored and is still empty is not sent at all, so a
  // document without the key does not gain one.
  const link = (key: "airbnbUrl" | "googleMapsUrl", clean: (typed: string) => string) => {
    const storedValue = stored?.[key];
    const typed = (data[key] ?? "").trim();
    if (typed) {
      data[key] = isEdit && typeof storedValue === "string" && typed === storedValue.trim() ? storedValue : clean(typed);
      return;
    }
    if (isEdit && typeof storedValue === "string" && storedValue.trim() !== "") data[key] = "";
    else if (isEdit && typeof storedValue === "string") data[key] = storedValue;
    else delete data[key];
  };
  link("airbnbUrl", normalizeAirbnbUrl);
  link("googleMapsUrl", (typed) => typed);

  // The create schema wants a URL or nothing: an empty calendar link is left out of a create.
  if (!isEdit && typeof data.icalUrl === "string" && data.icalUrl.trim() === "") delete data.icalUrl;

  if (!data.slug && data.name) data.slug = toSlug(data.name);
  return data;
}

/**
 * The statements record as the route takes it: null when it says nothing
 * beyond the defaults (the record is then cleared), else the whole record.
 * A problem in words, with the field to point at, when it cannot be saved.
 */
export function managementPayload(draft: ManagementDraft): { record: ManagementPayload | null } | { problem: string; field: string } {
  const owners = draft.owners.map((o) => ({ name: o.name.trim(), email: o.email.trim() || null })).filter((o) => o.name !== "" || o.email !== null);
  const nameless = draft.owners.findIndex((o) => o.name.trim() === "" && o.email.trim() !== "");
  if (nameless !== -1) return { problem: "Every owner needs a name.", field: `management.owners.${nameless}.name` };
  if (!isMonth(draft.from)) return { problem: "Statements from: pick a month.", field: "management.from" };
  if (draft.until !== "" && !isMonth(draft.until)) return { problem: "Until: pick a month, or none.", field: "management.until" };
  if (draft.until !== "" && draft.until < draft.from) return { problem: "Until is before the first month.", field: "management.until" };
  const reportForName = draft.reportForName.trim();
  if (reportForName === "" && draft.reportForAddress.trim() !== "") return { problem: "Report For needs a name above the address.", field: "management.reportForName" };
  const reportFor = reportForName === "" ? null : { name: reportForName, address: draft.reportForAddress.trim() };
  const feeRate = draft.feeRate.trim();
  if (feeRate !== "" && !/^(100(\.0{1,2})?|[0-9]{1,2}(\.[0-9]{1,2})?)$/.test(feeRate)) return { problem: "The default fee rate is a percent, like 20 or 12.5.", field: "management.feeRate" };
  if (reportFor === null && owners.length === 0 && draft.from === STATEMENTS_FROM_DEFAULT && draft.until === "" && feeRate === "" && draft.legacyFee === null && !draft.excluded) return { record: null };
  return {
    record: {
      reportFor,
      owners,
      statementsFrom: draft.from,
      statementsUntil: draft.until || null,
      defaultFeeRate: feeRate || null,
      ...(draft.legacyFee ? { defaultFee: draft.legacyFee } : {}),
      excludedFromReporting: draft.excluded,
    },
  };
}

// ─── Months, for the statements selects ───────────────────────

/** "2025-01" … twelve months past the current one, newest first. */
export function monthChoices(today: Date, extra: string[] = []): string[] {
  const months: string[] = [];
  const end = new Date(Date.UTC(today.getFullYear(), today.getMonth() + 12, 1));
  for (let d = new Date(Date.UTC(2025, 0, 1)); d <= end; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  for (const month of extra) if (isMonth(month) && !months.includes(month)) months.push(month);
  return months.sort().reverse();
}

// ─── Unsaved work kept in the tab ─────────────────────────────

/**
 * Unsaved changes are kept in the tab's session storage (§35.3): restored
 * when the same page opens again in the same tab, if the stored document is
 * still what it was when they were typed. Nothing is kept once saved.
 */
export interface KeptDraft {
  at: string;
  base: string;
  draft: EditorDraft;
}

export const keptDraftKey = (id: string | null) => `nubnb:property-editor:${id ?? "new"}`;

/** A short fingerprint of a serialised baseline: enough to tell "unchanged since" from "changed". */
export function fingerprint(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x9e3779b1) >>> 0;
  }
  return `${text.length.toString(36)}-${h1.toString(36)}-${h2.toString(36)}`;
}

export function readKeptDraft(id: string | null): KeptDraft | null {
  try {
    const raw = window.sessionStorage.getItem(keptDraftKey(id));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<KeptDraft>;
    if (!parsed || typeof parsed.at !== "string" || typeof parsed.base !== "string" || !parsed.draft || typeof parsed.draft !== "object") return null;
    return parsed as KeptDraft;
  } catch {
    return null;
  }
}

export function keepDraft(id: string | null, kept: KeptDraft): void {
  try {
    window.sessionStorage.setItem(keptDraftKey(id), JSON.stringify(kept));
  } catch {
    // Storage full or blocked: the page still works; the changes are simply not kept.
  }
}

export function forgetKeptDraft(id: string | null): void {
  try {
    window.sessionStorage.removeItem(keptDraftKey(id));
  } catch {
    // Nothing to do.
  }
}

// ─── Small helpers the sections share ─────────────────────────

/** `offers` with `icon` summarised, for logs and tests. */
export const offerSummary = (offer: Offer) => `${offer.category} / ${offer.name}${offer.available ? "" : " (not included)"}`;

/** "7:12 pm", for the save state. */
export function clockTime(date: Date): string {
  return date.toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" }).toLowerCase().replace(/\./g, "");
}
