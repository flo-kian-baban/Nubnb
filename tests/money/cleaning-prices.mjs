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
const P = 'TESTPROPpricesaaaa01'; // $83 short, $123 long
const Q = 'TESTPROPpricesaaaa02'; // no prices
const R = 'TESTPROPpricesaaaa03'; // short only
const ANA = { id: 'TESTCLEANERpricesana', name: 'Test Ana' };
const BEN = { id: 'TESTCLEANERpricesben', name: 'Test Ben' };
const PRICES_P = { shortTermCents: 8_300, midTermCents: 9_300, longTermCents: 12_300 };

// ═══ 1. The rule, pure ═══
console.log('═══ 1. The amount rule: 28 nights is long-term, 7–27 mid-term, 1–6 short-term (three tiers since Kian\'s ruling A of 2026-11-01) ═══');
console.log(`  nights Oct 1 → Oct 28: ${pr.stayNights('2026-10-01', '2026-10-28')} · Oct 1 → Oct 29: ${pr.stayNights('2026-10-01', '2026-10-29')} · same day: ${pr.stayNights('2026-10-01', '2026-10-01')} · reversed: ${pr.stayNights('2026-10-05', '2026-10-01')} · not a day: ${pr.stayNights('x', '2026-10-01')}`);
for (const nights of [0, 1, 6, 7, 27, 28, 29, 60]) console.log(`  ${String(nights).padStart(2)} nights → ${pr.presetKind(nights)}: ${$(pr.presetAmount(PRICES_P, nights).cents)}`);
check(pr.presetKind(6) === 'short' && pr.presetKind(7) === 'mid' && pr.presetKind(27) === 'mid' && pr.presetKind(28) === 'long', '6 nights = short, 7 = mid, 27 = mid, 28 = long (the boundaries)');
check(pr.presetAmount(null, 5).cents === null && pr.presetAmount({ shortTermCents: 6_300, longTermCents: null }, 30).cents === null, 'no preset, or no long-term preset for a long stay: no amount');
const job = (cleanerIds, start, checkout) => ({ cleanerIds, reservation: { start }, checkout });
const one27 = pr.markAmount(PRICES_P, job([ANA.id], '2026-10-01', '2026-10-28'));
const one28 = pr.markAmount(PRICES_P, job([ANA.id], '2026-10-01', '2026-10-29'));
const none = pr.markAmount(null, job([ANA.id], '2026-10-27', '2026-10-28'));
console.log(`  mark, one cleaner, 27 nights: ${JSON.stringify(one27)}`);
console.log(`  mark, one cleaner, 28 nights: ${JSON.stringify(one28)}`);
console.log(`  mark, one cleaner, no cleaning price: ${JSON.stringify(none)}`);
check(one27.cents === 9_300 && one27.amountFrom === 'mid' && one28.cents === 12_300 && one28.amountFrom === 'long', 'a mark takes the mid-term cleaning price at 27 nights and the long-term one at 28');
check(none.cents === null && none.from === 'short' && none.amountFrom === null, 'no cleaning price: no amount');
console.log(`  by hand, no job that day: ${JSON.stringify(pr.handLogSuggestion(PRICES_P, null))} · with a 30-night job: ${JSON.stringify(pr.handLogSuggestion(PRICES_P, { reservation: { start: '2026-09-01' }, checkout: '2026-10-01' }))}`);
console.log(`  where the amount came from: left as offered ${pr.amountSourceOf({ from: 'short', cents: 8_300 }, 8_300)} · changed ${pr.amountSourceOf({ from: 'short', cents: 8_300 }, 9_300)} · no preset, typed ${pr.amountSourceOf({ from: 'long', cents: null }, 9_300)}`);
console.log(`  words: ${['short', 'long', 'typed'].map((k) => pr.AMOUNT_SOURCE_WORDS[k]).join(' · ')}`);
console.log(`  a version 2 cleaning's words: ${pr.amountSourceWords({ amountCents: 9_300, suggested: { from: 'default', cents: 9_300 } })} · ${pr.amountSourceWords({ amountCents: 9500, suggested: { from: 'last', cents: 9_300 } })} · an older two-cleaner share: ${pr.amountSourceWords({ amountCents: null, suggested: { from: 'split', cents: null } })}`);
console.log(`  hints: ${pr.waitingHint(PRICES_P, { nights: 30, cleaners: 1 })} | ${pr.waitingHint(PRICES_P, { nights: 2, cleaners: 1 })} | ${pr.waitingHint(null, { nights: 2, cleaners: 1 })} | ${pr.waitingHint(PRICES_P, null)}`);
check(pr.AMOUNT_SOURCE_WORDS.short === 'short-term cleaning price' && pr.AMOUNT_SOURCE_WORDS.long === 'long-term cleaning price' && !Object.values(pr.AMOUNT_SOURCE_WORDS).some((w) => /preset|base price/.test(w)) && !pr.waitingHint(PRICES_P, null).includes('reset'), 'the one word: "cleaning price", never "preset" or "base price" (Build 2)');

