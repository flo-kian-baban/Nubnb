/**
 * DEV / SEED-ONLY — Mock property data for database seeding.
 *
 * Types are re-exported from @/app/types/property so all components
 * can migrate to the canonical import path. This file should only ever
 * be dynamically imported (e.g. in the admin seed function), never
 * statically imported by production components.
 */
export type { Offer, Review, Property } from "@/app/types/property";
import type { Offer, Property } from "@/app/types/property";

// --- Reusable mock data ---

const mockOffers: Offer[] = [
  // Scenic views
  { name: "City skyline view", category: "Scenic views", available: true },
  // Bathroom
  { name: "Bathtub", category: "Bathroom", available: true },
  { name: "Hair dryer", category: "Bathroom", available: true },
  { name: "Shampoo", category: "Bathroom", available: true },
  { name: "Hot water", category: "Bathroom", available: true },
  // Bedroom and laundry
  { name: "Free washer/dryer – In unit", category: "Bedroom and laundry", available: true },
  { name: "Essentials", category: "Bedroom and laundry", available: true },
  { name: "Hangers", category: "Bedroom and laundry", available: true },
  { name: "Bed linens", category: "Bedroom and laundry", available: true },
  { name: "Iron", category: "Bedroom and laundry", available: true },
  // Entertainment
  { name: "HDTV with streaming", category: "Entertainment", available: true },
  // Heating and cooling
  { name: "Central air conditioning", category: "Heating and cooling", available: true },
  { name: "Heating", category: "Heating and cooling", available: true },
  // Kitchen and dining
  { name: "Kitchen", category: "Kitchen and dining", available: true },
  { name: "Refrigerator", category: "Kitchen and dining", available: true },
  { name: "Microwave", category: "Kitchen and dining", available: true },
  { name: "Stove", category: "Kitchen and dining", available: true },
  { name: "Oven", category: "Kitchen and dining", available: true },
  { name: "Coffee maker", category: "Kitchen and dining", available: true },
  { name: "Dishwasher", category: "Kitchen and dining", available: true },
  // Parking and facilities
  { name: "Free parking on premises", category: "Parking and facilities", available: true },
  { name: "Elevator", category: "Parking and facilities", available: true },
  // Internet and office
  { name: "Wifi", category: "Internet and office", available: true },
  { name: "Dedicated workspace", category: "Internet and office", available: true },
  // Services
  { name: "Self check-in", category: "Services", available: true },
  { name: "Long-term stays allowed", category: "Services", available: true },
  // Not available
  { name: "Pool", category: "Parking and facilities", available: false },
  { name: "Gym", category: "Parking and facilities", available: false },
];

const mockTerms = {
  smokingAllowed: false,
  petsAllowed: false,
  partyAllowed: false,
  childrenAllowed: true,
  cancellationPolicy: "Firm - No Cancellation",
  rules: [
    "Self-check in process. By checking in you agree to abide by the house rules.",
    "No unauthorized parties or gatherings of any kind. Strict zero tolerance for noise complaints ($500 fine).",
    "No smoking of any kind in the home ($300 odor removal fee).",
    "Please do not put excessive toilet paper or garbage in the toilet.",
    "11 AM check out time strictly enforced ($100 late fee).",
    "Quiet hours: 11:00 PM – 7:00 AM."
  ]
};

const mockDescription = `Beautifully appointed space offering premium comfort and unparalleled access to the city's best attractions. 

Fully equipped kitchen for culinary enthusiasts.
Easy access to nearby parks & schools.
Surrounded by great restaurants, lakes, and much more to explore.

For longer stays, don't hesitate to message us for better prices. Enjoy your stay in this thoughtfully designed retreat!`;

