/**
 * The receipt a cleaner is working on, kept on the phone until the server
 * confirms it — so nothing typed is lost to a dropped connection, a closed
 * page, a flat battery or a session that ended.
 *
 * ── Where ──
 * One draft per cleaner per phone. The text goes to localStorage, the photo
 * to IndexedDB (too large for localStorage), both under the cleaner's ID.
 * Another cleaner signing in on the same phone gets their own draft and never
 * sees this one. Both are removed only once a send is confirmed. The photo
 * carries a `photoKey` that the draft names, so a photo left behind by an
 * earlier receipt is never taken for this one's.
 *
 * ── The one-time key ──
 * Each draft carries the `submissionKey` its send uses. Sent twice — because
 * the answer to the first send was lost — the server finds the first entry
 * and records nothing new. If the receipt is changed after a send whose
 * outcome is unknown, it is no longer the same receipt: it gets a new key.
 *
 * ── Reading what was typed ──
 * Prices and quantities are typed on a number pad, so "7,98", "$8" and ".5"
 * are read as a person means them and written in the form the server takes:
 * two decimals for a price, no leading zeros for a quantity. The price is the
 * amount printed on that receipt line (D1); quantity is never multiplied.
 *
 * Client-safe. Every storage call is guarded: a phone that refuses storage
 * (a private window, a full disk) still works, it just keeps nothing.
 */

import { LIMITS, SUBMISSION_KEY_PATTERN } from '@/app/lib/cleaners/model';
import type { EntryPayload } from '@/app/lib/cleaner-client';

export type Step = 'property' | 'photo' | 'items';

export const STEPS: readonly Step[] = ['property', 'photo', 'items'];

export interface DraftLine {
  /** For React only; never sent. */
  key: string;
  name: string;
  quantity: string;
  price: string;
}

export interface Draft {
  v: 1;
  submissionKey: string;
  propertyId: string | null;
  /** Kept beside the ID, so the draft still names the property if the list has not loaded. */
  propertyName: string | null;
  lines: DraftLine[];
  /** The stored photo that belongs to this draft; null before one is taken. */
  photoKey: string | null;
  step: Step;
  /** A send was tried and its outcome is unknown. The next change to the receipt gets it a new key. */
  unconfirmedSend: boolean;
}

/** A prepared receipt photo, as kept in IndexedDB. */
export interface StoredPhoto {
  /** Matches the `photoKey` of the draft it belongs to. */
  photoKey: string;
  blob: Blob;
  /** The file name to send: the original's, as a .jpg. */
  name: string;
  width: number;
  height: number;
}

const DRAFT_KEY_PREFIX = 'nubnb.cleaner.draft.v1.';
const DB_NAME = 'nubnb-cleaner';
const DB_VERSION = 1;
const PHOTO_STORE = 'photos';

// ─── Keys ──────────────────────────────────────────────────────

/** A random version 4 UUID, lowercase, as the server's SUBMISSION_KEY_PATTERN expects. */
export function newSubmissionKey(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function lineKey(): string {
  return newSubmissionKey().slice(0, 8);
}

export function newLine(): DraftLine {
  return { key: lineKey(), name: '', quantity: '1', price: '' };
}

export function newDraft(): Draft {
  return {
    v: 1,
    submissionKey: newSubmissionKey(),
    propertyId: null,
    propertyName: null,
    lines: [newLine()],
    photoKey: null,
    step: 'property',
    unconfirmedSend: false,
  };
}

/** A draft with nothing in it yet: not worth keeping. */
export function isEmptyDraft(draft: Draft): boolean {
  return (
    draft.propertyId === null &&
    draft.photoKey === null &&
    draft.lines.every((line) => line.name.trim() === '' && line.price.trim() === '')
  );
}

// ─── Text: localStorage ────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function readLine(value: unknown): DraftLine | null {
  if (!isRecord(value)) return null;
  const { key, name, quantity, price } = value;
  if (typeof name !== 'string' || typeof quantity !== 'string' || typeof price !== 'string') return null;
  return { key: typeof key === 'string' && key ? key : lineKey(), name, quantity, price };
}

/** A stored draft, or null if there is none or it is not one this code wrote. */
function readDraft(value: unknown): Draft | null {
  if (!isRecord(value) || value.v !== 1) return null;
  const { submissionKey, propertyId, propertyName, lines, photoKey, step, unconfirmedSend } = value;
  if (typeof submissionKey !== 'string' || !SUBMISSION_KEY_PATTERN.test(submissionKey)) return null;
  if (!Array.isArray(lines)) return null;
  const read = lines.map(readLine).filter((line): line is DraftLine => line !== null);
  return {
    v: 1,
    submissionKey,
    propertyId: typeof propertyId === 'string' ? propertyId : null,
    propertyName: typeof propertyName === 'string' ? propertyName : null,
    lines: read.length > 0 ? read : [newLine()],
    photoKey: typeof photoKey === 'string' ? photoKey : null,
    step: STEPS.includes(step as Step) ? (step as Step) : 'property',
    unconfirmedSend: unconfirmedSend === true,
  };
}

export function loadDraft(cleanerId: string): Draft | null {
  try {
    const text = window.localStorage.getItem(DRAFT_KEY_PREFIX + cleanerId);
    return text ? readDraft(JSON.parse(text)) : null;
  } catch {
    return null;
  }
}

