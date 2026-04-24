import { useState, useEffect, useRef } from "react";
import { Property } from "../data/properties";
import styles from "./PropertyDetailPanel.module.css";
import { DayPicker, DateRange } from "react-day-picker";
import "react-day-picker/style.css";
import { format, differenceInDays, addDays, addYears, eachDayOfInterval, parseISO, isAfter, isBefore, startOfDay } from "date-fns";
import { 
  X, Star, Share, Users, 
  MapPin, Clock, ShieldCheck, Check,
  ChevronLeft, ChevronRight, ChevronDown
} from "lucide-react";

interface PropertyDetailPanelProps {
  property: Property | undefined;
  onClose: () => void;
}

export function PropertyDetailPanel({ property, onClose }: PropertyDetailPanelProps) {
  const [currentImageIndex, setCurrentImageIndex] = useState(0);
  const [dateRange, setDateRange] = useState<DateRange | undefined>();
  const [availabilityStatus, setAvailabilityStatus] = useState<'idle' | 'checking' | 'available' | 'booked' | 'error'>('idle');
  const [showFullDescription, setShowFullDescription] = useState(false);
  const [expandedCategories, setExpandedCategories] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState(false);
  
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
      alert("Please select both check-in and check-out dates on the calendar.");
      return;
    }

    const startDate = format(dateRange.from, 'yyyy-MM-dd');
    const endDate = format(dateRange.to, 'yyyy-MM-dd');

    if (!property.icalUrl) {
      alert("This property does not have a calendar connected to verify availability.");
      setAvailabilityStatus('error');
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

  return (
    <div className={styles.container}>
      {/* Top Navigation / Actions */}
      <div className={styles.topBar}>
        <button className={styles.closeBtn} onClick={onClose} aria-label="Close details">
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
          <div 
            className={styles.carouselHero} 
            style={{ backgroundImage: `url(${allImages[currentImageIndex]})` }}
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
                  style={{ backgroundImage: `url(${img})` }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setCurrentImageIndex(idx);
                  }}
                  title={`View image ${idx + 1}`}
                />
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
                <Star size={15} fill="currentColor" className={styles.iconStar} />
                <span className={styles.ratingText}>4.98</span>
                <span className={styles.reviews}>(124 reviews)</span>
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
                <span className={styles.statValue}>{property.beds || '—'}</span>
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
                  return (
                    <div key={idx} className={styles.amenityGridItem}>
                      {matchingOffer?.icon ? (
                        <span className={styles.amenityGridIcon} dangerouslySetInnerHTML={{ __html: matchingOffer.icon }} />
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
                            {visibleItems.map((offer, idxi) => (
                              <li key={idxi} className={offer.available ? styles.featureItemIncluded : styles.featureItemExcluded}>
                                {offer.icon ? (
                                  <span className={styles.svgIcon} dangerouslySetInnerHTML={{ __html: offer.icon }} />
                                ) : (
                                  offer.available ? <Check size={18} /> : <X size={18} className={styles.featureItemExcludedIcon} />
                                )}
                                <span className={offer.available ? '' : styles.featureItemExcludedText}>{offer.name}</span>
                              </li>
                            ))}
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
                <span className={styles.amount}>{property.priceInfo?.nightly || property.price}</span>
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
                const nightlyRate = property.priceInfo?.nightly || parseInt(String(property.price || '0').replace(/[^0-9]/g, '')) || 0;
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
                <div className={`${styles.statusMessage} ${styles.success}`}>
                  Great news! These dates are available.
                </div>
              )}
              {availabilityStatus === 'booked' && (
                <div className={`${styles.statusMessage} ${styles.error}`}>
                  Sorry, those dates are already booked. Try another range.
                </div>
              )}
              {availabilityStatus === 'error' && (
                <div className={`${styles.statusMessage} ${styles.error}`}>
                  Could not verify availability at this time.
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
