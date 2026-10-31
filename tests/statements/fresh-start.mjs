// The fresh start of 1 November 2026 (Kian's rulings of 2026-10-31): statements begin with November 2026, so no
// September or October statement is owed. The first statement month is STATEMENTS_FROM_DEFAULT
// (app/lib/reports/model.ts), read through the one rule (statementMonths, inStatementScope) by the property list's
// Statement column, the property page, the home panel, the Statements tile, Finish, empty months and the backup's
// check; a record's start month narrows it and never widens it, so the records written with 2026-09 owe from November
// like any other. The office cost's month starts there too, and the Income page's "owes no statement" (I5) reads the
// same first month. Made-up data only: properties "TESTPROP…"; the Income read runs the app's server code on the
// in-memory Firestore (tests/tools/memory-firestore.cjs). Nothing is read from or written to Firestore or Storage.
//   node --import ./tests/tools/ts-hook.mjs tests/statements/fresh-start.mjs
import { createRequire } from 'node:module';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.NUBNB_ROOT || fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
createRequire(`${ROOT}/package.json`)(`${ROOT}/tests/tools/memory-firestore.cjs`);
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2_048 });
process.env.FIREBASE_SERVICE_ACCOUNT_KEY = JSON.stringify({ type: 'service_account', project_id: 'memory-test', private_key_id: 'memory-test', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), client_email: 'memory-test@memory-test.iam.gserviceaccount.com', client_id: '1', token_uri: 'https://oauth2.googleapis.com/token' });
process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = 'memory-test.appspot.com';
process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = 'memory-test';

const model = await import(`${ROOT}/app/lib/reports/model.ts`);
const st = await import(`${ROOT}/app/lib/reports/statement.ts`);
const { emptyMonth } = await import(`${ROOT}/app/lib/reports/empty.ts`);
const ce = await import(`${ROOT}/app/lib/firebase/server-cost-entries.ts`);
const income = await import(`${ROOT}/app/lib/firebase/server-income.ts`);

