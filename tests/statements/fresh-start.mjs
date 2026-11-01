// The fresh start of 1 November 2026 (Kian's rulings of 2026-10-31): statements begin with November 2026, so no
// September or October statement is owed. The first statement month is STATEMENTS_FROM_DEFAULT
// (app/lib/reports/model.ts), read through the one rule (statementMonths, inStatementScope) by the property list's
// Statement column, the property page, the home panel, the Statements tile, Finish, empty months and the backup's
// check; a record's start month narrows it and never widens it, so the records written with 2026-09 owe from November
// like any other. The office cost's month starts there too, and the Income page's "owes no statement" (I5) reads the
// same first month. Kian's rule of 2026-11-01 (sections 7–12): for any month before it nothing is expected, owed,
// missing or overdue — the Income page and the Costs page's Month tab show such a month as one line, "Statements start
// in November 2026", and nothing else; a direct arrangement's expected amounts begin at the later of its start and the
// first statement month, which Direct overdue, Record direct payment and every count read; and both pages open on the
// last closed month, never before the first statement month. Made-up data only: properties "TESTPROP…"; the Income
// read runs the app's server code on the in-memory Firestore (tests/tools/memory-firestore.cjs). Nothing is read from
// or written to Firestore or Storage.
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
const periods = await import(`${ROOT}/app/lib/direct/periods.ts`);
const next = await import(`${ROOT}/app/lib/home/next-step.ts`);
const standing = await import(`${ROOT}/app/lib/income/standing.ts`);

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

// ═══ 7. A month before the first statement month: one line (Kian's rule of 2026-11-01, items 1 and 3) ═══
console.log('═══ 7. A month before the first statement month: one line, on the Income page and the Costs Month tab ═══');
for (const month of ['2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01']) console.log(`  ${month} → ${JSON.stringify(model.beforeStatementsLine(month))}`);
check(['2026-08', '2026-09', '2026-10'].every((m) => model.beforeStatementsLine(m) === 'Statements start in November 2026'), 'August, September and October 2026 each show the one line "Statements start in November 2026"');
check(['2026-11', '2026-12', '2027-01'].every((m) => model.beforeStatementsLine(m) === null), 'November 2026 on shows its month as before');

