import { useState, useEffect, useRef, useSyncExternalStore } from "react";
import DOMPurify from "dompurify";
import { Property, PropertySummary } from "@/app/types/property";
import styles from "./PropertyDetailPanel.module.css";
import { nightlyPrice } from "@/app/lib/price";
import { StoredImage } from "./StoredImage";
import { DayPicker, DateRange } from "react-day-picker";
import "react-day-picker/style.css";
import { format, differenceInDays, addDays, addYears, eachDayOfInterval, parseISO, isAfter, isBefore, startOfDay } from "date-fns";
import Link from "next/link";
import {
  X, Star, Share, Users,
  MapPin, Clock, ShieldCheck, Check, CalendarDays,
  ChevronLeft, ChevronRight, ChevronDown, RefreshCw, WifiOff, Send
} from "lucide-react";

interface PropertyDetailPanelProps {
  /** The complete document. Undefined until it has been fetched. */
  property: Property | undefined;
  /**
   * The slim record from the list, available the instant a card is clicked.
   * It carries the name, cover image, location and price, so the panel opens
   * with real content rather than a blank rectangle while the rest arrives.
   */
  summary?: PropertySummary;
  isLoading?: boolean;
  /** Set when the full document could not be fetched. Never "not found". */
  error?: string | null;
  onRetry?: () => void;
  onClose: () => void;
  /**
   * Move focus into the panel when it opens. False for a panel that is open
   * because the visitor followed a /property/<slug> link — see HomePage.
   */
  moveFocusOnOpen?: boolean;
  /** Party size from the map filter, when the visitor set one. */
  guests?: number;
}

/**
 * The widths these two surfaces ask the image loader for.
 *
 * They exist to land on a generated variant rather than near one: the loader
 * rounds a requested width up to the nearest of 200 / 750 / 1200, so the hero
 * resolves to 750 on a phone and 1200 on a desktop panel, and a 100x68
 * thumbnail resolves to 200 — the 2x size it actually needs, instead of the
 * full-width original these tiles used to paint as a background-image.
 */
const HERO_SIZES = "(max-width: 900px) 100vw, 900px";
const THUMB_SIZES = "100px";

/**
 * True only once the component is running in the browser.
 *
 * `useSyncExternalStore` with a `false` server snapshot is the hydration-safe
 * way to ask this: the server render and the first client render both see
 * `false`, so nothing mismatches, and the second client render sees `true`.
 */
function useIsHydrated(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
}

