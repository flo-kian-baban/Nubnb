/**
 * Browser-side calls for direct payments (part B of PROPERTY-LIST-COLUMNS-PLAN.md, Kian's rulings of 2026-10-15).
 *
 * Every call resolves and never throws, as in schedule-client.ts: an answer is either the data, checked for shape, or
 * a failure fit to show as a Notice, saying when it is not known whether a write landed.
 *
 * Client-safe: it imports only the direct model and the shared error reading.
 */

import { describeErrorBody, readErrorBody } from '@/app/lib/api/http-failure';
import type { ArrangementView, DirectMethod, DirectPaymentView, OneOffPurpose } from '@/app/lib/direct/model';

export type DirectResult<T> = { ok: true; data: T } | { ok: false; status: number; title: string; detail?: string; code?: string; unknown: boolean };

const isRecord = (data: unknown): data is Record<string, unknown> => !!data && typeof data === 'object' && !Array.isArray(data);

async function call<T>(url: string, init: RequestInit, action: string, isExpected: (data: unknown) => boolean, unconfirmedCodes: readonly string[]): Promise<DirectResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, cache: 'no-store' });
  } catch (err) {
    return { ok: false, status: 0, title: `${action}: the server could not be reached.`, detail: err instanceof Error ? err.message : undefined, unknown: true };
  }
  const body = await readErrorBody(res);
  if (!res.ok) {
    const failure = describeErrorBody(body, res.status, action);
    const code = typeof body.code === 'string' ? body.code : undefined;
    return { ok: false, status: failure.status, title: failure.title, detail: failure.detail, code, unknown: res.status >= 500 || (code !== undefined && unconfirmedCodes.includes(code)) };
  }
  if (!isExpected(body.data)) return { ok: false, status: res.status, title: `${action}: the server's answer was not in the expected form.`, detail: 'Nothing is shown rather than something that might be wrong.', unknown: true };
  return { ok: true, data: body.data as T };
}

const isArrangement = (value: unknown): boolean =>
  isRecord(value) && typeof value.id === 'string' && typeof value.propertyId === 'string' && typeof value.payerName === 'string' && typeof value.wording === 'string' && typeof value.dueDay === 'number' && typeof value.fromMonth === 'string' && (value.untilMonth === null || typeof value.untilMonth === 'string') && Array.isArray(value.amounts) && Array.isArray(value.pauses) && Array.isArray(value.history);
const isPayment = (value: unknown): boolean =>
  isRecord(value) && typeof value.id === 'string' && typeof value.propertyId === 'string' && (value.arrangementId === null || typeof value.arrangementId === 'string') && typeof value.day === 'string' && typeof value.amountCents === 'number' && typeof value.method === 'string' && typeof value.wording === 'string' && (value.appliesTo === null || Array.isArray(value.appliesTo)) && (value.status === 'recorded' || value.status === 'removed') && isRecord(value.recordedBy) && Array.isArray(value.history);

export interface DirectAnswer {
  arrangements: ArrangementView[];
  payments: DirectPaymentView[];
  unreadable: number;
  today: string;
}

/** Every arrangement and payment, or one property's. */
export function fetchDirect(propertyId?: string): Promise<DirectResult<DirectAnswer>> {
  return call(
    `/api/admin/direct${propertyId ? `?property=${encodeURIComponent(propertyId)}` : ''}`,
    {},
    'Loading the direct payments failed',
    (data) => isRecord(data) && Array.isArray(data.arrangements) && data.arrangements.every(isArrangement) && Array.isArray(data.payments) && data.payments.every(isPayment) && typeof data.unreadable === 'number' && typeof data.today === 'string',
    [],
  );
}

const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export function startArrangement(input: { propertyId: string; payerName: string; wording: string; amount: string; dueDay: number; fromMonth: string }): Promise<DirectResult<{ arrangement: ArrangementView }>> {
  return call('/api/admin/direct/arrangements', json('POST', input), 'Starting the arrangement failed', (data) => isRecord(data) && isArrangement(data.arrangement), ['ARRANGEMENT_SAVE_FAILED']);
}

export type ArrangementChangeInput = { action: 'pause' | 'resume' | 'end'; month: string } | { action: 'amount'; month: string; amount: string };

export function changeArrangement(id: string, seen: number, change: ArrangementChangeInput): Promise<DirectResult<{ arrangement: ArrangementView }>> {
  return call(`/api/admin/direct/arrangements/${encodeURIComponent(id)}`, json('PATCH', { ...change, seen }), 'Changing the arrangement failed', (data) => isRecord(data) && isArrangement(data.arrangement) && (data.arrangement as { id: string }).id === id, ['ARRANGEMENT_SAVE_FAILED']);
}

export interface RecordInput {
  propertyId: string;
  arrangementId: string | null;
  purpose: OneOffPurpose | null;
  payerName: string | null;
  /** A one-off stay's first night and checkout day; null otherwise. */
  stay: { from: string; to: string } | null;
  day: string;
  amount: string;
  method: DirectMethod;
  wording: string;
  note: string | null;
  appliesTo: { month: string; amount: string }[] | null;
}

export function recordDirectPayment(input: RecordInput): Promise<DirectResult<{ payment: DirectPaymentView }>> {
  return call('/api/admin/direct/payments', json('POST', input), 'Recording the payment failed', (data) => isRecord(data) && isPayment(data.payment), ['DIRECT_PAYMENT_SAVE_FAILED']);
}

export function removeDirectPayment(id: string, seen: number): Promise<DirectResult<{ payment: DirectPaymentView }>> {
  return call(`/api/admin/direct/payments/${encodeURIComponent(id)}`, json('PATCH', { action: 'remove', seen }), 'Removing the payment failed', (data) => isRecord(data) && isPayment(data.payment), ['DIRECT_PAYMENT_SAVE_FAILED']);
}

export function applyDirectPayment(id: string, seen: number, appliesTo: { month: string; amount: string }[] | null): Promise<DirectResult<{ payment: DirectPaymentView }>> {
  return call(`/api/admin/direct/payments/${encodeURIComponent(id)}`, json('PATCH', { action: 'apply', seen, appliesTo }), 'Setting the months failed', (data) => isRecord(data) && isPayment(data.payment), ['DIRECT_PAYMENT_SAVE_FAILED']);
}
