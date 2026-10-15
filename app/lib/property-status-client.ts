/**
 * Browser-side read for the property list's Income and Cleaning columns (Kian's rulings of 2026-10-15, part A of
 * PROPERTY-LIST-COLUMNS-PLAN.md). Resolves and never throws: the data, checked for shape, or a failure the cells show
 * as not known ("—", the reason in the tooltip), as the Statement column does.
 *
 * Client-safe: the answer's type is imported as a type only; nothing of the server module is bundled.
 */

import { describeErrorBody, readErrorBody } from '@/app/lib/api/http-failure';
import type { PropertyStatusRead } from '@/app/lib/firebase/server-property-status';

export type { PropertyStatusRead };
export type PropertyStatusResult = { ok: true; data: PropertyStatusRead } | { ok: false; title: string };

const isRecord = (data: unknown): data is Record<string, unknown> => !!data && typeof data === 'object' && !Array.isArray(data);
const isCount = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isTextOrNull = (value: unknown) => value === null || typeof value === 'string';

const isFacts = (f: unknown) =>
  isRecord(f) && typeof f.activeTitle === 'boolean' && isCount(f.review) && isCount(f.undecided) && typeof f.missing === 'boolean' && isCount(f.accepted) && typeof f.acceptedCents === 'number' && Number.isSafeInteger(f.acceptedCents);

const isCleaner = (c: unknown) => isRecord(c) && isTextOrNull(c.name) && typeof c.marked === 'boolean' && typeof c.removed === 'boolean' && typeof c.pending === 'boolean';

const DIRECT_STATES = ['expected', 'partly', 'paid', 'overdue', 'paused'];
const isDirect = (d: unknown) =>
  isRecord(d) && DIRECT_STATES.includes(d.state as string) && typeof d.month === 'string' && isTextOrNull(d.dueDate) && typeof d.expectedCents === 'number' && typeof d.receivedCents === 'number' && typeof d.wording === 'string' && isCount(d.overdueMonths);

const isJob = (j: unknown) =>
  isRecord(j) && typeof j.propertyId === 'string' && typeof j.checkout === 'string' && (j.status === 'open' || j.status === 'booking-changed') && typeof j.changedAfterMark === 'boolean' && isTextOrNull(j.change) && Array.isArray(j.cleaners) && j.cleaners.every(isCleaner);

function isAnswer(data: unknown): data is PropertyStatusRead {
  if (!isRecord(data) || typeof data.today !== 'string' || !isRecord(data.income) || !isRecord(data.cleaning) || !isCount(data.unreadable)) return false;
  const { income, cleaning } = data;
  return typeof income.month === 'string' && typeof income.uploaded === 'boolean' && isRecord(income.properties) && Object.values(income.properties).every(isFacts) && isRecord(income.direct) && Object.values(income.direct).every(isDirect) && typeof cleaning.from === 'string' && typeof cleaning.to === 'string' && Array.isArray(cleaning.jobs) && cleaning.jobs.every(isJob);
}

export async function fetchPropertyStatus(): Promise<PropertyStatusResult> {
  const action = 'Loading the income and cleaning status failed';
  let res: Response;
  try {
    res = await fetch('/api/admin/property-status', { cache: 'no-store' });
  } catch (err) {
    return { ok: false, title: `${action}: the server could not be reached.${err instanceof Error ? ` ${err.message}` : ''}` };
  }
  const body = await readErrorBody(res);
  if (!res.ok) return { ok: false, title: describeErrorBody(body, res.status, action).title };
  if (!isAnswer(body.data)) return { ok: false, title: `${action}: the server's answer was not in the expected form.` };
  return { ok: true, data: body.data };
}
