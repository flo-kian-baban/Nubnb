/**
 * POST /api/properties — Create a new property (admin-only).
 *
 * Authenticated via HTTP-only session cookie.
 * Validated via Zod schema before any Firestore write.
 * All Firestore writes go through the Admin SDK — the client SDK never writes.
 */

import { NextRequest } from 'next/server';
import { getAdminDb } from '@/app/lib/firebase/admin';
import { verifyAdminSession } from '@/app/lib/api/verify-admin';
import { CreatePropertySchema } from '@/app/lib/api/schemas';
import { apiSuccess, apiError, apiValidationError } from '@/app/lib/api/safe-response';

const COLLECTION = 'properties';

export async function POST(request: NextRequest) {
  // ── Auth ──
  const auth = verifyAdminSession(request);
  if (!auth.valid) return apiError(auth.error!, auth.status!);

  try {
    const body = await request.json();

    if (!body || typeof body !== 'object') {
      return apiError('Invalid request body', 400);
    }

    // Strip any client-supplied `id` field — Firestore generates the ID
    const { id: _id, ...raw } = body;

    // ── Validate ──
    const result = CreatePropertySchema.safeParse(raw);
    if (!result.success) {
      return apiValidationError(
        result.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        }))
      );
    }

    const db = getAdminDb();
    const docRef = await db.collection(COLLECTION).add(result.data);

    return apiSuccess({ id: docRef.id }, 201);
  } catch (err) {
    return apiError('Failed to create property', 500, err);
  }
}
