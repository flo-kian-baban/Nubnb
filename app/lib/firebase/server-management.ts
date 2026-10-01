/**
 * The per-property management record (dispatch 23B, Kian's decision 4 of
 * 2026-09-30; "Report For" and the default fee rate, dispatch 23E):
 * `property_management/{propertyId}`, server-only, set whole from the
 * property form as the cleaner-facing name is, never on the world-readable
 * property document. It holds "Report For" — the name and postal address a
 * statement prints, which the statement editor can also set on its own
 * through `setReportFor` — the owners' names and optional emails (kept for
 * a later sending decision; nothing sends), the month statements start
 * from, optionally the month they stop, the default fee rate a new
 * statement starts from, and the default fee amount of dispatch 23B, read
 * and kept, no longer used. A property without a record expects statements
 * from STATEMENTS_FROM_DEFAULT, prints no "Report For" block, and has no
 * default rate.
 */

import { z } from 'zod';
import { getAdminDb } from './admin';
import { isDocumentId } from './server-leads';
import { toCents } from './server-cost-entries';
import {
  PROPERTY_MANAGEMENT_COLLECTION,
  PROPERTY_MANAGEMENT_SCHEMA_VERSION,
  STATEMENTS_FROM_DEFAULT,
  STATEMENT_LIMITS,
  isMonth,
  readPropertyManagement,
  type PropertyManagement,
  type PropertyManagementView,
  type ReportFor,
} from '@/app/lib/reports/model';

const CONTROL_CHARACTER = /\p{Cc}/u;
const AMOUNT = /^(0|[1-9][0-9]{0,5})\.[0-9]{2}$/;
/** A rate as typed, "20" or "12.5", at most two decimals, 0–100. */
const RATE = /^(100(\.0{1,2})?|[0-9]{1,2}(\.[0-9]{1,2})?)$/;

const text = (max: number, what: string) =>
  z
    .string()
    .transform((s) => s.normalize('NFC').replace(/\s+/g, ' ').trim())
    .pipe(z.string().min(1, what).max(max, `At most ${max} characters`).refine((s) => !CONTROL_CHARACTER.test(s), 'No control characters'));

/** "20" or "12.5" as basis points: 2000, 1250. */
export function toBasisPoints(rate: string): number {
  const [whole, rest = ''] = rate.split('.');
  return Number(whole) * 100 + Number(rest.padEnd(2, '0').slice(0, 2));
}

/** The legacy default fee as typed (dispatch 23B): a label and "150.00"; stored as cents. Taken when sent, so a record round-trips. */
export const FeeInputSchema = z
  .strictObject({
    label: text(STATEMENT_LIMITS.FEE_LABEL_MAX, 'Label the fee'),
    amount: z.string().regex(AMOUNT, 'An amount with two decimals, like 150.00').transform(toCents),
  })
  .transform((fee) => ({ label: fee.label, amountCents: fee.amount }));

/** "Report For" as typed: a name, and an address of up to six lines, line breaks kept. */
export const ReportForInputSchema = z
  .strictObject({
    name: text(STATEMENT_LIMITS.REPORT_FOR_NAME_MAX, 'Name who the report is for'),
    address: z
      .string()
      .transform((s) =>
        s
          .normalize('NFC')
          .replace(/\r\n/g, '\n')
          .split('\n')
          .map((line) => line.replace(/\s+/g, ' ').trim())
          .filter((line, i, all) => line !== '' || (i > 0 && i < all.length - 1))
          .join('\n')
          .trim(),
      )
      .pipe(
        z
          .string()
          .max(STATEMENT_LIMITS.REPORT_FOR_ADDRESS_MAX, `At most ${STATEMENT_LIMITS.REPORT_FOR_ADDRESS_MAX} characters`)
          .refine((s) => s.split('\n').length <= STATEMENT_LIMITS.REPORT_FOR_ADDRESS_LINES_MAX, `At most ${STATEMENT_LIMITS.REPORT_FOR_ADDRESS_LINES_MAX} lines`)
          .refine((s) => !CONTROL_CHARACTER.test(s.replace(/\n/g, '')), 'No control characters other than line breaks'),
      ),
  })
  .transform((value): ReportFor => ({ name: value.name, address: value.address }));

/** The record as the property form saves it. Strict: any other key is refused. */
export const ManagementInputSchema = z
  .strictObject({
    reportFor: ReportForInputSchema.nullable().optional(),
    owners: z
      .array(
        z.strictObject({
          name: text(STATEMENT_LIMITS.OWNER_NAME_MAX, 'Name the owner'),
          email: z
            .string()
            .transform((s) => s.trim())
            .pipe(z.string().max(STATEMENT_LIMITS.OWNER_EMAIL_MAX, `At most ${STATEMENT_LIMITS.OWNER_EMAIL_MAX} characters`).refine((s) => s === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s), 'Not an email address'))
            .nullable()
            .optional()
            .transform((value) => (value ? value : null)),
        }),
      )
      .max(STATEMENT_LIMITS.OWNERS_MAX, `At most ${STATEMENT_LIMITS.OWNERS_MAX} owners`),
    statementsFrom: z.string().refine(isMonth, 'A month, like 2026-10'),
    statementsUntil: z.string().refine(isMonth, 'A month, like 2027-03').nullable(),
    /** "20" or "12.5"; null for none. */
    defaultFeeRate: z.string().regex(RATE, 'A rate in percent, like 20 or 12.5').transform(toBasisPoints).nullable().optional(),
    defaultFee: FeeInputSchema.nullable().optional(),
  })
  .superRefine((body, ctx) => {
    if (body.statementsUntil !== null && body.statementsUntil < body.statementsFrom) {
      ctx.addIssue({ code: 'custom', path: ['statementsUntil'], message: 'The last month is before the first' });
    }
  });

