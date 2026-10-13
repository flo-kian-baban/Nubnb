// Dispatch 37B: cleanings through Nubnb's own pure code (the statements, their PDF, the ledger and its exports, the
// month ZIP, Finish's checks, the owed months, the empty months). Made-up data only: property "TESTPROP…", cleaner
// "Zelda Testcleaner", cleanings "TESTCLEANING…". Nothing is read from or written to production.
//   node --import ./tests/tools/ts-hook.mjs tests/money/cleanings.mjs
// `freeze` mirrors finishStatement's freeze() in server-reports.ts, as corrections.mjs does.
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.NUBNB_ROOT || fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const model = await import(`${ROOT}/app/lib/reports/model.ts`);
const st = await import(`${ROOT}/app/lib/reports/statement.ts`);
const { statementPdf } = await import(`${ROOT}/app/lib/reports/statement-pdf.ts`);
const { finishChecks } = await import(`${ROOT}/app/lib/reports/checks.ts`);
const { emptyMonth } = await import(`${ROOT}/app/lib/reports/empty.ts`);
const { selectMonthPackage, statementKey } = await import(`${ROOT}/app/lib/backup/data.ts`);
const { buildMonthPackage } = await import(`${ROOT}/app/lib/backup/package.ts`);
const { formatCents: $, ADMIN_ACTOR } = await import(`${ROOT}/app/lib/cleaners/model.ts`);
const { buildReport } = await import(`${ROOT}/app/lib/costs/report.ts`);
const { pdfFor } = await import(`${ROOT}/app/lib/costs/pdf.ts`);
const { workbookFor } = await import(`${ROOT}/app/lib/costs/xlsx.ts`);
const cl = await import(`${ROOT}/app/lib/cleanings/model.ts`);
const money = await import(`${ROOT}/app/lib/money/month.ts`);

const NAME = 'Zelda Testcleaner';
const P = 'TESTPROPcleaningsaa1';
const C = 'TESTCLEANERzelda0001';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const text = (bytes) => Buffer.from(bytes).toString('latin1');
const utf8 = (bytes) => Buffer.from(bytes).toString('utf8');
let seq = 0;

// ─── Made-up cleanings, as stored ───
function cleaning(day, cents, extra = {}) {
  const id = `TESTCLEANING${String(++seq).padStart(8, '0')}`;
  const at = `${day}T20:00:00.000Z`;
  return { id, schemaVersion: 1, propertyId: P, propertyNameAtEntry: 'Test Lakeview Loft', cleanerId: C, cleanerNameAtEntry: NAME, day, amountCents: cents, note: `cleaned by ${NAME}`, status: 'logged', suggested: { from: 'default', cents: 6000 }, createdAt: at, actor: ADMIN_ACTOR, history: [{ at, action: 'logged', actor: ADMIN_ACTOR, reason: null }], ...extra };
}
const changed = (c, at, cents) => ({ ...c, amountCents: cents, history: [...c.history, { at, action: 'changed', actor: ADMIN_ACTOR, reason: 'wrong amount', before: { amountCents: c.amountCents }, after: { amountCents: cents } }] });
const removed = (c, at) => ({ ...c, status: 'removed', history: [...c.history, { at, action: 'removed', actor: ADMIN_ACTOR, reason: null }] });
/** As the admin pages read it: the cleaner found, or deleted (`missing`). */
const view = (c, cleanerState = 'found') => {
  const read = cl.readCleaning(c.id, c);
  if (!read) throw new Error(`not in shape: ${c.id}`);
  return { ...read, cleaner: cleanerState === 'found' ? { state: 'found', name: NAME, status: 'active' } : { state: 'missing', name: null, status: null }, property: { state: 'found', name: 'Test Lakeview Loft' } };
};
const entries = (list, state) => list.map((c) => cl.cleaningEntryView(view(c, state)));
const draftOf = (month, lines = [], extra = {}) => ({ reference: `${model.monthReferenceWord(month)}-TEST`, reportDate: model.monthRange(model.addMonths(month, 1)).from, lines, fee: null, carried: null, notes: null, supersedes: null, ...extra });
const record = { id: P, schemaVersion: 3, propertyId: P, reportFor: { name: 'Test Owner', address: '' }, owners: [], statementsFrom: '2026-09', statementsUntil: null, defaultFeeRateBasisPoints: null, defaultFee: null, setAt: '2026-10-01T00:00:00.000Z' };
function freeze(es, reports, draft, month, finishedAt) {
  const built = st.buildStatement({ propertyId: P, propertyName: 'Test Lakeview Loft', month, entries: es, reports, draft, management: record });
  if (built.kind !== 'ok') throw new Error('unreadable ' + built.entryIds);
  const s = { ...built.statement, draft: false };
  const bytes = statementPdf(s);
  const id = `TESTREPORT${String(++seq).padStart(10, '0')}`;
  return {
    report: {
      id, legacy: false, income: [], ownersAtFinish: [], schemaVersion: model.MONTHLY_REPORT_SCHEMA_VERSION, propertyId: P, propertyNameAtFinish: 'Test Lakeview Loft', month,
      reference: s.reference, reportDate: s.reportDate, reportFor: s.reportFor, lines: s.lines, costs: s.costs, adjustments: s.adjustments, fee: s.fee, carried: s.carried,
      incomeCents: s.incomeCents, expensesCents: s.expensesCents, recordedCents: s.recordedCents, costsCents: s.costsCents, feeCents: s.feeCents, totalCents: s.totalCents, carriedCents: s.carriedCents,
      payableCents: s.payableCents, pendingLeftOut: s.pendingLeftOut, notes: s.notes, entryIds: s.costs.map((row) => row.entryId), finishedAt, actor: ADMIN_ACTOR, supersedes: null, draftRevision: 1,
      pdf: { path: `monthly-reports/${id}.pdf`, bytes: bytes.length, sha256: sha(bytes) },
    },
    bytes,
  };
}
const rows = (statement) => st.printedLines(statement).map((l) => `      ${l.description} · ${l.quantity} · ${l.rateCents === null ? '(rate empty)' : $(l.rateCents)} · ${$(l.amountCents)}`).join('\n');

