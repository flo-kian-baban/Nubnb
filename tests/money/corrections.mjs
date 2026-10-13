// Dispatch 35's acceptance scenarios (the dispatch 31 audit's) and its in-order chains, on Nubnb's own pure code
// (buildStatement, statementOf, printedLines, statementPdf, uncarriedDebts, laterReferences). Made-up data only:
// property "TESTPROP…", entries "TESTENTRY…". Nothing is read from or written to production.
//   node --import ./tests/tools/ts-hook.mjs tests/money/corrections.mjs acceptance   the scenarios, as text
//   node --import ./tests/tools/ts-hook.mjs tests/money/corrections.mjs chains       each chained statement's PDF SHA-256
// NUBNB_ROOT picks another copy of the code (to compare two versions); by default, this repository.
// `freeze` mirrors finishStatement's freeze() in server-reports.ts (that file needs the Admin SDK to load): the
// report it creates, its figures the built statement's own, carried adjustments written only when there are any.
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.NUBNB_ROOT || fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const model = await import(`${ROOT}/app/lib/reports/model.ts`);
const st = await import(`${ROOT}/app/lib/reports/statement.ts`);
const { statementPdf } = await import(`${ROOT}/app/lib/reports/statement-pdf.ts`);
const { entryViewOf } = await import(`${ROOT}/app/lib/backup/data.ts`);
const { formatCents, ADMIN_ACTOR } = await import(`${ROOT}/app/lib/cleaners/model.ts`);
const $ = formatCents;

const P = 'TESTPROPaaaaaaaaaaa1';
let seq = 0;
const iso = (s) => new Date(s).toISOString();
function entryDoc(id, createdAt, cents) {
  return {
    schemaVersion: 2, createdAt, status: 'approved', statusChangedAt: createdAt, statusReason: null, cleanerId: 'TESTCLEANER000000001', cleanerNameAtEntry: 'Test cleaner',
    propertyId: P, propertyNameAtEntry: 'Test property', purchasedOn: createdAt.slice(0, 10), note: null, currency: 'CAD', kind: 'receipt', autoApproved: null,
    lines: [{ name: 'Supplies', quantity: 1, lineTotalCents: cents }], receipts: [],
    history: [
      { at: createdAt, action: 'submitted', from: null, to: 'pending', actor: { role: 'cleaner', id: 'TESTCLEANER000000001', name: 'Test cleaner' }, reason: null },
      { at: createdAt, action: 'approved', from: 'pending', to: 'approved', actor: ADMIN_ACTOR, reason: null },
    ],
  };
}
const corrected = (doc, at, before, after) => ({ ...doc, history: [...doc.history, { at, action: 'line_corrected', from: null, to: null, actor: ADMIN_ACTOR, reason: 'wrong amount', line: { index: 0, before: { name: 'Supplies', quantity: 1, lineTotalCents: before }, after: { name: 'Supplies', quantity: 1, lineTotalCents: after } } }] });
const removed = (doc, at) => ({ ...doc, status: 'removed', history: [...doc.history, { at, action: 'removed', from: 'approved', to: 'removed', actor: ADMIN_ACTOR, reason: 'duplicate' }] });
const view = (id, doc) => entryViewOf(id, doc);
const line = (description, cents) => ({ id: `L${++seq}`, description, from: null, to: null, quantity: 1, rateCents: cents, amountCents: cents });
const draftOf = (month, lines = [], extra = {}) => ({ reference: `${model.monthReferenceWord(month)}-TEST`, reportDate: model.monthRange(model.addMonths(month, 1)).from, lines, fee: null, carried: null, notes: null, supersedes: null, ...extra });