// ═══ 8. Direct arrangements: expected from the later of the start and the first statement month (item 2) ═══
console.log('═══ 8. Direct arrangements: expected from the later of the start and November 2026 ═══');
const arrangement = (id, over = {}) => ({ id, schemaVersion: 1, propertyId: P(5), propertyNameAtStart: 'Test Fresh Five', payerName: 'Test Payer', wording: 'Monthly stay', dueDay: 28, fromMonth: '2026-10', untilMonth: null, amounts: [{ from: over.fromMonth ?? '2026-10', cents: 280_000 }], pauses: [], createdAt: '2026-10-01T15:00:00.000Z', createdBy: { kind: 'admin', id: 'TESTADMINfresh000001', name: 'Test Admin' }, history: [], ...over });
const payment = (id, arrangementId, day, cents, appliesTo = null) => ({ id, schemaVersion: 1, propertyId: P(5), propertyNameAtRecord: 'Test Fresh Five', arrangementId, purpose: 'arrangement', payerName: 'Test Payer', stay: null, day, amountCents: cents, currency: 'CAD', method: 'etransfer', wording: 'Monthly stay', note: null, appliesTo, status: 'recorded', recordedAt: `${day}T16:00:00.000Z`, recordedBy: { kind: 'admin', id: 'TESTADMINfresh000001', name: 'Test Admin' }, history: [] });
const A = arrangement('TESTARRfresh00000001'); // the kept arrangement's shape: from October 2026, due the 28th, $2,800 a month
const cases = [
  ['from 2026-10, due the 28th (as the kept one)', A],
  ['from 2026-12', arrangement('TESTARRfresh00000002', { fromMonth: '2026-12' })],
  ['from 2026-09, ended 2026-10', arrangement('TESTARRfresh00000003', { fromMonth: '2026-09', untilMonth: '2026-10' })],
  ['from 2026-08, paused October to November', arrangement('TESTARRfresh00000004', { fromMonth: '2026-08', pauses: [{ from: '2026-10', until: '2026-11' }] })],
];
const periodText = (m) => (m.periods.length === 0 ? 'nothing expected' : m.periods.map((p) => `${p.month} ${p.state}`).join(', '));
for (const [label, a] of cases) {
  console.log(`  ${label}: expects from ${periods.firstExpectedMonth(a)} on, within its span and outside its pauses`);
  for (const day of ['2026-10-31', '2026-11-01', '2026-11-28', '2026-11-29', '2026-12-01']) {
    const m = periods.arrangementMonths(a, [], day);
    const s = periods.directStanding([a], [], day);
    console.log(`    ${day} · ${m.status} · ${periodText(m)} · standing ${s ? `${s.state} ${s.month}${s.dueDate ? ` due ${s.dueDate}` : ''}, ${s.overdueMonths} overdue` : 'none'}`);
  }
}
check(!periods.isExpectedMonth(A, '2026-10') && periods.isExpectedMonth(A, '2026-11'), 'an arrangement from October 2026 expects nothing for October, and expects November');
check(periods.arrangementMonths(A, [], '2026-10-31').periods.length === 0 && periods.directStanding([A], [], '2026-10-31') === null, 'on 31 October 2026 it expects nothing and has no standing: October is not overdue');
const nov1 = periods.directStanding([A], [], '2026-11-01');
check(nov1 !== null && nov1.state === 'expected' && nov1.month === '2026-11' && nov1.dueDate === '2026-11-28' && nov1.overdueMonths === 0, 'on 1 November 2026 it is Expected for November, due the 28th, nothing overdue');
check(periods.directStanding([A], [], '2026-11-28').state === 'expected' && periods.directStanding([A], [], '2026-11-29').state === 'overdue' && periods.directStanding([A], [], '2026-11-29').overdueMonths === 1, 'November is overdue from the 29th, one month only');
check(periods.arrangementMonths(cases[1][1], [], '2026-12-01').periods.map((p) => p.month).join() === '2026-12' && periods.directStanding([cases[1][1]], [], '2026-11-01').month === '2026-12', 'an arrangement from December 2026 expects December, as before');
check(['2026-11-01', '2026-12-01'].every((day) => periods.arrangementMonths(cases[2][1], [], day).periods.length === 0 && periods.directStanding([cases[2][1]], [], day) === null), 'an arrangement that ended in October 2026 never owed anything');
check(periods.arrangementMonths(cases[3][1], [], '2026-12-01').periods.map((p) => p.month).join() === '2026-12', 'an arrangement from August paused October to November expects December first');
// What a payment received before the first month pays: the oldest month expected, November (no payment is stored today).
const early = payment('TESTPAYfresh00000001', A.id, '2026-10-28', 280_000);
const paidBy = periods.arrangementMonths(A, [early], '2026-11-01');
console.log(`  a payment received 2026-10-28, no months set → pays ${JSON.stringify(paidBy.applied.get(early.id))} · November ${paidBy.periods[0].state}`);
check(paidBy.applied.get(early.id).parts.map((p) => p.month).join() === '2026-11', 'a payment received before November, its months not set, pays November, the oldest month expected');
// Finish's check reads the same months.
check(periods.unpaidInMonth([A], [], '2026-10', '2026-11-29').length === 0 && periods.unpaidInMonth([A], [], '2026-11', '2026-11-29').length === 1, "Finish's check lists nothing unpaid for October, and November's overdue payment");
// The home: the Income cell, the Direct overdue chip and the Next step read the standing.
const row = (day) => next.rowView({ propertyId: P(5), today: day, status: st.reportingStatus({ propertyId: P(5), today: day, management: record(P(5)), reports: [] }), hasReportFor: true, incomeMonth: model.lastClosedMonth(day), review: 0, direct: periods.directStanding([A], [], day), jobs: [], hasCalendarLink: true, calendarRead: true });
for (const day of ['2026-10-31', '2026-11-01', '2026-11-29']) {
  const d = periods.directStanding([A], [], day);
  const v = row(day);
  console.log(`  the home on ${day}: Income cell ${d ? JSON.stringify(standing.directIncomeStanding(d).label) : '(no direct standing)'} · under Direct overdue ${v.under.direct} · Next step ${JSON.stringify(v.step.label)}`);
}
check(!row('2026-10-31').under.direct && !row('2026-11-01').under.direct && row('2026-11-01').step.key !== 'direct', 'on 31 October and 1 November the row is not under Direct overdue and has no Record direct payment step');
check(standing.directIncomeStanding(nov1).label === 'Expected Nov 28', 'on 1 November its Income cell reads "Expected Nov 28"');
check(row('2026-11-29').under.direct && row('2026-11-29').step.key === 'direct', 'from 29 November, unpaid, the row is under Direct overdue with Record direct payment');

