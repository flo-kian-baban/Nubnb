// Dispatch 36's checks: Nubnb's own pure code on made-up data (IDs "TEST…"). Nothing is read from or written to
// production. NUBNB_ROOT picks another copy of the code; by default, this repository.
//   node --import ./tests/tools/ts-hook.mjs tests/money/office-month.mjs
// 1. C3, the office-cost month: buildStatement, statementMonthFor, printedLines, moneyMonthsByProperty, the month
//    ZIP's selection (selectMonthPackage).
// 2. The title mark: monthView and unlinkedTitles with a title set aside.
// 3. The empty-month list: emptyMonth, as of 1 January 2027, for December and November.
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.NUBNB_ROOT || fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const model = await import(`${ROOT}/app/lib/reports/model.ts`);
const st = await import(`${ROOT}/app/lib/reports/statement.ts`);
const { statementPdf } = await import(`${ROOT}/app/lib/reports/statement-pdf.ts`);
const { entryViewOf, selectMonthPackage } = await import(`${ROOT}/app/lib/backup/data.ts`);
const { formatCents, ADMIN_ACTOR } = await import(`${ROOT}/app/lib/cleaners/model.ts`);
const { entryMonth, ledgerDay, officeWhen, buildReport } = await import(`${ROOT}/app/lib/costs/report.ts`);
const { pdfFor } = await import(`${ROOT}/app/lib/costs/pdf.ts`);
const { workbookFor } = await import(`${ROOT}/app/lib/costs/xlsx.ts`);
const { monthView } = await import(`${ROOT}/app/lib/income/month.ts`);
const income = await import(`${ROOT}/app/lib/income/model.ts`);
const { emptyMonth } = await import(`${ROOT}/app/lib/reports/empty.ts`);
const $ = formatCents;
let seq = 0;

// ─── Documents ───
function officeDoc(propertyId, createdAt, cents, description, month) {
  const submitted = { at: createdAt, action: 'submitted', from: null, to: 'pending', actor: ADMIN_ACTOR, reason: null };
  const approved = { at: createdAt, action: 'approved', from: 'pending', to: 'approved', actor: ADMIN_ACTOR, reason: 'Added by the office' };
  return {
    schemaVersion: 2, kind: 'office', cleanerId: null, cleanerNameAtEntry: null, propertyId, propertyNameAtEntry: 'Test property', createdAt, purchasedOn: null, note: null, currency: 'CAD',
    lines: [{ name: description, quantity: 1, lineTotalCents: cents }], taxCents: null, receipts: [], status: 'approved', statusChangedAt: createdAt, statusReason: null,
    history: [submitted, approved], autoApproved: null, ...(month === undefined ? {} : { month }),
  };
}
function cleanerDoc(propertyId, createdAt, cents, status = 'approved') {
  const history = [{ at: createdAt, action: 'submitted', from: null, to: 'pending', actor: { role: 'cleaner', id: 'TESTCLEANER000000001', name: 'Test cleaner' }, reason: null }];
  if (status === 'approved') history.push({ at: createdAt, action: 'approved', from: 'pending', to: 'approved', actor: ADMIN_ACTOR, reason: null });
  return {
    schemaVersion: 2, createdAt, status, statusChangedAt: createdAt, statusReason: null, cleanerId: 'TESTCLEANER000000001', cleanerNameAtEntry: 'Test cleaner', propertyId, propertyNameAtEntry: 'Test property',
    purchasedOn: createdAt.slice(0, 10), note: null, currency: 'CAD', kind: 'receipt', autoApproved: null, lines: [{ name: 'Supplies', quantity: 1, lineTotalCents: cents }], receipts: [], history,
  };
}
const record = (propertyId, name, extra = {}) => ({ id: `TESTMGMT${propertyId.slice(-6)}`, schemaVersion: 1, propertyId, reportFor: name === null ? null : { name, address: '' }, owners: [], statementsFrom: '2026-11', statementsUntil: null, defaultFeeRateBasisPoints: null, defaultFee: null, setAt: '2026-12-01T00:00:00.000Z', ...extra });
const draftOf = (month, reference, extra = {}) => ({ reference, reportDate: model.monthRange(model.addMonths(month, 1)).from, lines: [], fee: null, carried: null, notes: null, supersedes: null, ...extra });
const line = (description, cents) => ({ id: `L${++seq}`, description, from: null, to: null, quantity: 1, rateCents: cents, amountCents: cents });

