// Direct payments (part B of PROPERTY-LIST-COLUMNS-PLAN.md, Kian's rulings of 2026-10-15): an arrangement's months
// (app/lib/direct/periods.ts) and its changes (changes.ts), a payment as the owner's statement prints it and where,
// the lock, the figures beside the fee's base, Finish's warning, the property list's Income column, and the
// readers and route schemas — through Nubnb's own pure code. Made-up data only: property "TESTPROP…", payer "Test
// Payer", admins "Test Admin" and "Second Admin". Nothing is read from or written to production.
//   node --import ./tests/tools/ts-hook.mjs tests/direct/payments.mjs
import { fileURLToPath } from 'node:url';

const ROOT = process.env.NUBNB_ROOT || fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const dm = await import(`${ROOT}/app/lib/direct/model.ts`);
const pr = await import(`${ROOT}/app/lib/direct/periods.ts`);
const ch = await import(`${ROOT}/app/lib/direct/changes.ts`);
const sc = await import(`${ROOT}/app/lib/direct/schemas.ts`);
const model = await import(`${ROOT}/app/lib/reports/model.ts`);
const st = await import(`${ROOT}/app/lib/reports/statement.ts`);
const { statementPdf } = await import(`${ROOT}/app/lib/reports/statement-pdf.ts`);
const { finishChecks } = await import(`${ROOT}/app/lib/reports/checks.ts`);
const money = await import(`${ROOT}/app/lib/money/month.ts`);
const income = await import(`${ROOT}/app/lib/income/standing.ts`);
const { formatCents: $ } = await import(`${ROOT}/app/lib/cleaners/model.ts`);

