/**
 * One month's package, file by file (FINANCIAL-MANAGEMENT-PLAN.md §2.7):
 *
 *   Properties/<property · id6>/<year>/<yyyy-mm Month>/   one per property-month with a folder
 *     <yyyy-mm> Payment Summary <reference> (<ref>).pdf   the current finished statement, as stored
 *     <yyyy-mm> <property>.xlsx                           the statement, its costs with tax apart, items, history, receipts
 *     Receipts/<day> ref <ref>.jpg                        each counted cost's photo
 *     README.txt, manifest.json, SHA256SUMS.txt
 *   Nubnb/<year>/<yyyy-mm Month>/
 *     <yyyy-mm> Fee income.xlsx, <yyyy-mm> Not charged.xlsx
 *     Not charged receipts/<property · id6>/<day> ref <ref> - <status>.jpg
 *     Records/*.json                                      the month's documents as stored, receipt paths left out
 *     README.txt, manifest.json, SHA256SUMS.txt
 *
 * The admin's ZIP (dispatch 24) and the backup in Drive (the next dispatch)
 * are both made by `buildMonthPackage`, so they hold the same files under
 * the same names. The bytes of the PDFs and receipts are fetched by the
 * caller, checked against Nubnb's records, and handed in; this module never
 * fetches anything.
 *
 * Client-safe, and pure apart from the SHA-256 function it is given.
 */

import { readCostEntryFields } from '@/app/lib/cleaners/model';
import { sentDay } from '@/app/lib/costs/report';
import { monthLabel } from '@/app/lib/reports/model';
import { STANDING_LABELS } from '@/app/lib/reports/statement';
import { receiptKey, statementKey, type MonthPackageData, type PackageFolder } from './data';
import { cleanName, distinctNames, nubnbMonthPath, packageFileName, propertyFolderName, propertyMonthPath, receiptFileName, statementFileName, workbookFileName } from './names';
import { feeIncomeWorkbook, notChargedWorkbook, propertyWorkbook, whenWords, type FileNote } from './workbooks';

export interface PackageFile {
  /** Path inside the package, from its top level: `Properties/…` or `Nubnb/…`. */
  path: string;
  data: Uint8Array;
}

export type Sha256 = (bytes: Uint8Array) => Promise<string>;

/** Who made the package, for its READMEs. */
export type MadeBy = 'download' | 'backup';

const MADE_BY_WORDS: Record<MadeBy, string> = {
  download: "an admin's download from Nubnb",
  backup: "Nubnb's backup",
};

/** A file of one folder, before its hash is known: its path in the folder, its bytes, where it came from. */
interface FolderFile {
  name: string;
  data: Uint8Array;
  source: Record<string, unknown>;
  recordedSha256: string | null;
}

const encoder = new TextEncoder();
const json = (value: unknown) => encoder.encode(`${JSON.stringify(value, null, 2)}\n`);

/** The manifest, then the checksum list, appended to a folder's files: every file's hash, as made. */
async function sealFolder(files: FolderFile[], header: Record<string, unknown>, sha256: Sha256): Promise<{ name: string; data: Uint8Array }[]> {
  const hashed = await Promise.all(files.map(async (file) => ({ ...file, sha256: await sha256(file.data) })));
  const manifest = json({
    ...header,
    files: hashed.map((file) => ({ path: file.name, bytes: file.data.length, sha256: file.sha256, recordedSha256: file.recordedSha256, source: file.source })),
  });
  const all = [...hashed, { name: 'manifest.json', data: manifest, sha256: await sha256(manifest) }];
  const sums = encoder.encode(`${all.map((file) => `${file.sha256}  ${file.name}`).join('\n')}\n`);
  return [...all.map(({ name, data }) => ({ name, data })), { name: 'SHA256SUMS.txt', data: sums }];
}

const CANNOT_SHOW = [
  'That a purchase happened, for this property, at this price: a photo is what a cleaner’s phone sent, and the cleaner chose the property.',
  'When a photo was taken or a purchase made: the phone re-encodes the photo, dropping the camera’s date. Only the upload time is known.',
  'That a tax figure is the tax printed on the receipt: a cleaner typed it or confirmed it, or the office corrected it. The photo is the source.',
  'Which person in the office did anything: the office signs in with one shared PIN.',
  'Anything Nubnb no longer held when this was made.',
];