// ═══ 1. Equal amounts: one line ═══
console.log('═══ 1. September: three cleanings at $60.00, and a $56.50 receipt ═══');
const sep5 = cleaning('2026-09-05', 6000);
const sep12 = cleaning('2026-09-12', 6000);
const sep19 = cleaning('2026-09-19', 6000);
const receipt = {
  id: 'TESTENTRYreceipt0001', createdAt: '2026-09-10T15:00:00.000Z', status: 'approved', statusChangedAt: null, statusReason: null, history: [{ at: '2026-09-10T15:00:00.000Z', action: 'submitted', from: null, to: 'pending', actor: { role: 'cleaner', id: C, name: NAME }, reason: null, line: null, tax: null }, { at: '2026-09-10T15:00:00.000Z', action: 'approved', from: 'pending', to: 'approved', actor: ADMIN_ACTOR, reason: null, line: null, tax: null }],
  cleaner: { id: C, nameAtEntry: NAME, state: 'found', name: NAME, status: 'active' }, property: { id: P, nameAtEntry: 'Test Lakeview Loft', state: 'found', name: 'Test Lakeview Loft' }, purchasedOn: '2026-09-10', note: null, currency: 'CAD',
  lines: [{ name: 'Supplies', quantity: 1, lineTotalCents: 5000 }], linesNow: { kind: 'ok', lines: [{ index: 0, name: 'Supplies', quantity: 1, lineTotalCents: 5000, origin: 'sent', earlier: [] }], itemsCents: 5000, taxCents: 650, taxShape: 'field', totalCents: 5650, sentTotalCents: 5650, sentTaxCents: 650, corrected: false },
  receipts: [], taxShape: 'field', kind: 'receipt', autoApproved: null, month: null,
};
const sepEntries = [...entries([sep5, sep12, sep19]), receipt];
const sepBuilt = st.buildStatement({ propertyId: P, propertyName: 'Test Lakeview Loft', month: '2026-09', entries: sepEntries, reports: [], draft: draftOf('2026-09', [{ id: 'L-rev', description: 'Revenue', from: null, to: null, quantity: 1, rateCents: 200000, amountCents: 200000 }]), management: record });
console.log(`  printed rows:\n${rows(sepBuilt.statement)}`);
console.log(`  stored cost rows: ${sepBuilt.statement.costs.map((c) => `${c.kind} ${c.description} ${$(c.totalCents)}`).join(' | ')}`);
const sep = freeze(sepEntries, [], draftOf('2026-09', [{ id: 'L-rev', description: 'Revenue', from: null, to: null, quantity: 1, rateCents: 200000, amountCents: 200000 }]), '2026-09', '2026-10-05T14:00:00.000Z');
console.log(`  September finished: recorded ${$(sep.report.recordedCents)} · PDF holds "Expense - Cleaning": ${text(sep.bytes).includes('Expense - Cleaning')} · names the cleaner: ${text(sep.bytes).includes('Zelda')}`);

