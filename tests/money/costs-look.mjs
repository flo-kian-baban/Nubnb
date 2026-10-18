// The Costs page, round 1, fix 1 (2_026-10-18): the queue's marker `awaitingLook` (cost entries, version 3) on every
// path that counts as an admin looking at a receipt approved automatically, run with the app's own server code on an
// in-memory Firestore (tests/tools/memory-firestore.cjs: nothing is read from or written to Firestore or Storage).
// After each path the stored marker must equal the rule the queue reads by, awaitingLook() from the history (an admin
// event is a look), so the narrow read neither drops nor keeps an entry wrongly. Entries are made by the app's own
// creators: the cleaner's receipt (createCostEntry), the handyman's work (createWorkEntry), the office's cost
// (createOfficeEntry); a pending receipt, work and an office cost never carry the marker. Then fix 2: what an export's
// question says of what the report leaves out (buildReport, leftOutLines, leftOutWords).
//   node --import ./tests/tools/ts-hook.mjs tests/money/costs-look.mjs
import { createRequire } from 'node:module';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.NUBNB_ROOT || fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
createRequire(`${ROOT}/package.json`)(`${ROOT}/tests/tools/memory-firestore.cjs`);
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2_048 });
process.env.FIREBASE_SERVICE_ACCOUNT_KEY = JSON.stringify({ type: 'service_account', project_id: 'memory-test', private_key_id: 'memory-test', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), client_email: 'memory-test@memory-test.iam.gserviceaccount.com', client_id: '0', token_uri: 'https://oauth2.invalid/token' });
process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = 'memory-test.appspot.com';
process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = 'memory-test';

const ce = await import(`${ROOT}/app/lib/firebase/server-cost-entries.ts`);
const { awaitingLook, readCostEntryFields } = await import(`${ROOT}/app/lib/cleaners/model.ts`);

const ADMIN = { role: 'admin', id: 'TESTADMINcostslook01', name: 'Test admin' };
const P = 'TESTPROPcostslook001';
const CLEANER = 'TESTCLEANERlook00001';
const HANDY = 'TESTHANDYMANlook0001';
const seed = globalThis.__memSeed;
const stored = (id) => globalThis.__memDoc('cost_entries', id);
seed('properties', P, { name: 'Public look' });
seed('property_cleaner_names', P, { schemaVersion: 1, name: '1 Look St' });
seed('cleaners', CLEANER, { schemaVersion: 2, name: 'Test Lena', role: 'cleaner', status: 'active', sessionEpoch: 1, defaultRateCents: 9_000 });
seed('cleaners', HANDY, { schemaVersion: 2, name: 'Test Hal', role: 'handyman', status: 'active', sessionEpoch: 1 });

let keys = 0;
const key = () => `0a1b2c3d-1e1e-4a2a-8b3b-${String(++keys).padStart(12, '0')}`;
/** A receipt sent by the cleaner's own path: under $200.00 it is approved automatically. */
async function sendReceipt(dollars) {
  const parsed = ce.parseEntryPart(JSON.stringify({ submissionKey: key(), propertyId: P, lines: [{ name: 'Paper towels', quantity: '1', lineTotal: dollars }], tax: null }));
  if (parsed.kind !== 'ok') throw new Error(`entry not valid: ${JSON.stringify(parsed)}`);
  const ref = ce.newEntryRef();
  const made = await ce.createCostEntry({ entryRef: ref, cleanerId: CLEANER, sessionEpoch: 1, entry: parsed.entry, propertyNameAtEntry: 'Public look', receipt: { path: `receipts/${CLEANER}/${ref.id}/0.jpg`, contentType: 'image/jpeg', bytes: 1_000, sha256: '0'.repeat(64), uploadedAt: '2026-10-18T12:00:00.000Z' }, reading: null });
  return { id: ref.id, status: made.status };
}
const view = (id) => readCostEntryFields(id, stored(id));
const seen = (id) => stored(id).history.length;
const marker = (id) => ('awaitingLook' in stored(id) ? String(stored(id).awaitingLook) : 'absent');
let broken = 0;
function check(label, id, wantMarker) {
  const rule = awaitingLook(view(id));
  const now = marker(id);
  const agrees = (now === 'true') === rule;
  const ok = agrees && now === wantMarker;
  if (!ok) broken += 1;
  console.log(`  ${label}: awaitingLook ${now} · the rule says ${rule ? 'waiting for a look' : 'not waiting for one'} · ${ok ? 'as it should' : `WRONG (want ${wantMarker}, marker and rule ${agrees ? 'agree' : 'disagree'})`}`);
}

console.log('═══ 1. New entries ═══');
const auto = [];
for (let i = 0; i < 9; i++) auto.push((await sendReceipt(`${20 + i}.00`)).id);
check(`a receipt under $200.00, approved automatically (${stored(auto[0]).status})`, auto[0], 'true');
const pending = await sendReceipt('250.00');
check(`a receipt from $200.00 (${pending.status})`, pending.id, 'absent');
const workParsed = ce.parseWorkBody({ submissionKey: key(), propertyId: P, description: 'Fixed the closet door', price: '85.00' });
if (workParsed.kind !== 'ok') throw new Error(`work not valid: ${JSON.stringify(workParsed)}`);
const work = await ce.createWorkEntry({ cleanerId: HANDY, sessionEpoch: 1, work: workParsed.work, propertyNameAtEntry: 'Public look' });
check(`a handyman's work (${work.status})`, work.id, 'absent');
const office = await ce.createOfficeEntry(ADMIN, { office: ce.OfficeInputSchema.parse({ propertyId: P, description: 'Plumber', amount: '150.00', tax: null, month: '2026-10' }), propertyNameAtEntry: 'Public look' });
check(`an office cost (${office.status})`, office.id, 'absent');

