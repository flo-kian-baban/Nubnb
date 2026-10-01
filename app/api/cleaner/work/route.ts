/**
 * POST /api/cleaner/work — Log one piece of work done for one property (handyman-only, dispatch 24).
 *
 * Request:  JSON `{ submissionKey, propertyId, description, price }`
 *             description  what was done, 1–200 characters
 *             price        the amount, "185.00": positive, two decimals
 * Response: 201 `{ success: true, data: { id, status: 'pending', createdAt } }`
 *           200 `{ success: true, data: { id, createdAt, alreadyReceived: true } }`
 *               when this key was sent before: the first send's entry, and
 *               nothing new is written
 *
 * ── Who ──
 * The handyman is the one the verified session names. A cleaner's session
 * is refused here with 403 ROLE_MISMATCH: a cleaner logs receipts, at
 * POST /api/cleaner/entries, which refuses a handyman the same way. The
 * role is read from the account on this request and again inside the write.
 *
 * ── What is written ──
 * One `cost_entries` document of `kind: 'work'`: one line whose name is the
 * description, no tax, no receipt, no reading, and always `pending` — every
 * work entry needs an admin's approval, whatever its amount (Kian's ruling).
 * The one-time key works as on the receipt route.
 *
 * Order: cross-site, the session (before the body is read), the role, the
 * media type, the JSON, the schema, the one-time key, the property, then the
 * write. Nothing here logs the body. Every response is no-store.
 *
 * Firestore per entry: the session read, the one-time key read, the property
 * read, and a transaction of two reads and two creates.
 */

import { apiSuccess, apiFailure, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { CLEANER_SESSION_INVALID, requireRole, verifyCleanerSession } from '@/app/lib/cleaners/session';
import {
  DuplicateSubmissionError,
  SessionRevokedError,
  createWorkEntry,
  findSubmission,
  lookupPropertyName,
  parseWorkBody,
  type PropertyLookup,
  type SubmissionFound,
} from '@/app/lib/firebase/server-cost-entries';

export const maxDuration = 30;

/** The one thing logged about a Firestore error: its gRPC code. */
function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'number') return String(code);
  if (typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code)) return code;
  return 'unknown';
}

/** 200: this work arrived before, as `first`. Nothing new was written. */
function alreadyReceived(first: SubmissionFound) {
  return noStore(apiSuccess({ id: first.entryId, createdAt: first.createdAt, alreadyReceived: true }));
}

export async function POST(request: Request) {
  // ── 1. Cross-site ──
  const crossSite = refuseCrossSite(request);
  if (crossSite) return crossSite;

  // ── 2. Auth, then the role — before any of the body is read ──
  const session = await verifyCleanerSession(request);
  if (!session.ok) return noStore(apiFailure(session.refusal));
  const { cleaner } = session;
  const wrongRole = requireRole(cleaner, 'handyman');
  if (wrongRole) return noStore(apiFailure(wrongRole));

  // ── 3. Media type, then the JSON ──
  const wrongType = requireMediaType(request, 'application/json');
  if (wrongType) return wrongType;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return noStore(apiFailure({ message: 'The entry could not be read.', status: 400, code: 'ENTRY_BAD_REQUEST', hint: 'Send JSON: { submissionKey, propertyId, description, price }.' }));
  }

  // ── 4. The schema (422) ──
  const parsed = parseWorkBody(body);
  if (parsed.kind === 'invalid') return noStore(apiValidationError(parsed.issues));
  const { work } = parsed;

  // ── 5. Sent before? Then say so, and write nothing ──
  let first: SubmissionFound | null;
  try {
    first = await findSubmission(cleaner.id, work.submissionKey);
  } catch (err) {
    console.error(`[cleaner-work] one-time key check failed: grpc code ${errorCode(err)}`);
    return noStore(apiFailure({ message: 'Could not check whether this was already sent.', status: 502, code: 'SUBMISSION_CHECK_FAILED', hint: 'Nothing was recorded; retry.' }));
  }
  if (first) return alreadyReceived(first);

  // ── 6. The property must exist ──
  let property: PropertyLookup;
  try {
    property = await lookupPropertyName(work.propertyId);
  } catch (err) {
    console.error(`[cleaner-work] property lookup failed: grpc code ${errorCode(err)}`);
    return noStore(apiFailure({ message: 'Could not check the property.', status: 502, code: 'PROPERTY_LOOKUP_FAILED', hint: 'Nothing was recorded; retry.' }));
  }
  if (property.kind === 'missing') {
    return noStore(apiFailure({ message: 'That property does not exist.', status: 422, code: 'ENTRY_PROPERTY_NOT_FOUND', hint: 'Choose the property again. Nothing was recorded.' }));
  }

  // ── 7. Write, re-checking the account and the one-time key inside the transaction ──
  try {
    const created = await createWorkEntry({
      cleanerId: cleaner.id,
      sessionEpoch: cleaner.sessionEpoch,
      work,
      propertyNameAtEntry: property.name,
    });
    return noStore(apiSuccess(created, 201));
  } catch (err) {
    if (err instanceof SessionRevokedError) {
      return noStore(apiFailure({ ...CLEANER_SESSION_INVALID, hint: 'Nothing was logged.' }));
    }
    if (err instanceof DuplicateSubmissionError) return alreadyReceived(err.first);
    console.error(`[cleaner-work] entry not written: grpc code ${errorCode(err)}`);
    return noStore(apiFailure({ message: 'The entry could not be saved.', status: 502, code: 'ENTRY_WRITE_FAILED', hint: 'It may not have been recorded; sending again is safe.' }));
  }
}
