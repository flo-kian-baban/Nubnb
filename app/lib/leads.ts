/**
 * Leads: the admin inbox's reading of `contact_submissions`.
 *
 * Client-safe: no server imports. The API routes use it to build the inbox
 * rows and the admin pages use it to filter, search and render them, so both
 * sides read a document — and derive its source — the same way.
 *
 * Three document shapes exist, and none is assumed:
 *   before dispatch 10  name, email, subject, message, status, createdAt
 *   dispatch 10         the same, plus `stay` on a dates request:
 *                       { propertyId, propertyName, checkIn, checkOut, guests }
 *   dispatch 15         the same, plus `source` (how the visitor reached the
 *                       form) and `notification` (whether the team was told)
 * app/api/contact/route.ts is the only writer. Every field is read
 * defensively: one that is not on the document is reported as absent, never
 * filled in, and one this module does not know is still shown (`otherFields`).
 */

import {
  INQUIRY_SOURCES,
  classifySource,
  type ClassifiedSource,
} from '@/app/lib/inquiry';

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
// The values and the classifier live in app/lib/inquiry.ts, beside the
// contact form and route that write them, so they cannot drift apart.

export const LEAD_SOURCES = [...INQUIRY_SOURCES, 'unknown'] as const;
export type LeadSource = ClassifiedSource;

export const LEAD_SOURCE_LABELS: Record<LeadSource, string> = {
  property: 'Stay request',
  partner: 'Partner inquiry',
  fund: 'Fund inquiry',
  general: 'General message',
  unknown: 'Unknown',
};

export function isLeadSource(value: unknown): value is LeadSource {
  return typeof value === 'string' && (LEAD_SOURCES as readonly string[]).includes(value);
}

// ─── Notification ──────────────────────────────────────────────

/**
 * Whether the team was emailed about a lead, as the contact route recorded
 * it in `notification`:
 *
 *   sent        the mail server accepted the email
 *   failed      the email was not sent: nobody was told
 *   pending     the outcome was never recorded, so nobody can say anyone was
 *   unexpected  `notification` holds something the route never writes
 *   unrecorded  the lead predates notification tracking — not a failure,
 *               just not known
 */
export type NotificationState = 'sent' | 'failed' | 'pending' | 'unexpected' | 'unrecorded';

export interface NotificationRecord {
  state: NotificationState;
  /** When the outcome was recorded. */
  at: string | null;
  /** The mail server's reply on success, the reason on failure, the raw value when unexpected. */
  detail: string | null;
}

export function notificationOf(fields: LeadFields): NotificationRecord {
  const n = fields.notification;
  if (n === undefined) return { state: 'unrecorded', at: null, detail: null };
  if (!n || typeof n !== 'object' || Array.isArray(n)) {
    return { state: 'unexpected', at: null, detail: JSON.stringify(n) };
  }

  const record = n as Record<string, unknown>;
  const at = typeof record.at === 'string' ? record.at : null;
  switch (record.status) {
    case 'sent':
      return { state: 'sent', at, detail: fieldText(record.response) };
    case 'failed':
      return { state: 'failed', at, detail: fieldText(record.error) };
    case 'pending':
      return { state: 'pending', at, detail: null };
  }
  return { state: 'unexpected', at, detail: JSON.stringify(n) };
}

/** A lead the team may never have heard about. */
export function mayBeUnnotified(state: NotificationState): boolean {
  return state === 'failed' || state === 'pending' || state === 'unexpected';
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
  notification: NotificationState;
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
  'source',
  'notification',
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
    source: classifySource(fields).source,
    propertyName: stay ? fieldText(stay.propertyName) : null,
    propertyId: stay ? fieldText(stay.propertyId) : null,
    notification: notificationOf(fields).state,
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