export function PropertyDetailPanel({
  property,
  summary,
  isLoading = false,
  error = null,
  onRetry,
  onClose,
  moveFocusOnOpen = false,
  guests,
}: PropertyDetailPanelProps) {
  /**
   * The amenity icons are SVG markup stored on the document, so they have to
   * be sanitised before they are injected. DOMPurify's default build needs a
   * real DOM and its `sanitize` is not callable during a server render —
   * which never came up before, because the panel only ever rendered in the
   * browser. Now that /property/<slug> renders it on the server, the icons
   * wait for hydration and the generic tick that already stands in for a
   * missing icon is shown until then. The amenity's name is server-rendered
   * either way, so nothing readable is deferred — only the decoration.
   */
  const isHydrated = useIsHydrated();

  /**
   * Focus management for the panel.
   *
   * The panel slides over the list and takes the whole screen on mobile, so a
   * keyboard visitor who opens one and keeps tabbing must land inside it, not
   * back in the list behind it. Focus goes to the close button — the way out
   * is the first thing you find. Escape closes, and HomePage puts focus back
   * on the card that opened it.
   */
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const openId = property?.id ?? summary?.id ?? null;
  useEffect(() => {
    if (!openId || !moveFocusOnOpen) return;
    closeBtnRef.current?.focus({ preventScroll: true });
  }, [openId, moveFocusOnOpen]);

  const handlePanelKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    onClose();
  };
  const safeIcon = (markup: string | undefined): string | null => {
    if (!markup || !isHydrated) return null;
    return DOMPurify.sanitize(markup, { USE_PROFILES: { svg: true, svgFilters: true } });
  };

  const [currentImageIndex, setCurrentImageIndex] = useState(0);
  const [dateRange, setDateRange] = useState<DateRange | undefined>();
  /**
   * `no-dates` and `no-calendar` replace the two alert() calls that used to
   * sit on this path. A blocking, unstyled OS dialog is a poor way to tell
   * someone they forgot to pick a date, and it cannot be read by anything
   * that is not looking at it; these render inline, in the same place every
   * other answer about these dates appears.
   */
  const [availabilityStatus, setAvailabilityStatus] = useState<
    'idle' | 'checking' | 'available' | 'booked' | 'error' | 'below-minimum' | 'no-dates' | 'no-calendar'
  >('idle');
  const [showFullDescription, setShowFullDescription] = useState(false);
  const [expandedCategories, setExpandedCategories] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState(false);

  /**
   * The host's minimum stay. Treated as 1 when unset or nonsensical, so a
   * missing value can never block a booking enquiry.
   */
  const minNights = Math.max(1, Math.round(property?.priceInfo?.minNights ?? 1) || 1);
  
  // iCal booked dates
  const [bookedDates, setBookedDates] = useState<Date[]>([]);
  const [calendarLoading, setCalendarLoading] = useState(false);
  const lastFetchedIcalUrl = useRef<string | null | undefined>(null);

  // Fetch booked dates from iCal when property changes
  useEffect(() => {
    if (!property?.icalUrl) {
      setBookedDates([]);
      lastFetchedIcalUrl.current = null;
      return;
    }

    // Skip if we already fetched for this exact icalUrl
    if (lastFetchedIcalUrl.current === property.icalUrl) return;

    const fetchBookedDates = async () => {
      setCalendarLoading(true);
      try {
        const res = await fetch('/api/fetch-booked-dates', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ icalUrl: property.icalUrl }),
        });

        if (!res.ok) throw new Error('Failed to fetch');

        const result = await res.json();
        const dates: Date[] = [];

        // Expand each booked range into individual Date objects
        for (const range of result.data.bookedRanges) {
          const start = parseISO(range.start);
          const end = parseISO(range.end);
          if (start >= end) continue;
          // eachDayOfInterval is inclusive of start, exclusive-ish — we use addDays to stop before end (checkout day is available)
          const days = eachDayOfInterval({ start, end: addDays(end, -1) });
          dates.push(...days);
        }

        setBookedDates(dates);
        lastFetchedIcalUrl.current = property.icalUrl;
      } catch (err) {
        console.error('Error fetching booked dates:', err);
        setBookedDates([]);
      } finally {
        setCalendarLoading(false);
      }
    };

    fetchBookedDates();
  }, [property?.icalUrl]);

  const oneYearFromNow = addYears(new Date(), 1);

  // ── Nothing selected ──
  if (!property && !summary) return null;

  // ── Selected, but the full document is not here yet ──
  //
  // The header below is built from the summary, which is already in the page,
  // so what is shown is what is known and the indicator sits underneath it
  // rather than on top of it. A fetch that failed says so and offers a retry:
  // a property whose details would not load is not a property that does not
  // exist, and it must never be reported as one.
  if (!property && summary) {
    return (
      <div className={styles.container} onKeyDown={handlePanelKeyDown}>
        <div className={styles.topBar}>
          <button ref={closeBtnRef} className={styles.closeBtn} onClick={onClose} aria-label="Close details">
            <X size={22} />
          </button>
        </div>

        <div className={styles.content}>
          <div className={styles.carouselContainer}>
            <StoredImage
              src={summary.coverImage}
              alt={summary.name}
              className={styles.carouselHero}
              sizes={HERO_SIZES}
              priority
            />
          </div>

          <div className={styles.body}>
            <div className={styles.mainContent}>
              <div className={styles.headerSection}>
                {summary.propertyTypeTag && (
                  <span className={styles.propertyTypeTag}>{summary.propertyTypeTag}</span>
                )}
                <h1 className={styles.title}>{summary.name}</h1>
                <div className={styles.locationRow}>
                  <MapPin size={16} className={styles.iconSubtle} />
                  <span>
                    {summary.addressDetails?.city
                      ? `${summary.addressDetails.city}${summary.addressDetails.state ? `, ${summary.addressDetails.state}` : ""}`
                      : summary.location}
                  </span>
                </div>
              </div>

              {error ? (
                <div className={styles.detailNotice} role="alert">
                  <WifiOff size={28} strokeWidth={1.5} className={styles.detailNoticeIcon} />
                  <h2 className={styles.detailNoticeTitle}>We couldn&apos;t load this property</h2>
                  <p className={styles.detailNoticeText}>{error}</p>
                  {onRetry && (
                    <button type="button" className={styles.detailNoticeRetry} onClick={onRetry}>
                      <RefreshCw size={16} />
                      Try again
                    </button>
                  )}
                </div>
              ) : (
                <div className={styles.detailNotice} role="status" aria-live="polite">
                  <div className={styles.detailNoticeSpinner} />
                  <p className={styles.detailNoticeText}>
                    {isLoading ? "Loading the full listing…" : "Preparing the full listing…"}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!property) return null;

  const allImages = [property.coverImage, ...(property.images || [])];

  const nextImage = (e: React.MouseEvent) => {
    e.stopPropagation();
    setCurrentImageIndex((prev) => (prev + 1) % allImages.length);
  };

  const prevImage = (e: React.MouseEvent) => {
    e.stopPropagation();
    setCurrentImageIndex((prev) => (prev - 1 + allImages.length) % allImages.length);
  };


  const handleCheckAvailability = async () => {
    if (!dateRange?.from || !dateRange?.to) {
      setAvailabilityStatus('no-dates');
      return;
    }

    // ── Minimum stay ──
    // Checked before the calendar is consulted. 22 of 43 properties carry a
    // minNights of 28 or more and nothing enforced it, so a guest picking two
    // nights on a one-month-minimum listing was told the dates were
    // available. A stay the host will not accept is not an available stay,
    // whatever the iCal feed says.
    const selectedNights = differenceInDays(dateRange.to, dateRange.from);
    if (minNights > 1 && selectedNights < minNights) {
      setAvailabilityStatus('below-minimum');
      return;
    }

    const startDate = format(dateRange.from, 'yyyy-MM-dd');
    const endDate = format(dateRange.to, 'yyyy-MM-dd');

    if (!property.icalUrl) {
      setAvailabilityStatus('no-calendar');
      return;
    }

    setAvailabilityStatus('checking');

    try {
      const res = await fetch('/api/check-availability', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          icalUrl: property.icalUrl,
          startDate,
          endDate
        })
      });

      const result = await res.json();

      if (res.ok && result.success) {
        setAvailabilityStatus(result.data.available ? 'available' : 'booked');
      } else {
        setAvailabilityStatus('error');
      }
    } catch (err) {
      console.error(err);
      setAvailabilityStatus('error');
    }
  };

  // Check if description is long enough to truncate
  const descriptionIsLong = (property.description || '').length > 280;

  /**
   * Where "Request these dates" goes. The contact page reads these on the
   * server and renders the form already filled in; the same values are posted
   * back as structured fields, so what is stored is not a parsed sentence.
   */
  const requestHref = (() => {
    const params = new URLSearchParams({ propertyId: property.id, property: property.name });
    if (dateRange?.from) params.set('checkIn', format(dateRange.from, 'yyyy-MM-dd'));
    if (dateRange?.to) params.set('checkOut', format(dateRange.to, 'yyyy-MM-dd'));
    if (guests && guests > 0) params.set('guests', String(guests));
    return `/contact?${params.toString()}`;
  })();

  return (
    <div className={styles.container} onKeyDown={handlePanelKeyDown}>
      {/* Top Navigation / Actions */}
      <div className={styles.topBar}>
        <button ref={closeBtnRef} className={styles.closeBtn} onClick={onClose} aria-label="Close details">
          <X size={22} />
        </button>
        <div className={styles.actions}>
          <button
            className={styles.actionBtn}
            onClick={() => {
              navigator.clipboard.writeText(window.location.href);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
            aria-label="Copy link"
          >
            {copied ? <Check size={18} /> : <Share size={18} />}
            {copied && <span className={styles.copiedTooltip}>Copied!</span>}
          </button>
        </div>
      </div>

      {/* Scrollable Content */}
      <div className={styles.content}>
        {/* Hero Image Carousel */}
        <div className={styles.carouselContainer}>
          <StoredImage
            src={allImages[currentImageIndex]}
            alt={`${property.name} — image ${currentImageIndex + 1} of ${allImages.length}`}
            className={styles.carouselHero}
            sizes={HERO_SIZES}
            priority
          />

          {allImages.length > 1 && (
            <>
              <button 
                className={`${styles.carouselNav} ${styles.carouselNavPrev}`}
                onClick={prevImage}
                aria-label="Previous image"
              >
                <ChevronLeft size={22} />
              </button>
              <button 
                className={`${styles.carouselNav} ${styles.carouselNavNext}`}
                onClick={nextImage}
                aria-label="Next image"
              >
                <ChevronRight size={22} />
              </button>

              <div className={styles.carouselIndicators}>
                {allImages.map((_, idx) => (
                  <button
                    key={idx}
                    className={`${styles.carouselDot} ${currentImageIndex === idx ? styles.carouselDotActive : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setCurrentImageIndex(idx);
                    }}
                    aria-label={`Go to image ${idx + 1}`}
                  />
                ))}
              </div>
            </>
          )}
        </div>

        {/* Thumbnail Row */}
        {allImages.length > 1 && (
          <div className={styles.thumbnailContainer}>
            <div className={styles.galleryThumbnails}>
              {allImages.map((img, idx) => (
                <div
                  key={idx}
                  className={`${styles.galleryItem} ${currentImageIndex === idx ? styles.galleryItemActive : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setCurrentImageIndex(idx);
                  }}
                  title={`View image ${idx + 1}`}
                >
                  {/* Decorative: the control is the tile, which carries the
                      accessible name via `title`. An alt here would announce
                      the same property name 39 times over. */}
                  <StoredImage src={img} alt="" className={styles.galleryImage} sizes={THUMB_SIZES} />
                </div>
              ))}
            </div>
          </div>
        )}

        <div className={styles.body}>
          <div className={styles.mainContent}>
            {/* Title & Top Metadata */}
            <div className={`${styles.headerSection} ${styles.animateIn}`} style={{ animationDelay: '0.05s' }}>
              {property.propertyTypeTag && (
                <span className={styles.propertyTypeTag}>{property.propertyTypeTag}</span>
              )}
              <h1 className={styles.title}>{property.name}</h1>
              <div className={styles.locationRow}>
                <MapPin size={16} className={styles.iconSubtle} />
                <span>{property.addressDetails?.area}, {property.addressDetails?.city}</span>
                <span className={styles.dot}>•</span>
                {property.averageRating && property.averageRating > 0 ? (
                  <>
                    <Star size={15} fill="currentColor" className={styles.iconStar} />
                    <span className={styles.ratingText}>{property.averageRating.toFixed(2)}</span>
                    {property.totalReviewCount && property.totalReviewCount > 0 ? (
                      <span className={styles.reviews}>({property.totalReviewCount} review{property.totalReviewCount !== 1 ? 's' : ''})</span>
                    ) : null}
                  </>
                ) : (
                  <span className={styles.newBadge}>New</span>
                )}
              </div>
              {/* Highlight Badges */}
              {property.highlights && property.highlights.length > 0 && (
                <div className={styles.highlightBadges}>
                  {property.highlights.map((hl, idx) => (
                    <span key={idx} className={styles.highlightBadge}>
                      <Check size={12} /> {hl}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className={styles.divider} />

            {/* Quick Stats Row — 4 columns with Beds */}
            <div className={`${styles.quickStatsRow} ${styles.animateIn}`} style={{ animationDelay: '0.12s' }}>
              <div className={styles.statItem}>
                <span className={styles.statValue}>{property.guests}</span>
                <span className={styles.statLabel}>Guests</span>
              </div>
              <div className={styles.statDivider} />
              <div className={styles.statItem}>
                <span className={styles.statValue}>{property.bedrooms}</span>
                <span className={styles.statLabel}>Bedrooms</span>
              </div>
              <div className={styles.statDivider} />
              <div className={styles.statItem}>
                <span className={styles.statValue}>{property.beds || '-'}</span>
                <span className={styles.statLabel}>Beds</span>
              </div>
              <div className={styles.statDivider} />
              <div className={styles.statItem}>
                <span className={styles.statValue}>{property.bathrooms}</span>
                <span className={styles.statLabel}>Baths</span>
              </div>
            </div>

            <div className={styles.divider} />

            {/* About */}
            <div className={`${styles.section} ${styles.animateIn}`} style={{ animationDelay: '0.18s' }}>
              <h2 className={styles.sectionTitle}>
                <span className={styles.sectionTitleAccent} />
                About this space
              </h2>
              <p className={`${styles.descriptionText} ${!showFullDescription && descriptionIsLong ? styles.descriptionTruncated : ''}`}>
                {property.description}
              </p>
              {descriptionIsLong && (
                <button className={styles.showMoreBtn} onClick={() => setShowFullDescription(!showFullDescription)}>
                  {showFullDescription ? 'Show less' : 'Show more'}
                  <ChevronDown size={14} style={{ transform: showFullDescription ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s ease' }} />
                </button>
              )}
            </div>

            {/* At a Glance — 2 col × 3 row grid with SVG icons */}
            <div className={`${styles.section} ${styles.animateIn}`} style={{ animationDelay: '0.24s' }}>
              <h2 className={styles.sectionTitle}>
                <span className={styles.sectionTitleAccent} />
                At a Glance
              </h2>
              <div className={styles.amenityGrid}>
                {property.amenities.slice(0, 6).map((amenity, idx) => {
                  // Try to find a matching offer with an SVG icon
                  const matchingOffer = property.offers?.find(o => 
                    o.name.toLowerCase() === amenity.toLowerCase() && o.icon
                  );
                  const iconMarkup = safeIcon(matchingOffer?.icon);
                  return (
                    <div key={idx} className={styles.amenityGridItem}>
                      {iconMarkup ? (
                        <span className={styles.amenityGridIcon} dangerouslySetInnerHTML={{ __html: iconMarkup }} />
                      ) : (
                        <Check size={18} className={styles.amenityGridIcon} />
                      )}
                      <span>{amenity}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Things to Know — Logistics */}
            <div className={`${styles.section} ${styles.animateIn}`} style={{ animationDelay: '0.3s' }}>
              <h2 className={styles.sectionTitle}>
                <span className={styles.sectionTitleAccent} />
                Things to Know
              </h2>
              <div className={styles.logisticsGrid}>
                <div className={styles.logisticItem}>
                  <Clock size={18} className={styles.logisticIconRow} />
                  <div className={styles.logisticLabel}>Check-in</div>
                  <div className={styles.logisticValue}>After {property.details?.checkIn || '4:00 PM'}</div>
                </div>
                <div className={styles.logisticItem}>
                  <Clock size={18} className={styles.logisticIconRow} />
                  <div className={styles.logisticLabel}>Checkout</div>
                  <div className={styles.logisticValue}>Before {property.details?.checkOut || '11:00 AM'}</div>
                </div>
                {minNights > 1 && (
                  <div className={styles.logisticItem}>
                    <CalendarDays size={18} className={styles.logisticIconRow} />
                    <div className={styles.logisticLabel}>Minimum stay</div>
                    <div className={styles.logisticValue}>{minNights} nights</div>
                  </div>
                )}
                <div className={styles.logisticItem}>
                  <ShieldCheck size={18} className={styles.logisticIconRow} />
                  <div className={styles.logisticLabel}>Cancellation</div>
                  <div className={styles.logisticValue}>{property.terms?.cancellationPolicy || 'Firm'}</div>
                </div>
              </div>
            </div>

            <div className={styles.divider} />

            {/* What This Place Offers — Open Categories with SVGs */}
            {property.offers && property.offers.length > 0 && (
              <div className={`${styles.section} ${styles.animateIn}`} style={{ animationDelay: '0.36s' }}>
                <h2 className={styles.sectionTitle}>
                  <span className={styles.sectionTitleAccent} />
                  What this place offers
                </h2>
                <div className={styles.featuresContainer}>
                  {(() => {
                    const categories = [...new Set(property.offers.map(o => o.category))];
                    return categories.map((cat, idx) => {
                      const items = property.offers.filter(o => o.category === cat);
                      const hasMore = items.length > 5;
                      const isExpanded = expandedCategories[cat] ?? false;
                      const visibleItems = hasMore && !isExpanded ? items.slice(0, 5) : items;
                      return (
                        <div key={idx} className={styles.featureCategoryGroup}>
                          <h3 className={styles.featureCategoryTitle}>{cat}</h3>
                          <ul className={styles.featureList}>
                            {visibleItems.map((offer, idxi) => {
                              const iconMarkup = safeIcon(offer.icon);
                              return (
                                <li key={idxi} className={offer.available ? styles.featureItemIncluded : styles.featureItemExcluded}>
                                  {iconMarkup ? (
                                    <span className={styles.svgIcon} dangerouslySetInnerHTML={{ __html: iconMarkup }} />
                                  ) : (
                                    offer.available ? <Check size={18} /> : <X size={18} className={styles.featureItemExcludedIcon} />
                                  )}
                                  <span className={offer.available ? '' : styles.featureItemExcludedText}>{offer.name}</span>
                                </li>
                              );
                            })}
                          </ul>
                          {hasMore && (
                            <button 
                              className={styles.readMoreBtn}
                              onClick={() => setExpandedCategories(prev => ({ ...prev, [cat]: !prev[cat] }))}
                            >
                              {isExpanded ? 'Show less' : `Read more (${items.length - 5})`}
                              <ChevronDown size={14} style={{ transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.25s ease' }} />
                            </button>
                          )}
                        </div>
                      );
                    });
                  })()}
                </div>
              </div>
            )}

            {property.offers && property.offers.length > 0 && <div className={styles.divider} />}

            {/* Guest Reviews */}
            {property.reviews && property.reviews.length > 0 && (
              <div className={`${styles.section} ${styles.animateIn}`} style={{ animationDelay: '0.39s' }}>
                <h2 className={styles.sectionTitle}>
                  <span className={styles.sectionTitleAccent} />
                  Guest Reviews
                  {property.averageRating ? (
                    <span className={styles.reviewHeaderMeta}>
                      <Star size={14} fill="currentColor" />
                      {property.averageRating.toFixed(2)}
                      {property.totalReviewCount ? ` · ${property.totalReviewCount} reviews` : ''}
                    </span>
                  ) : null}
                </h2>
                <div className={styles.reviewsGrid}>
                  {property.reviews.map((review, idx) => (
                    <div key={idx} className={styles.reviewCard}>
                      <div className={styles.reviewCardHeader}>
                        {review.avatar ? (
                          <img src={review.avatar} alt={review.reviewer} className={styles.reviewAvatar} />
                        ) : (
                          <div className={styles.reviewAvatarPlaceholder}>
                            {review.reviewer.charAt(0).toUpperCase()}
                          </div>
                        )}
                        <div className={styles.reviewMeta}>
                          <span className={styles.reviewName}>{review.reviewer}</span>
                          <span className={styles.reviewDate}>{review.date}</span>
                        </div>
                        <div className={styles.reviewStars}>
                          {Array.from({ length: review.rating }).map((_, i) => (
                            <Star key={i} size={12} fill="currentColor" />
                          ))}
                        </div>
                      </div>
                      <p className={styles.reviewText}>{review.text}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {property.reviews && property.reviews.length > 0 && <div className={styles.divider} />}

            {/* House Rules — Card Layout */}
            {property.terms && (
              <div className={`${styles.section} ${styles.animateIn}`} style={{ animationDelay: '0.42s' }}>
                <h2 className={styles.sectionTitle}>
                  <span className={styles.sectionTitleAccent} />
                  House Rules
                </h2>
                <div className={styles.rulesGrid}>
                  <div className={styles.ruleCard}>
                    {property.terms.smokingAllowed ? <Check size={18} className={styles.ruleIconAllowed} /> : <X size={18} className={styles.ruleIconDenied} />}
                    <span>{property.terms.smokingAllowed ? 'Smoking allowed' : 'No smoking'}</span>
                  </div>
                  <div className={styles.ruleCard}>
                    {property.terms.petsAllowed ? <Check size={18} className={styles.ruleIconAllowed} /> : <X size={18} className={styles.ruleIconDenied} />}
                    <span>{property.terms.petsAllowed ? 'Pets allowed' : 'No pets'}</span>
                  </div>
                  <div className={styles.ruleCard}>
                    {property.terms.partyAllowed ? <Check size={18} className={styles.ruleIconAllowed} /> : <X size={18} className={styles.ruleIconDenied} />}
                    <span>{property.terms.partyAllowed ? 'Parties allowed' : 'No parties or events'}</span>
                  </div>
                  <div className={styles.ruleCard}>
                    {property.terms.childrenAllowed ? <Check size={18} className={styles.ruleIconAllowed} /> : <X size={18} className={styles.ruleIconDenied} />}
                    <span>{property.terms.childrenAllowed ? 'Suitable for children' : 'Not suitable for children'}</span>
                  </div>
                </div>
                {property.terms.rules && property.terms.rules.length > 0 && (
                  <ul className={styles.customRulesList}>
                    {property.terms.rules.map((rule, idx) => (
                      <li key={idx}>{rule}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

          </div>
          
          {/* Sticky Booking Card Sidebar */}
          <div className={styles.sidebar}>
            <div className={`${styles.bookingCard} ${styles.animateIn}`} style={{ animationDelay: '0.15s' }}>
              <div className={styles.bookingHeader}>
                <span className={styles.currency}>$</span>
                <span className={styles.amount}>{nightlyPrice(property)}</span>
                <span className={styles.night}>/ night</span>
              </div>
              
              <div className={styles.bookingInputs}>
                <div className={`${styles.inputGroup} ${styles.full}`}>
                  <span className={styles.inputLabel}>Select Dates</span>
                  <div className={styles.dayPickerWrapper}>
                    {calendarLoading ? (
                      <div className={styles.calendarLoading}>Loading availability...</div>
                    ) : (
                      <DayPicker
                        mode="range"
                        selected={dateRange}
                        onSelect={(range) => {
                          // If a full range is selected, check for booked days in between
                          if (range?.from && range?.to && bookedDates.length > 0) {
                            const from = startOfDay(range.from);
                            const to = startOfDay(range.to);
                            const hasBookedInBetween = bookedDates.some(d => {
                              const day = startOfDay(d);
                              return (isAfter(day, from) || day.getTime() === from.getTime()) && 
                                     isBefore(day, to);
                            });
                            if (hasBookedInBetween) {
                              // Reset selection — don't allow ranges spanning booked days
                              setDateRange(undefined);
                              setAvailabilityStatus('idle');
                              return;
                            }
                          }
                          setDateRange(range);
                          setAvailabilityStatus('idle');
                        }}
                        disabled={[
                          { before: new Date() },
                          { after: oneYearFromNow },
                          ...bookedDates,
                        ]}
                        startMonth={new Date()}
                        endMonth={oneYearFromNow}
                        className={styles.calendarDayPicker}
                      />
                    )}
                  </div>
                </div>
              </div>

              {(() => {
                // Was `priceInfo?.nightly || parseInt(String(price).replace(/[^0-9]/g,''))`,
                // a remnant of `price` having once been a string. It is a
                // number on all 43 documents and the schema requires one.
                const nightlyRate = nightlyPrice(property);
                const cleaningFee = property.priceInfo?.cleaningFee || 0;

                if (dateRange?.from && dateRange?.to) {
                  const nights = Math.max(differenceInDays(dateRange.to, dateRange.from), 1);
                  const nightlyTotal = nightlyRate * nights;
                  const grandTotal = nightlyTotal + cleaningFee;

                  return (
                    <div className={styles.priceBreakdown}>
                      <div className={styles.priceRow}>
                        <span>${nightlyRate} x {nights} night{nights !== 1 ? 's' : ''}</span>
                        <span>${nightlyTotal}</span>
                      </div>
                      {cleaningFee > 0 && (
                        <div className={styles.priceRow}>
                          <span>Cleaning fee</span>
                          <span>${cleaningFee}</span>
                        </div>
                      )}
                      <div className={styles.priceDivider} />
                      <div className={`${styles.priceRow} ${styles.priceTotal}`}>
                        <span>Total</span>
                        <span>${grandTotal}</span>
                      </div>
                    </div>
                  );
                }

                return (
                  <div className={styles.priceBreakdown}>
                    <div className={styles.priceRow} style={{ justifyContent: 'center', color: '#888' }}>
                      <span>Select dates to see total price</span>
                    </div>
                  </div>
                );
              })()}

              <button 
                className={styles.reserveBtn} 
                onClick={handleCheckAvailability}
                disabled={availabilityStatus === 'checking'}
              >
                {availabilityStatus === 'checking' ? 'Checking...' : 'Check Availability'}
              </button>
              
              {availabilityStatus === 'available' && (
                <>
                  <div className={`${styles.statusMessage} ${styles.success}`} role="status">
                    Great news! These dates are available.
                  </div>
                  {/*
                    The funnel used to end here. This carries the property and
                    the dates into the contact form so the visitor does not
                    retype what they have already told us, and so the enquiry
                    arrives as structured fields rather than prose someone has
                    to parse.
                  */}
                  <Link
                    href={requestHref}
                    className={styles.requestDatesBtn}
                    prefetch={false}
                  >
                    <Send size={16} />
                    Request these dates
                  </Link>
                </>
              )}
              {availabilityStatus === 'booked' && (
                <div className={`${styles.statusMessage} ${styles.error}`}>
                  Sorry, those dates are already booked. Try another range.
                </div>
              )}
              {availabilityStatus === 'below-minimum' && (
                <div className={`${styles.statusMessage} ${styles.error}`}>
                  This property has a {minNights}-night minimum stay. Choose a longer
                  range to check availability.
                </div>
              )}
              {availabilityStatus === 'error' && (
                <div className={`${styles.statusMessage} ${styles.error}`} role="alert">
                  Could not verify availability at this time.
                </div>
              )}
              {availabilityStatus === 'no-dates' && (
                <div className={`${styles.statusMessage} ${styles.error}`} role="alert">
                  Choose a check-in and a check-out date on the calendar above.
                </div>
              )}
              {availabilityStatus === 'no-calendar' && (
                <div className={`${styles.statusMessage} ${styles.error}`} role="alert">
                  This property has no calendar connected, so we can&rsquo;t confirm these
                  dates automatically. Send us a request and we&rsquo;ll check by hand.
                </div>
              )}
              
              <div className={styles.finePrint}>
                You won&apos;t be charged to verify
              </div>
            </div>
          </div>
          
        </div>
      </div>
    </div>
  );
}
