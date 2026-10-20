// The Availability page, round 1 (the audit of 2026-10-19; Kian's rulings K1–K5): the pure parts.
//   K1  the stay's one line: nights × nightly + the cleaning fee, "before taxes"; "no cleaning fee set" with none
//   K4  a stay shorter than the listed minimum is a near miss, "minimum n nights", never a fit
//   K3  "Not on Airbnb · checked <day>"; K5 "Not on the site"; a row read before the run: "calendar read <day, time>"
//   the slice each property is read as (GET /api/admin/availability/properties), and the browser's strict reading of it
// Made-up data; nothing is read from or written to Firestore.
//   node --import ./tests/tools/ts-hook.mjs tests/availability/round1.mjs
import { fileURLToPath } from 'node:url';

const ROOT = process.env.NUBNB_ROOT || fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const { stayLine, stayTotalOf, searchProperties } = await import(`${ROOT}/app/lib/availability/search.ts`);
const { attentionList } = await import(`${ROOT}/app/lib/availability/attention.ts`);
const { rowMarks, readBehindRun } = await import(`${ROOT}/app/lib/availability/marks.ts`);
const { toAvailabilityProperty, isAvailabilityProperty } = await import(`${ROOT}/app/lib/availability/property.ts`);

const out = (s) => console.log(s);

// ─── 1. K1: the one line ───
out('1. K1: the stay total is nights × nightly + the cleaning fee, before taxes; each value an admin-set price, the sum the only arithmetic');
for (const [nights, nightly, cleaningFee] of [[2, 99, 100], [2, 150, 0], [1, 1250, 75], [3, 200, -5], [30, 85, 120]]) {
  out(`  ${nights} × $${nightly}, fee ${cleaningFee}: "${stayLine(nights, { nightly, cleaningFee })}" · total ${stayTotalOf(nights, { nightly, cleaningFee })}`);
}

// ─── A made-up copy and three properties ───
const TODAY = '2026-11-01';
const RUN_AT = '2026-11-01T12:00:00.000Z'; // 08:00 Toronto, 1 November
const feed = (name, over = {}) => ({ name, icalUrl: 'https://example.invalid/calendar/ical/x.ics', status: 'ok', fetchedAt: RUN_AT, bytes: 10, eventCount: 0, events: [], ...over });
const property = (id, over = {}) => ({
  id, name: `${id} address`, publicName: `${id} title`, slug: id.toLowerCase(), city: 'Toronto', area: 'Midtown', location: 'Toronto', type: 'Condo',
  guests: 4, bedrooms: 2, bathrooms: 1, nightly: 99, minNights: 1, cleaningFee: 0, coverImage: '', airbnbUrl: '', offerNames: [], unlisted: false, ...over,
});
const P = property('P', { minNights: 2, cleaningFee: 100 });
const Q = property('Q', { minNights: 28, nightly: 150 });
const R = property('R', { nightly: 80, unlisted: true });
const snapshot = {
  version: 1, refreshedAt: RUN_AT, today: TODAY, horizonEnd: '2027-11-01',
  run: { source: 'daily', trigger: 'admin-page', startedAt: RUN_AT, finishedAt: RUN_AT, durationMs: 3000, fetched: 3, failed: [], pagesChecked: 0 },
  properties: {
    P: feed('P title'),
    Q: feed('Q title'),
    R: feed('R title', { fetchedAt: '2026-10-31T16:13:00.000Z', status: 'failed', failedSince: RUN_AT, failures: 1, error: 'cut', airbnbPage: { checkedAt: '2026-09-30T14:00:00.000Z', status: 410, verdict: 'gone' } }),
  },
};
const query = (checkIn, checkOut) => ({ checkIn, checkOut, guests: null, city: null, bedrooms: 'any', type: null, maxNightly: null, text: '' });
const rows = (list) => list.map((r) => `${r.property.id}[${r.reasons.map((x) => `${x.text}${x.miss ? '!' : ''}`).join(', ')}${r.stayTotal === null ? '' : ` · total ${r.stayTotal}`}]`).join(' ') || '(none)';

// ─── 2. K4 ───
out('\n2. K4: a stay shorter than the listed minimum is a near miss, never a fit');
for (const [checkIn, checkOut] of [['2026-11-10', '2026-11-12'], ['2026-11-10', '2026-11-11'], ['2026-11-10', '2026-12-08'], ['2026-11-10', '2026-12-07']]) {
  const result = searchProperties(snapshot, [P, Q, R], query(checkIn, checkOut), TODAY);
  out(`  ${checkIn} → ${checkOut} (${result.nights} night${result.nights === 1 ? '' : 's'}): fits ${rows(result.fits)} · near ${rows(result.near)} · unread ${result.unread.map((p) => p.id).join(',') || 'none'}`);
}
{
  // With another miss beside it, the minimum still counts as one of the two allowed; a third puts the row out of near.
  const result = searchProperties(snapshot, [Q], { ...query('2026-11-10', '2026-11-12'), guests: 5 }, TODAY);
  out(`  Q for 5 guests, 2 nights: fits ${rows(result.fits)} · near ${rows(result.near)}`);
  const result3 = searchProperties(snapshot, [Q], { ...query('2026-11-10', '2026-11-12'), guests: 5, city: 'Ajax' }, TODAY);
  out(`  Q for 5 guests in Ajax, 2 nights: fits ${rows(result3.fits)} · near ${rows(result3.near)} (three misses: out)`);
}
{
  // Without dates no minimum applies.
  const result = searchProperties(snapshot, [P, Q], query('', ''), TODAY);
  out(`  no dates: fits ${rows(result.fits)} · near ${rows(result.near)}`);
}

