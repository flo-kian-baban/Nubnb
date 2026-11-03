// Build 3 of the UX audit (Kian's rulings of 2026-11-02 and 2026-11-03): paydays on the 1st and the 15th (pay/payday.ts),
// what is due on each — counted and dated before it, decided by its day, minus payments — the person page's month figures
// and calendar (pay/month.ts), the questions before a payday's payment (pay/checks.ts), the counted-since instant on every
// pay row (pay/balance.ts), and the reads of a cleaner's History once it reads one month at a time, measured on the
// in-memory Firestore (tests/tools/memory-firestore.cjs) over a year of made-up cleanings and receipts: nothing is read
// from or written to Firestore or Storage, and every connection is refused. Made-up data only: members "TESTMEMBER…",
// properties "Test …", amounts with no production meaning (written with separators, never a real rate).
//   node --import ./tests/tools/ts-hook.mjs tests/pay/payday.mjs
import { createRequire } from 'node:module';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.NUBNB_ROOT || fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
createRequire(`${ROOT}/package.json`)(`${ROOT}/tests/tools/memory-firestore.cjs`);
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.FIREBASE_SERVICE_ACCOUNT_KEY = JSON.stringify({ type: 'service_account', project_id: 'memory-test', private_key_id: 'memory-test', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), client_email: 'memory-test@memory-test.iam.gserviceaccount.com', client_id: '0', token_uri: 'https://oauth2.invalid/token' });
process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = 'memory-test.appspot.com';
process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = 'memory-test';

const pay = await import(`${ROOT}/app/lib/pay/balance.ts`);
const pd = await import(`${ROOT}/app/lib/pay/payday.ts`);
const pm = await import(`${ROOT}/app/lib/pay/month.ts`);
const checks = await import(`${ROOT}/app/lib/pay/checks.ts`);
const home = await import(`${ROOT}/app/lib/cleaner-home.ts`);
const cl = await import(`${ROOT}/app/lib/firebase/server-cleanings.ts`);
const ce = await import(`${ROOT}/app/lib/firebase/server-cost-entries.ts`);
const sj = await import(`${ROOT}/app/lib/firebase/server-cleaning-jobs.ts`);
const { formatCents: $, readLinesNow } = await import(`${ROOT}/app/lib/cleaners/model.ts`);
const seed = globalThis.__memSeed;