/** True when the phone kept it. */
export function saveDraft(cleanerId: string, draft: Draft): boolean {
  try {
    window.localStorage.setItem(DRAFT_KEY_PREFIX + cleanerId, JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function clearDraft(cleanerId: string): void {
  try {
    window.localStorage.removeItem(DRAFT_KEY_PREFIX + cleanerId);
  } catch {
    // Nothing kept, nothing to clear.
  }
}

// ─── Photo: IndexedDB ──────────────────────────────────────────

function openPhotos(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(PHOTO_STORE)) {
        request.result.createObjectStore(PHOTO_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
}

/** Run one request against the photo store, and close the database after. */
async function withPhotos<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  const db = await openPhotos();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(PHOTO_STORE, mode);
      const request = run(tx.objectStore(PHOTO_STORE));
      tx.oncomplete = () => resolve(request.result as T);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

function readPhoto(value: unknown): StoredPhoto | null {
  if (!isRecord(value)) return null;
  const { photoKey, blob, name, width, height } = value;
  if (typeof photoKey !== 'string' || !(blob instanceof Blob)) return null;
  return {
    photoKey,
    blob,
    name: typeof name === 'string' ? name : 'receipt.jpg',
    width: typeof width === 'number' ? width : 0,
    height: typeof height === 'number' ? height : 0,
  };
}

/** The photo kept for this cleaner, if it is the one `photoKey` names. */
export async function loadPhoto(cleanerId: string, photoKey: string | null): Promise<StoredPhoto | null> {
  if (photoKey === null) return null;
  try {
    const photo = readPhoto(await withPhotos<unknown>('readonly', (store) => store.get(cleanerId)));
    return photo?.photoKey === photoKey ? photo : null;
  } catch {
    return null;
  }
}

/** True when the phone kept it. */
export async function savePhoto(cleanerId: string, photo: StoredPhoto): Promise<boolean> {
  try {
    await withPhotos('readwrite', (store) => store.put(photo, cleanerId));
    return true;
  } catch {
    return false;
  }
}

export async function clearPhoto(cleanerId: string): Promise<void> {
  try {
    await withPhotos('readwrite', (store) => store.delete(cleanerId));
  } catch {
    // Nothing kept, nothing to clear.
  }
}

// ─── Reading what was typed ────────────────────────────────────

/**
 * A price as typed, in the form the server takes ("7.98"), with its cents;
 * or null if it is not a price. More than $0.00 and at most $999,999.99.
 *   "7,98" → 7.98   "$8" → 8.00   ".5" → 0.50   "1,234.50" → 1234.50
 */
export function readPrice(typed: string): { text: string; cents: number } | null {
  let value = typed.replace(/[\s$]/g, '');
  if (value.includes('.')) {
    value = value.replace(/,/g, '');
  } else {
    // A single comma before one or two final digits is a decimal comma;
    // any other comma separates thousands.
    value = /^\d*,\d{1,2}$/.test(value) ? value.replace(',', '.') : value.replace(/,/g, '');
  }

  const match = /^(\d{0,6})(?:\.(\d{0,2}))?$/.exec(value);
  if (!match || (match[1] === '' && !match[2])) return null;

  const whole = Number(match[1] || '0');
  const fraction = (match[2] ?? '').padEnd(2, '0');
  const cents = whole * 100 + Number(fraction);
  if (cents <= 0 || cents > LIMITS.LINE_TOTAL_MAX_CENTS) return null;
  return { text: `${whole}.${fraction}`, cents };
}

/**
 * A quantity as typed, in the form the server takes ("2", "1.5"), or null.
 * More than 0, at most 99999.999, three decimals at most.
 */
export function readQuantity(typed: string): string | null {
  const value = typed.replace(/\s/g, '').replace(',', '.');
  const match = /^(\d{1,5})(?:\.(\d{1,3}))?$/.exec(value);
  if (!match) return null;
  const text = match[2] ? `${Number(match[1])}.${match[2]}` : String(Number(match[1]));
  return Number(text) > 0 ? text : null;
}

/** One more or one fewer, never below 1 by the buttons (1.5 goes down to 1); three decimals kept. */
export function stepQuantity(typed: string, by: 1 | -1): string {
  const current = Number(readQuantity(typed) ?? '1');
  const next = Math.round((current + by) * 1000) / 1000;
  if (next < 1) return String(current > 1 ? 1 : current);
  return String(Math.min(next, LIMITS.QUANTITY_MAX));
}

export interface LineProblems {
  name?: string;
  quantity?: string;
  price?: string;
}

/** What is missing or unreadable on a line, in a few words each. */
export function lineProblems(line: DraftLine): LineProblems {
  const problems: LineProblems = {};
  if (line.name.trim() === '') problems.name = 'Type the item';
  if (readQuantity(line.quantity) === null) problems.quantity = 'Check how many';
  if (line.price.trim() === '') problems.price = 'Type the amount';
  else if (readPrice(line.price) === null) problems.price = 'Check the amount';
  return problems;
}

export function hasProblems(problems: LineProblems): boolean {
  return Object.keys(problems).length > 0;
}

/** The sum of the prices that can be read, in cents. For display only; never stored. */
export function totalCents(lines: DraftLine[]): number {
  return lines.reduce((sum, line) => sum + (readPrice(line.price)?.cents ?? 0), 0);
}

/** The draft as the server takes it, or null while any line has a problem. */
export function toEntryPayload(draft: Draft): EntryPayload | null {
  if (draft.propertyId === null) return null;
  const lines: EntryPayload['lines'] = [];
  for (const line of draft.lines) {
    const quantity = readQuantity(line.quantity);
    const price = readPrice(line.price);
    const name = line.name.normalize('NFC').trim().replace(/\s+/g, ' ');
    if (!name || quantity === null || price === null) return null;
    lines.push({ name, quantity, lineTotal: price.text });
  }
  return { submissionKey: draft.submissionKey, propertyId: draft.propertyId, lines };
}
