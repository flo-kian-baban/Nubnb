// The cleaning flow (Kian's rulings A, B, E and F of 2026-11-01): three tiers by the booking's nights, the job's own
// amount, Record as cleaned by an admin equal to a cleaner's own mark, and "Ask for extra" holding the money until an
// admin approves or declines. The server functions run on an in-memory Firestore (tests/tools/memory-firestore.cjs):
// nothing is read from or written to Firestore or Storage, and every connection is refused. Made-up data only:
// properties "TESTPROP…", cleaners "Test …", amounts made up (written with separators, never a real rate).
//   node --import ./tests/tools/ts-hook.mjs tests/schedule/cleaning-flow.mjs
import { createRequire } from 'node:module';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.NUBNB_ROOT || fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
createRequire(`${ROOT}/package.json`)(`${ROOT}/tests/tools/memory-firestore.cjs`);
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.FIREBASE_SERVICE_ACCOUNT_KEY = JSON.stringify({ type: 'service_account', project_id: 'memory-test', private_key_id: 'memory-test', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), client_email: 'memory-test@memory-test.iam.gserviceaccount.com', client_id: '0', token_uri: 'https://oauth2.invalid/token' });
process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = 'memory-test.appspot.com';
process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = 'memory-test';

const pr = await import(`${ROOT}/app/lib/cleanings/prices.ts`);
const cm = await import(`${ROOT}/app/lib/cleanings/model.ts`);
const jm = await import(`${ROOT}/app/lib/schedule/model.ts`);
const sync = await import(`${ROOT}/app/lib/schedule/sync.ts`);
const standing = await import(`${ROOT}/app/lib/schedule/standing.ts`);
const sp = await import(`${ROOT}/app/lib/firebase/server-cleaning-prices.ts`);
const sj = await import(`${ROOT}/app/lib/firebase/server-cleaning-jobs.ts`);
const cl = await import(`${ROOT}/app/lib/firebase/server-cleanings.ts`);
const pay = await import(`${ROOT}/app/lib/pay/balance.ts`);
const checks = await import(`${ROOT}/app/lib/reports/checks.ts`);
const st = await import(`${ROOT}/app/lib/reports/statement.ts`);
const sc = await import(`${ROOT}/app/lib/cleanings/schemas.ts`);
const seed = globalThis.__memSeed;
const doc = globalThis.__memDoc;

