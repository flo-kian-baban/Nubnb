// Dispatch 37A: the month's money (app/lib/money/month.ts) on a made-up portfolio, one case per place two pages
// used to disagree (T1–T10 of the dispatch 37 plan) and per ruling (M1, M2). Made-up data only: properties
// "TESTPROP…", entries "TESTENTRY…", reports "TESTREPORT…". Nothing is read from or written to production.
//   node --import ./tests/tools/ts-hook.mjs tests/money/month-money.mjs
// `freeze` mirrors finishStatement's freeze() in server-reports.ts, as dispatch 35's corrections.mjs does.
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.NUBNB_ROOT || fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const model = await import(`${ROOT}/app/lib/reports/model.ts`);
const st = await import(`${ROOT}/app/lib/reports/statement.ts`);
const { statementPdf } = await import(`${ROOT}/app/lib/reports/statement-pdf.ts`);
const { finishChecks } = await import(`${ROOT}/app/lib/reports/checks.ts`);
const { entryViewOf, selectMonthPackage } = await import(`${ROOT}/app/lib/backup/data.ts`);
const { propertyWorkbook, feeIncomeWorkbook } = await import(`${ROOT}/app/lib/backup/workbooks.ts`);
const { formatCents: $, ADMIN_ACTOR } = await import(`${ROOT}/app/lib/cleaners/model.ts`);
const { buildReport, totalsByProperty, countedItems, chargedOnText, byStatementText } = await import(`${ROOT}/app/lib/costs/report.ts`);
const { pdfFor } = await import(`${ROOT}/app/lib/costs/pdf.ts`);
const { workbookFor } = await import(`${ROOT}/app/lib/costs/xlsx.ts`);
const { monthView } = await import(`${ROOT}/app/lib/income/month.ts`);
const money = await import(`${ROOT}/app/lib/money/month.ts`);
const { unlinkedTitles, unlinkedTitlesFromLines } = await import(`${ROOT}/app/lib/firebase/server-income.ts`);
const { panelFigures } = await import(`${ROOT}/app/lib/firebase/server-reports.ts`);

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);
const text = (bytes) => Buffer.from(bytes).toString('latin1');
let seq = 0;

// ─── Made-up documents ───
const cleanerHistory = (createdAt) => [
  { at: createdAt, action: 'submitted', from: null, to: 'pending', actor: { role: 'cleaner', id: 'TESTCLEANER000000001', name: 'Test cleaner' }, reason: null },
  { at: createdAt, action: 'approved', from: 'pending', to: 'approved', actor: ADMIN_ACTOR, reason: null },
];
function receipt(propertyId, createdAt, cents, extra = {}) {
  return {
    schemaVersion: 2, createdAt, status: 'approved', statusChangedAt: createdAt, statusReason: null, cleanerId: 'TESTCLEANER000000001', cleanerNameAtEntry: 'Test cleaner', propertyId, propertyNameAtEntry: 'Test property',
    purchasedOn: createdAt.slice(0, 10), note: null, currency: 'CAD', kind: 'receipt', autoApproved: null, lines: [{ name: 'Supplies', quantity: 1, lineTotalCents: cents }], taxCents: null, receipts: [],
    history: cleanerHistory(createdAt), ...extra,
  };
}
function office(propertyId, createdAt, cents, month) {
  return {
    schemaVersion: 2, kind: 'office', cleanerId: null, cleanerNameAtEntry: null, propertyId, propertyNameAtEntry: 'Test property', createdAt, purchasedOn: null, note: null, currency: 'CAD',
    lines: [{ name: 'Plumber', quantity: 1, lineTotalCents: cents }], taxCents: null, receipts: [], status: 'approved', statusChangedAt: createdAt, statusReason: null,
    history: [{ at: createdAt, action: 'submitted', from: null, to: 'pending', actor: ADMIN_ACTOR, reason: null }, { at: createdAt, action: 'approved', from: 'pending', to: 'approved', actor: ADMIN_ACTOR, reason: 'Added by the office' }],
    autoApproved: null, month,
  };
}
const corrected = (doc, at, before, after) => ({ ...doc, history: [...doc.history, { at, action: 'line_corrected', from: null, to: null, actor: ADMIN_ACTOR, reason: 'wrong amount', line: { index: 0, before: { name: doc.lines[0].name, quantity: 1, lineTotalCents: before }, after: { name: doc.lines[0].name, quantity: 1, lineTotalCents: after } } }] });
const line = (description, cents, id = `L${++seq}`) => ({ id, description, from: null, to: null, quantity: 1, rateCents: cents, amountCents: cents });
const draftOf = (month, lines = [], extra = {}) => ({ reference: `${model.monthReferenceWord(month)}-TEST`, reportDate: model.monthRange(model.addMonths(month, 1)).from, lines, fee: null, carried: null, notes: null, supersedes: null, ...extra });
const storedDraft = (propertyId, month, draft, finishedAs = null) => ({ id: `${propertyId}_${month}`, schemaVersion: 3, propertyId, month, ...draft, revision: 1, createdAt: '2026-12-01T00:00:00.000Z', updatedAt: '2026-12-01T00:00:00.000Z', finishedAs, finishedRevision: finishedAs ? 1 : null });
const record = (propertyId) => ({ id: propertyId, schemaVersion: 3, propertyId, reportFor: { name: 'Test Owner', address: '' }, owners: [], statementsFrom: '2026-11', statementsUntil: null, defaultFeeRateBasisPoints: null, defaultFee: null, setAt: '2026-12-01T00:00:00.000Z' });

