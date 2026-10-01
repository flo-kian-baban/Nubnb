/**
 * The piece of work a handyman is logging (dispatch 24), kept on the phone
 * until the server confirms it, as a cleaner's receipt draft is
 * (cleaner-draft.ts): nothing typed is lost to a dropped connection or a
 * closed page. Text only, in localStorage, under the account's ID.
 *
 * The one-time key works exactly as on a receipt: sent twice, the server
 * finds the first entry and writes nothing new; changed after a send whose
 * outcome is unknown, the work gets a new key.
 *
 * Client-safe. Every storage call is guarded.
 */

import { LIMITS, SUBMISSION_KEY_PATTERN } from '@/app/lib/cleaners/model';
import type { WorkPayload } from '@/app/lib/cleaner-client';
import { newSubmissionKey, readTax } from '@/app/lib/cleaner-draft';

export type WorkStep = 'property' | 'work';

export interface WorkDraft {
  v: 1;
  submissionKey: string;
  propertyId: string | null;
  propertyName: string | null;
  description: string;
  /** As typed on the number pad; read by readPrice below. */
  price: string;
  step: WorkStep;
  /** A send was tried and its outcome is unknown. The next change gets a new key. */
  unconfirmedSend: boolean;
}

const KEY_PREFIX = 'nubnb.cleaner.work.v1.';

export function newWorkDraft(): WorkDraft {
  return { v: 1, submissionKey: newSubmissionKey(), propertyId: null, propertyName: null, description: '', price: '', step: 'property', unconfirmedSend: false };
}

export function isEmptyWorkDraft(draft: WorkDraft): boolean {
  return draft.propertyId === null && draft.description.trim() === '' && draft.price.trim() === '';
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function readWorkDraft(value: unknown): WorkDraft | null {
  if (!isRecord(value) || value.v !== 1) return null;
  const { submissionKey, propertyId, propertyName, description, price, step, unconfirmedSend } = value;
  if (typeof submissionKey !== 'string' || !SUBMISSION_KEY_PATTERN.test(submissionKey)) return null;
  return {
    v: 1,
    submissionKey,
    propertyId: typeof propertyId === 'string' ? propertyId : null,
    propertyName: typeof propertyName === 'string' ? propertyName : null,
    description: typeof description === 'string' ? description : '',
    price: typeof price === 'string' ? price : '',
    step: step === 'work' ? 'work' : 'property',
    unconfirmedSend: unconfirmedSend === true,
  };
}

export function loadWorkDraft(cleanerId: string): WorkDraft | null {
  try {
    const text = window.localStorage.getItem(KEY_PREFIX + cleanerId);
    return text ? readWorkDraft(JSON.parse(text)) : null;
  } catch {
    return null;
  }
}

/** True when the phone kept it. */
export function saveWorkDraft(cleanerId: string, draft: WorkDraft): boolean {
  try {
    window.localStorage.setItem(KEY_PREFIX + cleanerId, JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function clearWorkDraft(cleanerId: string): void {
  try {
    window.localStorage.removeItem(KEY_PREFIX + cleanerId);
  } catch {
    // Nothing kept, nothing to clear.
  }
}

/**
 * The price as typed, in the form the server takes ("185.00"), with its
 * cents; or null. More than $0.00, at most $999,999.99. The same reading a
 * receipt's tax gets ("185", "185,50", "$185.5"), but zero is refused.
 */
export function readPrice(typed: string): { text: string; cents: number } | null {
  const read = readTax(typed);
  return read === null || read.cents <= 0 ? null : read;
}

export interface WorkProblems {
  description?: string;
  price?: string;
}

/** What is missing or unreadable, in a few words each. */
export function workProblems(draft: WorkDraft): WorkProblems {
  const problems: WorkProblems = {};
  const description = draft.description.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (description === '') problems.description = 'Say what you did';
  else if (description.length > LIMITS.WORK_DESCRIPTION_MAX) problems.description = `At most ${LIMITS.WORK_DESCRIPTION_MAX} characters`;
  if (draft.price.trim() === '') problems.price = 'Type the price';
  else if (readPrice(draft.price) === null) problems.price = 'Check the price';
  return problems;
}

/** The draft as the server takes it, or null while anything has a problem. */
export function toWorkPayload(draft: WorkDraft): WorkPayload | null {
  if (draft.propertyId === null || Object.keys(workProblems(draft)).length > 0) return null;
  const price = readPrice(draft.price);
  if (price === null) return null;
  return {
    submissionKey: draft.submissionKey,
    propertyId: draft.propertyId,
    description: draft.description.normalize('NFC').replace(/\s+/g, ' ').trim(),
    price: price.text,
  };
}
