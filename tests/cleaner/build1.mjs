// Build 1 of the UX audit (Kian's rulings of 2026-11-02): the cleaner and handyman apps. What the pure home and History
// code decides (item 1: same-day turnovers first, the day said once; item 8: months), what a mark with a note does
// (item 2: the note is the reason, the money waits), the one-click approval at the cleaning price (item 3), the grey
// words under Cleaned and why Undo is gone (item 4), a session that never expires by age (item 5), and the receipt
// total check (item 6). The server functions run on an in-memory Firestore (tests/tools/memory-firestore.cjs): nothing
// is read from or written to Firestore or Storage. Made-up data only: properties "TESTPROP…", cleaners "Test …",
// amounts made up and written with separators, never a real rate.
//   node --import ./tests/tools/ts-hook.mjs tests/cleaner/build1.mjs
import { createRequire } from 'node:module';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.NUBNB_ROOT || fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
createRequire(`${ROOT}/package.json`)(`${ROOT}/tests/tools/memory-firestore.cjs`);
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2_048 });
process.env.FIREBASE_SERVICE_ACCOUNT_KEY = JSON.stringify({ type: 'service_account', project_id: 'memory-test', private_key_id: 'memory-test', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), client_email: 'memory-test@memory-test.iam.gserviceaccount.com', client_id: '0', token_uri: 'https://oauth2.invalid/token' });
process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = 'memory-test.appspot.com';
process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = 'memory-test';

const home = await import(`${ROOT}/app/lib/cleaner-home.ts`);
const jm = await import(`${ROOT}/app/lib/schedule/model.ts`);
const cm = await import(`${ROOT}/app/lib/cleanings/model.ts`);
const sc = await import(`${ROOT}/app/lib/cleanings/schemas.ts`);
const sp = await import(`${ROOT}/app/lib/firebase/server-cleaning-prices.ts`);
const sj = await import(`${ROOT}/app/lib/firebase/server-cleaning-jobs.ts`);
const cl = await import(`${ROOT}/app/lib/firebase/server-cleanings.ts`);
const ce = await import(`${ROOT}/app/lib/firebase/server-cost-entries.ts`);
const pay = await import(`${ROOT}/app/lib/pay/balance.ts`);
const model = await import(`${ROOT}/app/lib/cleaners/model.ts`);
const marks = await import(`${ROOT}/app/lib/costs/marks.ts`);
const session = await import(`${ROOT}/app/lib/cleaners/session.ts`);
const { getAdminDb } = await import(`${ROOT}/app/lib/firebase/admin.ts`);
const seed = globalThis.__memSeed;
const doc = globalThis.__memDoc;