// ═══ 2. Typed prices and the record ═══
console.log('\n═══ 2. Typed prices, the record ═══');
console.log(`  typed: ${['', 'none', '83', '$83', '83.5', '83.50', '1,234.00', '0', '0.00', '10_300', 'abc', '83.123'].map((t) => `${JSON.stringify(t)}→${JSON.stringify(pr.readPriceText(t))}`).join(' ')}`);
console.log(`  for the route: ${['', '83', 'x'].map((t) => `${JSON.stringify(t)}→${JSON.stringify(pr.priceTextForRoute(t))}`).join(' ')} · field: ${pr.priceField(8_300)} ${JSON.stringify(pr.priceField(null))}`);
const record = { schemaVersion: 1, propertyId: P, shortTermCents: 8_300, longTermCents: 12_300, setAt: '2026-10-19T12:00:00.000Z', setBy: ADMIN, history: [{ at: '2026-10-19T12:00:00.000Z', actor: ADMIN, before: { shortTermCents: null, longTermCents: null }, after: { shortTermCents: 8_300, longTermCents: 12_300 } }] };
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
const csv = ['address,short,long', '12 Test Rd,83.00,123.00', '"12 Test Rd B",$63,$103', '  12   test rd  s ,73,', 'No Such Place,53,83', '12 Test Rd,93,133', 'Twin Address,63,83', '12 Test Rd C,abc,83', '', '12 Test Rd D,,'].join('\r\n');
const parsed = pr.parsePricesCsv(`﻿${csv}`);
console.log(`  parsed: ${parsed.kind}, ${parsed.rows?.length} rows (a BOM, CRLF, quotes and a blank line taken in stride) · lines: ${parsed.rows?.map((r) => r.line).join(',')}`);
console.log(`  header problems: ${pr.parsePricesCsv('address,price\n1 X,83').problem} · ${pr.parsePricesCsv('').problem} · ${pr.parsePricesCsv('address,short,long\n').problem}`);
console.log(`  other column names taken: ${pr.parsePricesCsv('Suite / Property,Short Term Price,Long Term Price (28+ Days)\n1 X,83,103').kind}`);
const properties = [
  { id: P, name: '12 Test Rd' },
  { id: Q, name: '12 Test Rd B' },
  { id: R, name: '12 TEST RD S' },
  { id: 'TESTPROPpricesaaaa04', name: 'Twin Address' },
  { id: 'TESTPROPpricesaaaa05', name: 'Twin  Address' },
  { id: 'TESTPROPpricesaaaa06', name: '12 Test Rd C' },
  { id: 'TESTPROPpricesaaaa07', name: '12 Test Rd D' },
];
const current = new Map([[P, { shortTermCents: 8_300, midTermCents: 8_300, longTermCents: 12_300 }], ['TESTPROPpricesaaaa07', { shortTermCents: null, midTermCents: null, longTermCents: null }]]);
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
console.log(`  prices: ${parse(sc.CleaningPricesSchema, { shortTerm: '83.00', midTerm: null, longTerm: null })} · ${parse(sc.CleaningPricesSchema, { shortTerm: '83', midTerm: '83.00', longTerm: '123.00' })} · ${parse(sc.CleaningPricesSchema, { shortTerm: '0.00', midTerm: null, longTerm: null })} · ${parse(sc.CleaningPricesSchema, { shortTerm: null })}`);
console.log(`  import: ${parse(sc.ImportCleaningPricesSchema, { rows: [{ propertyId: P, shortTerm: '83.00', midTerm: '83.00', longTerm: '123.00' }] })} · empty: ${parse(sc.ImportCleaningPricesSchema, { rows: [] })}`);
console.log(`  suggest: ${parse(sc.SuggestQuerySchema, { propertyId: P, day: '2026-10-19' })} · ${parse(sc.SuggestQuerySchema, { propertyId: P, day: 'today' })}`);
const fields = sheet.sheetFieldsOf({ reportFor: { name: 'Owner', address: '1 Road' }, referenceStem: '12-Test', defaultFeeRateBasisPoints: 2000 }, PRICES_P);
console.log(`  sheet fields: ${JSON.stringify(fields)}`);
console.log(`  prices payload: ${JSON.stringify(sheet.pricesPayload({ ...fields, short: '$85', long: '' }))} · problem on "x": ${sheet.sheetProblem({ ...fields, long: 'x' })}`);
console.log(`  same prices "83" and "83.00": ${sheet.samePriceFields(fields, { ...fields, short: '83' })} · management apart from prices: ${sheet.sameManagement(fields, { ...fields, short: '1' })} · whole row: ${sheet.sameSheetRow(fields, { ...fields, short: '1' })}`);
const save = UpdatePropertySchema.safeParse({ name: 'X', shortTermCents: 8_300 });
console.log(`  the property save with a price in its body: ${save.success ? 'ACCEPTED' : `refused — ${save.error.issues.map((i) => i.path.join('.')).join(', ')}`}`);
check(!save.success, 'the property save refuses a cleaning price (never on the public document)');

