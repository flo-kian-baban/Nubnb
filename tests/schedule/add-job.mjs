// Add a job, the UX pass (Kian's instruction of 2026-11-06): the amount from the property's cleaning price, with no Tier
// control and the tier stored as before (item 2); "Already cleaned", which adds the job and records it cleaned in one
// step exactly as Record as cleaned does (item 4); days back to the statements floor and no further (item 6); and the
// search's order and the quick labels. The server functions run on an in-memory Firestore
// (tests/tools/memory-firestore.cjs): nothing is read from or written to Firestore or Storage, and every connection is
// refused. Made-up data only: properties "TESTPROP…", cleaners "Test …", amounts made up (written with separators,
// never a real rate).
//   node --import ./tests/tools/ts-hook.mjs tests/schedule/add-job.mjs
import { createRequire } from 'node:module';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.NUBNB_ROOT || fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
createRequire(`${ROOT}/package.json`)(`${ROOT}/tests/tools/memory-firestore.cjs`);
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.FIREBASE_SERVICE_ACCOUNT_KEY = JSON.stringify({ type: 'service_account', project_id: 'memory-test', private_key_id: 'memory-test', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), client_email: 'memory-test@memory-test.iam.gserviceaccount.com', client_id: '0', token_uri: 'https://oauth2.invalid/token' });
process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = 'memory-test.appspot.com';
process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = 'memory-test';

const aj = await import(`${ROOT}/app/lib/schedule/add-job.ts`);
const pr = await import(`${ROOT}/app/lib/cleanings/prices.ts`);
const sc = await import(`${ROOT}/app/lib/cleanings/schemas.ts`);
const jm = await import(`${ROOT}/app/lib/schedule/model.ts`);
const sp = await import(`${ROOT}/app/lib/firebase/server-cleaning-prices.ts`);
const sj = await import(`${ROOT}/app/lib/firebase/server-cleaning-jobs.ts`);
const scl = await import(`${ROOT}/app/lib/firebase/server-cleanings.ts`);
const { getAdminDb } = await import(`${ROOT}/app/lib/firebase/admin.ts`);
const seed = globalThis.__memSeed;
const doc = globalThis.__memDoc;

