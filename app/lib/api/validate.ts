/**
 * Zero-dependency input validators for API routes.
 * All validators return { valid, error?, value? } — never throw.
 */

interface ValidationResult<T = string> {
  valid: boolean;
  error?: string;
  value?: T;
}

// ─── String ───────────────────────────────────────────────

export function validateString(
  input: unknown,
  maxLength: number = 2048,
  fieldName: string = 'input',
): ValidationResult {
  if (typeof input !== 'string') {
    return { valid: false, error: `${fieldName} must be a string` };
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: `${fieldName} is required` };
  }
  if (trimmed.length > maxLength) {
    return { valid: false, error: `${fieldName} exceeds maximum length of ${maxLength} characters` };
  }
  return { valid: true, value: trimmed };
}

// ─── URL (generic) ────────────────────────────────────────

export function validateUrl(
  input: unknown,
  fieldName: string = 'url',
): ValidationResult {
  const str = validateString(input, 2048, fieldName);
  if (!str.valid) return str;

  let parsed: URL;
  try {
    parsed = new URL(str.value!);
  } catch {
    return { valid: false, error: `${fieldName} is not a valid URL` };
  }

  // Only allow http/https
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { valid: false, error: `${fieldName} must use HTTPS or HTTP protocol` };
  }

  return { valid: true, value: str.value };
}

// ─── Airbnb URL ───────────────────────────────────────────

const AIRBNB_DOMAINS = ['airbnb.com', 'airbnb.co.uk', 'airbnb.ca', 'airbnb.com.au', 'airbnb.co.in', 'airbnb.de', 'airbnb.fr', 'airbnb.es', 'airbnb.it', 'airbnb.co.jp', 'airbnb.co.kr', 'airbnb.co.nz', 'airbnb.pt', 'airbnb.nl', 'airbnb.se', 'airbnb.no', 'airbnb.dk', 'airbnb.fi', 'airbnb.be', 'airbnb.at', 'airbnb.ch', 'airbnb.ie', 'airbnb.pl', 'airbnb.cz', 'airbnb.ru', 'airbnb.com.br', 'airbnb.mx', 'airbnb.com.ar', 'airbnb.cl', 'airbnb.co'];

export function validateAirbnbUrl(input: unknown): ValidationResult {
  const urlResult = validateUrl(input, 'Airbnb URL');
  if (!urlResult.valid) return urlResult;

  let parsed: URL;
  try {
    parsed = new URL(urlResult.value!);
  } catch {
    return { valid: false, error: 'Airbnb URL is not a valid URL' };
  }

  // Must be HTTPS for Airbnb
  if (parsed.protocol !== 'https:') {
    return { valid: false, error: 'Airbnb URL must use HTTPS' };
  }

  const hostname = parsed.hostname.replace(/^www\./, '');
  const isAirbnb = AIRBNB_DOMAINS.some((domain) => hostname === domain || hostname.endsWith('.' + domain));

  if (!isAirbnb) {
    return { valid: false, error: 'URL must be from an Airbnb domain' };
  }

  // Must contain /rooms/ path to be a listing
  if (!parsed.pathname.includes('/rooms/')) {
    return { valid: false, error: 'URL must be an Airbnb listing URL (containing /rooms/)' };
  }

  return { valid: true, value: urlResult.value };
}

// ─── iCal URL ─────────────────────────────────────────────

const ICAL_ALLOWED_HOSTS = [
  'airbnb.com', 'airbnb.co',
  'vrbo.com', 'homeaway.com',
  'booking.com',
  'calendar.google.com',
  'p.icloud.com', 'caldav.icloud.com',
  'outlook.live.com', 'outlook.office365.com',
  'tripadvisor.com',
  'lodgify.com', 'guesty.com', 'hospitable.com',
  'icalendar.net',
];

export function validateIcalUrl(input: unknown): ValidationResult {
  const urlResult = validateUrl(input, 'iCal URL');
  if (!urlResult.valid) return urlResult;

  let parsed: URL;
  try {
    parsed = new URL(urlResult.value!);
  } catch {
    return { valid: false, error: 'iCal URL is not a valid URL' };
  }

  if (parsed.protocol !== 'https:') {
    return { valid: false, error: 'iCal URL must use HTTPS' };
  }

  const hostname = parsed.hostname.replace(/^www\./, '');

  // Check against allowlist or .ics extension
  const isAllowed =
    ICAL_ALLOWED_HOSTS.some((h) => hostname === h || hostname.endsWith('.' + h)) ||
    parsed.pathname.endsWith('.ics');

  if (!isAllowed) {
    return { valid: false, error: 'iCal URL must be from a recognized calendar provider or end in .ics' };
  }

  return { valid: true, value: urlResult.value };
}

// ─── Google Maps URL ──────────────────────────────────────

const GMAPS_DOMAINS = ['google.com', 'google.co', 'goo.gl', 'maps.app.goo.gl'];

export function validateGoogleMapsUrl(input: unknown): ValidationResult {
  const urlResult = validateUrl(input, 'Google Maps URL');
  if (!urlResult.valid) return urlResult;

  let parsed: URL;
  try {
    parsed = new URL(urlResult.value!);
  } catch {
    return { valid: false, error: 'Google Maps URL is not a valid URL' };
  }

  const hostname = parsed.hostname.replace(/^www\./, '');
  const isGoogle = GMAPS_DOMAINS.some((d) => hostname === d || hostname.endsWith('.' + d));

  if (!isGoogle) {
    return { valid: false, error: 'URL must be from Google Maps' };
  }

  return { valid: true, value: urlResult.value };
}

// ─── Date string ──────────────────────────────────────────

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validateDateString(
  input: unknown,
  fieldName: string = 'date',
): ValidationResult {
  const str = validateString(input, 10, fieldName);
  if (!str.valid) return str;

  if (!ISO_DATE_RE.test(str.value!)) {
    return { valid: false, error: `${fieldName} must be in YYYY-MM-DD format` };
  }

  const parsed = new Date(str.value! + 'T00:00:00Z');
  if (isNaN(parsed.getTime())) {
    return { valid: false, error: `${fieldName} is not a valid date` };
  }

  // Reject dates more than 2 years in the future
  const maxDate = new Date();
  maxDate.setFullYear(maxDate.getFullYear() + 2);
  if (parsed > maxDate) {
    return { valid: false, error: `${fieldName} is too far in the future (max 2 years)` };
  }

  return { valid: true, value: str.value };
}