const CHECKING = [
  'On a Mac or Linux, in this folder:  shasum -a 256 -c SHA256SUMS.txt',
  'On Windows, one file at a time:     certutil -hashfile "<file>" SHA256',
];

function propertyReadme(data: MonthPackageData, folder: PackageFolder, made: MadeBy, contents: [string, string][]): Uint8Array {
  const report = folder.report;
  const lastDownload = report?.downloads[report.downloads.length - 1];
  const state =
    folder.kind === 'finished' && report
      ? `Finished ${whenWords(report.finishedAt)}, Toronto time.`
      : folder.kind === 'draft'
        ? 'No finished statement. The workbook holds the draft as it stood: not sent to anyone.'
        : 'No finished statement and no draft. The workbook holds the costs as they stood.';
  const lines = [
    `${folder.propertyName}, ${monthLabel(data.month)}`,
    'Nubnb: the month’s statement and its records',
    '',
    `Made ${whenWords(data.madeAt)}, Toronto time, by ${MADE_BY_WORDS[made]}, from what Nubnb held then.`,
    `Statement: ${state}`,
    `Standing in Nubnb’s reporting cycle: ${STANDING_LABELS[folder.standing]}.`,
    ...(report ? [`Downloads Nubnb recorded for the statement: ${report.downloads.length}${lastDownload ? ` (last ${whenWords(lastDownload.at)})` : ''}.`] : []),
    ...(folder.unreadable.length > 0 ? [`No statement can be worked out: approved entries that cannot be added up: ${folder.unreadable.join(', ')}.`] : []),
    '',
    'What is here',
    ...contents.map(([name, what]) => `  ${name}\n      ${what}`),
    '',
    'How to check the files',
    ...CHECKING.map((line) => `  ${line}`),
    ...(report ? ['  The statement’s SHA-256 was taken when it was finished: an owner who received it can hash their copy and compare.'] : []),
    '',
    'What this cannot show',
    ...CANNOT_SHOW.map((line) => `  - ${line}`),
    '',
  ];
  return encoder.encode(lines.join('\n'));
}

function nubnbReadme(data: MonthPackageData, made: MadeBy, contents: [string, string][]): Uint8Array {
  const finished = data.folders.filter((folder) => folder.kind === 'finished').length;
  const lines = [
    `Nubnb, ${monthLabel(data.month)}`,
    'Nubnb’s own records of the month: for Nubnb and its accountant, not for owners',
    '',
    `Made ${whenWords(data.madeAt)}, Toronto time, by ${MADE_BY_WORDS[made]}, from what Nubnb held then.`,
    `${finished} finished ${finished === 1 ? 'statement' : 'statements'}; ${data.folders.length} ${data.folders.length === 1 ? 'property has' : 'properties have'} a folder under Properties/.`,
    '',
    'What is here',
    ...contents.map(([name, what]) => `  ${name}\n      ${what}`),
    '',
    'How to check the files',
    ...CHECKING.map((line) => `  ${line}`),
    '',
    'What this cannot show',
    ...CANNOT_SHOW.map((line) => `  - ${line}`),
    '  - Whether HST applies to Nubnb’s fee: the statement prints one amount, and nothing in Nubnb records it.',
    '',
  ];
  return encoder.encode(lines.join('\n'));
}

/** The receipts of some entries, named for one folder: by the day each was sent and its ref, clashes told apart. */
function namedReceipts(data: MonthPackageData, entryIds: string[], prefix: string, withStatus: boolean): { byEntry: Map<string, { name: string; key: string; recordedSha256: string | null }[]> } {
  const wanted: { id: string; entryId: string; key: string; name: string; recordedSha256: string | null }[] = [];
  for (const entryId of entryIds) {
    const stored = data.entries[entryId];
    if (!stored) continue;
    const fields = readCostEntryFields(entryId, stored);
    const receipts = fields.receipts ?? [];
    receipts.forEach((receipt, index) => {
      wanted.push({
        id: entryId,
        entryId,
        key: receiptKey(entryId, index),
        name: receiptFileName({ day: sentDay(fields.createdAt), entryId, index, of: receipts.length, contentType: receipt.contentType, status: withStatus ? fields.status : null }),
        recordedSha256: receipt.sha256,
      });
    });
  }
  const byEntry = new Map<string, { name: string; key: string; recordedSha256: string | null }[]>();
  for (const item of distinctNames(wanted)) byEntry.set(item.entryId, [...(byEntry.get(item.entryId) ?? []), { name: `${prefix}${item.name}`, key: item.key, recordedSha256: item.recordedSha256 }]);
  return { byEntry };
}

