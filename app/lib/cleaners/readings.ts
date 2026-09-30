/**
 * The signed reading record (dispatch 20): what the read route hands the
 * phone, and what the phone hands back with the entry.
 *
 * The reading happens before the entry exists, so its record travels on the
 * phone in the draft until Send. To keep it evidence rather than a claim,
 * the server signs the exact text it returns, and the entry route accepts
 * a record only when the text comes back byte for byte with a valid
 * signature and the cleaner ID inside is the session's. The phone cannot
 * change what the model said, and a record cannot be moved between
 * cleaners.
 *
 * The key is derived from CLEANER_SESSION_SECRET under its own label, so it
 * is not the session MAC key, and rotating the secret voids readings in
 * flight along with every session — an entry sent after that is written
 * without its reading, and says so.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { readReadingRecord, type ReadingRecord } from './model';

const KEY_LABEL = 'nubnb:receipt-reading-key:v1';
const MAC_LABEL = 'nubnb:receipt-reading:v1:';

/** The 43-character base64url of a 32-byte MAC. */
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** The reading key, derived from the cleaner session key. */
export function readingKey(sessionKey: Buffer): Buffer {
  return createHmac('sha256', sessionKey).update(KEY_LABEL, 'utf8').digest();
}

/** The MAC of a record's exact text. */
function macOf(key: Buffer, text: string): string {
  return createHmac('sha256', key).update(MAC_LABEL, 'utf8').update(text, 'utf8').digest('base64url');
}

/** A record as text, with its signature. The text is what the phone keeps and returns. */
export function signReading(record: ReadingRecord, key: Buffer): { readingText: string; signature: string } {
  const readingText = JSON.stringify(record);
  return { readingText, signature: macOf(key, readingText) };
}

/**
 * The record inside `readingText`, if the signature is this server's over
 * exactly that text and the record names `cleanerId`; else null.
 */
export function verifyReading(readingText: string, signature: string, key: Buffer, cleanerId: string): ReadingRecord | null {
  if (!SIGNATURE_PATTERN.test(signature)) return null;
  const given = Buffer.from(signature, 'base64url');
  const expected = Buffer.from(macOf(key, readingText), 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readingText);
  } catch {
    return null;
  }
  const record = readReadingRecord(parsed);
  return record && record.cleanerId === cleanerId ? record : null;
}

// ─── The `reading` part of an entry ────────────────────────────

/**
 * A reading the phone carried back with the entry, verified: the record,
 * and for each entry line, in order, the index of the model line it was
 * filled from, or null for a line the cleaner added. Written beside the
 * entry, in its own document, and never into it.
 */
export interface ReadingAttachment {
  record: ReadingRecord;
  fromReading: (number | null)[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * The `reading` part, or null when it is not `{ readingText, signature,
 * fromReading }` with a record this server signed for this cleaner and a
 * `fromReading` of exactly `lineCount` entries, each null or a distinct
 * index into the record's lines.
 */
export function parseReadingPart(text: string, sessionKey: Buffer, cleanerId: string, lineCount: number): ReadingAttachment | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.readingText !== 'string' || typeof parsed.signature !== 'string') return null;
  if (!Array.isArray(parsed.fromReading) || parsed.fromReading.length !== lineCount) return null;

  const record = verifyReading(parsed.readingText, parsed.signature, readingKey(sessionKey), cleanerId);
  if (!record) return null;

  const modelLines = record.output?.lines.length ?? 0;
  const seen = new Set<number>();
  const fromReading: (number | null)[] = [];
  for (const from of parsed.fromReading) {
    if (from === null) {
      fromReading.push(null);
      continue;
    }
    if (typeof from !== 'number' || !Number.isInteger(from) || from < 0 || from >= modelLines || seen.has(from)) return null;
    seen.add(from);
    fromReading.push(from);
  }
  return { record, fromReading };
}
