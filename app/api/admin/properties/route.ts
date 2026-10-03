/**
 * GET /api/admin/properties — every property, whole, for the admin (dispatch 24).
 *
 * Response: 200 `{ success: true, data: { properties: Property[], unlistedIds: string[], createdMonths: { [id]: 'yyyy-mm' } } }`
 *
 * The admin list and the Availability page read the collection from the
 * browser until dispatch 24. The Firestore rules now refuse a browser that
 * lists `properties` (an unlisted property must be unreadable by the public,
 * Kian's ruling of 2026-10-03, and rules cannot tell an admin's browser from a
 * visitor's), so the admin reads it here, through the Admin SDK, behind the
 * admin session. Each property is its stored document with its ID, exactly as
 * the browser read gave it, because the property form edits and sends back
 * what it was given. Which properties are unlisted comes beside them, never
 * inside a document, so a form cannot write it onto one; so does the Toronto
 * month each document was created, by Firestore's own create time, which the
 * owed-months rule needs (Kian's ruling of 2026-10-03).
 *
 * Every response is no-store.
 */

import { NextRequest } from 'next/server';
import { getAdminDb } from '@/app/lib/firebase/admin';
import { unlistedPropertyIds } from '@/app/lib/firebase/server-visibility';
import { createdMonthOf } from '@/app/lib/firebase/created-month';
import { verifyAdminSession } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, noStore } from '@/app/lib/api/safe-response';

/** The one thing logged about a Firestore error: its gRPC code. */
function grpcCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? String(code) : 'unknown';
}

export async function GET(request: NextRequest) {
  const auth = verifyAdminSession(request);
  if (!auth.valid) return noStore(apiError(auth.error!, auth.status!));

  try {
    const [snapshot, unlisted] = await Promise.all([getAdminDb().collection('properties').get(), unlistedPropertyIds()]);
    const properties = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    const createdMonths = Object.fromEntries(snapshot.docs.map((doc) => [doc.id, createdMonthOf(doc.createTime)]));
    return noStore(apiSuccess({ properties, unlistedIds: [...unlisted].sort(), createdMonths }));
  } catch (err) {
    console.error(`[admin/properties] read failed: grpc code ${grpcCode(err)}`);
    return noStore(apiFailure({ message: 'Could not load the properties.', status: 503, code: 'PROPERTIES_UNAVAILABLE' }));
  }
}