let failures = 0;
const check = (ok, label) => {
  if (!ok) failures += 1;
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${label}`);
};
const $ = (cents) => (cents === null || cents === undefined ? 'none' : `$${(cents / 100).toFixed(2)}`);
const count = async (collection) => (await getAdminDb().collection(collection).get()).size;

const ADMIN = { role: 'admin', id: 'TESTADMINaddjobaaaa1', name: 'Test admin' };
const P = 'TESTPROPaddjobaaaa01'; // prices for all three tiers
const L = 'TESTPROPaddjobaaaa02'; // short and long prices only
const Q = 'TESTPROPaddjobaaaa03'; // no prices; an amount typed there before
const ANA = { id: 'TESTCLEANERaddjobana', name: 'Test Ana' };
const HAL = { id: 'TESTCLEANERaddjobhal', name: 'Test Hal' };
const PRICES = { shortTermCents: 6_340, midTermCents: 6_990, longTermCents: 9_870 };
const PRICES_L = { shortTermCents: 5_130, midTermCents: null, longTermCents: 8_420 };
for (const [id, name] of [[P, 'Test Priced'], [L, 'Test Two prices'], [Q, 'Test No price']]) seed('properties', id, { name, details: { checkOut: '11:00', checkIn: '16:00' }, addressDetails: { city: 'Toronto' } });
seed('cleaners', ANA.id, { schemaVersion: 2, name: ANA.name, role: 'cleaner', status: 'active', sessionEpoch: 1, history: [] });
seed('cleaners', HAL.id, { schemaVersion: 2, name: HAL.name, role: 'handyman', status: 'active', sessionEpoch: 1, history: [] });
await sp.setCleaningPrices(ADMIN, P, PRICES);
await sp.setCleaningPrices(ADMIN, L, PRICES_L);
const TODAY = '2028-11-20';
const at = (day, hour = 18) => new Date(`${day}T${String(hour).padStart(2, '0')}:00:00.000Z`);
const NOW = at(TODAY);
const add = (input, now = NOW) => sj.addJob(ADMIN, { cleanerId: null, tier: 'short', amountCents: null, label: null, ...input }, now);
const mark = async (id, day) => {
  const r = await sj.markCleaned({ id: ANA.id, name: ANA.name }, id, at(day, 20), {});
  return r.kind === 'marked' ? doc('cleanings', r.cleaningId) : null;
};

// ═══ 1. The amount from the property (item 2) ═══
console.log('═══ 1. The amount fills from the property\'s cleaning price; no Tier control; the tier stored as before (item 2) ═══');
const NONE = aj.NOTHING_TYPED;
const openP = aj.amountStart(PRICES, NONE);
const openL = aj.amountStart(PRICES_L, NONE);
const openQ = aj.amountStart(null, { short: 7_310, mid: null, long: null });
const openBare = aj.amountStart(null, NONE);
console.log(`  P picked: tier ${openP.tier}, field "${openP.field.value}", beside it ${aj.priceChoices(PRICES, openP.tier).map((c) => `"${c.words}"`).join(' ')} · words "${aj.amountWords(PRICES, NONE, 'short', 6_340, false)}"`);
console.log(`  a property with short and long prices only: field "${openL.field.value}", beside it ${aj.priceChoices(PRICES_L, 'short').map((c) => `"${c.words}"`).join(' ') || 'nothing'}`);
console.log(`  no price, an amount typed there before: field "${openQ.field.value}", placeholder "${openQ.field.placeholder}", words "${openQ.field.words}"`);
console.log(`  no price, nothing typed: field "${openBare.field.value}", placeholder "${openBare.field.placeholder}", beside it ${aj.priceChoices(null, 'short').length} prices · words "${openBare.field.words}"`);
check(openP.tier === 'short' && openP.field.value === '63.40' && JSON.stringify(aj.priceChoices(PRICES, 'short').map((c) => c.words)) === JSON.stringify(['Mid $69.90', 'Long $98.70']), 'a property picked: the amount holds its short-term cleaning price, "Mid $Y" and "Long $Z" beside it');
check(JSON.stringify(aj.priceChoices(PRICES_L, 'short').map((c) => c.words)) === JSON.stringify(['Long $84.20']) && JSON.stringify(aj.priceChoices(PRICES, 'mid').map((c) => c.words)) === JSON.stringify(['Short $63.40', 'Long $98.70']), 'only the prices the property has are offered; after a tap the others stay one tap away');
check(openQ.field.value === '' && openQ.field.placeholder === '73.10' && openQ.field.words === 'Last typed for short-term: $73.10' && openBare.field.value === '' && openBare.field.placeholder === '', 'no price: the field is empty, "Last typed" a grey placeholder, never a value (Build 2)');
const fold = [
  ['the short price left as it is', 'short', 6_340],
  ['Mid tapped', 'mid', 6_990],
  ['the amount changed', 'short', 5_550],
  ['the field emptied', 'short', null],
].map(([what, tier, cents]) => ({ what, ...aj.addedJobAmount(PRICES, tier, cents), words: aj.amountWords(PRICES, NONE, tier, cents, cents === null) }));
for (const f of fold) console.log(`  ${f.what}: stored tier ${f.tier}, amount on the job ${$(f.amountCents)} · words "${f.words}"`);
check(fold[0].amountCents === null && fold[1].tier === 'mid' && fold[1].amountCents === null && fold[2].amountCents === 5_550 && fold[3].amountCents === null, 'a price left as it is, or tapped, is stored as that tier\'s price; a changed amount is the job\'s own (ruling B)');

const asShort = await add({ propertyId: P, checkout: TODAY, cleanerId: ANA.id, tier: 'short', amountCents: 6_340 });
const asMid = await add({ propertyId: P, checkout: TODAY, cleanerId: ANA.id, tier: 'mid', amountCents: 6_990, label: 'Deep clean' });
const asTyped = await add({ propertyId: P, checkout: TODAY, cleanerId: ANA.id, tier: 'short', amountCents: 5_550 });
const asNone = await add({ propertyId: Q, checkout: TODAY, cleanerId: ANA.id, tier: 'short', amountCents: null });
const stored = (r) => doc('cleaning_jobs', r.job.id);
for (const [what, r] of [['short price kept', asShort], ['Mid tapped', asMid], ['amount changed', asTyped], ['no price, left empty', asNone]]) console.log(`  added (${what}): ${r.kind} · stored tier ${stored(r).tier}, amount ${$(stored(r).amountCents)} · history ${stored(r).history.map((e) => `${e.action}${e.reason ? ` "${e.reason}"` : ''}`).join(', ')}`);
const marks = { short: await mark(asShort.job.id, TODAY), mid: await mark(asMid.job.id, TODAY), typed: await mark(asTyped.job.id, TODAY), none: await mark(asNone.job.id, TODAY) };
console.log(`  Ana marks each: ${Object.entries(marks).map(([k, c]) => `${k} ${$(c?.amountCents)} (${c?.amountFrom ?? 'needs an amount'})`).join(' · ')} · words ${Object.values(marks).map((c) => `"${pr.amountSourceWords(c)}"`).join(', ')}`);
check(stored(asShort).tier === 'short' && stored(asShort).amountCents === null && stored(asMid).tier === 'mid' && stored(asMid).amountCents === null && stored(asMid).history[0].reason === 'Deep clean · mid-term job' && !stored(asMid).history.some((e) => e.action === 'amount-set'), 'the job reads as the tier it came from, as with the Tier control and no amount: history "· mid-term job", no amount on it');
check(marks.short.amountFrom === 'short' && marks.short.amountCents === 6_340 && marks.mid.amountFrom === 'mid' && marks.mid.amountCents === 6_990 && marks.typed.amountFrom === 'job' && marks.typed.amountCents === 5_550 && marks.none.amountCents === null, 'its cleaning counts the amount the field showed, from the source it came from (cleaning price, set on the job, or none)');
check(stored(asTyped).amountCents === 5_550 && stored(asTyped).history.some((e) => e.action === 'amount-set' && e.amountCents === 5_550), 'a changed amount is set on the job, in its history, as before');

// What the form reads once a property is picked (GET …/amount-start).
seed('cleanings', 'TESTCLEANINGtypedq01', { schemaVersion: 4, propertyId: Q, propertyNameAtEntry: 'Test No price', cleanerId: ANA.id, cleanerNameAtEntry: ANA.name, day: '2028-11-02', amountCents: 7_310, note: null, status: 'logged', suggested: { from: 'short', cents: null }, amountFrom: 'typed', createdAt: '2028-11-02T19:00:00.000Z', actor: ADMIN, history: [], jobId: null, extra: null });
const before = globalThis.__memReads.length;
const startP = await scl.addedJobStart(P);
const readsP = globalThis.__memReads.slice(before).reduce((n, r) => n + r.billed, 0);
const startL = await scl.addedJobStart(L);
const startQ = await scl.addedJobStart(Q);
console.log(`  the form's read: P ${JSON.stringify(startP)} (${readsP} read) · L lastTyped ${JSON.stringify(startL.lastTyped)} · Q ${JSON.stringify(startQ)}`);
check(JSON.stringify(startP.prices) === JSON.stringify(PRICES) && readsP === 1 && startQ.prices === null && startQ.lastTyped.short === 7_310 && startQ.lastTyped.long === null, 'the form reads the prices (one read when all three are set) and, where none, what was last typed there');
const body = { propertyId: P, checkout: TODAY, cleanerId: ANA.id, tier: 'mid', amount: '69.90', label: 'Deep clean', alreadyCleaned: true };
const parsed = sc.AddJobSchema.safeParse(body);
const parsedOld = sc.AddJobSchema.safeParse({ propertyId: P, checkout: TODAY, cleanerId: null, tier: 'short' });
console.log(`  the route's schema, the page's body: ${parsed.success ? JSON.stringify(parsed.data) : 'refused'} · without the tick: alreadyCleaned ${parsedOld.data?.alreadyCleaned}`);
check(parsed.success && parsed.data.amount === 6_990 && parsed.data.alreadyCleaned === true && parsedOld.success && parsedOld.data.alreadyCleaned === false, 'the route takes the body the page builds; Already cleaned is off unless sent');

// ═══ 2. Already cleaned (item 4) ═══
console.log('\n═══ 2. "Already cleaned": the job added and recorded cleaned in one step, exactly as Record as cleaned (item 4) ═══');
const PAST = '2028-11-17';
const jobsBefore = await count('cleaning_jobs');
const cleaningsBefore = await count('cleanings');
const oneStep = await add({ propertyId: P, checkout: PAST, cleanerId: ANA.id, tier: 'mid', amountCents: 6_990, label: 'Deep clean', alreadyCleaned: true });
const afterOne = { jobs: (await count('cleaning_jobs')) - jobsBefore, cleanings: (await count('cleanings')) - cleaningsBefore };
console.log(`  one step (${PAST}, Ana, Mid, "Deep clean"): ${oneStep.kind} · made ${afterOne.jobs} job, ${afterOne.cleanings} cleaning · recorded ${JSON.stringify(oneStep.recorded?.cleanings.map((c) => ({ amount: $(c.amountCents) })))} on the ${oneStep.recorded?.statementMonth} statement`);
const twoSteps = await add({ propertyId: P, checkout: PAST, cleanerId: ANA.id, tier: 'mid', amountCents: 6_990, label: 'Deep clean' });
const recorded = await sj.recordCleaned(ADMIN, twoSteps.job.id, [ANA.id], twoSteps.job.history.length, NOW);
console.log(`  Add then Record as cleaned, the same job: ${twoSteps.kind}, then ${recorded.kind} · ${$(recorded.cleanings?.[0]?.amountCents)} on the ${recorded.statementMonth} statement`);
// The two compared field by field, leaving out only what is each one's own: IDs and instants.
const TIMES = new Set(['at', 'createdAt', 'assignedAt', 'markedAt']);
const plain = (value, ids) => {
  if (Array.isArray(value)) return value.map((v) => plain(v, ids));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => !TIMES.has(k)).map(([k, v]) => [ids.get(k) ?? k, plain(v, ids)]));
  return typeof value === 'string' && ids.has(value) ? ids.get(value) : value;
};
const oneJob = doc('cleaning_jobs', oneStep.job.id);
const twoJob = doc('cleaning_jobs', twoSteps.job.id);
const oneCleaning = doc('cleanings', oneStep.recorded.cleanings[0].cleaningId);
const twoCleaning = doc('cleanings', recorded.cleanings[0].cleaningId);
const idsOne = new Map([[oneStep.job.id, '<job>'], [oneStep.recorded.cleanings[0].cleaningId, '<cleaning>']]);
const idsTwo = new Map([[twoSteps.job.id, '<job>'], [recorded.cleanings[0].cleaningId, '<cleaning>']]);
const jobSame = JSON.stringify(plain(oneJob, idsOne)) === JSON.stringify(plain(twoJob, idsTwo));
const cleaningSame = JSON.stringify(plain(oneCleaning, idsOne)) === JSON.stringify(plain(twoCleaning, idsTwo));
console.log(`  the job, one step against two: ${jobSame ? 'identical' : 'DIFFERENT'} but for IDs and instants · history ${oneJob.history.map((e) => `${e.action}${e.reason ? ` (${e.reason})` : ''}`).join(', ')}`);
console.log(`  the cleaning, one step against two: ${cleaningSame ? 'identical' : 'DIFFERENT'} but for IDs and instants · ${$(oneCleaning.amountCents)} ${oneCleaning.amountFrom}, logged "${oneCleaning.history[0].reason}" by ${oneCleaning.actor.name}, day ${oneCleaning.day}, job linked ${oneCleaning.jobId === oneStep.job.id}`);
check(oneStep.kind === 'added' && afterOne.jobs === 1 && afterOne.cleanings === 1, 'a past-day job with Already cleaned makes one job and one cleaning');
check(jobSame && cleaningSame && oneStep.recorded.statementMonth === recorded.statementMonth, 'the same job, cleaning, amount, history and statement month as Add then Record as cleaned');
check(oneCleaning.amountCents === 6_990 && oneCleaning.amountFrom === 'mid' && oneJob.assignments[ANA.id].cleaningId === oneStep.recorded.cleanings[0].cleaningId && oneJob.history.at(-1).action === 'marked' && oneJob.history.at(-1).reason === 'recorded by the office', 'counted at the chosen amount, the mark the office\'s, on the job');
const today = await add({ propertyId: P, checkout: TODAY, cleanerId: ANA.id, tier: 'short', amountCents: 6_340, alreadyCleaned: true });
const open = await add({ propertyId: P, checkout: PAST, cleanerId: ANA.id, tier: 'short', amountCents: 6_340 });
console.log(`  today with the tick: ${today.kind}, recorded ${today.recorded ? $(today.recorded.cleanings[0].amountCents) : 'no'} · a past day without it: ${open.kind}, recorded ${open.recorded ? 'yes' : 'no'}, marked ${Object.values(doc('cleaning_jobs', open.job.id).assignments).some((a) => a.cleaningId !== null)}`);
check(today.kind === 'added' && today.recorded !== null && open.kind === 'added' && open.recorded === null && Object.values(doc('cleaning_jobs', open.job.id).assignments).every((a) => a.cleaningId === null), 'today counts as a day that has come; without the tick the job is open, as before');
const counted = async () => ({ jobs: await count('cleaning_jobs'), cleanings: await count('cleanings') });
const was = await counted();
const nobody = await add({ propertyId: P, checkout: PAST, cleanerId: null, tier: 'short', amountCents: null, alreadyCleaned: true });
const ahead = await add({ propertyId: P, checkout: '2028-11-21', cleanerId: ANA.id, tier: 'short', amountCents: null, alreadyCleaned: true });
const handyman = await add({ propertyId: P, checkout: PAST, cleanerId: HAL.id, tier: 'short', amountCents: null, alreadyCleaned: true });
const farBack = await add({ propertyId: P, checkout: '2027-10-31', cleanerId: ANA.id, tier: 'short', amountCents: null, alreadyCleaned: true });
const still = await counted();
console.log(`  refused: nobody on it ${nobody.kind} ("${sj.ADD_JOB_REFUSALS['needs-cleaner'].message}") · tomorrow ${ahead.kind} (opens ${ahead.opensOn}) · a handyman ${handyman.kind} (${handyman.why}) · thirteen months back ${farBack.kind} ("${farBack.problem}") · written ${still.jobs - was.jobs} jobs, ${still.cleanings - was.cleanings} cleanings`);
check(nobody.kind === 'needs-cleaner' && sj.ADD_JOB_REFUSALS['needs-cleaner'].status === 422 && sj.ADD_JOB_REFUSALS['needs-cleaner'].message === 'Already cleaned needs the cleaner who cleaned it.', 'Already cleaned with no cleaner: refused, in words');
check(ahead.kind === 'too-early' && handyman.kind === 'not-assignable' && farBack.kind === 'bad-day' && still.jobs === was.jobs && still.cleanings === was.cleanings, 'a day not come, a handyman, a day a cleaning cannot be logged for: refused; nothing written, neither job nor cleaning');
check(aj.canRecordOnAdd('2028-11-20', TODAY) && aj.canRecordOnAdd('2026-11-01', TODAY) && !aj.canRecordOnAdd('2028-11-21', TODAY) && !aj.canRecordOnAdd('', TODAY), 'the tick is offered for today or earlier only');

