/**
 * POST /api/admin/cost-reports — Record a PDF report before it is downloaded (admin-only).
 *
 * Request:  `{ propertyId, from, to, entries: [{ id, seen }] }` — the
 *           property, the period the PDF prints (yyyy-mm-dd, both days
 *           included), and each entry in it with the length of its history
 *           as the page shows it
 * Response: 201 `{ success: true, data: { export: ReportExportView } }`
 *
 * A PDF goes to a property's co-owners, and an approved entry can still be
 * corrected or removed after it has gone out (Kian's ruling of 2026-09-30).
 * So the costs page asks here first and downloads the PDF only on a 201: the
 * record is what later lets the ledger say that a PDF already handed out no
 * longer matches. The Excel file is the admins' own working copy and is not
 * recorded.
 *
 * The server works the report out again from what is stored — the
 * property's approved entries sent in the period — and records it only if
 * that is exactly what the page built the PDF from. If an entry in the
 * period was corrected, approved, rejected or removed since the page loaded,
 * nothing is written and the answer is 409 REPORT_CHANGED. See
 * recordReportExport.
 *
 * Nothing on any entry is written. A record is written once and is never
 * changed or deleted.
 *
 * Order: the admin session, then the cross-site and media-type refusals, then
 * the JSON and the schema, then the work. Every response is no-store, the
 * refusals included.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { verifyAdminSession } from '@/app/lib/api/verify-admin';
import { apiSuccess, apiError, apiFailure, apiValidationError, noStore } from '@/app/lib/api/safe-response';
import { LIMITS } from '@/app/lib/cleaners/model';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { isDay } from '@/app/lib/costs/report';
import { REPORT_REFUSALS, recordReportExport } from '@/app/lib/firebase/server-cost-entries';
import { isDocumentId } from '@/app/lib/firebase/server-leads';

const DaySchema = z.string().refine(isDay, 'Write the date as yyyy-mm-dd');

/** Strict: a body that carries anything else — an amount, a name — is refused, not trimmed. */
const ReportSchema = z
  .strictObject({
    propertyId: z.string().refine((id) => isDocumentId(id), 'Not a property ID'),
    from: DaySchema,
    to: DaySchema,
    entries: z
      .array(
        z.strictObject({
          id: z.string().refine((id) => isDocumentId(id), 'Not an entry ID'),
          seen: z.number().int().min(1).max(1_000_000),
        }),
      )
      .max(LIMITS.REPORT_ENTRIES_MAX, `At most ${LIMITS.REPORT_ENTRIES_MAX} entries in one PDF`),
  })
  .superRefine((body, ctx) => {
    if (body.from > body.to) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'The period ends before it starts' });
    }
    if (new Set(body.entries.map((entry) => entry.id)).size !== body.entries.length) {
      ctx.addIssue({ code: 'custom', path: ['entries'], message: 'An entry is listed twice' });
    }
  });

export async function POST(request: NextRequest) {
  // ── Auth ──
  const auth = verifyAdminSession(request);
  if (!auth.valid) return noStore(apiError(auth.error!, auth.status!));

  // ── Cross-site and media type ──
  const crossSite = refuseCrossSite(request);
  if (crossSite) return crossSite;
  const wrongType = requireMediaType(request, 'application/json');
  if (wrongType) return wrongType;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return noStore(apiError('Invalid JSON body', 400));
  }

  // ── Validate ──
  const result = ReportSchema.safeParse(body);
  if (!result.success) {
    return noStore(
      apiValidationError(result.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))),
    );
  }

  const outcome = await recordReportExport(result.data);
  if (outcome.kind !== 'recorded') return noStore(apiFailure(REPORT_REFUSALS[outcome.kind]));

  return noStore(apiSuccess({ export: outcome.export }, 201));
}