let failures = 0;
const check = (ok, label) => {
  if (!ok) failures += 1;
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${label}`);
};
const $ = (cents) => (cents === null || cents === undefined ? 'none' : `$${(cents / 100).toFixed(2)}`);

const ADMIN = { role: 'admin', id: 'TESTADMINflowaaaaaa1', name: 'Test admin' };
const P = 'TESTPROPflowaaaaaa01'; // all three tiers
const Q = 'TESTPROPflowaaaaaa02'; // no prices
const ANA = { id: 'TESTCLEANERflowaana1', name: 'Test Ana' };
const BEN = { id: 'TESTCLEANERflowaben1', name: 'Test Ben' };
const PRICES = { shortTermCents: 8_300, midTermCents: 9_500, longTermCents: 13_300 };
const property = (id, name) => seed('properties', id, { name, icalUrl: `https://www.airbnb.ca/calendar/ical/${id}.ics?s=made-up`, details: { checkOut: '11:00', checkIn: '16:00' }, addressDetails: { city: 'Toronto' } });
property(P, 'Test Tiered');
property(Q, 'Test Unpriced');
for (const m of [ANA, BEN]) seed('cleaners', m.id, { schemaVersion: 2, name: m.name, role: 'cleaner', status: 'active', sessionEpoch: 1, history: [] });

/** A calendar job on `pid` for a stay from `start` to `checkout`, with `cleaners` on it, in the written shape (schema version 2). */
const seedJob = (pid, start, checkout, cleaners, extra = {}) => {
  const id = jm.jobIdOf(pid, checkout);
  const made = `${start}T12:00:00.000Z`;
  const assignments = Object.fromEntries(cleaners.map((m) => [m.id, jm.newAssignment(m.name, made, ADMIN)]));
  seed('cleaning_jobs', id, { schemaVersion: jm.JOB_SCHEMA_VERSION, propertyId: pid, propertyNameAtCreation: 'Test', checkout, reservation: { uid: `${id}@airbnb.com`, start }, calendarKey: 'abcdef0123', origin: 'calendar', tier: null, amountCents: null, nextCheckIn: null, status: 'open', change: null, cleanerIds: cleaners.map((m) => m.id), assignments, createdAt: made, history: [jm.jobEvent(made, 'created', jm.CALENDAR_ACTOR, { after: { start, end: checkout } }), ...cleaners.map((m) => jm.jobEvent(made, 'assigned', ADMIN, { cleanerId: m.id, cleanerName: m.name }))], ...extra });
  return id;
};
const at = (checkout) => new Date(`${checkout}T18:00:00.000Z`);
const mark = async (m, id, checkout, input) => {
  const r = await sj.markCleaned({ id: m.id, name: m.name }, id, at(checkout), input);
  const c = r.kind === 'marked' ? doc('cleanings', r.cleaningId) : null;
  return { kind: r.kind, id: r.cleaningId, amount: c ? $(c.amountCents) : '-', from: c?.suggested.from, amountFrom: c?.amountFrom, extra: c?.extra?.status ?? null, c };
};

// ═══ 1. Three tiers (ruling A) ═══
console.log('═══ 1. Three tiers by the booking\'s nights: short 1–6, mid 7–27, long 28+ (ruling A) ═══');
for (const nights of [1, 6, 7, 27, 28, 45]) console.log(`  ${String(nights).padStart(2)} nights → ${pr.presetKind(nights)} (${pr.TIER_WORDS[pr.presetKind(nights)]}, ${pr.TIER_NIGHTS[pr.presetKind(nights)]}): ${$(pr.presetAmount(PRICES, nights).cents)}`);
check(pr.presetKind(6) === 'short' && pr.presetKind(7) === 'mid' && pr.presetKind(27) === 'mid' && pr.presetKind(28) === 'long', 'the boundaries: 6 short, 7 mid, 27 mid, 28 long');
const v1 = pr.readCleaningPrices(P, { schemaVersion: 1, propertyId: P, shortTermCents: 8_300, longTermCents: 13_300, setAt: '2026-10-19T12:00:00.000Z', setBy: ADMIN, history: [{ at: '2026-10-19T12:00:00.000Z', actor: ADMIN, before: { shortTermCents: null, longTermCents: null }, after: { shortTermCents: 8_300, longTermCents: 13_300 } }] });
console.log(`  a version 1 record (two tiers) reads mid as: ${$(v1?.midTermCents)} (its short is ${$(v1?.shortTermCents)}) · history before/after mid: ${$(v1?.history[0].before.midTermCents)} / ${$(v1?.history[0].after.midTermCents)}`);
check(v1 !== null && v1.midTermCents === 8_300, 'a record from before the mid tier reads its mid price as its short one (mid starts equal to short)');
const csv = pr.parsePricesCsv('address,short,long\n12 Test Rd,83,133\n');
const matched = pr.matchPriceRows(csv.rows, [{ id: P, name: '12 Test Rd' }], new Map());
console.log(`  a CSV with no mid column: mid = ${$(matched.matched[0].after.midTermCents)}; with one: ${$(pr.matchPriceRows(pr.parsePricesCsv('address,short,mid,long\n12 Test Rd,83,95,133\n').rows, [{ id: P, name: '12 Test Rd' }], new Map()).matched[0].after.midTermCents)}`);
check(matched.matched[0].after.midTermCents === 8_300, 'the import without a mid column gives mid = short');
await sp.setCleaningPrices(ADMIN, P, PRICES);
const s3 = await mark(ANA, seedJob(P, '2028-11-02', '2028-11-05', [ANA]), '2028-11-05');
const s10 = await mark(ANA, seedJob(P, '2028-10-27', '2028-11-06', [ANA]), '2028-11-06');
const s30 = await mark(ANA, seedJob(P, '2028-10-08', '2028-11-07', [ANA]), '2028-11-07');
for (const [label, r] of [['3 nights', s3], ['10 nights', s10], ['30 nights', s30]]) console.log(`  mark on P, ${label}, one cleaner: ${r.kind} · ${r.amount} · from ${r.from} · amountFrom ${r.amountFrom} · schema ${r.c?.schemaVersion} · extra ${r.extra}`);
check(s3.amount === '$83.00' && s3.amountFrom === 'short' && s10.amount === '$95.00' && s10.amountFrom === 'mid' && s30.amount === '$133.00' && s30.amountFrom === 'long', '3 nights → short, 10 → mid, 30 → long');
const two = seedJob(P, '2028-11-05', '2028-11-08', [ANA, BEN]);
const twoAna = await mark(ANA, two, '2028-11-08');
const twoBen = await mark(BEN, two, '2028-11-08');
console.log(`  two cleaners on one job: Ana ${twoAna.amount} (${twoAna.from}) · Ben ${twoBen.amount} (${twoBen.from})`);
check(twoAna.amount === 'none' && twoBen.amount === 'none', 'two cleaners on a job still give no amount');
await sp.setCleaningPrices(ADMIN, P, { ...PRICES, shortTermCents: 8_700 });
const afterChange = doc('cleanings', s3.id);
const s3again = await mark(ANA, seedJob(P, '2028-11-07', '2028-11-09', [ANA]), '2028-11-09');
console.log(`  the short price raised: the earlier 3-night cleaning still ${$(afterChange.amountCents)} (${afterChange.amountFrom}); the next mark takes ${s3again.amount}`);
check(afterChange.amountCents === 8_300 && s3again.amount === '$87.00', 'a base change never alters an existing cleaning; the next mark takes the new base');

// ═══ 2. The job's own amount (ruling B) ═══
console.log('\n═══ 2. The job\'s own amount beats the base price (ruling B) ═══');
const jobB = seedJob(P, '2028-10-08', '2028-11-10', [ANA]);
const setB = await sj.setJobAmount(ADMIN, jobB, 11_111, 2);
console.log(`  set $111.11 on a 33-night job before the mark: ${setB.kind}, changed ${setB.changed}, history ${setB.job.history.map((e) => e.action).join(',')}`);
const bMark = await mark(ANA, jobB, '2028-11-10');
console.log(`  the mark: ${bMark.amount} · from ${bMark.from} · amountFrom ${bMark.amountFrom} (the long-term base is ${$(PRICES.longTermCents)})`);
check(bMark.amount === '$111.11' && bMark.amountFrom === 'job', 'a per-job amount beats all three tiers');
const locked = await sj.setJobAmount(ADMIN, jobB, 12_300, doc('cleaning_jobs', jobB).history.length);
console.log(`  changing it after the mark counted its money: ${locked.kind}`);
check(locked.kind === 'locked', 'the amount is locked once a mark\'s cleaning counts its money');
const jobB2 = seedJob(P, '2028-11-08', '2028-11-11', [ANA, BEN]);
await sj.setJobAmount(ADMIN, jobB2, 10_300, 3);
const b2 = await mark(ANA, jobB2, '2028-11-11');
console.log(`  $103.00 on a two-cleaner job: Ana's mark ${b2.amount} (${b2.from})`);
check(b2.amount === 'none', 'two cleaners: the job\'s amount gives no cleaning an amount; the admin types the split');
const hand = pr.handLogSuggestion(PRICES, { reservation: { start: '2028-10-08' }, checkout: '2028-11-10', tier: null, amountCents: 11_111 });
console.log(`  a cleaning by hand on the job's day starts from: ${JSON.stringify(hand)}`);
check(hand.from === 'job' && hand.cents === 11_111, 'logging by hand on that day starts from the job\'s amount');
const added = await sj.addJob(ADMIN, { propertyId: Q, checkout: '2028-11-12', cleanerId: ANA.id, tier: 'mid', amountCents: null }, at('2028-11-10'));
console.log(`  a job added by hand on Q (no prices), mid tier, Ana on it: ${added.kind} · origin ${added.job?.origin} · tier ${added.job?.tier} · reservation ${added.job?.reservation} · history ${added.job?.history.map((e) => e.action).join(',')} · reads back ${jm.readJob(added.job.id, doc('cleaning_jobs', added.job.id)) !== null}`);
check(added.kind === 'added' && added.job.origin === 'admin' && added.job.tier === 'mid' && added.job.cleanerIds[0] === ANA.id, 'Add a job (ruling C): by hand, a chosen tier, a cleaner on it, read back strictly');
check((await sj.addJob(ADMIN, { propertyId: Q, checkout: '2028-11-12', cleanerId: null, tier: 'short', amountCents: null })).kind === 'exists', 'one job a day per property: a second add is refused');
const plan = sync.planJob(jm.readJob(added.job.id, doc('cleaning_jobs', added.job.id)), { version: 1, refreshedAt: '2028-11-12T12:00:00.000Z', today: '2028-11-12', horizonEnd: '2029-11-12', run: {}, properties: { [Q]: { name: 'Test Unpriced', icalUrl: 'x', status: 'ok', fetchedAt: '2028-11-12T12:00:00.000Z', bytes: 1, eventCount: 0, events: [] } } }, 'k', '2028-11-12T12:00:00.000Z');
console.log(`  the calendar sync's plan for the job added by hand, its property read with no reservation: ${plan === null ? 'nothing (left as it is)' : JSON.stringify(plan)}`);
check(plan === null, 'the calendar never changes a job added by hand');
const qMark = await mark(ANA, added.job.id, '2028-11-12');
console.log(`  Ana's mark on it (Q has no prices): ${qMark.kind} · ${qMark.amount} · from ${qMark.from}`);
check(qMark.kind === 'marked' && qMark.amount === 'none' && qMark.from === 'mid', 'marked like any job; no mid preset on Q, so no amount');
const swapped = await sj.swapCleaner(ADMIN, seedJob(P, '2028-11-10', '2028-11-13', [ANA]), ANA.id, BEN.id, 2, at('2028-11-12'));
console.log(`  Change cleaner (ruling D): ${swapped.kind} · on it ${swapped.job?.cleanerIds.join(',')} · last events ${swapped.job?.history.slice(-2).map((e) => `${e.action}(${e.cleanerName}: ${e.reason})`).join(' ')}`);
check(swapped.kind === 'swapped' && swapped.job.cleanerIds.join() === BEN.id && !(ANA.id in swapped.job.assignments), 'one swap: Ana off, Ben on, both logged');

// ═══ 3. Record as cleaned (ruling E) ═══
console.log('\n═══ 3. Record as cleaned by an admin equals the cleaner\'s own mark (ruling E) ═══');
const jobE1 = seedJob(P, '2028-11-11', '2028-11-14', [ANA]);
const jobE2 = seedJob(P, '2028-11-12', '2028-11-15', [ANA]);
const own = await mark(ANA, jobE1, '2028-11-14');
const recorded = await sj.recordCleaned(ADMIN, jobE2, [ANA.id], 2, at('2028-11-15'));
const rec = doc('cleanings', recorded.cleanings[0].cleaningId);
const strip = (c) => ({ ...c, day: '<day>', createdAt: '<at>', jobId: '<job>', actor: '<actor>', history: c.history.map((e) => ({ ...e, at: '<at>', actor: '<actor>', reason: '<reason>' })) });
console.log(`  recorded: ${recorded.kind} · ${$(rec.amountCents)} · from ${rec.suggested.from} · amountFrom ${rec.amountFrom} · actor ${rec.actor.role} · logged by ${rec.history[0].actor.role} (${rec.history[0].reason}) · the job's marked event by ${recorded.job.history.at(-1).actor.role} for ${recorded.job.history.at(-1).cleanerName}`);
check(JSON.stringify(strip(own.c)) === JSON.stringify(strip(rec)), 'the stored cleaning is the same as the cleaner\'s own mark, but for who made it and when');
check(rec.actor.role === 'admin' && rec.history[0].reason === 'recorded by the office' && recorded.job.history.at(-1).actor.id === ADMIN.id && recorded.job.history.at(-1).cleanerId === ANA.id, 'the audit trail names the admin, and the cleaner it was recorded for');
const entryOf = (c) => cm.cleaningEntryView({ ...c, id: c === own.c ? own.id : recorded.cleanings[0].cleaningId, cleaner: { state: 'found', name: ANA.name, status: 'active' }, property: { state: 'found', name: 'Test Tiered' } });
const lineOf = (entry) => st.buildStatement({ propertyId: P, propertyName: 'Test Tiered', month: '2028-11', entries: [entry], reports: [], draft: null, management: null });
const lineOwn = lineOf(entryOf(own.c));
const lineRec = lineOf(entryOf(rec));
const rowWords = (built) => built.statement.costs.map((row) => `${row.description} ${$(row.totalCents)} kind ${row.kind}`).join(' | ');
console.log(`  the statement's cost rows: own mark → ${rowWords(lineOwn)}; recorded → ${rowWords(lineRec)}`);
check(lineOwn.statement.costs[0].totalCents === lineRec.statement.costs[0].totalCents && lineOwn.statement.costs[0].kind === lineRec.statement.costs[0].kind && lineRec.statement.costs[0].totalCents === 8_700, 'the statement charges the same cleaning line either way');
const payOf = (c, id) => pay.memberPay(ANA.id, { cleanings: [{ ...c, id }], entries: [], payments: [] });
console.log(`  pay: own ${$(payOf(own.c, own.id).earnedCents)} · recorded ${$(payOf(rec, recorded.cleanings[0].cleaningId).earnedCents)}`);
check(payOf(own.c, own.id).earnedCents === payOf(rec, recorded.cleanings[0].cleaningId).earnedCents, 'the cleaner is owed the same either way');
const early = await sj.recordCleaned(ADMIN, seedJob(P, '2028-11-14', '2028-11-20', [ANA]), [ANA.id], 2, at('2028-11-15'));
console.log(`  a job whose day has not come: ${early.kind} (opens ${early.opensOn})`);
check(early.kind === 'too-early', 'only a job whose day has come');
check((await sj.recordCleaned(ADMIN, jobE2, [ANA.id], 3, at('2028-11-15'))).kind === 'nothing-to-record', 'recording again counts nothing twice');

// ═══ 4. Ask for extra (ruling F) ═══
console.log('\n═══ 4. "Ask for extra" holds the money until an admin decides (ruling F) ═══');
const jobF = seedJob(P, '2028-11-13', '2028-11-16', [ANA]);
const asked = await mark(ANA, jobF, '2028-11-16', { note: 'Left the keys in the box', extraReason: 'Deep clean after a party' });
const jobAfter = doc('cleaning_jobs', jobF);
console.log(`  the mark with a note and an extra: ${asked.kind} · ${asked.amount} (${asked.amountFrom}) · extra ${asked.extra} "${asked.c.extra.reason}" · note "${asked.c.note}" · the job's assignment: extraAsked ${jobAfter.assignments[ANA.id].extraAsked}, note "${jobAfter.assignments[ANA.id].note}" · its marked event carries note/extra: ${jobAfter.history.at(-1).note !== undefined}/${jobAfter.history.at(-1).extra !== undefined}`);
check(asked.extra === 'asked' && asked.amount === '$87.00' && jobAfter.assignments[ANA.id].extraAsked === true, 'the cleaning arrives with the base amount, its extra asked, the job flagged');
const view = (c, id) => ({ ...c, id, cleaner: { state: 'found', name: ANA.name, status: 'active' }, property: { state: 'found', name: 'Test Tiered' } });
const askedEntry = cm.cleaningEntryView(view(asked.c, asked.id));
const askedBuilt = lineOf(askedEntry);
const askedPay = pay.memberPay(ANA.id, { cleanings: [view(asked.c, asked.id)], entries: [], payments: [] });
console.log(`  while asked: entry status ${askedEntry.status} (${askedEntry.linesNow.kind === 'unreadable' ? askedEntry.linesNow.reason : ''}) · statement cost rows ${askedBuilt.statement.costs.length} · pay earned ${$(askedPay.earnedCents)}, extraAsked ${askedPay.extraAsked}, row state ${askedPay.rows[0].state} "${askedPay.rows[0].note}"`);
check(askedEntry.status === 'pending' && askedBuilt.statement.costs.length === 0 && askedPay.earnedCents === 0 && askedPay.extraAsked === 1, 'the money is absent from the statement and the pay');
const st4 = jm.jobState({ status: 'open', change: null, checkout: '2028-11-16', cleanerIds: [ANA.id], assignees: [{ cleanerId: ANA.id, name: ANA.name, nameAtAssignment: ANA.name, assignedAt: 'x', assignedBy: ADMIN, cleaningId: asked.id, markedAt: 'x', removedAt: null, removedBy: null, note: null, extraAsked: true, status: 'active', state: 'found', cleaning: { state: 'found', status: 'logged', amountCents: 8_700, amountFrom: 'short', extra: 'asked', seen: 1 } }] }, '2028-11-16');
const cell = standing.cleaningStanding([{ propertyId: P, checkout: '2028-11-16', status: 'open', changedAfterMark: false, change: null, cleaners: [{ name: ANA.name, marked: true, removed: false, pending: false, extra: true }] }], { today: '2028-11-16', hasCalendar: true, calendarRead: true });
console.log(`  the Schedule says "${st4.label}" (${st4.tone}); the home's cell "${cell.label}" (${cell.tone})`);
check(st4.label === 'Cleaned · extra asked' && st4.tone === 'extra' && cell.label === 'Extra asked' && cell.tone === 'warning', 'the Schedule reads "Cleaned · extra asked" in amber; the home\'s cell "Extra asked"');
const finish = checks.finishChecks ? null : null;
const approved = await cl.decideExtra(ADMIN, asked.id, 'approve', 12_300, 1, null);
const approvedDoc = doc('cleanings', asked.id);
console.log(`  approved at $123.00: ${approved.kind} · ${$(approvedDoc.amountCents)} (${approvedDoc.amountFrom}) · extra ${approvedDoc.extra.status} by ${approvedDoc.extra.decidedBy.name} · last event ${approvedDoc.history.at(-1).action} ${$(approvedDoc.history.at(-1).before?.amountCents)} → ${$(approvedDoc.history.at(-1).after?.amountCents)}`);
const approvedView = view(cm.readCleaning(asked.id, approvedDoc), asked.id);
const approvedBuilt = lineOf(cm.cleaningEntryView(approvedView));
const approvedPay = pay.memberPay(ANA.id, { cleanings: [approvedView], entries: [], payments: [] });
console.log(`  then: statement row ${rowWords(approvedBuilt)} · pay earned ${$(approvedPay.earnedCents)} · changes ${approvedPay.rows[0].changes.map((c) => c.words).join('; ')}`);
check(approvedBuilt.statement.costs[0]?.totalCents === 12_300 && approvedPay.earnedCents === 12_300 && approvedDoc.amountFrom === 'typed', 'approved with a new amount: it appears at that amount, on the statement and in pay');
const jobF2 = seedJob(P, '2028-11-14', '2028-11-17', [ANA]);
const asked2 = await mark(ANA, jobF2, '2028-11-17', { note: null, extraReason: 'Extra load of laundry' });
const declined = await cl.decideExtra(ADMIN, asked2.id, 'decline', undefined, 1, null);
const declinedDoc = doc('cleanings', asked2.id);
const declinedView = view(cm.readCleaning(asked2.id, declinedDoc), asked2.id);
console.log(`  declined: ${declined.kind} · ${$(declinedDoc.amountCents)} (${declinedDoc.amountFrom}) · extra ${declinedDoc.extra.status} · statement row ${rowWords(lineOf(cm.cleaningEntryView(declinedView)))} · pay earned ${$(pay.memberPay(ANA.id, { cleanings: [declinedView], entries: [], payments: [] }).earnedCents)}`);
check(declinedDoc.amountCents === 8_700 && declinedDoc.extra.status === 'declined' && pay.memberPay(ANA.id, { cleanings: [declinedView], entries: [], payments: [] }).earnedCents === 8_700, 'declined: the base amount counts');
check((await cl.decideExtra(ADMIN, asked2.id, 'approve', undefined, 2, null)).kind === 'not-asked', 'a decided extra cannot be decided again');
const schema = sc.JobActionSchema.safeParse({ action: 'mark', note: '  ', extraReason: 'x' });
console.log(`  the route's body: ${schema.success ? JSON.stringify(schema.data) : 'refused'} · undo ${sc.JobActionSchema.safeParse({ action: 'undo' }).success} · an amount in a mark body: ${sc.JobActionSchema.safeParse({ action: 'mark', amount: '83.00' }).success ? 'ACCEPTED' : 'refused'}`);
check(schema.success && schema.data.note === null && !sc.JobActionSchema.safeParse({ action: 'mark', amount: '83.00' }).success, 'a mark carries a note and a reason, never an amount (ruling H)');
const cleanerView = await sj.cleanerJobsRead(ANA.id, '2028-11-16');
const keys = [...new Set(cleanerView.flatMap((j) => Object.keys(j)))].sort();
console.log(`  what the cleaner's app is sent per job: ${keys.join(', ')}`);
check(!keys.some((k) => /amount|price|cents|rate/i.test(k)) && cleanerView.find((j) => j.id === jobF)?.extraAsked === true, 'no amount, price or rate reaches the cleaner; the extra flag does');
const jobG = { propertyId: P, checkout: '2028-11-16', status: 'open', changedAfterMark: false, change: null, cleaners: [] };
const noLink = standing.cleaningStanding([], { today: '2028-11-16', hasCalendar: false, calendarRead: false });
console.log(`  a property with no calendar link (ruling G): "${noLink.label}" (${noLink.tone}, ${noLink.key})`);
check(noLink.label === 'No calendar' && noLink.tone === 'none', 'no link reads "No calendar", grey');
void jobG;
void finish;

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`);
if (failures) process.exitCode = 1;