// ═══ 2. Differing amounts, a late cleaning, a change and a removal after printing ═══
console.log('\n═══ 2. October: cleanings at $60.00 and $80.00; a September cleaning logged after September was finished; one changed, one removed after printing ═══');
const oct3 = cleaning('2026-10-03', 6000);
const oct9 = cleaning('2026-10-09', 8000);
const sep28 = cleaning('2026-09-28', 7500); // logged 12 October, after September's statement
const sep5b = changed(sep5, '2026-10-12T15:00:00.000Z', 7000);
const sep12b = removed(sep12, '2026-10-12T15:05:00.000Z');
const octAll = [sep5b, sep12b, sep19, sep28, oct3, oct9];
const octBuilt = st.buildStatement({ propertyId: P, propertyName: 'Test Lakeview Loft', month: '2026-10', entries: [...entries(octAll), receipt], reports: [sep.report], draft: draftOf('2026-10'), management: record });
console.log(`  printed rows:\n${rows(octBuilt.statement)}`);
console.log(`  October's statement: recorded ${$(octBuilt.statement.recordedCents)} · total ${$(octBuilt.statement.totalCents)}`);
const octPdf = statementPdf({ ...octBuilt.statement, draft: false });
console.log(`  October's PDF names the cleaner: ${text(octPdf).includes('Zelda')} · prints an average of $70.00: ${text(octPdf).includes('-$70.00 ')}`);
const charges = money.costCharges({ propertyId: P, entries: [...entries(octAll), receipt], reports: [sep.report], management: record });
for (const c of [sep5b, sep12b, sep19, sep28, oct3, oct9]) console.log(`  charges ${c.day} ${c.status} ${$(c.amountCents)}: ${(charges.get(c.id) ?? []).map((x) => `${x.month}${x.reportId ? ' finished' : ' open'} ${x.kind} ${$(x.cents)}`).join(' | ')}`);
const sepMoney = money.monthMoney({ propertyId: P, propertyName: 'Test Lakeview Loft', month: '2026-09', entries: [...entries(octAll), receipt], reports: [sep.report], draft: null, management: record, charges });
console.log(`  September's Costs tab: ${sepMoney.costTotals.count} costs · ${$(sepMoney.costTotals.cents)} · by statement: ${sepMoney.costTotals.byStatement.map((r) => `${r.month}${r.finished ? '' : ' (open)'} ${$(r.cents)}`).join(' · ')}`);

// ═══ 3. A deleted cleaner's cleanings still read ═══
console.log('\n═══ 3. The cleaner deleted ═══');
const gone = view(oct3, 'missing');
console.log(`  read by: ${cl.cleanerNameOf(gone)} (state ${gone.cleaner.state}) · amount ${$(gone.amountCents)}`);
const octGone = st.buildStatement({ propertyId: P, propertyName: 'Test Lakeview Loft', month: '2026-10', entries: [...entries(octAll, 'missing'), receipt], reports: [sep.report], draft: draftOf('2026-10'), management: record });
console.log(`  October's statement unchanged: ${sha(statementPdf({ ...octGone.statement, draft: false })) === sha(octPdf)}`);