function freeze(propertyId, entries, reports, draft, month, finishedAt, management = null) {
  const built = st.buildStatement({ propertyId, propertyName: 'Test property', month, entries, reports, draft, management });
  if (built.kind !== 'ok') throw new Error('unreadable ' + built.entryIds);
  const s = { ...built.statement, draft: false };
  const bytes = statementPdf(s);
  const id = `TESTREPORT${String(++seq).padStart(10, '0')}`;
  return {
    id, legacy: false, income: [], ownersAtFinish: [], schemaVersion: model.MONTHLY_REPORT_SCHEMA_VERSION, propertyId, propertyNameAtFinish: 'Test property', month,
    reference: s.reference, reportDate: s.reportDate, reportFor: s.reportFor, lines: s.lines, costs: s.costs, adjustments: s.adjustments, fee: s.fee, carried: s.carried,
    incomeCents: s.incomeCents, expensesCents: s.expensesCents, recordedCents: s.recordedCents, costsCents: s.costsCents, feeCents: s.feeCents, totalCents: s.totalCents, carriedCents: s.carriedCents,
    payableCents: s.payableCents, pendingLeftOut: s.pendingLeftOut, notes: s.notes, entryIds: s.costs.map((row) => row.entryId), finishedAt, actor: ADMIN_ACTOR, supersedes: null, draftRevision: 1,
    pdf: { path: `monthly-reports/${id}.pdf`, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
  };
}
const rowsOf = (statement) => st.printedLines(statement).map((l) => `      ${l.description}  ${$(l.amountCents)}`).join('\n') || '      (no rows)';
const build = (propertyId, entries, reports, month, management = null) => st.buildStatement({ propertyId, propertyName: 'Test property', month, entries, reports, draft: draftOf(month, 'TEST'), management });

// ═══ 1. C3 ═══
console.log('═══ 1. C3 · an office cost logged on 12 December for November ($85.00), beside a cleaner cost sent 12 December ($20.00) ═══');
const P = 'TESTPROPc3aaaaaaaaa1';
const O = 'TESTENTRYoffice0sep1';
const K = 'TESTENTRYcleaner0oct';
const oDoc = officeDoc(P, '2026-12-12T15:00:00.000Z', 8500, 'Plumber, November call-out', '2026-11');
const kDoc = cleanerDoc(P, '2026-12-12T15:30:00.000Z', 2000);
const entries = [entryViewOf(O, oDoc), entryViewOf(K, kDoc)];
console.log(`  entryMonth: office ${entryMonth(entries[0])} · cleaner (no month field) ${entryMonth(entries[1])} · the office view's month field: ${JSON.stringify(entries[0].month)}`);
console.log(`  moneyMonthsByProperty: ${JSON.stringify([...st.moneyMonthsByProperty([], entries)])}`);

console.log('\n  a) Nothing finished.');
console.log(`     statementMonthFor(2026-11, {}) = ${st.statementMonthFor('2026-11', new Set())}`);
let nov = build(P, entries, [], '2026-11');
let dec = build(P, entries, [], '2026-12');
console.log(`    November preview:\n${rowsOf(nov.statement)}\n    December preview:\n${rowsOf(dec.statement)}`);

console.log('\n  b) November finished on 5 December, before the cost was logged; then December.');
const novReport = freeze(P, [], [], draftOf('2026-11', 'Nov-TEST'), '2026-11', '2026-12-05T14:00:00.000Z');
console.log(`     statementMonthFor(2026-11, {2026-11}) = ${st.statementMonthFor('2026-11', new Set(['2026-11']))}`);
dec = build(P, entries, [novReport], '2026-12');
console.log(`    December preview:\n${rowsOf(dec.statement)}`);
console.log(`    December's cost rows as stored: ${JSON.stringify(dec.statement.costs.map((c) => ({ entryId: c.entryId, group: c.group, day: c.day, month: c.month, totalCents: c.totalCents, description: c.description })))}`);

console.log('\n  c) November and December finished, December without it (finished first, say); then January.');
const decReport = freeze(P, [entries[1]], [novReport], draftOf('2026-12', 'Dec-TEST'), '2026-12', '2027-01-02T14:00:00.000Z');
console.log(`     statementMonthFor(2026-11, {2026-11, 2026-12}) = ${st.statementMonthFor('2026-11', new Set(['2026-11', '2026-12']))}`);
const jan = build(P, entries, [novReport, decReport], '2027-01');
console.log(`    December as finished:\n${rowsOf(decReport)}\n    January preview:\n${rowsOf(jan.statement)}`);

console.log('\n  d) The same cost logged for December (month 2026-12) with November finished: December, as its own month.');
const o2 = [entryViewOf(O, officeDoc(P, '2026-12-12T15:00:00.000Z', 8500, 'Plumber, November call-out', '2026-12')), entries[1]];
console.log(`    December preview:\n${rowsOf(build(P, o2, [novReport], '2026-12').statement)}`);

console.log('\n  e) An office cost written before dispatch 36 (no month field), sent 12 December: December, by the day sent.');
const o3 = [entryViewOf(O, officeDoc(P, '2026-12-12T15:00:00.000Z', 8500, 'Plumber, November call-out', undefined))];
console.log(`    entryMonth = ${entryMonth(o3[0])}; November preview:\n${rowsOf(build(P, o3, [], '2026-11').statement)}\n    December preview:\n${rowsOf(build(P, o3, [], '2026-12').statement)}`);

console.log('\n  f) The month ZIP (selectMonthPackage) on 12 December: which month\'s folder lists the November office cost.');
for (const month of ['2026-11', '2026-12']) {
  const sel = selectMonthPackage({
    month, today: '2026-12-12', madeAt: '2026-12-12T16:00:00.000Z', properties: [{ id: P, name: 'Test property', createdMonth: '2026-11' }],
    entries: [{ id: O, stored: oDoc }, { id: K, stored: kDoc }], reports: [], drafts: [], downloads: [], management: [],
  });
  const folders = sel.data.folders.map((f) => ({ property: f.propertyId ?? f.id ?? '?', entries: Object.keys(f).filter((k) => /entr|cost/i.test(k)).map((k) => [k, JSON.stringify(f[k]).slice(0, 160)]) }));
  console.log(`    ${month}: entries named ${JSON.stringify(Object.keys(sel.data.entries))} · folders ${JSON.stringify(folders)}`);
}

console.log('\n  g) The ledger (Kian\'s ruling of 2026-10-12: exports place costs by the statements\' month rule).');
console.log(`    ledgerDay: office for November, logged 12 Dec → ${ledgerDay(entries[0])} · cleaner sent 12 Dec → ${ledgerDay(entries[1])} · office for December → ${ledgerDay(o2[0])}`);
console.log(`    officeWhen: ${JSON.stringify(officeWhen(entries[0]))} · for December: ${JSON.stringify(officeWhen(o2[0]))} · a cleaner entry: ${JSON.stringify(officeWhen(entries[1]))} · logged 5 Jan 2027 for Dec 2026: ${JSON.stringify(officeWhen({ kind: 'office', createdAt: '2027-01-05T15:00:00.000Z', month: '2026-12' }))}`);
for (const [from, to] of [['2026-11-01', '2026-11-30'], ['2026-12-01', '2026-12-31'], ['2026-11-15', '2026-12-15'], ['', '']]) {
  const r = buildReport(entries, P, from, to, new Date('2026-12-12T16:00:00Z'), 'Test property');
  console.log(`    ${from || '(open)'} – ${to || '(open)'}: ${r.report.from} – ${r.report.to} · ${r.report.entries.map((e) => `${e.id} placed ${e.placed} dated ${e.office ? `${e.office.month} ${e.office.logged}` : e.day} ${$(e.totalCents)}`).join(' | ') || '(none)'} · total ${$(r.report.totalCents)}`);
}
const novLedger = buildReport(entries, P, '2026-11-01', '2026-11-30', new Date('2026-12-12T16:00:00Z'), 'Test property').report;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
console.log(`    ledger-november.pdf ${sha(pdfFor(novLedger))} · ledger-november.xlsx ${sha(workbookFor(novLedger))}`);

// ═══ 2. The title mark ═══
console.log('\n═══ 2. The title mark · an December file with three titles: one linked, one set aside, one neither ═══');
const LINKED = 'TESTPROPlinkedaaaaa1';
const lineOf = (title, status, cents, extra = {}) => ({ id: `TESTLINE${++seq}`, uploadId: 'TESTUPLOAD', platform: 'airbnb', listingTitle: title, month: '2026-12', status, amountCents: cents, decided: null, fileRow: seq, ...extra });
const lines = [
  lineOf('__TEST__ Linked Loft', 'proposed', 50000),
  lineOf('__TEST__ Gone Cottage', 'rejected', 73573),
  lineOf('__TEST__ Gone Cottage', 'rejected', 1000),
  lineOf('__TEST__ Unknown Flat', 'proposed', 20000),
];
const linkOf = (title, propertyId, notNubnb) => ({ id: `TESTLINK${++seq}`, schemaVersion: 1, platform: 'airbnb', title, propertyId, ...(notNubnb ? { notNubnb: true } : {}), linkedAt: '2027-01-01T12:00:00.000Z', actor: ADMIN_ACTOR, history: [] });
const links = [linkOf('__TEST__ Linked Loft', LINKED, false), linkOf('__TEST__ Gone Cottage', null, true), linkOf('__TEST__ Old Name', LINKED, false), linkOf('__TEST__ Set Aside Elsewhere', null, true)];
const uploads = [{ platform: 'airbnb', month: '2026-12', titles: [{ title: '__TEST__ Linked Loft', rows: 1, amountCents: 50000 }, { title: '__TEST__ Gone Cottage', rows: 2, amountCents: 74573 }, { title: '__TEST__ Unknown Flat', rows: 1, amountCents: 20000 }] }];
const view = monthView({ uploads, lines, links, lastSeen: {}, properties: [{ id: LINKED, name: '__TEST__ Linked Loft' }], statements: [], calendar: { checkIns: [] } });
console.log(`  titles: ${JSON.stringify(view.titles.map((t) => ({ title: t.title, rows: t.rows, amount: $(t.amountCents), link: income.linkState(t.link), setAside: income.isSetAside(t.link) })))}`);
console.log(`  to review: ${JSON.stringify(view.review.map((g) => ({ property: g.propertyId, lines: g.lines.length, amount: $(g.amountCents) })))}`);
console.log(`  rejected: ${view.rejected.length} (${view.rejected.map((l) => l.listingTitle).join(', ')})`);
console.log(`  gaps.unlinked: ${JSON.stringify(view.gaps.unlinked.map((t) => t.title))}`);
console.log(`  gaps.missing: ${JSON.stringify(view.gaps.missing.map((m) => m.link.title))}  (the set-aside title absent from the file is not "missing")`);
let unlinkedTitles = null;
try {
  ({ unlinkedTitles } = await import(`${ROOT}/app/lib/firebase/server-income.ts`));
} catch (err) {
  console.log(`  unlinkedTitles: server-income.ts did not load here (${err.message.split('\n')[0]})`);
}
if (unlinkedTitles) console.log(`  unlinkedTitles (what the bulk finish refuses on): ${JSON.stringify(unlinkedTitles(uploads, links))}`);

// ═══ 3. The empty-month list ═══
console.log('\n═══ 3. emptyMonth · as of 1 January 2027, December (Due) and November (Past due) ═══');
const id = (n) => `TESTPROPempty${String(n).padStart(7, '0')}`;
const props = [];
const management = [];
const reports = [];
const drafts = [];
const allEntries = [];
const add = (n, name, created, reportFor, extra = {}) => {
  props.push({ id: id(n), name, createdMonth: created });
  management.push(record(id(n), reportFor, extra));
};
// A: a November statement whose reference has a month word: December's is suggested from it.
add(1, 'A · empty, last statement Nov-321-Ann', '2026-11', 'Ann');
reports.push(freeze(id(1), [], [], draftOf('2026-11', 'Nov-321-Ann'), '2026-11', '2026-12-05T14:00:00.000Z', management[0]));
// B: added in December, never a statement: nothing to suggest from.
add(2, 'B · added in December, no statement yet', '2026-12', 'Bea');
// C: no Report For name.
add(3, 'C · no Report For', '2026-12', null);
// D: calendar check-ins the file does not hold.
add(4, 'D · calendar stays not in the file', '2026-12', 'Dan');
// E: a draft with a line.
add(5, 'E · draft with a line', '2026-12', 'Eve');
drafts.push({ id: `${id(5)}_2026-10`, schemaVersion: 3, propertyId: id(5), month: '2026-12', ...draftOf('2026-12', 'Dec-E', { lines: [line('Revenue', 10000)] }), revision: 2, createdAt: '2026-12-20T00:00:00.000Z', updatedAt: '2026-12-20T00:00:00.000Z', finishedAs: null, finishedRevision: null });
// F: two Airbnb lines waiting.
add(6, 'F · Airbnb lines waiting', '2026-12', 'Fay');
// G: an office cost for December.
add(7, 'G · an office cost for December', '2026-12', 'Gus');
allEntries.push(entryViewOf('TESTENTRYemptyG00001', officeDoc(id(7), '2026-12-20T15:00:00.000Z', 4000, 'Lock change', '2026-12')));
// H: excluded from reporting.
add(8, 'H · excluded', '2026-12', 'Hal', { excludedFromReporting: true });
// I: December already finished.
add(9, 'I · December finished', '2026-11', 'Ida');
reports.push(freeze(id(9), [], [], draftOf('2026-12', 'Dec-I'), '2026-12', '2026-12-31T14:00:00.000Z', management[8]));
// J: added in January: owes no December.
add(10, 'J · added in January', '2027-01', 'Jo');
// K: November closed owing NuBNB, not carried.
add(11, 'K · November closed owing NuBNB', '2026-11', 'Kim');
reports.push(freeze(id(11), [], [], draftOf('2026-11', 'Nov-K', { lines: [line('Expense - Repairs', -30000)] }), '2026-11', '2026-12-05T14:00:00.000Z', management[10]));
// L: a cleaner's entry sent in December, still pending.
add(12, 'L · a pending entry', '2026-12', 'Lou');
allEntries.push(entryViewOf('TESTENTRYemptyL00001', cleanerDoc(id(12), '2026-12-20T15:00:00.000Z', 1500, 'pending')));
// M: an empty draft with a reference typed: that reference, not a suggestion.
add(13, 'M · empty draft, reference typed', '2026-12', 'Mo');
drafts.push({ id: `${id(13)}_2026-10`, schemaVersion: 3, propertyId: id(13), month: '2026-12', ...draftOf('2026-12', 'Dec-M-typed'), revision: 1, createdAt: '2026-12-20T00:00:00.000Z', updatedAt: '2026-12-20T00:00:00.000Z', finishedAs: null, finishedRevision: null });
// N: an office cost logged in December for November, November finished: it goes on December's statement, so December is not empty.
add(14, 'N · a November cost on December (November finished)', '2026-11', 'Ned');
reports.push(freeze(id(14), [], [], draftOf('2026-11', 'Nov-N'), '2026-11', '2026-12-05T14:00:00.000Z', management[13]));
allEntries.push(entryViewOf('TESTENTRYemptyN00001', officeDoc(id(14), '2026-12-12T15:00:00.000Z', 8500, 'Plumber', '2026-11')));

const unsettled = [{ title: '__TEST__ Unknown Flat', rows: 1, amountCents: 20000 }];
for (const month of ['2026-12', '2026-11']) {
  const out = emptyMonth({ month, today: '2027-01-01', properties: props, management, reports, drafts, entries: allEntries, income: { waiting: new Map(month === '2026-12' ? [[id(6), 2]] : []), checkInsWithout: new Set(month === '2026-12' ? [id(4)] : []), unsettled } });
  console.log(`\n  ${model.monthLabel(month)}:`);
  console.log(`    eligible (${out.eligible.length}):`);
  for (const c of out.eligible) console.log(`      ${c.name} · ${c.standing} · reference ${JSON.stringify(c.reference)}`);
  console.log(`    left out (${out.leftOut.length}):`);
  for (const c of out.leftOut) console.log(`      ${c.name} · ${c.why}`);
  console.log(`    unsettled: ${JSON.stringify(out.unsettled)}`);
}
