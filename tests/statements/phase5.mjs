// Phase 5, step 2 (Kian's rulings of 2026-11-01, after the Phase 5 report): a negative file row placed with a typed line
// is Airbnb's money (M1 extended); an unread row whose month is finished is placed on the next open statement, which
// prints its line with the day paid (as M11 does for a late file line); Finish warns when the typed fee base is not what
// Airbnb paid; the Report For sheet's import carries a default fee rate per property, which a new statement starts from.
// Made-up data only: properties "TESTPROP…", titles "__TEST__ …", booking codes HMTEST…; the app's own server functions
// run on the in-memory Firestore of tests/tools/memory-firestore.cjs. Nothing is read from or written to production.
//   node --import ./tests/tools/ts-hook.mjs tests/statements/phase5.mjs
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.NUBNB_ROOT || fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
createRequire(`${ROOT}/package.json`)(`${ROOT}/tests/tools/memory-firestore.cjs`);
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2_048 });
process.env.FIREBASE_SERVICE_ACCOUNT_KEY = JSON.stringify({ type: 'service_account', project_id: 'memory-test', private_key_id: 'memory-test', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), client_email: 'memory-test@memory-test.iam.gserviceaccount.com', client_id: '1', token_uri: 'https://oauth2.googleapis.com/token' });
process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = 'memory-test.appspot.com';
process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = 'memory-test';
const model = await import(`${ROOT}/app/lib/reports/model.ts`);
const st = await import(`${ROOT}/app/lib/reports/statement.ts`);
const money = await import(`${ROOT}/app/lib/money/month.ts`);
const { finishChecks } = await import(`${ROOT}/app/lib/reports/checks.ts`);
const { statementPdf } = await import(`${ROOT}/app/lib/reports/statement-pdf.ts`);
const prices = await import(`${ROOT}/app/lib/cleanings/prices.ts`);
const form = await import(`${ROOT}/app/admin/property/statement-form.ts`);
const sr = await import(`${ROOT}/app/lib/firebase/server-reports.ts`);
const su = await import(`${ROOT}/app/lib/firebase/server-unread.ts`);
const inc = await import(`${ROOT}/app/lib/income/model.ts`);
const mv = await import(`${ROOT}/app/lib/income/month.ts`);

