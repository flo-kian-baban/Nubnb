/**
 * The Toronto month a property's document was created in, from Firestore's
 * own create time (Kian's ruling of 2026-10-03: a property owes statements
 * from the later of September 2026 and the month its document was created).
 *
 * The create time is the document's metadata, never one of its fields:
 * nothing in Nubnb writes it and no form can change it. Every read returns
 * it, a projection (`select`) or a field mask included. The month is the one
 * on the Toronto calendar, as every month in the reports is.
 */

import type { Timestamp } from 'firebase-admin/firestore';
import { torontoDayOf } from '@/app/lib/costs/report';
import { monthOfDay } from '@/app/lib/reports/model';

/** "2026-10" for a document created on 3 October 2026, Toronto time; null when the read carried no create time. */
export function createdMonthOf(createTime: Timestamp | undefined | null): string | null {
  return createTime ? monthOfDay(torontoDayOf(createTime.toDate())) : null;
}