// ═══ 5. The server: Mark cleaned, by hand, typed after, a preset change, the import ═══
console.log('\n═══ 5. On an in-memory Firestore ═══');
const property = (id, name) => seed('properties', id, { name, icalUrl: `https://www.airbnb.ca/calendar/ical/${id}.ics?s=made-up`, details: { checkOut: '11:00', checkIn: '16:00' }, addressDetails: { city: 'Toronto' } });
property(P, 'Test Priced');
property(Q, 'Test Unpriced');
property(R, 'Test Short Only');
for (const m of [ANA, BEN]) seed('cleaners', m.id, { schemaVersion: 2, name: m.name, role: 'cleaner', status: 'active', sessionEpoch: 1, defaultRateCents: 9_300, history: [] });
const setP = await readsOf(sp.setCleaningPrices)(ADMIN, P, PRICES_P);
console.log(`  set P's prices: ${setP.result.kind}, changed ${setP.result.changed}, history ${setP.result.record.history.length} · reads ${setP.reads} (${byText(setP.by)})`);
const setAgain = await sp.setCleaningPrices(ADMIN, P, PRICES_P);
console.log(`  set the same again: changed ${setAgain.changed}, history still ${setAgain.record.history.length}`);
const setR = await sp.setCleaningPrices(ADMIN, R, { shortTermCents: 7_300, midTermCents: 7_300, longTermCents: null });
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
// One cleaner per job since Build 2: two jobs on one day instead of two cleaners on one (each with its own price).
const dayJobAna = await mark(ANA, seedJob(P, '2026-10-19', '2026-10-21', [ANA]), '2026-10-21');
const unpriced = await mark(ANA, seedJob(Q, '2026-10-20', '2026-10-22', [ANA]), '2026-10-22');
const shortOnlyLong = await mark(ANA, seedJob(R, '2026-09-20', '2026-10-23', [ANA]), '2026-10-23');
for (const [label, r] of [['P, 2 nights, one cleaner', short], ['P, 28 nights, one cleaner', long], ['P, 27 nights, one cleaner', edge27], ['P, 2 nights, Oct 21', dayJobAna], ['Q (no prices), one cleaner', unpriced], ['R (short only), 33 nights', shortOnlyLong]]) {
  console.log(`  mark ${label}: ${r.kind} · amount ${r.amount} · from ${r.from} · amountFrom ${r.amountFrom} · version ${r.version} · reads ${r.reads} (${r.by})`);
}
check(short.amount === '$83.00' && short.amountFrom === 'short' && long.amount === '$123.00' && long.amountFrom === 'long' && edge27.amount === '$93.00' && edge27.amountFrom === 'mid', 'live: the short-term cleaning price at 2 nights, the mid-term one at 27, the long-term one at 28');
check(unpriced.amount === 'none' && unpriced.from === 'short' && shortOnlyLong.amount === 'none' && shortOnlyLong.from === 'long', 'no matching cleaning price: no amount (Q has none; R has no long-term one)');
check(!short.by.includes('cleanings'), 'a mark reads no earlier cleaning: the amount comes from the property, not from what the cleaner was last paid');