console.log('\n═══ 2. Every way an admin looks at a receipt approved automatically ═══');
const [a1, a2, a3, a4, a5, a6, a7, a8, a9] = auto;
let r = await ce.markEntrySeen(ADMIN, a1, seen(a1));
check(`Seen, one at a time (${r.kind}, changed ${r.changed})`, a1, 'false');
r = await ce.markEntriesSeen(ADMIN, [{ id: a2, seen: seen(a2) }, { id: a3, seen: seen(a3) }]);
check(`"Mark these n seen", the first of two (${r.kind}, ${r.seen.length} marked)`, a2, 'false');
check('"Mark these n seen", the second of two', a3, 'false');
r = await ce.setEntryPaidWith(ADMIN, a4, 'nubnb-card', seen(a4));
check(`"Paid with Nubnb's card" ticked (${r.kind}, changed ${r.changed})`, a4, 'false');
r = await ce.setEntryStatus(ADMIN, a5, 'rejected', 'Not bought for a Nubnb unit', seen(a5));
check(`rejected (${r.kind}, changed ${r.changed})`, a5, 'false');
r = await ce.setEntryStatus(ADMIN, a6, 'removed', null, seen(a6));
check(`removed (${r.kind}, changed ${r.changed})`, a6, 'false');
r = await ce.setEntryStatus(ADMIN, a6, 'approved', null, seen(a6));
check(`approved again after the removal (${r.kind}, changed ${r.changed})`, a6, 'false');
r = await ce.setEntryStatus(ADMIN, a5, 'approved', null, seen(a5));
check(`approved after the rejection (${r.kind}, changed ${r.changed})`, a5, 'false');
// Approve on an entry already approved writes nothing (the entry pane does not offer it; it offers Seen): no admin
// event, so by the rule it is still not looked at, and the marker stays with the rule.
r = await ce.setEntryStatus(ADMIN, a7, 'approved', null, seen(a7));
check(`approve on one already approved automatically (${r.kind}, changed ${r.changed}: nothing written)`, a7, 'true');
r = await ce.changeEntryLine(ADMIN, a8, 0, { name: 'Paper towels (one returned)', quantity: 1, lineTotalCents: 1_000 }, seen(a8));
check(`a line corrected (${r.kind}, changed ${r.changed})`, a8, 'false');
r = await ce.changeEntryTax(ADMIN, a9, 300, seen(a9));
check(`the tax corrected (${r.kind}, changed ${r.changed})`, a9, 'false');

console.log('\n═══ 3. Paths on entries that never carried it ═══');
r = await ce.setEntryStatus(ADMIN, pending.id, 'approved', null, seen(pending.id));
check(`the receipt from $200.00 approved (${r.kind}, changed ${r.changed})`, pending.id, 'absent');
r = await ce.setEntryStatus(ADMIN, work.id, 'approved', null, seen(work.id));
check(`the handyman's work approved (${r.kind}, changed ${r.changed})`, work.id, 'absent');
r = await ce.setEntryStatus(ADMIN, office.id, 'removed', null, seen(office.id));
check(`the office cost removed (${r.kind}, changed ${r.changed})`, office.id, 'absent');

console.log(`\n${broken === 0 ? 'every path leaves the marker where the rule puts it' : `${broken} paths leave the marker wrong`}`);

console.log('\n═══ 4. What an export asks before leaving entries out (fix 2) ═══');
const { buildReport, leftOutLines, leftOutWords } = await import(`${ROOT}/app/lib/costs/report.ts`);
const { entryViewOf } = await import(`${ROOT}/app/lib/backup/data.ts`);
const cl = await import(`${ROOT}/app/lib/cleanings/model.ts`);
const pendingView = entryViewOf(pending.id, { ...stored(pending.id), status: 'pending', history: stored(pending.id).history.slice(0, 1) });
const noAmount = cl.cleaningEntryView({ ...cl.readCleaning('TESTCLEANINGlook0001', { schemaVersion: 2, propertyId: P, propertyNameAtEntry: 'Public look', cleanerId: CLEANER, cleanerNameAtEntry: 'Test Lena', day: pendingView.createdAt.slice(0, 10), amountCents: null, note: null, status: 'logged', suggested: { from: 'none', cents: null }, createdAt: pendingView.createdAt, actor: ADMIN, history: [{ at: pendingView.createdAt, action: 'logged', actor: ADMIN, reason: null }], jobId: `${P}_x` }), cleaner: { state: 'found', name: 'Test Lena', status: 'active' }, property: { state: 'found', name: 'Public look', internalName: '1 Look St' } });
// An open period: the entries were made today, whatever day this runs.
const built = buildReport([pendingView, noAmount, entryViewOf(a1, stored(a1))], P, '', '', new Date('2026-10-18T12:00:00Z'), '1 Look St');
console.log(`  the report leaves out: ${built.pendingLeftOut} pending review, ${built.noAmountLeftOut} cleaning with no amount yet`);
for (const [p, n] of [[built.pendingLeftOut, built.noAmountLeftOut], [1, 0], [0, 1], [0, 2], [3, 2]]) {
  console.log(`  ${p} pending, ${n} with no amount:`);
  for (const line of leftOutLines(p, n, 'in this period')) console.log(`    "${line}"`);
  console.log(`    notice: "${leftOutWords(p, n)}"`);
}
console.log(`  nothing left out: ${leftOutLines(0, 0, 'in this period').length} lines, no question asked`);