// ═══ 4. What an owner receives never names the cleaner ═══
console.log('\n═══ 4. Owners\' documents ═══');
const ledger = buildReport([...entries(octAll), receipt], P, '2026-09-01', '2026-10-31', new Date('2026-10-13T12:00:00Z'), 'Test Lakeview Loft', charges).report;
console.log(`  ledger: ${ledger.entries.map((e) => `${e.day} ${e.kind} ${e.cleaner} ${$(e.totalCents)}`).join(' | ')}`);
const ledgerPdf = pdfFor(ledger);
const ledgerXlsx = workbookFor(ledger);
const cleaningsOnly = buildReport(entries(octAll), P, '2026-09-01', '2026-10-31', new Date('2026-10-13T12:00:00Z'), 'Test Lakeview Loft', charges).report;
console.log(`  ledger PDF lists "Cleaning": ${text(ledgerPdf).includes('Cleaning')} · names the cleaner: ${text(ledgerPdf).includes('Zelda')}`);
console.log(`  ledger Excel of the cleanings alone names the cleaner: ${utf8(workbookFor(cleaningsOnly)).includes('Zelda')} · with the receipt, its "Logged by" names who sent it, as before 37B: ${utf8(ledgerXlsx).includes('Zelda')}`);
const onlyPdf = text(pdfFor(cleaningsOnly));
const pdfStrings = [...onlyPdf.matchAll(/\((.*?)\) Tj/g)].map((m) => m[1].replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8))).replace(/\\(.)/g, '$1'));
console.log(`  ledger PDF of the cleanings alone, the changed cleaning's split, line by line: ${pdfStrings.filter((t) => /statement \$|^On /.test(t)).map((t) => JSON.stringify(t)).join(' + ')}`);
console.log(`  its footnotes: ${pdfStrings.filter((t) => t.startsWith('* ')).map((t) => JSON.stringify(t)).join(' · ')}`);
const stored = (list) => list.map((c) => ({ id: c.id, stored: c }));
const receiptStored = { schemaVersion: 2, createdAt: receipt.createdAt, status: 'approved', statusChangedAt: null, statusReason: null, cleanerId: C, cleanerNameAtEntry: NAME, propertyId: P, propertyNameAtEntry: 'Test Lakeview Loft', purchasedOn: '2026-09-10', note: null, currency: 'CAD', kind: 'receipt', autoApproved: null, lines: [{ name: 'Supplies', quantity: 1, lineTotalCents: 5000 }], taxCents: 650, receipts: [], history: [{ at: receipt.createdAt, action: 'submitted', from: null, to: 'pending', actor: { role: 'cleaner', id: C, name: NAME }, reason: null }, { at: receipt.createdAt, action: 'approved', from: 'pending', to: 'approved', actor: ADMIN_ACTOR, reason: null }] };
for (const month of ['2026-09', '2026-10']) {
  const selection = selectMonthPackage({
    month, today: '2026-11-03', madeAt: '2026-11-03T16:00:00.000Z', properties: [{ id: P, name: 'Test Lakeview Loft', createdMonth: '2026-09' }],
    entries: [{ id: receipt.id, stored: receiptStored }], cleanings: stored(octAll), reports: [{ view: sep.report, stored: sep.report }], drafts: [], downloads: [], management: [{ view: record, stored: record }],
  });
  const objects = new Map([[statementKey(sep.report.id), sep.bytes]]);
  const pkg = await buildMonthPackage(selection.data, objects, async (bytes) => sha(bytes), 'download');
  const owners = pkg.files.filter((f) => f.path.startsWith('Properties/'));
  const nubnb = pkg.files.filter((f) => f.path.startsWith('Nubnb/'));
  console.log(`  ZIP ${month}: owner's folder ${owners.length} files, any naming the cleaner: ${owners.filter((f) => text(f.data).includes('Zelda')).map((f) => f.path).join(', ') || 'none'} · Nubnb's folder names them in: ${nubnb.filter((f) => text(f.data).includes('Zelda')).map((f) => f.path.split('/').pop()).join(', ')}`);
  const book = owners.find((f) => f.path.endsWith('.xlsx'));
  console.log(`    owner's workbook lists the cleanings: ${(utf8(book.data).match(/Cleaning · /g) ?? []).length} cleaning rows · says "Differs": ${utf8(book.data).includes('Differs')}`);
}

// ═══ 5. The amount a cleaning starts from ═══
console.log('\n═══ 5. The form\'s amount (Kian\'s ruling: last paid for the property, else the default rate) ═══');
const all = octAll.map((c) => view(c));
console.log(`  Zelda at this property: ${JSON.stringify(cl.suggestedAmount(all, C, P, 6500))}`);
console.log(`  Zelda at another property, default $65.00: ${JSON.stringify(cl.suggestedAmount(all, C, 'TESTPROPother0000001', 6500))}`);
console.log(`  someone with no default: ${JSON.stringify(cl.suggestedAmount(all, 'TESTCLEANERnobody001', P, null))}`);
console.log(`  the property's last cleaner: ${cl.lastCleanerOf(all, P)}`);
console.log(`  typed amounts: ${['60', '60.5', '60.50', '$75', '0', '-5', '10000', 'abc'].map((t) => `${t}→${cl.readAmountCents(t)}`).join(' ')}`);