// By hand: a day with a long job on P, a day without one, and a changed amount.
const byHandJobDay = await readsOf(cl.logCleaning)(ADMIN, { propertyId: P, cleanerId: BEN.id, day: '2026-10-19', amountCents: 12_300, note: null });
const byHandPlain = await readsOf(cl.logCleaning)(ADMIN, { propertyId: P, cleanerId: BEN.id, day: '2026-10-17', amountCents: 8_300, note: null });
const byHandTyped = await readsOf(cl.logCleaning)(ADMIN, { propertyId: P, cleanerId: BEN.id, day: '2026-10-15', amountCents: 9500, note: 'deep clean' });
const byHandUnpriced = await readsOf(cl.logCleaning)(ADMIN, { propertyId: Q, cleanerId: BEN.id, day: '2026-10-15', amountCents: 5_300, note: null });
for (const [label, r] of [['on the 28-night job\'s day, left at $123', byHandJobDay], ['no job that day, left at $83', byHandPlain], ['no job, typed $95', byHandTyped], ['Q, no preset, typed $53', byHandUnpriced]]) {
  const c = r.result.cleaning;
  console.log(`  by hand ${label}: ${r.result.kind} · ${$(c.amountCents)} · suggested ${JSON.stringify(c.suggested)} · amountFrom ${c.amountFrom} · reads ${r.reads} (${byText(r.by)})`);
}
check(byHandJobDay.result.cleaning.amountFrom === 'long' && byHandPlain.result.cleaning.amountFrom === 'short' && byHandTyped.result.cleaning.amountFrom === 'typed' && byHandUnpriced.result.cleaning.amountFrom === 'typed', 'by hand: the preset by the job\'s stay that day, else short-term; a changed amount is "typed"');
check(!('cleanings' in byHandPlain.result) && !byText(byHandPlain.by).includes('cleanings'), 'logging by hand reads no earlier cleaning');

