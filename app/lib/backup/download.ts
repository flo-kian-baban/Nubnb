/**
 * The month as a ZIP, made in the admin's browser (Kian's ruling of
 * 2026-10-03, dispatch 24): one call for what the month is made from and a
 * 60-second link to each file (GET /api/admin/month-package), the files
 * fetched straight from Google, each checked against the SHA-256 Nubnb
 * recorded for it, the package built by `buildMonthPackage` — the backup's
 * own builder — zipped, and saved. Vercel carries JSON; Google carries the
 * bytes.
 *
 * Resolves to a result and never throws. A file that cannot be fetched, or
 * whose SHA-256 is not the one recorded, stops the ZIP and is named: a ZIP
 * is never made short of a file, or with a file that is not what Nubnb
 * recorded.
 *
 * Browser only (Blob, an anchor's download, crypto.subtle).
 */

import { describeErrorBody, readErrorBody } from '@/app/lib/api/http-failure';
import { readCostEntryFields } from '@/app/lib/cleaners/model';
import { zipStored } from '@/app/lib/costs/zip';
import { receiptKey, statementKey, type MonthPackageData } from './data';
import { buildMonthPackage } from './package';

export type MonthZipResult =
  | { ok: true; name: string; bytes: number; files: number; statements: number; folders: number }
  | { ok: false; status: number; title: string; detail?: string };

/** What the page says while it works. */
export type MonthZipStep = 'asking' | 'fetching' | 'building' | 'saving';

/** SHA-256 of some bytes, in hex, by the browser's own Web Crypto. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** What each fetched file must hash to, by the package's key, and what the file is called in words. */
function expectations(data: MonthPackageData): Map<string, { sha256: string | null; also: string | null; label: string }> {
  const expected = new Map<string, { sha256: string | null; also: string | null; label: string }>();
  for (const folder of data.folders) {
    if (folder.report) expected.set(statementKey(folder.report.id), { sha256: folder.report.pdf.sha256, also: null, label: `the statement of ${folder.propertyName}` });
  }
  // A counted cost's receipt is also frozen into its statement's row: both must agree with the file.
  const frozen = new Map<string, string>();
  for (const folder of data.folders) for (const row of folder.statement.costs) if (row.receiptSha256) frozen.set(row.entryId, row.receiptSha256);
  for (const [entryId, stored] of Object.entries(data.entries)) {
    const fields = readCostEntryFields(entryId, stored);
    (fields.receipts ?? []).forEach((receipt, index) => {
      expected.set(receiptKey(entryId, index), { sha256: receipt.sha256, also: index === 0 ? (frozen.get(entryId) ?? null) : null, label: `the receipt of entry ${entryId.slice(0, 6)}` });
    });
  }
  return expected;
}

/** Fetch every linked file, a few at a time, each checked; the first problem stops it. */
async function fetchAll(links: Record<string, string>, expected: ReturnType<typeof expectations>): Promise<{ ok: true; objects: Map<string, Uint8Array> } | { ok: false; title: string; detail: string }> {
  const objects = new Map<string, Uint8Array>();
  const queue = Object.entries(links);
  let problem: { title: string; detail: string } | null = null;
  const worker = async () => {
    while (queue.length > 0 && problem === null) {
      const [key, url] = queue.shift()!;
      const what = expected.get(key);
      const label = what?.label ?? key;
      let bytes: Uint8Array;
      try {
        const res = await fetch(url, { cache: 'no-store', referrerPolicy: 'no-referrer' });
        if (!res.ok) {
          problem = { title: `Could not fetch ${label}.`, detail: `Google answered ${res.status}${res.status === 400 || res.status === 403 ? ': its link may have expired' : ''}. Nothing was saved. Try again.` };
          return;
        }
        bytes = new Uint8Array(await res.arrayBuffer());
      } catch (err) {
        problem = { title: `Could not fetch ${label}.`, detail: `${err instanceof Error ? err.message : 'The request failed.'} Nothing was saved. Try again.` };
        return;
      }
      const hash = await sha256Hex(bytes);
      if (!what?.sha256 || hash !== what.sha256 || (what.also !== null && hash !== what.also)) {
        problem = { title: `${label[0].toUpperCase()}${label.slice(1)} is not the file Nubnb recorded.`, detail: `Its SHA-256 is ${hash}; Nubnb recorded ${what?.sha256 ?? 'none'}${what?.also && what.also !== what.sha256 ? ` and the statement ${what.also}` : ''}. No ZIP was made.` };
        return;
      }
      objects.set(key, bytes);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return problem ? { ok: false, ...(problem as { title: string; detail: string }) } : { ok: true, objects };
}

/** Make the month's ZIP and hand it to the browser to save. */
export async function downloadMonthZip(month: string, onStep?: (step: MonthZipStep) => void): Promise<MonthZipResult> {
  onStep?.('asking');
  let res: Response;
  try {
    res = await fetch(`/api/admin/month-package?month=${encodeURIComponent(month)}`, { cache: 'no-store' });
  } catch (err) {
    return { ok: false, status: 0, title: 'Could not reach the server.', detail: err instanceof Error ? err.message : undefined };
  }
  if (!res.ok) {
    const failure = describeErrorBody(await readErrorBody(res), res.status, 'The month could not be read');
    return { ok: false, status: res.status, title: failure.title, detail: failure.detail };
  }
  const body = (await res.json().catch(() => null)) as { data?: { package?: MonthPackageData; links?: Record<string, string> } } | null;
  const data = body?.data?.package;
  const links = body?.data?.links;
  if (!data || !links || typeof links !== 'object') return { ok: false, status: res.status, title: 'The server’s answer could not be read.', detail: 'Nothing was saved.' };

  onStep?.('fetching');
  const fetched = await fetchAll(links, expectations(data));
  if (!fetched.ok) return { ok: false, status: 0, title: fetched.title, detail: fetched.detail };

  onStep?.('building');
  let built: Awaited<ReturnType<typeof buildMonthPackage>>;
  try {
    built = await buildMonthPackage(data, fetched.objects, sha256Hex, 'download');
  } catch (err) {
    return { ok: false, status: 0, title: 'The ZIP could not be made.', detail: `${err instanceof Error ? err.message : 'Something went wrong.'} Nothing was saved.` };
  }
  const zip = zipStored(
    built.files.map((file) => ({ name: file.path, data: file.data })),
    new Date(data.madeAt),
  );

  onStep?.('saving');
  const url = URL.createObjectURL(new Blob([zip], { type: 'application/zip' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = built.name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { ok: true, name: built.name, bytes: zip.length, files: built.files.length, statements: data.folders.filter((folder) => folder.report).length, folders: data.folders.length };
}