// ═══ 6. Finish's checks ═══
console.log('\n═══ 6. Finish ═══');
const keys = (statement) => finishChecks({ statement, reports: [sep.report], entries: [], income: { waiting: 0, unlinked: [], checkouts: 4 }, today: '2026-11-03' }).warnings.map((w) => w.key).join(', ');
const bare = st.buildStatement({ propertyId: P, propertyName: 'Test Lakeview Loft', month: '2026-11', entries: [], reports: [sep.report], draft: draftOf('2026-11'), management: record }).statement;
console.log(`  4 checkouts, nothing logged: ${keys(bare)}`);
console.log(`  4 checkouts, October's cleanings logged: ${keys(octBuilt.statement)}`);
const typedToo = st.buildStatement({ propertyId: P, propertyName: 'Test Lakeview Loft', month: '2026-10', entries: entries(octAll), reports: [sep.report], draft: draftOf('2026-10', [{ id: 'L-clean', description: 'Expense - Cleaning', from: null, to: null, quantity: 2, rateCents: -6000, amountCents: -12000 }]), management: record }).statement;
console.log(`  a typed cleaning line beside logged cleanings: ${finishChecks({ statement: typedToo, reports: [sep.report], entries: [], income: { waiting: 0, unlinked: [], checkouts: 0 }, today: '2026-11-03' }).warnings.filter((w) => w.key.startsWith('cleaning')).map((w) => w.text).join(' | ')}`);

// ═══ 7. Owed months and empty months (M2) ═══
console.log('\n═══ 7. A month whose only money is a logged cleaning ═══');
const Q = 'TESTPROPonlycleaning';
const only = { ...cleaning('2026-10-14', 6000), propertyId: Q };
const onlyEntries = [cl.cleaningEntryView({ ...cl.readCleaning(only.id, only), cleaner: { state: 'found', name: NAME, status: 'active' }, property: { state: 'found', name: 'Test Only Cleaning' } })];
console.log(`  months with money: ${JSON.stringify([...st.moneyMonthsByProperty([], onlyEntries)])}`);
console.log(`  owed in October, the property added in November: ${model.inStatementScope(null, '2026-10', '2026-11', st.moneyMonthsByProperty([], onlyEntries).get(Q) ?? [])}`);
const empty = emptyMonth({ month: '2026-10', today: '2026-11-03', properties: [{ id: Q, name: 'Test Only Cleaning', createdMonth: '2026-09' }], management: [{ ...record, id: Q, propertyId: Q }], reports: [], drafts: [], entries: onlyEntries, income: { waiting: new Map(), checkInsWithout: new Set(), unsettled: [] } });
console.log(`  finish-empty list for October: eligible ${empty.eligible.length} · left out: ${empty.leftOut.map((r) => r.why).join(' | ')}`);

// ═══ 8. What the routes accept: the bodies the page sends ═══
console.log('\n═══ 8. The routes\' schemas, given what the page sends ═══');
const sc = await import(`${ROOT}/app/lib/cleanings/schemas.ts`);
const parse = (schema, body) => {
  const r = schema.safeParse(body);
  return r.success ? `ok ${JSON.stringify(r.data)}` : `refused: ${r.error.issues.map((i) => `${i.path.join('.') || '(body)'} ${i.message}`).join('; ')}`;
};
const log = { propertyId: P, cleanerId: C, day: '2026-09-05', amount: '60.00' };
console.log(`  log, no note typed (null): ${parse(sc.LogCleaningSchema, { ...log, note: null })}`);
console.log(`  log, note left out: ${parse(sc.LogCleaningSchema, log)}`);
console.log(`  log, a note: ${parse(sc.LogCleaningSchema, { ...log, note: '  Mid-stay   clean ' })}`);
console.log(`  log, "60": ${parse(sc.LogCleaningSchema, { ...log, amount: '60', note: null })}`);
console.log(`  log, "0.00": ${parse(sc.LogCleaningSchema, { ...log, amount: '0.00', note: null })}`);
console.log(`  log, an extra field: ${parse(sc.LogCleaningSchema, { ...log, note: null, rate: '60.00' })}`);
console.log(`  change the amount: ${parse(sc.ChangeCleaningSchema, { action: 'change', seen: 1, amount: '70.00', reason: null })}`);
console.log(`  clear the note: ${parse(sc.ChangeCleaningSchema, { action: 'change', seen: 2, note: null, reason: null })}`);
console.log(`  remove, no reason: ${parse(sc.ChangeCleaningSchema, { action: 'remove', seen: 2, reason: null })}`);
console.log(`  delete: ${parse(sc.DeleteCleaningSchema, { seen: 3 })}`);
console.log(`  a default rate: ${parse(sc.DefaultRateSchema, { defaultRate: '60.00' })} · none: ${parse(sc.DefaultRateSchema, { defaultRate: null })}`);
