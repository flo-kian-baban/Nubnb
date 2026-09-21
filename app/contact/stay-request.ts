/**
 * The structured shape of a dates request, shared by the contact page, the
 * contact form and the API route.
 *
 * It exists so that an enquiry about a specific property on specific dates is
 * stored as fields rather than as a sentence someone has to read and retype.
 * Every field is optional in the URL and validated again on the server; a
 * request that is missing a property or either date is not a stay request and
 * the contact form falls back to its ordinary self.
 */

export interface StayRequest {
  propertyId: string;
  propertyName: string;
  /** ISO yyyy-mm-dd */
  checkIn: string;
  /** ISO yyyy-mm-dd */
  checkOut: string;
  guests: number;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A plain-string search-param bag, as a Next page receives it. */
type Params = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

/**
 * Build a StayRequest from query parameters, or null if they do not describe
 * one. Nothing here trusts the URL: lengths are capped and the dates must be
 * ISO and in order, because these values are rendered back to the visitor.
 */
export function parseStayRequest(params: Params): StayRequest | null {
  const propertyId = one(params.propertyId).slice(0, 200);
  const propertyName = one(params.property).slice(0, 200);
  const checkIn = one(params.checkIn);
  const checkOut = one(params.checkOut);

  if (!propertyId || !propertyName) return null;
  if (!ISO_DATE.test(checkIn) || !ISO_DATE.test(checkOut)) return null;
  if (checkIn >= checkOut) return null;

  const parsed = Number.parseInt(one(params.guests), 10);
  const guests = Number.isFinite(parsed) ? Math.min(50, Math.max(1, parsed)) : 1;

  return { propertyId, propertyName, checkIn, checkOut, guests };
}
