import { useState } from "react";
import { Property } from "../data/properties";
import styles from "./PropertyDetailPanel.module.css";
import { DayPicker, DateRange } from "react-day-picker";
import "react-day-picker/style.css";
import { format, differenceInDays } from "date-fns";
import { 
  X, Star, Share, Heart, Users, 
  MapPin, Clock, ShieldCheck, Check,
  ChevronLeft, ChevronRight
} from "lucide-react";

interface PropertyDetailPanelProps {
  property: Property | undefined;
  onClose: () => void;
}

export function PropertyDetailPanel({ property, onClose }: PropertyDetailPanelProps) {
  const [currentImageIndex, setCurrentImageIndex] = useState(0);
  const [dateRange, setDateRange] = useState<DateRange | undefined>();
  const [availabilityStatus, setAvailabilityStatus] = useState<'idle' | 'checking' | 'available' | 'booked' | 'error'>('idle');

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

      const data = await res.json();

      if (res.ok) {
        setAvailabilityStatus(data.available ? 'available' : 'booked');
      } else {
        setAvailabilityStatus('error');
      }
    } catch (err) {
      console.error(err);
      setAvailabilityStatus('error');
    }
  };

  return (
    <div className={styles.container}>
      {/* Top Navigation / Actions */}
      <div className={styles.topBar}>
        <button className={styles.closeBtn} onClick={onClose} aria-label="Close details">
          <X size={24} />
        </button>
        <div className={styles.actions}>
          <button className={styles.actionBtn}>
            <Share size={20} />
          </button>
          <button className={styles.actionBtn}>
            <Heart size={20} />
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
              {/* Navigation Arrows */}
              <button 
                className={`${styles.carouselNav} ${styles.carouselNavPrev}`}
                onClick={prevImage}
                aria-label="Previous image"
              >
                <ChevronLeft size={24} />
              </button>
              <button 
                className={`${styles.carouselNav} ${styles.carouselNavNext}`}
                onClick={nextImage}
                aria-label="Next image"
              >
                <ChevronRight size={24} />
              </button>

              {/* Dot Indicators */}
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
            <div className={styles.headerSection}>
              {property.propertyTypeTag && (
                <span className={styles.propertyTypeTag}>{property.propertyTypeTag}</span>
              )}
              <h1 className={styles.title}>{property.name}</h1>
              <div className={styles.locationRow}>
                <MapPin size={18} className={styles.iconSubtle} />
                <span>{property.addressDetails.area}, {property.addressDetails.city}</span>
                <span className={styles.dot}>•</span>
                <Star size={18} fill="currentColor" className={styles.iconStar} />
                <span className={styles.ratingText}>4.98</span>
                <span className={styles.reviews}>(124 reviews)</span>
              </div>
              {/* Highlight Badges */}
              {property.highlights && property.highlights.length > 0 && (
                <div className={styles.highlightBadges}>
                  {property.highlights.map((hl, idx) => (
                    <span key={idx} className={styles.highlightBadge}>
                      <Check size={14} /> {hl}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className={styles.divider} />

            {/* Quick Stats Row */}
            <div className={styles.quickStatsRow}>
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
                <span className={styles.statValue}>{property.bathrooms}</span>
                <span className={styles.statLabel}>Bathrooms</span>
              </div>
            </div>

            <div className={styles.divider} />

            {/* About */}
            <div className={styles.section}>
              <h2 className={styles.sectionTitle}>About this space</h2>
              <p className={styles.descriptionText}>{property.description}</p>
            </div>

            {/* Top Amenities Grid */}
            <div className={styles.section}>
              <h2 className={styles.sectionTitle}>At a Glance</h2>
              <div className={styles.highlightsGrid}>
                {property.amenities.map((amenity, idx) => (
                  <div key={idx} className={styles.highlightItem}>
                    <div className={styles.highlightIconBg}>
                      <Check size={18} className={styles.highlightIcon} />
                    </div>
                    <span>{amenity}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* At a Glance Logistics */}
            <div className={styles.section}>
              <h2 className={styles.sectionTitle}>Things to Know</h2>
              <div className={styles.logisticsGrid}>
                <div className={styles.logisticItem}>
                  <Clock size={20} className={styles.iconSubtle} />
                  <div>
                    <div className={styles.logisticLabel}>Check-in</div>
                    <div className={styles.logisticValue}>After {property.details?.checkIn || '4:00 PM'}</div>
                  </div>
                </div>
                <div className={styles.logisticItem}>
                  <Clock size={20} className={styles.iconSubtle} />
                  <div>
                    <div className={styles.logisticLabel}>Checkout</div>
                    <div className={styles.logisticValue}>Before {property.details?.checkOut || '11:00 AM'}</div>
                  </div>
                </div>
                <div className={styles.logisticItem}>
                  <ShieldCheck size={20} className={styles.iconSubtle} />
                  <div>
                    <div className={styles.logisticLabel}>Cancellation</div>
                    <div className={styles.logisticValue}>{property.terms?.cancellationPolicy || 'Firm'}</div>
                  </div>
                </div>
              </div>
            </div>

            <div className={styles.divider} />

            {/* What This Place Offers */}
            {property.offers && property.offers.length > 0 && (
              <div className={styles.section}>
                <h2 className={styles.sectionTitle}>What this place offers</h2>
                <div className={styles.featuresContainer}>
                  {(() => {
                    const categories = [...new Set(property.offers.map(o => o.category))];
                    return categories.map((cat, idx) => (
                      <div key={idx} className={styles.featureCategoryGroup}>
                        <h3 className={styles.featureCategoryTitle}>{cat}</h3>
                        <ul className={styles.featureList}>
                          {property.offers.filter(o => o.category === cat).map((offer, idxi) => (
                            <li key={idxi} className={offer.available ? styles.featureItemIncluded : styles.featureItemExcluded}>
                              {offer.available ? <Check size={18} /> : <X size={18} className={styles.featureItemExcludedIcon} />}
                              <span className={offer.available ? '' : styles.featureItemExcludedText}>{offer.name}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ));
                  })()}
                </div>
              </div>
            )}

            {property.offers && property.offers.length > 0 && <div className={styles.divider} />}

            {/* Terms & Rules */}
            {property.terms && (
              <div className={styles.section}>
                <h2 className={styles.sectionTitle}>House Rules</h2>
                <div className={styles.rulesGrid}>
                  <div className={styles.ruleItem}>
                    {property.terms.smokingAllowed ? <Check size={18} className={styles.ruleIconAllowed} /> : <X size={18} className={styles.ruleIconDenied} />}
                    <span>{property.terms.smokingAllowed ? 'Smoking allowed' : 'No smoking'}</span>
                  </div>
                  <div className={styles.ruleItem}>
                    {property.terms.petsAllowed ? <Check size={18} className={styles.ruleIconAllowed} /> : <X size={18} className={styles.ruleIconDenied} />}
                    <span>{property.terms.petsAllowed ? 'Pets allowed' : 'No pets'}</span>
                  </div>
                  <div className={styles.ruleItem}>
                    {property.terms.partyAllowed ? <Check size={18} className={styles.ruleIconAllowed} /> : <X size={18} className={styles.ruleIconDenied} />}
                    <span>{property.terms.partyAllowed ? 'Parties allowed' : 'No parties or events'}</span>
                  </div>
                  <div className={styles.ruleItem}>
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
            <div className={styles.bookingCard}>
              <div className={styles.bookingHeader}>
                <span className={styles.currency}>$</span>
                <span className={styles.amount}>{property.priceInfo?.nightly || property.price}</span>
                <span className={styles.night}>/ night</span>
              </div>
              
              <div className={styles.bookingInputs}>
                <div className={`${styles.inputGroup} ${styles.full}`}>
                  <span className={styles.inputLabel}>Select Dates</span>
                  <div className={styles.dayPickerWrapper}>
                    <DayPicker
                      mode="range"
                      selected={dateRange}
                      onSelect={(range) => {
                        setDateRange(range);
                        setAvailabilityStatus('idle');
                      }}
                      disabled={{ before: new Date() }}
                      className={styles.calendarDayPicker}
                    />
                  </div>
                </div>
                <div className={`${styles.inputGroup} ${styles.full}`}>
                  <span className={styles.inputLabel}>Guests</span>
                  <div className={styles.inputBox}>
                    <Users className={styles.inputIcon} size={18} />
                    <span>1 Guest</span>
                  </div>
                </div>
              </div>

              {(() => {
                let nights = property.priceInfo?.minNights || 1;
                if (dateRange?.from && dateRange?.to) {
                  const diff = differenceInDays(dateRange.to, dateRange.from);
                  if (diff > 0) nights = diff;
                }
                // Ensure at least minNights is charged
                nights = Math.max(nights, property.priceInfo?.minNights || 1);
                
                const nightlyTotal = property.priceInfo.nightly * nights;
                const grandTotal = nightlyTotal + property.priceInfo.cleaningFee;

                return (
                  <div className={styles.priceBreakdown}>
                    <div className={styles.priceRow}>
                      <span>${property.priceInfo.nightly} x {nights} nights</span>
                      <span>${nightlyTotal}</span>
                    </div>
                    <div className={styles.priceRow}>
                      <span>Cleaning fee</span>
                      <span>${property.priceInfo.cleaningFee}</span>
                    </div>
                    <div className={styles.priceDivider} />
                    <div className={`${styles.priceRow} ${styles.priceTotal}`}>
                      <span>Total</span>
                      <span>${grandTotal}</span>
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
