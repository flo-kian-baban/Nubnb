// Build 2 (Kian's rulings of 2026-11-02 and 2026-11-03): one cleaner per job and any number of jobs on a property and
// day (item 1), deleting a job and the marker the calendar sync honours (item 2), and a missing amount's field never
// holding a suggestion (item 3), plus the one word per state (item 5). The server functions run on an in-memory
// Firestore (tests/tools/memory-firestore.cjs): nothing is read from or written to Firestore or Storage, and every
// connection is refused. Made-up data only: properties "TESTPROP…", cleaners "Test …", amounts made up (written with
// separators, never a real rate).
//   node --import ./tests/tools/ts-hook.mjs tests/schedule/build2.mjs
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
const sc = await import(`${ROOT}/app/lib/cleanings/schemas.ts`);
const jm = await import(`${ROOT}/app/lib/schedule/model.ts`);
const sync = await import(`${ROOT}/app/lib/schedule/sync.ts`);
const store = await import(`${ROOT}/app/lib/schedule/store.ts`);
const standing = await import(`${ROOT}/app/lib/schedule/standing.ts`);
const home = await import(`${ROOT}/app/lib/home/next-step.ts`);
const sp = await import(`${ROOT}/app/lib/firebase/server-cleaning-prices.ts`);
const sj = await import(`${ROOT}/app/lib/firebase/server-cleaning-jobs.ts`);
const pay = await import(`${ROOT}/app/lib/pay/balance.ts`);
const payChecks = await import(`${ROOT}/app/lib/pay/checks.ts`);
const serverPay = await import(`${ROOT}/app/lib/firebase/server-pay.ts`);
const cleanersModel = await import(`${ROOT}/app/lib/cleaners/model.ts`);
const { getAdminDb } = await import(`${ROOT}/app/lib/firebase/admin.ts`);
const seed = globalThis.__memSeed;
const doc = globalThis.__memDoc;

