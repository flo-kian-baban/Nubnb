// The price in Assign and Change cleaner, and on the Schedule's row (Kian's instruction of 2026-11-06): the dialog's
// price from the job's own amount or the unit's cleaning price for the job's tier, saved with the cleaner as the row's
// Amount… saves it, one history line each (item 1); a unit with no price for the tier, its "Last typed" placeholder and
// "Also save as this unit's <tier> cleaning price" (item 2); the lock once the job's cleaning counts (item 3); and the
// row's price beside the cleaner chip (item 4). The server functions run on an in-memory Firestore
// (tests/tools/memory-firestore.cjs): nothing is read from or written to Firestore or Storage. Made-up data only:
// properties "TESTPROP…", cleaners "Test …", amounts made up (written with separators, never a real rate).
//   node --import ./tests/tools/ts-hook.mjs tests/schedule/job-price.mjs
import { createRequire } from 'node:module';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.NUBNB_ROOT || fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
createRequire(`${ROOT}/package.json`)(`${ROOT}/tests/tools/memory-firestore.cjs`);
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.FIREBASE_SERVICE_ACCOUNT_KEY = JSON.stringify({ type: 'service_account', project_id: 'memory-test', private_key_id: 'memory-test', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), client_email: 'memory-test@memory-test.iam.gserviceaccount.com', client_id: '0', token_uri: 'https://oauth2.invalid/token' });
process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = 'memory-test.appspot.com';
process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = 'memory-test';

const jp = await import(`${ROOT}/app/lib/schedule/job-price.ts`);
const aj = await import(`${ROOT}/app/lib/schedule/add-job.ts`);
const cm = await import(`${ROOT}/app/lib/cleanings/model.ts`);
const sc = await import(`${ROOT}/app/lib/cleanings/schemas.ts`);
const jm = await import(`${ROOT}/app/lib/schedule/model.ts`);
const sp = await import(`${ROOT}/app/lib/firebase/server-cleaning-prices.ts`);
const sj = await import(`${ROOT}/app/lib/firebase/server-cleaning-jobs.ts`);
const seed = globalThis.__memSeed;
const doc = globalThis.__memDoc;

