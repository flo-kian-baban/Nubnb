/**
 * Leads: the admin inbox's reading of `contact_submissions`.
 *
 * Client-safe: no server imports. The API routes use it to build the inbox
 * rows and the admin pages use it to filter, search and render them, so both
 * sides read a document — and derive its source — the same way.
 *
 * Two document shapes exist, and neither is assumed:
 *   before dispatch 10  name, email, subject, message, status, createdAt
 *   since               the same, plus `stay` on a dates request:
 *                       { propertyId, propertyName, checkIn, checkOut, guests }
 * app/api/contact/route.ts is the only writer. Every field is read
 * defensively: one that is not on the document is reported as absent, never
 * filled in, and one this module does not know is still shown (`otherFields`).
 */

// ─── Status ────────────────────────────────────────────────────

/** The three states an operator can put a lead in. The contact form writes "new". */
export const LEAD_STATUSES = ['new', 'answered', 'closed'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
  new: 'New',
  answered: 'Answered',
  closed: 'Closed',
};

export function isLeadStatus(value: unknown): value is LeadStatus {
  return typeof value === 'string' && (LEAD_STATUSES as readonly string[]).includes(value);
}

// ─── Source ────────────────────────────────────────────────────

export const LEAD_SOURCES = ['stay', 'partner', 'fund', 'general', 'unknown'] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export const LEAD_SOURCE_LABELS: Record<LeadSource, string> = {
  stay: 'Stay request',
  partner: 'Partner inquiry',
  fund: 'Fund inquiry',
  general: 'General message',
  unknown: 'Unknown',
};

export function isLeadSource(value: unknown): value is LeadSource {
  return typeof value === 'string' && (LEAD_SOURCES as readonly string[]).includes(value);
}

/**
 * Whether anything stored today can produce this source. `fund` cannot — see
 * `deriveSource` — and the inbox says so rather than offer a filter that can
 * only ever come back empty.
 */
export function isRecordedSource(source: LeadSource): boolean {
  return source !== 'fund';
}

/**
 * The subjects the contact form offers. Copied from the form's schema in
 * app/api/contact/route.ts, which stays the source of truth; the form is out
 * of scope here. A subject outside this list is not guessed at.
 */
const SUBJECT_BOOKING = "I'm looking to book";
const SUBJECT_LISTING = 'I want to list my property';
const SUBJECT_GENERAL = 'General enquiry';

export interface SourceFinding {
  source: LeadSource;
  /** What on the document the source was read from, for the operator. */
  basis: string;
}

/**
 * Where a lead came from, read only from what the document holds:
 *
 *   stay     its stay fields name a property
 *   partner  the subject is "I want to list my property"
 *   general  the subject is "General enquiry", or "I'm looking to book"
 *            without a property named
 *   unknown  anything else
 *
 * `fund` is never returned. /fund links to the plain contact form, which has
 * no Fund subject and records no origin, so a Fund inquiry is stored under
 * whichever subject its sender picked and nothing on it says it came from the
 * Fund page. The message text is not searched for hints: that would be a
 * guess, and "unknown" is an acceptable answer.
 */
export function deriveSource(fields: LeadFields): SourceFinding {
  const stay = stayOf(fields);
  if (stay && (hasText(stay.propertyId) || hasText(stay.propertyName))) {
    return { source: 'stay', basis: 'Its stay fields name a property.' };
  }

  switch (fields.subject) {
    case SUBJECT_LISTING:
      return { source: 'partner', basis: `Its subject is “${SUBJECT_LISTING}”.` };
    case SUBJECT_GENERAL:
      return { source: 'general', basis: `Its subject is “${SUBJECT_GENERAL}”.` };
    case SUBJECT_BOOKING:
      return {
        source: 'general',
        basis: `Its subject is “${SUBJECT_BOOKING}”, but it names no property.`,
      };
  }

  return {
    source: 'unknown',
    basis:
      fields.subject === undefined || fields.subject === null
        ? 'It has no subject and names no property.'
        : 'Its subject is not one the contact form offers, and it names no property.',
  };
}

// ─── Shapes ────────────────────────────────────────────────────

/** A document's fields as the API returns them: as stored, Timestamps as ISO strings. */
export type LeadFields = Record<string, unknown>;

/** One inbox row. Strings are as stored; null means the field is not on the document. */
export interface LeadSummary {
  id: string;
  name: string | null;
  email: string | null;
  subject: string | null;
  createdAt: string | null;
  /** As stored: possibly outside LEAD_STATUSES. */
  status: string | null;
  source: LeadSource;
  /** Only a stay request names a property. */
  propertyName: string | null;
  propertyId: string | null;
}

/** The live listing a stay request names, looked up by ID when the lead is opened. */
export type PropertyLink =
  /** `href` is null only for a listing with no name, which has no public URL. */
  | { state: 'found'; name: string; href: string | null }
  /** No property has this ID now. */
  | { state: 'missing' }
  /** The lookup failed. The lead itself still loaded. */
  | { state: 'unreadable' };

/** One lead in full: every field on the document. */
export interface LeadDetail {
  id: string;
  fields: LeadFields;
  /** null when the document names no property ID. */
  property: PropertyLink | null;
}

/** What a status change wrote — and all it wrote. */
export interface LeadStatusChange {
  id: string;
  status: LeadStatus;
  statusChangedAt: string;
}

// ─── Reading fields ────────────────────────────────────────────

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * A field as text. null when it is absent. A value that is not a string is
 * written out rather than dropped, so a malformed field is still visible.
 */
export function fieldText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** The `stay` map, when the document has one. */
export function stayOf(fields: LeadFields): Record<string, unknown> | null {
  const stay = fields.stay;
  return stay && typeof stay === 'object' && !Array.isArray(stay)
    ? (stay as Record<string, unknown>)
    : null;
}

const KNOWN_FIELDS = new Set([
  'name',
  'email',
  'subject',
  'message',
  'status',
  'createdAt',
  'statusChangedAt',
  'stay',
]);

const KNOWN_STAY_FIELDS = new Set(['propertyId', 'propertyName', 'checkIn', 'checkOut', 'guests']);

/**
 * Every field the inbox has no place for, so that nothing on a document goes
 * unshown. Stay fields are prefixed `stay.`; a `stay` that is not a map is
 * returned whole.
 */
export function otherFields(fields: LeadFields): [string, unknown][] {
  const others: [string, unknown][] = Object.entries(fields).filter(
    ([key]) => !KNOWN_FIELDS.has(key),
  );

  const stay = stayOf(fields);
  if (stay) {
    for (const [key, value] of Object.entries(stay)) {
      if (!KNOWN_STAY_FIELDS.has(key)) others.push([`stay.${key}`, value]);
    }
  } else if (fields.stay !== undefined) {
    others.push(['stay', fields.stay]);
  }

  return others;
}

export function toLeadSummary(id: string, fields: LeadFields): LeadSummary {
  const stay = stayOf(fields);
  return {
    id,
    name: fieldText(fields.name),
    email: fieldText(fields.email),
    subject: fieldText(fields.subject),
    createdAt: fieldText(fields.createdAt),
    status: fieldText(fields.status),
    source: deriveSource(fields).source,
    propertyName: stay ? fieldText(stay.propertyName) : null,
    propertyId: stay ? fieldText(stay.propertyId) : null,
  };
}

/** Search by name, email or property — the property's name or its ID. */
export function matchesLeadSearch(lead: LeadSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [lead.name, lead.email, lead.propertyName, lead.propertyId].some((value) =>
    value?.toLowerCase().includes(q),
  );
}
