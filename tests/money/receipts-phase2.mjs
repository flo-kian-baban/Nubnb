// Phase 2, receipts and work (2026-11-01): a cost dated before November 2026 is refused with "Statements start in
// November 2026" (before the 12-month window, so it reads the same on any day), and a receipt that may be a second
// send of one already held is flagged for the admin when it is created — the same photo (any property, any time), or
// the same total for the same property within 14 days; pending or approved earlier receipts only — and never refused;
// a flagged receipt waits for a decision whatever its amount (Kian's ruling of 2026-11-01). The flag's words, its
// reading back, and the bulk "Mark these n seen" leaving a flagged entry out. A receipt whose reading dates it before
// November 2026 is held back with a sentence the cleaner can act on, by the phone and by the route, before anything is
// stored (Kian's instruction of 2026-11-01). The app's own
// server code on an in-memory Firestore (tests/tools/memory-firestore.cjs): nothing is read from or written to
// Firestore or Storage.
//   node --import ./tests/tools/ts-hook.mjs tests/money/receipts-phase2.mjs
import { createRequire } from 'node:module';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.NUBNB_ROOT || fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const require = createRequire(`${ROOT}/package.json`);
require(`${ROOT}/tests/tools/memory-firestore.cjs`);
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.FIREBASE_SERVICE_ACCOUNT_KEY = JSON.stringify({ type: 'service_account', project_id: 'memory-test', private_key_id: 'memory-test', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), client_email: 'memory-test@memory-test.iam.gserviceaccount.com', client_id: '0', token_uri: 'https://oauth2.invalid/token' });
process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = 'memory-test.appspot.com';
process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = 'memory-test';

const ce = await import(`${ROOT}/app/lib/firebase/server-cost-entries.ts`);
const { readCostEntryFields, DUPLICATE_HINTS } = await import(`${ROOT}/app/lib/cleaners/model.ts`);
const { duplicateHints, duplicateWords, duplicateHref } = await import(`${ROOT}/app/lib/costs/duplicates.ts`);
const { getAdminDb } = await import(`${ROOT}/app/lib/firebase/admin.ts`);

