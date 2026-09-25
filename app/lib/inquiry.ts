/**
 * Inquiries: where one came from and what it is about.
 *
 * The one definition read by every party to a submission — the pages that
 * link into /contact, the contact page and form, the contact route that
 * validates and stores it, and the admin inbox that classifies it — so the
 * values each side uses cannot drift apart.
 *
 * Client-safe: no server imports.
 */

// ─── Source ────────────────────────────────────────────────────

/**
 * How the visitor reached the contact form, recorded on every submission as
 * `source`. It comes from the link they followed, never from what they typed:
 *
 *   property  "Request these dates" on a listing, which carries the property
 *   partner   a link on /about/partners
 *   fund      a link on /fund
 *   general   anything else: the site nav, a bookmark, a search result
 */
export const INQUIRY_SOURCES = ['property', 'partner', 'fund', 'general'] as const;
export type InquirySource = (typeof INQUIRY_SOURCES)[number];

export function isInquirySource(value: unknown): value is InquirySource {
  return typeof value === 'string' && (INQUIRY_SOURCES as readonly string[]).includes(value);
}

/** The sources a page states by linking to `/contact?from=<source>`. */
type LinkedSource = 'partner' | 'fund';

const FROM_PARAM = 'from';

/**
 * Where a page's links into the contact form point, so the form knows the way
 * in. Give those links `prefetch={false}`: /contact renders per request, so
 * each prefetch is a function call on every view of the linking page, and a
 * search parameter makes Next prefetch the bare route as well — three calls
 * per view where the plain link cost two.
 */
export function contactHref(source: LinkedSource): string {
  return `/contact?${FROM_PARAM}=${source}`;
}

/**
 * The source a contact-page URL states. A property arrival is recognised by
 * its stay parameters instead (see parseInquiryOrigin), so only the linked
 * sources are read here; anything else is a general visit.
 */
export function sourceFromParams(
  params: Record<string, string | string[] | undefined>,
): InquirySource {
  const raw = params[FROM_PARAM];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === 'partner' || value === 'fund' ? value : 'general';
}

// ─── Subject ───────────────────────────────────────────────────

const SUBJECT_BOOKING = "I'm looking to book";
const SUBJECT_LISTING = 'I want to list my property';
const SUBJECT_FUND = "I'm interested in the Fund";
const SUBJECT_GENERAL = 'General enquiry';

/** The subjects the contact form offers, and the only ones the contact route accepts. */
export const INQUIRY_SUBJECTS = [
  SUBJECT_BOOKING,
  SUBJECT_LISTING,
  SUBJECT_FUND,
  SUBJECT_GENERAL,
] as const;
export type InquirySubject = (typeof INQUIRY_SUBJECTS)[number];

/** The subject each way in starts with. The visitor can still change it. */
export const DEFAULT_SUBJECT: Record<InquirySource, InquirySubject> = {
  property: SUBJECT_BOOKING,
  partner: SUBJECT_LISTING,
  fund: SUBJECT_FUND,
  general: SUBJECT_BOOKING,
};

// ─── Classifying a stored submission ───────────────────────────

/** A stored submission's source, or `unknown` when nothing on it says. */
export type ClassifiedSource = InquirySource | 'unknown';

export interface SourceFinding {
  source: ClassifiedSource;
  /** What on the document the source was read from, for the operator. */
  basis: string;
}

const RECORDED_BASIS: Record<InquirySource, string> = {
  property: 'Recorded when it was sent: the visitor came from a listing’s “Request these dates”.',
  partner: 'Recorded when it was sent: the visitor came from the partner page.',
  fund: 'Recorded when it was sent: the visitor came from the Fund page.',
  general:
    'Recorded when it was sent: the visitor came to the contact form directly, not from a listing, the partner page or the Fund page.',
};

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * The source of a stored submission.
 *
 * A submission sent since sources were recorded carries its own `source`, and
 * that wins. One sent before carries none, so the closest source is read from
 * what it does hold, and the message is never searched for hints:
 *
 *   property  its stay fields name a property
 *   partner   its subject is "I want to list my property"
 *   fund      its subject is "I'm interested in the Fund"
 *   general   its subject is "General enquiry", or "I'm looking to book"
 *             without a property named
 *   unknown   anything else
 */
export function classifySource(fields: Record<string, unknown>): SourceFinding {
  if (isInquirySource(fields.source)) {
    return { source: fields.source, basis: RECORDED_BASIS[fields.source] };
  }

  // A `source` the form never writes is reported, not hidden, and not trusted.
  const lead =
    fields.source === undefined || fields.source === null
      ? 'No source was recorded; '
      : `Its stored source, ${JSON.stringify(fields.source)}, is not one the contact form writes, so it was read from the rest: `;

  const stay = fields.stay;
  if (
    stay &&
    typeof stay === 'object' &&
    !Array.isArray(stay) &&
    (hasText((stay as Record<string, unknown>).propertyId) ||
      hasText((stay as Record<string, unknown>).propertyName))
  ) {
    return { source: 'property', basis: `${lead}its stay fields name a property.` };
  }

  switch (fields.subject) {
    case SUBJECT_LISTING:
      return { source: 'partner', basis: `${lead}its subject is “${SUBJECT_LISTING}”.` };
    case SUBJECT_FUND:
      return { source: 'fund', basis: `${lead}its subject is “${SUBJECT_FUND}”.` };
    case SUBJECT_GENERAL:
      return { source: 'general', basis: `${lead}its subject is “${SUBJECT_GENERAL}”.` };
    case SUBJECT_BOOKING:
      return {
        source: 'general',
        basis: `${lead}its subject is “${SUBJECT_BOOKING}”, but it names no property.`,
      };
  }

  return {
    source: 'unknown',
    basis:
      fields.subject === undefined || fields.subject === null
        ? `${lead}it has no subject and names no property.`
        : `${lead}its subject is not one the contact form offers, and it names no property.`,
  };
}
