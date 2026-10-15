// Team pay (Kian's rulings of 2026-10-15): the one function that works out what a team member earned, was paid and
// is owed (app/lib/pay/balance.ts), the payment as stored (model.ts) and what the routes accept (schemas.ts), through
// Nubnb's own pure code. Made-up data only: members "TESTMEMBER…", properties "Test …", admins "Test Admin" and
// "Second Admin". Nothing is read from or written to production.
//   node --import ./tests/tools/ts-hook.mjs tests/pay/balance.mjs
import { fileURLToPath } from 'node:url';

const ROOT = process.env.NUBNB_ROOT || fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const pay = await import(`${ROOT}/app/lib/pay/balance.ts`);
const pm = await import(`${ROOT}/app/lib/pay/model.ts`);
const schemas = await import(`${ROOT}/app/lib/pay/schemas.ts`);
const { formatCents: $, readLinesNow, SYSTEM_ACTOR } = await import(`${ROOT}/app/lib/cleaners/model.ts`);

const ANA = 'TESTMEMBERana0000001';
const BEN = 'TESTMEMBERben0000002';
const SAM = 'TESTMEMBERsam0000003';
const ADMIN = { role: 'admin', id: 'TESTADMIN0001', name: 'Test Admin' };
const SECOND = { role: 'admin', id: 'TESTADMIN0002', name: 'Second Admin' };
let seq = 0;
let failures = 0;
const check = (ok, label) => {
  if (!ok) failures += 1;
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${label}`);
};

// ─── Made-up records, as the pages read them ───
function cleaning(member, name, day, cents, property = 'Test Lakeview Loft') {
  const at = `${day}T20:00:00.000Z`;
  return { id: `TESTCLEANING${String(++seq).padStart(8, '0')}`, cleanerId: member, cleanerNameAtEntry: name, day, amountCents: cents, status: 'logged', history: [{ at, action: 'logged', actor: ADMIN, reason: null }], propertyNameAtEntry: property, property: { name: property }, createdAt: at };
}
const changeAmount = (c, at, cents) => ({ ...c, amountCents: cents, history: [...c.history, { at, action: 'changed', actor: ADMIN, reason: 'wrong amount', before: { amountCents: c.amountCents }, after: { amountCents: cents } }] });
const removeCleaning = (c, at) => ({ ...c, status: 'removed', history: [...c.history, { at, action: 'removed', actor: ADMIN, reason: null }] });
const giveCleaning = (c, at, to, toName) => ({ ...c, cleanerId: to, cleanerNameAtEntry: toName, history: [...c.history, { at, action: 'changed', actor: ADMIN, reason: 'wrong cleaner', before: { cleanerId: c.cleanerId, cleanerName: c.cleanerNameAtEntry }, after: { cleanerId: to, cleanerName: toName } }] });

const ev = (at, action, extra = {}) => ({ at, action, from: null, to: null, actor: ADMIN, reason: null, line: null, tax: null, ...extra });
const approve = (at, actor = ADMIN) => ev(at, 'approved', { from: 'pending', to: 'approved', actor });
const reject = (at, reason) => ev(at, 'rejected', { from: 'pending', to: 'rejected', reason });
const removeEntry = (at) => ev(at, 'removed', { from: 'approved', to: 'removed' });
const card = (at, to = 'nubnb-card') => ev(at, 'paid_with_changed', { from: to === 'nubnb-card' ? 'team-member' : 'nubnb-card', to });
const fixTax = (at, before, after) => ev(at, 'tax_corrected', { tax: { before, after } });

/** A receipt or work entry: its status, who paid and its total now all come from its history, as the server reads it. */
function entry(member, kind, sentAt, lines, taxCents, events = [], property = 'Test Cozy Pad') {
  const sender = { role: kind === 'work' ? 'handyman' : 'cleaner', id: member, name: 'Test Sender' };
  const history = [ev(sentAt, 'submitted', { to: 'pending', actor: sender }), ...events];
  const statusEvent = [...history].reverse().find((e) => ['submitted', 'approved', 'rejected', 'removed'].includes(e.action));
  const cardEvent = [...history].reverse().find((e) => e.action === 'paid_with_changed');
  return {
    id: `TESTENTRY${String(++seq).padStart(11, '0')}`,
    kind,
    status: statusEvent.to,
    statusReason: statusEvent.reason,
    createdAt: sentAt,
    month: null,
    paidWith: cardEvent ? cardEvent.to : 'team-member',
    lines,
    history,
    linesNow: readLinesNow(lines, history, { shape: 'field', cents: taxCents }),
    taxShape: 'field',
    cleaner: { id: member },
    property: { nameAtEntry: property, name: property },
  };
}
const line = (name, cents) => ({ name, quantity: 1, lineTotalCents: cents });

/** A payment, read back through the strict reader as the server reads one. */
function payment(member, name, day, cents, method, recordedAt, note = null) {
  const id = `TESTPAYMENT${String(++seq).padStart(9, '0')}`;
  const fields = { schemaVersion: 1, memberId: member, memberNameAtPayment: name, amountCents: cents, currency: 'CAD', day, method, note, status: 'recorded', recordedAt, recordedBy: ADMIN, deletedAt: null, deletedBy: null, history: [{ at: recordedAt, action: 'recorded', actor: ADMIN }] };
  const read = pm.readPayment(id, fields);
  if (!read) throw new Error(`not in shape: ${id}`);
  return read;
}
const deletePayment = (p, at, by = SECOND) => pm.readPayment(p.id, { ...p, status: 'deleted', deletedAt: at, deletedBy: by, history: [...p.history, { at, action: 'deleted', actor: by }] });

const money = (cents) => (cents === null ? '—' : $(cents));
function show(title, memberId, sources, range) {
  const r = pay.memberPay(memberId, sources, range);
  console.log(`── ${title}`);
  console.log(`   earned ${$(r.earnedCents)} (cleanings ${$(r.parts.cleaningsCents)}, receipts ${$(r.parts.receiptsCents)}, work ${$(r.parts.workCents)}) · paid ${$(r.paidCents)} · balance ${pay.balanceWords(r.balanceCents).words} [${pay.balanceWords(r.balanceCents).tone}] · waiting ${r.waiting} · cannot add up ${r.cannotAddUp}`);
  for (const row of r.rows) {
    console.log(`   ${row.day ?? 'no day'} · ${pay.rowItemWords(row)} · earned ${money(row.earnedCents)} · paid ${money(row.paidCents)} · amount ${money(row.amountCents)} · ${row.state}${row.note ? ` · ${row.note}` : ''}${row.amber ? ' · AMBER' : ''}`);
    for (const change of row.changes) console.log(`       ${pay.changeWords(change)} (owed ${$(change.owedBefore)} → ${$(change.owedAfter)})${change.afterPayment ? ` · after the payment of ${pay.dayWords(change.afterPayment.day)} [amber]` : ''}`);
  }
  if (r.range) console.log(`   in ${r.range.from || '…'} – ${r.range.to || '…'}: earned ${$(r.range.earnedCents)} · paid ${$(r.range.paidCents)} · balance at the start ${$(r.range.balanceBeforeCents)} · at the end ${$(r.range.balanceAtEndCents)}`);
  return r;
}

// ═══ The records: Ana and Ben clean, Sam is a handyman ═══
const c1 = cleaning(ANA, 'Ana Test', '2026-10-02', 6000);
const c2 = changeAmount(cleaning(ANA, 'Ana Test', '2026-10-05', 6000), '2026-10-22T15:00:00.000Z', 5500);
const c3 = cleaning(ANA, 'Ana Test', '2026-10-09', null, 'Test Bayview');
const c4 = removeCleaning(cleaning(ANA, 'Ana Test', '2026-10-10', 6000), '2026-10-22T15:05:00.000Z');
const c5 = giveCleaning(cleaning(ANA, 'Ana Test', '2026-10-03', 6000), '2026-10-04T13:00:00.000Z', BEN, 'Ben Test');
const c6 = changeAmount(cleaning(ANA, 'Ana Test', '2026-10-21', null), '2026-10-22T16:00:00.000Z', 6000);
// r1: approved automatically the instant it was sent — the entry being made, not a change.
const r1 = entry(ANA, 'receipt', '2026-10-06T15:00:00.000Z', [line('Cleaner', 2000), line('Sponges', 1820)], 500, [approve('2026-10-06T15:00:00.000Z', SYSTEM_ACTOR)]);
// r2: approved by an admin the next day, its tax corrected after the payment of Oct 20.
const r2 = entry(ANA, 'receipt', '2026-10-07T15:00:00.000Z', [line('Mop', 3000)], 0, [approve('2026-10-08T14:00:00.000Z'), fixTax('2026-10-23T14:00:00.000Z', 0, 390)]);
// r3: approved, then marked paid with Nubnb's card before any payment.
const r3 = entry(ANA, 'receipt', '2026-10-12T15:00:00.000Z', [line('Bulbs', 2500)], null, [approve('2026-10-12T18:00:00.000Z'), card('2026-10-14T14:00:00.000Z')], 'Test Loft');
const r4 = entry(ANA, 'receipt', '2026-10-13T15:00:00.000Z', [line('Vacuum', 25000)], null);
const r5 = entry(ANA, 'receipt', '2026-10-11T15:00:00.000Z', [line('Lunch', 4000)], null, [reject('2026-10-12T14:00:00.000Z', 'Not a work expense')]);
// r6: approved, marked paid with the card, then the mark taken off again.
const r6 = entry(ANA, 'receipt', '2026-10-01T15:00:00.000Z', [line('Gloves', 1200)], null, [approve('2026-10-01T18:00:00.000Z'), card('2026-10-02T14:00:00.000Z'), card('2026-10-02T14:05:00.000Z', 'team-member')]);
const p1 = payment(ANA, 'Ana Test', '2026-10-20', 15000, 'e-transfer', '2026-10-20T18:00:00.000Z', 'Oct 1–15');
const p2 = deletePayment(payment(ANA, 'Ana Test', '2026-10-06', 10000, 'cash', '2026-10-06T19:00:00.000Z'), '2026-10-07T13:00:00.000Z');

// r7: a receipt whose tax is not whole cents: it cannot add up.
const r7 = entry(BEN, 'receipt', '2026-10-14T15:00:00.000Z', [line('Soap', 800)], 12.5, [approve('2026-10-14T16:00:00.000Z')]);
const w1 = entry(SAM, 'work', '2026-10-08T15:00:00.000Z', [line('Fixed the sink', 12000)], null, [approve('2026-10-09T14:00:00.000Z')], 'Test Lakeview Loft');
const w2 = entry(SAM, 'work', '2026-10-11T15:00:00.000Z', [line('Painted the door', '12.5')], null, [approve('2026-10-12T14:00:00.000Z')]);
// After the payment of Oct 10, removed: it counted before, and that payment may have included it.
const w3 = entry(SAM, 'work', '2026-10-09T15:00:00.000Z', [line('Hung shelves', 3000)], null, [approve('2026-10-09T16:00:00.000Z'), removeEntry('2026-10-12T14:00:00.000Z')]);
const p3 = payment(SAM, 'Sam Test', '2026-10-10', 16000, 'other', '2026-10-10T18:00:00.000Z');
const office = { ...entry(ANA, 'office', '2026-10-05T15:00:00.000Z', [line('Office printer', 9000)], null, [approve('2026-10-05T15:00:00.000Z')]), kind: 'office' };

const sources = { cleanings: [c1, c2, c3, c4, c5, c6], entries: [r1, r2, r3, r4, r5, r6, r7, w1, w2, w3, office], payments: [p1, p2, p3] };

console.log('═══ 1. Ana, a cleaner: earned from cleanings and approved receipts, paid once, a deleted payment ═══');
const ana = show('Ana, all time', ANA, sources);
check(ana.earnedCents === 6000 + 5500 + 6000 + 4320 + 3390 + 1200, 'earned = cleanings $60.00 + $55.00 + $60.00 (amount typed later) + receipts $43.20 + $33.90 + $12.00');
check(ana.paidCents === 15000, 'paid = the recorded payment only; the deleted one does not count');
check(ana.balanceCents === ana.earnedCents - 15000 && pay.balanceWords(ana.balanceCents).tone === 'owed', 'balance = earned − paid, owed');
check(ana.rows.find((r) => r.id === r3.id).state === 'nubnb-card' && ana.rows.find((r) => r.id === r3.id).earnedCents === null, "the receipt paid with Nubnb's card is listed and not owed");
check(ana.rows.find((r) => r.id === r6.id).state === 'counts', 'a card mark taken off again: owed again');
check(['waiting', 'rejected', 'no-amount'].every((state) => ana.rows.some((r) => r.state === state && r.earnedCents === null)), 'a pending, a rejected and a no-amount item are listed and not counted');
check(ana.waiting === 2, 'waiting: the pending receipt and the cleaning with no amount');
check(ana.rows.find((r) => r.id === p2.id).state === 'deleted' && ana.rows.find((r) => r.id === p2.id).paidCents === null, 'the deleted payment is listed, not counted');
check(ana.rows.find((r) => r.id === c2.id).amber && ana.rows.find((r) => r.id === c4.id).amber && ana.rows.find((r) => r.id === r2.id).amber, 'changed, removed and corrected after the payment of Oct 20: amber');
check(!ana.rows.find((r) => r.id === r3.id).amber, "marked paid with the card before any payment: not amber");
check(!ana.rows.find((r) => r.id === c6.id).amber, 'an amount typed after a payment: not amber (it did not count before)');
check(!ana.rows.some((r) => r.id === office.id), 'an office entry is no one’s pay');
check(ana.rows.map((r) => r.day).join() === [...ana.rows.map((r) => r.day)].sort().reverse().join(), 'newest first');

console.log('\n═══ 2. A cleaning given to another cleaner, and a receipt that cannot add up ═══');
const ben = show('Ben, all time', BEN, sources);
check(ana.rows.find((r) => r.id === c5.id).state === 'moved' && ana.rows.find((r) => r.id === c5.id).earnedCents === null, "Ana's row: given to Ben, not counted");
check(ben.earnedCents === 6000 && ben.rows.find((r) => r.id === c5.id).state === 'counts', "Ben's row: his, counted");
check(ben.cannotAddUp === 1 && ben.rows.find((r) => r.id === r7.id).detail === null, 'a receipt that cannot add up: counted apart, no count of items');

console.log('\n═══ 3. Sam, a handyman: approved work, paid more than earned, an entry that cannot add up ═══');
const sam = show('Sam, all time', SAM, sources);
check(sam.earnedCents === 12000 && sam.parts.workCents === 12000, 'earned = the approved work');
check(sam.balanceCents === -4000 && pay.balanceWords(sam.balanceCents).words === '$40.00 overpaid' && pay.balanceWords(sam.balanceCents).tone === 'overpaid', 'overpaid $40.00');
check(sam.cannotAddUp === 1 && sam.rows.find((r) => r.id === w2.id).earnedCents === null, 'the entry that cannot add up is counted nowhere, and counted apart');
check(sam.rows.find((r) => r.id === w3.id).amber, 'work removed after the payment that may have included it: amber');

console.log('\n═══ 4. Dates: what fell in them, and the balance at their start and end ═══');
const inDates = (range) => {
  const r = pay.memberPay(ANA, sources, range).range;
  console.log(`   ${r.from || '…'} – ${r.to || '…'}: earned ${$(r.earnedCents)} · paid ${$(r.paidCents)} · balance at the start ${$(r.balanceBeforeCents)} · at the end ${$(r.balanceAtEndCents)}`);
  return r;
};
const first = inDates({ from: '2026-10-01', to: '2026-10-15' });
check(first.earnedCents === 6000 + 5500 + 4320 + 3390 + 1200 && first.paidCents === 0 && first.balanceBeforeCents === 0 && first.balanceAtEndCents === first.earnedCents, 'Oct 1 – 15: earned in it, nothing paid (the cash payment was deleted), from settled');
const second = inDates({ from: '2026-10-16', to: '2026-10-31' });
check(second.balanceBeforeCents === first.balanceAtEndCents && second.balanceAtEndCents === ana.balanceCents, "Oct 16 – 31 starts where Oct 1 – 15 ended and ends at today's balance");
const open = inDates({ from: '', to: '' });
check(open.earnedCents === ana.earnedCents && open.paidCents === ana.paidCents && open.balanceBeforeCents === 0 && open.balanceAtEndCents === ana.balanceCents, 'all time (both ends open): everything');
const upTo = inDates({ from: '', to: '2026-10-15' });
check(upTo.balanceAtEndCents === first.balanceAtEndCents, 'up to Oct 15 (start open): the same end');

console.log('\n═══ 5. Words ═══');
for (const cents of [24000, 0, -4000]) console.log(`   balance ${cents}: ${pay.balanceWords(cents).words} [${pay.balanceWords(cents).tone}]`);
console.log(`   ${pm.paymentWords(p1)}`);
console.log(`   ${pay.changeWords({ at: '2026-10-22T15:00:00.000Z', by: 'Test Admin', words: 'Changed: $60.00 → $55.00', owedBefore: 6000, owedAfter: 5500, afterPayment: null })}`);
console.log(`   ${pay.changeWords({ at: '2026-10-22T15:00:00.000Z', by: null, words: 'Removed', owedBefore: 6000, owedAfter: 0, afterPayment: null })}`);
console.log(`   ${pay.whenWords('2026-10-23T03:30:00.000Z')} (an instant late on Oct 22 in Toronto) · ${pay.whenWords(null)}`);

console.log('\n═══ 6. The day paid ═══');
for (const day of ['2026-10-15', '2026-10-16', '2025-10-15', '2025-10-14', '2026-02-30', '2026-1-5']) console.log(`   ${day}: ${pm.paymentDayProblem(day, '2026-10-15') ?? 'accepted'}`);
for (const today of ['2026-10-15', '2026-03-31', '2024-02-29']) console.log(`   earliest when today is ${today}: ${pm.earliestPaymentDay(today)}`);

console.log('\n═══ 7. The strict reader ═══');
const base = { schemaVersion: 1, memberId: ANA, memberNameAtPayment: 'Ana Test', amountCents: 100, currency: 'CAD', day: '2026-10-20', method: 'cash', note: null, status: 'recorded', recordedAt: '2026-10-20T18:00:00.000Z', recordedBy: ADMIN, deletedAt: null, deletedBy: null, history: [{ at: '2026-10-20T18:00:00.000Z', action: 'recorded', actor: ADMIN }] };
const cases = [
  ['as written', {}],
  ['deleted, with no time', { status: 'deleted', deletedBy: SECOND }],
  ['recorded, with a deleter', { deletedBy: SECOND }],
  ['$0.00', { amountCents: 0 }],
  ['$12.345', { amountCents: 12.345 }],
  ['a cheque', { method: 'cheque' }],
  ['no history', { history: [] }],
  ['a day not in yyyy-mm-dd', { day: '20 Oct' }],
];
for (const [label, change] of cases) console.log(`   ${label}: ${pm.readPayment('TESTPAYMENTstrict', { ...base, ...change }) ? 'read' : 'not in shape'}`);

console.log('\n═══ 8. What the routes accept ═══');
for (const amount of ['300.00', '0.50', '999999.99', '300', '0.00', '1000000.00', '01.00', '300.5', '-5.00']) {
  const parsed = schemas.PaymentAmountSchema.safeParse(amount);
  console.log(`   amount "${amount}": ${parsed.success ? `${parsed.data} cents` : 'refused'}`);
}
const request = { memberId: ANA, amount: '300.00', day: '2026-10-20', method: 'e-transfer' };
for (const [label, body] of [
  ['no note', request],
  ['a note with spaces', { ...request, note: '  Sept   pay ' }],
  ['a blank note', { ...request, note: '   ' }],
  ['a field beyond', { ...request, paidTo: 'someone' }],
  ['a cheque', { ...request, method: 'cheque' }],
  ['an ID with a slash', { ...request, memberId: 'a/b' }],
]) {
  const parsed = schemas.RecordPaymentSchema.safeParse(body);
  console.log(`   ${label}: ${parsed.success ? `accepted, note ${JSON.stringify(parsed.data.note)}` : 'refused'}`);
}

console.log(`\n${failures === 0 ? 'every check held' : `${failures} check(s) failed`}`);
if (failures > 0) process.exitCode = 1;
