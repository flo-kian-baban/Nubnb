// Dispatch 36: a ledger of cleaner and handyman entries only (no office cost), as PDF and Excel, each file's SHA-256.
// Made-up data only. NUBNB_ROOT picks another copy of the code; by default, this repository.
//   node --import ./tests/tools/ts-hook.mjs tests/money/ledger.mjs
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const ROOT = process.env.NUBNB_ROOT || fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const { entryViewOf } = await import(`${ROOT}/app/lib/backup/data.ts`);
const { buildReport } = await import(`${ROOT}/app/lib/costs/report.ts`);
const { pdfFor } = await import(`${ROOT}/app/lib/costs/pdf.ts`);
const { workbookFor } = await import(`${ROOT}/app/lib/costs/xlsx.ts`);
const { ADMIN_ACTOR } = await import(`${ROOT}/app/lib/cleaners/model.ts`);
const P = 'TESTPROPledgeraaaaa1';
const doc = (createdAt, kind, lines, taxCents) => ({
  schemaVersion: 2, createdAt, status: 'approved', statusChangedAt: createdAt, statusReason: null, cleanerId: 'TESTCLEANER000000001', cleanerNameAtEntry: 'Test cleaner', propertyId: P, propertyNameAtEntry: 'Test property',
  purchasedOn: createdAt.slice(0, 10), note: null, currency: 'CAD', kind, autoApproved: null, lines, taxCents, receipts: [],
  history: [{ at: createdAt, action: 'submitted', from: null, to: 'pending', actor: { role: 'cleaner', id: 'TESTCLEANER000000001', name: 'Test cleaner' }, reason: null }, { at: createdAt, action: 'approved', from: 'pending', to: 'approved', actor: ADMIN_ACTOR, reason: null }],
});
const entries = [
  entryViewOf('TESTENTRYledger00001', doc('2026-09-03T15:00:00.000Z', 'receipt', [{ name: 'Paper towels', quantity: 2, lineTotalCents: 1299 }, { name: 'Bleach', quantity: 1, lineTotalCents: 499 }], 234)),
  entryViewOf('TESTENTRYledger00002', doc('2026-09-18T20:00:00.000Z', 'work', [{ name: 'Replaced the bathroom fan', quantity: 1, lineTotalCents: 15000 }], null)),
  entryViewOf('TESTENTRYledger00003', doc('2026-09-30T23:30:00.000Z', 'receipt', [{ name: 'Light bulbs', quantity: 4, lineTotalCents: 1596 }], 207)),
];
const out = {};
for (const [from, to] of [['2026-09-01', '2026-09-30'], ['', '']]) {
  const r = buildReport(entries, P, from, to, new Date('2026-10-12T16:00:00Z'), 'Test property');
  out[`${from || 'open'}–${to || 'open'} pdf`] = createHash('sha256').update(pdfFor(r.report)).digest('hex');
  out[`${from || 'open'}–${to || 'open'} xlsx`] = createHash('sha256').update(workbookFor(r.report)).digest('hex');
}
console.log(JSON.stringify(out, null, 1));
