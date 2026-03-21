// Comprehensive internal icon library for amenities
// Each icon has an id, display name, SVG markup, keywords for search, and category

export interface AmenityIcon {
  id: string;
  name: string;
  svg: string;
  keywords: string[];
  category: string;
}

// Helper: generate a simple SVG string with consistent attributes
const s = (inner: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

export const AMENITY_ICONS: AmenityIcon[] = [
  // ===================== Kitchen & Dining =====================
  { id: 'kitchen', name: 'Kitchen', category: 'Kitchen & Dining', keywords: ['kitchen', 'cook', 'cooking', 'culinary'], svg: s('<path d="M3 2v20M3 10h4V2M10 2v8a4 4 0 004 4M14 2v20M21 2v8M21 2c-1.5 0-3 1.5-3 4s1.5 4 3 4M21 14v8"/>') },
  { id: 'refrigerator', name: 'Refrigerator', category: 'Kitchen & Dining', keywords: ['refrigerator', 'fridge', 'freezer', 'cold'], svg: s('<rect x="4" y="2" width="16" height="20" rx="2"/><line x1="4" y1="10" x2="20" y2="10"/><line x1="9" y1="6" x2="9" y2="8"/><line x1="9" y1="14" x2="9" y2="16"/>') },
  { id: 'microwave', name: 'Microwave', category: 'Kitchen & Dining', keywords: ['microwave', 'reheat', 'warm'], svg: s('<rect x="2" y="4" width="20" height="15" rx="2"/><rect x="4" y="6" width="12" height="11" rx="1"/><circle cx="18.5" cy="9" r="0.8"/><circle cx="18.5" cy="12" r="0.8"/><line x1="2" y1="19" x2="22" y2="19"/>') },
  { id: 'stove', name: 'Stove', category: 'Kitchen & Dining', keywords: ['stove', 'burner', 'range', 'cooktop'], svg: s('<rect x="3" y="6" width="18" height="16" rx="2"/><circle cx="8" cy="4" r="1.5"/><circle cx="16" cy="4" r="1.5"/><line x1="3" y1="14" x2="21" y2="14"/>') },
  { id: 'oven', name: 'Oven', category: 'Kitchen & Dining', keywords: ['oven', 'bake', 'baking', 'roast'], svg: s('<rect x="3" y="2" width="18" height="20" rx="2"/><line x1="3" y1="8" x2="21" y2="8"/><rect x="6" y="11" width="12" height="8" rx="1"/><circle cx="8" cy="5" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="16" cy="5" r="1"/>') },
  { id: 'dishwasher', name: 'Dishwasher', category: 'Kitchen & Dining', keywords: ['dishwasher', 'dish', 'dishes', 'clean'], svg: s('<rect x="3" y="2" width="18" height="20" rx="2"/><line x1="3" y1="8" x2="21" y2="8"/><circle cx="12" cy="15" r="4"/><line x1="12" y1="5" x2="14" y2="5"/>') },
  { id: 'coffee', name: 'Coffee Maker', category: 'Kitchen & Dining', keywords: ['coffee', 'espresso', 'nespresso', 'cappuccino', 'latte', 'cafe', 'maker'], svg: s('<path d="M17 8h1a4 4 0 010 8h-1"/><path d="M3 8h14v9a4 4 0 01-4 4H7a4 4 0 01-4-4V8z"/><line x1="6" y1="2" x2="6" y2="4"/><line x1="10" y1="2" x2="10" y2="4"/><line x1="14" y1="2" x2="14" y2="4"/>') },
  { id: 'toaster', name: 'Toaster', category: 'Kitchen & Dining', keywords: ['toaster', 'toast', 'bread'], svg: s('<rect x="4" y="6" width="16" height="12" rx="3"/><line x1="8" y1="3" x2="8" y2="6"/><line x1="16" y1="3" x2="16" y2="6"/><line x1="4" y1="18" x2="6" y2="20"/><line x1="20" y1="18" x2="18" y2="20"/>') },
  { id: 'blender', name: 'Blender', category: 'Kitchen & Dining', keywords: ['blender', 'smoothie', 'mix', 'blend'], svg: s('<path d="M9 2h6l-1 10H10L9 2z"/><path d="M10 12h4v2a4 4 0 01-4 4h0"/><rect x="8" y="18" width="8" height="3" rx="1"/>') },
  { id: 'dining_table', name: 'Dining Table', category: 'Kitchen & Dining', keywords: ['dining', 'table', 'eat', 'meal', 'dinner', 'breakfast'], svg: s('<rect x="3" y="8" width="18" height="2" rx="1"/><line x1="6" y1="10" x2="6" y2="20"/><line x1="18" y1="10" x2="18" y2="20"/><line x1="9" y1="4" x2="9" y2="8"/><line x1="15" y1="4" x2="15" y2="8"/>') },
  { id: 'wine', name: 'Wine Glasses', category: 'Kitchen & Dining', keywords: ['wine', 'glass', 'glasses', 'cellar', 'vineyard', 'bar'], svg: s('<path d="M8 2h8l-1 6a4 4 0 01-3 3.5M12 11.5V20"/><line x1="8" y1="20" x2="16" y2="20"/><path d="M12 11.5a4 4 0 01-3-3.5L8 2"/>') },
  { id: 'kettle', name: 'Kettle', category: 'Kitchen & Dining', keywords: ['kettle', 'tea', 'boil', 'hot', 'electric'], svg: s('<ellipse cx="10" cy="14" rx="7" ry="8"/><path d="M17 10h2a2 2 0 010 4h-2"/><line x1="10" y1="3" x2="10" y2="6"/><line x1="7" y1="4" x2="7" y2="6"/><line x1="13" y1="4" x2="13" y2="6"/>') },
  { id: 'utensils', name: 'Utensils', category: 'Kitchen & Dining', keywords: ['utensils', 'silverware', 'cutlery', 'fork', 'knife', 'spoon', 'cooking basics'], svg: s('<path d="M3 2v8a4 4 0 004 4M7 2v8a4 4 0 01-4 4M5 14v8"/><path d="M19 2v4a4 4 0 01-4 4h0a4 4 0 01-4-4V2h8z"/><line x1="15" y1="10" x2="15" y2="22"/>') },
  { id: 'pantry', name: 'Pantry', category: 'Kitchen & Dining', keywords: ['pantry', 'storage', 'food', 'supplies', 'staples'], svg: s('<rect x="4" y="2" width="16" height="20" rx="2"/><line x1="4" y1="8" x2="20" y2="8"/><line x1="4" y1="14" x2="20" y2="14"/><line x1="12" y1="2" x2="12" y2="22"/>') },

  // ===================== Bathroom =====================
  { id: 'bathtub', name: 'Bathtub', category: 'Bathroom', keywords: ['bathtub', 'bath', 'tub', 'soak'], svg: s('<path d="M4 12h16a1 1 0 011 1v3a4 4 0 01-4 4H7a4 4 0 01-4-4v-3a1 1 0 011-1z"/><path d="M6 12V5a2 2 0 012-2h0a2 2 0 012 2v1"/>') },
  { id: 'shower', name: 'Shower', category: 'Bathroom', keywords: ['shower', 'rain', 'rainfall', 'rinse'], svg: s('<path d="M4 4h4v16"/><circle cx="14" cy="6" r="4"/><path d="M12 10v3M10 13l4-1M14 13l-4-1"/><path d="M11 16l1 6M15 16l-1 6M13 16l0 6"/>') },
  { id: 'hair_dryer', name: 'Hair Dryer', category: 'Bathroom', keywords: ['hair', 'dryer', 'blow', 'dry'], svg: s('<path d="M22 12a5 5 0 01-5 5h-2l-4 5V2l4 5h2a5 5 0 015 5z"/>') },
  { id: 'shampoo', name: 'Shampoo', category: 'Bathroom', keywords: ['shampoo', 'conditioner', 'body wash', 'soap', 'toiletries'], svg: s('<rect x="7" y="6" width="10" height="16" rx="2"/><path d="M10 6V4a2 2 0 012-2h0a2 2 0 012 2v2"/><line x1="12" y1="10" x2="12" y2="14"/>') },
  { id: 'hot_water', name: 'Hot Water', category: 'Bathroom', keywords: ['hot', 'water', 'warm'],  svg: s('<path d="M12 2c-3 4-6 6-6 10a6 6 0 0012 0c0-4-3-6-6-10z"/><path d="M12 8c-1.5 2-3 3-3 5a3 3 0 006 0c0-2-1.5-3-3-5z"/>') },
  { id: 'towels', name: 'Towels', category: 'Bathroom', keywords: ['towel', 'towels', 'bath towel', 'linen'], svg: s('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 12h16"/><path d="M8 4v16M16 4v16"/>') },
  { id: 'bidet', name: 'Bidet', category: 'Bathroom', keywords: ['bidet', 'spray', 'clean'], svg: s('<ellipse cx="12" cy="16" rx="6" ry="5"/><path d="M12 2v6"/><circle cx="12" cy="14" r="1"/>') },
  { id: 'toilet', name: 'Toilet', category: 'Bathroom', keywords: ['toilet', 'bathroom', 'restroom', 'wc'], svg: s('<path d="M6 10V4a2 2 0 012-2h8a2 2 0 012 2v6"/><ellipse cx="12" cy="14" rx="7" ry="5"/><path d="M10 19l-1 3h6l-1-3"/>') },

  // ===================== Bedroom & Laundry =====================
  { id: 'bed', name: 'Bed', category: 'Bedroom & Laundry', keywords: ['bed', 'bedroom', 'sleep', 'king', 'queen', 'double', 'single', 'twin', 'mattress'], svg: s('<path d="M2 17V7a2 2 0 012-2h16a2 2 0 012 2v10"/><path d="M2 17h20v2H2z"/><path d="M6 12a3 3 0 013-3h0a3 3 0 013 3"/>') },
  { id: 'pillow', name: 'Pillows', category: 'Bedroom & Laundry', keywords: ['pillow', 'pillows', 'extra', 'blanket', 'blankets', 'comforter'], svg: s('<ellipse cx="12" cy="12" rx="10" ry="6"/><path d="M12 6v12"/>') },
  { id: 'washer', name: 'Washer', category: 'Bedroom & Laundry', keywords: ['washer', 'washing', 'machine', 'laundry', 'wash'], svg: s('<rect x="3" y="2" width="18" height="20" rx="2"/><circle cx="12" cy="14" r="4"/><line x1="3" y1="8" x2="21" y2="8"/><circle cx="7" cy="5" r="1"/>') },
  { id: 'dryer', name: 'Dryer', category: 'Bedroom & Laundry', keywords: ['dryer', 'dry', 'tumble'], svg: s('<rect x="3" y="2" width="18" height="20" rx="2"/><circle cx="12" cy="14" r="4"/><line x1="3" y1="8" x2="21" y2="8"/><circle cx="7" cy="5" r="1"/><path d="M10 12a3 3 0 014 4"/>') },
  { id: 'iron', name: 'Iron', category: 'Bedroom & Laundry', keywords: ['iron', 'ironing', 'press', 'board'], svg: s('<path d="M3 17h18l-3-8H8l-5 8z"/><path d="M8 9V5a2 2 0 012-2h4"/>') },
  { id: 'hangers', name: 'Hangers', category: 'Bedroom & Laundry', keywords: ['hanger', 'hangers', 'closet', 'wardrobe', 'clothes'], svg: s('<path d="M12 3a3 3 0 00-3 3c0 1 .6 1.7 1.5 2L2 14h20L13.5 8c.9-.3 1.5-1 1.5-2a3 3 0 00-3-3z"/><line x1="2" y1="14" x2="2" y2="18"/><line x1="22" y1="14" x2="22" y2="18"/>') },
  { id: 'linens', name: 'Bed Linens', category: 'Bedroom & Laundry', keywords: ['linen', 'linens', 'sheets', 'bedding', 'essentials'], svg: s('<path d="M2 17V7a2 2 0 012-2h16a2 2 0 012 2v10"/><path d="M2 17h20v2H2z"/>') },
  { id: 'dresser', name: 'Dresser', category: 'Bedroom & Laundry', keywords: ['dresser', 'drawers', 'drawer', 'chest', 'storage', 'furniture'], svg: s('<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="10" y1="6" x2="14" y2="6"/><line x1="10" y1="12" x2="14" y2="12"/><line x1="10" y1="18" x2="14" y2="18"/>') },

  // ===================== Entertainment =====================
  { id: 'tv', name: 'TV', category: 'Entertainment', keywords: ['tv', 'television', 'hdtv', 'smart', 'streaming', 'netflix', 'screen', 'monitor', 'cable'], svg: s('<rect x="2" y="4" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="18" x2="12" y2="21"/>') },
  { id: 'gaming', name: 'Game Console', category: 'Entertainment', keywords: ['game', 'gaming', 'console', 'playstation', 'xbox', 'nintendo', 'video'], svg: s('<rect x="2" y="8" width="20" height="10" rx="5"/><circle cx="8" cy="13" r="2"/><circle cx="16" cy="11" r="1"/><circle cx="18" cy="13" r="1"/><circle cx="16" cy="15" r="1"/><circle cx="14" cy="13" r="1"/>') },
  { id: 'books', name: 'Books', category: 'Entertainment', keywords: ['book', 'books', 'reading', 'library', 'literature', 'material'], svg: s('<path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/>') },
  { id: 'sound_system', name: 'Sound System', category: 'Entertainment', keywords: ['sound', 'speaker', 'bluetooth', 'music', 'audio', 'stereo', 'sonos'], svg: s('<rect x="4" y="2" width="16" height="20" rx="2"/><circle cx="12" cy="14" r="4"/><circle cx="12" cy="6" r="1"/>') },
  { id: 'record_player', name: 'Record Player', category: 'Entertainment', keywords: ['record', 'vinyl', 'turntable', 'player'], svg: s('<rect x="2" y="4" width="20" height="16" rx="2"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>') },
  { id: 'board_games', name: 'Board Games', category: 'Entertainment', keywords: ['board', 'games', 'puzzles', 'cards', 'toys', 'family'], svg: s('<rect x="2" y="2" width="20" height="20" rx="2"/><line x1="12" y1="2" x2="12" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><circle cx="7" cy="7" r="2"/><circle cx="17" cy="17" r="2"/>') },
  { id: 'piano', name: 'Piano', category: 'Entertainment', keywords: ['piano', 'keyboard', 'instrument', 'music'], svg: s('<rect x="2" y="6" width="20" height="12" rx="1"/><line x1="6" y1="6" x2="6" y2="14"/><line x1="10" y1="6" x2="10" y2="14"/><line x1="14" y1="6" x2="14" y2="14"/><line x1="18" y1="6" x2="18" y2="14"/>') },

  // ===================== Heating & Cooling =====================
  { id: 'ac', name: 'Air Conditioning', category: 'Heating & Cooling', keywords: ['air', 'conditioning', 'ac', 'cool', 'central', 'climate'], svg: s('<rect x="2" y="3" width="20" height="8" rx="2"/><path d="M6 14v2m0 2v2m6-6v2m0 2v2m6-6v2m0 2v2"/>') },
  { id: 'heating', name: 'Heating', category: 'Heating & Cooling', keywords: ['heating', 'heat', 'warm', 'central', 'radiator', 'radiant'], svg: s('<path d="M12 2c-3 4-6 6-6 10a6 6 0 0012 0c0-4-3-6-6-10z"/>') },
  { id: 'fan', name: 'Fan', category: 'Heating & Cooling', keywords: ['fan', 'ceiling', 'portable', 'breeze', 'ventilation'], svg: s('<circle cx="12" cy="12" r="2"/><path d="M12 2c-3 0-4 3-4 5s3 4 4 5M12 22c3 0 4-3 4-5s-3-4-4-5M2 12c0-3 3-4 5-4s4 3 5 4M22 12c0 3-3 4-5 4s-4-3-5-4"/>') },
  { id: 'fireplace', name: 'Fireplace', category: 'Heating & Cooling', keywords: ['fireplace', 'fire', 'indoor', 'hearth', 'wood', 'burning'], svg: s('<rect x="2" y="2" width="20" height="4" rx="1"/><rect x="4" y="6" width="16" height="16"/><path d="M12 22v-6a3 3 0 013-3h0c0 2-1 3-1 5"/><path d="M12 22v-6a3 3 0 00-3-3h0c0 2 1 3 1 5"/>') },
  { id: 'heated_floors', name: 'Heated Floors', category: 'Heating & Cooling', keywords: ['heated', 'floor', 'floors', 'underfloor', 'radiant'], svg: s('<path d="M3 20h18"/><path d="M5 16c2-2 4 2 6 0s4 2 6 0"/><path d="M5 12c2-2 4 2 6 0s4 2 6 0"/>') },

  // ===================== Internet & Office =====================
  { id: 'wifi', name: 'Wifi', category: 'Internet & Office', keywords: ['wifi', 'internet', 'wireless', 'connection', 'broadband', 'fast'], svg: s('<path d="M5 12.55a11 11 0 0114.08 0"/><path d="M1.42 9a16 16 0 0121.16 0"/><path d="M8.53 16.11a6 6 0 016.95 0"/><circle cx="12" cy="20" r="1" fill="currentColor"/>') },
  { id: 'workspace', name: 'Workspace', category: 'Internet & Office', keywords: ['workspace', 'desk', 'office', 'work', 'dedicated', 'laptop', 'computer'], svg: s('<rect x="3" y="4" width="18" height="12" rx="2"/><line x1="7" y1="20" x2="17" y2="20"/><line x1="12" y1="16" x2="12" y2="20"/>') },
  { id: 'printer', name: 'Printer', category: 'Internet & Office', keywords: ['printer', 'print', 'scanner', 'fax'], svg: s('<rect x="6" y="14" width="12" height="6" rx="1"/><path d="M6 14V4h12v10"/><rect x="4" y="10" width="16" height="8" rx="2"/><line x1="8" y1="18" x2="16" y2="18"/>') },
  { id: 'ethernet', name: 'Ethernet', category: 'Internet & Office', keywords: ['ethernet', 'cable', 'wired', 'lan', 'port'], svg: s('<rect x="4" y="8" width="16" height="10" rx="2"/><line x1="8" y1="18" x2="8" y2="22"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="16" y1="18" x2="16" y2="22"/><line x1="4" y1="12" x2="2" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/>') },

  // ===================== Parking & Facilities =====================
  { id: 'parking', name: 'Parking', category: 'Parking & Facilities', keywords: ['parking', 'garage', 'car', 'vehicle', 'driveway', 'free', 'paid', 'space', 'spaces', 'premises'], svg: s('<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 17V7h4a3 3 0 010 6H9"/>') },
  { id: 'elevator', name: 'Elevator', category: 'Parking & Facilities', keywords: ['elevator', 'lift'], svg: s('<rect x="3" y="2" width="18" height="20" rx="2"/><line x1="12" y1="2" x2="12" y2="22"/><polyline points="7 9 7.5 7 8 9"/><polyline points="16 13 16.5 15 17 13"/>') },
  { id: 'pool', name: 'Pool', category: 'Parking & Facilities', keywords: ['pool', 'swim', 'swimming', 'indoor', 'outdoor'], svg: s('<path d="M2 16c1.5-1.5 3.5-1.5 5 0s3.5 1.5 5 0 3.5-1.5 5 0 3.5 1.5 5 0"/><path d="M2 20c1.5-1.5 3.5-1.5 5 0s3.5 1.5 5 0 3.5-1.5 5 0 3.5 1.5 5 0"/><line x1="8" y1="4" x2="8" y2="14"/><line x1="16" y1="4" x2="16" y2="14"/><path d="M8 8h8"/>') },
  { id: 'hot_tub', name: 'Hot Tub', category: 'Parking & Facilities', keywords: ['hot tub', 'jacuzzi', 'spa', 'whirlpool'], svg: s('<ellipse cx="12" cy="16" rx="9" ry="5"/><line x1="6" y1="3" x2="6" y2="8"/><line x1="10" y1="2" x2="10" y2="7"/><line x1="14" y1="3" x2="14" y2="8"/>') },
  { id: 'gym', name: 'Gym', category: 'Parking & Facilities', keywords: ['gym', 'fitness', 'exercise', 'workout', 'weight', 'training'], svg: s('<path d="M6 5v14M18 5v14M4 7h4M4 17h4M16 7h4M16 17h4M6 12h12"/>') },
  { id: 'ev_charger', name: 'EV Charger', category: 'Parking & Facilities', keywords: ['ev', 'charger', 'electric', 'vehicle', 'charging', 'tesla'], svg: s('<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M13 7l-3 5h4l-3 5"/>') },
  { id: 'sauna', name: 'Sauna', category: 'Parking & Facilities', keywords: ['sauna', 'steam', 'room', 'spa', 'wellness'], svg: s('<rect x="3" y="6" width="18" height="16" rx="2"/><path d="M8 2v4M12 2v4M16 2v4"/><path d="M7 14c1-1 2 1 3 0s2 1 3 0"/>') },
  { id: 'doorman', name: 'Doorman', category: 'Parking & Facilities', keywords: ['doorman', 'concierge', 'bellhop', 'porter', 'lobby'], svg: s('<circle cx="12" cy="5" r="3"/><path d="M12 8v14"/><path d="M8 12h8"/><path d="M7 22h10"/>') },

  // ===================== Outdoor =====================
  { id: 'backyard', name: 'Backyard', category: 'Outdoor', keywords: ['backyard', 'yard', 'garden', 'outdoor', 'grass', 'lawn'], svg: s('<path d="M12 3L2 12h3v8h14v-8h3L12 3z"/>') },
  { id: 'patio', name: 'Patio / Deck', category: 'Outdoor', keywords: ['patio', 'deck', 'terrace', 'veranda', 'porch'], svg: s('<path d="M3 12h18"/><path d="M5 12v8"/><path d="M19 12v8"/><path d="M12 2v10"/><path d="M3 12l9-10 9 10"/>') },
  { id: 'bbq', name: 'BBQ Grill', category: 'Outdoor', keywords: ['bbq', 'grill', 'barbecue', 'barbeque', 'charcoal', 'gas'], svg: s('<ellipse cx="12" cy="10" rx="8" ry="4"/><line x1="8" y1="14" x2="7" y2="20"/><line x1="16" y1="14" x2="17" y2="20"/><line x1="12" y1="14" x2="12" y2="20"/><line x1="8" y1="4" x2="8" y2="6"/><line x1="12" y1="3" x2="12" y2="6"/><line x1="16" y1="4" x2="16" y2="6"/>') },
  { id: 'fire_pit', name: 'Fire Pit', category: 'Outdoor', keywords: ['fire', 'pit', 'campfire', 'bonfire', 'outdoor fire'], svg: s('<circle cx="12" cy="14" r="8"/><path d="M12 6c-2 3-4 4-4 7a4 4 0 008 0c0-3-2-4-4-7z"/>') },
  { id: 'balcony', name: 'Balcony', category: 'Outdoor', keywords: ['balcony', 'terrace', 'veranda', 'rooftop'], svg: s('<path d="M3 10h18v2H3z"/><line x1="5" y1="12" x2="5" y2="20"/><line x1="9" y1="12" x2="9" y2="20"/><line x1="15" y1="12" x2="15" y2="20"/><line x1="19" y1="12" x2="19" y2="20"/><path d="M12 2v8"/>') },
  { id: 'outdoor_shower', name: 'Outdoor Shower', category: 'Outdoor', keywords: ['outdoor shower', 'outside shower'], svg: s('<circle cx="12" cy="4" r="3"/><path d="M10 7l-1 5M14 7l1 5"/><path d="M8 16l1-4h6l1 4"/><path d="M9 16c1 2 1 4 1 6M15 16c-1 2-1 4-1 6"/>') },
  { id: 'outdoor_dining', name: 'Outdoor Dining', category: 'Outdoor', keywords: ['outdoor dining', 'al fresco', 'outdoor table', 'outdoor furniture', 'outdoor kitchen'], svg: s('<circle cx="12" cy="4" r="3"/><line x1="12" y1="7" x2="12" y2="10"/><rect x="4" y="10" width="16" height="2" rx="1"/><line x1="6" y1="12" x2="5" y2="20"/><line x1="18" y1="12" x2="19" y2="20"/>') },
  { id: 'hammock', name: 'Hammock', category: 'Outdoor', keywords: ['hammock', 'relax', 'swing', 'lounge'], svg: s('<path d="M2 8c4 0 6 6 10 6s6-6 10-6"/><line x1="2" y1="4" x2="2" y2="12"/><line x1="22" y1="4" x2="22" y2="12"/>') },

  // ===================== Safety =====================
  { id: 'smoke_alarm', name: 'Smoke Alarm', category: 'Safety', keywords: ['smoke', 'alarm', 'detector', 'fire alarm'], svg: s('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2"/>') },
  { id: 'fire_extinguisher', name: 'Fire Extinguisher', category: 'Safety', keywords: ['fire', 'extinguisher', 'safety', 'emergency'], svg: s('<rect x="7" y="6" width="10" height="16" rx="3"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="15" y1="3" x2="18" y2="3"/><circle cx="12" cy="14" r="3"/>') },
  { id: 'first_aid', name: 'First Aid Kit', category: 'Safety', keywords: ['first', 'aid', 'kit', 'medical', 'emergency', 'health'], svg: s('<rect x="3" y="6" width="18" height="14" rx="2"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/><line x1="12" y1="10" x2="12" y2="16"/><line x1="9" y1="13" x2="15" y2="13"/>') },
  { id: 'carbon_monoxide', name: 'CO Alarm', category: 'Safety', keywords: ['carbon', 'monoxide', 'co', 'alarm', 'detector', 'gas'], svg: s('<circle cx="12" cy="12" r="9"/><path d="M9 9h3a3 3 0 010 6h-3"/>') },
  { id: 'lock', name: 'Lock / Security', category: 'Safety', keywords: ['lock', 'security', 'safe', 'lockbox', 'key', 'secure', 'surveillance', 'camera'], svg: s('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/><circle cx="12" cy="16" r="1"/>') },

  // ===================== Views & Location =====================
  { id: 'ocean_view', name: 'Ocean View', category: 'Views & Location', keywords: ['ocean', 'sea', 'beach', 'coast', 'shore', 'waterfront', 'beachfront'], svg: s('<path d="M2 16c1.5-1.5 3.5-1.5 5 0s3.5 1.5 5 0 3.5-1.5 5 0 3.5 1.5 5 0"/><path d="M2 20c1.5-1.5 3.5-1.5 5 0s3.5 1.5 5 0 3.5-1.5 5 0 3.5 1.5 5 0"/><circle cx="17" cy="6" r="4"/><line x1="2" y1="12" x2="22" y2="12"/>') },
  { id: 'mountain_view', name: 'Mountain View', category: 'Views & Location', keywords: ['mountain', 'hill', 'peak', 'scenic', 'nature', 'landscape'], svg: s('<path d="M8 21l4-10 4 10"/><path d="M2 21l6-12 3 6"/><path d="M22 21l-6-12-3 6"/>') },
  { id: 'city_view', name: 'City View', category: 'Views & Location', keywords: ['city', 'skyline', 'downtown', 'urban', 'skyscraper', 'view'], svg: s('<rect x="2" y="10" width="4" height="12"/><rect x="7" y="4" width="4" height="18"/><rect x="12" y="8" width="4" height="14"/><rect x="17" y="6" width="5" height="16"/>') },
  { id: 'lake_view', name: 'Lake View', category: 'Views & Location', keywords: ['lake', 'lakefront', 'lakeside', 'pond', 'reservoir'], svg: s('<path d="M2 18c2-2 4 0 6-2s4 0 6-2 4 0 6-2"/><path d="M2 14c2-2 4 0 6-2s4 0 6-2 4 0 6-2"/><circle cx="17" cy="5" r="3"/>') },
  { id: 'garden_view', name: 'Garden View', category: 'Views & Location', keywords: ['garden', 'courtyard', 'greenery', 'flower', 'plant'], svg: s('<path d="M12 22V12"/><path d="M12 12c-3-4-8-3-8 1s5 5 8 1"/><path d="M12 12c3-4 8-3 8 1s-5 5-8 1"/><path d="M12 8c-2-3-5-2-5 1s3 3 5 1"/><path d="M12 8c2-3 5-2 5 1s-3 3-5 1"/>') },
  { id: 'private_entrance', name: 'Private Entrance', category: 'Views & Location', keywords: ['private', 'entrance', 'entry', 'separate', 'own'], svg: s('<path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/>') },

  // ===================== Services =====================
  { id: 'self_checkin', name: 'Self Check-in', category: 'Services', keywords: ['self', 'check-in', 'checkin', 'keypad', 'keyless', 'smart lock', 'code'], svg: s('<rect x="5" y="2" width="14" height="20" rx="7"/><circle cx="12" cy="14" r="1.5"/><line x1="12" y1="14" x2="12" y2="10"/>') },
  { id: 'luggage_drop', name: 'Luggage Storage', category: 'Services', keywords: ['luggage', 'storage', 'baggage', 'drop', 'off', 'suitcase'], svg: s('<rect x="5" y="4" width="14" height="16" rx="2"/><path d="M9 4V2h6v2"/><line x1="5" y1="10" x2="19" y2="10"/><circle cx="12" cy="14" r="2"/>') },
  { id: 'long_term', name: 'Long-term Stays', category: 'Services', keywords: ['long', 'term', 'stay', 'allowed', 'month', 'monthly', 'extended'], svg: s('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>') },
  { id: 'breakfast', name: 'Breakfast', category: 'Services', keywords: ['breakfast', 'morning', 'meal', 'brunch', 'food'], svg: s('<circle cx="12" cy="14" r="7"/><path d="M12 7v-5"/><path d="M9 3h6"/><circle cx="12" cy="14" r="3"/>') },
  { id: 'cleaning', name: 'Cleaning', category: 'Services', keywords: ['cleaning', 'housekeeping', 'maid', 'service', 'clean'], svg: s('<path d="M12 2L9 12h6L12 2z"/><line x1="12" y1="12" x2="12" y2="22"/><path d="M8 22h8"/>') },
  { id: 'host_greeting', name: 'Host Greeting', category: 'Services', keywords: ['host', 'greeting', 'welcome', 'meet', 'person', 'in-person'], svg: s('<path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/>') },
  { id: 'pets_allowed', name: 'Pets Allowed', category: 'Services', keywords: ['pet', 'pets', 'dog', 'cat', 'animal', 'furry', 'friend', 'friendly'], svg: s('<path d="M10 5a2 2 0 11-4 0 2 2 0 014 0M18 5a2 2 0 11-4 0 2 2 0 014 0M6 12a2 2 0 11-4 0 2 2 0 014 0M22 12a2 2 0 11-4 0 2 2 0 014 0"/><path d="M12 16c-2 0-4-2-4-4 0-1.5 2-3 4-3s4 1.5 4 3c0 2-2 4-4 4z"/><path d="M12 16v4"/>') },

  // ===================== Accessibility =====================
  { id: 'wheelchair', name: 'Wheelchair Access', category: 'Accessibility', keywords: ['wheelchair', 'accessible', 'accessibility', 'handicap', 'disabled', 'ada', 'step-free'], svg: s('<circle cx="10" cy="5" r="2"/><path d="M10 7v5l4 3"/><path d="M14 15a5 5 0 11-8-3"/><path d="M14 15h4l1 4"/>') },
  { id: 'wide_door', name: 'Wide Doorway', category: 'Accessibility', keywords: ['wide', 'door', 'doorway', 'entrance', 'hallway', 'clearance'], svg: s('<line x1="5" y1="2" x2="5" y2="22"/><line x1="19" y1="2" x2="19" y2="22"/><path d="M5 12h14"/><path d="M8 4h8"/><path d="M8 20h8"/>') },
];

/**
 * Search icons by query string, returning best matches.
 * Matches against name, keywords, and category.
 */
export function findBestIcons(query: string, limit = 12): AmenityIcon[] {
  if (!query.trim()) return AMENITY_ICONS.slice(0, limit);

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

  const scored = AMENITY_ICONS.map(icon => {
    const haystack = [
      icon.name.toLowerCase(),
      icon.category.toLowerCase(),
      ...icon.keywords.map(k => k.toLowerCase()),
    ].join(' ');

    let score = 0;
    for (const term of terms) {
      // Exact keyword match = 3 points
      if (icon.keywords.some(k => k.toLowerCase() === term)) score += 3;
      // Name contains term = 2 points
      else if (icon.name.toLowerCase().includes(term)) score += 2;
      // Any keyword/category partial match = 1 point
      else if (haystack.includes(term)) score += 1;
    }

    return { icon, score };
  });

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => s.icon);
}

/** Get all unique categories */
export function getIconCategories(): string[] {
  return [...new Set(AMENITY_ICONS.map(i => i.category))];
}
