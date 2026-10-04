/**
 * POST /api/admin/income/uploads — Upload a platform's earnings file for a month (admin-only, dispatch 27).
 *
 * Request: multipart/form-data with three parts — `month` (yyyy-mm),
 * `channel` (the upload type: "airbnb") and `file` (Airbnb's transaction
 * report as a CSV, at most 2 MiB, UTF-8).
 *
 * Response: 201 `{ upload }` — what was read, what was added and what was
 * already stored. Refusals, each with nothing stored:
 *   413 FILE_TOO_LARGE, 415, 400 for a missing part
 *   422 FILE_UNREADABLE (evidence: the rows), NOTHING_IN_MONTH (evidence: the
 *       months the file covers), FILE_TOO_LONG
 *   409 FILE_ALREADY_UPLOADED (evidence: when, and for which month)
 *   502 FILE_NOT_STORED; UPLOAD_RECORD_FAILED (may or may not be recorded)
 *
 * Order: the admin session, then the cross-site and media-type refusals, the
 * size, the parts, then the work. Every response is no-store.
 */

import { NextRequest } from 'next/server';
import { verifyAdminSession } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, noStore } from '@/app/lib/api/safe-response';
import { refuseCrossSite, requireMediaType } from '@/app/lib/cleaners/request-guard';
import { UPLOAD_REFUSALS, uploadEarnings } from '@/app/lib/firebase/server-income';
import { INCOME_LIMITS, isIncomeChannel } from '@/app/lib/income/model';
import { isMonth, monthLabel } from '@/app/lib/reports/model';

/** The parts beside the file are a few bytes; this allows for the multipart framing. */
const REQUEST_MAX_BYTES = INCOME_LIMITS.FILE_MAX_BYTES + 64 * 1024;

export async function POST(request: NextRequest) {
  const auth = verifyAdminSession(request);
  if (!auth.valid) return noStore(apiError(auth.error!, auth.status!));
  const crossSite = refuseCrossSite(request);
  if (crossSite) return crossSite;
  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (declaredLength > REQUEST_MAX_BYTES) {
    return noStore(apiFailure({ message: 'The file is too large.', status: 413, code: 'FILE_TOO_LARGE', hint: `A file can be at most ${INCOME_LIMITS.FILE_MAX_BYTES / 1024 / 1024} MiB. Nothing was stored.` }));
  }
  const wrongType = requireMediaType(request, 'multipart/form-data');
  if (wrongType) return wrongType;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return noStore(apiError('The upload could not be read as a form.', 400));
  }
  const month = form.get('month');
  const channel = form.get('channel');
  const file = form.get('file');
  if (typeof month !== 'string' || !isMonth(month)) return noStore(apiError('Invalid month: write it as yyyy-mm', 400));
  if (!isIncomeChannel(channel)) return noStore(apiError('Unknown upload type', 400));
  if (!(file instanceof Blob)) return noStore(apiError('No file was sent.', 400));
  if (file.size > INCOME_LIMITS.FILE_MAX_BYTES) {
    return noStore(apiFailure({ message: 'The file is too large.', status: 413, code: 'FILE_TOO_LARGE', hint: `A file can be at most ${INCOME_LIMITS.FILE_MAX_BYTES / 1024 / 1024} MiB. Nothing was stored.` }));
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return noStore(apiFailure({ ...UPLOAD_REFUSALS.unreadable, message: 'This file is not UTF-8 text: it is not Airbnb\'s CSV.' }));
  }
  const fileName = 'name' in file && typeof file.name === 'string' ? file.name : 'upload.csv';

  const outcome = await uploadEarnings({ platform: channel, month, fileName, bytes, text });
  switch (outcome.kind) {
    case 'uploaded':
      return noStore(apiSuccess({ upload: outcome.upload }, 201));
    case 'unreadable':
      return noStore(apiFailure({ ...UPLOAD_REFUSALS.unreadable, hint: `${outcome.problems.join(' ')} ${UPLOAD_REFUSALS.unreadable.hint}` }));
    case 'nothing-in-month':
      return noStore(apiFailure({ ...UPLOAD_REFUSALS['nothing-in-month'], hint: `${outcome.months.length > 0 ? `Its rows were paid in ${outcome.months.map(monthLabel).join(', ')}. ` : ''}${UPLOAD_REFUSALS['nothing-in-month'].hint}` }));
    case 'too-many':
      return noStore(apiFailure({ ...UPLOAD_REFUSALS['too-many'], evidence: { rows: outcome.lines } }));
    case 'already-uploaded':
      return noStore(apiFailure({ ...UPLOAD_REFUSALS['already-uploaded'], evidence: { uploadId: outcome.uploadId, uploadedAt: outcome.uploadedAt, month: outcome.month } }));
    default:
      return noStore(apiFailure(UPLOAD_REFUSALS[outcome.kind]));
  }
}