let failures = 0;
const check = (ok, label) => {
  if (!ok) failures += 1;
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${label}`);
};
const $ = (cents) => (cents === null || cents === undefined ? 'none' : `$${(cents / 100).toFixed(2)}`);
const TODAY = '2028-11-18';
const TOMORROW = '2028-11-19';

// ═══ 1. The home's order and groups (item 1), the next guest's words, History's months (item 8) ═══
console.log('═══ 1. The home: same-day turnovers first within a day, the day said once as a heading; History by month ═══');
const view = (id, checkout, extra = {}) => ({ id, propertyId: `TESTPROP${id.slice(-2)}`, propertyName: `Test ${id.slice(-2)} St`, city: 'Toronto', checkout, checkOutTime: '11:00 AM', checkInTime: '4:00 PM', nextCheckIn: null, status: 'open', change: null, markedAt: null, canUndo: false, undoBlocked: null, recordedByOffice: false, note: null, extraAsked: false, markRefusal: checkout > TODAY ? 'too-early' : null, ...extra });
const jobs = [
  view('TESTJOB01', TODAY, { checkOutTime: '10:00 AM', nextCheckIn: '2028-11-21' }), // today, 10:00, next guest in three days
  view('TESTJOB02', TODAY, { checkOutTime: '11:00 AM', nextCheckIn: TODAY }), // today, 11:00, same-day turnover: first
  view('TESTJOB03', TOMORROW, { nextCheckIn: TOMORROW }), // tomorrow, same-day
  view('TESTJOB04', TOMORROW, { checkOutTime: '9:00 AM' }), // tomorrow, 9:00
  view('TESTJOB05', '2028-11-16'), // a past job still to do
  view('TESTJOB06', TODAY, { status: 'booking-changed', change: { kind: 'moved', movedTo: { start: '2028-11-20', end: '2028-11-24' } }, markRefusal: 'booking-changed' }),
];
const order = home.homeJobs(jobs, TODAY).map((j) => j.id).join(', ');
console.log(`  homeJobs: ${order}`);
check(order === 'TESTJOB05, TESTJOB02, TESTJOB01, TESTJOB06, TESTJOB03, TESTJOB04', 'the past job first, then today with the same-day turnover before the 10:00 job and the moved booking last, then tomorrow with its same-day job first');
const groups = home.homeGroups(jobs, TODAY);
console.log(`  homeGroups: ${groups.map((g) => `${g.key} "${g.heading}" [${g.jobs.map((j) => j.id.slice(-2)).join(',')}]`).join(' · ')}`);
check(groups.map((g) => g.heading).join(' | ') === 'Still to do | Today · Sat, Nov 18 | Tomorrow · Sun, Nov 19', 'three groups, each day named once in its heading');
for (const [label, j, want] of [
  ["today's same-day turnover", jobs[1], 'Next guest today 4:00 PM'],
  ["tomorrow's same-day turnover", jobs[2], 'Next guest tomorrow 4:00 PM'],
  ['the next guest in three days', jobs[0], 'Next guest Tue, Nov 21'],
  ['no next guest', jobs[3], null],
]) {
  const got = home.guestWords(j, TODAY);
  console.log(`  guestWords(${label}) → ${JSON.stringify(got)}`);
  check(got === want, label);
}
console.log(`  a moved booking's line: ${JSON.stringify(home.changedWords(jobs[5]))}`);
check(home.changedWords(jobs[5]).words === 'Moved to Fri, Nov 24' && home.changedWords(jobs[5]).plain, 'a moved booking reads "Moved to <day>" (one grey line on the home)');
const entry = (id, createdAt) => ({ id, createdAt, propertyId: 'TESTPROP99', propertyNameAtEntry: 'Test 99 St', lineCount: 1, totalCents: 1_234, sentTotalCents: 1_234, taxCents: null, taxShape: 'field', corrected: false, status: 'pending', statusReason: null, kind: 'receipt', description: null });
const items = home.historyItems([view('TESTJOB11', '2028-11-10', { markedAt: '2028-11-10T18:00:00.000Z' }), view('TESTJOB12', '2028-10-30', { markedAt: '2028-10-30T18:00:00.000Z' })], [entry('TESTENTRY1', '2028-11-17T15:00:00.000Z'), entry('TESTENTRY2', '2028-09-03T15:00:00.000Z'), entry('TESTENTRY3', null)]);
const months = home.historyMonths(items, TODAY);
console.log(`  historyMonths: ${months.join(', ')} · ${months.map((m) => `${home.monthWords(m)}: ${home.monthItems(items, m, months).map((i) => (i.kind === 'job' ? i.job.id : i.entry.id).slice(-2)).join(',')}`).join(' · ')}`);
check(months.join(',') === '2028-11,2028-10,2028-09' && home.monthItems(items, '2028-11', months).length === 3 && home.monthItems(items, '2028-09', months).length === 1, 'months newest first, this month always there; an undated entry under the newest month');
check(home.historyMonths([], '2028-11-18').join() === '2028-11', 'with nothing yet, the switcher opens on this month alone');

// ═══ 2. Done with and without a note (item 2) ═══
console.log('\n═══ 2. Done with no note counts at once; Done with a note waits for the office (the note is the reason) ═══');
const ADMIN = { role: 'admin', id: 'TESTADMINbuild1aaaa1', name: 'Test admin' };
const P = 'TESTPROPbuildoneaaa1';
const ANA = { id: 'TESTCLEANERbuild1ana', name: 'Test Ana' };
seed('properties', P, { name: 'Test Build', icalUrl: `https://www.airbnb.ca/calendar/ical/${P}.ics?s=made-up`, details: { checkOut: '11:00 AM', checkIn: '4:00 PM' }, addressDetails: { city: 'Toronto' } });
seed('cleaners', ANA.id, { schemaVersion: 2, name: ANA.name, role: 'cleaner', status: 'active', sessionEpoch: 1, history: [] });
await sp.setCleaningPrices(ADMIN, P, { shortTermCents: 8_300, midTermCents: 9_500, longTermCents: 13_300 });
const seedJob = (checkout, start) => {
  const id = jm.jobIdOf(P, checkout);
  const made = `${start}T12:00:00.000Z`;
  seed('cleaning_jobs', id, { schemaVersion: jm.JOB_SCHEMA_VERSION, propertyId: P, propertyNameAtCreation: 'Test Build', checkout, reservation: { uid: `${id}@airbnb.com`, start }, calendarKey: 'abcdef0123', origin: 'calendar', tier: null, amountCents: null, nextCheckIn: null, status: 'open', change: null, cleanerIds: [ANA.id], assignments: { [ANA.id]: jm.newAssignment(ANA.name, made, ADMIN) }, createdAt: made, history: [jm.jobEvent(made, 'created', jm.CALENDAR_ACTOR, { after: { start, end: checkout } }), jm.jobEvent(made, 'assigned', ADMIN, { cleanerId: ANA.id, cleanerName: ANA.name })] });
  return id;
};
const at = (day) => new Date(`${day}T18:00:00.000Z`);
const body = (note) => sc.JobActionSchema.parse({ action: 'mark', note });
const markAs = async (jobId, day, note) => {
  // As the route does since Build 1: the note is the reason.
  const parsed = body(note);
  const r = await sj.markCleaned(ANA, jobId, at(day), { note: parsed.note, extraReason: parsed.extraReason ?? parsed.note });
  return { kind: r.kind, id: r.cleaningId, cleaning: r.kind === 'marked' ? doc('cleanings', r.cleaningId) : null };
};
const asView = (c, id) => ({ ...c, id, cleaner: { state: 'found', name: ANA.name, status: 'active' }, property: { state: 'found', name: 'Test Build' } });
const payOf = (c, id) => pay.memberPay(ANA.id, { cleanings: [asView(c, id)], entries: [], payments: [] });
const plainJob = seedJob('2028-11-15', '2028-11-12');
const plain = await markAs(plainJob, '2028-11-15', null);
console.log(`  no note: ${plain.kind} · ${$(plain.cleaning.amountCents)} (${plain.cleaning.amountFrom}) · extra ${plain.cleaning.extra} · note ${plain.cleaning.note} · entry ${cm.cleaningEntryView(asView(plain.cleaning, plain.id)).status} · pay earned ${$(payOf(plain.cleaning, plain.id).earnedCents)}`);
check(plain.cleaning.extra === null && payOf(plain.cleaning, plain.id).earnedCents === 8_300 && cm.cleaningEntryView(asView(plain.cleaning, plain.id)).status === 'approved', 'with no note the cleaning counts at once, at the cleaning price');
const notedJob = seedJob('2028-11-16', '2028-11-13');
const noted = await markAs(notedJob, '2028-11-16', '  More time: very dirty  ');
console.log(`  with a note: ${noted.kind} · ${$(noted.cleaning.amountCents)} (${noted.cleaning.amountFrom}) · extra ${noted.cleaning.extra?.status} "${noted.cleaning.extra?.reason}" · note "${noted.cleaning.note}" · entry ${cm.cleaningEntryView(asView(noted.cleaning, noted.id)).status} · pay earned ${$(payOf(noted.cleaning, noted.id).earnedCents)}, extraAsked ${payOf(noted.cleaning, noted.id).extraAsked}`);
check(noted.cleaning.extra?.status === 'asked' && noted.cleaning.extra.reason === 'More time: very dirty' && noted.cleaning.note === 'More time: very dirty', 'with a note the cleaning is made and the note is the reason the money waits (ruling F\'s mechanics)');
check(payOf(noted.cleaning, noted.id).earnedCents === 0 && cm.cleaningEntryView(asView(noted.cleaning, noted.id)).status === 'pending', 'the noted cleaning counts nowhere until the office decides');
const assignment = doc('cleaning_jobs', notedJob).assignments[ANA.id];
check(assignment.extraAsked === true && assignment.note === 'More time: very dirty', 'the job\'s assignment carries the note and the flag');
let phone = await sj.cleanerJobsRead(ANA.id, '2028-11-16');
const cardOf = (id) => phone.find((j) => j.id === id);
console.log(`  the phone: plain extraAsked ${cardOf(plainJob).extraAsked}, canUndo ${cardOf(plainJob).canUndo}; noted extraAsked ${cardOf(notedJob).extraAsked} ("Cleaned · note sent"), canUndo ${cardOf(notedJob).canUndo}`);
check(cardOf(plainJob).extraAsked === false && cardOf(notedJob).extraAsked === true, 'the card reads "Cleaned" for the plain mark and "Cleaned · note sent" for the noted one');
const keys = [...new Set(phone.flatMap((j) => Object.keys(j)))].sort();
check(!keys.some((k) => /amount|price|cents|rate/i.test(k)), `no amount, price or rate reaches the cleaner (keys: ${keys.join(', ')})`);
check(!sc.JobActionSchema.safeParse({ action: 'mark', amount: '83.00' }).success, 'an amount in a mark body is refused (ruling H)');

// ═══ 3. Approve at cleaning price, one click (item 3) ═══
console.log('\n═══ 3. "Approve at cleaning price": one click counts the noted cleaning at the price it arrived with; the amber clears ═══');
const approved = await cl.decideExtra(ADMIN, noted.id, 'approve', undefined, 1, null);
const approvedDoc = doc('cleanings', noted.id);
console.log(`  decided: ${approved.kind} · ${$(approvedDoc.amountCents)} (${approvedDoc.amountFrom}) · extra ${approvedDoc.extra.status} by ${approvedDoc.extra.decidedBy.name} · last event ${approvedDoc.history.at(-1).action} · pay earned ${$(payOf(cm.readCleaning(noted.id, approvedDoc), noted.id).earnedCents)}`);
check(approved.kind === 'decided' && approvedDoc.amountCents === 8_300 && approvedDoc.amountFrom === 'short' && payOf(cm.readCleaning(noted.id, approvedDoc), noted.id).earnedCents === 8_300, 'approved at the cleaning price: the amount it arrived with now counts in pay');
phone = await sj.cleanerJobsRead(ANA.id, '2028-11-16');
console.log(`  the phone after the decision: noted extraAsked ${cardOf(notedJob).extraAsked} · note still "${cardOf(notedJob).note}"`);
check(cardOf(notedJob).extraAsked === false && cardOf(notedJob).markedAt !== null, 'the card\'s amber clears to "Cleaned": never the outcome, never an amount');
const declinedJob = seedJob('2028-11-17', '2028-11-14');
const declined = await markAs(declinedJob, '2028-11-17', 'Extra laundry');
const dec = await cl.decideExtra(ADMIN, declined.id, 'decline', undefined, 1, null);
console.log(`  a second note declined: ${dec.kind} · ${$(doc('cleanings', declined.id).amountCents)} counts · extra ${doc('cleanings', declined.id).extra.status}`);
check(dec.kind === 'decided' && doc('cleanings', declined.id).amountCents === 8_300, 'declined: the cleaning price counts (ruling F)');

// ═══ 4. The grey words under Cleaned (item 4) ═══
console.log('\n═══ 4. "Recorded by the office"; "Can\'t undo: already paid"; "Can\'t undo: on a statement" ═══');
const officeJob = seedJob('2028-11-14', '2028-11-11');
const rec = await sj.recordCleaned(ADMIN, officeJob, [ANA.id], 2, at('2028-11-14'));
phone = await sj.cleanerJobsRead(ANA.id, '2028-11-16');
console.log(`  recorded by the office: ${rec.kind} · the phone: recordedByOffice ${cardOf(officeJob).recordedByOffice}, canUndo ${cardOf(officeJob).canUndo}, undoBlocked ${cardOf(officeJob).undoBlocked} · words ${JSON.stringify(home.cleanedWords(cardOf(officeJob)))}`);
check(cardOf(officeJob).recordedByOffice === true && home.cleanedWords(cardOf(officeJob)).join() === 'Recorded by the office', 'an office-recorded mark says so in grey');
check(cardOf(plainJob).recordedByOffice === false && home.cleanedWords(cardOf(plainJob)).length === 0, 'the cleaner\'s own mark with Undo says nothing extra');
// A payment to Ana dated after the plain job's day: Undo is gone, and the card says why.
seed('team_payments', 'TESTPAYbuild1aaaaaa01', { schemaVersion: 1, memberId: ANA.id, memberNameAtPayment: ANA.name, amountCents: 8_300, currency: 'CAD', day: '2028-11-15', method: 'e-transfer', note: null, status: 'recorded', recordedAt: '2028-11-15T20:00:00.000Z', recordedBy: ADMIN, deletedAt: null, deletedBy: null, history: [{ at: '2028-11-15T20:00:00.000Z', action: 'recorded', actor: ADMIN }] });
phone = await sj.cleanerJobsRead(ANA.id, '2028-11-16');
console.log(`  after a payment dated Nov 15: the Nov 15 job canUndo ${cardOf(plainJob).canUndo}, undoBlocked ${cardOf(plainJob).undoBlocked} → ${JSON.stringify(home.cleanedWords(cardOf(plainJob)))}; the Nov 16 job canUndo ${cardOf(notedJob).canUndo}, undoBlocked ${cardOf(notedJob).undoBlocked}`);
check(cardOf(plainJob).canUndo === false && cardOf(plainJob).undoBlocked === 'paid' && home.cleanedWords(cardOf(plainJob)).join() === 'Can’t undo: already paid', 'a cleaning on or before the latest payment day: "Can\'t undo: already paid"');
check(cardOf(notedJob).canUndo === true && cardOf(notedJob).undoBlocked === null, 'a cleaning after that day keeps its Undo');
// A finished statement printing the noted cleaning.
seed('monthly_reports', 'TESTREPORTbuild1aaaa1', { propertyId: P, month: '2028-11', status: 'finished', entryIds: [noted.id], costs: [], adjustments: [] });
phone = await sj.cleanerJobsRead(ANA.id, '2028-11-16');
console.log(`  a finished statement prints the Nov 16 cleaning: canUndo ${cardOf(notedJob).canUndo}, undoBlocked ${cardOf(notedJob).undoBlocked} → ${JSON.stringify(home.cleanedWords(cardOf(notedJob)))}`);
check(cardOf(notedJob).canUndo === false && cardOf(notedJob).undoBlocked === 'statement' && home.cleanedWords(cardOf(notedJob)).join() === 'Can’t undo: on a statement', 'a cleaning a finished statement prints: "Can\'t undo: on a statement"');
const afterMark = await sj.oneCleanerJob(jm.readJob(plainJob, doc('cleaning_jobs', plainJob)), ANA.id, true, '2028-11-16');
console.log(`  the answer right after a mark on a paid day: canUndo ${afterMark.canUndo}, undoBlocked ${afterMark.undoBlocked}, recordedByOffice ${afterMark.recordedByOffice}`);
check(afterMark.canUndo === false && afterMark.undoBlocked === 'paid', 'the mark\'s own answer already says "already paid" when a payment covers its day');

// ═══ 5. No automatic expiry (item 5) ═══
console.log('\n═══ 5. A session never ages out; a token from the future is still refused ═══');
const key = randomBytes(32);
const issued = Date.parse('2028-10-01T12:00:00.000Z');
const token = session.createCleanerToken(key, ANA.id, 1, issued);
const after30 = session.parseCleanerToken(token, key, issued + 30 * 86_400_000);
const after13h = session.parseCleanerToken(token, key, issued + 13 * 3_600_000);
const fromFuture = session.parseCleanerToken(token, key, issued - 120_000);
console.log(`  issued Oct 1: after 13 hours ${after13h ? 'holds' : 'refused'} · after 30 days ${after30 ? 'holds' : 'refused'} · two minutes before it was issued ${fromFuture ? 'holds' : 'refused'} · cookie Max-Age ${session.CLEANER_SESSION_MAX_AGE / 86_400} days`);
check(after13h !== null && after30 !== null && after30.cleanerId === ANA.id, 'the token holds after 13 hours and after 30 days (it ended after 12 hours before)');
check(fromFuture === null, 'a token issued more than a minute ahead of the clock is refused');
check(session.CLEANER_SESSION_MAX_AGE === 400 * 86_400, 'the cookie is kept 400 days, the most a browser allows');

// ═══ 6. The receipt total check (item 6) ═══
console.log('\n═══ 6. The printed total against the lines: shown on the phone, a mark for the admin, never a refusal ═══');
for (const [total, want] of [['45.20', 4_520], ['$1,045.20', 104520], ['45', null], ['-5.00', null], [null, null], ['999999.99', 99999999], ['1000000.00', null]]) {
  const got = model.printedTotalOf({ store: null, purchasedOn: null, lines: [], subtotal: null, total, unreadable: false, notes: null });
  console.log(`  printedTotalOf(${JSON.stringify(total)}) → ${got}`);
  check(got === want, `printed total ${JSON.stringify(total)} reads as ${want}`);
}
// Each send its own amounts, so the same-amount duplicate flag of Phase 2 stays out of the way.
const record = (item, tax, total) => ({ v: 1, id: 'reading-1', cleanerId: ANA.id, requestedAt: '2028-11-16T15:00:00.000Z', model: 'gemini-3.8-flash', modelVersion: 'test', thinkingLevel: 'LOW', ms: 1_000, status: 'ok', reason: null, usage: null, output: { store: 'Test Store', purchasedOn: null, lines: [{ name: 'Sponges', quantity: 1, amount: item, kind: 'item' }, { name: 'HST', quantity: null, amount: tax, kind: 'tax' }], subtotal: item, total, unreadable: false, notes: null }, rawText: null });
let keyN = 0;
async function send(label, total, item = '40.00', tax = '5.20') {
  const parsedEntry = ce.parseEntryPart(JSON.stringify({ submissionKey: `0f0e0d0c-0b0a-4908-8706-${String(++keyN).padStart(12, '0')}`, propertyId: P, lines: [{ name: 'Sponges', quantity: '1', lineTotal: item }], tax }));
  if (parsedEntry.kind !== 'ok') throw new Error(`${label}: ${JSON.stringify(parsedEntry)}`);
  const entryRef = ce.newEntryRef();
  const created = await ce.createCostEntry({ entryRef, cleanerId: ANA.id, sessionEpoch: 1, entry: parsedEntry.entry, propertyNameAtEntry: 'Test Build', receipt: { path: `receipts/${entryRef.id}/y.jpg`, contentType: 'image/jpeg', bytes: 1, sha256: String(keyN).repeat(64).slice(0, 64), uploadedAt: '2028-11-16T15:00:00.000Z' }, reading: total === undefined ? null : { record: record(item, tax, total), fromReading: [0] } });
  const stored = (await getAdminDb().collection('cost_entries').doc(entryRef.id).get()).data();
  const fields = model.readCostEntryFields(entryRef.id, stored);
  console.log(`  ${label}: ${created.status}${created.autoApproved ? ' (approved automatically)' : ''} · printedTotalCents ${stored.printedTotalCents ?? '(absent)'} · totalDiffers ${stored.totalDiffers ? JSON.stringify(stored.totalDiffers) : '(absent)'} · read back: ${fields.totalDiffers ? marks.totalDiffersWords(fields.totalDiffers) : 'no mark'}`);
  return { created, stored, fields };
}
const same = await send('lines $45.20, the receipt prints $45.20', '45.20');
check(same.created.status === 'approved' && same.stored.totalDiffers === undefined && same.stored.printedTotalCents === 4_520, 'the totals agree: no mark, approved automatically under $200.00 as before');
const off = await send('lines $45.20, the receipt prints $47.20', '47.20', '40.00', '5.20');
check(off.created.status === 'pending' && off.created.autoApproved === false && off.stored.totalDiffers !== undefined, 'a difference never blocks sending; the entry waits for a decision (the developer\'s choice: a flagged receipt waits; this one is also a same-amount duplicate of the first)');
check(off.fields.totalDiffers?.printedTotalCents === 4_720 && off.fields.totalDiffers?.sentTotalCents === 4_520 && marks.totalDiffersWords(off.fields.totalDiffers) === 'Total differs from the receipt: it prints $47.20; the lines add up to $45.20.', 'the mark carries both figures and reads in the admin\'s words');
const none = await send('no readable printed total', null, '41.00', '5.33');
check(none.created.status === 'approved' && none.stored.totalDiffers === undefined && none.stored.printedTotalCents === undefined, 'a receipt with no readable total is not marked');
const noReading = await send('no reading at all', undefined, '42.00', '5.46');
check(noReading.created.status === 'approved' && noReading.stored.totalDiffers === undefined, 'no reading, no mark');
check(model.readCostEntryFields('x', { totalDiffers: { printedTotalCents: 4_520, sentTotalCents: 4_520 } }).totalDiffers === undefined && model.readCostEntryFields('x', { totalDiffers: { printedTotalCents: '47.20', sentTotalCents: 4_520 } }).totalDiffers === undefined, 'a stored mark whose figures agree, or are not whole cents, reads as no mark');

// ═══ 7. History reaches every month back to the statements floor (Kian's ruling H4 of 2026-11-02) ═══
console.log('\n═══ 7. History: a cleaning 60 days before the clock shows in its month, read from the cleanings themselves ═══');
const sixtyBack = seedJob('2028-09-19', '2028-09-16'); // 60 days before 2028-11-18: outside the 45 days the job list reaches
const old = await markAs(sixtyBack, '2028-09-19', null);
seed('cleanings', 'TESTCLEANINGbeforefloor', { schemaVersion: 4, propertyId: P, propertyNameAtEntry: 'Test Build', cleanerId: ANA.id, cleanerNameAtEntry: ANA.name, day: '2026-10-15', amountCents: 6_100, note: null, status: 'logged', suggested: { from: 'short', cents: 6_100 }, amountFrom: 'short', createdAt: '2026-10-15T18:00:00.000Z', actor: ADMIN, history: [{ at: '2026-10-15T18:00:00.000Z', action: 'logged', actor: ADMIN, reason: null }], jobId: null, extra: null });
const mineNow = await cl.listCleanerCleanings(ANA.id);
const listKeys = [...new Set(mineNow.flatMap((c) => Object.keys(c)))].sort();
console.log(`  the cleaner's cleanings read: ${mineNow.length} · days ${mineNow.map((c) => c.day).join(', ')} · keys ${listKeys.join(', ')}`);
check(mineNow.some((c) => c.id === old.id && c.day === '2028-09-19') && !mineNow.some((c) => c.day === '2026-10-15'), 'the 60-day cleaning is read; one dated before November 2026 is not');
check(!listKeys.some((k) => /amount|price|cents|rate/i.test(k)), 'no amount, price or rate in the list (ruling H)');
const officeRow = mineNow.find((c) => c.id === ids4OfficeCleaning());
check(officeRow?.recordedByOffice === true && mineNow.find((c) => c.id === old.id)?.recordedByOffice === false, 'the office-recorded cleaning says so; the cleaner\'s own does not');
const jobs45 = await sj.cleanerJobsRead(ANA.id, '2028-11-18');
const history = home.historyItems(jobs45, [], mineNow);
const sept = history.find((item) => item.kind === 'cleaning' && item.cleaning.id === old.id);
const nov16 = history.find((item) => item.day === '2028-11-16');
console.log(`  History items: ${history.map((item) => `${item.day} ${item.kind}`).join('; ')} · months ${home.historyMonths(history, '2028-11-18').join(', ')}`);
check(sept !== undefined && sept.day === '2028-09-19' && home.monthItems(history, '2028-09', home.historyMonths(history, '2028-11-18')).length === 1, 'the 60-day cleaning is a September row, as the cleaning itself (no job in hand, so no Undo)');
check(nov16?.kind === 'job' && history.filter((item) => item.day === '2028-11-16').length === 1, 'a cleaning within 45 days is its job, once (Undo and the grey words come with it)');
check(home.historyMonths(history, '2028-11-18').join() === '2028-11,2028-09', 'the switcher offers November and September');
function ids4OfficeCleaning() { return doc('cleaning_jobs', officeJob).assignments[ANA.id].cleaningId; }

console.log(`\n${failures === 0 ? 'every check passed' : `${failures} check(s) FAILED`}`);
if (failures > 0) process.exitCode = 1;