let failures = 0;
const check = (ok, label) => {
  if (!ok) failures += 1;
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${label}`);
};
const $ = (cents) => (cents === null || cents === undefined ? 'none' : `$${(cents / 100).toFixed(2)}`);

const ADMIN = { role: 'admin', id: 'TESTADMINjobpriceaa1', name: 'Test admin' };
const P = 'TESTPROPjobpricea001'; // prices for all three tiers
const Q = 'TESTPROPjobpricea002'; // no price; an amount typed there before
const ANA = { id: 'TESTCLEANERjobpriana', name: 'Test Ana' };
const BEN = { id: 'TESTCLEANERjobpriben', name: 'Test Ben' };
const PRICES = { shortTermCents: 6_340, midTermCents: 6_990, longTermCents: 9_870 };
for (const [id, name] of [[P, 'Test Priced'], [Q, 'Test No price']]) seed('properties', id, { name, details: { checkOut: '11:00', checkIn: '16:00' }, addressDetails: { city: 'Toronto' } });
for (const m of [ANA, BEN]) seed('cleaners', m.id, { schemaVersion: 2, name: m.name, role: 'cleaner', status: 'active', sessionEpoch: 1, history: [] });
await sp.setCleaningPrices(ADMIN, P, PRICES);
const TODAY = '2028-11-20';
const at = (day, hour = 18) => new Date(`${day}T${String(hour).padStart(2, '0')}:00:00.000Z`);
/** A calendar job in the written shape (schema version 3): a stay from `start` to `checkout`, `cleaners` on it. */
const seedJob = (pid, key, start, checkout, cleaners = []) => {
  const id = jm.jobIdOf(pid, checkout);
  const made = `${start}T12:00:00.000Z`;
  seed('cleaning_jobs', id, { schemaVersion: jm.JOB_SCHEMA_VERSION, propertyId: pid, propertyNameAtCreation: 'Test', checkout, reservation: { uid: `${key}@airbnb.com`, start }, calendarKey: '', origin: 'calendar', tier: null, amountCents: null, label: null, nextCheckIn: null, status: 'open', change: null, cleanerIds: cleaners.map((m) => m.id), assignments: Object.fromEntries(cleaners.map((m) => [m.id, jm.newAssignment(m.name, made, ADMIN)])), createdAt: made, history: [jm.jobEvent(made, 'created', jm.CALENDAR_ACTOR, { after: { start, end: checkout } }), ...cleaners.map((m) => jm.jobEvent(made, 'assigned', ADMIN, { cleanerId: m.id, cleanerName: m.name }))] });
  return id;
};
const job = (id) => doc('cleaning_jobs', id);
/** A job as the page holds it (JobView's fields these rules read), with each mark's cleaning as stored. */
const view = (id) => {
  const j = job(id);
  return { ...j, id, assignees: j.cleanerIds.map((cid) => { const a = j.assignments[cid]; const c = a.cleaningId && a.removedAt === null ? doc('cleanings', a.cleaningId) : null; return { cleaning: c ? { status: c.status, amountCents: c.amountCents, amountFrom: c.amountFrom ?? null, extra: c.extra?.status ?? null } : null }; }) };
};
const mark = async (m, id, day) => {
  const r = await sj.markCleaned({ id: m.id, name: m.name }, id, at(day, 20), {});
  return r.kind === 'marked' ? doc('cleanings', r.cleaningId) : { kind: r.kind };
};
const events = (id) => job(id).history.map((e) => e.action);
const recordOf = (pid) => doc('property_cleaning_prices', pid);

// ═══ 1. Price for this job (item 1) ═══
console.log('═══ 1. "Price for this job": from the job\'s own amount or the unit\'s cleaning price; saved with the cleaner (item 1) ═══');
const short3 = seedJob(P, 'p-short3', '2028-11-17', TODAY);
const v = view(short3);
console.log(`  a 3-night job at P: opens "${jp.jobPriceStart(v, PRICES)}" · note "${jp.jobPriceWords(v, PRICES, null, '63.40', 6_340)}" · one tap: ${aj.priceChips(PRICES, 'short', 6_340, true).map((c) => `"${c.words}"`).join(' ')} · after Mid tapped: ${aj.priceChips(PRICES, 'short', 6_990, true).map((c) => `"${c.words}"`).join(' ')} → note "${jp.jobPriceWords(v, PRICES, null, '69.90', 6_990)}"`);
check(jp.jobPriceStart(v, PRICES) === '63.40' && jp.jobPriceWords(v, PRICES, null, '63.40', 6_340) === 'Short-term cleaning price · 3 nights', 'it opens on the unit\'s cleaning price for the job\'s tier, the tier and nights under it');
check(JSON.stringify(aj.priceChips(PRICES, 'short', 6_340, true).map((c) => c.words)) === JSON.stringify(['Mid $69.90', 'Long $98.70']) && JSON.stringify(aj.priceChips(PRICES, 'short', 6_990, true).map((c) => c.words)) === JSON.stringify(['Short $63.40', 'Long $98.70']) && JSON.stringify(aj.priceChips({ shortTermCents: 5_130, midTermCents: null, longTermCents: null }, 'short', 5_130, true)) === '[]', 'the other prices one tap away, only where the unit has them; after a tap, the tier\'s own is one tap back');
const mid9 = seedJob(P, 'p-mid9', '2028-11-02', '2028-11-11');
const long30 = seedJob(P, 'p-long30', '2028-09-21', '2028-10-21');
check(jp.jobPriceStart(view(mid9), PRICES) === '69.90' && jp.jobPriceWords(view(mid9), PRICES, null, '69.90', 6_990) === 'Mid-term cleaning price · 9 nights' && jp.jobPriceStart(view(long30), PRICES) === '98.70' && jp.jobPriceWords(view(long30), PRICES, null, '98.70', 9_870) === 'Long-term cleaning price · 30 nights', 'mid 7–27 nights, long 28 and more: each opens on its own tier\'s price');
const sends = [['left as it opened', '63.40'], ['the same, retyped', '63.4'], ['changed', '70.10'], ['emptied', '']].map(([what, typed]) => ({ what, ...jp.jobPriceToSend(v, '63.40', typed, typed.trim() === '' ? null : cm.readAmountCents(typed), false) }));
console.log(`  what Assign sends with the cleaner: ${sends.map((x) => `${x.what} → ${x.kind}${x.kind === 'send' ? ` ${JSON.stringify(x.price)}` : ''}`).join(' · ')}`);
check(sends[0].kind === 'none' && sends[1].kind === 'none' && sends[2].kind === 'send' && sends[2].price === '70.10' && sends[3].kind === 'send' && sends[3].price === null, 'the price goes with the cleaner only when the admin changed it');

const before = JSON.stringify(recordOf(P));
const plain = await sj.setAssignees(ADMIN, short3, [ANA.id], 1);
const plainMark = await mark(ANA, short3, TODAY);
console.log(`  Assign Ana at the cleaning price (nothing sent): ${plain.kind}, price ${JSON.stringify(plain.price)} · history ${events(short3).join(', ')} · Ana marks: ${$(plainMark.amountCents)} (${plainMark.amountFrom})`);
check(plain.kind === 'saved' && plain.price === null && events(short3).join() === 'created,assigned,marked' && plainMark.amountCents === 6_340 && plainMark.amountFrom === 'short', 'assigned with the cleaning price: one line, and the mark counts at the cleaning price');
const edited = seedJob(P, 'p-edited', '2028-11-16', '2028-11-19');
const withPrice = await sj.setAssignees(ADMIN, edited, [ANA.id], 1, { cents: 7_010, saveCleaningPrice: false }, at('2028-11-18'));
const editedMark = await mark(ANA, edited, '2028-11-19');
console.log(`  Assign Ana with the price changed to $70.10: ${withPrice.kind}, price ${JSON.stringify(withPrice.price)} · history ${events(edited).join(', ')} · on the job ${$(job(edited).amountCents)} · Ana marks: ${$(editedMark.amountCents)} (${editedMark.amountFrom}) · P's cleaning prices ${JSON.stringify(recordOf(P)) === before ? 'unchanged' : 'CHANGED'}`);
check(withPrice.kind === 'saved' && events(edited).join() === 'created,assigned,amount-set,marked' && job(edited).amountCents === 7_010 && withPrice.price.amountChanged && !withPrice.price.cleaningPriceSaved, 'the cleaner and the price saved together: one history line each, the price as the job\'s own amount');
check(editedMark.amountCents === 7_010 && editedMark.amountFrom === 'job' && JSON.stringify(recordOf(P)) === before, 'the mark counts at that price; the unit\'s cleaning prices are unchanged');
const sameAsBase = seedJob(P, 'p-same', '2028-11-15', '2028-11-18');
const typedBase = await sj.setAssignees(ADMIN, sameAsBase, [ANA.id], 1, { cents: 6_340, saveCleaningPrice: false });
console.log(`  a price typed equal to the cleaning price: ${typedBase.kind}, amount changed ${typedBase.price.amountChanged}, history ${events(sameAsBase).join(', ')}`);
check(typedBase.price.amountChanged === false && job(sameAsBase).amountCents === null && events(sameAsBase).join() === 'created,assigned', 'the cleaning price itself is no amount on the job: no line for it');
const owned = seedJob(P, 'p-owned', '2028-11-14', '2028-11-17');
await sj.setJobAmount(ADMIN, owned, 7_550, 1, at('2028-11-16'));
check(jp.jobPriceStart(view(owned), PRICES) === '75.50' && jp.jobPriceWords(view(owned), PRICES, null, '75.50', 7_550) === 'Set on the job · 3 nights', 'a job with its own amount opens on it: "Set on the job"');
const cleared = await sj.setAssignees(ADMIN, owned, [ANA.id], 2, { cents: null, saveCleaningPrice: false });
console.log(`  its field emptied and saved with Ana: amount on the job ${$(job(owned).amountCents)} · history ${events(owned).join(', ')} · note while empty "${jp.jobPriceWords(view(owned), PRICES, null, '', null)}"`);
check(cleared.kind === 'saved' && job(owned).amountCents === null && events(owned).join() === 'created,amount-set,assigned,amount-set', 'emptied: the job\'s own amount cleared, as Amount… clears it; it takes the cleaning price');
const swapJob = seedJob(P, 'p-swap', '2028-11-12', '2028-11-15', [ANA]);
const swapped = await sj.swapCleaner(ADMIN, swapJob, ANA.id, BEN.id, 2, at('2028-11-14'), { cents: 7_230, saveCleaningPrice: false });
const benMark = await mark(BEN, swapJob, '2028-11-15');
console.log(`  Change cleaner, Ana → Ben, the price changed to $72.30: ${swapped.kind} · history ${events(swapJob).join(', ')} · Ben marks: ${$(benMark.amountCents)} (${benMark.amountFrom})`);
check(swapped.kind === 'swapped' && events(swapJob).join() === 'created,assigned,unassigned,assigned,amount-set,marked' && benMark.amountCents === 7_230 && benMark.amountFrom === 'job', 'Change cleaner saves the swap and the price together, and the new cleaner\'s mark counts it');
check(sc.JobPatchSchema.safeParse({ cleanerIds: [ANA.id], seen: 1, price: '70.10' }).data?.price === 7_010 && sc.JobPatchSchema.safeParse({ action: 'swap', from: ANA.id, to: BEN.id, seen: 1, price: null }).data?.price === null && sc.JobPatchSchema.safeParse({ cleanerIds: [ANA.id], seen: 1 }).data?.price === undefined && !sc.JobPatchSchema.safeParse({ cleanerIds: [ANA.id], seen: 1, price: '70.1' }).success, 'the route takes the price with Assign and Change cleaner, absent when unchanged');

// ═══ 2. No price for the tier (item 2) ═══
console.log('\n═══ 2. A unit with no price for the tier: the "Last typed" placeholder, and "Also save as this unit\'s <tier> cleaning price" (item 2) ═══');
seed('cleanings', 'TESTCLEANINGjobpriq1', { schemaVersion: 4, propertyId: Q, propertyNameAtEntry: 'Test No price', cleanerId: ANA.id, cleanerNameAtEntry: ANA.name, day: '2028-11-02', amountCents: 7_310, note: null, status: 'logged', suggested: { from: 'short', cents: null }, amountFrom: 'typed', createdAt: '2028-11-02T19:00:00.000Z', actor: ADMIN, history: [], jobId: null, extra: null });
const qWaiting = seedJob(Q, 'q-waiting', '2028-11-10', '2028-11-13', [ANA]);
const waitingMark = await mark(ANA, qWaiting, '2028-11-13');
const qJob = seedJob(Q, 'q-assign', '2028-11-14', '2028-11-17');
const qv = view(qJob);
const LAST = { short: 7_310, mid: null, long: null };
console.log(`  a 3-night job at Q: opens "${jp.jobPriceStart(qv, null)}", placeholder "${jp.jobPricePlaceholder(qv, null, LAST)}", note "${jp.jobPriceWords(qv, null, LAST, '', null)}" · nothing typed anywhere: "${jp.jobPriceWords(qv, null, null, '', null)}" · the tick offered: ${jp.canSaveCleaningPrice(qv, null)} ("${jp.saveCleaningPriceWords('short')}")`);
check(jp.jobPriceStart(qv, null) === '' && jp.jobPricePlaceholder(qv, null, LAST) === '73.10' && jp.jobPriceWords(qv, null, LAST, '', null) === 'Last typed for short-term: $73.10 · 3 nights' && jp.jobPriceWords(qv, null, null, '', null) === 'No short-term cleaning price · 3 nights', 'empty, with "Last typed" as its grey placeholder, never a value');
const untyped = jp.jobPriceToSend(qv, '', '', null, false);
const tickEmpty = jp.jobPriceToSend(qv, '', '', null, true);
console.log(`  saved untyped: ${untyped.kind} · the tick with nothing typed: ${tickEmpty.kind} "${tickEmpty.problem ?? ''}"`);
console.log(`  74.20 typed: "${jp.jobPriceWords(qv, null, LAST, '74.20', 7_420)}" · with the tick: "${jp.jobPriceWords(qv, null, LAST, '74.20', 7_420, true)}"`);
check(jp.jobPriceWords(qv, null, LAST, '74.20', 7_420) === 'Set on the job · 3 nights' && jp.jobPriceWords(qv, null, LAST, '74.20', 7_420, true) === 'Short-term cleaning price · 3 nights', 'with the tick, the price reads as the unit\'s cleaning price it is about to become');
check(untyped.kind === 'none' && tickEmpty.kind === 'bad' && tickEmpty.problem === 'Type the price to save it as this unit’s short-term cleaning price.' && jp.canSaveCleaningPrice(v, PRICES) === false, 'nothing saved untyped; the tick needs a price, and is offered only where the unit has none');
const saved = await sj.setAssignees(ADMIN, qJob, [ANA.id], 1, { cents: 7_420, saveCleaningPrice: true }, at('2028-11-16'));
const qRecord = recordOf(Q);
console.log(`  Assign Ana at Q with $74.20 and the tick: ${saved.kind} · price ${JSON.stringify(saved.price)} · Q's cleaning prices ${JSON.stringify({ short: qRecord?.shortTermCents, mid: qRecord?.midTermCents, long: qRecord?.longTermCents })}, history ${qRecord?.history.length} line by ${qRecord?.setBy.name} · the job: ${$(job(qJob).amountCents)} on it, history ${events(qJob).join(', ')}`);
check(saved.kind === 'saved' && qRecord.shortTermCents === 7_420 && qRecord.midTermCents === null && qRecord.history.length === 1 && qRecord.history[0].before.shortTermCents === null && qRecord.history[0].after.shortTermCents === 7_420 && saved.price.cleaningPriceSaved?.cents === 7_420, 'the unit\'s short-term cleaning price is set, with its own history line');
check(job(qJob).amountCents === null && events(qJob).join() === 'created,assigned', 'the job takes the new cleaning price: no amount of its own, one line for the cleaner');
const qMark = await mark(ANA, qJob, '2028-11-17');
const later = seedJob(Q, 'q-later', '2028-11-15', '2028-11-18', [BEN]);
const laterMark = await mark(BEN, later, '2028-11-18');
console.log(`  Ana marks it: ${$(qMark.amountCents)} (${qMark.amountFrom}) · a later job at Q, Ben marks: ${$(laterMark.amountCents)} (${laterMark.amountFrom}) · the cleaning marked before, with no amount: ${$(doc('cleanings', Object.values(job(qWaiting).assignments)[0].cleaningId).amountCents)} (was ${$(waitingMark.amountCents)})`);
check(qMark.amountCents === 7_420 && qMark.amountFrom === 'short' && laterMark.amountCents === 7_420 && laterMark.amountFrom === 'short', 'this job and a later one take the new cleaning price');
check(doc('cleanings', Object.values(job(qWaiting).assignments)[0].cleaningId).amountCents === null, 'a cleaning price set never changes an existing cleaning (the one marked before still needs an amount)');
const again = await sj.setAssignees(ADMIN, seedJob(Q, 'q-again', '2028-11-16', '2028-11-19'), [ANA.id], 1, { cents: 7_000 + 99, saveCleaningPrice: true });
const noAmount = await sj.setAssignees(ADMIN, seedJob(P, 'p-noamount', '2028-11-07', '2028-11-10'), [ANA.id], 1, { cents: null, saveCleaningPrice: true });
console.log(`  the tick where the unit has the price already: ${again.kind} ("${sj.JOB_PRICE_REFUSALS['price-exists']('short').message}") · the tick with no amount: ${noAmount.kind} · Q's record still ${$(recordOf(Q).shortTermCents)}, ${recordOf(Q).history.length} line`);
check(again.kind === 'price-exists' && noAmount.kind === 'price-needed' && recordOf(Q).shortTermCents === 7_420 && recordOf(Q).history.length === 1, 'a unit\'s cleaning price is never overwritten from the dialog; the tick needs an amount; nothing written');

// ═══ 3. Locked once the job's cleaning counts (item 3) ═══
console.log('\n═══ 3. Once the job\'s cleaning counts: read-only, "Locked: already counted" (item 3) ═══');
const lv = view(short3);
console.log(`  the job Ana marked at $63.40: counts ${jp.jobMoneyCounts(lv)} · opens "${jp.jobPriceStart(lv, PRICES)}" · note "${jp.jobPriceWords(lv, PRICES, null, '63.40', 6_340)}" · the tick offered ${jp.canSaveCleaningPrice(lv, PRICES)} · sends ${jp.jobPriceToSend(lv, '63.40', '70.00', 7_000, false).kind}`);
check(jp.jobMoneyCounts(lv) && jp.jobPriceWords(lv, PRICES, null, '63.40', 6_340) === 'Locked: already counted' && jp.jobPriceToSend(lv, '63.40', '70.00', 7_000, false).kind === 'none', 'read-only with "Locked: already counted"; nothing is sent');
const seenBefore = job(short3).history.length;
const locked = await sj.setAssignees(ADMIN, short3, [ANA.id], seenBefore, { cents: 7_000, saveCleaningPrice: false });
const stays = await sj.setAssignees(ADMIN, short3, [ANA.id], seenBefore);
console.log(`  a price sent anyway: ${locked.kind} ("${sj.JOB_AMOUNT_REFUSALS.locked.message}") · history ${job(short3).history.length - seenBefore} lines longer · Who cleans… saved with no price: ${stays.kind}, changed ${stays.changed}`);
check(locked.kind === 'locked' && job(short3).history.length === seenBefore && job(short3).amountCents === null && stays.kind === 'saved' && stays.changed === false, 'the server refuses it as Amount… does; nothing written');
const asked = seedJob(P, 'p-asked', '2028-11-06', '2028-11-09', [ANA]);
const askedMark = await sj.markCleaned({ id: ANA.id, name: ANA.name }, asked, at('2028-11-09', 20), { note: 'Very dirty', extraReason: 'Very dirty' });
const av = view(asked);
const follow = await sj.setAssignees(ADMIN, asked, [ANA.id], job(asked).history.length, { cents: 8_150, saveCleaningPrice: false });
console.log(`  a mark with a note waiting for a decision: counts ${jp.jobMoneyCounts(av)} · a price sent with Who cleans…: ${follow.kind}, cleanings that followed ${follow.price?.cleaningsChanged} · its cleaning now ${$(doc('cleanings', askedMark.cleaningId).amountCents)} (${doc('cleanings', askedMark.cleaningId).amountFrom})`);
check(!jp.jobMoneyCounts(av) && follow.kind === 'saved' && follow.price.cleaningsChanged === 1 && doc('cleanings', askedMark.cleaningId).amountCents === 8_150, 'a waiting cleaning is not locked, and follows the price, as with Amount…');

// ═══ 4. The row's price (item 4) ═══
console.log('\n═══ 4. The job\'s price beside the cleaner chip (item 4) ═══');
const rowNobody = seedJob(P, 'p-row', '2028-11-18', '2028-11-21');
const rowOwn = seedJob(P, 'p-row2', '2028-11-19', '2028-11-22');
await sj.setJobAmount(ADMIN, rowOwn, 9_510, 1);
const rows = [
  ['P, nobody yet, 3 nights', view(rowNobody), PRICES],
  ['P, its own amount', view(rowOwn), PRICES],
  ['Q before the tick (no price)', { ...view(seedJob(Q, 'q-row', '2028-11-19', '2028-11-22')), assignees: [] }, null],
  ['P, marked and counted', view(short3), PRICES],
  ['P, marked, set on the job', view(edited), PRICES],
  ['Q, marked, needs an amount', view(qWaiting), recordOf(Q)],
];
for (const [what, j, prices] of rows) {
  const tag = jp.jobPriceTag(j, prices);
  console.log(`  ${what}: ${tag ? `"${jp.jobPriceTagText(tag)}"` : 'nothing beside the chip'}`);
}
const texts = rows.map(([, j, prices]) => { const tag = jp.jobPriceTag(j, prices); return tag ? jp.jobPriceTagText(tag) : null; });
check(JSON.stringify(texts) === JSON.stringify(['$63.40 · short', '$95.10 · set on the job', 'no cleaning price', '$63.40 · short', '$70.10 · set on the job', null]), 'the row reads "$63.40 · short", "$95.10 · set on the job", "no cleaning price", or nothing where the chip says "needs an amount"');
const changedBooking = { ...view(seedJob(P, 'p-gone', '2028-11-20', '2028-11-24')), status: 'changed' };
check(jp.jobPriceTag(changedBooking, PRICES) === null, 'a booking that changed, not marked: no price beside it');

console.log(`\n${failures === 0 ? 'every check passed' : `${failures} check(s) FAILED`}`);
if (failures) process.exitCode = 1;