// ─── 3. K3, K5, the calendar's read ───
out('\n3. The marks a row carries: "Not on the site" (K5), "Not on Airbnb · checked <day>" (K3), "calendar read <day, time>"');
const marks = (p, f, runAt = RUN_AT) => rowMarks(p, f, runAt).map((m) => `${m.tone}: ${m.text}`).join(' | ') || '(no mark)';
out(`  P, read by the run: ${marks(P, snapshot.properties.P)}`);
out(`  R, unlisted, Airbnb page gone, its read failed: ${marks(R, snapshot.properties.R)}`);
out(`  listed, read before the run (fetchedAt 31 Oct 12:13 Toronto): ${marks(P, feed('x', { fetchedAt: '2026-10-31T16:13:00.000Z' }))}`);
out(`  listed, read by the run but the page gone, checked 30 Sep: ${marks(P, feed('x', { airbnbPage: { checkedAt: '2026-09-30T14:00:00.000Z', status: 404, verdict: 'gone' } }))}`);
out(`  page live: ${marks(P, feed('x', { airbnbPage: { checkedAt: '2026-09-30T14:00:00.000Z', status: 200, verdict: 'live' } }))}`);
out(`  page unknown: ${marks(P, feed('x', { airbnbPage: { checkedAt: '2026-09-30T14:00:00.000Z', status: 403, verdict: 'unknown' } }))}`);
out(`  no feed stored: ${marks(P, undefined)}`);
out(`  never read (fetchedAt null): ${marks(P, feed('x', { fetchedAt: null, status: 'failed' }))}`);
out(`  no run time known: ${marks(P, feed('x', { fetchedAt: '2026-10-31T16:13:00.000Z' }), null)}`);
out(`  readBehindRun: same instant ${readBehindRun(feed('x'), RUN_AT)} · a second earlier ${readBehindRun(feed('x', { fetchedAt: '2026-11-01T11:59:59.000Z' }), RUN_AT)}`);
out('  on the search rows:');
{
  const result = searchProperties(snapshot, [P, Q, R], query('2026-11-10', '2026-11-12'), TODAY);
  for (const row of [...result.fits, ...result.near]) out(`    ${row.property.id}: ${marks(row.property, row.feed, snapshot.refreshedAt)}`);
}
out('  on the ranking rows:');
{
  const result = attentionList(snapshot, [P, Q, R], 30, TODAY, null);
  for (const row of [...result.ranked, ...result.unread]) out(`    ${row.property.id} (${row.group}, sellable ${row.sellable}): ${marks(row.property, row.feed, snapshot.refreshedAt)}`);
}

// ─── 4. The slice ───
out('\n4. The slice of a property the page reads (GET /api/admin/availability/properties), and the browser\'s strict reading of it');
const doc = {
  id: 'p1', name: 'Bright 2BR near the lake', slug: 'bright-2br', addressDetails: { city: 'Toronto', state: 'ON', area: 'Beaches', country: 'Canada' }, location: 'Toronto, ON', type: 'Apartment',
  guests: 4, bedrooms: 2, bathrooms: 1, price: 99, priceInfo: { nightly: 99, weekly: 0, monthly: 0, weekend: 0, cleaningFee: 100, minNights: 2 }, coverImage: 'https://img.invalid/c.jpg', airbnbUrl: 'https://www.airbnb.com/rooms/1',
  offers: [{ name: 'Hot tub', category: 'Outdoor', available: true }, { name: 'Parking (1 space)', category: 'Parking', available: false }, null],
  images: ['a', 'b'], description: 'long text', reviews: [{}], icalUrl: 'https://www.airbnb.com/calendar/ical/secret.ics',
};
const slice = toAvailabilityProperty(doc, '12 Example St', true);
out(`  fields: ${Object.keys(slice).join(', ')}`);
out(`  name "${slice.name}" (the address), public "${slice.publicName}", nightly ${slice.nightly}, fee ${slice.cleaningFee}, min ${slice.minNights}, offers ${JSON.stringify(slice.offerNames)}, unlisted ${slice.unlisted}`);
out(`  the calendar link in the slice: ${'icalUrl' in slice} · images: ${'images' in slice} · description: ${'description' in slice}`);
out(`  without a cleaner-facing name, listed: name "${toAvailabilityProperty(doc).name}", unlisted ${toAvailabilityProperty(doc).unlisted}`);
out(`  no priceInfo: nightly ${toAvailabilityProperty({ ...doc, priceInfo: undefined }).nightly}, fee ${toAvailabilityProperty({ ...doc, priceInfo: undefined }).cleaningFee}, min ${toAvailabilityProperty({ ...doc, priceInfo: undefined }).minNights}`);
const readings = [
  ['the slice as the server answers it', slice],
  ['unlisted missing', (({ unlisted, ...rest }) => rest)(slice)],
  ['unlisted as a string', { ...slice, unlisted: 'true' }],
  ['a number among the offer names', { ...slice, offerNames: ['Hot tub', 3] }],
  ['nightly as a string', { ...slice, nightly: '99' }],
  ['cleaningFee NaN', { ...slice, cleaningFee: Number.NaN }],
  ['the whole property document', doc],
  ['null', null],
];
for (const [label, value] of readings) out(`  ${label}: ${isAvailabilityProperty(value)}`);
