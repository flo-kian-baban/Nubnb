/**
 * Property data access layer.
 *
 * READ operations use the client Firestore SDK (public data, no auth required).
 * WRITE operations call authenticated server-side API routes that use the
 * Firebase Admin SDK — the client SDK never writes to Firestore.
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
import { collection, doc, getDocs, getDoc, query } from 'firebase/firestore';
import { db, isFirebaseConfigured } from './config';
import { Property } from '@/app/types/property';

const COLLECTION_NAME = 'properties';

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

// ─── READ (client SDK — public data) ───────────────────────────

/**
 * Read every property, distinguishing a failed read from an empty collection.
 * Prefer this in the admin, where "the backend is down" and "there is nothing
 * here" must not look the same.
 */
export async function getPropertiesResult(): Promise<ReadResult<Property[]>> {
  if (!isFirebaseConfigured() || !db) {
    return { ok: false, error: 'Firebase is not configured — the property database is unreachable.' };
  }
  try {
    const q = query(collection(db, COLLECTION_NAME));
    const querySnapshot = await getDocs(q);
    const properties: Property[] = [];
    querySnapshot.forEach((docSnap) => {
      properties.push({ id: docSnap.id, ...docSnap.data() } as Property);
    });
    return { ok: true, data: properties };
  } catch (error) {
    console.error('Error getting documents: ', error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to load properties from Firestore.',
    };
  }
}

/**
 * Array-returning wrapper kept for the public pages, whose existing callers
 * treat the result as a plain list. An error still yields `[]` here — callers
 * that need to tell the two apart use {@link getPropertiesResult}.
 */
export async function getProperties(): Promise<Property[]> {
  const result = await getPropertiesResult();
  return result.ok ? result.data : [];
}

export async function getProperty(id: string): Promise<Property | null> {
  if (!isFirebaseConfigured() || !db) return null;
  try {
    const docRef = doc(db, COLLECTION_NAME, id);
    const docSnap = await getDoc(docRef);

    if (docSnap.exists()) {
      return { id: docSnap.id, ...docSnap.data() } as Property;
    } else {
      console.log("No such document!");
      return null;
    }
  } catch (error) {
    console.error("Error getting document:", error);
    return null;
  }
}

// ─── WRITE (server-side API routes via Admin SDK) ──────────────
// Session cookie is sent automatically with same-origin fetch requests.

export async function addProperty(
  property: Omit<Property, 'id'>,
): Promise<MutationResult<{ id: string }>> {
  let res: Response;
  try {
    res = await fetch('/api/properties', {
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
/** The property's co-owners record (dispatch 23B), from its own route; null when it has none. */
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
    return { ok: false, error: `Could not read the co-owners record (HTTP ${res.status}).` };
  }
  return { ok: true, data: data.record as PropertyManagementView | null };
}

/** Set the co-owners record whole, or clear it with null. */
export async function setManagement(id: string, record: ManagementPayload | null): Promise<MutationResult<{ record: PropertyManagementView | null }>> {
  let res: Response;
  try {
    res = await fetch(`/api/admin/properties/${encodeURIComponent(id)}/management`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
    });
  } catch (error) {
    return networkFailure(error, 'Could not reach the server to save the co-owners record');
  }
  if (!res.ok) return toFailure(res, 'Failed to save the co-owners record');
  const body = await res.json().catch(() => ({}));
  const stored = body && typeof body === 'object' ? (body as { data?: { record?: unknown } }).data?.record : undefined;
  return { ok: true, data: { record: stored && typeof stored === 'object' ? (stored as PropertyManagementView) : null } };
}

/** The record as the form saves it: amounts as typed, "150.00". */
export interface ManagementPayload {
  owners: { name: string; email: string | null }[];
  statementsFrom: string;
  statementsUntil: string | null;
  defaultFee: { label: string; amount: string } | null;
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
