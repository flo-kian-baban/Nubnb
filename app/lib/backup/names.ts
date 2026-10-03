/**
 * Every name in the month's package (FINANCIAL-MANAGEMENT-PLAN.md §2.7.1):
 * the ZIP, the folders, the statement, the workbook, the receipts. One place,
 * so the ZIP an admin downloads and the backup in Drive (the next dispatch)
 * name everything the same way.
 *
 * Names are cleaned of the characters Windows refuses and kept under 120
 * characters, so the ZIP and a folder downloaded from Drive unpack anywhere.
 * Client-safe, and pure.
 */

import { monthLabel, monthName } from '@/app/lib/reports/model';

const REFUSED = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;

/** A name a file system takes: refused characters become "-", spaces collapse, no trailing dot or space, at most `max` characters. */
export function cleanName(value: string, max = 120): string {
  let clean = value.normalize('NFC').replace(REFUSED, '-').replace(/\s+/g, ' ').trim();
  // Never cut a surrogate pair in half.
  if (clean.length > max) clean = Array.from(clean).slice(0, max).join('');
  clean = clean.replace(/[. ]+$/, '');
  return clean === '' ? 'Unnamed' : clean;
}

/** "2026-09 September": the month's folder. */
export function monthFolderName(month: string): string {
  return `${month} ${monthName(month)}`;
}

/** "Nubnb 2026-09 September.zip". */
export function packageFileName(month: string): string {
  return `Nubnb ${monthFolderName(month)}.zip`;
}

/** "Corner Penthouse l Tall Ceiling · 1VpX0w": a property's folder, its name and the first six characters of its ID. */
export function propertyFolderName(name: string | null, propertyId: string): string {
  return `${cleanName(name?.trim() || 'Unnamed property', 100)} · ${propertyId.slice(0, 6)}`;
}

/** The year folder of a month: "2026". */
export function yearOf(month: string): string {
  return month.slice(0, 4);
}

/** `Properties/<property>/<year>/<month>`: where a property's month lives. */
export function propertyMonthPath(folder: string, month: string): string {
  return `Properties/${folder}/${yearOf(month)}/${monthFolderName(month)}`;
}

/** `Nubnb/<year>/<month>`: Nubnb's own month. */
export function nubnbMonthPath(month: string): string {
  return `Nubnb/${yearOf(month)}/${monthFolderName(month)}`;
}

/** "2026-09 Payment Summary Sept-321-John (iDDcBK).pdf"; with no typed reference, "2026-09 Payment Summary (iDDcBK).pdf". */
export function statementFileName(month: string, reference: string | null, reportId: string): string {
  const typed = reference?.trim() ? ` ${cleanName(reference.trim(), 60)}` : '';
  return `${month} Payment Summary${typed} (${reportId.slice(0, 6)}).pdf`;
}

/** "2026-09 Corner Penthouse l Tall Ceiling.xlsx". */
export function workbookFileName(month: string, propertyName: string | null): string {
  return `${month} ${cleanName(propertyName?.trim() || 'Unnamed property', 100)}.xlsx`;
}

/** The extension a receipt's stored type gives. */
export function receiptExtension(contentType: string | null): string {
  if (contentType === 'image/png') return 'png';
  if (contentType === 'image/webp') return 'webp';
  return 'jpg';
}

/**
 * "2026-09-03 ref ykHRE5.jpg": the day it was sent and its ref, the two
 * things the statement prints for it. `(2 of 2)` when an entry has more than
 * one receipt; ` - rejected` and the like for a receipt not charged.
 */
export function receiptFileName(input: { day: string | null; entryId: string; index: number; of: number; contentType: string | null; status?: string | null }): string {
  const which = input.of > 1 ? ` (${input.index + 1} of ${input.of})` : '';
  const status = input.status ? ` - ${cleanName(input.status, 20)}` : '';
  return `${input.day ?? 'undated'} ref ${input.entryId.slice(0, 6)}${which}${status}.${receiptExtension(input.contentType)}`;
}

/**
 * Names that differ only by letter case clash on the Windows and macOS file
 * systems: each such name takes `(<the full ID>)` before its extension.
 * `items` are the would-be names with the ID that tells them apart.
 */
export function distinctNames<T extends { name: string; id: string }>(items: T[]): (T & { name: string })[] {
  const seen = new Map<string, number>();
  for (const item of items) seen.set(item.name.toLowerCase(), (seen.get(item.name.toLowerCase()) ?? 0) + 1);
  return items.map((item) => {
    if ((seen.get(item.name.toLowerCase()) ?? 0) < 2) return item;
    const dot = item.name.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [item.name.slice(0, dot), item.name.slice(dot)] : [item.name, ''];
    return { ...item, name: `${stem} (${item.id})${ext}` };
  });
}

/** "September 2026", for a sentence. */
export function monthWords(month: string): string {
  return monthLabel(month);
}
