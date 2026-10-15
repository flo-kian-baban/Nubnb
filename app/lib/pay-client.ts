/**
 * Browser-side calls for team pay (Kian's rulings of 2026-10-15, in CLAUDE.md under *Team pay*): the payments the Team
 * page and a person's pay page read, recording one, and deleting one.
 *
 * Every call resolves and never throws, as in schedule-client.ts: an answer is either the data, checked for shape, or
 * a failure fit to show as a Notice, saying when it is not known whether a write landed.
 *
 * Client-safe: it imports only the pay model and the shared error reading.
 */

import { describeErrorBody, readErrorBody } from '@/app/lib/api/http-failure';
import type { PaymentMethod, PaymentView } from '@/app/lib/pay/model';

export type PayResult<T> = { ok: true; data: T } | { ok: false; status: number; title: string; detail?: string; code?: string; unknown: boolean };

const isRecord = (data: unknown): data is Record<string, unknown> => !!data && typeof data === 'object' && !Array.isArray(data);

async function call<T>(url: string, init: RequestInit, action: string, isExpected: (data: unknown) => boolean, unconfirmedCodes: readonly string[] = []): Promise<PayResult<T>> {
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

const isPayment = (value: unknown): value is PaymentView =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.memberId === 'string' &&
  typeof value.amountCents === 'number' &&
  typeof value.day === 'string' &&
  typeof value.method === 'string' &&
  (value.status === 'recorded' || value.status === 'deleted') &&
  typeof value.recordedAt === 'string' &&
  isRecord(value.recordedBy) &&
  Array.isArray(value.history);

/** Every payment, recorded or deleted, and how many could not be read. */
export function fetchPayments(): Promise<PayResult<{ payments: PaymentView[]; unreadable: number }>> {
  return call('/api/admin/payments', {}, 'Loading the payments failed', (data) => isRecord(data) && Array.isArray(data.payments) && data.payments.every(isPayment) && typeof data.unreadable === 'number');
}

/** Record a payment (ruling 2): the amount as typed, "300.00". PAYMENT_RECORD_FAILED: it may or may not have landed. */
export function recordPayment(request: { memberId: string; amount: string; day: string; method: PaymentMethod; note: string | null }): Promise<PayResult<{ payment: PaymentView }>> {
  return call(
    '/api/admin/payments',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) },
    'Recording the payment failed',
    (data) => isRecord(data) && isPayment(data.payment),
    ['PAYMENT_RECORD_FAILED'],
  );
}

/** Delete a payment, as the page saw it (`seen`: its history's length): marked deleted, kept in the person's history (ruling 4). */
export function deletePayment(id: string, seen: number): Promise<PayResult<{ payment: PaymentView }>> {
  return call(
    `/api/admin/payments/${encodeURIComponent(id)}`,
    { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seen }) },
    'Deleting the payment failed',
    (data) => isRecord(data) && isPayment(data.payment) && data.payment.id === id,
    ['PAYMENT_DELETE_FAILED'],
  );
}
