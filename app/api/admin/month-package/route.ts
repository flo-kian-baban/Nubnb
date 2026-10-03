/**
 * GET /api/admin/month-package?month=YYYY-MM — what the admin's ZIP of a month is made from (dispatch 24).
 *
 * Kian's ruling of 2026-10-03: the admin can download a whole month as a ZIP
 * in the same folder structure the backup will use. The browser builds the
 * ZIP (app/lib/backup/); this route gives it what it is made from:
 *
 *   200 `{ success: true, data: { package: MonthPackageData, links: { [key]: url }, expiresAt, seconds } }`
 *
 * - `package`: which properties have a folder, the statement each holds (the
 *   current finished one, or the statement as it stands, worked out by the
 *   same `buildStatement` the editor runs), only the entries they name and the
 *   entries sent in the month, and the stored documents for `Records/`, the
 *   Storage path of each receipt left out (paths never leave the server).
 * - `links`: a 60-second signed link for each receipt and statement PDF, by
 *   the package's key. Google serves the bytes; Vercel serves this JSON.
 *
 * The download is recorded before the answer: one `report_downloads`
 * document per current statement in the package (`via: 'month-package'`: the
 * ZIP hands the statement out, and 23G's delete confirmation counts
 * downloads), and one `month_downloads` document for the package. If the
 * record cannot be written, no link is handed out (502), as for a PDF link.
 *
 * Works whether or not any backup has run. Admin session only; no-store.
 */

import { NextRequest } from 'next/server';
import { getAdminBucket, getAdminDb } from '@/app/lib/firebase/admin';
import { verifyAdminSession } from '@/app/lib/api/verify-admin';
import { apiError, apiFailure, apiSuccess, noStore } from '@/app/lib/api/safe-response';
import { ADMIN_ACTOR, COST_ENTRIES_COLLECTION, RECEIPTS_PREFIX } from '@/app/lib/cleaners/model';
import { torontoDayOf } from '@/app/lib/costs/report';
import {
  MONTH_DOWNLOADS_COLLECTION,
  MONTH_DOWNLOAD_SCHEMA_VERSION,
  MONTHLY_REPORT_DRAFTS_COLLECTION,
  MONTHLY_REPORTS_COLLECTION,
  MONTHLY_REPORTS_PREFIX,
  PROPERTY_MANAGEMENT_COLLECTION,
  REPORT_DOWNLOAD_SCHEMA_VERSION,
  REPORT_DOWNLOADS_COLLECTION,
  STATEMENT_LIMITS,
  isMonth,
  readMonthlyReport,
  readPropertyManagement,
  readReportDownload,
  readStatementDraft,
} from '@/app/lib/reports/model';
import { selectMonthPackage, type SelectInputs } from '@/app/lib/backup/data';
import { createdMonthOf } from '@/app/lib/firebase/created-month';

/** The one thing logged about a Firestore or Storage error: its code. */
function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' || typeof code === 'string' ? String(code) : 'unknown';
}

/** A path the package may sign: a receipt under its own entry's folder, or a statement's PDF. Never one from the request. */
function signable(key: string, path: string): boolean {
  if (path.includes('..')) return false;
  const [kind, id] = key.split(':');
  if (kind === 'receipt') return path.startsWith(`${RECEIPTS_PREFIX}/${id}/`);
  if (kind === 'statement') return path === `${MONTHLY_REPORTS_PREFIX}/${id}.pdf`;
  return false;
}