function freeze(entries, reports, draft, month, finishedAt) {
  const built = st.buildStatement({ propertyId: P, propertyName: 'Test property', month, entries, reports, draft, management: null });
  if (built.kind !== 'ok') throw new Error('unreadable ' + built.entryIds);
  const statement = { ...built.statement, draft: false };
  const bytes = statementPdf(statement);
  const id = `TESTREPORT${String(++seq).padStart(10, '0')}`;
  const report = {
    id, legacy: false, income: [], ownersAtFinish: [], schemaVersion: model.MONTHLY_REPORT_SCHEMA_VERSION, propertyId: P, propertyNameAtFinish: 'Test property', month,
    reference: statement.reference, reportDate: statement.reportDate, reportFor: statement.reportFor, lines: statement.lines, costs: statement.costs, adjustments: statement.adjustments,
    fee: statement.fee, carried: statement.carried, ...(statement.carriedAdjustments && statement.carriedAdjustments.length > 0 ? { carriedAdjustments: statement.carriedAdjustments } : {}),
    incomeCents: statement.incomeCents, expensesCents: statement.expensesCents, recordedCents: statement.recordedCents, costsCents: statement.costsCents, feeCents: statement.feeCents,
    totalCents: statement.totalCents, carriedCents: statement.carriedCents, payableCents: statement.payableCents, pendingLeftOut: statement.pendingLeftOut, notes: statement.notes,
    entryIds: statement.costs.map((row) => row.entryId), finishedAt, actor: ADMIN_ACTOR, supersedes: draft.supersedes ?? null, draftRevision: 1,
    pdf: { path: `monthly-reports/${id}.pdf`, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
  };
  return { report, bytes, built };
}
const reopen = (report) => ({ reference: report.reference, reportDate: report.reportDate, lines: report.lines, fee: report.fee, carried: report.carried, notes: report.notes, supersedes: report.supersedes });
const rows = (report) => st.printedLines(report).map((l) => `      ${l.description}  ${$(l.amountCents)}`).join('\n');
const show = (label, report) => console.log(`  ${label}: ${report.month} …${report.id.slice(-4)} · revenue share ${$(report.payableCents)}${report.carried ? ` · carried ${$(report.carried.amountCents)}` : ''}\n${rows(report) || '      (no rows)'}`);
const chargedFor = (reports, entryId) => model.currentReports(reports).reduce((sum, r) => sum + r.costs.filter((c) => c.entryId === entryId).reduce((a, c) => a + c.totalCents, 0) + r.adjustments.filter((a) => a.entryId === entryId).reduce((a, b) => a + b.deltaCents, 0), 0);
const build = (entries, reports, draft, month) => st.buildStatement({ propertyId: P, propertyName: 'Test property', month, entries, reports, draft, management: null });

const mode = process.argv[2];

if (mode === 'chains') {
  // Statements nobody changed: in-order chains, built and finished one after another with the code at NUBNB_ROOT.
  // Each statement's PDF bytes are hashed; the same chain under two codes must hash the same.
  const out = {};
  const X = 'TESTENTRYchainxxxxx1';
  const Z = 'TESTENTRYchainzzzzz2';
  let x = entryDoc(X, iso('2026-09-15T15:00:00Z'), 10000);
  const z = entryDoc(Z, iso('2026-08-28T15:00:00Z'), 4200);
  const sep = freeze([view(X, x), view(Z, z)], [], draftOf('2026-09', [line('Revenue', 200000), line('Expense - Repairs', -260000)]), '2026-09', '2026-10-05T14:00:00.000Z');
  out['September: a cost, an August cost from earlier, closing below zero'] = sep.report.pdf.sha256;
  x = corrected(x, '2026-10-20T14:00:00.000Z', 10000, 15000);
  const carry = st.carriedSuggestion(st.previousStatement([sep.report], '2026-10'));
  const oct = freeze([view(X, x), view(Z, z)], [sep.report], draftOf('2026-10', [line('Revenue', 100000)], { carried: carry }), '2026-10', '2026-11-04T14:00:00.000Z');
  out['October: the correction as an adjustment, September\'s balance carried'] = oct.report.pdf.sha256;
  x = corrected(x, '2026-11-20T14:00:00.000Z', 15000, 17000);
  const nov = freeze([view(X, x), view(Z, z)], [sep.report, oct.report], draftOf('2026-11', [line('Revenue', 50000)]), '2026-11', '2026-12-03T14:00:00.000Z');
  out['November: a second adjustment, measured from October'] = nov.report.pdf.sha256;
  const corr = freeze([view(X, x), view(Z, z)], [sep.report, oct.report, nov.report], { ...reopen(nov.report), supersedes: { reportId: nov.report.id, reason: 'The revenue was typed wrong.' } }, '2026-11', '2026-12-04T14:00:00.000Z');
  out['November corrected, nothing before it redone'] = corr.report.pdf.sha256;
  out['December preview: nothing to carry'] = createHash('sha256').update(statementPdf(build([view(X, x), view(Z, z)], [sep.report, oct.report, nov.report, corr.report], draftOf('2026-12'), '2026-12').statement)).digest('hex');
  console.log(JSON.stringify(out, null, 1));
  process.exit(0);
}

// ═══ 1. $100 corrected to $150 after its statement; October adjusted; September redone ═══
console.log('═══ 1. A $100.00 cost (sent 15 Sep) printed in September; corrected to $150.00; October prints the +$50.00; September redone ═══');
const X = 'TESTENTRYxxxxxxxxxx1';
const x0 = entryDoc(X, iso('2026-09-15T15:00:00Z'), 10000);
const sep = freeze([view(X, x0)], [], draftOf('2026-09', [line('Revenue', 200000)]), '2026-09', '2026-10-05T14:00:00.000Z');
show('September finished', sep.report);
const x1 = corrected(x0, '2026-10-20T14:00:00.000Z', 10000, 15000);
const oct = freeze([view(X, x1)], [sep.report], draftOf('2026-10', [line('Revenue', 100000)]), '2026-10', '2026-11-04T14:00:00.000Z');
show('October finished', oct.report);
console.log(`  laterReferences(September): ${JSON.stringify(st.laterReferences(sep.report, [sep.report, oct.report]).map((r) => [r.report.month, r.adjusted ? 'adjusted' : '', r.carried ? 'carried' : ''].filter(Boolean)))}`);
// (a) deleted and finished again: deleteFinishedStatement reopens the draft holding what the statement held.
const sep2 = freeze([view(X, x1)], [oct.report], reopen(sep.report), '2026-09', '2026-11-10T14:00:00.000Z');
show('(a) September deleted, then finished again', sep2.report);
console.log(`  CHARGED FOR THE COST across the current statements: ${$(chargedFor([oct.report, sep2.report], X))} (the cost is ${$(15000)})`);
const nov = build([view(X, x1)], [oct.report, sep2.report], draftOf('2026-11'), '2026-11');
console.log(`  November: ${nov.statement.adjustments.length} adjustment(s) for it`);
// (b) corrected: a replacing September statement.
const sepC = freeze([view(X, x1)], [sep.report, oct.report], { ...reopen(sep.report), supersedes: { reportId: sep.report.id, reason: 'test correction' } }, '2026-09', '2026-11-10T14:00:00.000Z');
show('(b) September corrected instead', sepC.report);
console.log(`  CHARGED FOR THE COST across the current statements: ${$(chargedFor([sep.report, oct.report, sepC.report], X))}`);
console.log(`  November: ${build([view(X, x1)], [sep.report, oct.report, sepC.report], draftOf('2026-11'), '2026-11').statement.adjustments.length} adjustment(s) for it`);
// (c) changed again after October, then September redone: the redo prints what is left after October's adjustment; November shows the later change.
const x2 = corrected(x1, '2026-11-08T14:00:00.000Z', 15000, 17000);
const sep3 = freeze([view(X, x2)], [oct.report], reopen(sep.report), '2026-09', '2026-11-10T14:00:00.000Z');
show('(c) corrected again to $170.00 after October, then September finished again', sep3.report);
const nov3 = build([view(X, x2)], [oct.report, sep3.report], draftOf('2026-11'), '2026-11');
console.log(`  November:\n${rows(nov3.statement)}`);
console.log(`  CHARGED once November is finished: ${$(chargedFor([oct.report, sep3.report, freeze([view(X, x2)], [oct.report, sep3.report], draftOf('2026-11'), '2026-11', '2026-12-03T14:00:00.000Z').report], X))} (the cost is ${$(17000)})`);

// ═══ 2. The removal case ═══
console.log('\n═══ 2. A $100.00 cost printed in September, removed afterwards; October gives it back; September redone ═══');
const Y = 'TESTENTRYyyyyyyyyyy2';
const y0 = entryDoc(Y, iso('2026-09-16T15:00:00Z'), 10000);
const sepY = freeze([view(Y, y0)], [], draftOf('2026-09', [line('Revenue', 200000)]), '2026-09', '2026-10-05T14:00:00.000Z');
const y1 = removed(y0, '2026-10-21T14:00:00.000Z');
const octY = freeze([view(Y, y1)], [sepY.report], draftOf('2026-10', [line('Revenue', 100000)]), '2026-10', '2026-11-04T14:00:00.000Z');
show('October finished', octY.report);
const sepY2 = freeze([view(Y, y1)], [octY.report], reopen(sepY.report), '2026-09', '2026-11-10T14:00:00.000Z');
show('September deleted, then finished again', sepY2.report);
console.log(`  NET FOR THE REMOVED COST across the current statements: ${$(chargedFor([octY.report, sepY2.report], Y))}`);
console.log(`  November: ${build([view(Y, y1)], [octY.report, sepY2.report], draftOf('2026-11'), '2026-11').statement.adjustments.length} adjustment(s) for it`);

// ═══ 3. Out-of-order finishing ═══
console.log('\n═══ 3. October finished first (a $40.00 cost sent 5 Oct); the cost removed; then the overdue September finished ═══');
const B = 'TESTENTRYbbbbbbbbbb3';
const b0 = entryDoc(B, iso('2026-10-05T15:00:00Z'), 4000);
const octB = freeze([view(B, b0)], [], draftOf('2026-10', [line('Revenue', 100000)]), '2026-10', '2026-11-03T14:00:00.000Z');
show('October finished', octB.report);
const b1 = removed(b0, '2026-11-05T14:00:00.000Z');
const sepB = freeze([view(B, b1)], [octB.report], draftOf('2026-09', [line('Revenue', 50000)]), '2026-09', '2026-11-06T14:00:00.000Z');
show('September finished after October', sepB.report);
const novB = build([view(B, b1)], [octB.report, sepB.report], draftOf('2026-11'), '2026-11');
console.log(`  November:\n${rows(novB.statement)}`);
const decB = build([view(B, b1)], [octB.report, sepB.report], draftOf('2026-12'), '2026-12');
console.log(`  December, if finished before November: ${decB.statement.adjustments.length} adjustment(s) — November carries it`);

// ═══ 4. A carried −$359.96 corrected to −$200.00 ═══
console.log('\n═══ 4. September closes at −$359.96; October carries it; September corrected to close at −$200.00 ═══');
const sepD = freeze([], [], draftOf('2026-09', [line('Revenue', 100000), line('Expense - Repairs', -135996)]), '2026-09', '2026-10-05T14:00:00.000Z');
show('September finished', sepD.report);
const offered = st.uncarriedDebts([sepD.report], '2026-10');
console.log(`  offered for October: ${JSON.stringify(offered.map((d) => ({ ...d, fromReportId: '…' + d.fromReportId.slice(-4) })))}`);
const carry = { label: offered[0].label, amountCents: offered[0].amountCents, fromReportId: offered[0].fromReportId, fromMonth: offered[0].fromMonth };
const sepDc = freeze([], [sepD.report], draftOf('2026-09', [line('Revenue', 100000), line('Expense - Repairs', -120000)], { supersedes: { reportId: sepD.report.id, reason: 'The repair was $1,200.00.' } }), '2026-09', '2026-10-08T14:00:00.000Z');
show('September corrected', sepDc.report);
// (a) October still a draft: the link follows the corrected statement.
const octOpen = build([], [sepD.report, sepDc.report], draftOf('2026-10', [line('Revenue', 300000)], { carried: carry }), '2026-10');
console.log(`  (a) October still a draft carrying it: carried ${$(octOpen.statement.carried.amountCents)} (stored in the draft: ${$(carry.amountCents)}), revenue share ${$(octOpen.statement.payableCents)}`);
// (b) October finished before the correction: November settles the difference.
const octD = freeze([], [sepD.report], draftOf('2026-10', [line('Revenue', 300000)], { carried: carry }), '2026-10', '2026-11-04T14:00:00.000Z');
show('(b) October finished, carrying it, before the correction', octD.report);
console.log(`  laterReferences(September): ${JSON.stringify(st.laterReferences(sepD.report, [sepD.report, octD.report]).map((r) => [r.report.month, r.adjusted ? 'adjusted' : '', r.carried ? 'carried' : ''].filter(Boolean)))}`);
const sepDc2 = freeze([], [sepD.report, octD.report], draftOf('2026-09', [line('Revenue', 100000), line('Expense - Repairs', -120000)], { supersedes: { reportId: sepD.report.id, reason: 'The repair was $1,200.00.' } }), '2026-09', '2026-11-08T14:00:00.000Z');
const novD = freeze([], [sepD.report, octD.report, sepDc2.report], draftOf('2026-11', [line('Revenue', 50000)]), '2026-11', '2026-12-03T14:00:00.000Z');
show('    September corrected afterwards; November finished', novD.report);
const deducted = octD.report.carriedCents + (novD.report.carriedAdjustments ?? []).reduce((s, r) => s + r.deltaCents, 0);
console.log(`  DEDUCTED FOR SEPTEMBER'S BALANCE in all: ${$(deducted)} (September now closes at ${$(sepDc2.report.payableCents)})`);
console.log(`  November's PDF, the adjustment as the owner reads it: ${st.printedLines(st.statementOf(novD.report, [sepD.report, octD.report, sepDc2.report, novD.report])).filter((l) => l.kind === 'carriedAdjustment').map((l) => `${l.description}  ${$(l.amountCents)}`)}`);
console.log(`  December: ${build([], [sepD.report, octD.report, sepDc2.report, novD.report], draftOf('2026-12'), '2026-12').statement.carriedAdjustments.length} carried adjustment(s)`);
// (c) Deleted instead, and finished again later.
const novE = build([], [octD.report], draftOf('2026-11'), '2026-11');
console.log(`  (c) September deleted after October carried it: November ${novE.statement.carriedAdjustments.map((r) => `${r.label}: carried ${$(r.chargedCents)}, now ${$(r.nowCents)}, gives back ${$(-r.deltaCents)}`)}`);
const novEr = freeze([], [octD.report], draftOf('2026-11', [line('Revenue', 50000)]), '2026-11', '2026-12-03T14:00:00.000Z');
const sepAgain = freeze([], [octD.report, novEr.report], draftOf('2026-09', [line('Revenue', 100000), line('Expense - Repairs', -120000)]), '2026-09', '2026-12-05T14:00:00.000Z');
const decE = build([], [octD.report, novEr.report, sepAgain.report], draftOf('2026-12'), '2026-12');
console.log(`      September finished again at ${$(sepAgain.report.payableCents)}: December ${decE.statement.carriedAdjustments.map((r) => `${r.label}: deducted so far ${$(r.chargedCents)}, now ${$(r.nowCents)}, deducts ${$(r.deltaCents)}`)}`);
console.log(`      DEDUCTED in all: ${$(octD.report.carriedCents + (novEr.report.carriedAdjustments ?? []).reduce((s, r) => s + r.deltaCents, 0) + decE.statement.carriedAdjustmentCents)}; offered again in December: ${st.uncarriedDebts([octD.report, novEr.report, sepAgain.report], '2026-12').length}`);

// ═══ 5. An uncarried debt is offered until a statement carries it ═══
console.log('\n═══ 5. September closes at −$359.96; October finished without carrying it ═══');
const octU = freeze([], [sepD.report], draftOf('2026-10', [line('Revenue', 300000)]), '2026-10', '2026-11-04T14:00:00.000Z');
console.log(`  offered in November: ${JSON.stringify(st.uncarriedDebts([sepD.report, octU.report], '2026-11').map((d) => [d.fromMonth, d.amountCents]))}`);
const novU = freeze([], [sepD.report, octU.report], draftOf('2026-11', [line('Revenue', 50000)]), '2026-11', '2026-12-03T14:00:00.000Z');
console.log(`  offered in December, November not carrying it either: ${JSON.stringify(st.uncarriedDebts([sepD.report, octU.report, novU.report], '2026-12').map((d) => [d.fromMonth, d.amountCents]))}`);
const decU = freeze([], [sepD.report, octU.report, novU.report], draftOf('2026-12', [line('Revenue', 50000)], { carried: { ...st.uncarriedDebts([sepD.report, octU.report, novU.report], '2026-12')[0], fromReportId: sepD.report.id } }), '2026-12', '2027-01-04T14:00:00.000Z');
console.log(`  December carries it (${$(decU.report.carriedCents)}); offered in January: ${JSON.stringify(st.uncarriedDebts([sepD.report, octU.report, novU.report, decU.report], '2027-01'))}`);