let failures = 0;
const check = (ok, label) => {
  if (!ok) failures += 1;
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${label}`);
};
const ANA = 'TESTMEMBERana0000001';
const ADMIN = { role: 'admin', id: 'TESTADMIN0001', name: 'Test Admin' };
const CLEANER = { role: 'cleaner', id: ANA, name: 'Ana Test' };
let seq = 0;

// ─── Made-up records, as the pages read them (the shapes of tests/pay/balance.mjs) ───
/** A cleaning marked by the cleaner at `markedAt` (default: 19:00 UTC on its day), with its amount; `extra` an ask on it. */
function cleaning(day, cents, { markedAt = `${day}T19:00:00.000Z`, actor = CLEANER, extra = null, property = 'Test Lakeview Loft', jobId = `TESTPROP1_${day}` } = {}) {
  return { id: `TESTCLEANING${String(++seq).padStart(8, '0')}`, cleanerId: ANA, cleanerNameAtEntry: 'Ana Test', day, amountCents: cents, status: 'logged', history: [{ at: markedAt, action: 'logged', actor, reason: null }], propertyNameAtEntry: property, property: { name: property }, createdAt: markedAt, actor, extra, jobId };
}
const typeAmount = (c, at, cents) => ({ ...c, amountCents: cents, history: [...c.history, { at, action: 'changed', actor: ADMIN, reason: null, before: { amountCents: null }, after: { amountCents: cents } }] });
const decideExtra = (c, at, decision, cents = null) => ({ ...c, amountCents: cents ?? c.amountCents, extra: { ...c.extra, status: decision === 'approve' ? 'approved' : 'declined', decidedAt: at, decidedBy: ADMIN }, history: [...c.history, { at, action: decision === 'approve' ? 'extra-approved' : 'extra-declined', actor: ADMIN, reason: null, ...(cents !== null ? { before: { amountCents: c.amountCents }, after: { amountCents: cents } } : {}) }] });
const asked = (reason, at) => ({ status: 'asked', reason, askedAt: at, decidedAt: null, decidedBy: null });
const ev = (at, action, extra = {}) => ({ at, action, from: null, to: null, actor: ADMIN, reason: null, line: null, tax: null, ...extra });
const approve = (at) => ev(at, 'approved', { from: 'pending', to: 'approved' });
const card = (at, to = 'nubnb-card') => ev(at, 'paid_with_changed', { from: to === 'nubnb-card' ? 'team-member' : 'nubnb-card', to });
function entry(kind, sentAt, cents, events = [], property = 'Test Cozy Pad') {
  const sender = { role: kind === 'work' ? 'handyman' : 'cleaner', id: ANA, name: 'Ana Test' };
  const lines = [{ name: kind === 'work' ? 'Fixed the sink' : 'Supplies', quantity: 1, lineTotalCents: cents }];
  const history = [ev(sentAt, 'submitted', { to: 'pending', actor: sender }), ...events];
  const statusEvent = [...history].reverse().find((e) => ['submitted', 'approved', 'rejected', 'removed'].includes(e.action));
  const cardEvent = [...history].reverse().find((e) => e.action === 'paid_with_changed');
  return { id: `TESTENTRY${String(++seq).padStart(11, '0')}`, kind, status: statusEvent.to, statusReason: statusEvent.reason, createdAt: sentAt, month: null, paidWith: cardEvent ? cardEvent.to : 'team-member', lines, history, linesNow: readLinesNow(lines, history, { shape: 'field', cents: null }), taxShape: 'field', cleaner: { id: ANA }, property: { nameAtEntry: property, name: property } };
}
let pseq = 0;
const payment = (day, cents, recordedAt = `${day}T21:00:00.000Z`) => ({ id: `TESTPAYMENT${String(++pseq).padStart(9, '0')}`, schemaVersion: 1, memberId: ANA, memberNameAtPayment: 'Ana Test', amountCents: cents, currency: 'CAD', day, method: 'e-transfer', note: null, status: 'recorded', recordedAt, recordedBy: ADMIN, deletedAt: null, deletedBy: null, history: [{ at: recordedAt, action: 'recorded', actor: ADMIN }] });
const rowsOf = (cleanings, entries, payments) => pay.memberPay(ANA, { cleanings, entries, payments }).rows;

// ═══ 1. The paydays ═══
console.log('═══ 1. Paydays: the 1st and the 15th; the next one, the one just passed or today, and what each covers ═══');
for (const today of ['2028-11-01', '2028-11-02', '2028-11-14', '2028-11-15', '2028-11-16', '2028-11-30', '2028-12-01', '2028-02-29']) {
  console.log(`  today ${today}: next ${pd.nextPayday(today)} (covers up to ${pd.cutoffOf(pd.nextPayday(today))}) · just passed or today ${pd.lastPayday(today)} (covers up to ${pd.cutoffOf(pd.lastPayday(today))})`);
}
check(pd.nextPayday('2028-11-14') === '2028-11-15' && pd.nextPayday('2028-11-15') === '2028-11-15' && pd.nextPayday('2028-11-16') === '2028-12-01' && pd.nextPayday('2028-12-01') === '2028-12-01', 'the next payday is the first 1st or 15th on or after today');
check(pd.lastPayday('2028-11-14') === '2028-11-01' && pd.lastPayday('2028-11-15') === '2028-11-15' && pd.lastPayday('2028-11-16') === '2028-11-15' && pd.lastPayday('2028-11-01') === '2028-11-01' && pd.lastPayday('2028-12-01') === '2028-12-01', 'the payday just passed or today');
check(pd.cutoffOf('2028-11-15') === '2028-11-14' && pd.cutoffOf('2028-12-01') === '2028-11-30' && pd.cutoffOf('2028-03-01') === '2028-02-29', 'the 15th covers up to the 14th; the 1st up to the last day of the month before');

// ═══ 2. The cutoffs ═══
console.log('\n═══ 2. Cutoffs: the 14th is in the 15th\'s due, the 15th is not; the 31st is in the 1st\'s; a receipt sent on the 10th and approved on the 16th joins the next payday ═══');
const c31 = cleaning('2028-10-31', 6_100);
const c14 = cleaning('2028-11-14', 6_100);
const c15 = cleaning('2028-11-15', 6_100);
const r10late = entry('receipt', '2028-11-10T15:00:00.000Z', 21_234, [approve('2028-11-16T14:00:00.000Z')]);
const r10onDay = entry('receipt', '2028-11-10T16:00:00.000Z', 4_520, [approve('2028-11-15T14:00:00.000Z')]);
const p1 = payment('2028-11-01', 6_100);
const rows2 = rowsOf([c31, c14, c15], [r10late, r10onDay], [p1]);
const show = (label, due) => console.log(`  ${label}: earned ${$(due.earnedCents)} · paid ${$(due.paidCents)} · due ${$(due.dueCents)} (covers up to ${due.cutoff})`);
const nov1 = pd.dueOn('2028-11-01', rows2, pd.cutoffOf('2028-11-01'));
show('due on Nov 1, as that morning (payments before it)', nov1);
check(nov1.earnedCents === 6_100 && nov1.paidCents === 0 && nov1.dueCents === 6_100, 'the cleaning of Oct 31 is in Nov 1\'s due');
const nov15 = pd.dueOn('2028-11-15', rows2);
show('due on Nov 15, now (every payment)', nov15);
check(nov15.earnedCents === 6_100 + 6_100 + 4_520 && nov15.paidCents === 6_100 && nov15.dueCents === 6_100 + 4_520, 'Oct 31 and Nov 14 are in; Nov 15 is not; the receipt approved on the 15th is in; the one approved on the 16th is not (decided late)');
check(rows2.filter((r) => pd.inPayday(r, '2028-11-15')).map((r) => r.id).sort().join() === [c31.id, c14.id, r10onDay.id].sort().join(), 'inPayday names exactly those three');
const dec1 = pd.dueOn('2028-12-01', rows2);
show('due on Dec 1, now', dec1);
check(dec1.earnedCents === 6_100 * 3 + 4_520 + 21_234 && dec1.dueCents === dec1.earnedCents - 6_100, 'Dec 1 holds everything dated through Nov 30, the late-approved receipt included');
console.log(`  counted since: Oct 31 ${rows2.find((r) => r.id === c31.id).countedAt} · receipt approved late ${rows2.find((r) => r.id === r10late.id).countedAt} · receipt approved on the day ${rows2.find((r) => r.id === r10onDay.id).countedAt}`);
check(pd.countedDayOf(rows2.find((r) => r.id === r10late.id)) === '2028-11-16' && pd.countedDayOf(rows2.find((r) => r.id === r10onDay.id)) === '2028-11-15' && pd.countedDayOf(rows2.find((r) => r.id === c31.id)) === '2028-10-31', 'each row says the Toronto day it started counting');

// ═══ 3. Pay on the 15th, then the 1st ═══
console.log('\n═══ 3. Pay on the 15th, then the 1st: balances, Settled, Paid ahead ═══');
const words = (rows, today) => {
  const balance = rows.reduce((n, r) => n + (r.earnedCents ?? 0) - (r.paidCents ?? 0), 0);
  const next = pd.nextPayday(today);
  const last = pd.lastPayday(today);
  const dueNext = pd.dueOn(next, rows);
  const dueLast = pd.dueOn(last, rows);
  return { balance, next, last, dueNext, dueLast, head: pd.dueWords(dueNext.dueCents, balance), fill: dueLast.dueCents > 0 ? $(dueLast.dueCents) : '(empty)' };
};
// On the 15th the receipt sent on the 10th is still pending (it is approved on the 16th).
const r10pending = entry('receipt', '2028-11-10T15:00:00.000Z', 21_234);
let state = words(rowsOf([c31, c14, c15], [r10pending, r10onDay], [p1]), '2028-11-15');
console.log(`  Nov 15 before paying: Owed now ${pay.balanceWords(state.balance).words} · Due on ${state.next}: ${state.head.words} · Pay fills "due on ${state.last}": ${state.fill}`);
check(state.head.words === $(10_620) && state.fill === $(10_620) && state.balance === 6_100 * 2 + 4_520, 'on the 15th the head and the Pay box both read what the 15th covers; Owed now holds the 15th\'s cleaning too');
const paid15 = payment('2028-11-15', 10_620, '2028-11-15T18:00:00.000Z');
state = words(rowsOf([c31, c14, c15], [r10pending, r10onDay], [p1, paid15]), '2028-11-15');
console.log(`  Nov 15 after paying ${$(10_620)}: Owed now ${pay.balanceWords(state.balance).words} · Due on ${state.next}: ${state.head.words} · Pay fills: ${state.fill}`);
check(state.head.words === 'Settled' && state.fill === '(empty)' && state.balance === 6_100, 'paid: the 15th reads Settled, the Pay box empties, Owed now is the cleaning of the 15th');
// On the 16th the receipt is approved: it counts from then.
const rows3 = rowsOf([c31, c14, c15], [r10late, r10onDay], [p1, paid15]);
state = words(rows3, '2028-11-20');
console.log(`  Nov 20 (the receipt approved on the 16th now counts): Owed now ${pay.balanceWords(state.balance).words} · Due on ${state.next}: ${state.head.words} · Pay fills "due on ${state.last}": ${state.fill}`);
check(state.head.words === $(6_100 + 21_234) && state.fill === '(empty)' && state.balance === 6_100 + 21_234, 'the late receipt joins Dec 1, not Nov 15: the Pay box stays empty for Nov 15');
state = words(rows3, '2028-12-01');
console.log(`  Dec 1: Due on ${state.next}: ${state.head.words} · Pay fills "due on ${state.last}": ${state.fill}`);
check(state.fill === $(27_334) && state.head.words === $(27_334), 'on Dec 1 the Pay box fills with everything dated through Nov 30 that is not paid');
const paidDec = payment('2028-12-01', 27_334, '2028-12-01T16:00:00.000Z');
const ahead = payment('2028-12-01', 5_000, '2028-12-01T16:05:00.000Z');
const rows4 = rowsOf([c31, c14, c15], [r10late, r10onDay], [p1, paid15, paidDec]);
state = words(rows4, '2028-12-01');
console.log(`  Dec 1 after paying ${$(27_334)}: Owed now ${pay.balanceWords(state.balance).words} · Due on Dec 1: ${state.head.words}`);
check(state.head.words === 'Settled' && state.balance === 0, 'Settled on both counts');
const rows5 = rowsOf([c31, c14, c15], [r10late, r10onDay], [p1, paid15, paidDec, ahead]);
state = words(rows5, '2028-12-01');
console.log(`  Dec 1 after ${$(5_000)} more: Owed now ${pay.balanceWords(state.balance).words} · Due on Dec 1: ${state.head.words} [${state.head.tone}]`);
check(state.head.words === `Paid ahead ${$(5_000)}` && state.head.tone === 'ahead' && pay.balanceWords(state.balance).words === `Paid ahead ${$(5_000)}`, 'a payment past what is owed reads Paid ahead');
const markers = pd.paydayMarkers('2028-11', rows5, '2028-12-01');
console.log(`  November's markers (seen from Dec 1): ${markers.map((m) => `${m.payday} ${m.past ? 'was due' : 'due'} ${$(m.dueCents)}`).join(' · ')}`);
check(markers[0].dueCents === 6_100 && markers[1].dueCents === 10_620 && markers.every((m) => m.past), 'the calendar marks each past payday with what was due that morning');

// ═══ 4. The questions before Pay ═══
console.log('\n═══ 4. Before Pay: asked once when something dated before the payday still needs an amount or a decision; "Pay $X ahead?" ═══');
const cNoAmount = cleaning('2028-11-12', null);
const cNoted = cleaning('2028-11-13', 6_100, { extra: asked('Very dirty', '2028-11-13T19:00:00.000Z') });
const rPending = entry('receipt', '2028-11-11T15:00:00.000Z', 21_234);
const rows6 = rowsOf([c14, cNoAmount, cNoted], [rPending], []);
const q = (question) => `"${question.title}" / ${question.lines.join(' / ')} / [${question.confirm}]`;
const qs = checks.paydayQuestions(rows6, '2028-11-15', 'Nov 15', { balanceCents: 6_100 }, 6_100, 'Ana Test');
for (const question of qs) console.log(`  ${q(question)}`);
check(qs.length === 1 && qs[0].title.includes('still needs you') && qs[0].lines[0].includes('1 cleaning needs an amount') && qs[0].lines[0].includes('1 cleaning with a note needs a decision') && qs[0].lines[0].includes('1 receipt or work entry needs a decision') && qs[0].confirm === 'Pay anyway', 'one question, naming the three, before the payday');
const qs2 = checks.paydayQuestions(rows6, '2028-11-15', 'Nov 15', { balanceCents: 6_100 }, 9_100, 'Ana Test');
for (const question of qs2) console.log(`  ${q(question)}`);
check(qs2.length === 2 && qs2[1].title === `Pay ${$(3_000)} ahead?` && qs2[1].confirm === 'Pay ahead', 'then K2 when the payment is larger than the balance');
const qs3 = checks.paydayQuestions(rowsOf([c14, cleaning('2028-11-16', null)], [], []), '2028-11-15', 'Nov 15', { balanceCents: 6_100 }, 6_100, 'Ana Test');
check(qs3.length === 0, 'a cleaning dated after the payday that needs an amount asks nothing for this payday');

// ═══ 5. Counted since, on every kind of row ═══
console.log('\n═══ 5. Counted since: logged with an amount; typed later; a note declined; approved; the card toggled ═══');
const cTyped = typeAmount(cleaning('2028-11-05', null), '2028-11-18T15:00:00.000Z', 5_300);
const cDeclined = decideExtra(cleaning('2028-11-13', 6_100, { extra: asked('Very dirty', '2028-11-13T19:00:00.000Z') }), '2028-11-16T15:00:00.000Z', 'decline');
const cApproved = decideExtra(cleaning('2028-11-13', 6_100, { extra: asked('Very dirty', '2028-11-13T19:00:00.000Z') }), '2028-11-16T15:30:00.000Z', 'approve', 7_100);
const rCard = entry('receipt', '2028-11-08T15:00:00.000Z', 4_520, [approve('2028-11-08T15:00:00.000Z'), card('2028-11-09T12:00:00.000Z'), card('2028-11-10T12:00:00.000Z', 'team-member')]);
const rCardStill = entry('receipt', '2028-11-08T16:00:00.000Z', 4_520, [approve('2028-11-08T16:00:00.000Z'), card('2028-11-09T12:00:00.000Z')]);
const rows7 = rowsOf([cTyped, cDeclined, cApproved, c14], [rCard, rCardStill], []);
for (const row of rows7) console.log(`  ${row.day} ${row.kind} ${row.state} · earned ${row.earnedCents === null ? '—' : $(row.earnedCents)} · counted since ${row.countedAt ?? 'not counting'}`);
const by = (id) => rows7.find((r) => r.id === id);
check(by(cTyped.id).countedAt === '2028-11-18T15:00:00.000Z' && by(cDeclined.id).countedAt === '2028-11-16T15:00:00.000Z' && by(cApproved.id).countedAt === '2028-11-16T15:30:00.000Z' && by(cApproved.id).earnedCents === 7_100 && by(c14.id).countedAt === '2028-11-14T19:00:00.000Z', 'a cleaning counts from its amount, its decision, or its mark');
check(by(rCard.id).countedAt === '2028-11-10T12:00:00.000Z' && by(rCardStill.id).countedAt === null && by(rCardStill.id).state === 'nubnb-card', 'a receipt counts again from the card mark taken off; one still on the card counts from nothing');

// ═══ 6. The month: figures and calendar ═══
console.log('\n═══ 6. The month\'s figures and the calendar (November 2028, seen from Nov 18) ═══');
const TODAY = '2028-11-18';
const cLater = cleaning('2028-11-05', 6_100, { markedAt: '2028-11-06T13:00:00.000Z' }); // marked the day after
const cOffice = cleaning('2028-11-07', 6_100, { actor: ADMIN, jobId: null });              // logged by hand
const cNov14 = cleaning('2028-11-14', 6_100);
const cNov15 = cleaning('2028-11-15', 6_100);
const cNoted2 = cleaning('2028-11-13', 6_100, { extra: asked('Very dirty', '2028-11-13T19:00:00.000Z') });
const cNoAmount2 = cleaning('2028-11-12', null, { property: 'Test Bayview', jobId: 'TESTPROP2_2028-11-12' });
const cOct = cleaning('2028-10-31', 6_100);
const rNov = entry('receipt', '2028-11-11T15:00:00.000Z', 4_520, [approve('2028-11-11T15:00:00.000Z')]);
const rCardNov = entry('receipt', '2028-11-09T15:00:00.000Z', 2_000, [approve('2028-11-09T15:00:00.000Z'), card('2028-11-09T16:00:00.000Z')]);
const wNov = entry('work', '2028-11-08T15:00:00.000Z', 12_000, [approve('2028-11-08T15:00:00.000Z')]);
const pNov1 = payment('2028-11-01', 6_100);
const pNov15 = payment('2028-11-15', 16_720, '2028-11-15T18:00:00.000Z');
const monthCleanings = [cLater, cOffice, cNov14, cNov15, cNoted2, cNoAmount2, cOct];
const rowsM = rowsOf(monthCleanings, [rNov, rCardNov, wNov], [pNov1, pNov15]);
const job = (day, c, extra = {}) => ({ id: `TESTPROP1_${day}`, propertyId: 'TESTPROP1', propertyName: '14 Sample St', checkout: day, label: null, origin: 'calendar', status: 'open', change: null, markedAt: c ? c.createdAt : null, cleaningId: c ? c.id : null, removedAt: null, note: c?.extra?.reason ?? null, extraAsked: !!c?.extra, amountCents: null, ...extra });
const jobs = [job('2028-11-05', cLater), job('2028-11-14', cNov14), job('2028-11-15', cNov15), job('2028-11-13', cNoted2), { ...job('2028-11-12', cNoAmount2), id: 'TESTPROP2_2028-11-12', propertyId: 'TESTPROP2', propertyName: '88 Example Ave' }, job('2028-11-09', null), job('2028-11-20', null), job('2028-11-28', null, { label: 'Deep clean', origin: 'admin' })];
const s = pm.monthSummary('2028-11', rowsM, monthCleanings, jobs, TODAY);
console.log(`  ${pm.jobsWords(s)} · notes sent ${s.notesSent}`);
console.log(`  cleanings counted ${$(s.cleanings.cents)} (${s.cleanings.count}, ${s.cleanings.averageCents === null ? 'no average' : `${$(s.cleanings.averageCents)} per cleaning`}) · receipts approved ${$(s.receipts.cents)} (${s.receipts.count}; on Nubnb's card ${$(s.receipts.cardCents)}) · work approved ${$(s.work.cents)} (${s.work.count}) · paid in the month ${$(s.paidCents)} · owed at month end ${$(s.owedAtEndCents)}`);
check(s.jobsDone === 6 && s.markedOnDay === 4 && s.markedLater === 1 && s.byOffice === 1 && s.notMarked === 1 && s.notesSent === 1, 'jobs done 6: 4 on the day, 1 later, 1 by the office; 1 Not marked (Nov 9; Nov 20 and 28 are ahead); 1 note sent');
check(s.cleanings.cents === 6_100 * 4 && s.cleanings.count === 4 && s.cleanings.averageCents === 6_100, 'four cleanings count (the one with no amount and the noted one do not): the average is their mean');
check(s.receipts.cents === 4_520 && s.receipts.count === 1 && s.receipts.cardCents === 2_000 && s.work.cents === 12_000 && s.work.count === 1, 'receipts approved $45.20 with $20.00 more on the card, not owed; work $120.00');
check(s.paidCents === 6_100 + 16_720 && s.owedAtEndCents === 6_100 * 5 + 4_520 + 12_000 - 6_100 - 16_720, 'paid in the month, and the running balance at Nov 30 (payments dated through it)');
const weeks = pm.calendarWeeks('2028-11');
console.log(`  November 2028: ${weeks.length} weeks, first row ${weeks[0].join(' ')}, last row ${weeks[weeks.length - 1].join(' ')}`);
check(weeks.length === 5 && weeks[0][0] === '2028-10-29' && weeks[0][3] === '2028-11-01' && weeks[4][6] === '2028-12-02', 'the grid starts on the Sunday before the 1st (a Wednesday) and ends on the Saturday after the 30th');
const cal = pm.calendarOf('2028-11', rowsM, jobs, TODAY).flat();
const dayOf = (day) => cal.find((d) => d.day === day);
const line = (item) => `${item.words} · ${item.state}${item.amountCents !== null && item.kind !== 'payday' && item.kind !== 'payment' ? ` · ${$(item.amountCents)}` : ''} [${item.tone}]`;
for (const day of ['2028-11-01', '2028-11-05', '2028-11-07', '2028-11-09', '2028-11-11', '2028-11-12', '2028-11-13', '2028-11-15', '2028-11-20', '2028-11-28']) console.log(`  ${day}${dayOf(day).isToday ? ' (today)' : ''}: ${dayOf(day).items.map(line).join(' | ') || 'nothing'}`);
check(dayOf('2028-11-01').items[0].kind === 'payday' && dayOf('2028-11-01').items[0].state === `was due ${$(6_100)}` && dayOf('2028-11-01').items[1].kind === 'payment', 'Nov 1: the payday first (what was due that morning), then the payment');
check(dayOf('2028-11-09').items.some((i) => i.kind === 'job' && i.state === 'Not marked' && i.tone === 'alert') && dayOf('2028-11-20').items.some((i) => i.kind === 'job' && i.state === 'Assigned'), 'a past unmarked job reads Not marked, one ahead Assigned');
check(dayOf('2028-11-12').items.some((i) => i.kind === 'job' && i.state === 'Done · Needs an amount') && dayOf('2028-11-13').items.some((i) => i.kind === 'job' && i.state === 'Done · Needs a decision'), 'a done job carries its cleaning\'s need');
check(dayOf('2028-11-07').items.some((i) => i.kind === 'cleaning' && i.words.includes('Cleaning') && i.state === 'Done') && dayOf('2028-11-28').items.some((i) => i.words.endsWith('Deep clean')), 'a cleaning logged by hand stands on its own; an added job shows its label');
check(dayOf('2028-11-15').items[0].kind === 'payday' && dayOf('2028-11-15').items[0].state === `was due ${$(34_820)}` && dayOf('2028-11-15').items.some((i) => i.kind === 'payment' && i.state === `Paid ${$(16_720)}`), 'Nov 15: what was due that morning (everything counted and dated before it, minus the Nov 1 payment), the payment that day beside it');
check(cal.filter((d) => !d.inMonth).length === 5 && cal.find((d) => d.day === TODAY).isToday, 'five days outside the month fill the edges; today is marked');

// ═══ 7. History reads one month at a time: a year of made-up cleanings and receipts, read before and after ═══
console.log('\n═══ 7. The cleaner app\'s History: reads per open over a year of data, all of it (before) against one month (after) ═══');
const HIST = 'TESTCLEANERhistory01';
let n = 0;
for (let i = 0; i < 365; i += 1) {
  const day = new Date(Date.UTC(2027, 10, 19 + i)).toISOString().slice(0, 10);
  for (let k = 0; k < 2; k += 1) {
    seed('cleanings', `TESTHISTCLEANING${String(++n).padStart(4, '0')}`, { schemaVersion: 4, propertyId: 'TESTPROP1', propertyNameAtEntry: 'Test Lakeview Loft', cleanerId: HIST, cleanerNameAtEntry: 'Test History', day, amountCents: 6_100, note: null, status: 'logged', suggested: { from: 'short', cents: 6_100 }, amountFrom: 'short', createdAt: `${day}T19:0${k}:00.000Z`, actor: { role: 'cleaner', id: HIST, name: 'Test History' }, history: [{ at: `${day}T19:0${k}:00.000Z`, action: 'logged', actor: { role: 'cleaner', id: HIST, name: 'Test History' }, reason: null }], jobId: `TESTPROP1_${day}`, extra: null });
  }
  if (i % 3 === 0) seed('cost_entries', `TESTHISTENTRY${String(i).padStart(5, '0')}`, { schemaVersion: 3, kind: 'receipt', cleanerId: HIST, cleanerNameAtEntry: 'Test History', propertyId: 'TESTPROP1', propertyNameAtEntry: 'Test Lakeview Loft', createdAt: `${day}T15:00:00.000Z`, lines: [{ name: 'Supplies', quantity: 1, lineTotalCents: 4_520 }], taxCents: null, receipts: [], status: 'approved', statusReason: null, history: [{ at: `${day}T15:00:00.000Z`, action: 'submitted', actor: { role: 'cleaner', id: HIST, name: 'Test History' }, from: null, to: 'pending', reason: null }, { at: `${day}T15:00:00.000Z`, action: 'approved', actor: { role: 'system', id: null, name: 'auto-approval' }, from: 'pending', to: 'approved', reason: 'Under $200.00: approved automatically' }], autoApproved: null, currency: 'CAD' });
}
const reads = async (fn) => {
  const before = globalThis.__memReads.length;
  const result = await fn();
  return { result, billed: globalThis.__memReads.slice(before).reduce((t, r) => t + r.billed, 0) };
};
const allCleanings = await reads(() => cl.listCleanerCleanings(HIST));
const allEntries = await reads(() => ce.listCleanerEntries(HIST));
const monthCleaningsRead = await reads(() => cl.listCleanerCleanings(HIST, { from: '2028-11-01', to: '2028-11-30' }));
const monthEntriesRead = await reads(() => ce.listCleanerEntries(HIST, { from: '2028-10-31T00:00:00.000Z', to: '2028-12-01T23:59:59.999Z' }));
console.log(`  seeded ${n} cleanings over 365 days and ${Math.ceil(365 / 3)} receipts`);
console.log(`  before (everything of theirs): cleanings ${allCleanings.result.length} rows, ${allCleanings.billed} reads · entries ${allEntries.result.length} rows, ${allEntries.billed} reads · a History open: ${allCleanings.billed + allEntries.billed} reads plus the session`);
console.log(`  after (November 2028): cleanings ${monthCleaningsRead.result.length} rows, ${monthCleaningsRead.billed} reads · entries ${monthEntriesRead.result.length} rows (a day each way, the route keeps the month), ${monthEntriesRead.billed} reads · a History open: ${monthCleaningsRead.billed + monthEntriesRead.billed} reads plus the session`);
check(allCleanings.billed === 730 && allEntries.billed === 122 && monthCleaningsRead.billed === 34 && monthCleaningsRead.result.every((c) => c.day.startsWith('2028-11')) && monthEntriesRead.billed <= 12, 'the month read costs the month\'s documents (Nov 1–17 here, two a day), not the year\'s');
const empty = await reads(() => cl.listCleanerCleanings(HIST, { from: '2026-11-01', to: '2026-11-30' }));
check(empty.result.length === 0 && empty.billed === 1, 'an empty month costs one read');
const months = home.historyMonthRange('2028-11-18');
console.log(`  the switcher's months: ${months.length}, from ${months[0]} back to ${months[months.length - 1]}`);
check(months[0] === '2028-11' && months[months.length - 1] === '2026-11' && months.length === 25, 'every month from this one back to the statements floor');
// The person page's one read: their jobs of a month, through the cleanerIds + checkout index.
for (const day of ['2028-10-30', '2028-11-03', '2028-11-20', '2028-12-02']) seed('cleaning_jobs', `TESTPROP1_${day}`, { schemaVersion: 3, propertyId: 'TESTPROP1', propertyNameAtCreation: 'Test Lakeview Loft', checkout: day, reservation: { uid: `r-${day}@airbnb.com`, start: '2028-10-01' }, calendarKey: 'k', origin: 'calendar', tier: null, amountCents: null, label: null, nextCheckIn: null, status: 'open', change: null, cleanerIds: [HIST], assignments: { [HIST]: { nameAtAssignment: 'Test History', assignedAt: '2028-10-01T12:00:00.000Z', assignedBy: ADMIN, cleaningId: null, markedAt: null, removedAt: null, removedBy: null, note: null, extraAsked: false } }, createdAt: '2028-10-01T12:00:00.000Z', history: [] });
seed('property_cleaner_names', 'TESTPROP1', { schemaVersion: 1, propertyId: 'TESTPROP1', name: '14 Sample St', setAt: '2028-10-01T12:00:00.000Z' });
const monthJobs = await reads(() => sj.memberJobsInMonth(HIST, '2028-11'));
console.log(`  their jobs of November: ${monthJobs.result.map((j) => `${j.checkout} ${j.propertyName}`).join(', ')} · ${monthJobs.billed} reads`);
check(monthJobs.result.length === 2 && monthJobs.result.every((j) => j.propertyName === '14 Sample St') && monthJobs.billed === 3, 'two jobs of the month, named by the address: one read each and one for the name');

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
