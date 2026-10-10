"use client";

import { Property, Offer } from "@/app/types/property";
import { addProperty, updateProperty, MutationIssue, getCleanerFacingName, setCleanerFacingName, getManagement, setManagement, setUnlisted, type ManagementPayload } from '@/app/lib/firebase/properties';
import { STATEMENTS_FROM_DEFAULT, STATEMENT_LIMITS, isMonth, rateText } from "@/app/lib/reports/model";
import { amountField } from "../costs/cost-display";
import { hasPriceDivergence, nightlyPrice } from "@/app/lib/price";
import { Fragment, useMemo, useState, useEffect, useRef } from "react";
import styles from "./PropertyForm.module.css";
import { Plus, Trash2, X, ImageIcon, ImagePlus, Link2, Star, ChevronDown, Check, AlertTriangle, XCircle, Pencil } from "lucide-react";
import { NOT_INCLUDED, addOffer, editOffer, excludeOffer, includeOffer, offerCategoryOptions, offerNameTaken, removeOffer, type OffersAndStars } from "./offers";

import { CustomSelect } from "./CustomSelect";
import { IconPicker } from "./IconPicker";
import { NoticeBanner, Notice, useNotice } from "./Notice";
import { normalizeAirbnbUrl } from "@/app/lib/api/validate";
import { describeHttpFailure, describeErrorBody, readErrorBody } from "@/app/lib/api/http-failure";
import { toSlug } from "@/app/lib/slug";
import type { ExtractionSummary, ScrapeFieldStatus } from "@/app/types/scrape";

const GTA_CITIES = [
  "Toronto, ON", "Mississauga, ON", "Brampton, ON", "Markham, ON",
  "Vaughan, ON", "Richmond Hill, ON", "Oakville, ON", "Burlington, ON",
  "Pickering, ON", "Ajax, ON", "Whitby, ON", "Oshawa, ON", "Milton, ON",
  "Halton Hills, ON", "Aurora, ON", "Newmarket, ON", "King City, ON",
  "Whitchurch-Stouffville, ON", "East Gwillimbury, ON", "Georgina, ON",
  "Brock, ON", "Scugog, ON", "Uxbridge, ON", "Caledon, ON"
];

const CANADIAN_PROVINCES = [
  "Alberta", "British Columbia", "Manitoba", "New Brunswick", 
  "Newfoundland and Labrador", "Nova Scotia", "Ontario", 
  "Prince Edward Island", "Quebec", "Saskatchewan", 
  "Northwest Territories", "Nunavut", "Yukon"
];

/** Mirrors ALLOWED_TYPES in /api/upload-image. SVG and HEIC are not accepted. */
const ACCEPTED_IMAGE_TYPES = "image/jpeg,image/png,image/webp,image/avif";

const PROPERTY_TYPES = ["House", "Apartment", "Villa", "Penthouse", "Estate", "Residence", "Ranch", "Condo", "Basement"];
const PROPERTY_TYPE_TAGS = ["Entire home", "Entire condo", "Entire guest suite", "Private room", "Shared room"];

/**
 * The one list row being edited in place (dispatch 29): an offer, a highlight
 * or a house rule. `include` is an offer in "Not included" being ticked whose
 * category is not known: it is offered again only once the admin picks one.
 */
type RowEdit =
  | { kind: "offer"; target: Offer; name: string; category: string; include: boolean }
  | { kind: "highlight" | "rule"; index: number; value: string };

/**
 * Which accordion each scraped field lives in, so a field that failed to
 * extract can be opened rather than hidden behind a collapsed section.
 * Keys are the scraper's field names (see app/types/scrape.ts).
 */
const SCRAPE_FIELD_SECTION: Record<string, string> = {
  name: "basic", description: "basic", coverImage: "basic", images: "basic",
  location: "basic", propertyTypeTag: "basic",
  checkIn: "location", checkOut: "location",
  guests: "capacity", bedrooms: "capacity", beds: "capacity",
  bathrooms: "capacity", price: "capacity",
  highlights: "highlights",
  amenities: "offers", offers: "offers",
  rules: "terms", petsAllowed: "terms", smokingAllowed: "terms", partyAllowed: "terms",
  reviews: "reviews", averageRating: "reviews", totalReviewCount: "reviews",
};

/** Human labels for the scrape report, keyed the same way. */
const SCRAPE_FIELD_LABEL: Record<string, string> = {
  name: "Title", description: "Description", guests: "Max guests",
  bedrooms: "Bedrooms", beds: "Beds", bathrooms: "Bathrooms",
  location: "Display location", coverImage: "Cover image", images: "Additional images",
  propertyTypeTag: "Property tag", highlights: "Highlights",
  amenities: "Top amenities", offers: "What this place offers",
  checkIn: "Check-in time", checkOut: "Check-out time", rules: "House rules",
  petsAllowed: "Pets allowed", smokingAllowed: "Smoking allowed",
  partyAllowed: "Parties allowed", price: "Price",
  averageRating: "Average rating", totalReviewCount: "Review count", reviews: "Reviews",
};

/** Operator-facing names for save-issue payload paths. */
const ISSUE_LABEL: Record<string, string> = {
  slug: "URL slug", currency: "Currency", coordinates: "Coordinates",
  type: "Type", icalUrl: "iCal URL", airbnbUrl: "Airbnb listing URL",
  googleMapsUrl: "Google Maps link",
  "addressDetails.city": "City", "addressDetails.state": "State/Province",
  "addressDetails.area": "Area", "addressDetails.country": "Country",
  "details.checkIn": "Check-in time", "details.checkOut": "Check-out time",
  "priceInfo.nightly": "Nightly price", "priceInfo.weekly": "Weekly price",
  "priceInfo.monthly": "Monthly price", "priceInfo.weekend": "Weekend price",
  "priceInfo.cleaningFee": "Cleaning fee", "priceInfo.minNights": "Min. nights",
  "terms.cancellationPolicy": "Cancellation policy", "terms.rules": "House rules",
};

/** Which accordion a save issue's payload path belongs to. */
const ISSUE_SECTION: Record<string, string> = {
  // airbnbUrl / googleMapsUrl / icalUrl live in the always-visible Data
  // Sources block, so they need no accordion to open.
  airbnbUrl: "", googleMapsUrl: "", icalUrl: "",
  slug: "basic", name: "basic", location: "basic", coverImage: "basic",
  images: "basic", type: "basic", propertyTypeTag: "basic", description: "basic",
  coordinates: "location", addressDetails: "location", details: "location",
  price: "capacity", currency: "capacity", bedrooms: "capacity", beds: "capacity",
  bathrooms: "capacity", guests: "capacity", priceInfo: "capacity",
  highlights: "highlights", amenities: "offers", offers: "offers", terms: "terms",
  reviews: "reviews", averageRating: "reviews", totalReviewCount: "reviews",
};

interface PropertyFormProps {
  initialData?: Property;
  /** Whether the property is unlisted (dispatch 24), as the list read it beside the documents. */
  initialUnlisted?: boolean;
  onClose: () => void;
  onSave: () => void;
}

