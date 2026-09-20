"use client";

import { Property, Offer } from "@/app/types/property";
import { addProperty, updateProperty, MutationIssue } from "@/app/lib/firebase/properties";
import { useState } from "react";
import styles from "./PropertyForm.module.css";
import { Plus, Trash2, X, ImageIcon, ImagePlus, Link2, Star, ChevronDown, Check, AlertTriangle, XCircle } from "lucide-react";

import { CustomSelect } from "./CustomSelect";
import { IconPicker } from "./IconPicker";
import { NoticeBanner, Notice, useNotice } from "./Notice";
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
const OFFER_CATEGORIES = [
  "Scenic views", "Bathroom", "Bedroom and laundry", "Entertainment",
  "Heating and cooling", "Kitchen and dining", "Parking and facilities",
  "Internet and office", "Location features", "Outdoor", "Services", "Safety"
];

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
  onClose: () => void;
  onSave: () => void;
}

export function PropertyForm({ initialData, onClose, onSave }: PropertyFormProps) {
  const [formData, setFormData] = useState<Partial<Property>>(
    initialData || {
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
    }
  );

  const [isSaving, setIsSaving] = useState(false);
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const [isUploadingMultiple, setIsUploadingMultiple] = useState(false);
  const [newRule, setNewRule] = useState("");
  const [newHighlight, setNewHighlight] = useState("");
  const [newOfferName, setNewOfferName] = useState("");
  const [newOfferCategory, setNewOfferCategory] = useState("Bathroom");
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

  // Save failures. The modal stays open and every entered value is kept.
  const [saveError, setSaveError] = useState<{ title: string; detail?: string } | null>(null);
  const [saveIssues, setSaveIssues] = useState<MutationIssue[]>([]);

  // Uploads and other in-form failures — one mechanism, no alert().
  const { notice: formNotice, show: showFormNotice, clear: clearFormNotice } = useNotice();

  const toggleSection = (key: string) => {
    setOpenSections(prev => ({ ...prev, [key]: !prev[key] }));
  };

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
        if (!formData.price) count++;
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
        SCRAPE_FIELD_SECTION[field] === sectionKey && report.status !== 'extracted',
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
      <div className={styles.section} key={sectionKey}>
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
        <div className={`${styles.accordionBody} ${isOpen ? styles.accordionBodyOpen : ''}`}>
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
    return (
      <span className={`${styles.scrapeBadge} ${styles.scrapeBadgeFailed}`} title={report.reason}>
        <XCircle size={11} /> Not found
      </span>
    );
  };

  /** Fields the scraper could not read, grouped for the post-scrape report. */
  const fieldsWithStatus = (status: 'extracted' | 'defaulted' | 'failed') =>
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
      <span className={styles.fieldIssue} role="alert">
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
    try {
      const res = await fetch('/api/scrape-airbnb', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: airbnbUrl }),
      });

      if (!res.ok) {
        // The scraper now refuses to report success on an unusable page and
        // says which failure it was. Nothing is imported on these paths, so
        // leave the form exactly as the operator left it.
        const errData = await res.json().catch(() => ({}));
        setFieldStatus(null);
        setExtractionSummary(null);
        setScrapeNotice({
          tone: 'error',
          title: errData.error || `Scrape failed (HTTP ${res.status}).`,
          detail: [errData.hint, errData.code ? `Code: ${errData.code}` : null]
            .filter(Boolean)
            .join(' · ') || undefined,
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
        price: data.price || prev.price,
        priceInfo: {
          nightly: data.price || prev.priceInfo?.nightly || 0,
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
        airbnbUrl: airbnbUrl || prev.airbnbUrl || '',
      }));

      // Open every accordion holding a field that defaulted or failed, plus
      // reviews when there are any — nothing broken stays collapsed.
      setOpenSections(prev => {
        const next = { ...prev };
        for (const [field, report] of Object.entries(status)) {
          if (report.status === 'extracted') continue;
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
            `${summary.defaulted} defaulted, ${summary.failed} not found.`
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
        const errData = await res.json();
        throw new Error(errData.error || 'Failed to parse Google Maps URL');
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
      const errData = await res.json().catch(() => ({}));
      const reason = [errData.error, errData.hint].filter(Boolean).join(' ')
        || `Upload failed (HTTP ${res.status}).`;
      throw new Error(reason);
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setFormData((prev: any) => ({ ...prev, highlights: currentHighlights.filter((_, i) => i !== index) }));
  };

  const addOffer = () => {
    if (!newOfferName.trim()) return;
    const offer: Offer = { name: newOfferName.trim(), category: newOfferCategory, available: true };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setFormData((prev: any) => ({ ...prev, offers: [...currentOffers, offer] }));
    setNewOfferName("");
  };
  const removeOffer = (index: number) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setFormData((prev: any) => ({ ...prev, offers: currentOffers.filter((_, i) => i !== index) }));
  };
  const toggleOfferAvailable = (index: number) => {
    const newOffers = [...currentOffers];
    newOffers[index] = { ...newOffers[index], available: !newOffers[index].available };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setFormData((prev: any) => ({ ...prev, offers: newOffers }));
  };

  const updateOfferIcon = (index: number, svg: string) => {
    const newOffers = [...currentOffers];
    newOffers[index] = { ...newOffers[index], icon: svg };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setFormData((prev: any) => ({ ...prev, offers: newOffers }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setSaveError(null);
    setSaveIssues([]);

    const finalData = { ...formData };
    // Always persist the latest external link state
    if (airbnbUrl.trim()) finalData.airbnbUrl = airbnbUrl.trim();
    if (googleMapsUrl.trim()) finalData.googleMapsUrl = googleMapsUrl.trim();
    if (!finalData.slug && finalData.name) {
      finalData.slug = finalData.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
    }

    // `onSave()` used to run unconditionally, so the modal closed and the list
    // refetched whether or not the write landed. Close only on confirmed
    // success; on failure keep the modal, the entered data, and show why.
    const result = initialData?.id
      ? await updateProperty(initialData.id, finalData)
      : await addProperty(finalData as Omit<Property, "id">);

    setIsSaving(false);

    if (result.ok) {
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
    }
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
        
        <form onSubmit={handleSubmit} className={styles.form}>
          
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
              <div className={styles.field}>
                <label>Base Price ({formData.currency || 'CAD'}) {scrapeBadge('price')}</label>
                <input type="number" name="price" value={formData.price ?? 0} onChange={handleChange} required className={`${scrapeClass('price')} ${issueClass('price')}`} />
                {fieldIssue('price')}
              </div>
              <div className={styles.field}>
                <label>Nightly Price {scrapeBadge('price')}</label>
                <input type="number" name="priceInfo.nightly" value={formData.priceInfo?.nightly ?? 0} onChange={handleChange} required className={`${scrapeClass('price')} ${issueClass('priceInfo.nightly')}`} />
                {fieldIssue('priceInfo.nightly')}
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
              {currentHighlights.map((hl, i) => (
                <div key={i} className={styles.listItem}>
                  <span>{hl}</span>
                  <button type="button" className={styles.iconBtn} onClick={() => removeHighlight(i)}>
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
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
                    return (
                      <div key={realIdx} className={styles.listItem} style={{ opacity: offer.available ? 1 : 0.4 }}>
                        <input 
                          type="checkbox" 
                          checked={offer.available} 
                          onChange={() => toggleOfferAvailable(realIdx)}
                          className={styles.offerCheckbox}
                        />
                        <IconPicker
                          currentIcon={offer.icon || ''}
                          amenityName={offer.name}
                          onSelect={(svg) => updateOfferIcon(realIdx, svg)}
                        />
                        <span style={{ flex: 1, textDecoration: offer.available ? 'none' : 'line-through' }}>{offer.name}</span>
                        <button 
                          type="button" 
                          className={`${styles.starBtn} ${currentAmenities.includes(offer.name) ? styles.starBtnActive : ''}`}
                          onClick={() => toggleOfferStarred(offer.name)}
                          title={currentAmenities.includes(offer.name) ? 'Remove from top amenities' : (currentAmenities.length >= 6 ? 'Max 6 starred' : 'Add to top amenities')}
                          disabled={!currentAmenities.includes(offer.name) && currentAmenities.length >= 6}
                        >
                          <Star size={14} fill={currentAmenities.includes(offer.name) ? '#ffb400' : 'none'} />
                        </button>
                        <button type="button" className={styles.iconBtn} onClick={() => removeOffer(realIdx)} style={{ marginLeft: '6px' }}>
                          <Trash2 size={14} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              ));
            })()}

            <div className={styles.addInputGroup}>
              <input 
                type="text" 
                value={newOfferName} 
                onChange={(e) => setNewOfferName(e.target.value)}
                placeholder="e.g. Free parking on premises"
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addOffer(); } }}
                className={styles.dataSourceInput}
                style={{ flex: 1 }}
              />
              <CustomSelect 
                options={OFFER_CATEGORIES} 
                value={newOfferCategory} 
                onChange={(val) => setNewOfferCategory(val)} 
              />
              <button type="button" className={styles.addBtnSmall} onClick={addOffer} disabled={!newOfferName.trim()}>
                <Plus size={16} /> Add
              </button>
            </div>
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
              {currentRules.map((rule, i) => (
                <div key={i} className={styles.listItem}>
                  <span style={{flex: 1}}>{rule}</span>
                  <button type="button" className={styles.iconBtn} onClick={() => removeRule(i)}>
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
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
            <button type="button" className={styles.cancelBtn} onClick={onClose} disabled={isSaving}>Cancel</button>
            <button type="submit" className={styles.saveBtn} disabled={isSaving}>
              {isSaving ? "Saving..." : "Save Property"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