let failures = 0;
const check = (ok, label) => {
  if (!ok) failures += 1;
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${label}`);
};
const $ = (c) => `${c < 0 ? '-' : ''}$${(Math.abs(c) / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const P = (n) => `TESTPROP${String(n).padStart(4, '0')}`;
const AT = '2026-12-02T15:00:00.000Z';
const ADMIN = { role: 'admin', id: 'TESTADMIN', name: 'Test Admin' };
const sha = (text) => createHash('sha256').update(text).digest('hex');
let seq = 0;
const line = (description, cents, extra = {}) => ({ id: `L${++seq}`, description, from: null, to: null, quantity: 1, rateCents: cents, amountCents: cents, ...extra });
const fileLine = (description, cents) => line(description, cents, { source: 'airbnb', platformLineId: sha(`line-${seq}`) });

// ═══ 1. A negative row placed with a typed line is Airbnb's money (M1 extended): the Phase 5 report's table, both ways ═══
console.log('═══ 1. A negative file row placed with a typed line: Airbnb\'s money, less revenue (Kian\'s ruling of 2026-11-01) ═══');
// P's November 2028 as the rehearsal had it: eight lines from the file, one direct payment, a typed +$162.35 placing a
// USD row, a typed -$30.00 placing a no-code negative row.
const fileLines = [fileLine('Revenue - Nov 22–25, 2028', 29950), fileLine('Revenue - Nov 20–23, 2028', 30103), fileLine('Revenue - Nov 13–16, 2028', 28810), fileLine('Adjustment - Nov 5–15, 2028', 1875), fileLine('Revenue - Nov 5–15, 2028', 98765), fileLine('Resolution Adjustment - Nov 2–5, 2028', -4520), fileLine('Revenue - Nov 2–5, 2028', 31245), fileLine('Revenue - Oct 31–Nov 30, 2028 (paid Nov 1)', 234560)];
const direct = line('E-transfer - Monthly stay - received Nov 2', 150000, { source: 'direct', platformLineId: sha('direct-1') });
const usd = line('Revenue - paid in USD, converted', 16235);
const negative = line('Resolution Adjustment - no confirmation code', -3000);
const lines = [...fileLines, direct, usd, negative];
const costs = [{ entryId: 'TESTENTRY0000000001', ref: 'c1', day: '2028-11-30', kind: 'cleaning', description: 'Cleaning', itemsCents: 44300, taxCents: null, totalCents: 44300, corrected: false, historyLength: 1, receiptSha256: null, group: 'month' }, { entryId: 'TESTENTRY0000000002', ref: 'r1', day: '2028-11-30', kind: 'receipt', description: 'ref r1', itemsCents: 23680, taxCents: null, totalCents: 23680, corrected: false, historyLength: 2, receiptSha256: null, group: 'month' }, { entryId: 'TESTENTRY0000000003', ref: 'w1', day: '2028-11-30', kind: 'work', description: 'ref w1', itemsCents: 15000, taxCents: null, totalCents: 15000, corrected: false, historyLength: 2, receiptSha256: null, group: 'month' }, { entryId: 'TESTENTRY0000000004', ref: 'o1', day: '2028-12-02', kind: 'office', description: 'ref o1', itemsCents: 2499, taxCents: 325, totalCents: 2824, corrected: false, historyLength: 2, receiptSha256: null, group: 'month', month: '2028-11' }];
// The placed rows as the stored decisions give them: the USD row (positive) and the no-code row (negative).
const placedRows = money.placedRowsOf([
  { month: '2028-11', payoutDate: '2028-11-18', amountCents: 12000, decision: { kind: 'placed', propertyId: P(1), month: '2028-11', lineId: usd.id, description: usd.description, amountCents: 16235, at: AT, actor: ADMIN } },
  { month: '2028-11', payoutDate: '2028-11-17', amountCents: -3000, decision: { kind: 'placed', propertyId: P(1), month: '2028-11', lineId: negative.id, description: negative.description, amountCents: -3000, at: AT, actor: ADMIN } },
  { month: '2028-11', payoutDate: '2028-11-26', amountCents: 9500, decision: null },
  { month: '2028-11', payoutDate: '2028-11-26', amountCents: -1000, decision: { kind: 'not-ours', reason: 'Not ours', at: AT, actor: ADMIN } },
]);
console.log(`  placed rows read from the decisions: ${placedRows.length} (${placedRows.map((r) => `${r.lineId} ${$(r.amountCents)} on ${r.statementMonth}`).join('; ')})`);
check(placedRows.length === 2 && placedRows.every((r) => r.propertyId === P(1)), 'two placed rows; an undecided row and a "not Nubnb\'s money" row give nothing');
const idsBefore = money.airbnbLineIdsOf([]);
const idsAfter = money.airbnbLineIdsOf([], placedRows);
check(idsBefore.size === 0 && idsAfter.size === 1 && idsAfter.has(negative.id) && !idsAfter.has(usd.id), 'only the NEGATIVE placed row\'s line joins the Airbnb set; the positive one stays typed revenue');
const bothWays = [['as coded before (M1: file lines only)', idsBefore], ['M1 extended (the placed negative row)', idsAfter]].map(([label, ids]) => {
  const income = money.incomeFigures(lines, ids);
  const fee = st.feeFrom(st.feeLabelFor(2000, income.airbnbCents), 2000, income.airbnbCents, null);
  const sums = st.statementSums(lines, costs, [], fee, null, []);
  return { label, income, fee, sums };
});
// "expenses" in the Phase 5 report's table is the statement's own split by sign (negative lines negated): $75.20 either
// way, the claw-back and the placed row both negative lines. The month's money's typed expenses (M1) move: $30.00 → $0.00.
for (const way of bothWays) console.log(`  ${way.label.padEnd(44)} revenue ${$(way.income.revenueCents)} · Airbnb paid ${$(way.income.airbnbCents)} · base ${$(way.fee.baseCents)} · fee ${$(way.fee.amountCents)} · negative lines ${$(way.sums.expensesCents)} (typed expenses under M1 ${$(way.income.expensesCents)}) · Revenue Share ${$(way.sums.payableCents)}`);
const [before, after] = bothWays;
check(before.income.revenueCents === 617023 && before.income.airbnbCents === 450788 && before.fee.amountCents === 90158 && before.sums.expensesCents === 7520 && before.income.expensesCents === 3000 && before.sums.payableCents === 438061, 'as coded before: revenue $6,170.23, Airbnb paid $4,507.88, fee $901.58, negative lines $75.20, Revenue Share $4,380.61 (the Phase 5 report\'s left column)');
check(after.income.revenueCents === 614023 && after.income.airbnbCents === 447788 && after.fee.amountCents === 89558 && after.sums.expensesCents === 7520 && after.income.expensesCents === 0 && after.sums.payableCents === 438661, 'M1 extended: revenue $6,140.23, Airbnb paid $4,477.88, fee $895.58, Revenue Share $4,386.61 (the right column); the placed row is no typed expense');
check(after.sums.payableCents - before.sums.payableCents === before.fee.amountCents - after.fee.amountCents, 'the owner\'s share moves by the fee alone: the Total before the fee is the same either way');
const figures = money.figuresOf({ legacy: false, lines, costs, adjustments: [], fee: after.fee, carried: null, carriedAdjustments: [], ...after.sums, propertyName: 'Test', month: '2028-11', reference: '', reportDate: '', reportFor: null, draft: true, pendingLeftOut: 0, notes: null, supersedes: null, heading: true }, idsAfter);
check(figures.airbnbCents === 447788 && figures.revenueCents === 614023 && figures.expensesCents === 0, 'the month\'s money (figuresOf) reads the placed negative row as Airbnb\'s money too');
// The Income page's by-property figures read the same decisions.
const monthViewFigures = mv.monthView({ uploads: [], lines: [], links: [], lastSeen: {}, properties: [{ id: P(1), name: '__TEST__ Pine Loft' }], statements: [{ propertyId: P(1), finished: false, lines }], calendar: { checkIns: [] }, month: '2028-11', unread: [{ id: sha('u-neg'), schemaVersion: 1, platform: 'airbnb', uploadId: 'TESTUPLOAD0001', fileRow: 12, payoutDate: '2028-11-17', month: '2028-11', type: 'Resolution Adjustment', confirmationCode: '', listingTitle: '__TEST__ Pine Loft', currency: 'CAD', stay: { start: '2028-11-15', end: '2028-11-17', nights: 2 }, amountCents: -3000, why: 'no confirmation code', decision: { kind: 'placed', propertyId: P(1), month: '2028-11', lineId: negative.id, description: negative.description, amountCents: -3000, at: AT, actor: ADMIN }, history: [{ at: AT, actor: ADMIN, action: 'placed' }], createdAt: AT }] }).byProperty[0];
check(monthViewFigures.airbnbCents === 447788 && monthViewFigures.revenueCents === 614023 && monthViewFigures.expensesCents === 0, 'the Income page\'s by-property figures read the placed negative row as Airbnb\'s money');

// ═══ 2. A row whose month is finished is placed on the next open statement, which prints the day paid ═══
console.log('\n═══ 2. Late placement: a November row placed on December\'s statement, printed with the day paid (M11\'s way) ═══');
const record = { id: P(2), schemaVersion: 3, propertyId: P(2), reportFor: { name: 'Test Owner', address: '' }, owners: [], statementsFrom: '2026-11', statementsUntil: null, defaultFeeRateBasisPoints: null, defaultFee: null, setAt: AT };
globalThis.__memSeed('properties', P(2), { name: '__TEST__ Quay House' });
// November finished: its report, as finishStatement freezes one (the fields readMonthlyReport reads).
const novLines = [fileLine('Revenue - Nov 10–14, 2026', 45505)];
const novBuilt = st.buildStatement({ propertyId: P(2), propertyName: '__TEST__ Quay House', month: '2026-11', entries: [], reports: [], draft: { reference: 'Nov-TEST', reportDate: '2026-12-02', lines: novLines, fee: null, carried: null, notes: null, supersedes: null }, management: record });
const novStatement = { ...novBuilt.statement, draft: false };
const novBytes = statementPdf(novStatement);
const novReport = { schemaVersion: 4, propertyId: P(2), propertyNameAtFinish: '__TEST__ Quay House', month: '2026-11', reference: 'Nov-TEST', reportDate: '2026-12-02', reportFor: { name: 'Test Owner', address: '' }, lines: novStatement.lines, costs: [], adjustments: [], fee: null, carried: null, incomeCents: novStatement.incomeCents, expensesCents: 0, recordedCents: 0, costsCents: 0, feeCents: 0, totalCents: novStatement.totalCents, carriedCents: 0, payableCents: novStatement.payableCents, pendingLeftOut: 0, notes: null, entryIds: [], finishedAt: AT, actor: ADMIN, supersedes: null, draftRevision: 1, pdf: { path: 'monthly-reports/TESTREPORT0000000001.pdf', bytes: novBytes.length, sha256: sha(Buffer.from(novBytes)) } };
globalThis.__memSeed('monthly_reports', 'TESTREPORT0000000001', novReport);
globalThis.__memSeed('monthly_report_drafts', `${P(2)}_2026-11`, { schemaVersion: 3, propertyId: P(2), month: '2026-11', reference: 'Nov-TEST', reportDate: '2026-12-02', lines: novLines.map((l) => ({ ...l })).filter(() => false), fee: null, carried: null, notes: null, supersedes: null, revision: 1, createdAt: AT, updatedAt: AT, finishedAs: 'TESTREPORT0000000001', finishedRevision: 1 });
// The row: November's USD reservation, undecided at month close.
const rowId = sha('late-usd');
globalThis.__memSeed('earnings_unread', rowId, { schemaVersion: 1, platform: 'airbnb', uploadId: 'TESTUPLOAD0002', fileRow: 9, payoutDate: '2026-11-26', month: '2026-11', type: 'Reservation', confirmationCode: 'HMTESTU2', listingTitle: '__TEST__ Quay House', currency: 'USD', stay: { start: '2026-11-24', end: '2026-11-26', nights: 2 }, amountCents: 9500, why: 'the currency is USD, not CAD', decision: null, history: [], createdAt: AT });
const lineOnDec = { id: 'test-late-line', description: 'Revenue - paid in USD, converted (November)', from: '2026-11-24', to: '2026-11-26', quantity: 1, rate: '128.50' };
const saved = await sr.saveDraft(ADMIN, sr.DraftInputSchema.parse({ propertyId: P(2), month: '2026-12', revision: 0, reference: 'Dec-TEST', reportDate: '2026-12-31', lines: [lineOnDec], fee: null, carried: null, notes: null, supersedes: null }));
console.log(`  December's draft saved with the typed line: ${saved.kind}`);
const onNovember = await su.placeUnread(ADMIN, rowId, { seen: 0, propertyId: P(2), lineId: 'no-such-line' }, new Date(AT));
console.log(`  placing with a line that is on no draft: ${onNovember.kind}${onNovember.kind === 'no-such-line' ? ` · the month named: ${onNovember.month}` : ''}`);
check(onNovember.kind === 'no-such-line' && onNovember.month === '2026-12', 'with November finished, the refusal names December: the next open statement is where the line must be');
const placed = await su.placeUnread(ADMIN, rowId, { seen: 0, propertyId: P(2), lineId: 'test-late-line' }, new Date(AT));
console.log(`  placing with December's typed line: ${placed.kind}${placed.kind === 'decided' ? ` · decision month ${placed.unread.decision.month} · line ${placed.unread.decision.lineId}` : ''}`);
check(placed.kind === 'decided' && placed.unread.decision.kind === 'placed' && placed.unread.decision.month === '2026-12' && placed.unread.decision.lineId === 'test-late-line', 'the row is placed on December\'s statement (the decision names December, the row keeps its own month)');
const rowNow = inc.readEarningsUnread(rowId, globalThis.__memDoc('earnings_unread', rowId));
const placedLate = money.placedRowsOf([rowNow]);
console.log(`  as the statements read it: ${JSON.stringify(placedLate)}`);
const decDraft = model.readStatementDraft(`${P(2)}_2026-12`, globalThis.__memDoc('monthly_report_drafts', `${P(2)}_2026-12`));
const novView = model.readMonthlyReport('TESTREPORT0000000001', globalThis.__memDoc('monthly_reports', 'TESTREPORT0000000001'));
const decBuilt = st.buildStatement({ propertyId: P(2), propertyName: '__TEST__ Quay House', month: '2026-12', entries: [], reports: [novView], draft: decDraft, management: record, placed: placedLate });
const decLine = decBuilt.statement.lines.find((l) => l.id === 'test-late-line');
console.log(`  December prints: "${decLine?.description}" ${$(decLine?.amountCents ?? 0)}`);
check(decLine?.description === 'Revenue - paid in USD, converted (November) (paid Nov 26)', 'the late line prints with the day paid after its words, as a late file line does (M11)');
const decText = Buffer.from(statementPdf({ ...decBuilt.statement, draft: false })).toString('latin1');
// A PDF literal string escapes its parentheses: "\\(paid Nov 26\\)" in the content stream.
check(decText.includes('paid Nov 26'), 'the PDF carries the label');
check(decDraft.lines[0].description === 'Revenue - paid in USD, converted (November)', 'the draft keeps the admin\'s words as typed: the label is printed, not stored');
const novAgain = globalThis.__memDoc('monthly_reports', 'TESTREPORT0000000001');
check(JSON.stringify(novAgain) === JSON.stringify(novReport) && novAgain.pdf.sha256 === sha(Buffer.from(novBytes)), 'November\'s finished statement and its PDF\'s hash are untouched');
const own = money.placedRowsOf([{ ...rowNow, decision: { ...rowNow.decision, month: '2026-11' } }]);
const sameMonth = st.buildStatement({ propertyId: P(2), propertyName: '__TEST__ Quay House', month: '2026-11', entries: [], reports: [], draft: { reference: 'Nov-TEST', reportDate: '2026-12-02', lines: [{ id: 'test-late-line', description: 'Revenue - paid in USD, converted', from: null, to: null, quantity: 1, rateCents: 12850, amountCents: 12850 }], fee: null, carried: null, notes: null, supersedes: null }, management: record, placed: own });
check(sameMonth.statement.lines[0].description === 'Revenue - paid in USD, converted', 'a row placed on its own month\'s statement prints the line as typed, no label');
// Deleting December's line reopens the row (the Phase 5 fix follows the decision's month).
const reopened = await sr.saveDraft(ADMIN, sr.DraftInputSchema.parse({ propertyId: P(2), month: '2026-12', revision: saved.draft.revision, reference: 'Dec-TEST', reportDate: '2026-12-31', lines: [], fee: null, carried: null, notes: null, supersedes: null }));
const rowAfter = globalThis.__memDoc('earnings_unread', rowId);
check(reopened.kind === 'saved' && rowAfter.decision === null && rowAfter.history.map((e) => e.action).join(',') === 'placed,reopened', 'deleting the line from December\'s draft reopens the November row');

// ═══ 3. Finish warns when the typed fee base is not what Airbnb paid ═══
console.log('\n═══ 3. Finish: the fee\'s base against what Airbnb paid (the base is what Airbnb paid; direct payments carry no fee) ═══');
const withFee = (baseCents) => st.buildStatement({ propertyId: P(3), propertyName: 'Test Fee', month: '2026-11', entries: [], reports: [], draft: { reference: 'Nov-TEST', reportDate: '2026-12-02', lines: [fileLine('Revenue - Nov 2–4, 2026', 10000), line('Cash - Monthly stay - received Nov 3', 50000, { source: 'direct', platformLineId: sha('d-3') })], fee: st.feeFrom(st.feeLabelFor(2000, baseCents), 2000, baseCents, null), carried: null, notes: null, supersedes: null }, management: { ...record, id: P(3), propertyId: P(3) } }).statement;
const warnAt = (baseCents, airbnbCents) => finishChecks({ statement: withFee(baseCents), reports: [], entries: [], income: { waiting: 0, unlinked: [], checkouts: 0 }, today: '2026-12-02', ...(airbnbCents === undefined ? {} : { airbnbCents }) }).warnings.filter((w) => w.key === 'fee-base-airbnb');
console.log(`  base $100.00, Airbnb paid $100.00: ${warnAt(10000, 10000).length} warning(s)`);
const off = warnAt(10000, 10100);
console.log(`  base $100.00, Airbnb paid $101.00: ${off.length} warning(s) · "${off[0]?.text}" (tab ${off[0]?.tab})`);
check(warnAt(10000, 10000).length === 0, 'equal: no warning');
check(off.length === 1 && off[0].text === "The fee's base is $100.00; Airbnb paid $101.00 this month." && off[0].tab === 'details', 'a base $1.00 off: one warning, both figures, on the Details tab');
check(warnAt(10100, 10000).length === 1 && warnAt(10000, undefined).length === 0, 'a base above what Airbnb paid warns too; with no Airbnb figure read, nothing is checked');
check(finishChecks({ statement: withFee(10100), reports: [], entries: [], income: { waiting: 0, unlinked: [], checkouts: 0 }, today: '2026-12-02', airbnbCents: 10000 }).refusals.length === 0, 'a warning, never a refusal');
check(withFee(10000).fee.amountCents === 2000 && withFee(10000).lines.some((l) => l.source === 'direct'), 'the direct payment on the statement is outside the base: the fee is 20% of the $100.00 Airbnb paid');

// ═══ 4. The Report For sheet's import carries a default fee rate per property ═══
console.log('\n═══ 4. The sheet\'s import: a rate column, saved as the property\'s default fee rate, which a new statement starts from ═══');
const csv = ['address,short,mid,long,rate', '__TEST__ 1 Statement Rd,75,95,115,20', '__TEST__ 2 Statement Rd,65,,100,12.5%', '__TEST__ 3 Statement Rd,60,60,90,', '__TEST__ 4 Statement Rd,60,60,90,abc', '__TEST__ 9 Nowhere Rd,50,50,50,15'].join('\n');
const parsed = prices.parsePricesCsv(csv);
console.log(`  parsed: ${parsed.kind} · rates ${parsed.rows.map((r) => JSON.stringify(r.rate)).join(', ')}`);
check(parsed.kind === 'ok' && parsed.rows.map((r) => r.rate).join('|') === '20|12.5%||abc|15', 'the rate column is read as typed, empty cells kept empty');
const noRate = prices.parsePricesCsv('address,short,long\n__TEST__ 1 Statement Rd,75,115');
check(noRate.kind === 'ok' && noRate.rows[0].rate === null, 'a file with no rate column reads rate null');
console.log(`  readRateText: ${['20', '12.5%', '', 'abc', '101', '0'].map((t) => `"${t}" → ${JSON.stringify(prices.readRateText(t))}`).join(' · ')}`);
const props = [1, 2, 3, 4].map((n) => ({ id: P(n), name: `__TEST__ ${n} Statement Rd` }));
const matched = prices.matchPriceRows(parsed.rows, props, new Map(), new Map([[P(1), 1500], [P(2), 1250], [P(3), 2000]]));
for (const m of matched.matched) console.log(`  matched ${m.name}: prices change ${m.changes} · rate ${m.rate ? `${m.rate.before} → ${m.rate.after} (changes ${m.rate.changes})` : 'as stored'}`);
for (const u of matched.unmatched) console.log(`  unmatched ${u.row.address}: ${u.why}`);
check(matched.matched.length === 3 && matched.matched[0].rate?.after === 2000 && matched.matched[0].rate.before === 1500 && matched.matched[0].rate.changes === true, 'row 1: the rate 15% → 20% changes');
check(matched.matched[1].rate?.after === 1250 && matched.matched[1].rate.changes === false, 'row 2: "12.5%" reads as the stored 12.5%: no change');
check(matched.matched[2].rate === null, 'row 3: an empty rate cell leaves the stored rate as it is');
check(matched.unmatched.some((u) => u.why === 'the rate is not a percent') && matched.unmatched.some((u) => u.why === 'no property with this address'), 'a rate that is not a percent is not saved, and says so; the unknown address neither');
const withoutRates = prices.matchPriceRows(noRate.rows, props, new Map());
check(withoutRates.matched[0].rate === null, 'a file with no rate column changes no rate');
// What a new statement starts from: the previous statement's rate, else the record's default (the sheet's rate is that default).
const managementAfter = { ...record, id: P(1), propertyId: P(1), defaultFeeRateBasisPoints: 2000 };
check(st.feeRateSuggestion(null, managementAfter) === 2000 && st.feeRateSuggestion({ fee: { rateBasisPoints: 1500 } }, managementAfter) === 1500, 'the suggested rate: the previous statement\'s, else the record\'s default');
const fresh = form.suggestedTyped(null, managementAfter, '2026-12', '2026-12-02');
console.log(`  a new December statement after the import: fee rate "${fresh.fee?.rate}", base "${fresh.fee?.base}"`);
check(fresh.fee?.rate === '20' && fresh.fee?.base === '', 'a new statement\'s rate is prefilled from the imported default; the base stays empty (never filled in)');

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`);
if (failures) process.exitCode = 1;