const P = 'TESTPROPdirect000001';
const ADMIN = { role: 'admin', id: 'TESTADMIN0001', name: 'Test Admin' };
const SECOND = { role: 'admin', id: 'TESTADMIN0002', name: 'Second Admin' };
let failures = 0;
const check = (ok, label) => {
  if (!ok) failures += 1;
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${label}`);
};
let seq = 0;
const hex = () => (++seq).toString(16).padStart(64, '0');
const pdfStrings = (bytes) =>
  [...Buffer.from(bytes).toString('latin1').matchAll(/\((.*?)\) Tj/g)].map((m) =>
    m[1]
      .replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)))
      .replace(/\\(.)/g, '$1')
      .replace(/\x96/g, '–')
      .replace(/\xb7/g, '·'),
  );

// ─── Made-up records, in the shapes the server writes ───
const at = (day) => `${day}T16:00:00.000Z`;
function arrangement(extra = {}) {
  const a = {
    schemaVersion: 1, propertyId: P, propertyNameAtStart: 'Test Lakeview Suite', payerName: 'Test Payer', wording: 'Monthly stay', dueDay: 20,
    fromMonth: '2026-08', untilMonth: null, amounts: [{ from: '2026-08', cents: 120_000 }], pauses: [], createdAt: at('2026-08-01'), createdBy: ADMIN,
    history: [{ at: at('2026-08-01'), action: 'started', actor: ADMIN, month: '2026-08', cents: 120_000 }], ...extra,
  };
  const read = dm.readArrangement('TESTARRANGE000000001', a);
  if (!read) throw new Error('arrangement not in shape');
  return read;
}
function payment(day, cents, extra = {}) {
  const id = hex();
  const p = {
    schemaVersion: 1, propertyId: P, propertyNameAtRecord: 'Test Lakeview Suite', arrangementId: 'TESTARRANGE000000001', purpose: 'monthly-stay', payerName: 'Test Payer', stay: null,
    day, amountCents: cents, currency: 'CAD', method: 'cash', wording: 'Monthly stay', note: null, appliesTo: null, status: 'recorded',
    recordedAt: at(day), recordedBy: ADMIN, removedAt: null, removedBy: null, history: [{ at: at(day), action: 'recorded', actor: ADMIN, appliesTo: null }], ...extra,
  };
  const read = dm.readDirectPayment(id, p);
  if (!read) throw new Error(`payment of ${day} not in shape`);
  return read;
}
const show = (months) =>
  months.periods.map((p) => `${p.month} ${pr.PERIOD_STATE_LABELS[p.state]} ${$(p.receivedCents)}/${$(p.expectedCents)}`).join(' · ') + ` · credit ${$(months.creditCents)}${months.nextMonth ? ` for ${months.nextMonth}` : ''} · ${months.status}`;

// ═══ 1. An arrangement's months ═══
console.log("═══ 1. An arrangement's months: $1,200.00 a month from August, due the 20th; today 2026-10-15 ═══");
const A = arrangement();
const p1 = payment('2026-09-05', 120_000);
const p2 = payment('2026-09-25', 60_000, { method: 'e-transfer' });
const p3 = payment('2026-10-03', 100_000);
const p4 = payment('2026-10-10', 100_000, { method: 'cheque' });
const TODAY = '2026-10-15';
const steps = [
  ['nothing received', []],
  ['Sep 5 · $1,200.00 cash', [p1]],
  ['Sep 25 · $600.00 e-transfer', [p1, p2]],
  ['Oct 3 · $1,000.00 cash', [p1, p2, p3]],
  ['Oct 10 · $1,000.00 cheque', [p1, p2, p3, p4]],
];
for (const [label, list] of steps) console.log(`  ${label.padEnd(30)} ${show(pr.arrangementMonths(A, list, TODAY))}`);
const after4 = pr.arrangementMonths(A, [p1, p2, p3, p4], TODAY);
check(after4.periods.map((p) => p.state).join(',') === 'paid,paid,paid', 'all three months paid after the fourth payment');
check(after4.creditCents === 20_000 && after4.nextMonth === '2026-11', 'the overpayment of $200.00 waits for November');
check(pr.arrangementMonths(A, [p1], TODAY).periods[0].paidBy[0].paymentId === p1.id, "Sep 5's payment pays August first: the oldest unpaid month");
const after3 = pr.arrangementMonths(A, [p1, p2, p3], TODAY);
check(after3.periods[2].state === 'partly' && after3.periods[1].state === 'paid', 'October partly paid before its due day; September paid by the oldest-first rule');
check(pr.arrangementMonths(A, [p1, p2], TODAY).periods[1].state === 'overdue', 'September with $600.00 of $1,200.00 after its due day is overdue');
check(pr.arrangementMonths(A, [p1, p2], '2026-09-20').periods[1].state === 'partly', 'on its due day itself it is still partly paid: overdue from the day after');
console.log(`  how the fourth payment was applied: ${dm.appliesToWords(after4.applied.get(p4.id).parts)} · credit ${$(after4.applied.get(p4.id).creditCents)}`);
// The months set by hand (changeable)
const pHand = payment('2026-10-12', 100_000, { appliesTo: [{ month: '2026-10', cents: 50_000 }, { month: '2026-11', cents: 50_000 }] });
const hand = pr.arrangementMonths(A, [p1, pHand], TODAY);
console.log(`  set by hand, Oct $500.00 + Nov $500.00:  ${show(hand)}`);
check(hand.periods.find((p) => p.month === '2026-10').receivedCents === 50_000 && hand.creditCents === 50_000, "a month set by hand is paid as set; November's part waits as credit until November is expected");
check(hand.periods.find((p) => p.month === '2026-09').receivedCents === 0, 'a payment set by hand pays no other month');

// ═══ 2. Its changes, each a step in its history with its admin ═══
console.log("\n═══ 2. Changes: pause, resume, change the amount, end ═══");
const step = (a, change, actor, label) => {
  const out = ch.changedArrangement(a, change, actor, at(TODAY), TODAY);
  if ('problem' in out) {
    console.log(`  ${label}: refused · ${out.problem}`);
    return null;
  }
  const next = dm.readArrangement(a.id, { ...a, ...out.next });
  const last = next.history[next.history.length - 1];
  console.log(`  ${label}: ${last.action} ${last.month}${last.cents ? ` ${$(last.cents)}` : ''} by ${last.actor.name} · pauses ${JSON.stringify(next.pauses)} · amounts ${next.amounts.map((x) => `${x.from} ${$(x.cents)}`).join(', ')} · until ${next.untilMonth}`);
  return next;
};
const B0 = arrangement({ fromMonth: '2026-10', amounts: [{ from: '2026-10', cents: 90_000 }], dueDay: 25, history: [{ at: at(TODAY), action: 'started', actor: ADMIN, month: '2026-10', cents: 90_000 }] });
console.log(`  started: ${show(pr.arrangementMonths(B0, [], TODAY))}`);
const B1 = step(B0, { action: 'pause', month: '2026-10' }, ADMIN, 'pause from October');
check(pr.arrangementMonths(B1, [], TODAY).status === 'paused' && pr.arrangementMonths(B1, [], TODAY).periods.length === 0, 'paused from October: nothing expected, status paused');
step(B1, { action: 'pause', month: '2026-11' }, ADMIN, 'pause again');
step(B1, { action: 'resume', month: '2026-10' }, ADMIN, 'resume from the month it paused');
const B2 = step(B1, { action: 'resume', month: '2026-11' }, SECOND, 'resume from November');
const B3 = step(B2, { action: 'amount', month: '2026-12', cents: 95_000 }, SECOND, 'amount from December');
step(B3, { action: 'amount', month: '2026-11', cents: 92_000 }, ADMIN, 'amount from November (before the last change)');
step(B3, { action: 'amount', month: '2027-01', cents: 95_000 }, ADMIN, 'the same amount again');
const B4 = step(B3, { action: 'end', month: '2027-02' }, ADMIN, 'end with February');
step(B4, { action: 'end', month: '2027-03' }, ADMIN, 'end twice');
step(B4, { action: 'pause', month: '2028-03' }, ADMIN, 'a month more than 12 away');
// A monthly stay of at least 30 nights (Kian's rulings: the short-stay threshold is 30 nights)
const Feb = arrangement({ fromMonth: '2027-02', amounts: [{ from: '2027-02', cents: 90_000 }], history: [{ at: at(TODAY), action: 'started', actor: ADMIN, month: '2027-02', cents: 90_000 }] });
step(Feb, { action: 'end', month: '2027-02' }, ADMIN, 'February 2027 alone (28 nights)');
const Sep1 = arrangement({ fromMonth: '2026-11', amounts: [{ from: '2026-11', cents: 90_000 }], history: [{ at: at(TODAY), action: 'started', actor: ADMIN, month: '2026-11', cents: 90_000 }] });
step(Sep1, { action: 'end', month: '2026-11' }, ADMIN, 'November 2026 alone (30 nights)');
check('problem' in ch.changedArrangement(Feb, { action: 'end', month: '2027-02' }, ADMIN, at(TODAY), TODAY) && !('problem' in ch.changedArrangement(Sep1, { action: 'end', month: '2026-11' }, ADMIN, at(TODAY), TODAY)), 'ended within one month: 28 nights refused, 30 accepted');
check(B4.history.map((h) => `${h.action}:${h.actor.name}`).join(',') === 'started:Test Admin,paused:Test Admin,resumed:Second Admin,amount-changed:Second Admin,ended:Test Admin', 'the history keeps every step and who took it');
check(pr.amountFor(B4, '2026-11') === 90_000 && pr.amountFor(B4, '2026-12') === 95_000, 'earlier months keep their amount; December on is $950.00');
check(pr.arrangementMonths(B4, [], '2027-06-01').periods.map((p) => p.month).join(',') === '2026-11,2026-12,2027-01,2027-02', 'months expected: November to February, October paused, nothing after the end');
check(pr.arrangementMonths(B4, [], '2027-06-01').status === 'ended', 'after February it is ended');

// ═══ 3. On the owner's statement ═══
console.log("\n═══ 3. The owner's statement: Kian's wording, the month received, the next open statement ═══");
const record = { id: P, schemaVersion: 3, propertyId: P, reportFor: { name: 'Test Owner', address: '' }, owners: [], statementsFrom: '2026-08', statementsUntil: null, defaultFeeRateBasisPoints: null, defaultFee: null, setAt: at('2026-08-01') };
const draftOf = (month, extra = {}) => ({ reference: `${model.monthReferenceWord(month)}-DIR`, reportDate: model.monthRange(model.addMonths(month, 1)).from, lines: [], fee: null, carried: null, notes: null, supersedes: null, ...extra });
function freeze(lines, reports, draft, month, finishedAt) {
  const built = st.buildStatement({ propertyId: P, propertyName: 'Test Lakeview Suite', month, entries: [], reports, draft, management: record, platformLines: lines });
  const s = { ...built.statement, draft: false };
  const id = `TESTREPORT${String(++seq).padStart(10, '0')}`;
  const report = {
    id, legacy: false, income: [], ownersAtFinish: [], schemaVersion: model.MONTHLY_REPORT_SCHEMA_VERSION, propertyId: P, propertyNameAtFinish: 'Test Lakeview Suite', month,
    reference: s.reference, reportDate: s.reportDate, reportFor: s.reportFor, lines: s.lines, costs: s.costs, adjustments: s.adjustments, fee: s.fee, carried: s.carried,
    incomeCents: s.incomeCents, expensesCents: s.expensesCents, recordedCents: s.recordedCents, costsCents: s.costsCents, feeCents: s.feeCents, totalCents: s.totalCents, carriedCents: s.carriedCents,
    payableCents: s.payableCents, pendingLeftOut: s.pendingLeftOut, notes: s.notes, entryIds: [], finishedAt, actor: ADMIN, supersedes: draft.supersedes ?? null, draftRevision: 1,
    pdf: { path: `monthly-reports/${id}.pdf`, bytes: 0, sha256: '' },
  };
  return { report: model.readMonthlyReport(id, report), statement: s, claim: built.claim };
}
const lines = dm.directLinesOf([p1, p2, p3, p4]);
const sepBuilt = st.buildStatement({ propertyId: P, propertyName: 'Test Lakeview Suite', month: '2026-09', entries: [], reports: [], draft: draftOf('2026-09'), management: record, platformLines: lines });
console.log(`  September, as it stands: ${sepBuilt.statement.lines.map((l) => `${l.description} ${$(l.amountCents)} (source ${l.source})`).join(' · ')}`);
check(sepBuilt.statement.lines.map((l) => l.description).join(' | ') === 'E-transfer - Monthly stay - received Sep 25 | Cash - Monthly stay - received Sep 5', "September prints its two payments in Kian's words, newest first");
check(JSON.stringify(sepBuilt.claim.platform.map((c) => c.seen)) === '[1,1]', "Finish's claim holds each payment and its history's length");
const sep = freeze(lines, [], draftOf('2026-09'), '2026-09', at('2026-10-05'));
const sepPdf = pdfStrings(statementPdf(sep.statement)).filter((t) => /received|Test Payer|Monthly stay/.test(t));
console.log(`  September's PDF prints: ${sepPdf.map((t) => JSON.stringify(t)).join(' · ')}`);
check(sepPdf.length === 2 && !sepPdf.some((t) => t.includes('Test Payer')), 'the PDF prints both payments and never the payer');
check(sep.report.lines.every((l) => l.source === 'direct' && dm.DIRECT_PAYMENT_ID.test(l.platformLineId)), 'the finished statement keeps each line with its payment');
// A September payment recorded after September was finished
const late = payment('2026-09-28', 30_000);
const lines2 = dm.directLinesOf([p1, p2, p3, p4, late]);
const octBuilt = st.buildStatement({ propertyId: P, propertyName: 'Test Lakeview Suite', month: '2026-10', entries: [], reports: [sep.report], draft: draftOf('2026-10'), management: record, platformLines: lines2 });
console.log(`  October, after September was finished: ${octBuilt.statement.lines.map((l) => l.description).join(' · ')}`);
check(octBuilt.statement.lines.some((l) => l.description === 'Cash - Monthly stay - received Sep 28'), "the late September payment is on October's statement, its day printed once, no \"(paid …)\"");
check(!sep.report.lines.some((l) => l.platformLineId === late.id), "September's finished statement is not touched");
// The lock
const printed = st.printedPlatformLines(model.currentReports([sep.report]));
check(printed.has(p1.id) && printed.has(p2.id) && !printed.has(late.id), 'Sep 5 and Sep 25 are printed on a finished statement (locked); Sep 28 is not');
const lateRemoved = dm.readDirectPayment(late.id, { ...late, status: 'removed', removedAt: at(TODAY), removedBy: SECOND, history: [...late.history, { at: at(TODAY), action: 'removed', actor: SECOND, appliesTo: null }] });
const octAfter = st.buildStatement({ propertyId: P, propertyName: 'Test Lakeview Suite', month: '2026-10', entries: [], reports: [sep.report], draft: draftOf('2026-10'), management: record, platformLines: dm.directLinesOf([p1, p2, p3, p4, lateRemoved]) });
check(!octAfter.statement.lines.some((l) => l.platformLineId === late.id) && octAfter.statement.incomeCents === octBuilt.statement.incomeCents - 30_000, 'a removed payment leaves the statement and its totals');
check(dm.directLineOf(lateRemoved) === null && lateRemoved.status === 'removed', 'removed, it is kept: read back whole, marked');
// Owed months (M2)
console.log(`  owed months: ${JSON.stringify([...st.moneyMonthsByProperty([], [], lines2)])}`);

// ═══ 4. The figures beside the fee's base, and Finish ═══
console.log("\n═══ 4. The revenue beside the fee's base, its check, and Finish's warning ═══");
const octFig = money.figuresOf(octBuilt.statement, new Set());
console.log(`  October's figures: revenue ${$(octFig.revenueCents)} · direct ${$(octFig.directCents)} · Airbnb ${$(octFig.airbnbCents)} · typed ${$(octFig.typedRevenueCents)}`);
check(octFig.directCents === 230_000 && octFig.revenueCents === 230_000, 'direct income is revenue, named apart from Airbnb');
const fee = st.feeFrom('NuBNB 20% Net of $1,000.00', 2000, 100_000, null);
const withFee = st.buildStatement({ propertyId: P, propertyName: 'Test Lakeview Suite', month: '2026-10', entries: [], reports: [sep.report], draft: draftOf('2026-10', { fee: { ...fee, baseRevenueCents: 100_000 } }), management: record, platformLines: lines2 });
const checks = finishChecks({ statement: withFee.statement, reports: [sep.report], entries: [], income: { waiting: 0, unlinked: [], checkouts: 0 }, today: TODAY, revenueCents: money.figuresOf(withFee.statement, new Set()).revenueCents, direct: pr.unpaidInMonth([A], [p1, p2, p3], '2026-10', TODAY) });
for (const w of checks.warnings) console.log(`    warns: ${w.text}`);
check(checks.warnings.some((w) => w.key === 'fee-base' && w.text.includes('$1,000.00') && w.text.includes('$2,300.00')), "the base check counts direct income: typed at $1,000.00 of revenue, now $2,300.00");
check(checks.warnings.some((w) => w.key === 'direct-0' && w.text.includes('$400.00 of $1,200.00')), "Finish warns: October's expected $1,200.00 has $400.00 received");
check(pr.unpaidInMonth([A], [p1, p2, p3, p4], '2026-10', TODAY).length === 0, 'once October is paid, no warning');

// ═══ 5. The property list's Income column ═══
console.log("\n═══ 5. The Income column's direct states ═══");
const col = (arrs, pays, today) => {
  const d = pr.directStanding(arrs, pays, today);
  const read = { month: '2026-09', uploaded: true, properties: {}, direct: d ? { [P]: d } : {} };
  const s = income.incomeStanding(read, P);
  return `${s.key} · "${s.label}" · ${s.tone} · ${s.month ?? '-'} · ${s.title}`;
};
const cases = [
  ['overdue', [A], [], TODAY],
  ['partly', [A], [p1, p2, p3], TODAY],
  ['paid', [A], [p1, p2, p3, p4], TODAY],
  ['expected', [B0], [], TODAY],
  ['paused', [B1], [], TODAY],
];
for (const [key, arrs, pays, today] of cases) {
  const line = col(arrs, pays, today);
  console.log(`  ${line}`);
  check(line.startsWith(`direct-${key}`), `direct-${key}`);
}
const both = income.incomeStanding({ month: '2026-09', uploaded: true, properties: { [P]: { activeTitle: true, review: 0, undecided: 0, missing: false, accepted: 2, acceptedCents: 50_000 } }, direct: { [P]: pr.directStanding([B0], [], TODAY) } }, P);
console.log(`  Airbnb Received beside direct Expected: ${both.key} · "${both.label}" · ${both.title}`);
check(both.key === 'received', 'green outranks plain: Airbnb Received shows, the tooltip names both');
const both2 = income.incomeStanding({ month: '2026-09', uploaded: true, properties: { [P]: { activeTitle: true, review: 0, undecided: 0, missing: false, accepted: 2, acceptedCents: 50_000 } }, direct: { [P]: pr.directStanding([A], [], TODAY) } }, P);
check(both2.key === 'direct-overdue' && both2.tone === 'problem', 'red outranks green: Overdue shows');

// ═══ 6. Readers and route schemas ═══
console.log("\n═══ 6. Readers and route schemas ═══");
check(model.readLine({ id: 'x', description: 'Cash - Monthly stay - received Oct 3', from: null, to: null, quantity: 1, rateCents: 100, amountCents: 100, source: 'direct' }) === null, 'a direct line without its payment is not a line');
check(dm.readDirectPayment(hex(), { ...p1, purpose: 'long-stay' }) === null, "an arrangement's payment is a monthly stay, never a one-off's purpose");
check(dm.readDirectPayment(hex(), { ...p1, appliesTo: [{ month: '2026-09', cents: 1 }] }) === null, 'months set by hand add up to the whole amount');
check(dm.readDirectPayment('TESTNOTHEX', p1) === null, 'an ID not 64 hex is refused');
const body = (extra = {}) => ({ propertyId: P, arrangementId: null, purpose: 'not-a-stay', day: '2026-10-12', amount: '75.00', method: 'cash', wording: 'Parking', ...extra });
const stay29 = { from: '2026-09-01', to: '2026-09-30' };
const stay30 = { from: '2026-09-01', to: '2026-10-01' };
const parse = (schema, b) => {
  const r = schema.safeParse(b);
  return r.success ? `ok ${JSON.stringify(r.data)}` : `refused: ${r.error.issues.map((i) => `${i.path.join('.') || '(body)'} ${i.message}`).join('; ')}`;
};
console.log(`  one-off, not a stay: ${parse(sc.RecordDirectPaymentSchema, body())}`);
console.log(`  one-off, a short stay: ${parse(sc.RecordDirectPaymentSchema, body({ purpose: 'short-stay' }))}`);
console.log(`  one-off with no purpose: ${parse(sc.RecordDirectPaymentSchema, body({ purpose: null }))}`);
console.log(`  arrangement with a purpose: ${parse(sc.RecordDirectPaymentSchema, body({ arrangementId: 'TESTARRANGE000000001' }))}`);
console.log(`  months not adding up: ${parse(sc.RecordDirectPaymentSchema, body({ arrangementId: 'TESTARRANGE000000001', purpose: null, appliesTo: [{ month: '2026-10', amount: '50.00' }] }))}`);
console.log(`  start: ${parse(sc.StartArrangementSchema, { propertyId: P, payerName: '  Test   Payer ', wording: 'Monthly stay', amount: '1200.00', dueDay: 29, fromMonth: '2026-10' })}`);
console.log(`  change amount: ${parse(sc.ChangeArrangementSchema, { action: 'amount', seen: 1, month: '2026-12', amount: '950.00' })}`);
check(!sc.RecordDirectPaymentSchema.safeParse(body({ purpose: 'short-stay' })).success, 'a direct short stay cannot be recorded (Kian: until his accountant confirms its tax treatment)');
console.log(`  a stay with no dates: ${parse(sc.RecordDirectPaymentSchema, body({ purpose: 'long-stay', wording: 'Stay' }))}`);
console.log(`  not a stay, with dates: ${parse(sc.RecordDirectPaymentSchema, body({ stay: stay30 }))}`);
console.log(`  the server's rule, 29 nights (Sep 1 – Sep 30): ${dm.shortStayProblem(stay29)}`);
console.log(`  the server's rule, 30 nights (Sep 1 – Oct 1): ${dm.shortStayProblem(stay30)}`);
check(dm.stayNights(stay29) === 29 && dm.shortStayProblem(stay29) !== null && dm.shortStayProblem(stay30) === null, 'the threshold is 30 nights (Kian): 29 refused, 30 accepted');
const oneOff = (stay) => dm.readDirectPayment(hex(), { ...p1, arrangementId: null, purpose: 'long-stay', payerName: 'Test Tenant', wording: 'Stay', stay });
check(oneOff(stay29) === null && oneOff(stay30) !== null && oneOff(null) === null, 'the reader keeps a one-off stay of 30 nights only, and never one without its dates');
check(dm.readDirectPayment(hex(), { ...p1, stay: stay30 }) === null, "an arrangement's payment has no stay of its own");
check(dm.DIRECT_PURPOSE_LABELS['long-stay'] === 'A stay of 30 nights or more' && dm.SHORT_STAY_WORDS.includes('under 30 nights'), 'the words the dialog shows say 30');

// ═══ 7. A finished statement holding a direct line, corrected ═══
console.log("\n═══ 7. A finished statement holding a direct line, corrected ═══");
const pStay = oneOff(stay30);
const pFee = dm.readDirectPayment(hex(), { ...p1, arrangementId: null, purpose: 'not-a-stay', payerName: null, wording: 'Parking', day: '2026-09-22', amountCents: 5_000 });
const linesC = dm.directLinesOf([pStay, pFee]);
const sepC = freeze(linesC, [], draftOf('2026-09'), '2026-09', at('2026-10-06'));
const printedC = (reports) => st.printedPlatformLines(model.currentReports(reports));
console.log(`  September finished: ${sepC.report.lines.map((l) => l.description).join(' · ')}`);
check(printedC([sepC.report]).has(pStay.id) && printedC([sepC.report]).has(pFee.id), 'both are printed: locked');
// The correction: a draft that supersedes it. The finished statement stays current (the owner's), while the draft rebuilds the month without it.
const corrDraft = draftOf('2026-09', { supersedes: { reportId: sepC.report.id, reason: 'Test correction' } });
const corrBuilt = st.buildStatement({ propertyId: P, propertyName: 'Test Lakeview Suite', month: '2026-09', entries: [], reports: [sepC.report], draft: corrDraft, management: record, platformLines: linesC });
console.log(`  the correction as it stands: ${corrBuilt.statement.lines.map((l) => l.description).join(' · ')}`);
check(JSON.stringify(corrBuilt.statement.lines.map((l) => [l.description, l.amountCents, l.platformLineId])) === JSON.stringify(sepC.report.lines.map((l) => [l.description, l.amountCents, l.platformLineId])), 'the correction holds the same direct lines, word for word');
const octDuring = st.buildStatement({ propertyId: P, propertyName: 'Test Lakeview Suite', month: '2026-10', entries: [], reports: [sepC.report], draft: draftOf('2026-10'), management: record, platformLines: linesC });
check(octDuring.statement.lines.length === 0, "while it is corrected, October's statement holds neither");
// Removed during the correction (the server's lock lifts while a draft supersedes the statement), then the correction finished.
const pFeeRemoved = dm.readDirectPayment(pFee.id, { ...pFee, status: 'removed', removedAt: at(TODAY), removedBy: SECOND, history: [...pFee.history, { at: at(TODAY), action: 'removed', actor: SECOND, appliesTo: null }] });
const linesC2 = dm.directLinesOf([pStay, pFeeRemoved]);
const corr = freeze(linesC2, [sepC.report], corrDraft, '2026-09', at('2026-10-07'));
const after = [sepC.report, corr.report];
console.log(`  corrected: ${corr.report.lines.map((l) => l.description).join(' · ')} · current ${model.currentReports(after).map((r) => r.id).join(', ')}`);
check(model.currentReports(after).length === 1 && model.currentReports(after)[0].id === corr.report.id, 'the corrected statement replaces the first');
const pdfLine = (s) => pdfStrings(statementPdf(s)).filter((t) => t.includes('received'));
console.log(`  first PDF: ${JSON.stringify(pdfLine(sepC.statement))} · corrected PDF: ${JSON.stringify(pdfLine(corr.statement))}`);
check(pdfLine(corr.statement).includes(pdfLine(sepC.statement).find((t) => t.startsWith('Cash - Stay'))), 'the stay line prints the same in the corrected PDF');
check(printedC(after).has(pStay.id) && !printedC(after).has(pFee.id), 'the stay is locked again, by the corrected statement; the removed one is on none');
const octAfterC = st.buildStatement({ propertyId: P, propertyName: 'Test Lakeview Suite', month: '2026-10', entries: [], reports: after, draft: draftOf('2026-10'), management: record, platformLines: linesC2 });
console.log(`  October after: ${octAfterC.statement.lines.length} lines · income ${$(octAfterC.statement.incomeCents)}`);
check(octAfterC.statement.lines.length === 0 && octAfterC.statement.incomeCents === 0, 'nothing is charged twice: October holds no September payment');
check(dm.receivedDayProblem('2026-10-16', TODAY) !== null && dm.receivedDayProblem('2025-10-14', TODAY) !== null && dm.receivedDayProblem('2025-10-15', TODAY) === null, 'a day received: never after today, at most 12 months back');

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`);
if (failures) process.exitCode = 1;