let failures = 0;
const check = (ok, label) => {
  if (!ok) failures += 1;
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${label}`);
};
const $ = (cents) => (cents === null || cents === undefined ? 'none' : `$${(cents / 100).toFixed(2)}`);

const ADMIN = { role: 'admin', id: 'TESTADMINbuild2aaaa1', name: 'Test admin' };
const P = 'TESTPROPbuild2aaaa01'; // prices for all three tiers
const S = 'TESTPROPbuild2aaaa02'; // prices; the calendar's jobs, deleted and read again
const ANA = { id: 'TESTCLEANERbuild2ana', name: 'Test Ana' };
const BEN = { id: 'TESTCLEANERbuild2ben', name: 'Test Ben' };
const PRICES = { shortTermCents: 6_700, midTermCents: 7_700, longTermCents: 10_700 };
const LINK = (id) => `https://www.airbnb.ca/calendar/ical/${id}.ics?s=made-up`;
const property = (id, name) => seed('properties', id, { name, icalUrl: LINK(id), details: { checkOut: '11:00', checkIn: '16:00' }, addressDetails: { city: 'Toronto' } });
property(P, 'Test Priced');
property(S, 'Test Synced');
for (const m of [ANA, BEN]) seed('cleaners', m.id, { schemaVersion: 2, name: m.name, role: 'cleaner', status: 'active', sessionEpoch: 1, history: [] });
await sp.setCleaningPrices(ADMIN, P, PRICES);
await sp.setCleaningPrices(ADMIN, S, PRICES);
const TODAY = '2028-11-20';
const at = (day) => new Date(`${day}T18:00:00.000Z`);
const { calendarKeyOf } = store;
/** A calendar job in the written shape (schema version 3), `cleaners` on it. */
const seedJob = (pid, uid, start, checkout, cleaners) => {
  const id = jm.jobIdOf(pid, checkout);
  const made = `${start}T12:00:00.000Z`;
  seed('cleaning_jobs', id, { schemaVersion: jm.JOB_SCHEMA_VERSION, propertyId: pid, propertyNameAtCreation: 'Test', checkout, reservation: { uid, start }, calendarKey: calendarKeyOf(LINK(pid)), origin: 'calendar', tier: null, amountCents: null, label: null, nextCheckIn: null, status: 'open', change: null, cleanerIds: cleaners.map((m) => m.id), assignments: Object.fromEntries(cleaners.map((m) => [m.id, jm.newAssignment(m.name, made, ADMIN)])), createdAt: made, history: [jm.jobEvent(made, 'created', jm.CALENDAR_ACTOR, { after: { start, end: checkout } }), ...cleaners.map((m) => jm.jobEvent(made, 'assigned', ADMIN, { cleanerId: m.id, cleanerName: m.name }))] });
  return id;
};
const mark = async (m, id, day) => {
  const r = await sj.markCleaned({ id: m.id, name: m.name }, id, at(day), {});
  const c = r.kind === 'marked' ? doc('cleanings', r.cleaningId) : null;
  return { kind: r.kind, id: r.cleaningId, amount: $(c?.amountCents), amountFrom: c?.amountFrom, c };
};

// ═══ 1. One cleaner per job; any number of jobs on one property and day ═══
console.log('═══ 1. One cleaner per job; any number of jobs on one property and day (item 1) ═══');
const turnover = seedJob(P, 'r-turnover@airbnb.com', '2028-11-17', TODAY, [ANA]);
const two = await sj.setAssignees(ADMIN, turnover, [ANA.id, BEN.id], 2);
console.log(`  a second cleaner put on the turnover: ${two.kind} — "${sj.ASSIGN_REFUSALS['one-cleaner'].message}" · on it still ${doc('cleaning_jobs', turnover).cleanerIds.length} · MAX_ASSIGNEES ${sj.MAX_ASSIGNEES}`);
check(two.kind === 'one-cleaner' && doc('cleaning_jobs', turnover).cleanerIds.length === 1 && sj.MAX_ASSIGNEES === 1, 'a job has one cleaner: a second is refused, nothing written');
const toBen = await sj.setAssignees(ADMIN, turnover, [BEN.id], 2);
const toNobody = await sj.setAssignees(ADMIN, doc('cleaning_jobs', turnover) && turnover, [], toBen.job.history.length);
console.log(`  Ana off, Ben on in one save: ${toBen.kind}, on it ${toBen.job.cleanerIds.join(',') === BEN.id ? 'Ben' : toBen.job.cleanerIds.join(',')} · then nobody: ${toNobody.kind}, on it ${toNobody.job.cleanerIds.length === 0 ? 'nobody' : toNobody.job.cleanerIds.join(',')}`);
check(toBen.kind === 'saved' && toBen.job.cleanerIds.join() === BEN.id && toNobody.kind === 'saved' && toNobody.job.cleanerIds.length === 0, 'Assign is a single choice: one cleaner, or nobody');
check(!sc.JobPatchSchema.safeParse({ cleanerIds: [ANA.id, BEN.id], seen: 2 }).success && sc.JobPatchSchema.safeParse({ cleanerIds: [ANA.id], seen: 2 }).success && sc.JobPatchSchema.safeParse({ cleanerIds: [], seen: 2 }).success && !sc.RecordJobSchema.safeParse({ cleanerIds: [ANA.id, BEN.id], seen: 2 }).success, 'the routes take one cleaner or none, never two');

const deep = await sj.addJob(ADMIN, { propertyId: P, checkout: TODAY, cleanerId: ANA.id, tier: 'short', amountCents: 4_400, label: 'Deep clean' }, at('2028-11-19'));
const visit = await sj.addJob(ADMIN, { propertyId: P, checkout: TODAY, cleanerId: BEN.id, tier: 'short', amountCents: null, label: null }, at('2028-11-19'));
const third = await sj.addJob(ADMIN, { propertyId: P, checkout: TODAY, cleanerId: null, tier: 'long', amountCents: null, label: 'Windows' }, at('2028-11-19'));
console.log(`  three jobs added on P today beside its turnover: ${[deep, visit, third].map((r) => `${r.kind} "${r.job?.label}" ${r.job?.cleanerIds.join(',') || 'nobody'} ${$(r.job?.amountCents)} ${r.job?.tier}`).join(' | ')}`);
console.log(`  their IDs: ${[deep, visit, third].map((r) => jm.jobIdParts(r.job.id)?.added ? 'turnover+suffix' : 'turnover').join(', ')} · all distinct ${new Set([turnover, deep.job.id, visit.job.id, third.job.id]).size === 4} · each reads back ${[deep, visit, third].every((r) => jm.readJob(r.job.id, doc('cleaning_jobs', r.job.id)) !== null)} · history reason "${deep.job.history[0].reason}"`);
check(deep.kind === 'added' && visit.kind === 'added' && third.kind === 'added' && new Set([turnover, deep.job.id, visit.job.id, third.job.id]).size === 4, 'any number of jobs on one property and day: no JOB_EXISTS, each its own ID');
check(deep.job.label === 'Deep clean' && visit.job.label === jm.DEFAULT_JOB_LABEL && jm.jobLabel(doc('cleaning_jobs', turnover)) === 'Turnover', 'each added job has its label ("Extra visit" when none is typed); the calendar\'s reads "Turnover"');
check([deep, visit, third].every((r) => jm.isJobId(r.job.id) && jm.readJob(r.job.id, doc('cleaning_jobs', r.job.id)) !== null), 'added jobs\' IDs pass the routes\' pattern and read back strictly');
const calendarWithSuffix = { ...doc('cleaning_jobs', turnover) };
check(jm.readJob(`${turnover}_abc123`, calendarWithSuffix) === null && jm.readJob(deep.job.id, { ...doc('cleaning_jobs', deep.job.id), label: 'x'.repeat(jm.JOB_LABEL_MAX + 1) }) === null && jm.readJob(turnover, { ...calendarWithSuffix, label: 'Deep clean' }) === null, 'refused as not in shape: a suffix on a calendar job, a label too long, a label on a calendar job');
check(sc.AddJobSchema.safeParse({ propertyId: P, checkout: TODAY, cleanerId: null, tier: 'short', label: 'Deep clean' }).success && !sc.AddJobSchema.safeParse({ propertyId: P, checkout: TODAY, cleanerId: null, tier: 'short', label: 'x'.repeat(jm.JOB_LABEL_MAX + 1) }).success && sc.AddJobSchema.safeParse({ propertyId: P, checkout: TODAY, cleanerId: null, tier: 'short' }).data.label === null, 'the route takes a label of at most 40 characters, none meaning the default');

const anaSees = await sj.cleanerJobsRead(ANA.id, TODAY);
const benSees = await sj.cleanerJobsRead(BEN.id, TODAY);
console.log(`  Ana's app today: ${anaSees.map((j) => `${j.label ?? 'turnover'}`).join(', ')} · Ben's: ${benSees.map((j) => `${j.label ?? 'turnover'}`).join(', ')} · keys per job: ${[...new Set(anaSees.flatMap((j) => Object.keys(j)))].sort().join(', ')}`);
check(anaSees.length === 1 && anaSees[0].id === deep.job.id && anaSees[0].label === 'Deep clean' && benSees.length === 1 && benSees[0].id === visit.job.id && benSees[0].label === jm.DEFAULT_JOB_LABEL, 'each cleaner sees only their own job, by its label');
check(!anaSees.some((j) => Object.keys(j).some((k) => /amount|price|cents|rate/i.test(k))), 'the label reaches the app; no amount does (ruling H)');
const anaMark = await mark(ANA, deep.job.id, TODAY);
const benMark = await mark(BEN, visit.job.id, TODAY);
console.log(`  Ana marks "Deep clean" ($44.00 on the job): ${anaMark.amount} (${anaMark.amountFrom}) · Ben marks "Extra visit" (no amount on the job): ${benMark.amount} (${benMark.amountFrom})`);
check(anaMark.amount === '$44.00' && anaMark.amountFrom === 'job' && benMark.amount === '$67.00' && benMark.amountFrom === 'short', 'each mark counts its own amount: the job\'s, else the property\'s cleaning price for its tier');
const view = (r, who) => ({ ...r.c, id: r.id, cleaner: { state: 'found', name: who.name, status: 'active' }, property: { state: 'found', name: 'Test Priced' } });
const anaPay = pay.memberPay(ANA.id, { cleanings: [view(anaMark, ANA), view(benMark, BEN)], entries: [], payments: [] });
const benPay = pay.memberPay(BEN.id, { cleanings: [view(anaMark, ANA), view(benMark, BEN)], entries: [], payments: [] });
console.log(`  pay: Ana earned ${$(anaPay.earnedCents)} · Ben earned ${$(benPay.earnedCents)}`);
check(anaPay.earnedCents === 4_400 && benPay.earnedCents === 6_700, 'each is owed their own job\'s amount');
const noSplit = pr.markAmount(PRICES, { cleanerIds: [ANA.id, BEN.id], reservation: { start: '2028-11-10' }, checkout: TODAY });
console.log(`  markAmount no longer knows a split: ${JSON.stringify(noSplit)}`);
check(noSplit.from !== 'split' && noSplit.cents === PRICES.midTermCents, 'the two-cleaner split is gone from new work (an older cleaning\'s "split" still reads)');
check(cm.readCleaning('old', { ...anaMark.c, amountCents: null, amountFrom: null, suggested: { from: 'split', cents: null } }) !== null && pr.amountSourceWords({ amountCents: null, suggested: { from: 'split', cents: null } }) === 'needs an amount: several cleaners were on the job', 'reading an older two-cleaner share still works, in the new words');

// ═══ 2. Delete a job ═══
console.log('\n═══ 2. Delete a job (item 2): the job and its cleaning go; a calendar job leaves a marker the sync honours ═══');
const unmarked = seedJob(S, 'r-one@airbnb.com', '2028-11-18', TODAY, [ANA]);
const seen = doc('cleaning_jobs', unmarked).history.length;
const wrongSeen = await sj.deleteJob(ADMIN, unmarked, seen + 1, at(TODAY));
const deleted = await sj.deleteJob(ADMIN, unmarked, seen, at(TODAY));
const marker = doc('deleted_cleaning_jobs', unmarked);
console.log(`  delete with a stale seen: ${wrongSeen.kind} · delete: ${deleted.kind}, cleanings ${deleted.cleanings}, marker ${deleted.marker} · the job now: ${doc('cleaning_jobs', unmarked) == null ? 'gone' : 'still there'} · marker: ${marker ? `${marker.reservation.uid} ${marker.reservation.start}→${marker.checkout} by ${marker.deletedBy.name}` : 'none'} · reads back ${jm.readDeletedJob(unmarked, marker) !== null}`);
check(wrongSeen.kind === 'changed-since' && deleted.kind === 'deleted', 'a stale page is refused first; then the delete goes through');
check(deleted.kind === 'deleted' && deleted.marker === true && deleted.cleanings === 0 && doc('cleaning_jobs', unmarked) == null && jm.readDeletedJob(unmarked, marker)?.reservation.uid === 'r-one@airbnb.com', 'an unmarked calendar job: deleted; a minimal marker keyed by the turnover holds the booking');
check(jm.readDeletedJob('otherid', marker) === null && jm.readDeletedJob(unmarked, { ...marker, reservation: { uid: 'x' } }) === null, 'a marker is read strictly');

const RUN = `${TODAY}T14:00:00.000Z`;
const copy = (events) => ({ version: 1, refreshedAt: RUN, today: TODAY, horizonEnd: '2029-11-20', run: { source: 'manual', startedAt: RUN, finishedAt: RUN, durationMs: 0, fetched: 1, failed: [], pagesChecked: 0 }, properties: { [S]: { name: 'Test Synced', icalUrl: LINK(S), status: 'ok', fetchedAt: RUN, bytes: 1, eventCount: events.length, events } } });
const reserved = (uid, start, end) => ({ uid, kind: 'reserved', start, end });
const same = await store.syncJobs(getAdminDb(), copy([reserved('r-one@airbnb.com', '2028-11-18', TODAY)]));
console.log(`  the next calendar read, the same booking still ending today: created ${same.created}, changed ${same.changed}, failed ${same.failed} · the job: ${doc('cleaning_jobs', unmarked) == null ? 'not made again' : 'MADE AGAIN'}`);
check(same.created === 0 && same.failed === null && doc('cleaning_jobs', unmarked) == null, 'the sync does not recreate a deleted job while its booking stands');
const pure = sync.planCreates({ snapshot: copy([reserved('r-one@airbnb.com', '2028-11-18', TODAY)]), existing: new Set(), keys: new Map([[S, calendarKeyOf(LINK(S))]]), nowIso: RUN, deleted: new Map([[unmarked, { uid: 'r-one@airbnb.com', start: '2028-11-18' }]]) });
const movedIn = sync.planCreates({ snapshot: copy([reserved('r-one@airbnb.com', '2028-11-19', TODAY)]), existing: new Set(), keys: new Map([[S, calendarKeyOf(LINK(S))]]), nowIso: RUN, deleted: new Map([[unmarked, { uid: 'r-one@airbnb.com', start: '2028-11-18' }]]) });
console.log(`  planned, pure: the same booking ${pure.length} · its check-in moved ${movedIn.length}`);
check(pure.length === 0 && movedIn.length === 1, 'the marker holds the booking: a moved check-in is a changed booking, so a new job may be made');
const changed = await store.syncJobs(getAdminDb(), copy([reserved('r-two@airbnb.com', '2028-11-19', TODAY)]));
const remade = doc('cleaning_jobs', unmarked);
console.log(`  another booking ends today under a new UID: created ${changed.created} · the job: ${remade ? `made again (${remade.reservation.uid}, nobody on it: ${remade.cleanerIds.length === 0})` : 'not made'}`);
check(changed.created === 1 && remade?.reservation.uid === 'r-two@airbnb.com', 'a changed booking makes a new job');

const added = await sj.addJob(ADMIN, { propertyId: S, checkout: TODAY, cleanerId: ANA.id, tier: 'short', amountCents: null, label: 'Extra visit' }, at('2028-11-19'));
const addedGone = await sj.deleteJob(ADMIN, added.job.id, added.job.history.length, at(TODAY));
console.log(`  a job added by hand, deleted: ${addedGone.kind}, marker ${addedGone.marker} · markers now ${doc('deleted_cleaning_jobs', added.job.id) == null ? 'none for it' : 'ONE'}`);
check(addedGone.kind === 'deleted' && addedGone.marker === false && doc('deleted_cleaning_jobs', added.job.id) == null, 'a job added by hand leaves no marker: the calendar never made it');

const markedJob = seedJob(S, 'r-marked@airbnb.com', '2028-11-15', '2028-11-18', [ANA]);
const markedMark = await mark(ANA, markedJob, '2028-11-18');
const markedGone = await sj.deleteJob(ADMIN, markedJob, doc('cleaning_jobs', markedJob).history.length, at(TODAY));
console.log(`  a marked job (cleaning ${markedMark.amount}, counted nowhere yet), deleted: ${markedGone.kind}, cleanings ${markedGone.cleanings} · the cleaning: ${doc('cleanings', markedMark.id) == null ? 'gone' : 'still there'}`);
check(markedGone.kind === 'deleted' && markedGone.cleanings === 1 && doc('cleanings', markedMark.id) == null, 'its cleaning goes with it while nothing counts it');

const paidJob = seedJob(S, 'r-paid@airbnb.com', '2028-11-14', '2028-11-16', [ANA]);
const paidMark = await mark(ANA, paidJob, '2028-11-16');
const payment = await serverPay.recordPayment(ADMIN, { memberId: ANA.id, amountCents: 6_700, day: '2028-11-17', method: 'e-transfer', note: null, seen: 0 }, at('2028-11-17'));
const paidRefused = await sj.deleteJob(ADMIN, paidJob, doc('cleaning_jobs', paidJob).history.length, at(TODAY));
console.log(`  payment to Ana dated Nov 17: ${payment.kind} · deleting the Nov 16 job: ${paidRefused.kind}${paidRefused.kind === 'cleaning-paid' ? ` (${paidRefused.name}, ${$(paidRefused.payment.amountCents)} on ${paidRefused.payment.day})` : ''} · job still there ${doc('cleaning_jobs', paidJob) != null} · cleaning still there ${doc('cleanings', paidMark.id) != null} · marker none ${doc('deleted_cleaning_jobs', paidJob) == null}`);
check(paidRefused.kind === 'cleaning-paid' && paidRefused.payment.id === payment.payment.id && doc('cleaning_jobs', paidJob) != null && doc('cleanings', paidMark.id) != null && doc('deleted_cleaning_jobs', paidJob) == null, 'refused: its cleaning is counted in a recorded payment; nothing deleted, no marker');

const printedJob = seedJob(S, 'r-printed@airbnb.com', '2028-11-10', '2028-11-13', [BEN]);
const printedMark = await mark(BEN, printedJob, '2028-11-13');
seed('monthly_reports', 'TESTREPORTbuild2aaa1', { propertyId: S, month: '2028-11', reference: 'Nov-Test', entryIds: [printedMark.id], costs: [], adjustments: [] });
const printedRefused = await sj.deleteJob(ADMIN, printedJob, doc('cleaning_jobs', printedJob).history.length, at(TODAY));
console.log(`  a finished statement prints Ben's Nov 13 cleaning: deleting its job: ${printedRefused.kind}${printedRefused.kind === 'cleaning-printed' ? ` (${printedRefused.name}, ${printedRefused.months.join(',')})` : ''} · job still there ${doc('cleaning_jobs', printedJob) != null}`);
check(printedRefused.kind === 'cleaning-printed' && printedRefused.months.join() === '2028-11' && doc('cleaning_jobs', printedJob) != null, 'refused: its cleaning is printed on a finished statement; nothing deleted');
check(sc.DeleteJobSchema.safeParse({ seen: 3 }).success && !sc.DeleteJobSchema.safeParse({}).success && !sc.DeleteJobSchema.safeParse({ seen: 3, reason: 'x' }).success, 'the route takes `seen` and nothing else: no reason is asked');
check(sj.DELETE_JOB_REFUSALS['changed-since'].code === 'JOB_CHANGED' && sj.DELETE_JOB_REFUSALS.failed.code === 'JOB_DELETE_FAILED', 'the refusals name their codes');

// ═══ 3. Never save a suggestion ═══
console.log('\n═══ 3. Never save a suggestion (item 3): how a missing amount\'s field opens ═══');
const T = 'TESTPROPbuild2aaaa03';
const facts = (id, day, cents, amountFrom, jobId, from = 'short') => ({ id, propertyId: T, day, createdAt: `${day}T18:00:00.000Z`, status: 'logged', amountCents: cents, amountFrom, suggested: { from, cents: null }, jobId });
const jobs = { [`${T}_2028-11-10`]: { nights: 2, cleaners: 1 }, [`${T}_2028-11-12`]: { nights: 3, cleaners: 1 }, [`${T}_2028-11-14`]: { nights: 2, cleaners: 2 }, [`${T}_2028-11-16`]: { nights: 2, cleaners: 1, amountCents: 5_500 } };
const earlier = [facts('t1', '2028-11-10', 7_300, 'typed', `${T}_2028-11-10`)];
const cases = [
  ['no price, $73 typed before', pr.missingAmountStart(null, earlier, jobs, facts('w1', '2028-11-12', null, null, `${T}_2028-11-12`))],
  ['a short-term cleaning price $67', pr.missingAmountStart(PRICES, earlier, jobs, facts('w2', '2028-11-12', null, null, `${T}_2028-11-12`))],
  ['$55 set on the job', pr.missingAmountStart(null, earlier, jobs, facts('w3', '2028-11-16', null, null, `${T}_2028-11-16`))],
  ['nothing at all', pr.missingAmountStart(null, [], jobs, facts('w4', '2028-11-12', null, null, `${T}_2028-11-12`))],
  ['an older two-cleaner share', pr.missingAmountStart(PRICES, earlier, jobs, facts('w5', '2028-11-14', null, null, `${T}_2028-11-14`))],
];
for (const [label, start] of cases) console.log(`  ${label}: ${start.kind} → ${JSON.stringify(pr.fieldStart(start))}`);
const opens = cases.map(([, start]) => pr.fieldStart(start));
check(cases[0][1].kind === 'recommendation' && opens[0].value === '' && opens[0].placeholder === '73.00' && opens[0].words === 'Last typed for short-term: $73.00', '"Last typed for <tier>: $X" is a placeholder and its words, never the field\'s value');
check(cases[1][1].kind === 'preset' && opens[1].value === '67.00' && opens[1].words === 'Short-term cleaning price: $67.00', 'the property\'s cleaning price fills the field: an amount an admin set');
check(cases[2][1].kind === 'job' && opens[2].value === '55.00' && opens[2].words === 'Set on the job: $55.00', 'the amount set on the job fills the field');
check(cases[3][1].kind === 'none' && opens[3].value === '' && opens[3].placeholder === '' && cases[4][1].kind === 'none' && opens[4].value === '', 'nothing, or an older two-cleaner share: empty, no placeholder');
check(pr.fieldStart(null).value === '' && pr.fieldStart(null).placeholder === '', 'before the starts are read: empty');

// ═══ 4. One word per state (item 5) ═══
console.log('\n═══ 4. One word per state (item 5): the admin\'s words ═══');
const noted = { status: 'open', change: null, checkout: TODAY, cleanerIds: [ANA.id], assignees: [{ cleanerId: ANA.id, name: ANA.name, nameAtAssignment: ANA.name, assignedAt: 'x', assignedBy: ADMIN, cleaningId: 'c', markedAt: 'x', removedAt: null, removedBy: null, note: 'More time', extraAsked: true, status: 'active', state: 'found', cleaning: { state: 'found', status: 'logged', amountCents: 6_700, amountFrom: 'short', extra: 'asked', seen: 1 } }] };
const words = {
  schedule: jm.jobState(noted, TODAY).label,
  homeNote: standing.cleaningStanding([{ propertyId: P, checkout: TODAY, status: 'open', changedAfterMark: false, change: null, cleaners: [{ name: ANA.name, marked: true, removed: false, pending: false, extra: true }] }], { today: TODAY, hasCalendar: true, calendarRead: true }).label,
  homeAmount: standing.cleaningStanding([{ propertyId: P, checkout: TODAY, status: 'open', changedAfterMark: false, change: null, cleaners: [{ name: ANA.name, marked: true, removed: false, pending: true, extra: false }] }], { today: TODAY, hasCalendar: true, calendarRead: true }).label,
  chip: home.CHIPS.find((c) => c.key === 'extra').label,
  entry: cleanersModel.ENTRY_STATUS_LABELS.pending,
  noAmount: cm.NO_AMOUNT_YET,
  extraAsked: cm.EXTRA_ASKED,
  extraWords: cm.extraWords({ status: 'asked', reason: 'More time', askedAt: 'x', decidedAt: null, decidedBy: null }),
  notCounted: payChecks.notCountedWords({ noAmount: 2, waitingReview: 1, extraAsked: 1 }).join(' · '),
  k2: payChecks.recordQuestions({ balanceCents: 1_000, noAmount: 0, waitingReview: 0, cannotAddUp: 0 }, 2_500, 'Test Ana')[0].title,
  k2confirm: payChecks.recordQuestions({ balanceCents: 1_000, noAmount: 0, waitingReview: 0, cannotAddUp: 0 }, 2_500, 'Test Ana')[0].confirm,
  balance: [pay.balanceWords(0).words, pay.balanceWords(-500).words],
  source: pr.AMOUNT_SOURCE_WORDS.short,
  pay: pay.memberPay(ANA.id, { cleanings: [{ id: 'n', cleanerId: ANA.id, cleanerNameAtEntry: ANA.name, day: TODAY, amountCents: null, status: 'logged', history: [{ at: 'x', action: 'logged', actor: ADMIN, reason: null }], extra: null, propertyNameAtEntry: 'P', createdAt: 'x' }], entries: [], payments: [] }).rows[0].note,
  counts: [cm.countsWords('2028-11-20', '2028-11'), cm.countsWords('2026-10-25', '2026-11')],
};
for (const [k, v] of Object.entries(words)) console.log(`  ${k}: ${Array.isArray(v) ? v.join(' · ') : v}`);
check(words.schedule === 'Cleaned · needs a decision' && words.homeNote === 'Needs a decision' && words.chip === 'Needs a decision' && words.entry === 'Needs a decision' && words.extraAsked.startsWith('Needs a decision') && words.extraWords === 'Needs a decision: “More time”', '"Needs a decision": a pending entry, or a cleaning with a note, with the note\'s words');
check(words.homeAmount === 'Needs an amount' && words.noAmount.startsWith('Needs an amount') && words.pay === 'Needs an amount' && words.notCounted === '2 cleanings need an amount · 1 cleaning with a note needs a decision · 1 receipt or work entry needs a decision', '"Needs an amount": a cleaning with no amount');
check(words.k2 === 'Pay $15.00 ahead?' && words.k2confirm === 'Pay ahead' && words.balance.join('|') === 'Settled|Paid ahead $5.00', '"Settled", "Paid ahead", and the question "Pay $X ahead?"');
check(words.source === 'short-term cleaning price' && words.counts[0] === "goes on November 2028's statement" && words.counts[1] === 'counts in pay; statements start November 2026', '"cleaning price"; a decision before the statements floor says "counts in pay; statements start November 2026"');
const retired = JSON.stringify(words);
check(!/extra asked|Extra asked|No amount yet|Amount needed|Waiting for|preset|base price|advance/.test(retired), 'none of the retired words remains in these');

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`);
if (failures) process.exitCode = 1;
