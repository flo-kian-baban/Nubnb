"use client";

import { Property, Offer } from "@/app/types/property";
import { addProperty, updateProperty } from "@/app/lib/firebase/properties";
import { storage } from "@/app/lib/firebase/config";
import { ref, uploadBytesResumable, getDownloadURL } from "firebase/storage";
import { useState } from "react";
import styles from "./PropertyForm.module.css";
import { Plus, Trash2, X, ImageIcon, ImagePlus, Link2, Star, ChevronDown } from "lucide-react";

import { CustomSelect } from "./CustomSelect";
import { IconPicker } from "./IconPicker";

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

const PROPERTY_TYPES = ["House", "Apartment", "Villa", "Penthouse", "Estate", "Residence", "Ranch", "Condo", "Basement"];
const PROPERTY_TYPE_TAGS = ["Entire home", "Entire condo", "Entire guest suite", "Private room", "Shared room"];
const OFFER_CATEGORIES = [
  "Scenic views", "Bathroom", "Bedroom and laundry", "Entertainment",
  "Heating and cooling", "Kitchen and dining", "Parking and facilities",
  "Internet and office", "Location features", "Outdoor", "Services", "Safety"
];

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
  const [scrapeMessage, setScrapeMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [scrapeAttempted, setScrapeAttempted] = useState(false);
  const [scrapedFields, setScrapedFields] = useState<Set<string>>(new Set());
  const [googleMapsUrl, setGoogleMapsUrl] = useState(initialData?.googleMapsUrl || "");
  const [isParsingMaps, setIsParsingMaps] = useState(false);
  const [mapsMessage, setMapsMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});

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

  const renderAccordionSection = (sectionKey: string, title: string, children: React.ReactNode) => {
    const isOpen = !!openSections[sectionKey];
    const unfilled = getUnfilledCount(sectionKey);
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
          </div>
          <ChevronDown size={20} className={isOpen ? styles.accordionChevronOpen : styles.accordionChevron} />
        </div>
        <div className={`${styles.accordionBody} ${isOpen ? styles.accordionBodyOpen : ''}`}>
          {children}
        </div>
      </div>
    );
  };

  // Returns the CSS class for a field's scrape status
  const scrapeClass = (fieldKey: string) => {
    if (!scrapeAttempted) return '';
    return scrapedFields.has(fieldKey) ? styles.scrapeSuccess : styles.scrapeFailed;
  };

  const handleScrapeAirbnb = async () => {
    if (!airbnbUrl.trim() || !airbnbUrl.includes('airbnb')) {
      setScrapeMessage({ type: 'error', text: 'Please enter a valid Airbnb URL.' });
      return;
    }
    setIsScraping(true);
    setScrapeMessage(null);
    try {
      const res = await fetch('/api/scrape-airbnb', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: airbnbUrl }),
      });
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Scraping failed');
      }
      const result = await res.json();
      const data = result.data;

      // Track which fields were successfully scraped
      const filled = new Set<string>();
      if (data.name) filled.add('name');
      if (data.description) filled.add('description');
      if (data.guests) filled.add('guests');
      if (data.bedrooms) filled.add('bedrooms');
      if (data.beds) filled.add('beds');
      if (data.bathrooms) filled.add('bathrooms');
      if (data.price) { filled.add('price'); filled.add('priceInfo.nightly'); }
      if (data.propertyTypeTag) filled.add('propertyTypeTag');
      if (data.checkIn) filled.add('details.checkIn');
      if (data.checkOut) filled.add('details.checkOut');
      if (data.highlights?.length) filled.add('highlights');
      setScrapedFields(filled);
      setScrapeAttempted(true);

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

      // Auto-open reviews accordion if reviews were scraped
      if (data.reviews?.length) {
        setOpenSections(prev => ({ ...prev, reviews: true }));
      }

      setScrapeMessage({ type: 'success', text: `Imported data for "${data.name}". Review & edit below, then save.` });
    } catch (err) {
      setScrapeMessage({ type: 'error', text: err instanceof Error ? err.message : 'Scraping failed. Try again.' });
    } finally {
      setIsScraping(false);
    }
  };

  const handleParseGoogleMaps = async () => {
    if (!googleMapsUrl.trim()) {
      setMapsMessage({ type: 'error', text: 'Please enter a Google Maps URL.' });
      return;
    }
    if (!googleMapsUrl.includes('google') && !googleMapsUrl.includes('goo.gl') && !googleMapsUrl.includes('maps.app')) {
      setMapsMessage({ type: 'error', text: 'Please enter a valid Google Maps link.' });
      return;
    }
    setIsParsingMaps(true);
    setMapsMessage(null);
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

      const parts = [
        data.addressDetails?.city,
        data.addressDetails?.state,
        data.addressDetails?.area,
        data.addressDetails?.country,
      ].filter(Boolean);
      setMapsMessage({
        type: 'success',
        text: `Location set: ${parts.join(', ')} (${data.lat?.toFixed(4)}, ${data.lng?.toFixed(4)})`,
      });
    } catch (err) {
      setMapsMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to parse URL.' });
    } finally {
      setIsParsingMaps(false);
    }
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!storage) { alert('Firebase Storage is not configured.'); return; }

    setIsUploadingImage(true);
    const storageRef = ref(storage!, `properties/${Date.now()}_${file.name.replace(/[^a-zA-Z0-9.]/g, '_')}`);
    const uploadTask = uploadBytesResumable(storageRef, file);

    uploadTask.on('state_changed', 
      null, 
      (error) => {
        console.error("Single image upload failed:", error);
        setIsUploadingImage(false);
        e.target.value = '';
      }, 
      () => {
        getDownloadURL(uploadTask.snapshot.ref).then((downloadURL) => {
          setFormData(prev => ({ ...prev, coverImage: downloadURL }));
          setIsUploadingImage(false);
          e.target.value = '';
        });
      }
    );
  };

  const handleMultipleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    if (!storage) { alert('Firebase Storage is not configured.'); return; }

    setIsUploadingMultiple(true);

    try {
      const uploadPromises = Array.from(files).map((file, index) => {
        const storageRef = ref(storage!, `properties/${Date.now()}_${index}_${file.name.replace(/[^a-zA-Z0-9.]/g, '_')}`);
        const uploadTask = uploadBytesResumable(storageRef, file);
        
        return new Promise<string>((resolve, reject) => {
          uploadTask.on('state_changed', 
            null, 
            reject, 
            () => {
              getDownloadURL(uploadTask.snapshot.ref).then(resolve).catch(reject);
            }
          );
        });
      });

      const uploadedUrls = await Promise.all(uploadPromises);
      
      setFormData(prev => ({ 
        ...prev, 
        images: [...(prev.images || []), ...uploadedUrls] 
      }));
    } catch (error) {
      console.error("Failed to upload some images:", error);
      alert("Failed to upload one or more images. Please check your connection and try again.");
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
    
    const finalData = { ...formData };
    // Always persist the latest external link state
    if (airbnbUrl.trim()) finalData.airbnbUrl = airbnbUrl.trim();
    if (googleMapsUrl.trim()) finalData.googleMapsUrl = googleMapsUrl.trim();
    if (!finalData.slug && finalData.name) {
      finalData.slug = finalData.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
    }

    try {
      if (initialData?.id) {
        await updateProperty(initialData.id, finalData);
      } else {
        await addProperty(finalData as Omit<Property, "id">);
      }
      onSave();
    } catch (error) {
      console.error("Failed to save property", error);
    } finally {
      setIsSaving(false);
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
              {scrapeMessage && (
                <div className={`${styles.statusMessage} ${scrapeMessage.type === 'success' ? styles.statusSuccess : styles.statusError}`}>
                  {scrapeMessage.text}
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
              {mapsMessage && (
                <div className={`${styles.statusMessage} ${mapsMessage.type === 'success' ? styles.statusSuccess : styles.statusError}`}>
                  {mapsMessage.text}
                </div>
              )}
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
                className={styles.dataSourceInput}
              />
            </div>
          </div>

          {/* --- Basic Info (Accordion) --- */}
          {renderAccordionSection("basic", "Basic Info", (<>
            <div className={styles.grid}>
              <div className={styles.field} style={{ gridColumn: '1 / -1' }}>
                <label>Cover Banner Image *</label>
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
                      accept="image/*" 
                      onChange={handleImageUpload} 
                      disabled={isUploadingImage} 
                      className={styles.fileInputHidden}
                    />
                  </label>
                </div>
              </div>

              <div className={styles.field} style={{ gridColumn: '1 / -1' }}>
                <label>Additional Property Images</label>
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
                      accept="image/*" 
                      multiple
                      onChange={handleMultipleImageUpload} 
                      disabled={isUploadingMultiple} 
                      className={styles.fileInputHidden}
                    />
                  </label>
                </div>
              </div>

              <div className={styles.field}>
                <label>Title</label>
                <input type="text" name="name" value={formData.name || ""} onChange={handleChange} required placeholder="e.g. Modern Villa" className={scrapeClass('name')} />
              </div>
              <div className={styles.field}>
                <label>Display Location *</label>
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
                <CustomSelect 
                  options={PROPERTY_TYPES} 
                  value={formData.type || ""} 
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  onChange={(val) => handleChange({ target: { name: 'type', value: val } } as any)} 
                  placeholder="Select property type"
                />
              </div>
              <div className={styles.field}>
                <label>Property Tag</label>
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
              <label>Description</label>
              <textarea name="description" value={formData.description || ""} onChange={handleChange} rows={10} required placeholder="Describe the property..." className={scrapeClass('description')} />
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
                <input type="text" name="addressDetails.city" value={formData.addressDetails?.city || ""} onChange={handleChange} required />
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
                <input type="text" name="addressDetails.area" value={formData.addressDetails?.area || ""} onChange={handleChange} required />
              </div>
              <div className={styles.field}>
                <label>Country</label>
                <input type="text" name="addressDetails.country" value={formData.addressDetails?.country || ""} onChange={handleChange} required />
              </div>
              <div className={styles.field}>
                <label>Check In Time</label>
                <input type="text" name="details.checkIn" value={formData.details?.checkIn || ""} onChange={handleChange} required placeholder="e.g. 4:00 PM" className={scrapeClass('details.checkIn')} />
              </div>
              <div className={styles.field}>
                <label>Check Out Time</label>
                <input type="text" name="details.checkOut" value={formData.details?.checkOut || ""} onChange={handleChange} required placeholder="e.g. 11:00 AM" className={scrapeClass('details.checkOut')} />
              </div>
            </div>
          </>))}

          {/* --- Capacity & Pricing (Accordion) --- */}
          {renderAccordionSection("capacity", "Capacity & Pricing", (<>
            <div className={styles.grid}>
              <div className={styles.field}>
                <label>Bedrooms</label>
                <input type="number" name="bedrooms" value={formData.bedrooms ?? 0} onChange={handleChange} required className={scrapeClass('bedrooms')} />
              </div>
              <div className={styles.field}>
                <label>Beds</label>
                <input type="number" name="beds" value={formData.beds ?? 0} onChange={handleChange} required className={scrapeClass('beds')} />
              </div>
              <div className={styles.field}>
                <label>Bathrooms</label>
                <input type="number" step="0.5" name="bathrooms" value={formData.bathrooms ?? 0} onChange={handleChange} required className={scrapeClass('bathrooms')} />
              </div>
              <div className={styles.field}>
                <label>Max Guests</label>
                <input type="number" name="guests" value={formData.guests ?? 0} onChange={handleChange} required className={scrapeClass('guests')} />
              </div>
            </div>
            <hr className={styles.sectionDivider} />
            <div className={styles.grid}>
              <div className={styles.field}>
                <label>Base Price ({formData.currency || 'CAD'})</label>
                <input type="number" name="price" value={formData.price ?? 0} onChange={handleChange} required className={scrapeClass('price')} />
              </div>
              <div className={styles.field}>
                <label>Nightly Price</label>
                <input type="number" name="priceInfo.nightly" value={formData.priceInfo?.nightly ?? 0} onChange={handleChange} required className={scrapeClass('priceInfo.nightly')} />
              </div>
              <div className={styles.field}>
                <label>Weekly Price</label>
                <input type="number" name="priceInfo.weekly" value={formData.priceInfo?.weekly ?? 0} onChange={handleChange} required />
              </div>
              <div className={styles.field}>
                <label>Monthly Price</label>
                <input type="number" name="priceInfo.monthly" value={formData.priceInfo?.monthly ?? 0} onChange={handleChange} required />
              </div>
              <div className={styles.field}>
                <label>Weekend Price</label>
                <input type="number" name="priceInfo.weekend" value={formData.priceInfo?.weekend ?? 0} onChange={handleChange} required />
              </div>
              <div className={styles.field}>
                <label>Cleaning Fee</label>
                <input type="number" name="priceInfo.cleaningFee" value={formData.priceInfo?.cleaningFee ?? 0} onChange={handleChange} required />
              </div>
              <div className={styles.field}>
                <label>Min. Nights</label>
                <input type="number" name="priceInfo.minNights" value={formData.priceInfo?.minNights ?? 0} onChange={handleChange} required />
              </div>
            </div>
          </>))}

          {/* --- 3 Main Highlights (Accordion) --- */}
          {renderAccordionSection("highlights", "3 Main Highlights", (<>
            <p className={styles.sectionHint}>
              Top standout features shown as badges — e.g. &quot;City View&quot;, &quot;Park for Free&quot;, &quot;Self check-in&quot;
            </p>
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
            </p>

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
              <input type="text" name="terms.cancellationPolicy" value={formData.terms?.cancellationPolicy || ""} onChange={handleChange} required placeholder="e.g. Firm - No Cancellation" />
            </div>
            
            <div className={styles.checkboxGroup}>
              <label className={styles.checkboxItem}>
                <input type="checkbox" name="terms.smokingAllowed" checked={!!formData.terms?.smokingAllowed} onChange={handleCheckbox} />
                Smoking Allowed
              </label>
              <label className={styles.checkboxItem}>
                <input type="checkbox" name="terms.petsAllowed" checked={!!formData.terms?.petsAllowed} onChange={handleCheckbox} />
                Pets Allowed
              </label>
              <label className={styles.checkboxItem}>
                <input type="checkbox" name="terms.partyAllowed" checked={!!formData.terms?.partyAllowed} onChange={handleCheckbox} />
                Parties Allowed
              </label>
              <label className={styles.checkboxItem}>
                <input type="checkbox" name="terms.childrenAllowed" checked={!!formData.terms?.childrenAllowed} onChange={handleCheckbox} />
                Children Allowed
              </label>
            </div>

            <label className={styles.dataSourceLabel} style={{ marginTop: '12px' }}>House Rules</label>
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
