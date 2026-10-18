// The Costs page, round 1 (2026-10-18): the review queue's narrow read (listQueue) against the full read (listCosts),
// both run with the app's own server code on an in-memory Firestore (tests/tools/memory-firestore.cjs: nothing is
// read from or written to Firestore or Storage, and every connection is refused). Made-up entries of every status,
// age, kind and version: the narrow read must give the queue exactly as the full read does — the same entries, the
// same views, the same Worth a look — while reading fewer documents; then "Mark these n seen" in one request, which
// reads only those entries, and the queue's marker cleared by any admin event. Reads are counted as Firestore bills.
//   node --import ./tests/tools/ts-hook.mjs tests/money/costs-queue.mjs
import { createRequire } from 'node:module';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.NUBNB_ROOT || fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
createRequire(`${ROOT}/package.json`)(`${ROOT}/tests/tools/memory-firestore.cjs`);
// A made-up service account: firebase-admin starts, and has nowhere to go.
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.FIREBASE_SERVICE_ACCOUNT_KEY = JSON.stringify({ type: 'service_account', project_id: 'memory-test', private_key_id: 'memory-test', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), client_email: 'memory-test@memory-test.iam.gserviceaccount.com', client_id: '0', token_uri: 'https://oauth2.invalid/token' });
process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = 'memory-test.appspot.com';
process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = 'memory-test';

const ce = await import(`${ROOT}/app/lib/firebase/server-cost-entries.ts`);
const model = await import(`${ROOT}/app/lib/reports/model.ts`);
const st = await import(`${ROOT}/app/lib/reports/statement.ts`);
const { inQueue } = await import(`${ROOT}/app/lib/costs/report.ts`);
const { watchList } = await import(`${ROOT}/app/lib/costs/patterns.ts`);
const { awaitingLook, ADMIN_ACTOR } = await import(`${ROOT}/app/lib/cleaners/model.ts`);

const TODAY = '2026-11-03';
const ADMIN = { role: 'admin', id: 'TESTADMINcostsqueue1', name: 'Test admin' };
const PA = 'TESTPROPqueueaaaaaa1';
const PB = 'TESTPROPqueuebbbbbb1';
const ANA = { id: 'TESTCLEANERqueueana1', name: 'Test Ana', role: 'cleaner' };
const HANDY = { id: 'TESTHANDYMANqueue001', name: 'Test Handy', role: 'handyman' };
const seed = globalThis.__memSeed;
seed('properties', PA, { name: 'Public A' });
seed('properties', PB, { name: 'Public B' });
seed('property_cleaner_names', PA, { schemaVersion: 1, name: '1 Queue St' });
seed('property_cleaner_names', PB, { schemaVersion: 1, name: '2 Queue St' });
seed('cleaners', ANA.id, { schemaVersion: 2, name: ANA.name, role: 'cleaner', status: 'active', defaultRateCents: 9000 });
seed('cleaners', HANDY.id, { schemaVersion: 2, name: HANDY.name, role: 'handyman', status: 'active' });