// Typing the amount of a cleaning that needs one, and changing one.
const typedSplit = await cl.changeCleaning(ADMIN, unpriced.id, { amountCents: 4_300 }, 1, null);
const after = doc('cleanings', unpriced.id);
console.log(`  the unpriced cleaning's amount typed: ${typedSplit.kind} · ${$(after.amountCents)} · amountFrom ${after.amountFrom} · history ${after.history.length} (before ${JSON.stringify(after.history[1].before)}, after ${JSON.stringify(after.history[1].after)})`);
const changedShort = await cl.changeCleaning(ADMIN, short.id, { amountCents: 8500 }, 1, 'extra linen');
const shortAfter = doc('cleanings', short.id);
console.log(`  the $83 cleaning changed to $85: ${changedShort.kind} · amountFrom ${shortAfter.amountFrom} · suggested kept ${JSON.stringify(shortAfter.suggested)}`);
const dayOnly = await cl.changeCleaning(ADMIN, long.id, { note: 'late checkout' }, 1, null);
console.log(`  the $123 cleaning's note changed, amount not: ${dayOnly.kind} · amountFrom ${doc('cleanings', long.id).amountFrom}`);
check(after.amountFrom === 'typed' && shortAfter.amountFrom === 'typed' && doc('cleanings', long.id).amountFrom === 'long', 'an amount typed or changed reads "typed"; a change to another field keeps the cleaning price');
check(cm.readCleaning(short.id, shortAfter) !== null && cm.readCleaning('v2', { ...shortAfter, schemaVersion: 2, amountFrom: undefined, suggested: { from: 'default', cents: 9_300 } }) !== null, 'version 3 reads, and a version 2 cleaning (no amountFrom, 37B\'s suggestion) still reads');
check(cm.readCleaning('x', { ...shortAfter, amountFrom: 'preset' }) === null && cm.readCleaning('x', { ...after, amountCents: null, amountFrom: 'short' }) === null, 'refused as not in shape: an unknown source; a source with no amount');

// A preset change leaves every existing cleaning unchanged.
/** Every cleaning made so far: its amount and source, as stored. */
const madeSoFar = [short.id, long.id, edge27.id, dayJobAna.id, unpriced.id, shortOnlyLong.id, byHandJobDay.result.cleaning.id, byHandPlain.result.cleaning.id, byHandTyped.result.cleaning.id, byHandUnpriced.result.cleaning.id];
const allAmounts = () => madeSoFar.map((id) => { const c = doc('cleanings', id); return `${id}:${c.amountCents}:${c.amountFrom}`; }).join(',');
const before = allAmounts();
const changeP = await sp.setCleaningPrices(ADMIN, P, { shortTermCents: 9900, longTermCents: 15_300 });
const afterChange = allAmounts();
console.log(`  P's prices changed to $99/$153: ${changeP.kind}, history ${changeP.record.history.length} · every cleaning's amount and source as before: ${before === afterChange}`);
check(before === afterChange, 'changing a preset changes no existing cleaning');
const nextMark = await mark(ANA, seedJob(P, '2026-10-22', '2026-10-24', [ANA]), '2026-10-24');
console.log(`  the next mark on P: ${nextMark.amount} (${nextMark.amountFrom})`);
check(nextMark.amount === '$99.00', 'the next cleaning takes the new preset');

// The import, one transaction.
const imported = await readsOf(sp.importCleaningPrices)(ADMIN, [
  { propertyId: P, prices: { shortTermCents: 8_300, midTermCents: 8_300, longTermCents: 12_300 } },
  { propertyId: Q, prices: { shortTermCents: 6_300, midTermCents: 6_300, longTermCents: 10_300 } },
  { propertyId: R, prices: { shortTermCents: 7_300, midTermCents: 7_300, longTermCents: null } },
]);
console.log(`  import 3 rows: ${imported.result.kind} · ${imported.result.saved.map((s) => `${s.propertyId.slice(-2)} changed ${s.changed} (history ${s.record.history.length})`).join(', ')} · reads ${imported.reads} (${byText(imported.by)})`);
check(imported.result.saved.map((s) => s.changed).join() === 'true,true,false', 'the import writes the rows that change and leaves R, already as given, with no new history event');
const refusedImport = await sp.importCleaningPrices(ADMIN, [{ propertyId: P, prices: PRICES_P }, { propertyId: 'TESTPROPnosuchaaaa00', prices: PRICES_P }]);
console.log(`  import with a property that does not exist: ${refusedImport.kind} (${refusedImport.propertyIds?.length} ID) · P's history still ${doc('property_cleaning_prices', P).history.length}`);
check(refusedImport.kind === 'no-such-property' && doc('property_cleaning_prices', P).history.length === 3, 'a row naming no property refuses the whole import; nothing written');
console.log(`  a property named twice: ${(await sp.importCleaningPrices(ADMIN, [{ propertyId: P, prices: PRICES_P }, { propertyId: P, prices: PRICES_P }])).kind}`);
const waiting = await cl.waitingJobsOf([...madeSoFar, nextMark.id].map((id) => doc('cleanings', id)));
console.log(`  waiting jobs for the tab's hints: ${Object.entries(waiting).map(([id, j]) => `${id.slice(-10)} ${j.nights} nights, ${j.cleaners} cleaners`).join(' · ')}`);