/**
 * Every file of the month's package. `objects` holds the bytes of each PDF
 * and receipt the package names, by `statementKey` / `receiptKey`, already
 * checked against Nubnb's records by the caller; one missing is an error.
 */
export async function buildMonthPackage(data: MonthPackageData, objects: Map<string, Uint8Array>, sha256: Sha256, made: MadeBy): Promise<{ name: string; files: PackageFile[] }> {
  const madeAt = new Date(data.madeAt);
  const files: PackageFile[] = [];
  const need = (key: string): Uint8Array => {
    const bytes = objects.get(key);
    if (!bytes) throw new Error(`The package needs ${key}, which was not fetched.`);
    return bytes;
  };
  const statementFiles = new Map<string, FileNote & { path: string }>();
  const folderNames = distinctNames(data.folders.map((folder) => ({ id: folder.propertyId, name: propertyFolderName(folder.propertyName, folder.propertyId), folder })));

  for (const { name: folderName, folder } of folderNames) {
    const base = propertyMonthPath(folderName, data.month);
    const own: FolderFile[] = [];
    const contents: [string, string][] = [];

    // The statement, as stored.
    if (folder.kind === 'finished' && folder.report) {
      const name = statementFileName(data.month, folder.report.reference, folder.report.id);
      const bytes = need(statementKey(folder.report.id));
      own.push({ name, data: bytes, source: { collection: 'monthly_reports', id: folder.report.id, pdf: true }, recordedSha256: folder.report.pdf.sha256 });
      statementFiles.set(folder.report.id, { name, path: `${base}/${name}`, bytes: bytes.length, recordedSha256: folder.report.pdf.sha256, sha256: await sha256(bytes) });
      contents.push([name, `The Payment Summary, finished ${whenWords(folder.report.finishedAt)}: the bytes Nubnb stored when it was finished.`]);
    }

    // Each counted cost's and adjustment's receipt.
    const entryIds = [...new Set([...folder.statement.costs.map((row) => row.entryId), ...folder.statement.adjustments.map((row) => row.entryId)])];
    const { byEntry } = namedReceipts(data, entryIds, 'Receipts/', false);
    const notes = new Map<string, FileNote[]>();
    for (const [entryId, receipts] of byEntry) {
      const list: FileNote[] = [];
      for (const receipt of receipts) {
        const bytes = need(receipt.key);
        own.push({ name: receipt.name, data: bytes, source: { collection: 'cost_entries', id: entryId, receipt: Number(receipt.key.split(':')[2]) }, recordedSha256: receipt.recordedSha256 });
        list.push({ name: receipt.name, bytes: bytes.length, recordedSha256: receipt.recordedSha256, sha256: await sha256(bytes) });
      }
      notes.set(entryId, list);
    }

    // The workbook.
    const workbookName = workbookFileName(data.month, folder.propertyName);
    own.push({ name: workbookName, data: propertyWorkbook({ data, folder, receipts: notes, madeAt }), source: { made: 'workbook' }, recordedSha256: null });
    contents.push([workbookName, 'The statement line by line, each cost with its tax apart, the items, the history and the receipts.']);
    if (notes.size > 0) contents.push(['Receipts/', 'One photo per cost, named by the day it was sent and its ref, as the statement prints them.']);
    contents.push(['manifest.json', 'Every file with its SHA-256 and where it came from.'], ['SHA256SUMS.txt', 'The same hashes, in the form shasum checks.']);

    own.push({ name: 'README.txt', data: propertyReadme(data, folder, made, contents), source: { made: 'readme' }, recordedSha256: null });
    const sealed = await sealFolder(
      own,
      {
        schemaVersion: 1,
        kind: 'property-month',
        month: data.month,
        property: { id: folder.propertyId, name: folder.propertyName },
        made: { at: data.madeAt, by: made },
        statement: folder.report ? { reportId: folder.report.id, reference: folder.report.reference, finishedAt: folder.report.finishedAt, sha256AtFinish: folder.report.pdf.sha256, downloads: folder.report.downloads } : null,
        state: folder.kind,
      },
      sha256,
    );
    for (const file of sealed) files.push({ path: `${base}/${file.name}`, data: file.data });
  }

  // ── Nubnb's month ──
  const base = nubnbMonthPath(data.month);
  const own: FolderFile[] = [];
  const contents: [string, string][] = [];
  own.push({ name: `${data.month} Fee income.xlsx`, data: feeIncomeWorkbook({ data, statements: statementFiles, madeAt }), source: { made: 'workbook' }, recordedSha256: null });
  contents.push([`${data.month} Fee income.xlsx`, 'Every property’s standing for the month and, for each finished statement, its revenue, fee with rate and base, and revenue share; the totals; each statement’s file and SHA-256.']);

  const foldersByProperty = new Map(folderNames.map(({ name, folder }) => [folder.propertyId, name]));
  const notChargedReceipts = new Map<string, FileNote[]>();
  const byProperty = new Map<string, string[]>();
  for (const item of data.notCharged) {
    const key = item.propertyId ?? 'unknown';
    byProperty.set(key, [...(byProperty.get(key) ?? []), item.entryId]);
  }
  for (const [propertyId, entryIds] of byProperty) {
    const name = data.notCharged.find((item) => (item.propertyId ?? 'unknown') === propertyId)?.propertyName ?? 'Unknown property';
    const folderName = foldersByProperty.get(propertyId) ?? (propertyId === 'unknown' ? cleanName(name) : propertyFolderName(name, propertyId));
    const { byEntry } = namedReceipts(data, entryIds, `Not charged receipts/${folderName}/`, true);
    for (const [entryId, receipts] of byEntry) {
      const list: FileNote[] = [];
      for (const receipt of receipts) {
        const bytes = need(receipt.key);
        own.push({ name: receipt.name, data: bytes, source: { collection: 'cost_entries', id: entryId, receipt: Number(receipt.key.split(':')[2]) }, recordedSha256: receipt.recordedSha256 });
        list.push({ name: receipt.name, bytes: bytes.length, recordedSha256: receipt.recordedSha256, sha256: await sha256(bytes) });
      }
      notChargedReceipts.set(entryId, list);
    }
  }
  own.push({ name: `${data.month} Not charged.xlsx`, data: notChargedWorkbook({ data, receipts: notChargedReceipts, madeAt }), source: { made: 'workbook' }, recordedSha256: null });
  contents.push([`${data.month} Not charged.xlsx`, 'Every entry sent in the month that its statements do not charge, with who logged it, its status and its history.']);
  if (notChargedReceipts.size > 0) contents.push(['Not charged receipts/', 'Their photos, by property.']);

  const records: [string, unknown][] = [
    [`Records/cost_entries ${data.month}.json`, Object.values(data.entries)],
    [`Records/monthly_reports ${data.month}.json`, data.records.monthlyReports],
    [`Records/monthly_report_drafts ${data.month}.json`, data.records.drafts],
    [`Records/report_downloads ${data.month}.json`, data.records.downloads],
    ['Records/property_management.json', data.records.management],
  ];
  for (const [name, value] of records) own.push({ name, data: json(value), source: { made: 'records' }, recordedSha256: null });
  contents.push(['Records/', 'The month’s documents as stored: the entries named here, the statements, drafts and download records, the management records. Storage paths are left out.']);
  contents.push(['manifest.json', 'Every file with its SHA-256 and where it came from.'], ['SHA256SUMS.txt', 'The same hashes, in the form shasum checks.']);
  own.push({ name: 'README.txt', data: nubnbReadme(data, made, contents), source: { made: 'readme' }, recordedSha256: null });

  const sealed = await sealFolder(own, { schemaVersion: 1, kind: 'nubnb-month', month: data.month, property: null, made: { at: data.madeAt, by: made } }, sha256);
  for (const file of sealed) files.push({ path: `${base}/${file.name}`, data: file.data });

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { name: packageFileName(data.month), files };
}