const by = (m) => ({ role: m.role, id: m.id, name: m.name });
const SYSTEM = { role: 'system', id: null, name: 'auto-approval' };
/** An entry as stored: version 2 (before the marker) or 3; `look`: 'unseen' (approved automatically, no admin event), 'seen', or none. */
function entry(id, { version, property = PA, at, cents, status = 'approved', look = null, kind = 'receipt', month, who = ANA }) {
  const auto = look !== null;
  const history = [{ at, action: 'submitted', from: null, to: 'pending', actor: kind === 'office' ? ADMIN_ACTOR : by(who), reason: null }];
  if (status !== 'pending') history.push({ at, action: 'approved', from: 'pending', to: 'approved', actor: auto ? SYSTEM : ADMIN_ACTOR, reason: null });
  if (look === 'seen') history.push({ at, action: 'seen', from: null, to: null, actor: ADMIN, reason: null });
  if (status === 'rejected' || status === 'removed') history.push({ at, action: status, from: 'approved', to: status, actor: ADMIN, reason: status === 'rejected' ? 'Not ours' : null });
  seed('cost_entries', id, {
    schemaVersion: version, ...(version >= 3 ? { awaitingLook: look === 'unseen' && status === 'approved' } : {}),
    kind, cleanerId: kind === 'office' ? null : who.id, cleanerNameAtEntry: kind === 'office' ? null : who.name, propertyId: property, propertyNameAtEntry: 'Public', createdAt: at, purchasedOn: null, note: null, currency: 'CAD',
    lines: [{ name: 'Supplies', quantity: 1, lineTotalCents: cents }], taxCents: kind === 'receipt' ? 0 : null, receipts: [], status, statusChangedAt: at, statusReason: status === 'rejected' ? 'Not ours' : null,
    history, autoApproved: auto ? { thresholdCents: 20000, totalCents: cents, at } : null, ...(month ? { month } : {}),
  });
  return id;
}
const T = (day) => `${day}T15:00:00.000Z`;
// Written before the marker (version 2):
entry('TESTENTRYqueueL1oldu', { version: 2, at: T('2026-06-10'), cents: 4200, look: 'unseen' }); // queue: unseen, older than 90 days
entry('TESTENTRYqueueL2olds', { version: 2, at: T('2026-06-12'), cents: 3100, look: 'seen' }); // read, not in the queue
entry('TESTENTRYqueueL3oldp', { version: 2, at: T('2026-05-20'), cents: 25000, status: 'pending' }); // queue: a decision, old
entry('TESTENTRYqueueL4newa', { version: 2, at: T('2026-10-01'), cents: 8000 }); // read, not in the queue
// Written since (version 3):
entry('TESTENTRYqueueN1oldu', { version: 3, at: T('2026-06-15'), cents: 5200, look: 'unseen' }); // queue: unseen, older than 90 days
entry('TESTENTRYqueueN2olds', { version: 3, at: T('2026-06-16'), cents: 6100, look: 'seen' }); // never read by the queue
entry('TESTENTRYqueueN3rejd', { version: 3, at: T('2026-04-02'), cents: 9900, status: 'rejected' }); // queue: kept on record
entry('TESTENTRYqueueN4remd', { version: 3, at: T('2026-03-02'), cents: 7700, status: 'removed' }); // queue: kept on record
entry('TESTENTRYqueueN5offc', { version: 3, at: T('2026-02-01'), cents: 15000, kind: 'office', month: '2026-01' }); // never read by the queue
entry('TESTENTRYqueueN6work', { version: 3, at: T('2026-10-20'), cents: 26000, status: 'pending', kind: 'work', who: HANDY, property: PB }); // queue: a decision
entry('TESTENTRYqueueN7newu', { version: 3, at: T('2026-10-25'), cents: 4800, look: 'unseen', property: PB }); // queue: unseen
entry('TESTENTRYqueueN8news', { version: 3, at: T('2026-10-26'), cents: 3900, look: 'seen' }); // read for Worth a look
entry('TESTENTRYqueueN9late', { version: 3, at: T('2026-09-28'), cents: 21240, status: 'pending' }); // queue: a decision, late (September is finished)
// Ana's receipts just under the line in the last 90 days, looked at: Worth a look must name her from either read.
for (const [i, day] of ['2026-08-20', '2026-09-03', '2026-09-17', '2026-10-08', '2026-10-15'].entries()) entry(`TESTENTRYqueueband0${i}`, { version: 3, at: T(day), cents: 18500 + i * 100, look: 'seen' });
// Months of history, decided and looked at: the full read reads them all; the queue read none.
for (let i = 0; i < 40; i++) entry(`TESTENTRYqueuehist${String(i).padStart(2, '0')}`, { version: 3, property: i % 2 ? PA : PB, at: T(`2026-0${3 + (i % 5)}-${String(1 + (i % 27)).padStart(2, '0')}`), cents: 2000 + i * 37, look: i % 3 ? 'seen' : null });
// September finished for PA.
const sep = st.buildStatement({ propertyId: PA, propertyName: '1 Queue St', month: '2026-09', entries: [], reports: [], draft: { reference: 'Sept-Q', reportDate: '2026-10-01', lines: [{ id: 'L1', description: 'Revenue', from: null, to: null, quantity: 1, rateCents: 100000, amountCents: 100000 }], fee: null, carried: null, notes: null, supersedes: null }, management: null }).statement;
seed('monthly_reports', 'TESTREPORTqueuesep01', {
  schemaVersion: model.MONTHLY_REPORT_SCHEMA_VERSION, propertyId: PA, propertyNameAtFinish: '1 Queue St', month: '2026-09', reference: sep.reference, reportDate: sep.reportDate, reportFor: null, lines: sep.lines, costs: [], adjustments: [], fee: null, carried: null,
  incomeCents: sep.incomeCents, expensesCents: sep.expensesCents, recordedCents: sep.recordedCents, costsCents: sep.costsCents, feeCents: sep.feeCents, totalCents: sep.totalCents, carriedCents: sep.carriedCents, payableCents: sep.payableCents,
  pendingLeftOut: 0, notes: null, entryIds: [], finishedAt: '2026-10-05T14:00:00.000Z', actor: ADMIN_ACTOR, supersedes: null, draftRevision: 1, ownersAtFinish: [], income: [], pdf: { path: 'monthly-reports/TESTREPORTqueuesep01.pdf', bytes: 1, sha256: 'x' },
});

const reads = async (label, fn) => {
  globalThis.__memReads.length = 0;
  const result = await fn();
  const total = globalThis.__memReads.reduce((s, r) => s + r.billed, 0);
  const parts = {};
  for (const r of globalThis.__memReads) parts[r.what] = (parts[r.what] ?? 0) + r.billed;
  console.log(`${label}: ${total} reads (${Object.entries(parts).sort((a, b) => b[1] - a[1]).map(([w, n]) => `${w} ${n}`).join(' · ')})`);
  return result;
};
const short = (id) => id.replace('TESTENTRYqueue', '');
const queueOf = (view) => view.entries.filter(inQueue);
const names = (list) => list.map((e) => short(e.id)).join(' ');