// ═══ 6. The admin-typed recommendation (the second round). The second-cleaner question of 2026-10-19 is gone since Build 2: a job has one cleaner. ═══
console.log('\n═══ 6. One cleaner per job (Build 2): no second-cleaner question remains ═══');
check(typeof pr.secondCleanerQuestion === 'undefined', 'the second-cleaner question is gone: a job has one cleaner (Kian\'s ruling of 2026-11-03)');

console.log('\n═══ 6b. The admin-typed recommendation, per tier ═══');
const T = 'TESTPROPpricesaaaa08';
const facts = (id, day, cents, amountFrom, jobId, from = 'short', extra = {}) => ({ id, propertyId: T, day, createdAt: `${day}T18:00:00.000Z`, status: 'logged', amountCents: cents, amountFrom, suggested: { from, cents: null }, jobId, ...extra });
const jobsT = { [`${T}_2026-10-10`]: { nights: 2, cleaners: 1 }, [`${T}_2026-10-12`]: { nights: 28, cleaners: 1 }, [`${T}_2026-10-14`]: { nights: 2, cleaners: 2 }, [`${T}_2026-10-16`]: { nights: 27, cleaners: 1 }, [`${T}_2026-10-18`]: { nights: 2, cleaners: 1 }, [`${T}_2026-10-20`]: { nights: 30, cleaners: 1 } };
const history = [
  facts('c-hand', '2026-10-08', 6500, 'typed', null, 'short'),                                 // by hand, typed: short
  facts('c-short', '2026-10-10', 7_300, 'typed', `${T}_2026-10-10`),                           // a job's, one cleaner, 2 nights: short
  facts('c-long', '2026-10-12', 11_300, 'typed', `${T}_2026-10-12`),                           // 28 nights: long
  facts('c-share-ana', '2026-10-14', 3500, 'typed', `${T}_2026-10-14`),                      // a share of a two-cleaner job: never counted
  facts('c-share-ben', '2026-10-14', 3500, 'typed', `${T}_2026-10-14`),
  facts('c-27', '2026-10-16', 7500, 'typed', `${T}_2026-10-16`),                              // 27 nights: mid-term since ruling A (the only mid)
  facts('c-removed', '2026-10-18', 9900, 'typed', `${T}_2026-10-18`, 'short', { status: 'removed' }), // removed: never counted
  facts('c-preset', '2026-10-20', 12_300, 'long', `${T}_2026-10-20`),                          // from a preset, not typed: never counted
];
const recShort = pr.recommendedAmount(history, jobsT, T, 'short');
const recMid = pr.recommendedAmount(history, jobsT, T, 'mid');
const recLong = pr.recommendedAmount(history, jobsT, T, 'long');
console.log(`  short-term: ${$(recShort?.cents)} from ${recShort?.cleaningId} (${recShort?.day}) · mid-term: ${$(recMid?.cents)} from ${recMid?.cleaningId} (${recMid?.day}) · long-term: ${$(recLong?.cents)} from ${recLong?.cleaningId} (${recLong?.day})`);
check(recShort?.cleaningId === 'c-short' && recMid?.cleaningId === 'c-27' && recLong?.cleaningId === 'c-long', 'the newest typed amount per tier: 2 nights counts as short-term, 27 as mid-term, 28 as long-term');
check(pr.recommendedAmount(history.filter((c) => c.id !== 'c-27'), jobsT, T, 'short')?.cleaningId === 'c-short', 'a two-cleaner share and a removed cleaning are never the recommendation, however recent');
console.log(`  tiers: ${history.map((c) => `${c.id}:${pr.cleaningTier(c, jobsT)}`).join(' ')} · a job's cleaning whose job is unknown: ${pr.recommendedAmount([facts('c-x', '2026-10-30', 5_300, 'typed', `${T}_2026-10-30`)], jobsT, T, 'short') === null}`);
check(pr.recommendedAmount([facts('c-x', '2026-10-30', 5_300, 'typed', `${T}_2026-10-30`)], jobsT, T, 'short') === null && pr.recommendedAmount(history, jobsT, 'TESTPROPother', 'short') === null, 'no recommendation from a job not known here, nor from another property');
const waitingShort = facts('w-short', '2026-10-22', null, null, `${T}_2026-10-22`);
const waitingLong = facts('w-long', '2026-10-24', null, null, `${T}_2026-10-24`);
const waitingShare = facts('w-share', '2026-10-26', null, null, `${T}_2026-10-26`, 'split');
const jobsW = { ...jobsT, [`${T}_2026-10-22`]: { nights: 3, cleaners: 1 }, [`${T}_2026-10-24`]: { nights: 29, cleaners: 1 }, [`${T}_2026-10-26`]: { nights: 2, cleaners: 2 } };
const open = (prices, c) => pr.missingAmountStart(prices, history, jobsW, c);
console.log(`  no cleaning price: short field ${JSON.stringify(open(null, waitingShort))} · long field ${JSON.stringify(open(null, waitingLong))} · an older two-cleaner share ${JSON.stringify(open(null, waitingShare))}`);
console.log(`  short price $83 set: short field ${JSON.stringify(open({ shortTermCents: 8_300, longTermCents: null }, waitingShort))} · long field still ${open({ shortTermCents: 8_300, longTermCents: null }, waitingLong).kind}`);
console.log(`  words: ${pr.recommendationWords('short', 7500)} · ${pr.recommendationWords('long', 11_300)} · by hand, no job: ${open(null, facts('w-hand', '2026-10-28', null, null, null)).kind} (${open(null, facts('w-hand', '2026-10-28', null, null, null)).tier})`);
console.log(`  how each opens (Build 2): recommendation ${JSON.stringify(pr.fieldStart(open(null, waitingShort)))} · price ${JSON.stringify(pr.fieldStart(open({ shortTermCents: 8_300, longTermCents: null }, waitingShort)))} · nothing ${JSON.stringify(pr.fieldStart(open(null, facts('w-hand', '2026-10-28', null, null, null))))}`);
check(open(null, waitingShort).kind === 'recommendation' && open(null, waitingShort).cents === 7_300 && open(null, waitingLong).cents === 11_300 && open(null, waitingShare).kind === 'none', 'a missing amount starts from the tier\'s recommendation; an older two-cleaner share from nothing');
check(open({ shortTermCents: 8_300, longTermCents: null }, waitingShort).kind === 'preset' && open({ shortTermCents: 8_300, longTermCents: null }, waitingLong).kind === 'recommendation', 'a cleaning price for the tier replaces the recommendation completely; the other tier keeps its own');
check(pr.fieldStart(open(null, waitingShort)).value === '' && pr.fieldStart(open(null, waitingShort)).placeholder === '73.00' && pr.fieldStart(open({ shortTermCents: 8_300, longTermCents: null }, waitingShort)).value === '83.00', 'never save a suggestion (Build 2, item 3): the recommendation is a placeholder, never the field\'s value; the cleaning price fills it');

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
