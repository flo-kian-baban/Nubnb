// Cleaning prices per property (Kian's ruling of 2026-10-19): the amount rule with its 28-night boundary, the record's
// strict reader, the CSV reading and the matching by address, the routes' schemas, the property save's refusal, and
// the server functions — Mark cleaned with one cleaner (short and long stays), with two cleaners, with no preset; a
// cleaning logged by hand with and without a job that day; an amount typed after; a preset change leaving a cleaning
// unchanged; the import in one transaction — on an in-memory Firestore (tests/tools/memory-firestore.cjs): nothing is
// read from or written to Firestore or Storage, and every connection is refused. Made-up data only: properties
// "TESTPROP…", cleaners "Test …".
//   node --import ./tests/tools/ts-hook.mjs tests/money/cleaning-prices.mjs
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
const sheet = await import(`${ROOT}/app/lib/reports/report-for-sheet.ts`);
const { UpdatePropertySchema } = await import(`${ROOT}/app/lib/api/schemas.ts`);
const jm = await import(`${ROOT}/app/lib/schedule/model.ts`);
const sp = await import(`${ROOT}/app/lib/firebase/server-cleaning-prices.ts`);
const sj = await import(`${ROOT}/app/lib/firebase/server-cleaning-jobs.ts`);
const cl = await import(`${ROOT}/app/lib/firebase/server-cleanings.ts`);
const seed = globalThis.__memSeed;
const doc = globalThis.__memDoc;