// ═══ 3. Days back to the floor (item 6) ═══
console.log('\n═══ 3. Past days back to November 1, 2026, and no further (item 6) ═══');
const NOV6 = new Date('2026-11-06T18:00:00.000Z');
const beforeFloor = await add({ propertyId: P, checkout: '2026-10-31', cleanerId: ANA.id }, NOV6);
const onFloor = await add({ propertyId: P, checkout: '2026-11-01', cleanerId: ANA.id }, NOV6);
const onFloorCleaned = await add({ propertyId: P, checkout: '2026-11-01', cleanerId: ANA.id, tier: 'short', amountCents: 6_340, alreadyCleaned: true }, NOV6);
const yearBack = await add({ propertyId: P, checkout: '2025-11-01', cleanerId: ANA.id }, NOV6);
console.log(`  on 6 Nov 2026: Oct 31 ${beforeFloor.kind} ("${beforeFloor.problem}") · Nov 1 ${onFloor.kind} · Nov 1, already cleaned ${onFloorCleaned.kind} (${$(onFloorCleaned.recorded?.cleanings[0].amountCents)} on the ${onFloorCleaned.recorded?.statementMonth} statement) · a year back ${yearBack.kind}`);
console.log(`  the words: ${JSON.stringify([aj.addedJobDayProblem('2026-10-31'), aj.addedJobDayProblem('2026-11-01'), aj.addedJobDayProblem('2026-1-1'), aj.FLOOR_WORDS])} · first day ${aj.ADDED_JOB_FROM_DAY} · the calendar reaches ${aj.addedJobLastDay('2026-11-06')}`);
check(beforeFloor.kind === 'before-floor' && beforeFloor.problem === 'Statements start in November 2026' && yearBack.kind === 'before-floor' && aj.FLOOR_WORDS === 'Statements start in November 2026', 'a day before November 1, 2026 is refused: "Statements start in November 2026"');
check(onFloor.kind === 'added' && onFloorCleaned.kind === 'added' && onFloorCleaned.recorded?.statementMonth === '2026-11' && aj.addedJobDayProblem('2026-11-01') === null && aj.ADDED_JOB_FROM_DAY === '2026-11-01', 'November 1, 2026 itself is allowed, recorded cleaned too, on the November statement');
check(aj.addedJobDayProblem('2026-1-1') === 'Pick the day.' && aj.addedJobLastDay('2026-11-06') === '2027-11-07', 'a day not written as one is refused; the calendar looks a year ahead (ruling C: any date)');

