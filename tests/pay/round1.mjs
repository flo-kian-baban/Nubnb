// The Team page, round 1 (the Team page audit of 2026-10-19; Kian's rulings K1–K5): the questions before a payment
// (K1 while anything is not counted, K2 above the balance), the delete refusal (K3, with the ruling of 2026-10-15),
// the order a missing amount's field opens with on the pay view (preset, then the admin-typed recommendation, then
// empty; never a share), a history sent without codes (K5), the regular-cleaner record's history (schema version 2) and
// the replacements applied with a deactivation or delete (K4) — the last on an in-memory Firestore
// (tests/tools/memory-firestore.cjs): nothing is read from or written to Firestore or Storage, and every connection is
// refused. Made-up data only: properties "TESTPROP…", cleaners "Test …", amounts with no production meaning.
//   node --import ./tests/tools/ts-hook.mjs tests/pay/round1.mjs
import { createRequire } from 'node:module';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.NUBNB_ROOT || fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
createRequire(`${ROOT}/package.json`)(`${ROOT}/tests/tools/memory-firestore.cjs`);
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.FIREBASE_SERVICE_ACCOUNT_KEY = JSON.stringify({ type: 'service_account', project_id: 'memory-test', private_key_id: 'memory-test', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), client_email: 'memory-test@memory-test.iam.gserviceaccount.com', client_id: '0', token_uri: 'https://oauth2.invalid/token' });
process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = 'memory-test.appspot.com';
process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = 'memory-test';

const checks = await import(`${ROOT}/app/lib/pay/checks.ts`);
const pr = await import(`${ROOT}/app/lib/cleanings/prices.ts`);
const cm = await import(`${ROOT}/app/lib/cleaners/model.ts`);
const reg = await import(`${ROOT}/app/lib/schedule/regular.ts`);
const jm = await import(`${ROOT}/app/lib/schedule/model.ts`);
const { syncJobs, calendarKeyOf } = await import(`${ROOT}/app/lib/schedule/store.ts`);
const sc = await import(`${ROOT}/app/lib/firebase/server-cleaners.ts`);
const sr = await import(`${ROOT}/app/lib/firebase/server-regular-cleaners.ts`);
const cl = await import(`${ROOT}/app/lib/firebase/server-cleanings.ts`);
const ce = await import(`${ROOT}/app/lib/firebase/server-cost-entries.ts`);
const { getAdminDb } = await import(`${ROOT}/app/lib/firebase/admin.ts`);
const db = getAdminDb();
const seed = globalThis.__memSeed;
const doc = globalThis.__memDoc;