export const properties: Property[] = [
  {
    id: 'p_01',
    slug: 'the-glass-pavilion-toronto',
    name: 'Skyline View King Bed 2 Bedroom Free Parking',
    location: 'Downtown Toronto, ON',
    coordinates: [-79.3832, 43.6532], 
    price: 3500,
    currency: 'CAD',
    bedrooms: 2,
    beds: 0,
    bathrooms: 1,
    guests: 6,
    coverImage: 'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?auto=format&fit=crop&q=80&w=2000',
    type: 'Condo',
    propertyTypeTag: 'Entire condo',
    highlights: ['City skyline view', 'Park for free', 'Self check-in'],
    amenities: ['City View', 'Free Parking', 'Smart Home', 'Wifi'],
    offers: mockOffers,
    description: mockDescription,
    priceInfo: { nightly: 3500, weekly: 3200, monthly: 3000, weekend: 3800, cleaningFee: 250, minNights: 3 },
    addressDetails: { city: 'Toronto', state: 'ON', area: 'Downtown Core', country: 'Canada' },
    details: { checkIn: '4:00 PM', checkOut: '11:00 AM' },
    terms: mockTerms
  },
  {
    id: 'p_02',
    slug: 'richmond-hill-estate',
    name: 'Spacious Family Home with Pool and Garden',
    location: 'Richmond Hill, ON',
    coordinates: [-79.4357, 43.8711],
    price: 1800,
    currency: 'CAD',
    bedrooms: 5,
    beds: 0,
    bathrooms: 4,
    guests: 10,
    coverImage: 'https://images.unsplash.com/photo-1512917774080-9991f1c4c750?auto=format&fit=crop&q=80&w=2000',
    type: 'House',
    propertyTypeTag: 'Entire home',
    highlights: ['Extra spacious', 'Park for free', 'Great location'],
    amenities: ['Large Garden', 'Pool', 'Fire Pit', 'Wifi'],
    offers: [
      ...mockOffers.filter(o => o.name !== 'City skyline view' && o.name !== 'Elevator'),
      { name: "Pool", category: "Parking and facilities", available: true },
      { name: "Indoor fireplace", category: "Heating and cooling", available: true },
      { name: "Fire pit", category: "Outdoor", available: true },
      { name: "Backyard", category: "Outdoor", available: true },
    ],
    description: mockDescription,
    priceInfo: { nightly: 1800, weekly: 1700, monthly: 1500, weekend: 2000, cleaningFee: 150, minNights: 2 },
    addressDetails: { city: 'Richmond Hill', state: 'ON', area: 'Oak Ridges', country: 'Canada' },
    details: { checkIn: '4:00 PM', checkOut: '11:00 AM' },
    terms: mockTerms
  },
  {
    id: 'p_03',
    slug: 'aurora-manor',
    name: 'Comfortable & Cozy Family Basement Suite',
    location: 'Aurora, ON',
    coordinates: [-79.4673, 44.0065],
    price: 2200,
    currency: 'CAD',
    bedrooms: 1,
    beds: 0,
    bathrooms: 1,
    guests: 2,
    coverImage: 'https://images.unsplash.com/photo-1613977257363-707ba9348227?auto=format&fit=crop&q=80&w=2000',
    type: 'House',
    propertyTypeTag: 'Entire home',
    highlights: ['Park for free', 'At-home coffee', 'Peace and quiet'],
    amenities: ['Private Entrance', 'Free Parking', 'Wifi'],
    offers: mockOffers.filter(o => o.name !== 'City skyline view' && o.name !== 'Elevator' && o.name !== 'Bathtub'),
    description: mockDescription,
    priceInfo: { nightly: 2200, weekly: 2100, monthly: 1900, weekend: 2400, cleaningFee: 200, minNights: 2 },
    addressDetails: { city: 'Aurora', state: 'ON', area: 'Magna', country: 'Canada' },
    details: { checkIn: '4:00 PM', checkOut: '11:00 AM' },
    terms: mockTerms
  },
  {
    id: 'p_04',
    slug: 'markham-ranch-home',
    name: '4 Bedroom 2 Bathroom Texas Ranch Style Home',
    location: 'Markham, ON',
    coordinates: [-79.3193, 43.8561],
    price: 1500,
    currency: 'CAD',
    bedrooms: 4,
    beds: 0,
    bathrooms: 2,
    guests: 8,
    coverImage: 'https://images.unsplash.com/photo-1510798831971-661eb04b3739?auto=format&fit=crop&q=80&w=2000',
    type: 'House',
    propertyTypeTag: 'Entire home',
    highlights: ['Self check-in', 'Extra spacious', 'Peace and quiet'],
    amenities: ['Fireplace', 'Free Parking', 'Waterfront'],
    offers: [
      ...mockOffers.filter(o => o.name !== 'City skyline view' && o.name !== 'Elevator'),
      { name: "Indoor fireplace", category: "Heating and cooling", available: true },
      { name: "Waterfront", category: "Location features", available: true },
      { name: "Private entrance", category: "Location features", available: true },
      { name: "Books and reading material", category: "Entertainment", available: true },
      { name: "Free driveway parking – 3 spaces", category: "Parking and facilities", available: true },
    ],
    description: mockDescription,
    priceInfo: { nightly: 1500, weekly: 1400, monthly: 1300, weekend: 1600, cleaningFee: 100, minNights: 1 },
    addressDetails: { city: 'Markham', state: 'ON', area: 'Unionville', country: 'Canada' },
    details: { checkIn: '4:00 PM', checkOut: '11:00 AM' },
    terms: mockTerms
  },
  {
    id: 'p_05',
    slug: 'yorkville-sanctuary',
    name: 'Luxury Suite in the Heart of Yorkville',
    location: 'Downtown Toronto, ON',
    coordinates: [-79.3932, 43.6702],
    price: 2800,
    currency: 'CAD',
    bedrooms: 2,
    beds: 0,
    bathrooms: 2,
    guests: 4,
    coverImage: 'https://images.unsplash.com/photo-1600607687920-4e2a09cf159d?auto=format&fit=crop&q=80&w=2000',
    type: 'Condo',
    propertyTypeTag: 'Entire condo',
    highlights: ['City skyline view', 'Great location', 'Self check-in'],
    amenities: ['City View', 'Balcony', 'Modern Interior', 'Wifi'],
    offers: mockOffers,
    description: mockDescription,
    priceInfo: { nightly: 2800, weekly: 2600, monthly: 2400, weekend: 3000, cleaningFee: 150, minNights: 2 },
    addressDetails: { city: 'Toronto', state: 'ON', area: 'Yorkville', country: 'Canada' },
    details: { checkIn: '4:00 PM', checkOut: '11:00 AM' },
    terms: mockTerms
  },
  {
    id: 'p_06',
    slug: 'vaughan-valley-estate',
    name: 'Private Estate with Wine Cellar and Heated Driveway',
    location: 'Vaughan, ON',
    coordinates: [-79.5255, 43.8345],
    price: 1950,
    currency: 'CAD',
    bedrooms: 5,
    beds: 0,
    bathrooms: 4.5,
    guests: 10,
    coverImage: 'https://images.unsplash.com/photo-1576941089067-2de3c901e126?auto=format&fit=crop&q=80&w=2000',
    type: 'House',
    propertyTypeTag: 'Entire home',
    highlights: ['Extra spacious', 'Park for free', 'Peace and quiet'],
    amenities: ['Wine Cellar', 'Heated Driveway', 'Outdoor Kitchen'],
    offers: [
      ...mockOffers.filter(o => o.name !== 'City skyline view'),
      { name: "Wine cellar", category: "Entertainment", available: true },
      { name: "Outdoor kitchen", category: "Outdoor", available: true },
      { name: "Indoor fireplace", category: "Heating and cooling", available: true },
      { name: "Heated driveway", category: "Parking and facilities", available: true },
    ],
    description: mockDescription,
    priceInfo: { nightly: 1950, weekly: 1800, monthly: 1600, weekend: 2100, cleaningFee: 200, minNights: 2 },
    addressDetails: { city: 'Vaughan', state: 'ON', area: 'Woodbridge', country: 'Canada' },
    details: { checkIn: '4:00 PM', checkOut: '11:00 AM' },
    terms: mockTerms
  },
  {
    id: 'p_07',
    slug: 'north-york-oasis',
    name: '1 Bedroom Private Basement Suite in Prime Location',
    location: 'North York, ON',
    coordinates: [-79.4125, 43.7615],
    price: 1200,
    currency: 'CAD',
    bedrooms: 1,
    beds: 0,
    bathrooms: 1,
    guests: 2,
    coverImage: 'https://images.unsplash.com/photo-1580587771525-78b9dba3b914?auto=format&fit=crop&q=80&w=2000',
    type: 'House',
    propertyTypeTag: 'Entire guest suite',
    highlights: ['Self check-in', 'Peace and quiet', 'Park for free'],
    amenities: ['Subway Access', 'Private Entrance', 'Wifi'],
    offers: mockOffers.filter(o => o.name !== 'City skyline view' && o.name !== 'Elevator' && o.name !== 'Bathtub'),
    description: mockDescription,
    priceInfo: { nightly: 1200, weekly: 1100, monthly: 1000, weekend: 1400, cleaningFee: 100, minNights: 1 },
    addressDetails: { city: 'Toronto', state: 'ON', area: 'North York', country: 'Canada' },
    details: { checkIn: '4:00 PM', checkOut: '11:00 AM' },
    terms: mockTerms
  },
  {
    id: 'p_08',
    slug: 'king-city-ranch',
    name: 'King City Country Ranch with Private Woods',
    location: 'King City, ON',
    coordinates: [-79.5283, 43.9298],
    price: 2400,
    currency: 'CAD',
    bedrooms: 6,
    beds: 0,
    bathrooms: 5,
    guests: 12,
    coverImage: 'https://images.unsplash.com/photo-1558036117-15d82a90b9b1?auto=format&fit=crop&q=80&w=2000',
    type: 'House',
    propertyTypeTag: 'Entire home',
    highlights: ['Extra spacious', 'Peace and quiet', 'Furry friends welcome'],
    amenities: ['Private Woods', 'Indoor Pool', 'Equestrian'],
    offers: [
      ...mockOffers.filter(o => o.name !== 'City skyline view'),
      { name: "Pool", category: "Parking and facilities", available: true },
      { name: "Indoor fireplace", category: "Heating and cooling", available: true },
      { name: "Private entrance", category: "Location features", available: true },
      { name: "Backyard", category: "Outdoor", available: true },
      { name: "Fire pit", category: "Outdoor", available: true },
    ],
    description: mockDescription,
    priceInfo: { nightly: 2400, weekly: 2200, monthly: 2000, weekend: 2800, cleaningFee: 300, minNights: 3 },
    addressDetails: { city: 'King City', state: 'ON', area: 'Rural', country: 'Canada' },
    details: { checkIn: '4:00 PM', checkOut: '11:00 AM' },
    terms: { ...mockTerms, petsAllowed: true },
  }
];
