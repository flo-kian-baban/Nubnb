/**
 * The per-property management record (dispatch 23B, Kian's decision 4 of
 * 2026-09-30): `property_management/{propertyId}`, server-only, set whole on
 * save as the cleaner-facing name is, never on the world-readable property
 * document. It holds the co-owners' names and optional emails (kept for a
 * later sending decision; nothing sends), the month statements start from,
 * optionally the month they stop, and the default management fee (an
 * amount and a label; never a rate). A property without a record expects
 * statements from STATEMENTS_FROM_DEFAULT, is addressed as "the owners of
 * <property>", and has no default fee.
 */

import { z } from 'zod';
import { getAdminDb } from './admin';
import { isDocumentId } from './server-leads';
import { toCents } from './server-cost-entries';
import {
  PROPERTY_MANAGEMENT_COLLECTION,
  PROPERTY_MANAGEMENT_SCHEMA_VERSION,
  STATEMENT_LIMITS,
  isMonth,
  readPropertyManagement,
  type PropertyManagementView,
} from '@/app/lib/reports/model';

const CONTROL_CHARACTER = /\p{Cc}/u;
const AMOUNT = /^(0|[1-9][0-9]{0,5})\.[0-9]{2}$/;

const text = (max: number, what: string) =>
  z
    .string()
    .transform((s) => s.normalize('NFC').replace(/\s+/g, ' ').trim())
    .pipe(z.string().min(1, what).max(max, `At most ${max} characters`).refine((s) => !CONTROL_CHARACTER.test(s), 'No control characters'));

/** The fee as typed: a label and "150.00", zero or more; stored as cents. */
export const FeeInputSchema = z
  .strictObject({
    label: text(STATEMENT_LIMITS.FEE_LABEL_MAX, 'Label the fee'),
    amount: z.string().regex(AMOUNT, 'An amount with two decimals, like 150.00').transform(toCents),
  })
  .transform((fee) => ({ label: fee.label, amountCents: fee.amount }));

/** The record as the property form saves it. Strict: any other key is refused. */
export const ManagementInputSchema = z
  .strictObject({
    owners: z
      .array(
        z.strictObject({
          name: text(STATEMENT_LIMITS.OWNER_NAME_MAX, 'Name the co-owner'),
          email: z
            .string()
            .transform((s) => s.trim())
            .pipe(z.string().max(STATEMENT_LIMITS.OWNER_EMAIL_MAX, `At most ${STATEMENT_LIMITS.OWNER_EMAIL_MAX} characters`).refine((s) => s === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s), 'Not an email address'))
            .nullable()
            .optional()
            .transform((value) => (value ? value : null)),
        }),
      )
      .max(STATEMENT_LIMITS.OWNERS_MAX, `At most ${STATEMENT_LIMITS.OWNERS_MAX} co-owners`),
    statementsFrom: z.string().refine(isMonth, 'A month, like 2026-10'),
    statementsUntil: z.string().refine(isMonth, 'A month, like 2027-03').nullable(),
    defaultFee: FeeInputSchema.nullable(),
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
  const stored = {
    schemaVersion: PROPERTY_MANAGEMENT_SCHEMA_VERSION,
    propertyId,
    owners: input.owners.map((owner) => ({ name: owner.name, email: owner.email })),
    statementsFrom: input.statementsFrom,
    statementsUntil: input.statementsUntil,
    defaultFee: input.defaultFee,
    setAt: new Date().toISOString(),
  };
  await ref.set(stored);
  return { kind: 'set', record: readPropertyManagement(propertyId, stored)! };
}