export type ManagementInput = z.output<typeof ManagementInputSchema>;

/** One property's record, or null when it has none. @throws if the read fails. */
export async function getManagement(propertyId: string): Promise<PropertyManagementView | null> {
  if (!isDocumentId(propertyId)) return null;
  const doc = await getAdminDb().collection(PROPERTY_MANAGEMENT_COLLECTION).doc(propertyId).get();
  return doc.exists ? readPropertyManagement(doc.id, doc.data() ?? {}) : null;
}

/** Every record. One read per document; a document not in shape is left out and logged. @throws if the read fails. */
export async function listManagement(): Promise<PropertyManagementView[]> {
  const snapshot = await getAdminDb().collection(PROPERTY_MANAGEMENT_COLLECTION).get();
  const records: PropertyManagementView[] = [];
  for (const doc of snapshot.docs) {
    const record = readPropertyManagement(doc.id, doc.data());
    if (record) records.push(record);
    else console.error(`[management] property_management/${doc.id} is not in the written shape; left out`);
  }
  return records;
}

export type SetManagementResult = { kind: 'set'; record: PropertyManagementView } | { kind: 'cleared' } | { kind: 'no-such-property' };

/** The record as stored, from the form's input; absent optional fields keep what is stored. */
function stored(propertyId: string, input: ManagementInput, was: PropertyManagementView | null): PropertyManagement {
  return {
    schemaVersion: PROPERTY_MANAGEMENT_SCHEMA_VERSION,
    propertyId,
    reportFor: input.reportFor === undefined ? (was?.reportFor ?? null) : input.reportFor,
    owners: input.owners.map((owner) => ({ name: owner.name, email: owner.email })),
    statementsFrom: input.statementsFrom,
    statementsUntil: input.statementsUntil,
    defaultFeeRateBasisPoints: input.defaultFeeRate === undefined ? (was?.defaultFeeRateBasisPoints ?? null) : input.defaultFeeRate,
    defaultFee: input.defaultFee === undefined ? (was?.defaultFee ?? null) : input.defaultFee,
    setAt: new Date().toISOString(),
  };
}

/**
 * Set a property's record whole, or clear it (`null`). The property must
 * exist; the property document is never touched.
 *
 * @throws if a read or write fails.
 */
export async function setManagement(propertyId: string, input: ManagementInput | null): Promise<SetManagementResult> {
  if (!isDocumentId(propertyId)) return { kind: 'no-such-property' };
  const db = getAdminDb();
  const [property] = await db.getAll(db.collection('properties').doc(propertyId), { fieldMask: ['name'] });
  if (!property.exists) return { kind: 'no-such-property' };
  const ref = db.collection(PROPERTY_MANAGEMENT_COLLECTION).doc(propertyId);
  if (input === null) {
    await ref.delete();
    return { kind: 'cleared' };
  }
  const was = await ref.get();
  const record = stored(propertyId, input, was.exists ? readPropertyManagement(was.id, was.data() ?? {}) : null);
  await ref.set(record);
  return { kind: 'set', record: readPropertyManagement(propertyId, record as unknown as Record<string, unknown>)! };
}

export type SetReportForResult = { kind: 'set'; record: PropertyManagementView } | { kind: 'no-such-property' };

/**
 * Set "Report For" alone, from the statement editor (dispatch 23E): the one
 * field is merged into the record, which is created with its defaults when
 * the property has none, so the unit's info and the editor read the same
 * document. Null clears the field; the record stays.
 *
 * @throws if a read or write fails.
 */
export async function setReportFor(propertyId: string, reportFor: ReportFor | null): Promise<SetReportForResult> {
  if (!isDocumentId(propertyId)) return { kind: 'no-such-property' };
  const db = getAdminDb();
  const [property] = await db.getAll(db.collection('properties').doc(propertyId), { fieldMask: ['name'] });
  if (!property.exists) return { kind: 'no-such-property' };
  const ref = db.collection(PROPERTY_MANAGEMENT_COLLECTION).doc(propertyId);
  const record = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const was = snap.exists ? readPropertyManagement(snap.id, snap.data() ?? {}) : null;
    const now = new Date().toISOString();
    if (snap.exists && was === null) throw new Error(`property_management/${propertyId} is not in the written shape`);
    const next: PropertyManagement = was
      ? { ...was, reportFor, setAt: now }
      : { schemaVersion: PROPERTY_MANAGEMENT_SCHEMA_VERSION, propertyId, reportFor, owners: [], statementsFrom: STATEMENTS_FROM_DEFAULT, statementsUntil: null, defaultFeeRateBasisPoints: null, defaultFee: null, setAt: now };
    const { id: _id, ...fields } = next as PropertyManagement & { id?: string };
    void _id;
    tx.set(ref, fields);
    return fields;
  });
  return { kind: 'set', record: readPropertyManagement(propertyId, record as unknown as Record<string, unknown>)! };
}
