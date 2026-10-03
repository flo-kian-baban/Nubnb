/**
 * Property data access layer, for the admin.
 *
 * READ and WRITE operations both call authenticated server-side API routes
 * that use the Firebase Admin SDK. The browser no longer reads Firestore
 * (dispatch 24): the rules refuse a browser that lists `properties`, so that
 * an unlisted property is unreadable by the public, and an admin's browser
 * looks like anyone's to them. The public pages read on the server
 * (server-properties.ts).
 *
 * Authentication is handled automatically via the HTTP-only session cookie
 * set by /api/admin-auth. No headers or client-side tokens needed.
 *
 * Error contract: the write helpers used to catch their own throws and return
 * `null`/`false`, which discarded the API's HTTP status and its field-level
 * `issues` array. They now return a discriminated `MutationResult` so the
 * caller can tell *why* a write failed and show it against the right field.
 */

import type { PropertyManagementView } from '@/app/lib/reports/model';
import { Property } from '@/app/types/property';

// ─── Result types ──────────────────────────────────────────────

/** One field-level validation problem, as returned by the API's 422 responses. */
export interface MutationIssue {
  /** Dotted path into the payload, e.g. `guests`, `priceInfo.nightly`. */
  path: string;
  message: string;
}

export type MutationResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      /** HTTP status, or 0 when the request never reached the server. */
      status: number;
      error: string;
      issues: MutationIssue[];
    };

export type ReadResult<T> = { ok: true; data: T } | { ok: false; error: string };

// ─── Internal ──────────────────────────────────────────────────

/** Parse a JSON body without throwing on an empty or non-JSON response. */
async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Turn a non-2xx response into a structured failure, preserving `issues`. */
async function toFailure(res: Response, fallback: string): Promise<Extract<MutationResult<never>, { ok: false }>> {
  const body = await readJson(res);
  const rawIssues = Array.isArray(body.issues) ? body.issues : [];
  const issues: MutationIssue[] = rawIssues
    .filter((i): i is { path: unknown; message: unknown } => !!i && typeof i === 'object')
    .map((i) => ({ path: String(i.path ?? ''), message: String(i.message ?? '') }))
    .filter((i) => i.message.length > 0);

  return {
    ok: false,
    status: res.status,
    error: typeof body.error === 'string' && body.error ? body.error : fallback,
    issues,
  };
}

/** A request that never reached the server (offline, DNS, CORS, abort). */
function networkFailure(error: unknown, fallback: string): Extract<MutationResult<never>, { ok: false }> {
  return {
    ok: false,
    status: 0,
    error: error instanceof Error ? `${fallback}: ${error.message}` : fallback,
    issues: [],
  };
}

// ─── READ (the admin route, Admin SDK) ─────────────────────────

/** Every property as stored, and which of them are unlisted (beside them: never a field the form could send back). */
export interface AdminProperties {
  properties: Property[];
  unlistedIds: Set<string>;
}

/**
 * Read every property, distinguishing a failed read from an empty collection,
 * for the admin, where "the backend is down" and "there is nothing here" must
 * not look the same.
 */
export async function getPropertiesResult(): Promise<ReadResult<AdminProperties>> {
  let res: Response;
  try {
    res = await fetch('/api/admin/properties', { cache: 'no-store' });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not reach the server.' };
  }
  const body = await res.json().catch(() => ({}));
  const data = body && typeof body === 'object' ? (body as { data?: { properties?: unknown; unlistedIds?: unknown } }).data : undefined;
  if (!res.ok || !data || !Array.isArray(data.properties) || !Array.isArray(data.unlistedIds)) {
    const said = body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : null;
    return { ok: false, error: said ?? `Could not load the properties (HTTP ${res.status}).` };
  }
  return { ok: true, data: { properties: data.properties as Property[], unlistedIds: new Set(data.unlistedIds.filter((id): id is string => typeof id === 'string')) } };
}

// ─── WRITE (server-side API routes via Admin SDK) ──────────────
// Session cookie is sent automatically with same-origin fetch requests.

export async function addProperty(
  property: Omit<Property, 'id'>,
  options: { unlisted?: boolean } = {},
): Promise<MutationResult<{ id: string }>> {
  let res: Response;
  try {
    // Unlisted from the start (dispatch 24): the route writes the property and its mark in one batch.
    res = await fetch(options.unlisted ? '/api/properties?unlisted=1' : '/api/properties', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(property),
    });
  } catch (error) {
    return networkFailure(error, 'Could not reach the server to create the property');
  }

  if (!res.ok) return toFailure(res, 'Failed to create property');

  const body = await readJson(res);
  const data = body.data as { id?: string } | undefined;
  if (!data?.id) {
    return { ok: false, status: res.status, error: 'The server accepted the write but returned no property ID.', issues: [] };
  }
  return { ok: true, data: { id: data.id } };
}