console.log('═══ 1. The same queue from the narrow read as from the full read ═══');
const full = await reads('full read (listCosts)', () => ce.listCosts());
const narrow = await reads('queue read (listQueue)', () => ce.listQueue(TODAY));
console.log(`queue from the full read:   ${names(queueOf(full))}`);
console.log(`queue from the narrow read: ${names(queueOf(narrow))}`);
const sameQueue = JSON.stringify(queueOf(full)) === JSON.stringify(queueOf(narrow));
console.log(`identical, entry for entry and field for field: ${sameQueue}`);
const watch = (view) => JSON.stringify(watchList(view.entries, TODAY));
console.log(`Worth a look identical: ${watch(full) === watch(narrow)} · names: ${watchList(narrow.entries, TODAY).filter((p) => p.worthALook).map((p) => p.name ?? p.cleanerId).join(', ') || 'nobody'}`);
console.log(`read by the narrow read, not in the queue (Worth a look's 90 days, and entries written before the marker): ${names(narrow.entries.filter((e) => !inQueue(e)))}`);
console.log(`read by the full read only: ${full.entries.filter((e) => !narrow.entries.some((n) => n.id === e.id)).length} entries (${names(full.entries.filter((e) => !narrow.entries.some((n) => n.id === e.id) && !e.id.includes('hist')))} and the 40 of history)`);
console.log(`finished months of the properties with an entry waiting: ${JSON.stringify(narrow.finishedMonths)} · window from ${narrow.since}`);
console.log(`the same exports and property names: ${JSON.stringify(full.exports) === JSON.stringify(narrow.exports) && JSON.stringify(full.properties) === JSON.stringify(narrow.properties)}`);

console.log('\n═══ 2. "Mark these n seen": one request, reading only those entries ═══');
const unseen = queueOf(narrow).filter(awaitingLook);
console.log(`unseen in the queue: ${names(unseen)}`);
const stale = await reads('a stale one (N7 seen as 1)', () => ce.markEntriesSeen(ADMIN, [{ id: 'TESTENTRYqueueN7newu', seen: 1 }, { id: 'TESTENTRYqueueN1oldu', seen: 2 }]));
console.log(`  → ${stale.kind} ${stale.reason ?? ''} ${(stale.ids ?? []).map(short).join(' ')} · N1 untouched: ${globalThis.__memDoc('cost_entries', 'TESTENTRYqueueN1oldu').history.length === 2}`);
const done = await reads(`mark ${unseen.length - 1} (all but N7)`, () => ce.markEntriesSeen(ADMIN, unseen.filter((e) => !e.id.endsWith('N7newu')).map((e) => ({ id: e.id, seen: e.history.length }))));
console.log(`  → ${done.kind}: ${done.seen.map((s) => `${short(s.id)} ${s.event.action} by ${s.event.actor?.name}`).join(', ')} · unchanged ${done.unchanged.length}`);
const n1 = globalThis.__memDoc('cost_entries', 'TESTENTRYqueueN1oldu');
const l1 = globalThis.__memDoc('cost_entries', 'TESTENTRYqueueL1oldu');
console.log(`  N1 (version 3): awaitingLook ${n1.awaitingLook} · L1 (version 2): has the field ${'awaitingLook' in l1} (never backfilled), its history ends ${l1.history.at(-1).action}`);
const again = await ce.markEntriesSeen(ADMIN, [{ id: 'TESTENTRYqueueN1oldu', seen: n1.history.length }]);
console.log(`  marking N1 again: ${again.kind}, unchanged ${again.unchanged.map(short).join(' ')}, nothing written: ${globalThis.__memDoc('cost_entries', 'TESTENTRYqueueN1oldu').history.length === n1.history.length}`);

console.log('\n═══ 3. Any admin event clears the marker ═══');
const n7 = narrow.entries.find((e) => e.id.endsWith('N7newu'));
const removed = await reads('remove N7 (a review)', () => ce.setEntryStatus(ADMIN, n7.id, 'removed', null, n7.history.length));
console.log(`  → ${removed.kind} · N7 awaitingLook ${globalThis.__memDoc('cost_entries', n7.id).awaitingLook} · in the queue now as removed: ${removed.entry.status}`);

console.log('\n═══ 4. The queue after: narrow and full still agree ═══');
const full2 = await reads('full read', () => ce.listCosts());
const narrow2 = await reads('queue read', () => ce.listQueue(TODAY));
console.log(`queue: ${names(queueOf(narrow2))} · identical to the full read's: ${JSON.stringify(queueOf(full2)) === JSON.stringify(queueOf(narrow2))} · Worth a look identical: ${watch(full2) === watch(narrow2)}`);