let failures = 0;
const check = (ok, words) => {
  if (!ok) failures += 1;
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${words}`);
};
const section = (title) => console.log(`═══ ${title} ═══`);

// ── 1. The purchase date ──
section('1. A purchase date before November 2026 is refused with "Statements start in November 2026"');
const at = (iso) => new Date(iso);
const cases = [
  ['2026-10-31', '2026-11-20T15:00:00Z'],
  ['2026-10-01', '2026-11-20T15:00:00Z'],
  ['2026-11-01', '2026-11-20T15:00:00Z'],
  ['2026-10-31', '2028-11-20T15:00:00Z'],
  ['2026-11-01', '2028-11-20T15:00:00Z'],
  ['2027-11-20', '2028-11-20T15:00:00Z'],
  ['2028-11-21', '2028-11-20T15:00:00Z'],
  ['2026-02-30', '2026-11-20T15:00:00Z'],
];
const answers = new Map();
for (const [day, now] of cases) {
  const problem = ce.purchasedOnProblem(day, at(now));
  answers.set(`${day}@${now.slice(0, 10)}`, problem);
  console.log(`  purchasedOnProblem(${day}, today ${now.slice(0, 10)}) → ${problem === null ? 'null' : JSON.stringify(problem)}`);
}
check(answers.get('2026-10-31@2026-11-20') === 'Statements start in November 2026' && answers.get('2026-10-01@2026-11-20') === 'Statements start in November 2026', 'October 2026, inside the 12 months, is refused with the first statement month');
check(answers.get('2026-10-31@2028-11-20') === 'Statements start in November 2026', 'two years on, a date before November 2026 still reads "Statements start in November 2026", not the 12-month window');
check(answers.get('2026-11-01@2026-11-20') === null, '1 November 2026 is accepted');
check(answers.get('2026-11-01@2028-11-20') === 'The date must be within the last 12 months' && answers.get('2027-11-20@2028-11-20') === null, 'the 12-month window holds as before after the floor');
check(answers.get('2028-11-21@2028-11-20') === 'The date cannot be in the future' && answers.get('2026-02-30@2026-11-20') === 'Not a real calendar date', 'a future day and a day that does not exist are refused as before');
const part = (purchasedOn) => JSON.stringify({ submissionKey: '0f0e0d0c-0b0a-4908-8706-050403020100', propertyId: 'TESTPROPphasetwoaaa1', purchasedOn, lines: [{ name: 'Gloves', quantity: '1', lineTotal: '12.00' }], tax: null });
const parsed = ce.parseEntryPart(part('2026-10-31'));
console.log(`  parseEntryPart(purchasedOn 2026-10-31) → ${JSON.stringify(parsed)}`);
check(parsed.kind === 'invalid' && parsed.issues.length === 1 && parsed.issues[0].path === 'purchasedOn' && parsed.issues[0].message === 'Statements start in November 2026', 'the entry route refuses it as a 422 on purchasedOn, before any photo is stored');
check(ce.parseEntryPart(part(null)).kind === 'ok', 'no purchase date at all (what the app sends) is accepted');

// ── 2. The flag, written when a receipt is created ──
section('2. A possible second send is flagged on the new receipt, never refused');
const seed = globalThis.__memSeed;
const P = 'TESTPROPphasetwoaaa1';
const Q = 'TESTPROPphasetwobbb1';
const ANA = 'TESTCLEANERphase2ana';
const BEN = 'TESTCLEANERphase2ben';
seed('properties', P, { name: 'Public P' });
seed('properties', Q, { name: 'Public Q' });
seed('cleaners', ANA, { schemaVersion: 2, name: 'Test Ana', role: 'cleaner', status: 'active', sessionEpoch: 1 });
seed('cleaners', BEN, { schemaVersion: 2, name: 'Test Ben', role: 'cleaner', status: 'active', sessionEpoch: 1 });
const DAY = 86_400_000;
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();
const sha = (c) => c.repeat(64);
/** An earlier receipt as a version-3 entry with this phase's two fields. */
function earlier(id, { property = P, who = ANA, photo, cents, days, status = 'approved' }) {
  seed('cost_entries', id, {
    schemaVersion: 3, kind: 'receipt', cleanerId: who, cleanerNameAtEntry: 'Test', propertyId: property, propertyNameAtEntry: 'Public', createdAt: ago(days), purchasedOn: null, note: null, currency: 'CAD',
    lines: [{ name: 'Supplies', quantity: 1, lineTotalCents: cents }], taxCents: null, receipts: [{ path: `receipts/${id}/x.jpg`, contentType: 'image/jpeg', bytes: 1, sha256: photo, uploadedAt: ago(days) }],
    status, statusChangedAt: ago(days), statusReason: null, history: [], autoApproved: null, photoSha256: photo, sentTotalCents: cents,
  });
}
earlier('TESTENTRYearlierphoto', { photo: sha('a'), cents: 24857, days: 2 });
earlier('TESTENTRYrejectedphot', { photo: sha('b'), cents: 1111, days: 1, status: 'rejected' });
earlier('TESTENTRYoldamount001', { photo: sha('c'), cents: 4720, days: 20 });
earlier('TESTENTRYotherunit001', { property: Q, photo: sha('d'), cents: 9999, days: 1 });
earlier('TESTENTRYpendingamt01', { who: BEN, photo: sha('e'), cents: 6050, days: 3, status: 'pending' });
earlier('TESTENTRYremovedamt01', { photo: sha('f'), cents: 7070, days: 3, status: 'removed' });
seed('cost_entries', 'TESTENTRYworkonunitp1', { schemaVersion: 3, kind: 'work', cleanerId: 'TESTHANDYMANphase2hl', propertyId: P, createdAt: ago(1), lines: [{ name: 'Work', quantity: 1, lineTotalCents: 3030 }], taxCents: null, receipts: [], status: 'approved', history: [], autoApproved: null, sentTotalCents: 3030 });

let keyN = 0;
const key = () => `0f0e0d0c-0b0a-4908-8706-${String(++keyN).padStart(12, '0')}`;
const names = new Map();
async function send(label, { who = ANA, property = P, photo, cents }) {
  const parsedEntry = ce.parseEntryPart(JSON.stringify({ submissionKey: key(), propertyId: property, lines: [{ name: 'Supplies', quantity: '1', lineTotal: (cents / 100).toFixed(2) }], tax: null }));
  if (parsedEntry.kind !== 'ok') throw new Error(`${label}: ${JSON.stringify(parsedEntry)}`);
  const entryRef = ce.newEntryRef();
  names.set(entryRef.id, label);
  const created = await ce.createCostEntry({ entryRef, cleanerId: who, sessionEpoch: 1, entry: parsedEntry.entry, propertyNameAtEntry: 'Public', receipt: { path: `receipts/${entryRef.id}/y.jpg`, contentType: 'image/jpeg', bytes: 1, sha256: photo, uploadedAt: new Date().toISOString() }, reading: null });
  const stored = (await getAdminDb().collection('cost_entries').doc(entryRef.id).get()).data();
  const hints = (stored.possibleDuplicates ?? []).map((h) => `${h.why} → ${names.get(h.entryId) ?? h.entryId}`);
  console.log(`  ${label}: ${created.status}${created.autoApproved ? ' (approved automatically)' : ''} · stored photoSha256 ${stored.photoSha256 === photo ? 'as sent' : 'WRONG'} · sentTotalCents ${stored.sentTotalCents} · possibleDuplicates ${stored.possibleDuplicates === undefined ? '(absent)' : `[${hints.join(', ')}]`}`);
  return { created, stored, hints };
}
const a = await send('the same photo as an approved receipt, another amount', { photo: sha('a'), cents: 1500 });
check(a.hints.length === 1 && a.hints[0] === 'same-photo → TESTENTRYearlierphoto', 'the same photo is flagged, whatever the amount');
const b = await send('the same photo as a rejected receipt', { photo: sha('b'), cents: 1111 });
check(b.stored.possibleDuplicates === undefined, 'a rejected earlier receipt is not counted: no flag');
const c = await send('the same total, same unit, sent 20 days before', { photo: sha('1'), cents: 4720 });
check(c.stored.possibleDuplicates === undefined, `the same total from longer than ${DUPLICATE_HINTS.WINDOW_DAYS} days ago is not flagged`);
const d = await send('the same total as a receipt for another unit', { photo: sha('2'), cents: 9999 });
check(d.stored.possibleDuplicates === undefined, 'the same total for another property is not flagged');
const e = await send('the same total, same unit, 2 days before, another photo', { photo: sha('3'), cents: 24857 });
check(e.hints.length === 1 && e.hints[0] === 'same-amount → TESTENTRYearlierphoto', 'the same total for the same property within the window is flagged (the photo taken again)');
const f = await send('the same total as a pending receipt by another cleaner, same unit', { who: ANA, photo: sha('4'), cents: 6050 });
check(f.hints.length === 1 && f.hints[0] === 'same-amount → TESTENTRYpendingamt01', 'a pending earlier receipt counts, whoever sent it');
const g = await send('the same total as a removed receipt', { photo: sha('5'), cents: 7070 });
check(g.stored.possibleDuplicates === undefined, 'a removed earlier receipt is not counted');
const h = await send('the same total as a handyman\'s work on the unit', { photo: sha('6'), cents: 3030 });
check(h.stored.possibleDuplicates === undefined, 'work is not a receipt: no flag');
const i = await send('both the same photo and the same total as one receipt', { photo: sha('a'), cents: 24857 });
const ids = i.stored.possibleDuplicates.map((x) => x.entryId);
check(new Set(ids).size === ids.length && i.hints.filter((x) => x.endsWith('TESTENTRYearlierphoto')).length === 1 && i.hints.findIndex((x) => x.startsWith('same-amount')) > i.hints.findLastIndex((x) => x.startsWith('same-photo')), 'one hint per earlier receipt (the receipts sent above match too), the photo ones first');
check(a.created.status === 'pending' && a.created.autoApproved === false && f.created.status === 'pending' && i.created.status === 'pending', `a flagged receipt waits for a decision whatever its amount: $15.00 ${a.created.status}, $60.50 ${f.created.status}, $248.57 ${i.created.status}`);
check([b, c, d, g, h].every((x) => x.created.status === 'approved' && x.created.autoApproved === true), 'an unflagged receipt under $200.00 is still approved automatically (2026-09-30)');
check(a.stored.awaitingLook === undefined && a.stored.autoApproved === null && a.stored.history.length === 1, 'a flagged one carries no automatic approval: no marker, no record of the rule, one event (submitted)');

section('3. A check that cannot be made writes the receipt, unflagged');
const firestore = require(require.resolve('@google-cloud/firestore', { paths: [ROOT] }));
const realGet = firestore.Query.prototype.get;
firestore.Query.prototype.get = function (...args) {
  const filters = this._queryOptions?.filters ?? [];
  if (filters.some((x) => String(x.field?.formattedName ?? x.field ?? '').includes('photoSha256'))) return Promise.reject(Object.assign(new Error('unavailable'), { code: 14 }));
  return realGet.apply(this, args);
};
const errors = [];
const realError = console.error;
console.error = (...m) => errors.push(m.join(' '));
const j = await send('the same photo again, the check failing', { photo: sha('a'), cents: 1500 });
console.error = realError;
firestore.Query.prototype.get = realGet;
console.log(`  logged: ${JSON.stringify(errors)}`);
check(j.created.id && j.stored.possibleDuplicates === undefined && errors.some((m) => m.includes('duplicate check not made: grpc code 14')), 'the receipt is written; no flag; the failure is logged by its code');

// ── 4. Read back, in words ──
section('4. The flag read back and in words');
const view = readCostEntryFields('X', { possibleDuplicates: [{ entryId: 'TESTENTRYearlierphoto', why: 'same-photo', sentAt: '2028-11-20T15:03:10.067Z' }, { entryId: 'Y', why: 'something else' }, 'not a map'] });
console.log(`  readCostEntryFields(…).possibleDuplicates → ${JSON.stringify(view.possibleDuplicates)}`);
check(view.possibleDuplicates?.length === 1, 'a hint not in the written shape is left out');
check(!('possibleDuplicates' in readCostEntryFields('Z', {})), 'an entry with none carries no key at all (every older entry reads as before)');
for (const hint of [{ entryId: 'E1', why: 'same-photo', sentAt: '2028-11-20T15:03:10.067Z' }, { entryId: 'E2', why: 'same-amount', sentAt: '2028-12-01T04:30:02.939Z' }, { entryId: 'E3', why: 'same-amount', sentAt: null }]) {
  console.log(`  ${hint.why}, sent ${hint.sentAt} → "${duplicateWords(hint)}" · ${duplicateHref(hint)}`);
}
check(duplicateWords({ entryId: 'E2', why: 'same-amount', sentAt: '2028-12-01T04:30:02.939Z' }) === 'Same amount, same unit, as the receipt sent 30 Nov 2028', 'the day is Toronto\'s: 04:30 UTC on 1 December is 30 November');
check(duplicateHints({}).length === 0 && duplicateHints({ possibleDuplicates: [{ entryId: 'E', why: 'same-photo', sentAt: null }] }).length === 1, 'duplicateHints reads absent as none');

// ── 5. The bulk Seen leaves a flagged entry out ──
section('5. "Mark these n seen" leaves a possible duplicate out');
const unseen = [{ id: 'U1' }, { id: 'U2', possibleDuplicates: [{ entryId: 'U1', why: 'same-amount', sentAt: null }] }, { id: 'U3' }];
const marked = unseen.filter((entry) => duplicateHints(entry).length === 0).map((entry) => entry.id);
console.log(`  of ${unseen.map((x) => x.id).join(', ')} the bulk Seen sends ${marked.join(', ')}`);
check(marked.join(',') === 'U1,U3', 'the flagged one is left for an admin to open (the page filters as here: page.tsx onMarkAll)');

// ── 6. The reading's date before November 2026 ──
section('6. A receipt the reading dates before November 2026 is held back, with a sentence the cleaner can act on');
const rd = await import(`${ROOT}/app/lib/cleaners/reading-date.ts`);
const { readingDatedBefore } = await import(`${ROOT}/app/lib/cleaner-draft.ts`);
const { readingKey, signReading, parseReadingPart } = await import(`${ROOT}/app/lib/cleaners/readings.ts`);
console.log(`  the sentence: "${rd.DATED_BEFORE_STATEMENTS}" · the route's code: ${rd.DATED_BEFORE_STATEMENTS_CODE}`);
check(rd.DATED_BEFORE_STATEMENTS === 'This receipt is dated before November 2026 and can’t be sent here. Give it to Nubnb directly.' && !rd.DATED_BEFORE_STATEMENTS.startsWith('Statements start'), 'what the cleaner reads says what to do, and is not the admin\'s floor line');
const days = ['2026-10-15', '2026-10-31', '2026-11-01', '2025-11-01', '2025-10-31', '2020-09-26', '2014-09-26', '2026-02-30', '15/10/26', '', null, 20261015];
for (const day of days) console.log(`  read ${JSON.stringify(day)} → ${JSON.stringify(rd.readDateBeforeStatements(day))}`);
check(rd.readDateBeforeStatements('2026-10-15') === '2026-10-15' && rd.readDateBeforeStatements('2026-10-31') === '2026-10-31' && rd.readDateBeforeStatements('2025-11-01') === '2025-11-01', 'a real date in the twelve months before November 2026 holds the receipt back');
check(rd.readDateBeforeStatements('2026-11-01') === null, '1 November 2026 and after: sent as usual');
check(['2025-10-31', '2020-09-26', '2014-09-26'].every((d) => rd.readDateBeforeStatements(d) === null), 'a date further back is taken as a misreading of a two-digit year (measured 2026-09-30) and holds nothing back');
check(['2026-02-30', '15/10/26', '', null, 20261015].every((d) => rd.readDateBeforeStatements(d) === null), 'no date, another format, or a day that does not exist holds nothing back');
const SECRET = Buffer.alloc(32, 7);
const recordFor = (purchasedOn, status = 'ok') => ({ v: 1, id: '6a5b4c3d-2e1f-4a0b-8c9d-0e1f2a3b4c5d', cleanerId: ANA, requestedAt: '2028-11-21T15:00:00.000Z', model: 'gemini-3.8-flash', modelVersion: 'stand-in', thinkingLevel: 'low', ms: 7, status, reason: status === 'ok' ? null : 'http_500', usage: null, output: status === 'ok' ? { store: 'Test store', purchasedOn, lines: [{ name: 'Gloves', quantity: 1, amount: '12.00', kind: 'item' }], subtotal: '12.00', total: '12.00', unreadable: false, notes: null } : null, rawText: null });
for (const [purchasedOn, status] of [['2026-10-15', 'ok'], ['2028-11-20', 'ok'], [null, 'ok'], ['2026-10-15', 'failed']]) {
  const signed = signReading(recordFor(purchasedOn, status), readingKey(SECRET));
  const attachment = parseReadingPart(JSON.stringify({ ...signed, fromReading: [0] }), SECRET, ANA, 1);
  const routeSays = attachment ? rd.recordDatedBeforeStatements(attachment.record) : 'reading dropped';
  const draft = { photoKey: 'p1', reading: { photoKey: 'p1', readingText: signed.readingText, signature: signed.signature, applied: 1 } };
  const phoneSays = readingDatedBefore(draft);
  const otherPhoto = readingDatedBefore({ ...draft, photoKey: 'p2' });
  console.log(`  a reading (${status}) dated ${JSON.stringify(purchasedOn)}: the route holds back ${JSON.stringify(routeSays)} · the phone holds back ${JSON.stringify(phoneSays)} · after a new photo ${JSON.stringify(otherPhoto)}`);
}
const held = (purchasedOn, status = 'ok') => { const signed = signReading(recordFor(purchasedOn, status), readingKey(SECRET)); return [rd.recordDatedBeforeStatements(parseReadingPart(JSON.stringify({ ...signed, fromReading: [0] }), SECRET, ANA, 1)?.record), readingDatedBefore({ photoKey: 'p1', reading: { photoKey: 'p1', readingText: signed.readingText, signature: signed.signature, applied: 1 } })]; };
check(held('2026-10-15').every((x) => x === '2026-10-15'), 'the route and the phone hold back the same receipt, from the same signed reading');
check(held('2028-11-20').every((x) => x === null) && held(null).every((x) => x === null) && held('2026-10-15', 'failed').every((x) => x === null), 'a later date, no date, or a reading that failed holds nothing back');
const draftNew = { photoKey: 'p2', reading: { photoKey: 'p1', readingText: signReading(recordFor('2026-10-15'), readingKey(SECRET)).readingText, signature: 'x', applied: 1 } };
check(readingDatedBefore(draftNew) === null, 'a retaken photo is judged by its own reading, not the last one');

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