export async function GET(request: NextRequest) {
  const auth = verifyAdminSession(request);
  if (!auth.valid) return noStore(apiError(auth.error!, auth.status!));

  const month = request.nextUrl.searchParams.get('month');
  if (!isMonth(month)) return noStore(apiError('A month, like 2026-09', 400));

  // ── What Nubnb holds now ──
  const db = getAdminDb();
  let selection: ReturnType<typeof selectMonthPackage>;
  const madeAt = new Date();
  try {
    const [properties, entries, reports, drafts, downloads, management] = await Promise.all([
      db.collection('properties').select('name').get(),
      db.collection(COST_ENTRIES_COLLECTION).get(),
      db.collection(MONTHLY_REPORTS_COLLECTION).get(),
      db.collection(MONTHLY_REPORT_DRAFTS_COLLECTION).where('month', '==', month).get(),
      db.collection(REPORT_DOWNLOADS_COLLECTION).where('month', '==', month).get(),
      db.collection(PROPERTY_MANAGEMENT_COLLECTION).get(),
    ]);
    const input: SelectInputs = {
      month,
      today: torontoDayOf(madeAt),
      madeAt: madeAt.toISOString(),
      properties: properties.docs.map((doc) => ({ id: doc.id, name: typeof doc.get('name') === 'string' ? (doc.get('name') as string) : null, createdMonth: createdMonthOf(doc.createTime) })),
      entries: entries.docs.map((doc) => ({ id: doc.id, stored: doc.data() })),
      reports: reports.docs.flatMap((doc) => {
        const view = readMonthlyReport(doc.id, doc.data());
        if (!view) console.error(`[month-package] monthly_reports/${doc.id} is not in the written shape; left out`);
        return view ? [{ view, stored: doc.data() }] : [];
      }),
      drafts: drafts.docs.flatMap((doc) => {
        const view = readStatementDraft(doc.id, doc.data());
        return view ? [{ view, stored: doc.data() }] : [];
      }),
      downloads: downloads.docs.flatMap((doc) => {
        const view = readReportDownload(doc.id, doc.data());
        return view ? [{ view, stored: doc.data() }] : [];
      }),
      management: management.docs.flatMap((doc) => {
        const view = readPropertyManagement(doc.id, doc.data());
        return view ? [{ view, stored: doc.data() }] : [];
      }),
    };
    selection = selectMonthPackage(input);
  } catch (err) {
    console.error(`[month-package] read for ${month} failed: code ${errorCode(err)}`);
    return noStore(apiFailure({ message: 'Could not read the month.', status: 503, code: 'MONTH_PACKAGE_UNAVAILABLE', hint: 'Nothing was recorded. Try again.' }));
  }

  // ── A 60-second link for each receipt and statement PDF ──
  const seconds = STATEMENT_LIMITS.DOWNLOAD_LINK_SECONDS;
  const expires = Date.now() + seconds * 1000;
  const links: Record<string, string> = {};
  try {
    const bucket = getAdminBucket();
    for (const object of selection.objects) {
      if (!signable(object.key, object.path)) {
        console.error(`[month-package] ${object.key}: its stored path is not one the package signs; left out`);
        continue;
      }
      const [url] = await bucket.file(object.path).getSignedUrl({ version: 'v4', action: 'read', expires });
      links[object.key] = url;
    }
  } catch (err) {
    console.error(`[month-package] signing for ${month} failed: code ${errorCode(err)}`);
    return noStore(apiFailure({ message: 'Could not make the links to the files.', status: 502, code: 'MONTH_PACKAGE_LINKS_FAILED', hint: 'Nothing was recorded. Try again.' }));
  }

  // ── The download, recorded before any link is handed out ──
  const at = new Date().toISOString();
  const pkg = selection.data;
  try {
    const batch = db.batch();
    for (const folder of pkg.folders) {
      if (!folder.report) continue;
      const ref = db.collection(REPORT_DOWNLOADS_COLLECTION).doc();
      const record = { schemaVersion: REPORT_DOWNLOAD_SCHEMA_VERSION, reportId: folder.report.id, propertyId: folder.propertyId, month, at, actor: ADMIN_ACTOR, via: 'month-package' };
      batch.create(ref, record);
      // The package says what it was made with, its own download included.
      folder.report.downloads.push({ at, via: 'month-package' });
      pkg.records.downloads.push({ id: ref.id, ...record });
    }
    batch.create(db.collection(MONTH_DOWNLOADS_COLLECTION).doc(), {
      schemaVersion: MONTH_DOWNLOAD_SCHEMA_VERSION,
      month,
      at,
      actor: ADMIN_ACTOR,
      reportIds: selection.reportIds,
      folders: pkg.folders.length,
      entries: Object.keys(pkg.entries).length,
      files: Object.keys(links).length,
    });
    await batch.commit();
  } catch (err) {
    console.error(`[month-package] recording the download of ${month} failed: code ${errorCode(err)}`);
    return noStore(
      apiFailure({ message: 'Could not record the download.', status: 502, code: 'MONTH_PACKAGE_RECORD_FAILED', hint: 'No file was handed out. It may or may not have been recorded: try again.' }),
    );
  }

  console.log(`[month-package] ${month}: ${pkg.folders.length} folders, ${Object.keys(links).length} files, ${selection.reportIds.length} statements`);
  return noStore(apiSuccess({ package: pkg, links, expiresAt: new Date(expires).toISOString(), seconds }));
}