let failures = 0;
const check = (ok, label) => {
  if (!ok) failures += 1;
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${label}`);
};
const readsOf = (fn) => async (...args) => {
  const before = globalThis.__memReads.length;
  const result = await fn(...args);
  const part = globalThis.__memReads.slice(before);
  const by = {};
  for (const r of part) {
    const k = r.what.replace(/^([a-z_]+)(\/| where).*$/, '$1');
    by[k] = (by[k] ?? 0) + r.billed;
  }
  return { result, reads: part.reduce((n, r) => n + r.billed, 0), by };
};
const byText = (by) => Object.entries(by).sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `${k} ${n}`).join(', ');
const q = (question) => `"${question.title}" / ${question.lines.join(' / ')} / [${question.confirm}]`;

// ═══ 1. K1 and K2: the questions before a payment ═══
console.log('═══ 1. Before a payment: K1 (not all counted) and K2 (more than is owed), in that order ═══');
const standing = (balanceCents, noAmount = 0, waitingReview = 0, cannotAddUp = 0) => ({ balanceCents, noAmount, waitingReview, cannotAddUp });
const cases = [
  ['owed $300, paying $300, nothing waiting', standing(30_000), 30_000],
  ['owed $300, paying $300, 2 cleanings with no amount and 1 receipt under review', standing(30_000, 2, 1), 30_000],
  ['owed $300, paying $500, nothing waiting', standing(30_000), 50_000],
  ['owed $300, paying $500, 1 cleaning with no amount', standing(30_000, 1), 50_000],
  ['settled, paying $80', standing(0), 8_000],
  ['overpaid $20, paying $50', standing(-2_000), 5_000],
  ['settled, 3 cleanings with no amount, paying $0.01', standing(0, 3), 1],
];
for (const [label, pay, cents] of cases) {
  const questions = checks.recordQuestions(pay, cents, 'Test Ana');
  console.log(`  ${label}: ${questions.length === 0 ? 'no question' : questions.map(q).join(' THEN ')}`);
}
check(checks.recordQuestions(standing(30_000), 30_000, 'Test Ana').length === 0, 'nothing waiting and not above the balance: no question');
check(checks.recordQuestions(standing(30_000, 2, 1), 30_000, 'Test Ana').length === 1 && /2 cleanings have no amount yet, and 1 receipt or work entry is waiting for review/.test(checks.recordQuestions(standing(30_000, 2, 1), 30_000, 'Test Ana')[0].lines[0]), 'K1 names the counts');
check(/balance of \$300\.00 owed does not include them/.test(checks.recordQuestions(standing(30_000, 2, 1), 30_000, 'Test Ana')[0].lines[1]), 'K1 says the balance does not include them');
check(checks.recordQuestions(standing(30_000), 50_000, 'Test Ana')[0].title === 'This pays $200.00 more than Test Ana is owed. Record it as an advance?', 'K2 in Kian\'s words, $X the amount above the balance');
check(checks.recordQuestions(standing(30_000, 1), 50_000, 'Test Ana').map((x) => x.confirm).join(',') === 'Record anyway,Record as an advance', 'both: K1 first, then K2');
check(checks.recordQuestions(standing(-2_000), 5_000, 'Test Ana')[0].title.startsWith('This pays $50.00 more'), 'overpaid already: the whole payment is above what is owed');

// ═══ 2. K3: the delete refusal ═══
console.log('\n═══ 2. Deleting a member: refused with a balance (2026-10-15), with records that cannot be read, or with anything not counted (K3) ═══');
for (const [label, pay, uncertain] of [
  ['settled, nothing waiting', standing(0), 0],
  ['owed $12.50', standing(1_250), 0],
  ['overpaid $5.00 and 1 cleaning with no amount', standing(-500, 1), 0],
  ['settled, 1 record not in shape', standing(0), 1],
  ['settled, 1 entry that cannot add up', standing(0, 0, 0, 1), 0],
  ['settled, 2 cleanings with no amount', standing(0, 2), 0],
  ['settled, 1 receipt under review', standing(0, 0, 1), 0],
  ['settled, 1 cleaning with no amount and 2 entries under review', standing(0, 1, 2), 0],
]) {
  const refusal = checks.deleteRefusal(pay, uncertain, 'Test Ana');
  console.log(`  ${label}: ${refusal ? `${refusal.code} — ${refusal.message} ${refusal.hint}` : 'may be deleted'}`);
}
check(checks.deleteRefusal(standing(0), 0, 'Test Ana') === null, 'settled with nothing waiting: may be deleted');
check(checks.deleteRefusal(standing(1_250), 0, 'Test Ana')?.code === 'MEMBER_HAS_BALANCE', 'a balance: MEMBER_HAS_BALANCE');
check(checks.deleteRefusal(standing(0, 2), 0, 'Test Ana')?.code === 'MEMBER_HAS_OUTSTANDING' && /2 cleanings have no amount yet/.test(checks.deleteRefusal(standing(0, 2), 0, 'Test Ana').message), 'only cleanings with no amount: MEMBER_HAS_OUTSTANDING, naming them');
check(checks.deleteRefusal(standing(0, 0, 1), 0, 'Test Ana')?.code === 'MEMBER_HAS_OUTSTANDING' && /waiting for review/.test(checks.deleteRefusal(standing(0, 0, 1), 0, 'Test Ana').message), 'only an entry under review: refused too');
check([standing(1_250), standing(0, 2), standing(0, 0, 1), standing(0), standing(0, 0, 0, 1)].every((pay) => (checks.deleteRefusal(pay, 0, 'Test Ana')?.hint ?? 'Deactivate them instead. Nothing was deleted.') === 'Deactivate them instead. Nothing was deleted.'), 'every refusal points to Deactivate');

// ═══ 3. The pay view's field: preset, then the recommendation, then empty; never a share ═══
console.log('\n═══ 3. What a missing amount\'s field opens with on the pay view (the same rule as the Cleanings tab) ═══');
const P1 = 'TESTPROPteamr1aaaaa1'; // short $80, long $120
const P2 = 'TESTPROPteamr1aaaaa2'; // no preset; $70 typed short-term before
const P3 = 'TESTPROPteamr1aaaaa3'; // nothing at all
const P4 = 'TESTPROPteamr1aaaaa4'; // long preset only
const P5 = 'TESTPROPteamr1aaaaa5'; // Ana's too, replaced by nobody
const ANA = { id: 'TESTCLEANERteamr1ana', name: 'Test Ana' };
const prices = { [P1]: { shortTermCents: 8_000, longTermCents: 12_000 }, [P4]: { shortTermCents: null, longTermCents: 15_000 } };
const facts = (id, propertyId, day, amountCents, amountFrom, jobId, from = 'short') => ({ id, propertyId, day, createdAt: `${day}T15:00:00.000Z`, status: 'logged', amountCents, amountFrom, suggested: { from, cents: null }, jobId });
const jobs = { [`${P1}_2028-11-10`]: { nights: 2, cleaners: 1 }, [`${P1}_2028-11-11`]: { nights: 30, cleaners: 1 }, [`${P1}_2028-11-12`]: { nights: 2, cleaners: 2 }, [`${P2}_2028-11-10`]: { nights: 2, cleaners: 1 }, [`${P2}_2028-11-09`]: { nights: 3, cleaners: 1 }, [`${P3}_2028-11-10`]: { nights: 2, cleaners: 1 }, [`${P4}_2028-11-10`]: { nights: 2, cleaners: 1 } };
const waiting = [
  ['P1 short stay, preset $80', facts('c1', P1, '2028-11-10', null, null, `${P1}_2028-11-10`)],
  ['P1 30-night stay, long preset $120', facts('c2', P1, '2028-11-11', null, null, `${P1}_2028-11-11`)],
  ['P1 two cleaners on the job', facts('c3', P1, '2028-11-12', null, null, `${P1}_2028-11-12`)],
  ['P2 no preset, $70 typed before (short-term)', facts('c4', P2, '2028-11-10', null, null, `${P2}_2028-11-10`)],
  ['P3 nothing', facts('c5', P3, '2028-11-10', null, null, `${P3}_2028-11-10`)],
  ['P4 long preset only, a short stay', facts('c6', P4, '2028-11-10', null, null, `${P4}_2028-11-10`)],
];
const earlier = [facts('t1', P2, '2028-11-09', 7_000, 'typed', `${P2}_2028-11-09`), facts('t2', P2, '2028-11-05', 9_000, 'typed', null, 'long')];
const all = [...earlier, ...waiting.map(([, c]) => c)];
// The pay view's rule: a preset or a recommendation is put in the field; a split or nothing leaves it empty.
const fieldOf = (start) => (start.kind === 'preset' || start.kind === 'recommendation' ? (start.cents / 100).toFixed(2) : '');
const starts = waiting.map(([label, c]) => [label, pr.missingAmountStart(prices[c.propertyId] ?? null, all, jobs, c)]);
for (const [label, start] of starts) console.log(`  ${label}: ${JSON.stringify(start)} → field "${fieldOf(start)}"`);
check(starts[0][1].kind === 'preset' && fieldOf(starts[0][1]) === '80.00' && starts[1][1].kind === 'preset' && fieldOf(starts[1][1]) === '120.00', 'a preset for the tier: the field opens with it');
check(starts[2][1].kind === 'split' && fieldOf(starts[2][1]) === '', 'two cleaners on the job: never prefilled, with a preset or not');
check(starts[3][1].kind === 'recommendation' && fieldOf(starts[3][1]) === '70.00' && pr.recommendationWords(starts[3][1].tier, starts[3][1].cents) === 'Last typed for short-term: $70.00', 'no preset: the last amount typed there in the tier, labelled');
check(starts[4][1].kind === 'none' && fieldOf(starts[4][1]) === '', 'no preset and nothing typed: empty');
check(starts[5][1].kind === 'none', 'a preset for the other tier only: nothing for this one');

// ═══ 4. K5: a history sent without codes ═══
console.log('\n═══ 4. K5: a code change\'s history entry leaves without the old or new code ═══');
const ADMIN = { role: 'admin', id: 'TESTADMINteamr1aaaa1', name: 'Test admin' };
const stored = {
  name: 'Test Ana', code: '4071', status: 'active', role: 'cleaner', createdAt: '2026-10-02T14:00:00.000Z', sessionEpoch: 3,
  history: [
    { at: '2026-10-02T14:00:00.000Z', action: 'created', from: null, to: 'active', actor: ADMIN, reason: null },
    { at: '2026-10-19T15:30:00.000Z', action: 'code_changed', from: '2583', to: '4071', actor: ADMIN, reason: null },
    { at: '2026-10-16T22:00:00.000Z', action: 'deactivated', from: 'active', to: 'deactivated', actor: ADMIN, reason: null },
    { at: '2026-10-17T13:00:00.000Z', action: 'code_released', from: '2583', to: null, actor: ADMIN, reason: 'Given to another team member' },
  ],
};
const summary = cm.readCleanerSummary(ANA.id, stored);
console.log(`  history as sent: ${summary.history.map((e) => `${e.action} from=${JSON.stringify(e.from)} to=${JSON.stringify(e.to)}`).join(' · ')}`);
console.log(`  in words: ${summary.history.map(cm.accountEventWords).join(' · ')}`);
const sent = JSON.stringify({ ...summary, code: '<the current code, shown by Kian\'s ruling of 2026-09-28>' });
check(summary.history[1].from === null && summary.history[1].to === null && summary.history[3].from === null, 'code_changed and code_released leave with from and to blanked');
check(summary.history[0].to === 'active' && summary.history[2].from === 'active', 'a status event keeps its from and to');
check(!/\b(2583|4071)\b/.test(sent), 'no code value in what is sent (the current code aside)');
check(cm.accountEventWords(summary.history[1]) === 'Code changed by Test admin on Oct 19, 2026', 'the words: "Code changed by <admin> on <day>"');
check(cm.withoutCodes(null) === null, 'no history stays none');

// ═══ 5. The regular-cleaner record, schema version 2 ═══
console.log('\n═══ 5. The regular-cleaner record: a history, and nobody named (schema version 2) ═══');
const BEN = { id: 'TESTCLEANERteamr1ben', name: 'Test Ben' };
const v1 = { schemaVersion: 1, propertyId: P1, cleanerId: ANA.id, cleanerNameAtSet: ANA.name, setAt: '2026-10-18T12:00:00.000Z', setBy: ADMIN };
const r1 = reg.readRegularCleaner(P1, v1);
console.log(`  a version 1 record reads: ${JSON.stringify({ ...r1 })}`);
const event = reg.regularEvent('2026-10-19T16:00:00.000Z', 'replaced', ADMIN, { cleanerId: ANA.id, name: ANA.name }, { cleanerId: BEN.id, name: BEN.name }, 'deactivated');
const v2 = reg.regularRecordAfter(P1, r1, { cleanerId: BEN.id, name: BEN.name }, event);
console.log(`  after a replacement: ${JSON.stringify(v2)}`);
console.log(`  in words: ${reg.regularEventWords(event)} · ${reg.regularEventWords(reg.regularEvent('2026-10-19T16:00:00.000Z', 'cleared', ADMIN, { cleanerId: BEN.id, name: BEN.name }, null))} · ${reg.regularEventWords(reg.regularEvent('2026-10-19T16:00:00.000Z', 'set', ADMIN, null, { cleanerId: ANA.id, name: ANA.name }))}`);
const nobody = reg.regularRecordAfter(P1, v2, null, reg.regularEvent('2026-10-19T17:00:00.000Z', 'replaced', ADMIN, { cleanerId: BEN.id, name: BEN.name }, null, 'deleted'));
check(r1 !== null && r1.history.length === 0, 'a version 1 record reads with an empty history');
check(reg.readRegularCleaner(P1, v2) !== null && v2.schemaVersion === 2 && v2.cleanerId === BEN.id && v2.history.length === 1, 'the record after a replacement reads back, naming the replacement, one event');
check(reg.readRegularCleaner(P1, nobody)?.cleanerId === null && reg.readRegularCleaner(P1, nobody)?.history.length === 2, 'a record naming nobody reads back, with both events');
for (const [label, fields] of [
  ['version 1 naming nobody', { ...v1, cleanerId: null }],
  ['an event of an unknown action', { ...v2, history: [{ ...event, action: 'moved' }] }],
  ['an event with a reason that is not deactivated or deleted', { ...v2, history: [{ ...event, reason: 'left' }] }],
  ['another property\'s ID', { ...v2, propertyId: P2 }],
]) console.log(`  refused as not in shape — ${label}: ${reg.readRegularCleaner(P1, fields) === null}`);
check(reg.replacementAssigns({ id: BEN.id, name: BEN.name, role: 'cleaner', status: 'active' }, ANA.id) && !reg.replacementAssigns({ id: ANA.id, name: ANA.name, role: 'cleaner', status: 'active' }, ANA.id) && !reg.replacementAssigns({ id: BEN.id, name: BEN.name, role: 'cleaner', status: 'deactivated' }, ANA.id), 'a replacement is an active cleaner other than the person leaving');

// ═══ 6. On the in-memory Firestore: K3 refused on the server, K4 applied with a deactivation and a delete ═══
console.log('\n═══ 6. The server: K3 inside the delete, K4 inside the deactivation and the delete, the next job to the replacement ═══');
const TODAY = '2026-10-19';
const RUN = '2026-10-19T11:00:00.000Z';
const DEE = { id: 'TESTCLEANERteamr1dee', name: 'Test Dee' };
const HANDY = { id: 'TESTHANDYMANteamr1hn', name: 'Test Handy' };
const LINK = (p) => `https://www.airbnb.ca/calendar/ical/${p}.ics?s=made-up`;
const cleanerDoc = (m, role, status) => ({ schemaVersion: 2, name: m.name, role, status, sessionEpoch: 1, history: [{ at: RUN, action: 'created', from: null, to: 'active', actor: ADMIN, reason: null }] });
seed('cleaners', ANA.id, cleanerDoc(ANA, 'cleaner', 'active'));
seed('cleaners', BEN.id, cleanerDoc(BEN, 'cleaner', 'active'));
seed('cleaners', DEE.id, cleanerDoc(DEE, 'cleaner', 'deactivated'));
seed('cleaners', HANDY.id, cleanerDoc(HANDY, 'handyman', 'active'));
const names = ['One', 'Two', 'Three', 'Four', 'Five'];
for (const [i, pid] of [P1, P2, P3, P4, P5].entries()) seed('properties', pid, { name: `Test ${names[i]}`, icalUrl: LINK(names[i]), details: { checkOut: '11:00', checkIn: '16:00' } });
seed('property_cleaner_names', P1, { schemaVersion: 1, propertyId: P1, name: 'Test 1 Round St', setAt: RUN });
seed(reg.PROPERTY_REGULAR_CLEANERS_COLLECTION, P1, { ...v1 });
seed(reg.PROPERTY_REGULAR_CLEANERS_COLLECTION, P2, { ...v1, propertyId: P2 });
seed(reg.PROPERTY_REGULAR_CLEANERS_COLLECTION, P3, { ...v1, propertyId: P3, cleanerId: BEN.id, cleanerNameAtSet: BEN.name });
seed(reg.PROPERTY_REGULAR_CLEANERS_COLLECTION, P4, { ...v1, propertyId: P4, cleanerId: DEE.id, cleanerNameAtSet: DEE.name });
seed(reg.PROPERTY_REGULAR_CLEANERS_COLLECTION, P5, { ...v1, propertyId: P5 });
// Ana's open job on P1 tomorrow (not marked), and her cleaning with no amount on P1 (a mark the office has not typed yet).
const jobTomorrow = jm.jobIdOf(P1, '2026-10-20');
seed('cleaning_jobs', jobTomorrow, { schemaVersion: jm.JOB_SCHEMA_VERSION, propertyId: P1, propertyNameAtCreation: 'Test One', checkout: '2026-10-20', reservation: { uid: 'r-tomorrow', start: '2026-10-18' }, calendarKey: calendarKeyOf(LINK('One')), nextCheckIn: null, status: 'open', change: null, cleanerIds: [ANA.id], assignments: { [ANA.id]: { nameAtAssignment: ANA.name, assignedAt: RUN, assignedBy: reg.REGULAR_CLEANER_ACTOR, cleaningId: null, markedAt: null, removedAt: null, removedBy: null } }, createdAt: RUN, history: [jm.jobEvent(RUN, 'created', jm.CALENDAR_ACTOR, { after: { start: '2026-10-18', end: '2026-10-20' } }), jm.jobEvent(RUN, 'assigned', reg.REGULAR_CLEANER_ACTOR, { cleanerId: ANA.id, cleanerName: ANA.name })] });
const jobYesterday = jm.jobIdOf(P1, '2026-10-18');
seed('cleaning_jobs', jobYesterday, { schemaVersion: jm.JOB_SCHEMA_VERSION, propertyId: P1, propertyNameAtCreation: 'Test One', checkout: '2026-10-18', reservation: { uid: 'r-yesterday', start: '2026-10-16' }, calendarKey: calendarKeyOf(LINK('One')), nextCheckIn: null, status: 'open', change: null, cleanerIds: [ANA.id], assignments: { [ANA.id]: { nameAtAssignment: ANA.name, assignedAt: RUN, assignedBy: ADMIN, cleaningId: 'TESTCLEANINGteamr1c1', markedAt: '2026-10-18T16:00:00.000Z', removedAt: null, removedBy: null } }, createdAt: RUN, history: [jm.jobEvent(RUN, 'created', jm.CALENDAR_ACTOR, { after: { start: '2026-10-16', end: '2026-10-18' } })] });
seed('cleanings', 'TESTCLEANINGteamr1c1', { schemaVersion: 3, propertyId: P1, propertyNameAtEntry: 'Test One', cleanerId: ANA.id, cleanerNameAtEntry: ANA.name, day: '2026-10-18', amountCents: null, note: null, status: 'logged', suggested: { from: 'short', cents: null }, amountFrom: null, createdAt: '2026-10-18T16:00:00.000Z', actor: { role: 'cleaner', id: ANA.id, name: ANA.name }, history: [{ at: '2026-10-18T16:00:00.000Z', action: 'logged', actor: { role: 'cleaner', id: ANA.id, name: ANA.name }, reason: null }], jobId: jobYesterday });

// K3 on the server: Ana has a cleaning with no amount.
const refused = await readsOf(sc.deleteCleaner)(ADMIN, ANA.id);
console.log(`  delete Ana (a cleaning with no amount, settled otherwise): ${JSON.stringify({ kind: refused.result.kind, code: refused.result.refusal?.code, message: refused.result.refusal?.message })} · reads ${refused.reads} (${byText(refused.by)})`);
check(refused.result.kind === 'cannot-delete' && refused.result.refusal.code === 'MEMBER_HAS_OUTSTANDING' && doc('cleaners', ANA.id) !== null, 'K3: refused inside the transaction, nothing written');

// The team's schedule read, before.
const before = await readsOf(sr.teamSchedule)(TODAY);
console.log(`  the Team page's schedule read: ${JSON.stringify(before.result)} · reads ${before.reads} (${byText(before.by)})`);
check((before.result.regular[ANA.id] ?? []).map((p) => p.name).join(',') === 'Test 1 Round St,Test Five,Test Two' && before.result.upcoming[ANA.id] === 1 && before.result.upcoming[BEN.id] === undefined, 'regular properties by the name the admin knows them by; jobs ahead count the open jobs from today on');

// K4 with a deactivation: P1 → Ben, P5 → nobody, P2 → Ana herself (never), P3 → Ben (not Ana's), a property with no record, P4 → Ben (Dee's, not Ana's).
const deactivated = await readsOf(sc.setCleanerStatus)(ADMIN, ANA.id, 'deactivated', { [P1]: BEN.id, [P5]: null, [P2]: ANA.id, [P3]: BEN.id, TESTPROPteamr1nothere: BEN.id, [P4]: BEN.id });
console.log(`  deactivate Ana with replacements: ${deactivated.result.kind} · taken off ${deactivated.result.jobsTakenOff.map((j) => `${j.propertyName} ${j.checkout}`).join(', ')} · regular: ${deactivated.result.regular.map((r) => `${r.name} ${r.outcome}${r.to ? ` → ${r.to.name}` : ''}`).join('; ')} · reads ${deactivated.reads} (${byText(deactivated.by)})`);
const p1After = reg.readRegularCleaner(P1, doc(reg.PROPERTY_REGULAR_CLEANERS_COLLECTION, P1));
const p5After = reg.readRegularCleaner(P5, doc(reg.PROPERTY_REGULAR_CLEANERS_COLLECTION, P5));
const p2After = doc(reg.PROPERTY_REGULAR_CLEANERS_COLLECTION, P2);
const p3After = doc(reg.PROPERTY_REGULAR_CLEANERS_COLLECTION, P3);
const p4After = reg.readRegularCleaner(P4, doc(reg.PROPERTY_REGULAR_CLEANERS_COLLECTION, P4));
const eventsOf = (history) => history.map((e) => `${e.action} ${e.from?.name ?? 'nobody'} → ${e.to?.name ?? 'nobody'}${e.reason ? ` (${e.reason})` : ''} by ${e.actor.name}`).join('; ');
console.log(`  P1 now: ${p1After.cleanerId === BEN.id ? 'Ben' : p1After.cleanerId} · ${eventsOf(p1After.history)}`);
console.log(`  P5 now: ${p5After.cleanerId ?? 'nobody'} · ${eventsOf(p5After.history)}`);
console.log(`  P2 (herself chosen): version ${p2After.schemaVersion}, names ${p2After.cleanerId === ANA.id ? 'Ana' : '?'} · P3 (Ben's): version ${p3After.schemaVersion}, names ${p3After.cleanerId === BEN.id ? 'Ben' : '?'}, history ${JSON.stringify(p3After.history ?? 'none')} · P4 (Dee's): version ${p4After.schemaVersion}, names ${p4After.cleanerId === DEE.id ? 'Dee' : '?'}`);
const tomorrow = jm.readJob(jobTomorrow, doc('cleaning_jobs', jobTomorrow));
console.log(`  the job tomorrow: on it ${tomorrow.cleanerIds.length ? tomorrow.cleanerIds.join(',') : 'nobody'} · last event ${tomorrow.history[tomorrow.history.length - 1].action} (${tomorrow.history[tomorrow.history.length - 1].reason})`);
check(deactivated.result.kind === 'done' && deactivated.result.regular.map((r) => r.outcome).join(',') === 'replaced,cleared,not-assignable,not-theirs,not-theirs,not-theirs', 'the outcomes: replaced, cleared, herself refused, three left as they were (not hers)');
check(p1After.schemaVersion === 2 && p1After.cleanerId === BEN.id && p1After.history.length === 1 && p1After.history[0].action === 'replaced' && p1After.history[0].reason === 'deactivated' && p1After.history[0].from.cleanerId === ANA.id, 'P1: Ben, one "replaced (deactivated)" event from Ana');
check(p5After.schemaVersion === 2 && p5After.cleanerId === null && p5After.history[0].to === null, 'P5: nobody, recorded');
check(p2After.schemaVersion === 1 && p2After.cleanerId === ANA.id && p3After.schemaVersion === 1 && p3After.history === undefined && p4After.cleanerId === DEE.id, 'P2, P3 and P4: untouched (P2 still names Ana, deactivated: it assigns nobody)');
check(tomorrow.cleanerIds.length === 0 && tomorrow.history[tomorrow.history.length - 1].action === 'unassigned', 'existing jobs follow round 1: Ana comes off, nobody is put on in her place');
check(doc('cleaners', ANA.id).status === 'deactivated' && doc('cleaners', ANA.id).sessionEpoch === 2, 'Ana is deactivated, her sessions ended');

// The next job the sync makes for P1 goes to Ben; for P2 to nobody.
const reserved = (uid, start, end) => ({ uid, kind: 'reserved', start, end });
const feed = (name, events) => ({ name, icalUrl: LINK(name), status: 'ok', fetchedAt: RUN, bytes: 1, eventCount: events.length, events });
const copy = (properties) => ({ version: 1, refreshedAt: RUN, today: TODAY, horizonEnd: '2027-10-19', run: { source: 'daily', startedAt: RUN, finishedAt: RUN, durationMs: 0, fetched: 0, failed: [], pagesChecked: 0 }, properties });
const synced = await readsOf(syncJobs)(db, copy({ [P1]: feed('One', [reserved('r-next', '2026-10-19', '2026-10-21')]), [P2]: feed('Two', [reserved('r-next2', '2026-10-19', '2026-10-21')]), [P5]: feed('Five', [reserved('r-next5', '2026-10-19', '2026-10-21')]) }));
const jobOf = (pid) => jm.readJob(jm.jobIdOf(pid, '2026-10-21'), doc('cleaning_jobs', jm.jobIdOf(pid, '2026-10-21')) ?? {});
const nextP1 = jobOf(P1);
const nextP2 = jobOf(P2);
const nextP5 = jobOf(P5);
console.log(`  the sync: ${JSON.stringify(synced.result)} · P1's new job: on it ${nextP1?.cleanerIds.join(',') || 'nobody'} (${nextP1?.history[nextP1.history.length - 1].actor.name}) · P2's (Ana, deactivated): on it ${nextP2?.cleanerIds.join(',') || 'nobody'} · P5's (nobody named): on it ${nextP5?.cleanerIds.join(',') || 'nobody'} · reads ${synced.reads} (${byText(synced.by)})`);
check(nextP1?.cleanerIds.join(',') === BEN.id && nextP1.history[nextP1.history.length - 1].actor.name === 'regular cleaner' && nextP2?.cleanerIds.length === 0 && nextP5?.cleanerIds.length === 0, 'the next job on P1 goes to Ben by "regular cleaner"; P2\'s (a deactivated regular cleaner) and P5\'s (nobody) to nobody');

// The schedule read after: Ben regular for P1 and P3, with a job ahead.
const after = await readsOf(sr.teamSchedule)(TODAY);
console.log(`  the schedule read after: ${JSON.stringify(after.result)} · reads ${after.reads}`);
check((after.result.regular[BEN.id] ?? []).map((p) => p.name).join(',') === 'Test 1 Round St,Test Three' && after.result.upcoming[BEN.id] === 1 && (after.result.regular[ANA.id] ?? []).map((p) => p.name).join(',') === 'Test Two' && after.result.upcoming[ANA.id] === undefined, 'after: Ben is the regular cleaner for P1 and P3, with one job ahead; Ana only for P2 (left as it was), with no job ahead');

// K4 with a delete: Dee (deactivated, nothing owed, regular for P4) deleted with P4 → Ben.
const deleted = await readsOf(sc.deleteCleaner)(ADMIN, DEE.id, { [P4]: BEN.id });
const p4Final = reg.readRegularCleaner(P4, doc(reg.PROPERTY_REGULAR_CLEANERS_COLLECTION, P4));
console.log(`  delete Dee with P4 → Ben: ${deleted.result.kind} · regular: ${deleted.result.regular.map((r) => `${r.name} ${r.outcome}${r.to ? ` → ${r.to.name}` : ''}`).join('; ')} · P4 now ${eventsOf(p4Final.history)} · reads ${deleted.reads} (${byText(deleted.by)})`);
check(deleted.result.kind === 'deleted' && doc('cleaners', DEE.id) === null && p4Final.cleanerId === BEN.id && p4Final.history[0].reason === 'deleted', 'K4 with a delete: the account is gone, P4 names Ben, "replaced (deleted)" recorded');

// A clear by hand keeps the record (schema version 2), and the read says none.
const clearedP3 = await sr.setRegularCleaner(ADMIN, P3, null);
const p3Read = await sr.getRegularCleaner(P3);
console.log(`  clearing P3 by hand: ${clearedP3.kind} · reads back as ${JSON.stringify(p3Read.regular)} with history ${eventsOf(p3Read.history ?? [])}`);
check(clearedP3.kind === 'cleared' && p3Read.regular === null && (p3Read.history ?? []).length === 1, 'a clear keeps the record naming nobody, read as none, its history kept');

// What the missing amounts start from, and the whole costs read without repeated property lookups.
seed(pr.PROPERTY_CLEANING_PRICES_COLLECTION, P1, { schemaVersion: 1, propertyId: P1, shortTermCents: 8_000, longTermCents: 12_000, setAt: RUN, setBy: ADMIN, history: [] });
const started = await readsOf(cl.amountStarts)([P1, P2, 'not an id'], [jobYesterday, `${P2}_2026-10-01`, 'bad job id']);
console.log(`  amount starts for P1, P2 and the job yesterday: ${JSON.stringify(started.result)} · reads ${started.reads} (${byText(started.by)})`);
check(started.result.prices[P1]?.shortTermCents === 8_000 && started.result.prices[P2] === undefined && started.result.jobs[jobYesterday]?.nights === 2 && started.result.jobs[jobYesterday]?.cleaners === 1 && started.reads === 4, 'presets and job facts for what exists, one read each; IDs not in shape skipped');
const costs = await readsOf(ce.listCosts)();
console.log(`  the whole costs read: ${costs.result.cleanings.length} cleaning, ${costs.result.properties.length} properties · reads ${costs.reads} (${byText(costs.by)})`);
check(costs.by.properties === 5 && costs.result.cleanings[0].property.internalName === 'Test 1 Round St', 'the cleanings\' properties are not looked up a second time: five properties, five property reads, the address still on the cleaning');

console.log(`\n${failures === 0 ? 'every check held' : `${failures} check(s) failed`}`);
if (failures > 0) process.exitCode = 1;