// ═══ 9. The month the Income page and the Costs Month tab open on (item 4) ═══
console.log('═══ 9. The month the Income page and the Costs Month tab open on ═══');
const opens = (day) => ({ income: model.openingMonth(model.lastClosedMonth(day), model.monthOfDay(day)), monthTab: model.openingMonth(model.addMonths(model.monthOfDay(day), -1), model.monthOfDay(day)) });
for (const day of ['2026-10-31', '2026-11-01', '2026-11-30', '2026-12-01', '2027-01-05']) console.log(`  ${day} → Income ${opens(day).income} · Month tab ${opens(day).monthTab}`);
check(['2026-11-01', '2026-11-30'].every((day) => opens(day).income === '2026-11' && opens(day).monthTab === '2026-11'), 'in November 2026 both open on November 2026, not October');
check(opens('2026-12-01').income === '2026-11' && opens('2027-01-05').income === '2026-12' && opens('2027-01-05').monthTab === '2026-12', 'from December on, both open on the month before today\'s, as before');
check(['2026-11-01', '2026-11-30', '2026-12-01', '2027-01-05'].every((day) => opens(day).income >= model.STATEMENTS_FROM_DEFAULT && opens(day).monthTab >= model.STATEMENTS_FROM_DEFAULT), 'from 1 November 2026 neither opens before the first statement month');

// ═══ 10. Calendar stays before November never count as gaps (item 1) ═══
console.log('═══ 10. The Income page\'s calendar gaps: stays before November never count ═══');
const monthView = (await import(`${ROOT}/app/lib/income/month.ts`)).monthView;
seed('properties', P(6), { name: 'Test Fresh Six' }); // no Airbnb title: a stay on its calendar makes it an untitled gap
seed('availability_days', '2026-11-01', { version: 1, refreshedAt: '2026-11-01T09:00:00.000Z', today: '2026-11-01', horizonEnd: '2027-11-01', run: { source: 'daily', startedAt: '2026-11-01T09:00:00.000Z', finishedAt: '2026-11-01T09:00:03.000Z', fetched: 1, failed: [] }, properties: { [P(6)]: { status: 'ok', events: [{ kind: 'reserved', start: '2026-10-28', end: '2026-11-03' }, { kind: 'reserved', start: '2026-11-05', end: '2026-11-08' }] } } });
console.log('  the calendar copy of 2026-11-01 holds two stays for an untitled property: 2026-10-28 → 2026-11-03 and 2026-11-05 → 2026-11-08');
const gapsOf = async (month) => {
  const read = await income.readIncomeMonth(month);
  const view = monthView({ ...read, month, today: '2026-11-20' });
  const stays = read.calendar.stays.find((s) => s.propertyId === P(6))?.count ?? 0;
  const checkIns = read.calendar.checkIns.find((c) => c.propertyId === P(6))?.days ?? [];
  console.log(`  ${month}: stays counted ${stays} · check-ins ${JSON.stringify(checkIns)} · untitled gap ${JSON.stringify(view.gaps.untitled.filter((u) => u.propertyId === P(6)).map((u) => u.stays))}`);
  return { stays, checkIns, untitled: view.gaps.untitled.filter((u) => u.propertyId === P(6)) };
};
const octGaps = await gapsOf('2026-10');
const novGaps = await gapsOf('2026-11');
check(octGaps.stays === 0 && octGaps.checkIns.length === 0 && octGaps.untitled.length === 0, 'October: the stay from 28 October counts nowhere, as a stay or a check-in');
check(novGaps.stays === 1 && JSON.stringify(novGaps.checkIns) === '["2026-11-05"]' && novGaps.untitled.length === 1 && novGaps.untitled[0].stays === 1, 'November: only the stay from 5 November counts; the one that began on 28 October does not');

