"use client";

import { Property, Offer } from "@/app/data/properties";
import { addProperty, updateProperty } from "@/app/lib/firebase/properties";
import { storage } from "@/app/lib/firebase/config";
import { ref, uploadBytesResumable, getDownloadURL } from "firebase/storage";
import { useState } from "react";
import styles from "./PropertyForm.module.css";
import { Plus, Trash2, X, ImageIcon, ImagePlus, Loader2, Link2 } from "lucide-react";

import { CustomSelect } from "./CustomSelect";

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

const PROPERTY_TYPES = ["House", "Apartment", "Villa", "Penthouse", "Estate", "Residence", "Ranch", "Condo"];
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
      bathrooms: 0,
      guests: 0,
      coverImage: "",
      images: [],
      type: "House",
      propertyTypeTag: "Entire home",
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
    }
  );

  const [isSaving, setIsSaving] = useState(false);
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const [isUploadingMultiple, setIsUploadingMultiple] = useState(false);
  const [newRule, setNewRule] = useState("");
  const [newAmenity, setNewAmenity] = useState("");
  const [newHighlight, setNewHighlight] = useState("");
  const [newOfferName, setNewOfferName] = useState("");
  const [newOfferCategory, setNewOfferCategory] = useState("Bathroom");
  const [airbnbUrl, setAirbnbUrl] = useState("");
  const [isScraping, setIsScraping] = useState(false);
  const [scrapeMessage, setScrapeMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

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
      const data = await res.json();

      // Map scraped data into form fields
      setFormData(prev => ({
        ...prev,
        name: data.name || prev.name,
        description: data.description || prev.description,
        guests: data.guests || prev.guests,
        bedrooms: data.bedrooms || prev.bedrooms,
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
      }));

      setScrapeMessage({ type: 'success', text: `Imported data for "${data.name}". Review & edit below, then save.` });
    } catch (err) {
      setScrapeMessage({ type: 'error', text: err instanceof Error ? err.message : 'Scraping failed. Try again.' });
    } finally {
      setIsScraping(false);
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

  const addAmenity = () => {
    if (!newAmenity.trim()) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setFormData((prev: any) => ({ ...prev, amenities: [...currentAmenities, newAmenity.trim()] }));
    setNewAmenity("");
  };
  const removeAmenity = (index: number) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setFormData((prev: any) => ({ ...prev, amenities: currentAmenities.filter((_, i) => i !== index) }));
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    
    const finalData = { ...formData };
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
          
          {/* --- Airbnb Import --- */}
          <div className={styles.section}>
            <h3>Import from Airbnb</h3>
            <p style={{ fontSize: '13px', color: '#999', marginBottom: '12px', marginTop: '-4px' }}>
              Paste an Airbnb listing URL to auto-fill the form below.
            </p>
            <div className={styles.addInputGroup}>
              <div style={{ position: 'relative', flex: 1 }}>
                <Link2 size={16} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: '#666' }} />
                <input
                  type="url"
                  value={airbnbUrl}
                  onChange={(e) => setAirbnbUrl(e.target.value)}
                  placeholder="https://www.airbnb.ca/rooms/..."
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleScrapeAirbnb(); } }}
                  disabled={isScraping}
                  style={{ flex: 1, width: '100%', padding: '12px 12px 12px 36px', background: '#1a1a1a', border: '1px solid #333', color: '#fff', borderRadius: '8px', fontSize: '14px' }}
                />
              </div>
              <button
                type="button"
                className={styles.addBtnSmall}
                onClick={handleScrapeAirbnb}
                disabled={isScraping || !airbnbUrl.trim()}
                style={{ whiteSpace: 'nowrap', padding: '10px 20px', opacity: isScraping ? 0.6 : 1 }}
              >
                {isScraping ? <Loader2 size={16} className="animate-spin" /> : <Link2 size={16} />}
                {isScraping ? 'Scraping...' : 'Import'}
              </button>
            </div>
            {scrapeMessage && (
              <div style={{
                marginTop: '10px',
                padding: '10px 14px',
                borderRadius: '8px',
                fontSize: '13px',
                background: scrapeMessage.type === 'success' ? 'rgba(76, 175, 80, 0.12)' : 'rgba(244, 67, 54, 0.12)',
                color: scrapeMessage.type === 'success' ? '#66bb6a' : '#ef5350',
                border: `1px solid ${scrapeMessage.type === 'success' ? 'rgba(76, 175, 80, 0.25)' : 'rgba(244, 67, 54, 0.25)'}`,
              }}>
                {scrapeMessage.text}
              </div>
            )}
          </div>

          {/* --- Basic Info --- */}
          <div className={styles.section}>
            <h3>Basic Info</h3>
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
                      <Loader2 size={32} className={`animate-spin ${styles.uploadIcon}`} />
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
                      <Loader2 size={24} className="animate-spin text-gray-400" />
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
                <input type="text" name="name" value={formData.name || ""} onChange={handleChange} required placeholder="e.g. Modern Villa" />
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
                  value={formData.type || "House"} 
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  onChange={(val) => handleChange({ target: { name: 'type', value: val } } as any)} 
                />
              </div>
              <div className={styles.field}>
                <label>Property Tag</label>
                <CustomSelect 
                  options={PROPERTY_TYPE_TAGS} 
                  value={formData.propertyTypeTag || "Entire home"} 
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  onChange={(val) => handleChange({ target: { name: 'propertyTypeTag', value: val } } as any)} 
                />
              </div>
            </div>
            <div className={styles.field}>
              <label>Description</label>
              <textarea name="description" value={formData.description || ""} onChange={handleChange} rows={5} required placeholder="Describe the property..." />
            </div>
          </div>

          {/* --- Highlights (Top Badges) --- */}
          <div className={styles.section}>
            <h3>Highlights (Max 3)</h3>
            <p style={{ fontSize: '13px', color: '#999', marginBottom: '12px', marginTop: '-4px' }}>
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
                    style={{ flex: 1, padding: '10px 12px', background: '#1a1a1a', border: '1px solid #333', color: '#fff', borderRadius: '8px' }}
                  />
                  <button type="button" className={styles.addBtnSmall} onClick={addHighlight}>
                    <Plus size={16} /> Add
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* --- Address Details & Settings --- */}
          <div className={styles.section}>
            <h3>Location & Settings</h3>
            <div className={styles.grid}>
              <div className={styles.field} style={{ gridColumn: '1 / -1' }}>
                <label>iCal URL (For Availability Checking)</label>
                <input 
                  type="url" 
                  name="icalUrl" 
                  value={formData.icalUrl || ""} 
                  onChange={handleChange} 
                  placeholder="https://example.com/calendar.ics" 
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
                <input type="text" name="details.checkIn" value={formData.details?.checkIn || ""} onChange={handleChange} required placeholder="e.g. 4:00 PM" />
              </div>
              <div className={styles.field}>
                <label>Check Out Time</label>
                <input type="text" name="details.checkOut" value={formData.details?.checkOut || ""} onChange={handleChange} required placeholder="e.g. 11:00 AM" />
              </div>
            </div>
          </div>

          {/* --- Capacity & Pricing --- */}
          <div className={styles.section}>
            <h3>Capacity & Pricing</h3>
            <div className={styles.grid}>
              <div className={styles.field}>
                <label>Bedrooms</label>
                <input type="number" name="bedrooms" value={formData.bedrooms} onChange={handleChange} required />
              </div>
              <div className={styles.field}>
                <label>Bathrooms</label>
                <input type="number" step="0.5" name="bathrooms" value={formData.bathrooms} onChange={handleChange} required />
              </div>
              <div className={styles.field}>
                <label>Max Guests</label>
                <input type="number" name="guests" value={formData.guests} onChange={handleChange} required />
              </div>
              <div className={styles.field}>
                <label>Base Price ({formData.currency || 'CAD'})</label>
                <input type="number" name="price" value={formData.price} onChange={handleChange} required />
              </div>
              <div className={styles.field}>
                <label>Nightly Price</label>
                <input type="number" name="priceInfo.nightly" value={formData.priceInfo?.nightly} onChange={handleChange} required />
              </div>
              <div className={styles.field}>
                <label>Weekly Price</label>
                <input type="number" name="priceInfo.weekly" value={formData.priceInfo?.weekly} onChange={handleChange} required />
              </div>
              <div className={styles.field}>
                <label>Monthly Price</label>
                <input type="number" name="priceInfo.monthly" value={formData.priceInfo?.monthly} onChange={handleChange} required />
              </div>
              <div className={styles.field}>
                <label>Weekend Price</label>
                <input type="number" name="priceInfo.weekend" value={formData.priceInfo?.weekend} onChange={handleChange} required />
              </div>
              <div className={styles.field}>
                <label>Cleaning Fee</label>
                <input type="number" name="priceInfo.cleaningFee" value={formData.priceInfo?.cleaningFee} onChange={handleChange} required />
              </div>
              <div className={styles.field}>
                <label>Min. Nights</label>
                <input type="number" name="priceInfo.minNights" value={formData.priceInfo?.minNights} onChange={handleChange} required />
              </div>
            </div>
          </div>

          {/* --- Top Amenities (Card Badges) --- */}
          <div className={styles.section}>
            <h3>Top Amenities (Card Badges)</h3>
            <p style={{ fontSize: '13px', color: '#999', marginBottom: '12px', marginTop: '-4px' }}>
              3-4 short labels shown on the property card — e.g. &quot;Wifi&quot;, &quot;Free Parking&quot;, &quot;Pool&quot;
            </p>
            <div className={styles.listContainer}>
              {currentAmenities.map((amenity, i) => (
                <div key={i} className={styles.listItem}>
                  <span>{amenity}</span>
                  <button type="button" className={styles.iconBtn} onClick={() => removeAmenity(i)}>
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
              <div className={styles.addInputGroup}>
                <input 
                  type="text" 
                  value={newAmenity} 
                  onChange={(e) => setNewAmenity(e.target.value)}
                  placeholder="e.g. Infinity Pool"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addAmenity();
                    }
                  }}
                  style={{ flex: 1, padding: '10px 12px', background: '#1a1a1a', border: '1px solid #333', color: '#fff', borderRadius: '8px' }}
                />
                <button type="button" className={styles.addBtnSmall} onClick={addAmenity}>
                  <Plus size={16} /> Add
                </button>
              </div>
            </div>
          </div>

          {/* --- What This Place Offers (Full Offers) --- */}
          <div className={styles.section}>
            <h3>What This Place Offers</h3>
            <p style={{ fontSize: '13px', color: '#999', marginBottom: '12px', marginTop: '-4px' }}>
              Full amenity list grouped by category. Toggle &quot;available&quot; to mark items as unavailable.
            </p>

            {/* Group offers by category for display */}
            {(() => {
              const categories = [...new Set(currentOffers.map(o => o.category))];
              return categories.map(cat => (
                <div key={cat} style={{ marginBottom: '16px' }}>
                  <label style={{ fontSize: '13px', fontWeight: 600, color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '6px' }}>{cat}</label>
                  {currentOffers.filter(o => o.category === cat).map((offer) => {
                    const realIdx = currentOffers.indexOf(offer);
                    return (
                      <div key={realIdx} className={styles.listItem} style={{ opacity: offer.available ? 1 : 0.4 }}>
                        <span style={{ flex: 1, textDecoration: offer.available ? 'none' : 'line-through' }}>{offer.name}</span>
                        <button type="button" className={styles.iconBtn} onClick={() => toggleOfferAvailable(realIdx)} title={offer.available ? 'Mark unavailable' : 'Mark available'} style={{ color: offer.available ? '#66bb6a' : '#999', marginRight: '4px', fontSize: '12px' }}>
                          {offer.available ? '✓' : '✗'}
                        </button>
                        <button type="button" className={styles.iconBtn} onClick={() => removeOffer(realIdx)}>
                          <X size={14} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              ));
            })()}

            <div className={styles.addInputGroup} style={{ gap: '8px' }}>
              <input 
                type="text" 
                value={newOfferName} 
                onChange={(e) => setNewOfferName(e.target.value)}
                placeholder="e.g. Free parking on premises"
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addOffer(); } }}
                style={{ flex: 1, padding: '10px 12px', background: '#1a1a1a', border: '1px solid #333', color: '#fff', borderRadius: '8px' }}
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
          </div>

          {/* --- Terms & Rules --- */}
          <div className={styles.section}>
            <h3>Terms & Rules</h3>
            <div className={styles.field} style={{ marginBottom: '16px' }}>
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

            <label style={{ marginTop: '16px', fontSize: '14px', fontWeight: '500', color: '#e0e0e0' }}>House Rules</label>
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
                  style={{ flex: 1, padding: '10px 12px', background: '#1a1a1a', border: '1px solid #333', color: '#fff', borderRadius: '8px' }}
                />
                <button type="button" className={styles.addBtnSmall} onClick={addRule}>
                  <Plus size={16} /> Add
                </button>
              </div>
            </div>
          </div>

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