let failures = 0;
const check = (ok, label) => {
  if (!ok) failures += 1;
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${label}`);
};
const P = (n) => `TESTPROPfresh${String(n).padStart(7, '0')}`;
const record = (propertyId, over = {}) => ({ id: propertyId, schemaVersion: 3, propertyId, reportFor: { name: 'Test Owner', address: '' }, owners: [], statementsFrom: '2026-09', statementsUntil: null, defaultFeeRateBasisPoints: null, defaultFee: null, setAt: '2026-10-03T15:00:00.000Z', ...over });
const MONTHS = ['2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01'];

// ═══ 1. The first statement month ═══
console.log('═══ 1. The first statement month ═══');
console.log(`  STATEMENTS_FROM_DEFAULT: ${model.STATEMENTS_FROM_DEFAULT} (${model.monthLabel(model.STATEMENTS_FROM_DEFAULT)})`);
const firsts = [
  ['no record', null, null, []],
  ['a record from 2026-09 (as the records written before the fresh start)', record(P(1)), null, []],
  ['a record from 2026-12', record(P(1), { statementsFrom: '2026-12' }), null, []],
  ['a record from 2026-09, the property added in January 2027', record(P(1)), '2027-01', []],
  ['added in January 2027, money in September, October and November', record(P(1)), '2027-01', ['2026-09', '2026-10', '2026-11']],
];
for (const [label, management, created, money] of firsts) console.log(`  ${label.padEnd(66)} → from ${model.statementMonths(management, created, money).from}`);
check(model.STATEMENTS_FROM_DEFAULT === '2026-11', 'statements begin with November 2026');
check(model.statementMonths(null).from === '2026-11' && model.statementMonths(record(P(1))).from === '2026-11', 'no record and a record from 2026-09 both start in November 2026: a record narrows, never widens');
check(model.statementMonths(record(P(1)), '2027-01', ['2026-09', '2026-10', '2026-11']).from === '2026-11', 'money in September or October never makes a month before November owed; November money is owed before the month added');

// ═══ 2. Months owed ═══
console.log('═══ 2. Months owed, August 2026 to January 2027 ═══');
const scopes = [
  ['no record', null, null, []],
  ['a record from 2026-09', record(P(1)), null, []],
  ['a record from 2026-09, money in September and October', record(P(1)), null, ['2026-09', '2026-10']],
  ['a record from 2026-12', record(P(1), { statementsFrom: '2026-12' }), null, []],
  ['added in December 2026', record(P(1)), '2026-12', []],
  ['excluded from reporting', record(P(1), { excludedFromReporting: true }), null, []],
];
console.log(`  ${''.padEnd(56)} ${MONTHS.join('  ')}`);
for (const [label, management, created, money] of scopes) console.log(`  ${label.padEnd(56)} ${MONTHS.map((m) => (model.inStatementScope(management, m, created, money) ? 'owed   ' : '—      ')).join('  ')}`);
check(scopes.every(([, management, created, money]) => !model.inStatementScope(management, '2026-09', created, money) && !model.inStatementScope(management, '2026-10', created, money)), 'no case owes September or October 2026');
check(model.inStatementScope(null, '2026-11') && model.inStatementScope(record(P(1)), '2026-11') && model.inStatementScope(record(P(1)), '2027-01'), 'no record, and a record from 2026-09, owe November 2026 on');

// ═══ 3. The one rule, day by day ═══
console.log('═══ 3. The one rule (the Statement column, the property page, the home panel, the tile), day by day ═══');
const status = (today, reports = [], management = record(P(1))) => st.reportingStatus({ propertyId: P(1), today, management, reports });
const show = (s) => `${s.tone} · ${s.standing} · ${s.month} · past due ${JSON.stringify(s.pastDue)} · previous ${s.previous.month} ${s.previous.standing}`;
const DAYS = ['2026-10-31', '2026-11-01', '2026-11-10', '2026-11-30', '2026-12-01', '2026-12-10', '2026-12-11', '2027-01-01', '2027-01-11'];
for (const day of DAYS) console.log(`  ${day} · a record from 2026-09, nothing finished → ${show(status(day))}`);
for (const day of ['2026-11-01', '2026-12-01']) console.log(`  ${day} · no record, nothing finished → ${show(status(day, [], null))}`);
const novFinished = [{ id: 'TESTREPORTfresh00001', propertyId: P(1), month: '2026-11', supersedes: null }];
console.log(`  2027-01-05 · November finished → ${show(status('2027-01-05', novFinished))}`);
check(['2026-10-31', '2026-11-01', '2026-11-10', '2026-11-30'].every((day) => status(day).pastDue.length === 0 && status(day).tone === 'none'), 'until November closes nothing is due or past due: September and October are not owed');
check(status('2026-12-01').standing === 'due' && status('2026-12-01').month === '2026-11', 'on 1 December, November is due');
check(status('2027-01-11').standing === 'pastDue' && JSON.stringify(status('2027-01-11').pastDue) === '["2026-11"]', 'in January, an unfinished November is past due, and nothing before it');
const statuses = st.reportingStatuses({ today: '2026-11-01', properties: [{ id: P(1) }, { id: P(2) }, { id: P(3) }], management: [record(P(1)), record(P(2))], reports: [] });
const counts = st.reportingCounts([...statuses.values()]);
console.log(`  the Statements tile on 2026-11-01, three properties (two records from 2026-09, one without): ${JSON.stringify(counts)}`);
check(counts.pastDue === 0 && counts.due === 0 && counts.owed === 0, 'the tile counts nothing due or past due on 1 November');
const decCounts = st.reportingCounts([...st.reportingStatuses({ today: '2026-12-01', properties: [{ id: P(1) }, { id: P(2) }, { id: P(3) }], management: [record(P(1)), record(P(2))], reports: [] }).values()]);
console.log(`  the Statements tile on 2026-12-01: ${JSON.stringify(decCounts)}`);
check(decCounts.due === 3 && decCounts.pastDue === 0, 'on 1 December every property owes November, none past due');

// ═══ 4. Empty months ═══
console.log('═══ 4. Empty months: what can be finished together ═══');
const emptyFor = (month, today) => emptyMonth({ month, today, properties: [{ id: P(1), name: 'Test Fresh One', createdMonth: '2026-09' }, { id: P(2), name: 'Test Fresh Two', createdMonth: '2026-09' }], management: [record(P(1))], reports: [], drafts: [], entries: [], income: { waiting: new Map(), checkInsWithout: new Set(), unsettled: [] } });
for (const [month, today] of [['2026-09', '2026-11-03'], ['2026-10', '2026-11-03'], ['2026-11', '2026-12-03']]) {
  const e = emptyFor(month, today);
  console.log(`  ${month} as of ${today}: eligible ${JSON.stringify(e.eligible.map((c) => c.propertyId))} · left out ${JSON.stringify(e.leftOut.map((l) => [l.propertyId, l.why ?? l.reason ?? null]))}`);
}
check(emptyFor('2026-10', '2026-11-03').eligible.length === 0 && emptyFor('2026-09', '2026-11-03').eligible.length === 0, 'September and October offer nothing to finish');
check(emptyFor('2026-11', '2026-12-03').eligible.length === 1 && emptyFor('2026-11', '2026-12-03').leftOut.length === 1, 'November is owed by both: one can be finished empty, the other is left out only for want of a Report For name');

// ═══ 5. The office cost's month ═══
console.log("═══ 5. The office cost's month ═══");
const office = (month) => ce.OfficeInputSchema.safeParse({ propertyId: P(1), description: 'Plumber', amount: '150.00', tax: null, month });
for (const month of ['2026-09', '2026-10', '2026-11']) {
  const r = office(month);
  console.log(`  ${month}: ${r.success ? 'accepted' : `refused · ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`}`);
}
check(!office('2026-10').success && office('2026-10').error.issues[0].message === 'Statements begin with November 2026' && office('2026-11').success, 'an office cost for October is refused, for November accepted');

// ═══ 6. The Income page ═══
console.log("═══ 6. The Income page: who owes no statement (I5) ═══");
const seed = globalThis.__memSeed;
seed('properties', P(1), { name: 'Test Fresh One' });
seed('properties', P(2), { name: 'Test Fresh Two' });
seed('properties', P(3), { name: 'Test Fresh Three' });
seed('properties', P(4), { name: 'Test Fresh Four' });
seed('property_management', P(2), record(P(2)));
seed('property_management', P(3), record(P(3), { statementsFrom: '2026-12' }));
seed('property_management', P(4), record(P(4), { excludedFromReporting: true }));
for (const month of ['2026-10', '2026-11', '2026-12']) {
  const read = await income.readIncomeMonth(month);
  console.log(`  ${month}:`);
  for (const row of read.noStatement) console.log(`    ${row.propertyId}: ${row.why}`);
  if (read.noStatement.length === 0) console.log('    (every property owes one)');
}
const oct = await income.readIncomeMonth('2026-10');
check(oct.noStatement.length === 4, 'in October, all four owe no statement: no record, a record from 2026-09, one from 2026-12, one excluded');
const nov = await income.readIncomeMonth('2026-11');
check(JSON.stringify(nov.noStatement.map((r) => r.propertyId).sort()) === JSON.stringify([P(3), P(4)]), 'in November, only the record from 2026-12 and the excluded property owe none');

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
