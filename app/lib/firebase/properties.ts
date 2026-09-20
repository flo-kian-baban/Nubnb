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