// ═══ 4. The property search and the quick labels ═══
console.log('\n═══ 4. The property search (any part of the name, recent first) and the quick labels ═══');
const units = [
  { id: 'u1', name: '12 Elm St, Unit B', publicName: 'Cozy Loft by the Park' },
  { id: 'u2', name: '40 Côte Ave', publicName: 'Sunny Suite' },
  { id: 'u3', name: '7 Bay St', publicName: 'Bay View Studio' },
  { id: 'u4', name: '99 Queen St W', publicName: '99 Queen St W' },
];
const show = (o) => `recent [${o.recent.map((u) => u.id).join(',')}] rest [${o.rest.map((u) => u.id).join(',')}]`;
console.log(`  nothing typed, u3 recent: ${show(aj.unitOrder(units, '', ['u3']))} · "bay": ${show(aj.unitOrder(units, 'bay', []))} · "cote": ${show(aj.unitOrder(units, 'cote', []))} · "  LOFT ": ${show(aj.unitOrder(units, '  LOFT ', ['u3']))} · "unit b": ${show(aj.unitOrder(units, 'unit b', []))} · "zzz": ${show(aj.unitOrder(units, 'zzz', []))}`);
check(show(aj.unitOrder(units, '', ['u3'])) === 'recent [u3] rest [u1,u2,u4]', 'every unit when nothing is typed, the recent first, the rest by name');
check(show(aj.unitOrder(units, 'bay', [])) === 'recent [] rest [u3]' && show(aj.unitOrder(units, 'cote', [])) === 'recent [] rest [u2]' && show(aj.unitOrder(units, '  LOFT ', ['u3'])) === 'recent [] rest [u1]' && show(aj.unitOrder(units, 'unit b', [])) === 'recent [] rest [u1]' && show(aj.unitOrder(units, 'zzz', [])).endsWith('rest []'), 'any part of the address or the public title, accents, case and spaces aside');
const recent = aj.recentUnitIds(['u2', 'u9'], [{ propertyId: 'u3', createdAt: '2028-11-01T10:00:00.000Z' }, { propertyId: 'u1', createdAt: '2028-11-05T10:00:00.000Z' }, { propertyId: 'u2', createdAt: '2028-11-06T10:00:00.000Z' }]);
const many = aj.recentUnitIds(['a', 'b', 'c', 'd', 'e', 'f', 'g'], []);
console.log(`  recent: this browser's picks u2, u9, then the jobs added by hand newest first: [${recent.join(', ')}] · seven picks keep ${many.length}`);
check(recent.join() === 'u2,u9,u1,u3' && many.length === aj.RECENT_UNITS, 'recent: this browser\'s picks, then the properties of jobs added by hand, newest first, at most six');
console.log(`  the quick labels: ${[...aj.JOB_LABEL_CHOICES, aj.OTHER_LABEL].join(', ')} · default "${jm.DEFAULT_JOB_LABEL}" · Other typed "Windows" → ${JSON.stringify(aj.chosenLabel('Other', ' Windows '))} · Other left empty → ${JSON.stringify(aj.chosenLabel('Other', '  '))} · Move-out → ${JSON.stringify(aj.chosenLabel('Move-out', 'ignored'))}`);
check(JSON.stringify([...aj.JOB_LABEL_CHOICES, aj.OTHER_LABEL]) === JSON.stringify(['Turnover', 'Deep clean', 'Extra visit', 'Move-out', 'Other']) && jm.DEFAULT_JOB_LABEL === 'Extra visit' && aj.chosenLabel('Other', ' Windows ') === 'Windows' && aj.chosenLabel('Other', '  ') === null && aj.chosenLabel('Move-out', 'ignored') === 'Move-out', 'Turnover, Deep clean, Extra visit (the default), Move-out, Other with its own words');
const moveOut = await add({ propertyId: P, checkout: TODAY, label: 'Move-out' });
const turnover = await add({ propertyId: P, checkout: TODAY, label: 'Turnover' });
check(moveOut.kind === 'added' && jm.readJob(moveOut.job.id, stored(moveOut))?.label === 'Move-out' && jm.readJob(turnover.job.id, stored(turnover))?.label === 'Turnover', 'each quick label is stored on the job added and reads back');

console.log(`\n${failures === 0 ? 'every check passed' : `${failures} check(s) FAILED`}`);
if (failures) process.exitCode = 1;