let failures = 0;
const check = (ok, label) => {
  if (!ok) failures += 1;
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${label}`);
};
const $ = (cents) => (cents === null ? 'none' : `$${(cents / 100).toFixed(2)}`);
const readsOf = (fn) => async (...args) => {
  const before = globalThis.__memReads.length;
  const result = await fn(...args);
  const part = globalThis.__memReads.slice(before);
  const by = {};
  for (const r of part) by[r.what.replace(/^([a-z_]+)\/.*$/, '$1')] = (by[r.what.replace(/^([a-z_]+)\/.*$/, '$1')] ?? 0) + r.billed;
  return { result, reads: part.reduce((n, r) => n + r.billed, 0), by };
};
const byText = (by) => Object.entries(by).sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `${k} ${n}`).join(', ');

const ADMIN = { role: 'admin', id: 'TESTADMINprices0001a', name: 'Test admin' };
const P = 'TESTPROPpricesaaaa01'; // $80 short, $120 long
const Q = 'TESTPROPpricesaaaa02'; // no prices
const R = 'TESTPROPpricesaaaa03'; // short only
const ANA = { id: 'TESTCLEANERpricesana', name: 'Test Ana' };
const BEN = { id: 'TESTCLEANERpricesben', name: 'Test Ben' };
const PRICES_P = { shortTermCents: 8000, longTermCents: 12000 };

// ═══ 1. The rule, pure ═══
console.log('═══ 1. The amount rule: 28 nights is long-term, 27 is short-term ═══');
console.log(`  nights Oct 1 → Oct 28: ${pr.stayNights('2026-10-01', '2026-10-28')} · Oct 1 → Oct 29: ${pr.stayNights('2026-10-01', '2026-10-29')} · same day: ${pr.stayNights('2026-10-01', '2026-10-01')} · reversed: ${pr.stayNights('2026-10-05', '2026-10-01')} · not a day: ${pr.stayNights('x', '2026-10-01')}`);
for (const nights of [0, 1, 27, 28, 29, 60]) console.log(`  ${String(nights).padStart(2)} nights → ${pr.presetKind(nights)}: ${$(pr.presetAmount(PRICES_P, nights).cents)}`);
check(pr.presetKind(27) === 'short' && pr.presetKind(28) === 'long', '27 nights = short, 28 = long (the boundary)');
check(pr.presetAmount(null, 5).cents === null && pr.presetAmount({ shortTermCents: 6000, longTermCents: null }, 30).cents === null, 'no preset, or no long-term preset for a long stay: no amount');
const job = (cleanerIds, start, checkout) => ({ cleanerIds, reservation: { start }, checkout });
const one27 = pr.markAmount(PRICES_P, job([ANA.id], '2026-10-01', '2026-10-28'));
const one28 = pr.markAmount(PRICES_P, job([ANA.id], '2026-10-01', '2026-10-29'));
const two = pr.markAmount(PRICES_P, job([ANA.id, BEN.id], '2026-10-01', '2026-10-29'));
const none = pr.markAmount(null, job([ANA.id], '2026-10-27', '2026-10-28'));
console.log(`  mark, one cleaner, 27 nights: ${JSON.stringify(one27)}`);
console.log(`  mark, one cleaner, 28 nights: ${JSON.stringify(one28)}`);
console.log(`  mark, two cleaners, 28 nights: ${JSON.stringify(two)}`);
console.log(`  mark, one cleaner, no preset: ${JSON.stringify(none)}`);
check(one27.cents === 8000 && one27.amountFrom === 'short' && one28.cents === 12000 && one28.amountFrom === 'long', 'a mark takes the short-term preset at 27 nights and the long-term one at 28');
check(two.cents === null && two.from === 'split' && two.amountFrom === null, 'two cleaners on the job: no amount, "split"');
check(none.cents === null && none.from === 'short' && none.amountFrom === null, 'no preset: no amount');
console.log(`  by hand, no job that day: ${JSON.stringify(pr.handLogSuggestion(PRICES_P, null))} · with a 30-night job: ${JSON.stringify(pr.handLogSuggestion(PRICES_P, { reservation: { start: '2026-09-01' }, checkout: '2026-10-01' }))}`);
console.log(`  where the amount came from: left as offered ${pr.amountSourceOf({ from: 'short', cents: 8000 }, 8000)} · changed ${pr.amountSourceOf({ from: 'short', cents: 8000 }, 9000)} · no preset, typed ${pr.amountSourceOf({ from: 'long', cents: null }, 9000)}`);
console.log(`  words: ${['short', 'long', 'typed'].map((k) => pr.AMOUNT_SOURCE_WORDS[k]).join(' · ')}`);
console.log(`  a version 2 cleaning's words: ${pr.amountSourceWords({ amountCents: 9000, suggested: { from: 'default', cents: 9000 } })} · ${pr.amountSourceWords({ amountCents: 9500, suggested: { from: 'last', cents: 9000 } })} · waiting after a split: ${pr.amountSourceWords({ amountCents: null, suggested: { from: 'split', cents: null } })}`);
console.log(`  waiting hints: ${pr.waitingHint(PRICES_P, { nights: 30, cleaners: 2 })} | ${pr.waitingHint(PRICES_P, { nights: 2, cleaners: 1 })} | ${pr.waitingHint(null, { nights: 2, cleaners: 1 })} | ${pr.waitingHint(PRICES_P, null)}`);

// ═══ 2. Typed prices and the record ═══
console.log('\n═══ 2. Typed prices, the record ═══');
console.log(`  typed: ${['', 'none', '80', '$80', '80.5', '80.50', '1,200.00', '0', '0.00', '10000', 'abc', '80.123'].map((t) => `${JSON.stringify(t)}→${JSON.stringify(pr.readPriceText(t))}`).join(' ')}`);
console.log(`  for the route: ${['', '80', 'x'].map((t) => `${JSON.stringify(t)}→${JSON.stringify(pr.priceTextForRoute(t))}`).join(' ')} · field: ${pr.priceField(8000)} ${JSON.stringify(pr.priceField(null))}`);
const record = { schemaVersion: 1, propertyId: P, shortTermCents: 8000, longTermCents: 12000, setAt: '2026-10-19T12:00:00.000Z', setBy: ADMIN, history: [{ at: '2026-10-19T12:00:00.000Z', actor: ADMIN, before: { shortTermCents: null, longTermCents: null }, after: { shortTermCents: 8000, longTermCents: 12000 } }] };
check(pr.readCleaningPrices(P, record) !== null, 'a record in shape reads');
const badRecords = [
  ['another property\'s ID', { ...record, propertyId: Q }],
  ['a zero preset', { ...record, shortTermCents: 0 }],
  ['a preset in dollars (not integer cents)', { ...record, longTermCents: 120.5 }],
  ['no history', { ...record, history: undefined }],
  ['a history event without before', { ...record, history: [{ at: record.setAt, actor: ADMIN, after: PRICES_P }] }],
  ['an actor of no known role', { ...record, setBy: { role: 'owner', id: null, name: null } }],
];
for (const [label, fields] of badRecords) console.log(`  refused as not in shape — ${label}: ${pr.readCleaningPrices(P, fields) === null}`);

// ═══ 3. The CSV and the matching ═══
console.log('\n═══ 3. The import file: reading and matching by address ═══');
const csv = ['address,short,long', '12 Test Rd,80.00,120.00', '"12 Test Rd B",$60,$100', '  12   test rd  s ,70,', 'No Such Place,50,80', '12 Test Rd,90,130', 'Twin Address,60,80', '12 Test Rd C,abc,80', '', '12 Test Rd D,,'].join('\r\n');
const parsed = pr.parsePricesCsv(`﻿${csv}`);
console.log(`  parsed: ${parsed.kind}, ${parsed.rows?.length} rows (a BOM, CRLF, quotes and a blank line taken in stride) · lines: ${parsed.rows?.map((r) => r.line).join(',')}`);
console.log(`  header problems: ${pr.parsePricesCsv('address,price\n1 X,80').problem} · ${pr.parsePricesCsv('').problem} · ${pr.parsePricesCsv('address,short,long\n').problem}`);
console.log(`  other column names taken: ${pr.parsePricesCsv('Suite / Property,Short Term Price,Long Term Price (28+ Days)\n1 X,80,100').kind}`);
const properties = [
  { id: P, name: '12 Test Rd' },
  { id: Q, name: '12 Test Rd B' },
  { id: R, name: '12 TEST RD S' },
  { id: 'TESTPROPpricesaaaa04', name: 'Twin Address' },
  { id: 'TESTPROPpricesaaaa05', name: 'Twin  Address' },
  { id: 'TESTPROPpricesaaaa06', name: '12 Test Rd C' },
  { id: 'TESTPROPpricesaaaa07', name: '12 Test Rd D' },
];
const current = new Map([[P, PRICES_P], ['TESTPROPpricesaaaa07', { shortTermCents: null, longTermCents: null }]]);
const { matched, unmatched } = pr.matchPriceRows(parsed.rows, properties, current);
for (const m of matched) console.log(`  matched line ${m.row.line}: ${m.name} · short ${$(m.before.shortTermCents)} → ${$(m.after.shortTermCents)} · long ${$(m.before.longTermCents)} → ${$(m.after.longTermCents)} · changes ${m.changes}`);
for (const u of unmatched) console.log(`  unmatched line ${u.row.line}: ${JSON.stringify(u.row.address)} · ${u.why}`);
check(matched.length === 4 && matched[0].changes === false && matched.find((m) => m.propertyId === R)?.after.longTermCents === null, 'exact address, case and spaces ignored; the first row of a property wins; an empty long is none; a row equal to what is stored changes nothing');
check(unmatched.map((u) => u.why).join('|') === 'no property with this address|another row names the same property|two or more properties share this address|a price is not readable', 'the four ways a row is not saved');

// ═══ 4. The schemas, the sheet, the property save ═══
console.log('\n═══ 4. Schemas, the sheet\'s fields, the property save ═══');
const parse = (schema, body) => {
  const r = schema.safeParse(body);
  return r.success ? `ok ${JSON.stringify(r.data)}` : `refused: ${r.error.issues.map((i) => `${i.path.join('.') || '(body)'} ${i.message}`).join('; ')}`;
};
console.log(`  prices: ${parse(sc.CleaningPricesSchema, { shortTerm: '80.00', longTerm: null })} · ${parse(sc.CleaningPricesSchema, { shortTerm: '80', longTerm: '120.00' })} · ${parse(sc.CleaningPricesSchema, { shortTerm: '0.00', longTerm: null })} · ${parse(sc.CleaningPricesSchema, { shortTerm: null })}`);
console.log(`  import: ${parse(sc.ImportCleaningPricesSchema, { rows: [{ propertyId: P, shortTerm: '80.00', longTerm: '120.00' }] })} · empty: ${parse(sc.ImportCleaningPricesSchema, { rows: [] })}`);
console.log(`  suggest: ${parse(sc.SuggestQuerySchema, { propertyId: P, day: '2026-10-19' })} · ${parse(sc.SuggestQuerySchema, { propertyId: P, day: 'today' })}`);
const fields = sheet.sheetFieldsOf({ reportFor: { name: 'Owner', address: '1 Road' }, referenceStem: '321-John', defaultFeeRateBasisPoints: 2000 }, PRICES_P);
console.log(`  sheet fields: ${JSON.stringify(fields)}`);
console.log(`  prices payload: ${JSON.stringify(sheet.pricesPayload({ ...fields, short: '$85', long: '' }))} · problem on "x": ${sheet.sheetProblem({ ...fields, long: 'x' })}`);
console.log(`  same prices "80" and "80.00": ${sheet.samePriceFields(fields, { ...fields, short: '80' })} · management apart from prices: ${sheet.sameManagement(fields, { ...fields, short: '1' })} · whole row: ${sheet.sameSheetRow(fields, { ...fields, short: '1' })}`);
const save = UpdatePropertySchema.safeParse({ name: 'X', shortTermCents: 8000 });
console.log(`  the property save with a price in its body: ${save.success ? 'ACCEPTED' : `refused — ${save.error.issues.map((i) => i.path.join('.')).join(', ')}`}`);
check(!save.success, 'the property save refuses a cleaning price (never on the public document)');

// ═══ 5. The server: Mark cleaned, by hand, typed after, a preset change, the import ═══
console.log('\n═══ 5. On an in-memory Firestore ═══');
const property = (id, name) => seed('properties', id, { name, icalUrl: `https://www.airbnb.ca/calendar/ical/${id}.ics?s=made-up`, details: { checkOut: '11:00', checkIn: '16:00' }, addressDetails: { city: 'Toronto' } });
property(P, 'Test Priced');
property(Q, 'Test Unpriced');
property(R, 'Test Short Only');
for (const m of [ANA, BEN]) seed('cleaners', m.id, { schemaVersion: 2, name: m.name, role: 'cleaner', status: 'active', sessionEpoch: 1, defaultRateCents: 9000, history: [] });
const setP = await readsOf(sp.setCleaningPrices)(ADMIN, P, PRICES_P);
console.log(`  set P's prices: ${setP.result.kind}, changed ${setP.result.changed}, history ${setP.result.record.history.length} · reads ${setP.reads} (${byText(setP.by)})`);
const setAgain = await sp.setCleaningPrices(ADMIN, P, PRICES_P);
console.log(`  set the same again: changed ${setAgain.changed}, history still ${setAgain.record.history.length}`);
const setR = await sp.setCleaningPrices(ADMIN, R, { shortTermCents: 7000, longTermCents: null });
console.log(`  set R's short-term only: ${setR.result?.kind ?? setR.kind}`);
console.log(`  no such property: ${(await sp.setCleaningPrices(ADMIN, 'TESTPROPnosuchaaaa00', PRICES_P)).kind}`);
const listed = await readsOf(sp.listCleaningPrices)();
console.log(`  listed: ${[...listed.result.keys()].length} records · reads ${listed.reads}`);

/** A job on `pid` for a stay from `start` to `checkout`, with `cleaners` on it, in the written shape. */
const seedJob = (pid, start, checkout, cleaners) => {
  const id = jm.jobIdOf(pid, checkout);
  const made = `${start}T12:00:00.000Z`;
  const assignments = Object.fromEntries(cleaners.map((m) => [m.id, { nameAtAssignment: m.name, assignedAt: made, assignedBy: ADMIN, cleaningId: null, markedAt: null, removedAt: null, removedBy: null }]));
  seed('cleaning_jobs', id, { schemaVersion: jm.JOB_SCHEMA_VERSION, propertyId: pid, propertyNameAtCreation: 'Test', checkout, reservation: { uid: `${id}@airbnb.com`, start }, calendarKey: 'abcdef0123', nextCheckIn: null, status: 'open', change: null, cleanerIds: cleaners.map((m) => m.id), assignments, createdAt: made, history: [jm.jobEvent(made, 'created', jm.CALENDAR_ACTOR, { after: { start, end: checkout } }), ...cleaners.map((m) => jm.jobEvent(made, 'assigned', ADMIN, { cleanerId: m.id, cleanerName: m.name }))] });
  return id;
};
const mark = async (m, id, checkout) => {
  const r = await readsOf(sj.markCleaned)({ id: m.id, name: m.name }, id, new Date(`${checkout}T18:00:00.000Z`));
  const c = r.result.kind === 'marked' ? doc('cleanings', r.result.cleaningId) : null;
  return { kind: r.result.kind, amount: c ? $(c.amountCents) : '-', from: c?.suggested.from, amountFrom: c?.amountFrom, version: c?.schemaVersion, reads: r.reads, by: byText(r.by), id: r.result.cleaningId };
};
const short = await mark(ANA, seedJob(P, '2026-10-16', '2026-10-18', [ANA]), '2026-10-18');
const long = await mark(ANA, seedJob(P, '2026-09-21', '2026-10-19', [ANA]), '2026-10-19');
const edge27 = await mark(ANA, seedJob(P, '2026-09-23', '2026-10-20', [ANA]), '2026-10-20');
const split = seedJob(P, '2026-10-19', '2026-10-21', [ANA, BEN]);
const splitAna = await mark(ANA, split, '2026-10-21');
const splitBen = await mark(BEN, split, '2026-10-21');
const unpriced = await mark(ANA, seedJob(Q, '2026-10-20', '2026-10-22', [ANA]), '2026-10-22');
const shortOnlyLong = await mark(ANA, seedJob(R, '2026-09-20', '2026-10-23', [ANA]), '2026-10-23');
for (const [label, r] of [['P, 2 nights, one cleaner', short], ['P, 28 nights, one cleaner', long], ['P, 27 nights, one cleaner', edge27], ['P, 2 nights, two cleaners — Ana', splitAna], ['P, 2 nights, two cleaners — Ben', splitBen], ['Q (no prices), one cleaner', unpriced], ['R (short only), 33 nights', shortOnlyLong]]) {
  console.log(`  mark ${label}: ${r.kind} · amount ${r.amount} · from ${r.from} · amountFrom ${r.amountFrom} · version ${r.version} · reads ${r.reads} (${r.by})`);
}
check(short.amount === '$80.00' && short.amountFrom === 'short' && long.amount === '$120.00' && long.amountFrom === 'long' && edge27.amount === '$80.00', 'live: the short-term preset at 2 and 27 nights, the long-term one at 28');
check(splitAna.amount === 'none' && splitBen.amount === 'none' && splitAna.from === 'split', 'two cleaners on one job: both cleanings arrive with no amount');
check(unpriced.amount === 'none' && unpriced.from === 'short' && shortOnlyLong.amount === 'none' && shortOnlyLong.from === 'long', 'no matching preset: no amount (Q has none; R has no long-term one)');
check(!short.by.includes('cleanings'), 'a mark reads no earlier cleaning: the amount comes from the property, not from what the cleaner was last paid');
const job2 = doc('cleaning_jobs', split);
console.log(`  the split job's history: ${job2.history.filter((e) => e.action === 'marked').map((e) => `${e.cleanerName} ${e.amountCents === null ? 'no amount' : $(e.amountCents)}`).join(' · ')}`);

// By hand: a day with a long job on P, a day without one, and a changed amount.
const byHandJobDay = await readsOf(cl.logCleaning)(ADMIN, { propertyId: P, cleanerId: BEN.id, day: '2026-10-19', amountCents: 12000, note: null });
const byHandPlain = await readsOf(cl.logCleaning)(ADMIN, { propertyId: P, cleanerId: BEN.id, day: '2026-10-17', amountCents: 8000, note: null });
const byHandTyped = await readsOf(cl.logCleaning)(ADMIN, { propertyId: P, cleanerId: BEN.id, day: '2026-10-15', amountCents: 9500, note: 'deep clean' });
const byHandUnpriced = await readsOf(cl.logCleaning)(ADMIN, { propertyId: Q, cleanerId: BEN.id, day: '2026-10-15', amountCents: 5000, note: null });
for (const [label, r] of [['on the 28-night job\'s day, left at $120', byHandJobDay], ['no job that day, left at $80', byHandPlain], ['no job, typed $95', byHandTyped], ['Q, no preset, typed $50', byHandUnpriced]]) {
  const c = r.result.cleaning;
  console.log(`  by hand ${label}: ${r.result.kind} · ${$(c.amountCents)} · suggested ${JSON.stringify(c.suggested)} · amountFrom ${c.amountFrom} · reads ${r.reads} (${byText(r.by)})`);
}
check(byHandJobDay.result.cleaning.amountFrom === 'long' && byHandPlain.result.cleaning.amountFrom === 'short' && byHandTyped.result.cleaning.amountFrom === 'typed' && byHandUnpriced.result.cleaning.amountFrom === 'typed', 'by hand: the preset by the job\'s stay that day, else short-term; a changed amount is "typed"');
check(!('cleanings' in byHandPlain.result) && !byText(byHandPlain.by).includes('cleanings'), 'logging by hand reads no earlier cleaning');

// Typing the amount of a waiting cleaning, and changing one.
const typedSplit = await cl.changeCleaning(ADMIN, splitAna.id, { amountCents: 4000 }, 1, null);
const after = doc('cleanings', splitAna.id);
console.log(`  Ana's share typed: ${typedSplit.kind} · ${$(after.amountCents)} · amountFrom ${after.amountFrom} · history ${after.history.length} (before ${JSON.stringify(after.history[1].before)}, after ${JSON.stringify(after.history[1].after)})`);
const changedShort = await cl.changeCleaning(ADMIN, short.id, { amountCents: 8500 }, 1, 'extra linen');
const shortAfter = doc('cleanings', short.id);
console.log(`  the $80 cleaning changed to $85: ${changedShort.kind} · amountFrom ${shortAfter.amountFrom} · suggested kept ${JSON.stringify(shortAfter.suggested)}`);
const dayOnly = await cl.changeCleaning(ADMIN, long.id, { note: 'late checkout' }, 1, null);
console.log(`  the $120 cleaning's note changed, amount not: ${dayOnly.kind} · amountFrom ${doc('cleanings', long.id).amountFrom}`);
check(after.amountFrom === 'typed' && shortAfter.amountFrom === 'typed' && doc('cleanings', long.id).amountFrom === 'long', 'an amount typed or changed reads "typed"; a change to another field keeps the preset');
check(cm.readCleaning(short.id, shortAfter) !== null && cm.readCleaning('v2', { ...shortAfter, schemaVersion: 2, amountFrom: undefined, suggested: { from: 'default', cents: 9000 } }) !== null, 'version 3 reads, and a version 2 cleaning (no amountFrom, 37B\'s suggestion) still reads');
check(cm.readCleaning('x', { ...shortAfter, amountFrom: 'preset' }) === null && cm.readCleaning('x', { ...after, amountCents: null, amountFrom: 'short' }) === null, 'refused as not in shape: an unknown source; a source with no amount');

// A preset change leaves every existing cleaning unchanged.
/** Every cleaning made so far: its amount and source, as stored. */
const madeSoFar = [short.id, long.id, edge27.id, splitAna.id, splitBen.id, unpriced.id, shortOnlyLong.id, byHandJobDay.result.cleaning.id, byHandPlain.result.cleaning.id, byHandTyped.result.cleaning.id, byHandUnpriced.result.cleaning.id];
const allAmounts = () => madeSoFar.map((id) => { const c = doc('cleanings', id); return `${id}:${c.amountCents}:${c.amountFrom}`; }).join(',');
const before = allAmounts();
const changeP = await sp.setCleaningPrices(ADMIN, P, { shortTermCents: 9900, longTermCents: 15000 });
const afterChange = allAmounts();
console.log(`  P's prices changed to $99/$150: ${changeP.kind}, history ${changeP.record.history.length} · every cleaning's amount and source as before: ${before === afterChange}`);
check(before === afterChange, 'changing a preset changes no existing cleaning');
const nextMark = await mark(ANA, seedJob(P, '2026-10-22', '2026-10-24', [ANA]), '2026-10-24');
console.log(`  the next mark on P: ${nextMark.amount} (${nextMark.amountFrom})`);
check(nextMark.amount === '$99.00', 'the next cleaning takes the new preset');

// The import, one transaction.
const imported = await readsOf(sp.importCleaningPrices)(ADMIN, [
  { propertyId: P, prices: { shortTermCents: 8000, longTermCents: 12000 } },
  { propertyId: Q, prices: { shortTermCents: 6000, longTermCents: 10000 } },
  { propertyId: R, prices: { shortTermCents: 7000, longTermCents: null } },
]);
console.log(`  import 3 rows: ${imported.result.kind} · ${imported.result.saved.map((s) => `${s.propertyId.slice(-2)} changed ${s.changed} (history ${s.record.history.length})`).join(', ')} · reads ${imported.reads} (${byText(imported.by)})`);
check(imported.result.saved.map((s) => s.changed).join() === 'true,true,false', 'the import writes the rows that change and leaves R, already as given, with no new history event');
const refusedImport = await sp.importCleaningPrices(ADMIN, [{ propertyId: P, prices: PRICES_P }, { propertyId: 'TESTPROPnosuchaaaa00', prices: PRICES_P }]);
console.log(`  import with a property that does not exist: ${refusedImport.kind} (${refusedImport.propertyIds?.length} ID) · P's history still ${doc('property_cleaning_prices', P).history.length}`);
check(refusedImport.kind === 'no-such-property' && doc('property_cleaning_prices', P).history.length === 3, 'a row naming no property refuses the whole import; nothing written');
console.log(`  a property named twice: ${(await sp.importCleaningPrices(ADMIN, [{ propertyId: P, prices: PRICES_P }, { propertyId: P, prices: PRICES_P }])).kind}`);
const waiting = await cl.waitingJobsOf([...madeSoFar, nextMark.id].map((id) => doc('cleanings', id)));
console.log(`  waiting jobs for the tab's hints: ${Object.entries(waiting).map(([id, j]) => `${id.slice(-10)} ${j.nights} nights, ${j.cleaners} cleaners`).join(' · ')}`);

// ═══ 6. A second cleaner after a mark, and the admin-typed recommendation (the second round) ═══
console.log('\n═══ 6. A second cleaner after a mark: the question ═══');
const assignee = (m, cleaning) => ({ cleanerId: m.id, name: m.name, nameAtAssignment: m.name, cleaning });
const marked = { cleanerIds: [ANA.id], assignees: [assignee(ANA, { status: 'logged', amountCents: 8000, amountFrom: 'short' })] };
const q1 = pr.secondCleanerQuestion(marked, [ANA.id, BEN.id]);
console.log(`  Ben added after Ana's $80 mark: ${q1 ? `${q1.title} ${q1.lines.join(' ')} [${q1.confirm}]` : 'no question'}`);
console.log(`  nobody added (Ana alone): ${pr.secondCleanerQuestion(marked, [ANA.id]) === null} · Ana taken off, Ben added (one cleaner): ${pr.secondCleanerQuestion(marked, [BEN.id]) === null}`);
console.log(`  Ana's cleaning waiting for an amount: ${pr.secondCleanerQuestion({ ...marked, assignees: [assignee(ANA, { status: 'logged', amountCents: null, amountFrom: null })] }, [ANA.id, BEN.id]) === null}`);
console.log(`  Ana's mark removed by the office: ${pr.secondCleanerQuestion({ ...marked, assignees: [assignee(ANA, null)] }, [ANA.id, BEN.id]) === null}`);
console.log(`  Ana's amount typed by an admin: ${pr.secondCleanerQuestion({ ...marked, assignees: [assignee(ANA, { status: 'logged', amountCents: 7000, amountFrom: 'typed' })] }, [ANA.id, BEN.id])?.title}`);
const three = pr.secondCleanerQuestion({ cleanerIds: [ANA.id, BEN.id], assignees: [assignee(ANA, { status: 'logged', amountCents: 12000, amountFrom: 'long' }), assignee(BEN, { status: 'logged', amountCents: 4000, amountFrom: 'typed' })] }, [ANA.id, BEN.id, 'TESTCLEANERpricescar']);
console.log(`  a third cleaner added where two carry amounts: ${three.title} | ${three.lines.join(' | ')}`);
check(q1 !== null && q1.title.includes('$80.00') && q1.title.includes('short-term preset') && q1.lines[0].startsWith('With two cleaners') && pr.secondCleanerQuestion(marked, [ANA.id]) === null, 'asked only when a cleaner is added beside a mark that carries an amount, in Kian\'s words');

console.log('\n═══ 6b. The admin-typed recommendation, per tier ═══');
const T = 'TESTPROPpricesaaaa08';
const facts = (id, day, cents, amountFrom, jobId, from = 'short', extra = {}) => ({ id, propertyId: T, day, createdAt: `${day}T18:00:00.000Z`, status: 'logged', amountCents: cents, amountFrom, suggested: { from, cents: null }, jobId, ...extra });
const jobsT = { [`${T}_2026-10-10`]: { nights: 2, cleaners: 1 }, [`${T}_2026-10-12`]: { nights: 28, cleaners: 1 }, [`${T}_2026-10-14`]: { nights: 2, cleaners: 2 }, [`${T}_2026-10-16`]: { nights: 27, cleaners: 1 }, [`${T}_2026-10-18`]: { nights: 2, cleaners: 1 }, [`${T}_2026-10-20`]: { nights: 30, cleaners: 1 } };
const history = [
  facts('c-hand', '2026-10-08', 6500, 'typed', null, 'short'),                                 // by hand, typed: short
  facts('c-short', '2026-10-10', 7000, 'typed', `${T}_2026-10-10`),                           // a job's, one cleaner, 2 nights: short
  facts('c-long', '2026-10-12', 11000, 'typed', `${T}_2026-10-12`),                           // 28 nights: long
  facts('c-share-ana', '2026-10-14', 3500, 'typed', `${T}_2026-10-14`),                      // a share of a two-cleaner job: never counted
  facts('c-share-ben', '2026-10-14', 3500, 'typed', `${T}_2026-10-14`),
  facts('c-27', '2026-10-16', 7500, 'typed', `${T}_2026-10-16`),                              // 27 nights: short, the newest short
  facts('c-removed', '2026-10-18', 9900, 'typed', `${T}_2026-10-18`, 'short', { status: 'removed' }), // removed: never counted
  facts('c-preset', '2026-10-20', 12000, 'long', `${T}_2026-10-20`),                          // from a preset, not typed: never counted
];
const recShort = pr.recommendedAmount(history, jobsT, T, 'short');
const recLong = pr.recommendedAmount(history, jobsT, T, 'long');
console.log(`  short-term: ${$(recShort?.cents)} from ${recShort?.cleaningId} (${recShort?.day}) · long-term: ${$(recLong?.cents)} from ${recLong?.cleaningId} (${recLong?.day})`);
check(recShort?.cleaningId === 'c-27' && recLong?.cleaningId === 'c-long', 'the newest typed amount per tier: 27 nights counts as short-term, 28 as long-term');
check(pr.recommendedAmount(history.filter((c) => c.id !== 'c-27'), jobsT, T, 'short')?.cleaningId === 'c-short', 'a two-cleaner share and a removed cleaning are never the recommendation, however recent');
console.log(`  tiers: ${history.map((c) => `${c.id}:${pr.cleaningTier(c, jobsT)}`).join(' ')} · a job's cleaning whose job is unknown: ${pr.recommendedAmount([facts('c-x', '2026-10-30', 5000, 'typed', `${T}_2026-10-30`)], jobsT, T, 'short') === null}`);
check(pr.recommendedAmount([facts('c-x', '2026-10-30', 5000, 'typed', `${T}_2026-10-30`)], jobsT, T, 'short') === null && pr.recommendedAmount(history, jobsT, 'TESTPROPother', 'short') === null, 'no recommendation from a job not known here, nor from another property');
const waitingShort = facts('w-short', '2026-10-22', null, null, `${T}_2026-10-22`);
const waitingLong = facts('w-long', '2026-10-24', null, null, `${T}_2026-10-24`);
const waitingShare = facts('w-share', '2026-10-26', null, null, `${T}_2026-10-26`, 'split');
const jobsW = { ...jobsT, [`${T}_2026-10-22`]: { nights: 3, cleaners: 1 }, [`${T}_2026-10-24`]: { nights: 29, cleaners: 1 }, [`${T}_2026-10-26`]: { nights: 2, cleaners: 2 } };
const open = (prices, c) => pr.missingAmountStart(prices, history, jobsW, c);
console.log(`  no preset: short field ${JSON.stringify(open(null, waitingShort))} · long field ${JSON.stringify(open(null, waitingLong))} · a share ${JSON.stringify(open(null, waitingShare))}`);
console.log(`  short preset $80 set: short field ${JSON.stringify(open({ shortTermCents: 8000, longTermCents: null }, waitingShort))} · long field still ${open({ shortTermCents: 8000, longTermCents: null }, waitingLong).kind}`);
console.log(`  words: ${pr.recommendationWords('short', 7500)} · ${pr.recommendationWords('long', 11000)} · by hand, no job: ${open(null, facts('w-hand', '2026-10-28', null, null, null)).kind} (${open(null, facts('w-hand', '2026-10-28', null, null, null)).tier})`);
check(open(null, waitingShort).kind === 'recommendation' && open(null, waitingShort).cents === 7500 && open(null, waitingLong).cents === 11000 && open(null, waitingShare).kind === 'split', 'a missing amount opens with the tier\'s recommendation; a share never');
check(open({ shortTermCents: 8000, longTermCents: null }, waitingShort).kind === 'preset' && open({ shortTermCents: 8000, longTermCents: null }, waitingLong).kind === 'recommendation', 'a preset for the tier replaces the recommendation completely; the other tier keeps its own');

console.log('\n═══ 6c. On the in-memory Firestore: typed amounts never become a preset ═══');
const T2 = 'TESTPROPpricesaaaa09';
property(T2, 'Test No Preset');
const typedHand = await cl.logCleaning(ADMIN, { propertyId: T2, cleanerId: BEN.id, day: '2026-10-17', amountCents: 7700, note: null });
const jT = seedJob(T2, '2026-10-16', '2026-10-18', [ANA]);
const markT = await mark(ANA, jT, '2026-10-18');
const typedMark = await cl.changeCleaning(ADMIN, markT.id, { amountCents: 7200 }, 1, null);
const nextT = await mark(ANA, seedJob(T2, '2026-10-18', '2026-10-20', [ANA]), '2026-10-20');
const listT = [typedHand.cleaning.id, markT.id, nextT.id].map((id) => doc('cleanings', id));
const jobsOfT = await cl.waitingJobsOf(listT);
const recT = pr.recommendedAmount(listT.map((c, i) => ({ ...c, id: [typedHand.cleaning.id, markT.id, nextT.id][i] })), jobsOfT, T2, 'short');
console.log(`  by hand $77 (typed) · a mark typed to $72 (${typedMark.kind}) · the next mark: ${nextT.amount} (${nextT.from}) · jobs read for the tab: ${Object.keys(jobsOfT).length} · recommendation now: ${$(recT?.cents)}`);
check(nextT.amount === 'none' && recT?.cents === 7200 && Object.keys(jobsOfT).length === 2, 'Mark cleaned still gives no amount on a property with no preset; the typed $72 is the recommendation, never a preset; the typed cleaning\'s job is read for the tab');
check(doc('property_cleaning_prices', T2) === undefined || doc('property_cleaning_prices', T2) === null, 'no prices record was made for it');

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
