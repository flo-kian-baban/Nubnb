// The name every internal surface shows, and what owners receive (Kian's rulings of 2026-10-15, evening): a property's
// cleaner-facing name, usually its street address, else its public title. The public title stays what Airbnb titles are
// matched against. Made-up data only: properties "TESTPROP…", titles "Test …", addresses "1 Test St …". Nothing is read
// from or written to production.
//   node --import ./tests/tools/ts-hook.mjs tests/names/internal-names.mjs
import { fileURLToPath } from 'node:url';

const ROOT = process.env.NUBNB_ROOT || fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const names = await import(`${ROOT}/app/lib/property-names.ts`);
const report = await import(`${ROOT}/app/lib/costs/report.ts`);
const availability = await import(`${ROOT}/app/lib/availability/property.ts`);
const search = await import(`${ROOT}/app/lib/availability/search.ts`);
const month = await import(`${ROOT}/app/lib/income/month.ts`);
const leads = await import(`${ROOT}/app/lib/leads.ts`);

let failures = 0;
const check = (ok, label) => {
  if (!ok) failures += 1;
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${label}`);
};

// ═══ 1. The label ═══
console.log('═══ 1. internalLabel: the cleaner-facing name, else the public title ═══');
for (const [p, want] of [
  [{ name: 'Test Corner Penthouse', internalName: '1 Test St, unit 4' }, '1 Test St, unit 4'],
  [{ name: 'Test Corner Penthouse', internalName: null }, 'Test Corner Penthouse'],
  [{ name: 'Test Corner Penthouse', internalName: '   ' }, 'Test Corner Penthouse'],
  [{ name: 'Test Corner Penthouse' }, 'Test Corner Penthouse'],
  [{ name: '', internalName: null }, null],
  [null, null],
]) {
  const got = names.internalLabel(p);
  console.log(`    ${JSON.stringify(p)} → ${JSON.stringify(got)}`);
  check(got === want, `shows ${JSON.stringify(want)}`);
}

// ═══ 2. Costs: the entry's property, and the ledger export's name and file ═══
console.log('\n═══ 2. Costs: propertyLabel, as the queue, the ledger and its exports name a property ═══');
const entry = (property) => ({ property: { id: 'TESTPROP0001', state: 'found', nameAtEntry: 'Test Old Title', ...property } });
for (const [property, want] of [
  [{ name: 'Test Corner Penthouse', internalName: '1 Test St, unit 4' }, '1 Test St, unit 4'],
  [{ name: 'Test Corner Penthouse', internalName: null }, 'Test Corner Penthouse'],
  [{ name: 'Test Corner Penthouse' }, 'Test Corner Penthouse'],
  [{ state: 'missing', name: null, internalName: null }, 'Test Old Title'],
]) {
  const got = report.propertyLabel(entry(property));
  console.log(`    ${JSON.stringify(property)} → ${JSON.stringify(got)}`);
  check(got === want, `labelled ${JSON.stringify(want)}`);
}
const file = report.reportFileName({ propertyName: '1 Test St, unit 4', from: '2026-09-01', to: '2026-09-30' }, 'pdf');
console.log(`    ledger PDF named: ${file}`);
check(file.includes('1-test-st-unit-4'), 'the export file is named by the address');

// ═══ 3. Availability: the address as the name, the public title under it and searched ═══
console.log('\n═══ 3. Availability: named by the address, found by either ═══');
const listing = { id: 'TESTPROP0002', name: 'Test Sunlit Boho Skyline Stay', slug: 'test-sunlit-boho', addressDetails: { city: 'Toronto', area: 'Test Area' }, offers: [] };
const withAddress = availability.toAvailabilityProperty(listing, '2 Test Ave, suite 9');
const without = availability.toAvailabilityProperty(listing);
console.log(`    with a cleaner-facing name: name ${JSON.stringify(withAddress.name)} · public ${JSON.stringify(withAddress.publicName)}`);
console.log(`    without:                    name ${JSON.stringify(without.name)} · public ${JSON.stringify(without.publicName)}`);
check(withAddress.name === '2 Test Ave, suite 9' && withAddress.publicName === 'Test Sunlit Boho Skyline Stay', 'the address is the name; the public title rides beside it');
check(without.name === 'Test Sunlit Boho Skyline Stay', 'with no cleaner-facing name, the public title is the name');
for (const [text, want] of [['boho skyline', true], ['test ave', true], ['suite 9', true], ['penthouse', false]]) {
  const got = search.matchesText(withAddress, text);
  console.log(`    "${text}" → ${got ? 'found' : 'not found'}`);
  check(got === want, `"${text}" ${want ? 'finds' : 'does not find'} it`);
}

// ═══ 4. Income: shown by the address, matched by the public title ═══
console.log('\n═══ 4. Income: the page shows the address; titles still match the public title ═══');
const properties = [
  { id: 'TESTPROP0003', name: 'Test Private Basement Near Yonge', internalName: '3 Test Rd, lower' },
  { id: 'TESTPROP0004', name: 'Test Cozy Pad', internalName: 'Test Cozy Pad' },
];
check(month.suggestedProperty(properties, 'Test Private Basement Near Yonge') === 'TESTPROP0003', 'an Airbnb title equal to the public title suggests the property');
check(month.suggestedProperty(properties, '3 Test Rd, lower') === null, 'an Airbnb title equal to the address suggests nothing (matching never reads the address)');
const ADMIN = { role: 'admin', id: 'TESTADMIN0001', name: 'Test Admin' };
const link = { id: 'TESTLINK-1', schemaVersion: 1, platform: 'airbnb', title: 'Test Private Basement Near Yonge', propertyId: 'TESTPROP0003', linkedAt: '2026-08-20T12:00:00.000Z', actor: ADMIN, history: [], active: true };
const line = {
  id: 'TESTLINE000001', schemaVersion: 1, platform: 'airbnb', uploadId: 'TESTUPLOAD1', fileRow: 2, payoutDate: '2026-09-15', month: '2026-09', type: 'Reservation',
  confirmationCode: 'TESTCODE1', listingTitle: 'Test Private Basement Near Yonge', stay: { start: '2026-09-10', end: '2026-09-14', nights: 4 }, amountCents: 10_000, currency: 'CAD',
  evidence: { grossCents: null, serviceFeeCents: null, cleaningFeeCents: null }, remittedTaxCents: null, status: 'proposed', decided: null, history: [],
};
const view = month.monthView({
  uploads: [{ platform: 'airbnb', month: '2026-09', titles: [{ title: 'Test Private Basement Near Yonge', rows: 1, amountCents: 10_000 }] }],
  lines: [line], links: [link], lastSeen: {}, properties, statements: [], calendar: { checkIns: [] }, month: '2026-09',
});
console.log(`    to review: ${view.review.map((g) => `${g.propertyId} "${g.name}" (${g.lines.length})`).join(', ')}`);
check(view.review.length === 1 && view.review[0].name === '3 Test Rd, lower', 'the review group is named by the address');

// ═══ 5. Leads: found by the title the renter saw, or by the address ═══
console.log('\n═══ 5. Leads: the inbox search ═══');
const lead = { id: 'TESTLEAD1', name: 'Test Renter', email: 'renter@example.test', propertyName: 'Test Bright Walkout Basement', propertyId: 'TESTPROP0005', propertyInternalName: '5 Test Cres' };
for (const [q, want] of [['walkout', true], ['test cres', true], ['nothing like it', false]]) {
  const got = leads.matchesLeadSearch(lead, q);
  console.log(`    "${q}" → ${got ? 'found' : 'not found'}`);
  check(got === want, `"${q}" ${want ? 'finds' : 'does not find'} the lead`);
}

console.log(`\n${failures === 0 ? 'every check passed' : `${failures} check(s) FAILED`}`);
if (failures > 0) process.exitCode = 1;