export async function updateProperty(
  id: string,
  property: Partial<Property>,
): Promise<MutationResult<{ id: string }>> {
  let res: Response;
  try {
    res = await fetch(`/api/properties/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(property),
    });
  } catch (error) {
    return networkFailure(error, 'Could not reach the server to update the property');
  }

  if (!res.ok) return toFailure(res, 'Failed to update property');

  return { ok: true, data: { id } };
}

// ─── The name cleaners see (dispatch 21) ────────────────────────
// Its own server-only collection, reached through the admin routes below:
// never a field on the property document, which is world-readable.

/** The property's cleaner-facing name, or null when it has none. */
export async function getCleanerFacingName(id: string): Promise<ReadResult<string | null>> {
  let res: Response;
  try {
    res = await fetch(`/api/admin/properties/${encodeURIComponent(id)}/cleaner-name`, { cache: 'no-store' });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not reach the server.' };
  }
  const body = await res.json().catch(() => ({}));
  const data = body && typeof body === 'object' ? (body as { data?: { name?: unknown } }).data : undefined;
  if (!res.ok || !data || (data.name !== null && typeof data.name !== 'string')) {
    return { ok: false, error: `Could not read the name cleaners see (HTTP ${res.status}).` };
  }
  return { ok: true, data: data.name as string | null };
}

/** Set the property's cleaner-facing name; an empty string or null clears it. */
/** The property's statements record (dispatch 23B; "Report For" since 23E), from its own route; null when it has none. */
export async function getManagement(id: string): Promise<ReadResult<PropertyManagementView | null>> {
  let res: Response;
  try {
    res = await fetch(`/api/admin/properties/${encodeURIComponent(id)}/management`, { cache: 'no-store' });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not reach the server.' };
  }
  const body = await res.json().catch(() => ({}));
  const data = body && typeof body === 'object' ? (body as { data?: { record?: unknown } }).data : undefined;
  if (!res.ok || !data || (data.record !== null && (typeof data.record !== 'object' || !Array.isArray((data.record as { owners?: unknown }).owners)))) {
    return { ok: false, error: `Could not read the statements record (HTTP ${res.status}).` };
  }
  return { ok: true, data: data.record as PropertyManagementView | null };
}

/** Set the statements record whole, or clear it with null. */
export async function setManagement(id: string, record: ManagementPayload | null): Promise<MutationResult<{ record: PropertyManagementView | null }>> {
  let res: Response;
  try {
    res = await fetch(`/api/admin/properties/${encodeURIComponent(id)}/management`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
    });
  } catch (error) {
    return networkFailure(error, 'Could not reach the server to save the statements record');
  }
  if (!res.ok) return toFailure(res, 'Failed to save the statements record');
  const body = await res.json().catch(() => ({}));
  const stored = body && typeof body === 'object' ? (body as { data?: { record?: unknown } }).data?.record : undefined;
  return { ok: true, data: { record: stored && typeof stored === 'object' ? (stored as PropertyManagementView) : null } };
}

/** The record as the form saves it: the rate as typed, "20"; the legacy default fee sent back as loaded, "150.00". */
export interface ManagementPayload {
  reportFor: { name: string; address: string } | null;
  owners: { name: string; email: string | null }[];
  statementsFrom: string;
  statementsUntil: string | null;
  defaultFeeRate: string | null;
  defaultFee?: { label: string; amount: string } | null;
  /** Excluded from reporting (dispatch 24). Always sent, so unticking it clears what is stored. */
  excludedFromReporting: boolean;
}

// ─── Unlisted (dispatch 24) ────────────────────────────────────
// Its own server-only collection, reached through the admin route below:
// never a field on the property document.

/** Unlist the property, or list it again. */
export async function setUnlisted(id: string, unlisted: boolean): Promise<MutationResult<{ unlisted: boolean }>> {
  let res: Response;
  try {
    res = await fetch(`/api/admin/properties/${encodeURIComponent(id)}/visibility`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unlisted }),
    });
  } catch (error) {
    return networkFailure(error, 'Could not reach the server to save whether the property is listed');
  }
  if (!res.ok) return toFailure(res, 'Failed to save whether the property is listed');
  const body = await res.json().catch(() => ({}));
  const stored = body && typeof body === 'object' ? (body as { data?: { unlisted?: unknown } }).data?.unlisted : undefined;
  return { ok: true, data: { unlisted: stored === true } };
}

export async function setCleanerFacingName(id: string, name: string | null): Promise<MutationResult<{ name: string | null }>> {
  let res: Response;
  try {
    res = await fetch(`/api/admin/properties/${encodeURIComponent(id)}/cleaner-name`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
  } catch (error) {
    return networkFailure(error, 'Could not reach the server to save the name cleaners see');
  }
  if (!res.ok) return toFailure(res, 'Failed to save the name cleaners see');
  const body = await res.json().catch(() => ({}));
  const stored = body && typeof body === 'object' ? (body as { data?: { name?: unknown } }).data?.name : undefined;
  return { ok: true, data: { name: typeof stored === 'string' ? stored : null } };
}

export async function deleteProperty(id: string): Promise<MutationResult<{ id: string }>> {
  let res: Response;
  try {
    res = await fetch(`/api/properties/${id}`, { method: 'DELETE' });
  } catch (error) {
    return networkFailure(error, 'Could not reach the server to delete the property');
  }

  if (!res.ok) return toFailure(res, 'Failed to delete property');

  return { ok: true, data: { id } };
}