// ═══ 11. The home's Income column: on and after 1 November it describes November (Kian's rule of 2026-11-01) ═══
console.log("═══ 11. The home's Income column: on and after 1 November it describes November, never October ═══");
const statusRead = await import(`${ROOT}/app/lib/firebase/server-property-status.ts`);
const { ADMIN_ACTOR } = await import(`${ROOT}/app/lib/cleaners/model.ts`);
seed('earnings_title_links', 'TESTLINKfresh0000007', { schemaVersion: 1, platform: 'airbnb', title: 'Test Fresh Seven', propertyId: P(7), active: true, linkedAt: '2026-10-14T15:00:00.000Z', actor: ADMIN_ACTOR, history: [] });
const columnAt = [
  ['31 Oct 2026, 12:00 EDT', '2026-10-31T16:00:00.000Z'],
  ['1 Nov 2026, 00:30 EDT', '2026-11-01T04:30:00.000Z'],
  ['1 Nov 2026, 11:00 EST', '2026-11-01T16:00:00.000Z'],
  ['30 Nov 2026, 23:30 EST', '2026-12-01T04:30:00.000Z'],
  ['1 Dec 2026, 09:00 EST', '2026-12-01T14:00:00.000Z'],
  ['5 Jan 2027, 09:00 EST', '2027-01-05T14:00:00.000Z'],
];
const columns = [];
for (const [label, iso] of columnAt) {
  const read = await statusRead.readPropertyStatus(new Date(iso));
  const titled = standing.incomeStanding(read.income, P(7));
  const untitled = standing.incomeStanding(read.income, P(8));
  columns.push({ iso, month: read.income.month, titled, untitled });
  console.log(`  ${label.padEnd(23)} → the column's month ${read.income.month} · a titled property "${titled.label}" (${titled.title}) · an untitled one "${untitled.label}", month ${untitled.month}`);
}
check(columns.slice(1).every((c) => c.month >= '2026-11'), 'from 00:30 on 1 November the column never describes a month before November');
check(columns[2].month === '2026-11' && columns[2].titled.label === 'No file yet' && columns[2].titled.title.startsWith('November 2026:'), 'on 1 November it describes November: "No file yet" is about November, not October');
check(columns[4].month === '2026-11' && columns[5].month === '2026-12', 'from December, the month before today\'s, as before');

// ═══ 12. A payment dated before November 2026 is refused, and nothing is written (Kian's rule of 2026-11-01) ═══
console.log('═══ 12. Recording a payment dated before November 2026 ═══');
const dmodel = await import(`${ROOT}/app/lib/direct/model.ts`);
const sdirect = await import(`${ROOT}/app/lib/firebase/server-direct.ts`);
const { getAdminDb } = await import(`${ROOT}/app/lib/firebase/admin.ts`);
for (const day of ['2026-10-28', '2026-10-31', '2026-11-01', '2026-11-20']) console.log(`  receivedDayProblem(${day}, today 2026-11-20) → ${JSON.stringify(dmodel.receivedDayProblem(day, '2026-11-20'))}`);
check(['2026-10-28', '2026-10-31'].every((day) => dmodel.receivedDayProblem(day, '2026-11-20') === 'Statements start in November 2026') && dmodel.receivedDayProblem('2026-11-01', '2026-11-20') === null, 'a day received before November 2026 is refused with "Statements start in November 2026"; 1 November is not');
check(dmodel.receivedDayProblem('2027-11-16', '2027-11-15') !== null && dmodel.receivedDayProblem('2026-11-14', '2027-11-15') !== null && dmodel.receivedDayProblem('2026-11-15', '2027-11-15') === null, 'the 12-month limit holds as before once a year has passed since November 2026');
seed('properties', P(9), { name: 'Test Fresh Nine' });
const readsBefore = globalThis.__memReads.length;
const refused = await sdirect.recordDirectPayment(ADMIN_ACTOR, { propertyId: P(9), arrangementId: null, purpose: 'not-a-stay', payerName: null, stay: null, day: '2026-10-28', cents: 7_500, method: 'cash', wording: 'Parking', note: null, appliesTo: null }, new Date('2026-11-20T16:00:00.000Z'));
const readsByIt = globalThis.__memReads.length - readsBefore;
const paymentsAfter = (await getAdminDb().collection('direct_payments').get()).size;
console.log(`  recordDirectPayment(a parking payment received 2026-10-28, on 2026-11-20) → ${JSON.stringify(refused)} · reads it made ${readsByIt} · direct payments stored after ${paymentsAfter}`);
check(refused.kind === 'refused' && refused.problem === 'Statements start in November 2026' && readsByIt === 0 && paymentsAfter === 0, 'refused before any read, and nothing is written');

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