function freeze(propertyId, entries, reports, draft, month, finishedAt) {
  const built = st.buildStatement({ propertyId, propertyName: 'Test property', month, entries, reports, draft, management: null });
  if (built.kind !== 'ok') throw new Error('unreadable ' + built.entryIds);
  const s = { ...built.statement, draft: false };
  const bytes = statementPdf(s);
  const id = `TESTREPORT${String(++seq).padStart(10, '0')}`;
  return {
    id, legacy: false, income: [], ownersAtFinish: [], schemaVersion: model.MONTHLY_REPORT_SCHEMA_VERSION, propertyId, propertyNameAtFinish: 'Test property', month,
    reference: s.reference, reportDate: s.reportDate, reportFor: s.reportFor, lines: s.lines, costs: s.costs, adjustments: s.adjustments, fee: s.fee, carried: s.carried,
    ...(s.carriedAdjustments.length > 0 ? { carriedAdjustments: s.carriedAdjustments } : {}),
    incomeCents: s.incomeCents, expensesCents: s.expensesCents, recordedCents: s.recordedCents, costsCents: s.costsCents, feeCents: s.feeCents, totalCents: s.totalCents, carriedCents: s.carriedCents,
    payableCents: s.payableCents, pendingLeftOut: s.pendingLeftOut, notes: s.notes, entryIds: s.costs.map((row) => row.entryId), finishedAt, actor: ADMIN_ACTOR, supersedes: draft.supersedes ?? null, draftRevision: 1,
    pdf: { path: `monthly-reports/${id}.pdf`, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
  };
}
const fig = (f) => (f === null ? 'none' : `revenue ${$(f.revenueCents)} (Airbnb ${$(f.airbnbCents)}) · expenses ${$(f.expensesCents)} · recorded ${$(f.recordedCents)} · fee ${$(f.feeCents)} · settled carried ${$(f.carriedAdjustmentCents)} · total ${$(f.totalCents)} · carried ${$(f.carriedCents)} · share ${$(f.payableCents)}`);
const where = (charges) => charges.map((c) => `${c.month}${c.reportId ? ' finished' : ' open'} ${c.kind} ${$(c.cents)}`).join(' | ') || '(none)';
const split = (rows) => rows.map((r) => `${r.month}${r.finished ? '' : ' (open)'} ${$(r.cents)}`).join(' · ');

// ═══ T1 · A $50.00 cost logged for November after November's statement was finished ═══
console.log('═══ T1 · a $100.00 receipt sent 15 Nov; November finished 5 Dec; a $50.00 office cost logged 12 Dec for November ═══');
const P1 = 'TESTPROPt1aaaaaaaaaa';
const R1 = 'TESTENTRYt1receipt01';
const O1 = 'TESTENTRYt1office001';
const r1 = receipt(P1, '2026-11-15T15:00:00.000Z', 10000);
const nov1 = freeze(P1, [entryViewOf(R1, r1)], [], draftOf('2026-11', [line('Revenue', 200000)]), '2026-11', '2026-12-05T14:00:00.000Z');
const o1 = office(P1, '2026-12-12T15:00:00.000Z', 5000, '2026-11');
const entries1 = [entryViewOf(R1, r1), entryViewOf(O1, o1)];
const charges1 = money.costCharges({ propertyId: P1, entries: entries1, reports: [nov1], management: record(P1) });
const draftSep = storedDraft(P1, '2026-11', draftOf('2026-11', nov1.lines), nov1.id);
const novMoney = money.monthMoney({ propertyId: P1, propertyName: 'Test property', month: '2026-11', entries: entries1, reports: [nov1], draft: draftSep, management: record(P1), charges: charges1 });
const decMoney = money.monthMoney({ propertyId: P1, propertyName: 'Test property', month: '2026-12', entries: entries1, reports: [nov1], draft: null, management: record(P1), charges: charges1 });
console.log(`  charges: receipt ${where(charges1.get(R1))} · office ${where(charges1.get(O1))}`);
console.log(`  (a) Costs tab, November: ${novMoney.costTotals.count} entries · ${$(novMoney.costTotals.cents)} · by statement: ${split(novMoney.costTotals.byStatement)} · badge ${novMoney.costTotals.count}`);
for (const l of novMoney.costs) console.log(`        ${l.entry.id} ${l.state} now ${$(l.nowCents)} · ${where(l.charges)}`);
const ledger1 = buildReport(entries1, P1, '2026-11-01', '2026-11-30', new Date('2026-12-13T12:00:00Z'), 'Test property', charges1);
console.log(`  (b) Ledger PDF/Excel, 1–30 Nov: ${ledger1.report.entries.length} entries · ${$(ledger1.report.totalCents)} · ${byStatementText(ledger1.report.byStatement, ledger1.report.unchargedCents)}`);
for (const e of ledger1.report.entries) console.log(`        ${e.id} ${$(e.totalCents)} ${e.chargedOn ? chargedOnText(e.chargedOn) : '(its own month)'}`);
const pdf1 = pdfFor(ledger1.report);
const xlsx1 = workbookFor(ledger1.report);
console.log(`        PDF ${sha(pdf1)} holds "On December 2026's statement": ${text(pdf1).includes("On December 2026's statement")} · "Charged on: November 2026's statement $100.00": ${text(pdf1).includes("Charged on: November 2026's statement $100.00")} · Excel ${sha(xlsx1)}`);
console.log(`  (c) November's statement as sent: recorded ${$(nov1.recordedCents)}; month's money figures: ${fig(novMoney.figures)}`);
console.log(`  (d) December's statement as it stands: ${st.printedLines(decMoney.statement).map((r) => `${r.description} ${$(r.amountCents)}`).join('; ')} · also charged on the Costs tab: ${decMoney.alsoCharged.map((r) => `${r.description} ${$(r.cents)}`).join('; ')}`);
const panel1 = panelFigures({ today: '2026-12-13', properties: [{ id: P1, name: 'Test property' }], entries: entries1, reports: [nov1], drafts: [draftSep], management: [record(P1)], airbnbLineIds: new Set() });
console.log(`  (e) Home panel: November costs ${$(panel1['2026-11'][P1].figures.costsCents)} (as it stands: ${panel1['2026-11'][P1].asItStands}) · December costs ${$(panel1['2026-12'][P1].figures.costsCents)} (as it stands: ${panel1['2026-12'][P1].asItStands})`);
const unchanged1 = buildReport([entries1[0]], P1, '2026-11-01', '2026-11-30', new Date('2026-12-13T12:00:00Z'), 'Test property', charges1);
console.log(`  (f) A ledger whose entries are all on their own month's statement is as before: ${sha(pdfFor(unchanged1.report)) === sha(pdfFor(buildReport([entries1[0]], P1, '2026-11-01', '2026-11-30', new Date('2026-12-13T12:00:00Z'), 'Test property').report))}`);

// ═══ T2 · a correction in progress ═══
console.log('\n═══ T2 · November finished at $2,000.00 revenue; a correction adds $100.00 of revenue ═══');
const P2 = 'TESTPROPt2aaaaaaaaaa';
const nov2 = freeze(P2, [], [], draftOf('2026-11', [line('Revenue', 200000, 'L-rev')]), '2026-11', '2026-12-05T14:00:00.000Z');
const correction2 = storedDraft(P2, '2026-11', draftOf('2026-11', [line('Revenue', 200000, 'L-rev'), line('Revenue - late', 10000, 'L-late')], { supersedes: { reportId: nov2.id, reason: 'A stay was left out.' } }));
const m2 = money.monthMoney({ propertyId: P2, propertyName: 'Test property', month: '2026-11', entries: [], reports: [nov2], draft: correction2, management: record(P2) });
console.log(`  month's money: correcting ${m2.correcting} · figures (as sent) revenue ${$(m2.figures.revenueCents)} · correction revenue ${$(m2.correction.revenueCents)} · the page previews ${m2.statement.draft ? 'the correction' : 'the statement as sent'}`);
const panel2 = panelFigures({ today: '2026-12-13', properties: [{ id: P2, name: 'Test property' }], entries: [], reports: [nov2], drafts: [correction2], management: [record(P2)], airbnbLineIds: new Set() });
console.log(`  home panel: revenue ${$(panel2['2026-11'][P2].figures.revenueCents)} · correction ${$(panel2['2026-11'][P2].correction.revenueCents)}`);
const view2 = monthView({ uploads: [], lines: [], links: [], lastSeen: {}, properties: [{ id: P2, name: 'Test property' }], statements: [{ propertyId: P2, finished: false, lines: correction2.lines, sent: nov2.lines }], calendar: { checkIns: [] } });
console.log(`  Income page, By property: revenue ${$(view2.byProperty[0].revenueCents)} · correction ${$(view2.byProperty[0].correction.revenueCents)} · badge ${view2.byProperty[0].finished ? 'finished' : 'draft'}`);

// ═══ T3 · two files of one month sharing rows ═══
console.log('\n═══ T3 · an unlinked title in two December files that share one row ═══');
const linesT3 = [
  { platform: 'airbnb', month: '2026-12', listingTitle: '__TEST__ Unknown Flat', amountCents: 20000 },
  { platform: 'airbnb', month: '2026-12', listingTitle: '__TEST__ Unknown Flat', amountCents: 15000 },
];
const uploadsT3 = [
  { platform: 'airbnb', month: '2026-12', titles: [{ title: '__TEST__ Unknown Flat', rows: 1, amountCents: 20000 }] },
  { platform: 'airbnb', month: '2026-12', titles: [{ title: '__TEST__ Unknown Flat', rows: 2, amountCents: 35000 }] },
];
console.log(`  the files' own summaries (before): ${JSON.stringify(unlinkedTitles(uploadsT3, []))}`);
console.log(`  the stored lines (Finish, the empty months, the Income page): ${JSON.stringify(unlinkedTitlesFromLines(linesT3, []))}`);

// ═══ T4 and M1 · Airbnb claw-backs are less revenue, never expenses ═══
console.log('\n═══ T4 · M1 · Airbnb $1,000.00 and a −$200.00 Resolution Adjustment; a typed $300.00 revenue line and a −$60.00 cleaning ═══');
const P4 = 'TESTPROPt4aaaaaaaaaa';
const lines4 = [line('Revenue - Dec 2–9, 2026', 100000, 'AIRBNB-1'), line('Resolution Adjustment - Dec 2–9, 2026', -20000, 'AIRBNB-2'), line('Revenue - direct stay', 30000), line('Expense - Cleaning', -6000)];
const ids4 = money.airbnbLineIdsOf([{ decided: { status: 'accepted', lineId: 'AIRBNB-1' } }, { decided: { status: 'accepted', lineId: 'AIRBNB-2' } }, { decided: { status: 'rejected' } }, { decided: null }]);
const fee4 = { ...st.feeFrom('NuBNB 20% Net of $800.00', 2000, 80000, null), baseRevenueCents: 110000 };
const m4 = money.monthMoney({ propertyId: P4, propertyName: 'Test property', month: '2026-12', entries: [], reports: [], draft: { ...draftOf('2026-12', lines4, { fee: fee4 }), finishedAs: null }, management: record(P4), airbnbLineIds: ids4 });
console.log(`  the statement's own split (stored at finish, by sign): income ${$(m4.statement.incomeCents)} · expenses ${$(m4.statement.expensesCents)} · total ${$(m4.statement.totalCents)}`);
console.log(`  the month's money: ${fig(m4.figures)}`);
console.log(`  sources: ${m4.income.map((i) => `${i.line.description} ${i.source}`).join(' | ')}`);
const checks4 = (revenueCents) => finishChecks({ statement: m4.statement, reports: [], entries: [], income: { waiting: 0, unlinked: [], checkouts: 0 }, today: '2027-01-03', revenueCents }).warnings.map((w) => w.key).join(', ');
console.log(`  Finish, base typed beside revenue $1,100.00: warns [${checks4(m4.figures.revenueCents)}] (with the split by sign: [${checks4(undefined)}])`);
const typedOnly = money.monthMoney({ propertyId: P4, propertyName: 'Test property', month: '2026-12', entries: [], reports: [], draft: { ...draftOf('2026-12', lines4, { fee: fee4 }), finishedAs: null }, management: record(P4) });
console.log(`  the PDF, with the Airbnb lines known and without: ${sha(statementPdf({ ...m4.statement, draft: false }))} and ${sha(statementPdf({ ...typedOnly.statement, draft: false }))} (identical: ${sha(statementPdf({ ...m4.statement, draft: false })) === sha(statementPdf({ ...typedOnly.statement, draft: false }))})`);

// ═══ T5 · one figure for approved costs ═══
console.log('\n═══ T5 · an approved $56.50 receipt ($50.00 + $6.50 tax) and a pending $20.00 one ═══');
const P5 = 'TESTPROPt5aaaaaaaaaa';
const e5 = [entryViewOf('TESTENTRYt5approved1', receipt(P5, '2026-12-03T15:00:00.000Z', 5000, { taxCents: 650 })), entryViewOf('TESTENTRYt5pending01', receipt(P5, '2026-12-04T15:00:00.000Z', 2000, { status: 'pending', history: cleanerHistory('2026-12-04T15:00:00.000Z').slice(0, 1) }))];
const t5 = totalsByProperty(e5).all;
const items5 = countedItems(e5);
const report5 = buildReport(e5, P5, '2026-12-01', '2026-12-31', new Date('2026-12-13T12:00:00Z'), 'Test property').report;
console.log(`  totals: approved ${$(t5.approvedCents)} (tax ${$(t5.approvedTaxCents)}) · pending apart ${$(t5.pendingCents)}`);
console.log(`  ledger line: ${$(report5.totalCents)} · Items bought, approved: ${$(items5.filter((r) => r.status === 'approved').reduce((s, r) => s + r.line.lineTotalCents, 0))} (rows: ${items5.map((r) => `${r.line.name} ${$(r.line.lineTotalCents)}${r.tax !== undefined ? ' tax' : ''} ${r.status}`).join('; ')})`);
const m5 = money.monthMoney({ propertyId: P5, propertyName: 'Test property', month: '2026-12', entries: e5, reports: [], draft: null, management: record(P5) });
console.log(`  Costs tab: ${m5.costTotals.count} entry · ${$(m5.costTotals.cents)} · tax ${$(m5.costTotals.taxCents)} · waiting ${m5.costTotals.waiting.count} · ${$(m5.costTotals.waiting.cents)}`);

// ═══ T6, T9, T10 · the month ZIP ═══
console.log('\n═══ T6 · November redone after December adjusted its cost; T10 · a November office cost charged on December; T9 · a carried balance ═══');
const P6 = 'TESTPROPt6aaaaaaaaaa';
const X6 = 'TESTENTRYt6receipt01';
const x6 = receipt(P6, '2026-11-15T15:00:00.000Z', 10000);
const novA = freeze(P6, [entryViewOf(X6, x6)], [], draftOf('2026-11', [line('Revenue', 200000)]), '2026-11', '2026-12-05T14:00:00.000Z');
const x6b = corrected(x6, '2026-12-20T14:00:00.000Z', 10000, 15000);
const O6 = 'TESTENTRYt6office001';
const o6 = office(P6, '2026-12-22T15:00:00.000Z', 4000, '2026-11');
const dec6 = freeze(P6, [entryViewOf(X6, x6b), entryViewOf(O6, o6)], [novA], draftOf('2026-12', [line('Revenue', 100000)], { carried: { label: 'Balance From October', amountCents: 35996, fromReportId: null } }), '2026-12', '2027-01-04T14:00:00.000Z');
// November deleted and finished again (dispatch 35): it charges only what is left after December's adjustment.
const novB = freeze(P6, [entryViewOf(X6, x6b), entryViewOf(O6, o6)], [dec6], { ...draftOf('2026-11', novA.lines) }, '2026-11', '2027-01-10T14:00:00.000Z');
const stored6 = { [X6]: x6b, [O6]: o6 };
const pick6 = (month) =>
  selectMonthPackage({
    month, today: '2027-01-10', madeAt: '2027-01-10T16:00:00.000Z', properties: [{ id: P6, name: 'Test property', createdMonth: '2026-11' }],
    entries: Object.entries(stored6).map(([id, stored]) => ({ id, stored })), reports: [dec6, novB].map((view) => ({ view, stored: view })), drafts: [], downloads: [], management: [{ view: record(P6), stored: record(P6) }],
  });
const novPkg = pick6('2026-11');
const novFolder = novPkg.data.folders[0];
console.log(`  November as redone: cost row ${$(novFolder.statement.costs[0].totalCents)}; the rest elsewhere: ${JSON.stringify(novFolder.elsewhere)}`);
const novBook = text(propertyWorkbook({ data: novPkg.data, folder: novFolder, receipts: new Map(), madeAt: new Date('2027-01-10T16:00:00Z') }));
console.log(`  its workbook says "Yes: $100.00 here, the rest on December 2026's statement $50.00": ${novBook.includes("Yes: $100.00 here, the rest on December 2026&apos;s statement $50.00") || novBook.includes("Yes: $100.00 here, the rest on December 2026's statement $50.00")} · says "Differs": ${novBook.includes('Differs')} · lists "Charged on December 2026's statement" under Items: ${novBook.includes('Charged on December 2026')}`);
const decPkg = pick6('2026-12');
const decFolder = decPkg.data.folders[0];
const decBook = text(propertyWorkbook({ data: decPkg.data, folder: decFolder, receipts: new Map(), madeAt: new Date('2027-01-10T16:00:00Z') }));
console.log(`  December's workbook: "From November 2026" ${decBook.includes('From November 2026')} · "From December 2026" ${decBook.includes('From December 2026')} · "Recorded costs" row ${decBook.includes('Recorded costs')} · carried as printed (+359.96) ${decBook.includes('<v>359.96</v>')} · as before (−359.96) ${decBook.includes('<v>-359.96</v>')}`);
console.log(`  December's figures: ${fig(decFolder.figures)}`);
const feeBook = text(feeIncomeWorkbook({ data: decPkg.data, statements: new Map(), madeAt: new Date('2027-01-10T16:00:00Z') }));
console.log(`  fee workbook: "Carried balances settled (CAD)" ${feeBook.includes('Carried balances settled (CAD)')} · "Fee, deducted (CAD)" ${feeBook.includes('Fee, deducted (CAD)')} · "of which Airbnb (CAD)" ${feeBook.includes('of which Airbnb (CAD)')}`);

// ═══ T7 · the home panel adds up ═══
console.log('\n═══ T7 · a carried balance and a carried balance settled: Income − Costs − Fee − Carried = Revenue share ═══');
const P7 = 'TESTPROPt7aaaaaaaaaa';
const nov7 = freeze(P7, [], [], draftOf('2026-11', [line('Revenue', 100000), line('Expense - Repairs', -135996)]), '2026-11', '2026-12-05T14:00:00.000Z');
const carry7 = st.carriedSuggestion(nov7);
const dec7 = freeze(P7, [], [nov7], draftOf('2026-12', [line('Revenue', 300000)], { carried: carry7 }), '2026-12', '2027-01-04T14:00:00.000Z');
const nov7c = freeze(P7, [], [nov7, dec7], draftOf('2026-11', [line('Revenue', 100000), line('Expense - Repairs', -120000)], { supersedes: { reportId: nov7.id, reason: 'The repair was $1,200.00.' } }), '2026-11', '2027-01-08T14:00:00.000Z');
const jan7 = freeze(P7, [], [nov7, dec7, nov7c], draftOf('2027-01', [line('Revenue', 50000)]), '2027-01', '2027-02-03T14:00:00.000Z');
const panel7 = panelFigures({ today: '2027-02-03', properties: [{ id: P7, name: 'Test property' }], entries: [], reports: [nov7, dec7, nov7c, jan7], drafts: [], management: [record(P7)], airbnbLineIds: new Set() });
for (const m of ['2026-11', '2026-12', '2027-01']) {
  const f = panel7[m][P7].figures;
  console.log(`  ${m}: income ${$(f.revenueCents)} − costs ${$(f.costsCents)} − fee ${$(f.feeCents)} − carried ${$(money.carriedAllCents(f))} = ${$(f.revenueCents - f.costsCents - f.feeCents - money.carriedAllCents(f))} · revenue share ${$(f.payableCents)}`);
}

// ═══ T8 · the Costs tab's count ═══
console.log('\n═══ T8 · November finished with one cost; a second approved for November afterwards ═══');
console.log(`  head ${novMoney.costTotals.count} entries; the tab's count is the same figure (${novMoney.costTotals.count}); the statement's own cost rows: ${novMoney.statement.costs.length}`);

// ═══ M2 · the owed-months rule counts any confirmed line ═══
console.log('\n═══ M2 · the months with money ═══');
console.log(`  ${JSON.stringify([...st.moneyMonthsByProperty([{ propertyId: P4, month: '2026-12', lines: lines4 }, { propertyId: P2, month: '2026-10', lines: [] }], [...entries1, ...e5])])}`);