export function PropertyForm({ initialData, initialUnlisted = false, onClose, onSave }: PropertyFormProps) {
  const [formData, setFormData] = useState<Partial<Property>>(() =>
    initialData
      ? {
          ...initialData,
          priceInfo: {
            ...(initialData.priceInfo ?? {}),
            // The input is seeded with the price renters are being shown, not
            // the raw stored `nightly`. On a document whose nightly is 0 or
            // missing the public surfaces fall back to `price`, so the stored
            // nightly is not the live price and prefilling it would invite an
            // operator to save a $0 listing by touching nothing. Opening a
            // property and saving it unchanged now leaves every renter-facing
            // price exactly as it was.
            nightly: nightlyPrice(initialData),
          } as Property['priceInfo'],
        }
      : {
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
      priceInfo: {
        nightly: 0,
        weekly: 0,
        monthly: 0,
        weekend: 0,
        cleaningFee: 0,
        minNights: 1,
      },
      addressDetails: {
        city: "",
        state: "",
        area: "",
        country: "",
      },
      details: {
        checkIn: "4:00 PM",
        checkOut: "11:00 AM",
      },
      terms: {
        smokingAllowed: false,
        petsAllowed: false,
        partyAllowed: false,
        childrenAllowed: false,
        cancellationPolicy: "Flexible",
        rules: [],
      },
      coordinates: [0, 0],
      reviews: [],
      averageRating: 0,
      totalReviewCount: 0,
      airbnbUrl: "",
      googleMapsUrl: "",
    },
  );

  /**
   * The disagreement this property was opened with, if any.
   *
   * Read from `initialData`, never from `formData`, so it reflects what is
   * stored rather than what has been typed since. It stays visible for the
   * whole editing session: the point is to tell the operator what saving is
   * about to reconcile, and that is true right up until they save.
   */
  const storedPriceConflict = useMemo(() => {
    if (!initialData || !hasPriceDivergence(initialData)) return null;
    return {
      base: initialData.price as number,
      nightly: initialData.priceInfo!.nightly,
      // What renters are actually being shown right now, resolved by the same
      // helper every public surface uses. Not simply the nightly value: when
      // nightly is 0 or missing the helper falls back to the base price, and
      // a warning that told the operator renters see $0 in that case would be
      // telling them something untrue.
      shown: nightlyPrice(initialData),
    };
  }, [initialData]);
  /** The price as currently typed — what a save would write to both fields. */
  const pendingNightly = formData.priceInfo?.nightly ?? 0;

  const [isSaving, setIsSaving] = useState(false);
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const [isUploadingMultiple, setIsUploadingMultiple] = useState(false);
  const [newRule, setNewRule] = useState("");
  const [newHighlight, setNewHighlight] = useState("");
  const [newOfferName, setNewOfferName] = useState("");
  // No default category (dispatch 29): a new item goes where the admin puts it, never quietly into Bathroom.
  const [newOfferCategory, setNewOfferCategory] = useState("");
  const [offerAddError, setOfferAddError] = useState<string | null>(null);
  const [rowEdit, setRowEdit] = useState<RowEdit | null>(null);
  const [rowEditError, setRowEditError] = useState<string | null>(null);
  /**
   * The category an item had before it was unticked, by name, for this
   * editing session only — so ticking it moves it back. Never saved.
   */
  const formerCategories = useRef(new Map<string, string>());
  const [airbnbUrl, setAirbnbUrl] = useState(initialData?.airbnbUrl || "");
  const [isScraping, setIsScraping] = useState(false);
  const [scrapeNotice, setScrapeNotice] = useState<Notice | null>(null);
  // Per-field provenance from the scraper, replacing the old guesswork Set.
  const [fieldStatus, setFieldStatus] = useState<ScrapeFieldStatus | null>(null);
  const [extractionSummary, setExtractionSummary] = useState<ExtractionSummary | null>(null);
  const [googleMapsUrl, setGoogleMapsUrl] = useState(initialData?.googleMapsUrl || "");
  const [isParsingMaps, setIsParsingMaps] = useState(false);
  const [mapsNotice, setMapsNotice] = useState<Notice | null>(null);
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});
  /** Sections whose opening animation has finished: only these let a menu reach past their edge. */
  const [settledSections, setSettledSections] = useState<Record<string, boolean>>({});
  /** A save was tried: required fields still missing are now marked. */
  const [submitAttempted, setSubmitAttempted] = useState(false);

  // Save failures. The modal stays open and every entered value is kept.
  const [saveError, setSaveError] = useState<{ title: string; detail?: string } | null>(null);
  /**
   * The name cleaners see (dispatch 21): kept in its own server-only
   * collection, so it is read and saved apart from the property document.
   * `loaded` is what the server holds (null: none; undefined: not known yet
   * or could not be read), and `cleanerFacingName` is what is typed.
   */
  const [cleanerFacingName, setCleanerFacingName_] = useState("");
  const [loadedCleanerFacingName, setLoadedCleanerFacingName] = useState<string | null | undefined>(undefined);
  const [cleanerFacingNameState, setCleanerFacingNameState] = useState<"none" | "loading" | "ready" | "unavailable">(
    initialData?.id ? "loading" : "none",
  );
  /** Post-save image mirroring is in flight. The save itself is already done. */
  const [isMirroring, setIsMirroring] = useState(false);
  const [saveIssues, setSaveIssues] = useState<MutationIssue[]>([]);

  // Uploads and other in-form failures — one mechanism, no alert().
  const { notice: formNotice, show: showFormNotice, clear: clearFormNotice } = useNotice();

  /**
   * The statements record (dispatch 23B; "Report For" and the fee rate,
   * dispatch 23E): its own server-only document, loaded and saved apart
   * from the property, like the name for cleaners.
   */
  /**
   * Unlisted (Kian's ruling of 2026-10-03, dispatch 24): kept in its own
   * server-only collection, saved by its own route; `loadedUnlisted` is what
   * the server holds.
   */
  const [unlisted, setUnlistedDraft] = useState(initialUnlisted);
  const [loadedUnlisted, setLoadedUnlisted] = useState(initialUnlisted);
  const [management, setManagement_] = useState<ManagementDraft>(emptyManagement);
  const [loadedManagement, setLoadedManagement] = useState<string>(JSON.stringify(emptyManagement()));
  const [managementState, setManagementState] = useState<"none" | "loading" | "ready" | "unavailable">(initialData?.id ? "loading" : "none");
  useEffect(() => {
    const id = initialData?.id;
    if (!id) return;
    let cancelled = false;
    getManagement(id).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        const draft = result.data
          ? {
              reportForName: result.data.reportFor?.name ?? "",
              reportForAddress: result.data.reportFor?.address ?? "",
              owners: result.data.owners.map((o) => ({ name: o.name, email: o.email ?? "" })),
              from: result.data.statementsFrom,
              until: result.data.statementsUntil ?? "",
              feeRate: result.data.defaultFeeRateBasisPoints === null ? "" : rateText(result.data.defaultFeeRateBasisPoints).replace("%", ""),
              legacyFee: result.data.defaultFee ? { label: result.data.defaultFee.label, amount: amountField(result.data.defaultFee.amountCents) } : null,
              excluded: result.data.excludedFromReporting === true,
            }
          : emptyManagement();
        setManagement_(draft);
        setLoadedManagement(JSON.stringify(draft));
        setManagementState("ready");
      } else {
        setManagementState("unavailable");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [initialData?.id]);

  // The cleaner-facing name comes from its own route, not from the property.
  useEffect(() => {
    const id = initialData?.id;
    if (!id) return;
    let cancelled = false;
    getCleanerFacingName(id).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setLoadedCleanerFacingName(result.data);
        setCleanerFacingName_(result.data ?? "");
        setCleanerFacingNameState("ready");
      } else {
        setCleanerFacingNameState("unavailable");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [initialData?.id]);

  const toggleSection = (key: string) => {
    if (!openSections[key]) {
      setOpenSections(prev => ({ ...prev, [key]: true }));
      return;
    }
    // Clip again first, then collapse two frames later, so the close animates as it always has.
    setSettledSections(prev => ({ ...prev, [key]: false }));
    requestAnimationFrame(() => requestAnimationFrame(() => setOpenSections(prev => ({ ...prev, [key]: false }))));
  };

  // A section clips its contents only while it opens (dispatch 29). Clipping an
  // open one cut off the category dropdown and the icon picker, which open past
  // its bottom edge — the "categories cannot be changed" report.
  useEffect(() => {
    const opening = Object.keys(openSections).filter((key) => openSections[key] && !settledSections[key]);
    if (opening.length === 0) return;
    const timer = window.setTimeout(
      () => setSettledSections((prev) => ({ ...prev, ...Object.fromEntries(opening.map((key) => [key, true])) })),
      400, // the open transition is 350 ms
    );
    return () => window.clearTimeout(timer);
  }, [openSections, settledSections]);

  // Count unfilled required fields per section
  const getUnfilledCount = (sectionKey: string): number => {
    switch (sectionKey) {
      case 'basic': {
        let count = 0;
        // Count total images (cover + additional); if < 6 that's 1 lacking input
        const totalImages = (formData.coverImage ? 1 : 0) + (formData.images?.length || 0);
        if (totalImages < 6) count++;
        if (!formData.name?.trim()) count++;
        if (!formData.location?.trim()) count++;
        if (!formData.type?.trim()) count++;
        if (!formData.propertyTypeTag?.trim()) count++;
        if (!formData.description?.trim()) count++;
        return count;
      }
      case 'location': {
        let count = 0;
        if (!formData.coordinates?.[1] && formData.coordinates?.[1] !== 0) count++;
        if (!formData.coordinates?.[0] && formData.coordinates?.[0] !== 0) count++;
        if (formData.coordinates?.[0] === 0 && formData.coordinates?.[1] === 0) count += 2;
        if (!formData.addressDetails?.city?.trim()) count++;
        if (!formData.addressDetails?.state?.trim()) count++;
        if (!formData.addressDetails?.area?.trim()) count++;
        if (!formData.addressDetails?.country?.trim()) count++;
        if (!formData.details?.checkIn?.trim()) count++;
        if (!formData.details?.checkOut?.trim()) count++;
        return count;
      }
      case 'capacity': {
        let count = 0;
        if (!formData.bedrooms) count++;
        if (!formData.beds) count++;
        if (!formData.bathrooms) count++;
        if (!formData.guests) count++;
        // `price` is no longer entered separately — it is written from the
        // nightly value on save, so counting it would flag a field that has
        // no input.
        if (!formData.priceInfo?.nightly) count++;
        if (!formData.priceInfo?.weekly) count++;
        if (!formData.priceInfo?.monthly) count++;
        if (!formData.priceInfo?.weekend) count++;
        if (!formData.priceInfo?.cleaningFee && formData.priceInfo?.cleaningFee !== 0) count++;
        if (!formData.priceInfo?.minNights) count++;
        return count;
      }
      case 'highlights': {
        const hl = formData.highlights || [];
        return Math.max(0, 3 - hl.length);
      }
      case 'offers': {
        const offers = formData.offers || [];
        return offers.length === 0 ? 1 : 0;
      }
      case 'terms': {
        let count = 0;
        if (!formData.terms?.cancellationPolicy?.trim()) count++;
        if (!(formData.terms?.rules?.length)) count++;
        return count;
      }
      default:
        return 0;
    }
  };

  /** Fields in this section the scraper defaulted or failed to read. */
  const sectionScrapeProblems = (sectionKey: string) =>
    Object.entries(fieldStatus || {}).filter(
      ([field, report]) =>
        SCRAPE_FIELD_SECTION[field] === sectionKey &&
        report.status !== 'extracted' &&
        report.status !== 'admin-entered',
    ).length;

  /** Save issues the API reported against fields in this section. */
  const sectionSaveIssues = (sectionKey: string) =>
    saveIssues.filter((i) => ISSUE_SECTION[i.path.split('.')[0]] === sectionKey).length;

  const renderAccordionSection = (sectionKey: string, title: string, children: React.ReactNode) => {
    const isOpen = !!openSections[sectionKey];
    const unfilled = getUnfilledCount(sectionKey);
    const scrapeProblems = sectionScrapeProblems(sectionKey);
    const rejected = sectionSaveIssues(sectionKey);
    return (
      <div className={styles.section} key={sectionKey} data-section={sectionKey}>
        <div className={styles.accordionHeader} onClick={() => toggleSection(sectionKey)}>
          <div className={styles.accordionHeaderLeft}>
            <h3>{title}</h3>
            {unfilled > 0 ? (
              <span className={styles.accordionBadge}>{unfilled}</span>
            ) : (
              <span className={styles.accordionBadgeZero}>✓</span>
            )}
            {rejected > 0 && (
              <span className={styles.accordionBadgeRejected} title="Fields the server rejected on save">
                <XCircle size={11} /> {rejected} rejected
              </span>
            )}
            {scrapeProblems > 0 && (
              <span className={styles.accordionBadgeScrape} title="Fields that were defaulted or not found during import">
                <AlertTriangle size={11} /> {scrapeProblems} unverified
              </span>
            )}
          </div>
          <ChevronDown size={20} className={isOpen ? styles.accordionChevronOpen : styles.accordionChevron} />
        </div>
        <div className={`${styles.accordionBody} ${isOpen ? styles.accordionBodyOpen : ''} ${isOpen && settledSections[sectionKey] ? styles.accordionBodySettled : ''}`}>
          {children}
        </div>
      </div>
    );
  };

  // ── Scrape provenance ──────────────────────────────────────
  // Driven by the scraper's own fieldStatus map: every field it returns gets a
  // state here, including the ones it silently defaults.

  /** Border colour for a plain input, from the scraper's report for that field. */
  const scrapeClass = (field: string) => {
    const report = fieldStatus?.[field];
    if (!report) return '';
    if (report.status === 'extracted') return styles.scrapeExtracted;
    if (report.status === 'defaulted') return styles.scrapeDefaulted;
    // `admin-entered` is a normal state, not a problem — leave the field plain.
    if (report.status === 'admin-entered') return '';
    return styles.scrapeFailed;
  };

  /** Badge for any control that has no border to colour (selects, lists, images). */
  const scrapeBadge = (field: string) => {
    const report = fieldStatus?.[field];
    if (!report) return null;

    if (report.status === 'extracted') {
      return (
        <span className={`${styles.scrapeBadge} ${styles.scrapeBadgeExtracted}`} title="Read from the Airbnb listing.">
          <Check size={11} /> Scraped
        </span>
      );
    }
    if (report.status === 'defaulted') {
      return (
        <span className={`${styles.scrapeBadge} ${styles.scrapeBadgeDefaulted}`} title={report.reason}>
          <AlertTriangle size={11} /> Default: {String(report.defaultUsed)}
        </span>
      );
    }
    if (report.status === 'admin-entered') {
      return (
        <span className={styles.scrapeBadge} title={report.reason}>
          Enter manually
        </span>
      );
    }
    return (
      <span className={`${styles.scrapeBadge} ${styles.scrapeBadgeFailed}`} title={report.reason}>
        <XCircle size={11} /> Not found
      </span>
    );
  };

  /** Fields the scraper could not read, grouped for the post-scrape report. */
  const fieldsWithStatus = (status: 'extracted' | 'defaulted' | 'failed' | 'admin-entered') =>
    Object.entries(fieldStatus || {})
      .filter(([, r]) => r.status === status)
      .map(([field, r]) => ({ field, label: SCRAPE_FIELD_LABEL[field] || field, reason: r.reason, defaultUsed: r.defaultUsed }));

  // ── Save issues ────────────────────────────────────────────

  /** Validation messages the API reported against this exact payload path. */
  const issuesFor = (path: string) => saveIssues.filter((i) => i.path === path);

  const fieldIssue = (path: string) => {
    const issues = issuesFor(path);
    if (issues.length === 0) return null;
    return (
      <span className={styles.fieldIssue} role="alert" data-issue>
        {issues.map((i) => i.message).join('. ')}
      </span>
    );
  };

  /** Red border on an input the API rejected. */
  const issueClass = (path: string) => (issuesFor(path).length > 0 ? styles.fieldIssueInput : '');

  const handleScrapeAirbnb = async () => {
    if (!airbnbUrl.trim() || !airbnbUrl.includes('airbnb')) {
      setScrapeNotice({ tone: 'error', title: 'Please enter a valid Airbnb URL.' });
      return;
    }
    setIsScraping(true);
    setScrapeNotice(null);
    // Scrape the canonical listing URL, not whatever was pasted. A URL copied
    // out of Airbnb search carries check_in/check_out, and those change the
    // page that gets scraped. Show the operator the URL actually used.
    const scrapeUrl = normalizeAirbnbUrl(airbnbUrl.trim());
    if (scrapeUrl !== airbnbUrl) setAirbnbUrl(scrapeUrl);
    try {
      const res = await fetch('/api/scrape-airbnb', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: scrapeUrl }),
      });

      if (!res.ok) {
        // The scraper now refuses to report success on an unusable page and
        // says which failure it was. Nothing is imported on these paths, so
        // leave the form exactly as the operator left it.
        const errData = await readErrorBody(res);
        const failure = describeErrorBody(errData, res.status, 'Scrape failed');
        setFieldStatus(null);
        setExtractionSummary(null);
        setScrapeNotice({
          tone: 'error',
          title: failure.title,
          detail: failure.detail,
          items: errData.evidence
            ? Object.entries(errData.evidence as Record<string, string | number>).map(
                ([k, v]) => `${k}: ${v}`,
              )
            : undefined,
        });
        return;
      }

      const result = await res.json();
      const data = result.data;

      const status: ScrapeFieldStatus = data.fieldStatus || {};
      const summary: ExtractionSummary | null = data.extractionSummary || null;
      setFieldStatus(status);
      setExtractionSummary(summary);
      // The import replaces the lists a row edit points into.
      setRowEdit(null);
      setRowEditError(null);

      // Map scraped data into form fields
      setFormData(prev => ({
        ...prev,
        name: data.name || prev.name,
        description: data.description || prev.description,
        guests: data.guests || prev.guests,
        bedrooms: data.bedrooms || prev.bedrooms,
        beds: data.beds || prev.beds,
        bathrooms: data.bathrooms || prev.bathrooms,
        coverImage: data.coverImage || prev.coverImage,
        images: data.images?.length ? data.images : prev.images,
        propertyTypeTag: data.propertyTypeTag || prev.propertyTypeTag || 'Entire home',
        highlights: data.highlights?.length ? data.highlights : prev.highlights,
        amenities: data.amenities?.length ? data.amenities.slice(0, 8) : prev.amenities,
        offers: data.offers?.length ? data.offers : prev.offers,
        // Location: the geocoder is the source of truth. The scraped value
        // only fills an empty field — it never overwrites what Google Maps
        // resolved. (This key was missing entirely, so a scraped location was
        // extracted and then silently dropped.)
        location: prev.location || data.location || '',
        // `price` is not scraped — see the `admin-entered` provenance state.
        // Whatever the operator has entered stands.
        price: prev.price,
        priceInfo: {
          nightly: prev.priceInfo?.nightly || 0,
          weekly: prev.priceInfo?.weekly || 0,
          monthly: prev.priceInfo?.monthly || 0,
          weekend: prev.priceInfo?.weekend || 0,
          cleaningFee: prev.priceInfo?.cleaningFee || 0,
          minNights: prev.priceInfo?.minNights || 1,
        },
        details: {
          checkIn: data.checkIn || prev.details?.checkIn || '4:00 PM',
          checkOut: data.checkOut || prev.details?.checkOut || '11:00 AM',
        },
        terms: {
          smokingAllowed: data.smokingAllowed ?? prev.terms?.smokingAllowed ?? false,
          petsAllowed: data.petsAllowed ?? prev.terms?.petsAllowed ?? false,
          partyAllowed: data.partyAllowed ?? prev.terms?.partyAllowed ?? false,
          childrenAllowed: prev.terms?.childrenAllowed ?? true,
          cancellationPolicy: prev.terms?.cancellationPolicy || 'Flexible',
          rules: data.rules?.length ? data.rules : prev.terms?.rules || [],
        },
        reviews: data.reviews?.length ? data.reviews : prev.reviews || [],
        averageRating: data.averageRating || prev.averageRating || 0,
        totalReviewCount: data.totalReviewCount || prev.totalReviewCount || 0,
        airbnbUrl: scrapeUrl || prev.airbnbUrl || '',
      }));

      // Open every accordion holding a field that defaulted or failed, plus
      // reviews when there are any — nothing broken stays collapsed.
      setOpenSections(prev => {
        const next = { ...prev };
        for (const [field, report] of Object.entries(status)) {
          if (report.status === 'extracted' || report.status === 'admin-entered') continue;
          const section = SCRAPE_FIELD_SECTION[field];
          if (section) next[section] = true;
        }
        if (data.reviews?.length) next.reviews = true;
        return next;
      });

      const warnings: string[] = Array.isArray(data.warnings) ? data.warnings : [];
      const incomplete = summary ? summary.defaulted + summary.failed : 0;
      setScrapeNotice({
        tone: incomplete > 0 || warnings.length > 0 ? 'warning' : 'success',
        title: summary
          ? `Imported "${data.name}" — ${summary.extracted} of ${summary.total} fields extracted, ` +
            `${summary.defaulted} defaulted, ${summary.failed} not found` +
            (summary['admin-entered'] ? `, ${summary['admin-entered']} for you to enter.` : '.')
          : `Imported data for "${data.name}".`,
        detail:
          incomplete > 0
            ? 'Amber and red fields below were NOT read from the listing. Check every one of them before saving.'
            : 'Review & edit below, then save.',
        items: warnings.length > 0 ? warnings : undefined,
      });
    } catch (err) {
      setFieldStatus(null);
      setExtractionSummary(null);
      setScrapeNotice({
        tone: 'error',
        title: err instanceof Error ? err.message : 'Scraping failed. Try again.',
        detail: 'Nothing was imported.',
      });
    } finally {
      setIsScraping(false);
    }
  };

  const handleParseGoogleMaps = async () => {
    if (!googleMapsUrl.trim()) {
      setMapsNotice({ tone: 'error', title: 'Please enter a Google Maps URL.' });
      return;
    }
    if (!googleMapsUrl.includes('google') && !googleMapsUrl.includes('goo.gl') && !googleMapsUrl.includes('maps.app')) {
      setMapsNotice({ tone: 'error', title: 'Please enter a valid Google Maps link.' });
      return;
    }
    setIsParsingMaps(true);
    setMapsNotice(null);
    try {
      const res = await fetch('/api/parse-google-maps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: googleMapsUrl }),
      });
      if (!res.ok) {
        // `await res.json()` used to run unguarded here. A 502/503/504 carries
        // an HTML body, so it threw, and the operator saw the JSON parse error
        // instead of the status.
        const failure = await describeHttpFailure(res, 'Could not read that Google Maps link');
        setMapsNotice({ tone: 'error', title: failure.title, detail: failure.detail });
        return;
      }
      const result = await res.json();
      const data = result.data;

      setFormData(prev => ({
        ...prev,
        coordinates: data.coordinates || prev.coordinates,
        location: data.location || prev.location,
        addressDetails: {
          city: data.addressDetails?.city || prev.addressDetails?.city || '',
          state: data.addressDetails?.state || prev.addressDetails?.state || '',
          area: data.addressDetails?.area || prev.addressDetails?.area || '',
          country: data.addressDetails?.country || prev.addressDetails?.country || '',
        },
        googleMapsUrl: googleMapsUrl || prev.googleMapsUrl || '',
      }));

      // Coordinates always come back; the address only comes back if Nominatim
      // answered. Reporting "Location set" with a blank address hid that.
      const addr = data.addressDetails || {};
      const missing = (['city', 'state', 'area', 'country'] as const).filter((k) => !addr[k]);
      const coords = `${data.lat?.toFixed(4)}, ${data.lng?.toFixed(4)}`;

      if (missing.length === 4) {
        setMapsNotice({
          tone: 'error',
          title: `Coordinates set (${coords}) — but no address was resolved.`,
          detail:
            'Reverse geocoding returned nothing, so city, province, area and country are all blank. ' +
            'Fill them in under Location before saving: an empty city drops this property out of the city filter.',
        });
      } else if (missing.length > 0) {
        setMapsNotice({
          tone: 'warning',
          title: `Location partly resolved (${coords}).`,
          detail: `Reverse geocoding did not return: ${missing.join(', ')}. Fill these in under Location before saving.`,
        });
      } else {
        setMapsNotice({
          tone: 'success',
          title: `Location set: ${[addr.city, addr.state, addr.area, addr.country].join(', ')} (${coords})`,
        });
      }
    } catch (err) {
      setMapsNotice({ tone: 'error', title: err instanceof Error ? err.message : 'Failed to parse URL.' });
    } finally {
      setIsParsingMaps(false);
    }
  };

  /**
   * Send one file to /api/upload-image and return the stored URL.
   *
   * Uploads are server-side: there is no Firebase Auth in this app, so the
   * browser has no credential Storage could trust. The route authenticates
   * with the admin session cookie and writes via the Admin SDK.
   *
   * Rejects with a message already fit to show the operator — the route
   * returns `error`/`hint`/`code` the same way the scraper does.
   */
  const uploadImageFile = async (file: File): Promise<string> => {
    const body = new FormData();
    body.append('file', file);

    const res = await fetch('/api/upload-image', { method: 'POST', body });

    if (!res.ok) {
      const failure = await describeHttpFailure(res, 'Upload failed');
      throw new Error([failure.title, failure.detail].filter(Boolean).join(' '));
    }

    const { data } = await res.json();
    if (!data?.url) throw new Error('The server did not return an image URL.');
    return data.url as string;
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    clearFormNotice();
    setIsUploadingImage(true);

    try {
      const url = await uploadImageFile(file);
      setFormData(prev => ({ ...prev, coverImage: url }));
      showFormNotice({ tone: 'success', title: `Cover image uploaded: ${file.name}` });
    } catch (error) {
      // Previously console-only, which is why five months of denied uploads
      // looked like a click that never registered.
      showFormNotice({
        tone: 'error',
        title: 'Cover image upload failed.',
        detail: error instanceof Error ? error.message : 'Check your connection and try again.',
      });
    } finally {
      setIsUploadingImage(false);
      e.target.value = '';
    }
  };

  const handleMultipleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    clearFormNotice();
    setIsUploadingMultiple(true);

    try {
      const selected = Array.from(files);
      // allSettled, not all: one rejected file should not discard the ones
      // that uploaded cleanly, and the operator needs to know which failed.
      const results = await Promise.allSettled(selected.map(uploadImageFile));

      const uploadedUrls = results.flatMap(r => (r.status === 'fulfilled' ? [r.value] : []));
      const failures = results.flatMap((r, i) =>
        r.status === 'rejected'
          ? [`${selected[i].name}: ${r.reason instanceof Error ? r.reason.message : 'upload failed'}`]
          : []
      );

      if (uploadedUrls.length > 0) {
        setFormData(prev => ({
          ...prev,
          images: [...(prev.images || []), ...uploadedUrls]
        }));
      }

      if (failures.length === 0) {
        showFormNotice({
          tone: 'success',
          title: `${uploadedUrls.length} image${uploadedUrls.length === 1 ? '' : 's'} uploaded.`,
        });
      } else if (uploadedUrls.length > 0) {
        showFormNotice({
          tone: 'warning',
          title: `${uploadedUrls.length} of ${selected.length} images uploaded — ${failures.length} failed.`,
          detail: 'The successful ones have been added. The rest were not saved.',
          items: failures,
        });
      } else {
        showFormNotice({
          tone: 'error',
          title: `None of the ${selected.length} image${selected.length === 1 ? '' : 's'} could be uploaded.`,
          items: failures,
        });
      }
    } catch (error) {
      showFormNotice({
        tone: 'error',
        title: 'Image upload failed.',
        detail: error instanceof Error ? error.message : 'Check your connection and try again.',
      });
    } finally {
      setIsUploadingMultiple(false);
      e.target.value = '';
    }
  };

  const removeAdditionalImage = (indexToRemove: number) => {
    setFormData(prev => ({
      ...prev,
      images: (prev.images || []).filter((_, i) => i !== indexToRemove)
    }));
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const { name, value, type } = e.target;
    const parsedValue = type === "number" ? (value === "" ? 0 : parseFloat(value) || 0) : value;

    if (name.includes(".")) {
      const parts = name.split(".");
      if (parts.length === 2) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setFormData((prev: any) => ({
          ...prev,
          [parts[0]]: {
            ...(prev[parts[0]] || {}),
            [parts[1]]: parsedValue,
          },
        }));
      }
    } else {
      setFormData((prev) => ({ ...prev, [name]: parsedValue }));
    }
  };

  const handleCheckbox = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, checked } = e.target;
    if (name.includes(".")) {
      const parts = name.split(".");
      if (parts.length === 2) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setFormData((prev: any) => ({
          ...prev,
          [parts[0]]: {
            ...(prev[parts[0]] || {}),
            [parts[1]]: checked,
          },
        }));
      }
    } else {
      setFormData((prev) => ({ ...prev, [name]: checked }));
    }
  };

  // --- Array helpers ---
  const currentRules = formData.terms?.rules || [];
  const currentAmenities = formData.amenities || [];
  const currentHighlights = formData.highlights || [];
  const currentOffers = formData.offers || [];

  const addRule = () => {
    if (!newRule.trim()) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setFormData((prev: any) => ({
      ...prev,
      terms: { ...(prev.terms || {}), rules: [...currentRules, newRule.trim()] }
    }));
    setNewRule("");
  };
  const removeRule = (index: number) => {
    shiftRowEditAfterRemoval("rule", index);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setFormData((prev: any) => ({
      ...prev,
      terms: { ...prev.terms, rules: currentRules.filter((_, i) => i !== index) }
    }));
  };

  const toggleOfferStarred = (offerName: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setFormData((prev: any) => {
      const current: string[] = prev.amenities || [];
      if (current.includes(offerName)) {
        // Unstar — remove from amenities
        return { ...prev, amenities: current.filter(a => a !== offerName) };
      } else if (current.length < 6) {
        // Star — add to amenities (max 6)
        return { ...prev, amenities: [...current, offerName] };
      }
      return prev; // Already at 6, do nothing
    });
  };

  const addHighlight = () => {
    if (!newHighlight.trim() || currentHighlights.length >= 3) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setFormData((prev: any) => ({ ...prev, highlights: [...currentHighlights, newHighlight.trim()] }));
    setNewHighlight("");
  };
  const removeHighlight = (index: number) => {
    shiftRowEditAfterRemoval("highlight", index);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setFormData((prev: any) => ({ ...prev, highlights: currentHighlights.filter((_, i) => i !== index) }));
  };

  // ── Offers (dispatch 29) ──
  // Offers and stars change together, through app/admin/components/offers.ts:
  // a rename carries its star, a delete drops it, and nothing else is touched.

  /** The property's own stored categories, then the standard ones — never "Not included" (Kian's ruling). */
  const categoryOptions = offerCategoryOptions(initialData?.offers, currentOffers);

  const applyOffers = (update: (state: OffersAndStars) => OffersAndStars) =>
    setFormData((prev) => {
      const before: OffersAndStars = { offers: prev.offers || [], amenities: prev.amenities || [] };
      const after = update(before);
      if (after === before) return prev;
      return { ...prev, offers: after.offers, ...(after.amenities !== before.amenities ? { amenities: after.amenities } : {}) };
    });

  const addOfferRow = () => {
    const name = newOfferName.trim();
    if (!name || !newOfferCategory) return;
    if (offerNameTaken(currentOffers, name)) {
      setOfferAddError(`"${name}" is already in the list.`);
      return;
    }
    applyOffers((state) => addOffer(state, name, newOfferCategory));
    setNewOfferName("");
    setOfferAddError(null);
  };

  const deleteOffer = (offer: Offer) => {
    if (rowEdit?.kind === "offer" && rowEdit.target === offer) cancelRowEdit();
    formerCategories.current.delete(offer.name);
    applyOffers((state) => removeOffer(state, offer));
  };

  /** Unticking moves an item to "Not included"; ticking moves it back (Kian's ruling of 2026-10-10). */
  const toggleOfferAvailable = (offer: Offer) => {
    if (offer.available) {
      if (offer.category !== NOT_INCLUDED) formerCategories.current.set(offer.name, offer.category);
      applyOffers((state) => excludeOffer(state, offer));
      return;
    }
    const former = formerCategories.current.get(offer.name);
    if (offer.category !== NOT_INCLUDED || former) {
      formerCategories.current.delete(offer.name);
      applyOffers((state) => includeOffer(state, offer, former));
      return;
    }
    // Where it goes back to is not known (it was imported as not included): the admin picks it.
    startOfferEdit(offer, true);
  };

  const updateOfferIcon = (offer: Offer, svg: string) => {
    const replaced: Offer = { ...offer, icon: svg };
    setFormData((prev) => {
      const offers = prev.offers || [];
      const index = offers.indexOf(offer);
      if (index === -1) return prev;
      const next = offers.slice();
      next[index] = replaced;
      return { ...prev, offers: next };
    });
    setRowEdit((edit) => (edit?.kind === "offer" && edit.target === offer ? { ...edit, target: replaced } : edit));
  };

  // ── Rows edited in place: offers, highlights, house rules (dispatch 29) ──

  /** `data` with the open row edit applied, or what is wrong with the edit. */
  const applyRowEdit = (data: Partial<Property>, edit: RowEdit): { data: Partial<Property> } | { problem: string } => {
    if (edit.kind === "offer") {
      const name = edit.name.trim();
      if (!name) return { problem: "Give it a name." };
      const offers = data.offers || [];
      if (offerNameTaken(offers, name, edit.target)) return { problem: `"${name}" is already in the list.` };
      // An item in "Not included" keeps that category unless it is being included: it follows availability.
      const offered = edit.include || edit.target.category !== NOT_INCLUDED;
      if (offered && (!edit.category || edit.category === NOT_INCLUDED)) return { problem: "Pick a category." };
      const before: OffersAndStars = { offers, amenities: data.amenities || [] };
      const after = editOffer(before, edit.target, {
        name,
        category: offered ? edit.category : edit.target.category,
        available: edit.include ? true : edit.target.available,
      });
      if (after === before) return { data };
      return { data: { ...data, offers: after.offers, ...(after.amenities !== before.amenities ? { amenities: after.amenities } : {}) } };
    }
    const value = edit.value.trim();
    if (!value) return { problem: "Empty — delete it instead." };
    if (edit.kind === "highlight") {
      const highlights = data.highlights || [];
      if (highlights[edit.index] === value) return { data };
      return { data: { ...data, highlights: highlights.map((h, i) => (i === edit.index ? value : h)) } };
    }
    const rules = data.terms?.rules || [];
    if (rules[edit.index] === value) return { data };
    return { data: { ...data, terms: { ...(data.terms as Property["terms"]), rules: rules.map((r, i) => (i === edit.index ? value : r)) } } };
  };

  /** A renamed item keeps the category it is remembered by. */
  const carryFormerCategory = (edit: RowEdit) => {
    if (edit.kind !== "offer") return;
    const former = formerCategories.current.get(edit.target.name);
    if (former === undefined || edit.name.trim() === edit.target.name) return;
    formerCategories.current.delete(edit.target.name);
    if (!edit.include) formerCategories.current.set(edit.name.trim(), former);
  };

  /** Apply the open row edit. False, with the reason shown on the row, when it cannot be applied. */
  const commitRowEdit = (): boolean => {
    if (!rowEdit) return true;
    const result = applyRowEdit(formData, rowEdit);
    if ("problem" in result) {
      setRowEditError(result.problem);
      return false;
    }
    carryFormerCategory(rowEdit);
    if (result.data !== formData) setFormData(result.data);
    setRowEdit(null);
    setRowEditError(null);
    return true;
  };

  function cancelRowEdit() {
    setRowEdit(null);
    setRowEditError(null);
  }

  function startOfferEdit(offer: Offer, include = false) {
    if (!commitRowEdit()) return;
    setRowEdit({ kind: "offer", target: offer, name: offer.name, category: include ? "" : offer.category, include });
  }

  const startListEdit = (kind: "highlight" | "rule", index: number) => {
    if (!commitRowEdit()) return;
    setRowEdit({ kind, index, value: (kind === "highlight" ? currentHighlights : currentRules)[index] ?? "" });
  };

  /** A highlight or rule above the one being edited went: the edit follows its row. */
  function shiftRowEditAfterRemoval(kind: "highlight" | "rule", removed: number) {
    if (rowEdit?.kind !== kind) return;
    if (rowEdit.index === removed) cancelRowEdit();
    else if (rowEdit.index > removed) setRowEdit({ ...rowEdit, index: rowEdit.index - 1 });
  }

  const rowEditKeys = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitRowEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelRowEdit();
    }
  };

  /**
   * Open the section holding `el`, then bring it into view and focus it (dispatch 29).
   * `report` shows the browser's own message beside a missing required field.
   */
  const pointAt = (el: HTMLElement, report = false) => {
    const key = el.closest<HTMLElement>("[data-section]")?.dataset.section;
    const ready = !key || (openSections[key] && settledSections[key]);
    if (key && !openSections[key]) setOpenSections((prev) => ({ ...prev, [key]: true }));
    window.setTimeout(() => {
      el.scrollIntoView({ block: "center" });
      const target = el.matches("input, textarea, select, button")
        ? el
        : el.closest(`.${styles.field}`)?.querySelector<HTMLElement>("input, textarea, button") ?? null;
      target?.focus({ preventScroll: true });
      if (report && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) el.reportValidity();
    }, ready ? 0 : 450);
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;

    // An open row edit is part of what the admin is saving: apply it, or
    // point at what is wrong with it and save nothing.
    let data = formData;
    if (rowEdit) {
      const applied = applyRowEdit(data, rowEdit);
      if ("problem" in applied) {
        setRowEditError(applied.problem);
        const input = form.querySelector<HTMLElement>("[data-row-edit] input[type=text]");
        if (input) pointAt(input);
        return;
      }
      carryFormerCategory(rowEdit);
      data = applied.data;
      if (data !== formData) setFormData(data);
      setRowEdit(null);
      setRowEditError(null);
    }

    // The form is `noValidate` (dispatch 29): the browser used to put its
    // message over a closed section, where the field could not be seen.
    // Open the section holding the first missing field and point at it.
    setSubmitAttempted(true);
    const missing = Array.from(form.elements).find(
      (el): el is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement =>
        (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) &&
        el.willValidate &&
        !el.checkValidity(),
    );
    if (missing) {
      pointAt(missing, true);
      return;
    }

    setIsSaving(true);
    setSaveError(null);
    setSaveIssues([]);

    const finalData = { ...data };
    const isEdit = !!initialData?.id;



    // ── One price ──
    // The form has a single nightly-price input; the legacy top-level `price`
    // is written from it rather than entered separately. This is the only
    // place `price` is set, and it is what converges a divergent document —
    // on an explicit save, by an operator who has seen the warning. Nothing
    // rewrites a stored document on its own.
    finalData.price = finalData.priceInfo?.nightly ?? 0;

    // ── Airbnb URL: canonical on create, untouched on an unedited update ──
    // A pasted URL carries tracking parameters, and a dated one points at a
    // different page than the listing. But rewriting a *stored* URL that the
    // operator never touched would mean opening a property and saving it
    // silently changed a field — so normalise only what they actually typed.
    const storedAirbnbUrl = initialData?.airbnbUrl ?? '';
    const typedAirbnbUrl = airbnbUrl.trim();
    const airbnbUrlEdited = typedAirbnbUrl !== storedAirbnbUrl.trim();
    if (typedAirbnbUrl) {
      finalData.airbnbUrl =
        !isEdit || airbnbUrlEdited ? normalizeAirbnbUrl(typedAirbnbUrl) : storedAirbnbUrl;
    }

    if (googleMapsUrl.trim()) finalData.googleMapsUrl = googleMapsUrl.trim();

    // ── Empty optional URLs ──
    // The form initialises these to "". CreatePropertySchema validates them
    // with z.string().url(), which rejects "", so every create that omitted a
    // link returned 422. Send them absent instead — `optional()` already means
    // "may be missing", so nothing about the schema has to be loosened.
    //
    // Updates keep the "": UpdatePropertySchema accepts it deliberately
    // (`urlOrEmpty`), and it is how the operator clears a link they had set.
    if (!isEdit) {
      for (const key of ['airbnbUrl', 'googleMapsUrl', 'icalUrl'] as const) {
        const value = finalData[key];
        if (typeof value === 'string' && value.trim() === '') delete finalData[key];
      }
    }

    // One slug function, shared with the URL layer. The old inline generator
    // dropped "&" where the URL layer turns it into "and", so the two
    // disagreed on every name containing one.
    //
    // Still only generated when empty: regenerating on rename would change
    // the stored slug of an existing document, and stored slugs are what old
    // links resolve against.
    if (!finalData.slug && finalData.name) {
      finalData.slug = toSlug(finalData.name);
    }

    // `onSave()` used to run unconditionally, so the modal closed and the list
    // refetched whether or not the write landed. Close only on confirmed
    // success; on failure keep the modal, the entered data, and show why.
    // ── Unlisted, before anything else on an edit (dispatch 24) ──
    // Unlisting takes the property off the public site before any other change
    // is published; listing it again is the same one write. A create carries
    // the flag itself, and the route writes both at once.
    if (initialData?.id && unlisted !== loadedUnlisted) {
      const shown = await setUnlisted(initialData.id, unlisted);
      if (!shown.ok) {
        setIsSaving(false);
        setSaveError({
          title: `Not saved — ${shown.error}`,
          detail: shown.status === 401 || shown.status === 403 ? 'Your admin session may have expired. Open the admin in a new tab to sign in again, then save — your entries here are kept.' : 'Nothing was saved. Your entries are kept; save again to retry.',
        });
        return;
      }
      setLoadedUnlisted(shown.data.unlisted);
    }

    const result = initialData?.id
      ? await updateProperty(initialData.id, finalData)
      : await addProperty(finalData as Omit<Property, "id">, { unlisted });

    setIsSaving(false);

    if (result.ok) {
      // ── Mirror the images, as a separate step after the save ──
      //
      // The save is already durable at this point and nothing below can undo
      // it. Mirroring runs second and on its own request because it fetches
      // every image of the property: coupling it to the save would let a slow
      // CDN fail a write that had nothing wrong with it.
      //
      // On failure the document keeps whatever `coverImageStored` /
      // `imagesStored` it already had — the route never writes them unless
      // every image landed — and the modal stays open carrying the warning,
      // so the operator learns that the property saved but its images did
      // not mirror. scripts/mirror-images.mjs catches up afterwards.
      const savedId = initialData?.id || (result.data as { id?: string })?.id;

      // ── The name cleaners see, as its own write, when it changed ──
      // It lives in its own collection, so it is saved by its own route once
      // the property is safely saved. A failure here leaves the property
      // saved and says so; the modal stays open to retry.
      if (savedId && cleanerFacingNameState !== "unavailable") {
        const typed = cleanerFacingName.trim();
        const loaded = loadedCleanerFacingName ?? null;
        if (typed !== (loaded ?? "")) {
          const named = await setCleanerFacingName(savedId, typed === "" ? null : typed);
          if (!named.ok) {
            showFormNotice({
              tone: "warning",
              title: "Saved — but the name for cleaners was not.",
              detail: `${named.error} The property itself is saved. Save again to retry the name.`,
            });
            return;
          }
          setLoadedCleanerFacingName(named.data.name);
          setCleanerFacingName_(named.data.name ?? "");
        }
      }

      // ── The statements record, as its own write, when it changed (dispatch 23B) ──
      if (savedId && managementState !== "unavailable" && JSON.stringify(management) !== loadedManagement) {
        const payload = toManagementPayload(management);
        if ("problem" in payload) {
          showFormNotice({ tone: "warning", title: "Saved — but the statements record was not.", detail: `${payload.problem} The property itself is saved. Fix it and save again.` });
          return;
        }
        const stored = await setManagement(savedId, payload.record);
        if (!stored.ok) {
          showFormNotice({ tone: "warning", title: "Saved — but the statements record was not.", detail: `${stored.error} The property itself is saved. Save again to retry.` });
          return;
        }
        setLoadedManagement(JSON.stringify(management));
      }

      if (savedId) {
        setIsMirroring(true);
        try {
          const res = await fetch('/api/mirror-property-images', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: savedId }),
          });
          if (!res.ok) {
            const failure = await describeHttpFailure(res, 'Images were not mirrored');
            setIsMirroring(false);
            showFormNotice({
              tone: 'warning',
              title: 'Saved — but the images were not mirrored.',
              detail:
                `${failure.title} The property itself is saved and its previously mirrored ` +
                `images are unchanged. Save again to retry, or run scripts/mirror-images.mjs.`,
            });
            return;
          }
        } catch (err) {
          setIsMirroring(false);
          showFormNotice({
            tone: 'warning',
            title: 'Saved — but the images were not mirrored.',
            detail:
              `${err instanceof Error ? err.message : 'The mirroring request failed.'} ` +
              `The property itself is saved and its previously mirrored images are unchanged.`,
          });
          return;
        }
        setIsMirroring(false);
      }

      onSave();
      return;
    }

    setSaveIssues(result.issues);
    setSaveError({
      title:
        result.issues.length > 0
          ? `Not saved — ${result.issues.length} field${result.issues.length === 1 ? '' : 's'} rejected by the server.`
          : `Not saved — ${result.error}`,
      detail:
        result.status === 401 || result.status === 403
          ? 'Your admin session may have expired. Open the admin in a new tab to sign in again, then save — your entries here are kept.'
          : result.status === 0
            ? 'The request never reached the server. Your entries are kept; check your connection and try again.'
            : result.issues.length > 0
              ? 'Fix the highlighted fields below and save again. Nothing you typed has been lost.'
              : `HTTP ${result.status}. Your entries are kept.`,
    });

    // Open every accordion holding a rejected field so no error is collapsed.
    if (result.issues.length > 0) {
      setOpenSections(prev => {
        const next = { ...prev };
        for (const issue of result.issues) {
          const section = ISSUE_SECTION[issue.path.split('.')[0]];
          if (section) next[section] = true;
        }
        return next;
      });
      // Then point at the first field the server refused (dispatch 29), once its section has opened.
      window.setTimeout(() => {
        const first = form.querySelector<HTMLElement>("[data-issue]");
        if (first) pointAt(first);
      }, 450);
    }
  };

  /** One highlight or house rule: its text with Edit and Delete, or, while edited, an input with Save and Cancel. */
  const renderListRow = (kind: "highlight" | "rule", text: string, index: number, onRemove: () => void) => {
    const editing = rowEdit && rowEdit.kind !== "offer" && rowEdit.kind === kind && rowEdit.index === index ? rowEdit : null;
    const noun = kind === "highlight" ? "highlight" : "rule";
    if (editing) {
      return (
        <Fragment key={index}>
          <div className={styles.listItem} data-row-edit>
            <input
              type="text"
              className={`${styles.dataSourceInput} ${styles.rowEditInput}`}
              value={editing.value}
              autoFocus
              aria-label={`Edit ${noun}`}
              onChange={(e) => { setRowEdit({ ...editing, value: e.target.value }); setRowEditError(null); }}
              onKeyDown={rowEditKeys}
            />
            <div className={styles.rowActions}>
              <button type="button" className={styles.rowConfirmBtn} title="Save" aria-label={`Save ${noun}`} onClick={commitRowEdit}><Check size={14} /></button>
              <button type="button" className={styles.rowPlainBtn} title="Cancel" aria-label="Cancel" onClick={cancelRowEdit}><X size={14} /></button>
            </div>
          </div>
          {rowEditError && <span className={styles.fieldIssue} role="alert">{rowEditError}</span>}
        </Fragment>
      );
    }
    return (
      <div key={index} className={styles.listItem}>
        <span className={styles.rowText}>{text}</span>
        <div className={styles.rowActions}>
          <button type="button" className={styles.rowPlainBtn} title="Edit" aria-label={`Edit ${noun}: ${text}`} onClick={() => startListEdit(kind, index)}><Pencil size={14} /></button>
          <button type="button" className={styles.iconBtn} title="Delete" aria-label={`Delete ${noun}: ${text}`} onClick={onRemove}><Trash2 size={16} /></button>
        </div>
      </div>
    );
  };

  return (
    <div className={styles.overlay}>
      <div className={styles.modal}>
        <div className={styles.header}>
          <h2>{initialData ? "Edit Property" : "Add New Property"}</h2>
          <button type="button" className={styles.closeBtn} onClick={onClose} disabled={isSaving}>
            <X size={28} />
          </button>
        </div>
        
        <form onSubmit={handleSubmit} className={`${styles.form} ${submitAttempted ? styles.attempted : ''}`} noValidate>

          {/* ── Two stored prices, one of them invisible to renters ──
              Informational. It does not block saving and asks for no
              confirmation: the price input is seeded with the price renters
              are already seeing, so saving this form untouched reconciles the
              two stored fields onto that value and changes nothing anyone is
              quoted. Sits above everything, outside every accordion, so it is
              read before the form is touched. */}
          {storedPriceConflict && (
            <div className={styles.priceWarning} role="status">
              <p className={styles.priceWarningHead}>
                <AlertTriangle size={18} aria-hidden />
                This property stores two different prices
              </p>
              {/* The badge follows the helper, not the field name. When nightly
                  is 0 the helper falls back to the base price, and renters are
                  seeing that — marking nightly here would contradict the line
                  below it. */}
              <div className={styles.priceWarningValues}>
                <span className={styles.priceWarningValue}>
                  Stored base price: <b>${storedPriceConflict.base.toLocaleString()}</b>
                  {storedPriceConflict.shown === storedPriceConflict.base && (
                    <span className={styles.priceWarningSeen}> ← what renters see</span>
                  )}
                </span>
                <span className={styles.priceWarningValue}>
                  Stored nightly price: <b>${storedPriceConflict.nightly.toLocaleString()}</b>
                  {storedPriceConflict.shown === storedPriceConflict.nightly && (
                    <span className={styles.priceWarningSeen}> ← what renters see</span>
                  )}
                </span>
              </div>
              <p className={styles.priceWarningBody}>
                Renters currently see{' '}
                <b>${storedPriceConflict.shown.toLocaleString()}</b> on the card, the map pin and
                the property page — and the price below is already set to it. Saving sets{' '}
                <em>both</em> stored fields to{' '}
                <b>${pendingNightly.toLocaleString()}</b>
                {pendingNightly === storedPriceConflict.shown
                  ? ', so nothing a renter sees changes.'
                  : `, changing what renters see from $${storedPriceConflict.shown.toLocaleString()}.`}
              </p>
            </div>
          )}

          {/* --- On the site, and in reporting (dispatch 24) --- */}
          <div className={styles.section}>
            <h3>Status</h3>
            <div className={styles.checkboxGroup}>
              <label className={styles.checkboxItem} title="Not on the public site: the homepage, the map, its own page and the property API. Still in the admin, the cleaner app and availability.">
                <input type="checkbox" checked={unlisted} onChange={(e) => setUnlistedDraft(e.target.checked)} aria-label="Unlisted" />
                Unlisted
              </label>
              <label
                className={styles.checkboxItem}
                title={
                  managementState === "unavailable"
                    ? "The statements record could not be read, so this cannot be changed until the form is reopened."
                    : "Owes no statements: left out of the Statement column's counts, the tile and the home panel. Costs and income stay."
                }
              >
                <input
                  type="checkbox"
                  checked={management.excluded}
                  disabled={managementState === "loading" || managementState === "unavailable"}
                  onChange={(e) => setManagement_({ ...management, excluded: e.target.checked })}
                  aria-label="Exclude from reporting"
                />
                Exclude from reporting
              </label>
            </div>
          </div>

          {/* --- Data Sources --- */}
          <div className={styles.section}>
            <h3>Data Sources</h3>
            <p className={styles.sectionHint}>
              Paste links to auto-fill property data, location, and availability.
            </p>

            {/* Airbnb Import */}
            <div className={styles.dataSourceGroup}>
              <label className={styles.dataSourceLabel}>🏠 Airbnb Listing</label>
              <div className={styles.addInputGroup}>
                <div style={{ position: 'relative', flex: 1 }}>
                  <Link2 size={16} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: '#555' }} />
                  <input
                    type="url"
                    value={airbnbUrl}
                    onChange={(e) => setAirbnbUrl(e.target.value)}
                    placeholder="https://www.airbnb.ca/rooms/..."
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleScrapeAirbnb(); } }}
                    disabled={isScraping}
                    className={`${styles.dataSourceInput} ${styles.dataSourceInputWithIcon}`}
                  />
                </div>
                <button
                  type="button"
                  className={styles.addBtnSmall}
                  onClick={handleScrapeAirbnb}
                  disabled={isScraping || !airbnbUrl.trim()}
                >
                  {isScraping ? <svg className={styles.spinner} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg> : <Link2 size={16} />}
                  {isScraping ? 'Scraping...' : 'Import'}
                </button>
              </div>
              {fieldIssue('airbnbUrl')}
              <NoticeBanner notice={scrapeNotice} onDismiss={() => setScrapeNotice(null)} className={styles.inlineNotice} />

              {/* Per-field extraction report — every field the scraper returned,
                  so a silently defaulted value cannot pass as listing data. */}
              {extractionSummary && (
                <div className={styles.scrapeReport}>
                  <div className={styles.scrapeReportCounts}>
                    <span className={styles.scrapeBadgeExtracted}><Check size={11} /> {extractionSummary.extracted} extracted</span>
                    <span className={styles.scrapeBadgeDefaulted}><AlertTriangle size={11} /> {extractionSummary.defaulted} defaulted</span>
                    <span className={styles.scrapeBadgeFailed}><XCircle size={11} /> {extractionSummary.failed} not found</span>
                    <span className={styles.scrapeReportTotal}>of {extractionSummary.total} fields</span>
                  </div>
                  {(['defaulted', 'failed'] as const).map((status) => {
                    const rows = fieldsWithStatus(status);
                    if (rows.length === 0) return null;
                    return (
                      <ul key={status} className={styles.scrapeReportList}>
                        {rows.map((row) => (
                          <li key={row.field}>
                            <span className={status === 'defaulted' ? styles.scrapeBadgeDefaulted : styles.scrapeBadgeFailed}>
                              {status === 'defaulted' ? `Default "${String(row.defaultUsed)}"` : 'Not found'}
                            </span>
                            <strong>{row.label}</strong>
                            <span className={styles.scrapeReportReason}>{row.reason}</span>
                          </li>
                        ))}
                      </ul>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Google Maps Location */}
            <div className={styles.dataSourceGroup}>
              <label className={styles.dataSourceLabel}>📍 Google Maps Link</label>
              <div className={styles.addInputGroup}>
                <input
                  type="url"
                  value={googleMapsUrl}
                  onChange={(e) => setGoogleMapsUrl(e.target.value)}
                  placeholder="https://maps.app.goo.gl/... or any Google Maps link"
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleParseGoogleMaps(); } }}
                  disabled={isParsingMaps}
                  className={styles.dataSourceInput}
                  style={{ flex: 1 }}
                />
                <button
                  type="button"
                  className={styles.addBtnSmall}
                  onClick={handleParseGoogleMaps}
                  disabled={isParsingMaps || !googleMapsUrl.trim()}
                >
                  {isParsingMaps ? <svg className={styles.spinner} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg> : '📍'}
                  {isParsingMaps ? 'Locating...' : 'Get Location'}
                </button>
              </div>
              {fieldIssue('googleMapsUrl')}
              <NoticeBanner notice={mapsNotice} onDismiss={() => setMapsNotice(null)} className={styles.inlineNotice} />
            </div>

            {/* iCal URL */}
            <div>
              <label className={styles.dataSourceLabel}>📅 iCal URL (Availability)</label>
              <input
                type="url"
                name="icalUrl"
                value={formData.icalUrl || ""}
                onChange={handleChange}
                placeholder="https://example.com/calendar.ics"
                className={`${styles.dataSourceInput} ${issueClass('icalUrl')}`}
              />
              {fieldIssue('icalUrl')}
            </div>
          </div>

          {/* --- Basic Info (Accordion) --- */}
          {renderAccordionSection("basic", "Basic Info", (<>
            <div className={styles.grid}>
              <div className={styles.field} style={{ gridColumn: '1 / -1' }}>
                <label>Cover Banner Image * {scrapeBadge('coverImage')}</label>
                {fieldIssue('coverImage')}
                <div className={`${styles.imageBannerContainer} ${formData.coverImage ? styles.hasImage : ''}`}>
                  {formData.coverImage && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={formData.coverImage} alt="Cover Preview" className={styles.bannerImage} />
                  )}
                  
                  <label className={styles.uploadOverlay}>
                    {isUploadingImage ? (
                      <svg className={`${styles.spinner} ${styles.uploadIcon}`} width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
                    ) : (
                      <ImageIcon size={32} className={styles.uploadIcon} />
                    )}
                    <span className={styles.uploadText}>
                      {isUploadingImage ? "Uploading..." : (formData.coverImage ? "Change Cover Image" : "Upload Cover Image")}
                    </span>
                    <input 
                      type="file" 
                      accept={ACCEPTED_IMAGE_TYPES}
                      onChange={handleImageUpload} 
                      disabled={isUploadingImage} 
                      className={styles.fileInputHidden}
                    />
                  </label>
                </div>
              </div>

              <div className={styles.field} style={{ gridColumn: '1 / -1' }}>
                <label>Additional Property Images {scrapeBadge('images')}</label>
                {fieldIssue('images')}
                <div className={styles.imagesGrid}>
                  {(formData.images || []).map((imgUrl, idx) => (
                    <div key={idx} className={styles.imageCard}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={imgUrl} alt={`Property Image ${idx + 1}`} />
                      <button type="button" className={styles.removeImageBtn} onClick={() => removeAdditionalImage(idx)}>
                        <X size={16} />
                      </button>
                    </div>
                  ))}
                  
                  <label className={styles.uploadCard}>
                    {isUploadingMultiple ? (
                      <svg className={styles.spinner} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#999" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
                    ) : (
                      <ImagePlus size={24} className="text-gray-400" />
                    )}
                    <span>{isUploadingMultiple ? "Uploading..." : "Add Images"}</span>
                    <input 
                      type="file" 
                      accept={ACCEPTED_IMAGE_TYPES}
                      multiple
                      onChange={handleMultipleImageUpload} 
                      disabled={isUploadingMultiple} 
                      className={styles.fileInputHidden}
                    />
                  </label>
                </div>
              </div>

              <div className={styles.field}>
                <label>Title {scrapeBadge('name')}</label>
                <input type="text" name="name" value={formData.name || ""} onChange={handleChange} required placeholder="e.g. Modern Villa" className={`${scrapeClass('name')} ${issueClass('name')}`} />
                {fieldIssue('name')}
                {fieldIssue('slug')}
              </div>
              {/* The name cleaners see (dispatch 21): its own server-only record, never a field of the property. */}
              <div className={styles.field}>
                <label>Name for cleaners</label>
                <input
                  type="text"
                  name="cleanerFacingName"
                  value={cleanerFacingName}
                  onChange={(e) => setCleanerFacingName_(e.target.value)}
                  maxLength={120}
                  placeholder={
                    cleanerFacingNameState === "loading"
                      ? "Loading…"
                      : `Leave empty to show cleaners “${formData.name || "the title"}”`
                  }
                  disabled={cleanerFacingNameState === "loading" || cleanerFacingNameState === "unavailable"}
                />
                <small>
                  Cleaners see this name in their app instead of the title, in search, on the property screen and in their
                  receipts. The public site and this admin keep the title. It is stored apart from the property and never
                  reaches the public site.
                  {cleanerFacingNameState === "unavailable" && " It could not be read just now, so it cannot be changed here until the form is reopened."}
                </small>
              </div>
              {/* Statements (dispatch 23B; "Report For" and the fee rate, 23E): a server-only record beside the property, never on it. */}
              <div className={styles.field}>
                <label>Statements</label>
                <small>
                  Who the Payment Summary is for, the months statements run, and the fee rate a statement starts from. Stored
                  apart from the property; nothing here reaches the public site, and nothing sends email.
                  {managementState === "unavailable" && " It could not be read just now, so it cannot be changed here until the form is reopened."}
                </small>
                <fieldset className={styles.managementBlock} disabled={managementState === "loading" || managementState === "unavailable"}>
                  <div className={styles.managementRow}>
                    <label className={styles.managementLabel}>
                      Report For
                      <input type="text" placeholder="Name" value={management.reportForName} maxLength={STATEMENT_LIMITS.REPORT_FOR_NAME_MAX} onChange={(e) => setManagement_({ ...management, reportForName: e.target.value })} aria-label="Report For name" />
                    </label>
                    <label className={styles.managementLabel}>
                      Address
                      <textarea placeholder={"321-20 John St.\nToronto, ON, M5V 0G5"} value={management.reportForAddress} maxLength={STATEMENT_LIMITS.REPORT_FOR_ADDRESS_MAX} rows={3} onChange={(e) => setManagement_({ ...management, reportForAddress: e.target.value })} aria-label="Report For address" />
                    </label>
                  </div>
                  {management.owners.map((owner, i) => (
                    <div key={i} className={styles.managementRow}>
                      <input type="text" placeholder="Owner's name" value={owner.name} maxLength={STATEMENT_LIMITS.OWNER_NAME_MAX} onChange={(e) => setManagement_({ ...management, owners: management.owners.map((o, j) => (j === i ? { ...o, name: e.target.value } : o)) })} aria-label={`Owner ${i + 1} name`} />
                      <input type="text" placeholder="Email (optional, not used yet)" value={owner.email} maxLength={STATEMENT_LIMITS.OWNER_EMAIL_MAX} onChange={(e) => setManagement_({ ...management, owners: management.owners.map((o, j) => (j === i ? { ...o, email: e.target.value } : o)) })} aria-label={`Owner ${i + 1} email`} />
                      <button type="button" className={styles.managementRemove} aria-label={`Remove owner ${i + 1}`} onClick={() => setManagement_({ ...management, owners: management.owners.filter((_, j) => j !== i) })}>
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                  {management.owners.length < STATEMENT_LIMITS.OWNERS_MAX && (
                    <button type="button" className={styles.managementAdd} onClick={() => setManagement_({ ...management, owners: [...management.owners, { name: "", email: "" }] })}>
                      <Plus size={14} /> Add an owner
                    </button>
                  )}
                  <div className={styles.managementRow}>
                    <label className={styles.managementLabel}>
                      Statements from
                      <input type="month" value={management.from} onChange={(e) => setManagement_({ ...management, from: e.target.value })} />
                    </label>
                    <label className={styles.managementLabel}>
                      until (optional)
                      <input type="month" value={management.until} onChange={(e) => setManagement_({ ...management, until: e.target.value })} />
                    </label>
                  </div>
                  <div className={styles.managementRow}>
                    <label className={styles.managementLabel}>
                      Default fee rate (%)
                      <input type="text" inputMode="decimal" placeholder="20" value={management.feeRate} onChange={(e) => setManagement_({ ...management, feeRate: e.target.value })} />
                    </label>
                  </div>
                </fieldset>
              </div>
              <div className={styles.field}>
                <label>Display Location * {scrapeBadge('location')}</label>
                {fieldIssue('location')}
                <CustomSelect 
                  options={GTA_CITIES} 
                  value={formData.location || ""} 
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  onChange={(val) => handleChange({ target: { name: 'location', value: val } } as any)} 
                  placeholder="Select a city"
                />
              </div>

              <div className={styles.field}>
                <label>Type</label>
                {fieldIssue('type')}
                <CustomSelect 
                  options={PROPERTY_TYPES} 
                  value={formData.type || ""} 
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  onChange={(val) => handleChange({ target: { name: 'type', value: val } } as any)} 
                  placeholder="Select property type"
                />
              </div>
              <div className={styles.field}>
                <label>Property Tag {scrapeBadge('propertyTypeTag')}</label>
                {fieldIssue('propertyTypeTag')}
                <CustomSelect 
                  options={PROPERTY_TYPE_TAGS} 
                  value={formData.propertyTypeTag || ""} 
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  onChange={(val) => handleChange({ target: { name: 'propertyTypeTag', value: val } } as any)} 
                  placeholder="Select a tag"
                />
              </div>
            </div>
            <div className={styles.field}>
              <label>Description {scrapeBadge('description')}</label>
              <textarea name="description" value={formData.description || ""} onChange={handleChange} rows={10} required placeholder="Describe the property..." className={`${scrapeClass('description')} ${issueClass('description')}`} />
              {fieldIssue('description')}
            </div>
          </>))}

          {/* --- Location (Accordion) --- */}
          {renderAccordionSection("location", "Location", (<>
            <div className={styles.grid}>
              {/* Coordinates (auto-filled from Google Maps or manual) */}
              <div className={styles.field}>
                <label>Latitude</label>
                <input 
                  type="number" 
                  step="any"
                  value={formData.coordinates?.[1] || 0}
                  onChange={(e) => setFormData(prev => ({ ...prev, coordinates: [prev.coordinates?.[0] || 0, parseFloat(e.target.value) || 0] }))}
                  placeholder="e.g. 43.8561"
                />
              </div>
              <div className={styles.field}>
                <label>Longitude</label>
                <input 
                  type="number" 
                  step="any"
                  value={formData.coordinates?.[0] || 0}
                  onChange={(e) => setFormData(prev => ({ ...prev, coordinates: [parseFloat(e.target.value) || 0, prev.coordinates?.[1] || 0] }))}
                  placeholder="e.g. -79.3193"
                />
              </div>
              <div className={styles.field}>
                <label>City</label>
                <input type="text" name="addressDetails.city" value={formData.addressDetails?.city || ""} onChange={handleChange} required className={issueClass('addressDetails.city')} />
                {fieldIssue('addressDetails.city')}
              </div>
              <div className={styles.field}>
                <label>State/Province *</label>
                {fieldIssue('addressDetails.state')}
                <CustomSelect
                  options={CANADIAN_PROVINCES} 
                  value={formData.addressDetails?.state || ""} 
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  onChange={(val) => handleChange({ target: { name: 'addressDetails.state', value: val } } as any)} 
                  placeholder="Select a province"
                />
              </div>
              <div className={styles.field}>
                <label>Area</label>
                <input type="text" name="addressDetails.area" value={formData.addressDetails?.area || ""} onChange={handleChange} required className={issueClass('addressDetails.area')} />
                {fieldIssue('addressDetails.area')}
              </div>
              <div className={styles.field}>
                <label>Country</label>
                <input type="text" name="addressDetails.country" value={formData.addressDetails?.country || ""} onChange={handleChange} required className={issueClass('addressDetails.country')} />
                {fieldIssue('addressDetails.country')}
              </div>
              <div className={styles.field}>
                <label>Check In Time {scrapeBadge('checkIn')}</label>
                <input type="text" name="details.checkIn" value={formData.details?.checkIn || ""} onChange={handleChange} required placeholder="e.g. 4:00 PM" className={`${scrapeClass('checkIn')} ${issueClass('details.checkIn')}`} />
                {fieldIssue('details.checkIn')}
              </div>
              <div className={styles.field}>
                <label>Check Out Time {scrapeBadge('checkOut')}</label>
                <input type="text" name="details.checkOut" value={formData.details?.checkOut || ""} onChange={handleChange} required placeholder="e.g. 11:00 AM" className={`${scrapeClass('checkOut')} ${issueClass('details.checkOut')}`} />
                {fieldIssue('details.checkOut')}
              </div>
            </div>
          </>))}

          {/* --- Capacity & Pricing (Accordion) --- */}
          {renderAccordionSection("capacity", "Capacity & Pricing", (<>
            <div className={styles.grid}>
              <div className={styles.field}>
                <label>Bedrooms {scrapeBadge('bedrooms')}</label>
                <input type="number" name="bedrooms" value={formData.bedrooms ?? 0} onChange={handleChange} required className={`${scrapeClass('bedrooms')} ${issueClass('bedrooms')}`} />
                {fieldIssue('bedrooms')}
              </div>
              <div className={styles.field}>
                <label>Beds {scrapeBadge('beds')}</label>
                <input type="number" name="beds" value={formData.beds ?? 0} onChange={handleChange} required className={`${scrapeClass('beds')} ${issueClass('beds')}`} />
                {fieldIssue('beds')}
              </div>
              <div className={styles.field}>
                <label>Bathrooms {scrapeBadge('bathrooms')}</label>
                <input type="number" step="0.5" name="bathrooms" value={formData.bathrooms ?? 0} onChange={handleChange} required className={`${scrapeClass('bathrooms')} ${issueClass('bathrooms')}`} />
                {fieldIssue('bathrooms')}
              </div>
              <div className={styles.field}>
                <label>Max Guests {scrapeBadge('guests')}</label>
                <input type="number" name="guests" value={formData.guests ?? 0} onChange={handleChange} required className={`${scrapeClass('guests')} ${issueClass('guests')}`} />
                {fieldIssue('guests')}
              </div>
            </div>
            <hr className={styles.sectionDivider} />
            <div className={styles.grid}>
              {/* One price. This input is the nightly price, and on save it is
                  written to both `priceInfo.nightly` and the legacy `price`
                  field. There used to be a separate "Base Price" input here
                  writing `price` on its own, which is how 3 of the 43
                  properties ended up with two different numbers. `price` has
                  no input of its own any more, so it cannot diverge again.
                  Both issue paths render here, because both fields now come
                  from this one value. */}
              <div className={styles.field} style={{ gridColumn: '1 / -1' }}>
                <label>Nightly Price ({formData.currency || 'CAD'}) * {scrapeBadge('price')}</label>
                <input type="number" name="priceInfo.nightly" value={formData.priceInfo?.nightly ?? 0} onChange={handleChange} required className={`${scrapeClass('price')} ${issueClass('priceInfo.nightly')} ${issueClass('price')}`} />
                {fieldIssue('priceInfo.nightly')}
                {fieldIssue('price')}
                <p className={styles.fieldHint}>
                  The price shown on cards, map pins and the property page.
                </p>
              </div>
              <div className={styles.field}>
                <label>Weekly Price</label>
                <input type="number" name="priceInfo.weekly" value={formData.priceInfo?.weekly ?? 0} onChange={handleChange} required className={issueClass('priceInfo.weekly')} />
                {fieldIssue('priceInfo.weekly')}
              </div>
              <div className={styles.field}>
                <label>Monthly Price</label>
                <input type="number" name="priceInfo.monthly" value={formData.priceInfo?.monthly ?? 0} onChange={handleChange} required className={issueClass('priceInfo.monthly')} />
                {fieldIssue('priceInfo.monthly')}
              </div>
              <div className={styles.field}>
                <label>Weekend Price</label>
                <input type="number" name="priceInfo.weekend" value={formData.priceInfo?.weekend ?? 0} onChange={handleChange} required className={issueClass('priceInfo.weekend')} />
                {fieldIssue('priceInfo.weekend')}
              </div>
              <div className={styles.field}>
                <label>Cleaning Fee</label>
                <input type="number" name="priceInfo.cleaningFee" value={formData.priceInfo?.cleaningFee ?? 0} onChange={handleChange} required className={issueClass('priceInfo.cleaningFee')} />
                {fieldIssue('priceInfo.cleaningFee')}
              </div>
              <div className={styles.field}>
                <label>Min. Nights</label>
                <input type="number" name="priceInfo.minNights" value={formData.priceInfo?.minNights ?? 0} onChange={handleChange} required className={issueClass('priceInfo.minNights')} />
                {fieldIssue('priceInfo.minNights')}
              </div>
            </div>
          </>))}

          {/* --- 3 Main Highlights (Accordion) --- */}
          {renderAccordionSection("highlights", "3 Main Highlights", (<>
            <p className={styles.sectionHint}>
              Top standout features shown as badges — e.g. &quot;City View&quot;, &quot;Park for Free&quot;, &quot;Self check-in&quot; {scrapeBadge('highlights')}
            </p>
            {fieldIssue('highlights')}
            <div className={styles.listContainer}>
              {currentHighlights.map((hl, i) => renderListRow("highlight", hl, i, () => removeHighlight(i)))}
              {currentHighlights.length < 3 && (
                <div className={styles.addInputGroup}>
                  <input 
                    type="text" 
                    value={newHighlight} 
                    onChange={(e) => setNewHighlight(e.target.value)}
                    placeholder="e.g. City skyline view"
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addHighlight(); } }}
                    className={styles.dataSourceInput}
                    style={{ flex: 1 }}
                  />
                  <button type="button" className={styles.addBtnSmall} onClick={addHighlight}>
                    <Plus size={16} /> Add
                  </button>
                </div>
              )}
            </div>
          </>))}

          {/* --- What This Place Offers (Accordion) --- */}
          {renderAccordionSection("offers", "What This Place Offers", (<>
            <p className={styles.sectionHint}>
              Full amenity list grouped by category. ★ Star up to 6 items to feature them as top amenities on the property card.
              {currentAmenities.length > 0 && <span style={{ color: '#ffb400', marginLeft: '6px' }}>({currentAmenities.length}/6 starred)</span>}
              <span className={styles.badgeRow}>
                <span>Offers {scrapeBadge('offers')}</span>
                <span>Top amenities {scrapeBadge('amenities')}</span>
              </span>
            </p>
            {fieldIssue('offers')}
            {fieldIssue('amenities')}

            {/* Group offers by category for display */}
            {(() => {
              const categories = [...new Set(currentOffers.map(o => o.category))];
              return categories.map(cat => (
                <div key={cat} className={styles.offerCategoryGroup}>
                  <label className={styles.offerCategoryLabel}>{cat}</label>
                  {currentOffers.filter(o => o.category === cat).map((offer) => {
                    const realIdx = currentOffers.indexOf(offer);
                    const editing = rowEdit?.kind === "offer" && rowEdit.target === offer ? rowEdit : null;
                    const starred = currentAmenities.includes(offer.name);
                    // An item in "Not included" keeps that category unless it is being included (Kian's ruling).
                    const picksCategory = !!editing && (editing.include || offer.category !== NOT_INCLUDED);
                    return (
                      <Fragment key={`${realIdx}:${offer.name}`}>
                        <div className={`${styles.listItem} ${offer.available || editing ? '' : styles.listItemUnavailable}`} data-row-edit={editing ? '' : undefined}>
                          <input
                            type="checkbox"
                            checked={offer.available}
                            disabled={!!editing}
                            onChange={() => toggleOfferAvailable(offer)}
                            className={styles.offerCheckbox}
                            title={offer.available ? 'Offered — untick to move it to Not included' : 'Not included — tick to offer it'}
                            aria-label={offer.available ? `${offer.name}: offered` : `${offer.name}: not included`}
                          />
                          <IconPicker
                            currentIcon={offer.icon || ''}
                            amenityName={offer.name}
                            onSelect={(svg) => updateOfferIcon(offer, svg)}
                          />
                          {editing ? (
                            <>
                              <input
                                type="text"
                                className={`${styles.dataSourceInput} ${styles.rowEditInput}`}
                                value={editing.name}
                                autoFocus
                                aria-label="Item name"
                                onChange={(e) => { setRowEdit({ ...editing, name: e.target.value }); setRowEditError(null); }}
                                onKeyDown={rowEditKeys}
                              />
                              {picksCategory ? (
                                <div className={styles.rowEditCategory}>
                                  <CustomSelect
                                    options={categoryOptions}
                                    value={editing.category}
                                    onChange={(category) => { setRowEdit({ ...editing, category }); setRowEditError(null); }}
                                    placeholder="Pick a category"
                                  />
                                </div>
                              ) : (
                                <span className={styles.rowFixedCategory}>{NOT_INCLUDED}</span>
                              )}
                              <div className={styles.rowActions}>
                                <button type="button" className={styles.rowConfirmBtn} title={editing.include ? 'Include' : 'Save'} aria-label={`${editing.include ? 'Include' : 'Save'} ${offer.name}`} onClick={commitRowEdit}>
                                  <Check size={14} />
                                </button>
                                <button type="button" className={styles.rowPlainBtn} title="Cancel" aria-label="Cancel" onClick={cancelRowEdit}>
                                  <X size={14} />
                                </button>
                              </div>
                            </>
                          ) : (
                            <>
                              <span className={`${styles.rowText} ${offer.available ? '' : styles.offerNameUnavailable}`} data-offer-name>{offer.name}</span>
                              <div className={styles.rowActions}>
                                <button
                                  type="button"
                                  className={`${styles.starBtn} ${starred ? styles.starBtnActive : ''}`}
                                  onClick={() => toggleOfferStarred(offer.name)}
                                  title={starred ? 'Remove from top amenities' : !offer.available ? 'Not included — tick it to star it' : (currentAmenities.length >= 6 ? 'Max 6 starred' : 'Add to top amenities')}
                                  disabled={!starred && (!offer.available || currentAmenities.length >= 6)}
                                >
                                  <Star size={14} fill={starred ? '#ffb400' : 'none'} />
                                </button>
                                <button type="button" className={styles.rowPlainBtn} title="Edit" aria-label={`Edit ${offer.name}`} onClick={() => startOfferEdit(offer)}>
                                  <Pencil size={14} />
                                </button>
                                <button type="button" className={styles.iconBtn} title="Delete" aria-label={`Delete ${offer.name}`} onClick={() => deleteOffer(offer)}>
                                  <Trash2 size={14} />
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                        {editing && rowEditError && <span className={styles.fieldIssue} role="alert">{rowEditError}</span>}
                      </Fragment>
                    );
                  })}
                </div>
              ));
            })()}

            {/* The name takes the row; the category a fixed width beside it (dispatch 29: it took
                the row and left the name 2 px, so what was typed could not be seen). */}
            <div className={styles.addInputGroup}>
              <input
                type="text"
                value={newOfferName}
                onChange={(e) => { setNewOfferName(e.target.value); setOfferAddError(null); }}
                placeholder="e.g. Free parking on premises"
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addOfferRow(); } }}
                className={styles.dataSourceInput}
                aria-label="New item"
              />
              <div className={styles.offerAddCategory}>
                <CustomSelect
                  options={categoryOptions}
                  value={newOfferCategory}
                  onChange={(val) => setNewOfferCategory(val)}
                  placeholder="Category"
                />
              </div>
              <button
                type="button"
                className={styles.addBtnSmall}
                onClick={addOfferRow}
                disabled={!newOfferName.trim() || !newOfferCategory}
                title={newOfferCategory ? undefined : 'Pick a category'}
              >
                <Plus size={16} /> Add
              </button>
            </div>
            {offerAddError && <span className={styles.fieldIssue} role="alert">{offerAddError}</span>}
          </>))}

          {/* --- Terms & Rules (Accordion) --- */}
          {renderAccordionSection("terms", "Terms & Rules", (<>
            <div className={styles.field}>
              <label>Cancellation Policy</label>
              <input type="text" name="terms.cancellationPolicy" value={formData.terms?.cancellationPolicy || ""} onChange={handleChange} required placeholder="e.g. Firm - No Cancellation" className={issueClass('terms.cancellationPolicy')} />
              {fieldIssue('terms.cancellationPolicy')}
            </div>
            
            <div className={styles.checkboxGroup}>
              <label className={styles.checkboxItem}>
                <input type="checkbox" name="terms.smokingAllowed" checked={!!formData.terms?.smokingAllowed} onChange={handleCheckbox} />
                Smoking Allowed {scrapeBadge('smokingAllowed')}
              </label>
              <label className={styles.checkboxItem}>
                <input type="checkbox" name="terms.petsAllowed" checked={!!formData.terms?.petsAllowed} onChange={handleCheckbox} />
                Pets Allowed {scrapeBadge('petsAllowed')}
              </label>
              <label className={styles.checkboxItem}>
                <input type="checkbox" name="terms.partyAllowed" checked={!!formData.terms?.partyAllowed} onChange={handleCheckbox} />
                Parties Allowed {scrapeBadge('partyAllowed')}
              </label>
              <label className={styles.checkboxItem}>
                <input type="checkbox" name="terms.childrenAllowed" checked={!!formData.terms?.childrenAllowed} onChange={handleCheckbox} />
                Children Allowed
              </label>
            </div>

            <label className={styles.dataSourceLabel} style={{ marginTop: '12px' }}>House Rules {scrapeBadge('rules')}</label>
            {fieldIssue('terms.rules')}
            <div className={styles.listContainer}>
              {currentRules.map((rule, i) => renderListRow("rule", rule, i, () => removeRule(i)))}
              <div className={styles.addInputGroup}>
                <input 
                  type="text" 
                  value={newRule} 
                  onChange={(e) => setNewRule(e.target.value)}
                  placeholder="e.g. No noise after 10PM"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addRule();
                    }
                  }}
                  className={styles.dataSourceInput}
                  style={{ flex: 1 }}
                />
                <button type="button" className={styles.addBtnSmall} onClick={addRule}>
                  <Plus size={16} /> Add
                </button>
              </div>
            </div>
          </>))}

          {/* Reviews (read-only preview) */}
          {renderAccordionSection("reviews", `Reviews${formData.averageRating ? ` · ★ ${Number(formData.averageRating).toFixed(2)}` : ''}${formData.totalReviewCount ? ` (${formData.totalReviewCount})` : ''}`, (<>
            {fieldStatus && (
              <p className={styles.sectionHint}>
                <span className={styles.badgeRow}>
                  <span>Reviews {scrapeBadge('reviews')}</span>
                  <span>Average rating {scrapeBadge('averageRating')}</span>
                  <span>Review count {scrapeBadge('totalReviewCount')}</span>
                </span>
              </p>
            )}
            {formData.reviews && formData.reviews.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {formData.reviews.map((review: { reviewer: string; date: string; rating: number; text: string; avatar?: string }, idx: number) => (
                  <div key={idx} className={styles.reviewCard}>
                    <div className={styles.reviewHeader}>
                      {review.avatar ? (
                        <img src={review.avatar} alt={review.reviewer} className={styles.reviewAvatar} />
                      ) : (
                        <div className={styles.reviewAvatarFallback}>
                          {review.reviewer.charAt(0).toUpperCase()}
                        </div>
                      )}
                      <div className={styles.reviewMeta}>
                        <div className={styles.reviewName}>{review.reviewer}</div>
                        <div className={styles.reviewDate}>{review.date}</div>
                      </div>
                      <div className={styles.reviewStars}>
                        {Array.from({ length: review.rating }).map((_, i) => (
                          <span key={i}>★</span>
                        ))}
                      </div>
                      <button
                        type="button"
                        className={styles.reviewDeleteBtn}
                        onClick={() => {
                          const updated = [...(formData.reviews || [])];
                          updated.splice(idx, 1);
                          setFormData(prev => ({ ...prev, reviews: updated }));
                        }}
                        title="Delete review"
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          <line x1="10" y1="11" x2="10" y2="17" />
                          <line x1="14" y1="11" x2="14" y2="17" />
                        </svg>
                      </button>
                    </div>
                    <p className={styles.reviewText}>{review.text}</p>
                  </div>
                ))}
              </div>
            ) : (
              <div className={styles.emptyReviews}>
                No reviews fetched yet. Scrape an Airbnb listing to import reviews.
              </div>
            )}
          </>))}

          <NoticeBanner notice={formNotice} onDismiss={clearFormNotice} className={styles.inlineNotice} />

          {saveError && (
            <NoticeBanner
              notice={{
                tone: 'error',
                title: saveError.title,
                detail: saveError.detail,
                items: saveIssues.map(
                  (i) => `${ISSUE_LABEL[i.path] || SCRAPE_FIELD_LABEL[i.path] || i.path}: ${i.message}`,
                ),
              }}
              onDismiss={() => { setSaveError(null); setSaveIssues([]); }}
              className={styles.inlineNotice}
            />
          )}

          <div className={styles.actions}>
            <button type="button" className={styles.cancelBtn} onClick={onClose} disabled={isSaving || isMirroring}>Cancel</button>
            <button type="submit" className={styles.saveBtn} disabled={isSaving || isMirroring}>
              {isSaving ? "Saving..." : isMirroring ? "Saved — mirroring images..." : "Save Property"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Co-owners and statements (dispatch 23B) ─────────────────

interface ManagementDraft {
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

function emptyManagement(): ManagementDraft {
  return { reportForName: "", reportForAddress: "", owners: [], from: STATEMENTS_FROM_DEFAULT, until: "", feeRate: "", legacyFee: null, excluded: false };
}

/**
 * The draft as the route takes it: null when it says nothing beyond the
 * defaults (the record is then cleared), else the whole record. A problem
 * in words when it cannot be saved.
 */
function toManagementPayload(draft: ManagementDraft): { record: ManagementPayload | null } | { problem: string } {
  const owners = draft.owners.map((o) => ({ name: o.name.trim(), email: o.email.trim() || null })).filter((o) => o.name !== "" || o.email !== null);
  if (owners.some((o) => o.name === "")) return { problem: "Every owner needs a name." };
  if (!isMonth(draft.from)) return { problem: "Statements from: a month, like 2026-10." };
  if (draft.until !== "" && !isMonth(draft.until)) return { problem: "Until: a month, like 2027-03, or empty." };
  if (draft.until !== "" && draft.until < draft.from) return { problem: "Until is before the first month." };
  const reportForName = draft.reportForName.trim();
  if (reportForName === "" && draft.reportForAddress.trim() !== "") return { problem: "Report For needs a name above the address." };
  const reportFor = reportForName === "" ? null : { name: reportForName, address: draft.reportForAddress.trim() };
  const feeRate = draft.feeRate.trim();
  if (feeRate !== "" && !/^(100(\.0{1,2})?|[0-9]{1,2}(\.[0-9]{1,2})?)$/.test(feeRate)) return { problem: "The default fee rate is a percent, like 20 or 12.5." };
  if (reportFor === null && owners.length === 0 && draft.from === STATEMENTS_FROM_DEFAULT && draft.until === "" && feeRate === "" && draft.legacyFee === null && !draft.excluded) return { record: null };
  return { record: { reportFor, owners, statementsFrom: draft.from, statementsUntil: draft.until || null, defaultFeeRate: feeRate || null, ...(draft.legacyFee ? { defaultFee: draft.legacyFee } : {}), excludedFromReporting: draft.excluded } };
}
