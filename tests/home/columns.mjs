// The property list's Income and Cleaning columns (Kian's rulings of 2026-10-15, part A of
// PROPERTY-LIST-COLUMNS-PLAN.md): every state each cell can show, decided by app/lib/income/standing.ts and
// app/lib/schedule/standing.ts, on made-up records shaped as the server reads them. Made-up data only: properties
// "TESTPROP…", titles "Test …", cleaners "Test …". Nothing is read from or written to production.
//   node --import ./tests/tools/ts-hook.mjs tests/home/columns.mjs
import { fileURLToPath } from 'node:url';

const ROOT = process.env.NUBNB_ROOT || fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const income = await import(`${ROOT}/app/lib/income/standing.ts`);
const cleaning = await import(`${ROOT}/app/lib/schedule/standing.ts`);
const monthModule = await import(`${ROOT}/app/lib/income/month.ts`);

const ADMIN = { role: 'admin', id: 'TESTADMIN0001', name: 'Test Admin' };
let failures = 0;
const check = (ok, label) => {
  if (!ok) failures += 1;
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${label}`);
};
const show = (s) => `${s.key} · "${s.label}" · ${s.tone} · ${s.month ?? s.day ?? '-'}${s.target ? ` · → ${s.target}` : ''} · ${s.title}`;

// ═══ 1. Income ═══
console.log('═══ 1. Income: the month due (September 2026), worst first ═══');
const MONTH = '2026-09';
let row = 0;
function line(title, { status = 'proposed', property = null, type = 'Reservation', cents = 10_000, month = MONTH } = {}) {
  row += 1;
  const at = '2026-10-14T16:00:00.000Z';
  return {
    id: `TESTLINE${String(row).padStart(6, '0')}`, schemaVersion: 1, platform: 'airbnb', uploadId: 'TESTUPLOAD1', fileRow: row + 1, payoutDate: `${month}-15`, month, type,
    confirmationCode: `TESTCODE${row}`, listingTitle: title, stay: { start: `${month}-10`, end: `${month}-14`, nights: 4 }, amountCents: cents, currency: 'CAD',
    evidence: { grossCents: null, serviceFeeCents: null, cleaningFeeCents: null }, remittedTaxCents: null, status,
    decided: status === 'accepted' ? { status: 'accepted', at, actor: ADMIN, propertyId: property, description: `Revenue - ${title}`, amountCents: cents, edited: false } : status === 'rejected' ? { status: 'rejected', at, actor: ADMIN } : null,
    history: [],
  };
}
const link = (title, propertyId, { active = true, linkedAt = '2026-08-20T12:00:00.000Z' } = {}) => ({ id: `TESTLINK-${title}`, schemaVersion: 1, platform: 'airbnb', title, propertyId, linkedAt, actor: ADMIN, history: [], active });
const upload = (titles, month = MONTH) => ({ platform: 'airbnb', month, titles: titles.map((title) => ({ title, rows: 1, amountCents: 10_000 })) });

const P = (n) => `TESTPROP${String(n).padStart(4, '0')}`;
const links = [
  link('Test Review Loft', P(1)),
  link('Test Missing Suite', P(2)),
  link('Test Received Condo', P(3)),
  link('Test Both Studio', P(4)),
  link('Test Quiet House', P(6)),
  link('Test New Title', P(7), { linkedAt: '2026-09-25T12:00:00.000Z' }),
  link('Test Old Title', P(8), { active: false }),
  link('Test Current Title', P(8)),
];
const lines = [
  line('Test Review Loft'),
  line('Test Review Loft', { type: 'Unknown Thing' }),
  line('Test Received Condo', { status: 'accepted', property: P(3), cents: 45_000 }),
  line('Test Received Condo', { status: 'accepted', property: P(3), cents: -5_000, type: 'Adjustment' }),
  line('Test Both Studio'),
  line('Test Both Studio', { status: 'accepted', property: P(4) }),
  line('Test Quiet House', { status: 'rejected' }),
  line('Test Old Title'),
  line('Test Untitled Cottage', { status: 'accepted', property: P(9), cents: 30_000 }),
  line('Test Review Loft', { month: '2026-08' }),
];
const uploads = [upload(['Test Review Loft', 'Test Received Condo', 'Test Both Studio', 'Test Quiet House', 'Test Old Title', 'Test Untitled Cottage']), upload(['Test Missing Suite'], '2026-08')];
const read = income.incomeReadOf({ month: MONTH, uploads, lines, links });
console.log(`  uploaded: ${read.uploaded}; properties with facts: ${Object.keys(read.properties).sort().join(', ')}`);
const expectIncome = {
  [P(1)]: 'review', // two lines waiting, one of a type Nubnb does not read; August's line is not counted
  [P(2)]: 'missing', // its active title, linked in August, is not in September's file
  [P(3)]: 'received', // two accepted lines, an adjustment among them
  [P(4)]: 'review', // one accepted, one waiting: waiting comes first
  [P(5)]: 'no-title', // nothing at all
  [P(6)]: 'no-income', // its title is in the file and its one line was rejected
  [P(7)]: 'no-income', // its title became active in September: not "not in file" (Kian's ruling of 2026-10-13)
  [P(8)]: 'review', // a line under its previous title waits for review
  [P(9)]: 'received', // accepted for it under a title that is not its active one
};
for (const [id, key] of Object.entries(expectIncome)) {
  const s = income.incomeStanding(read, id);
  console.log(`  ${id}: ${show(s)}`);
  check(s.key === key, `${id} is ${key}`);
}
check(read.properties[P(1)].review === 2 && read.properties[P(1)].undecided === 1, 'P1: 2 to review, 1 needing a decision');
check(read.properties[P(3)].accepted === 2 && read.properties[P(3)].acceptedCents === 40_000, 'P3: the adjustment is taken off what was received');

// The Income page's own view says the same
const view = monthModule.monthView({ uploads: uploads.filter((u) => u.month === MONTH), lines: lines.filter((l) => l.month === MONTH), links, lastSeen: {}, properties: [], statements: [], calendar: { checkIns: [] }, month: MONTH });
check(JSON.stringify(view.review.map((g) => [g.propertyId, g.lines.length]).sort()) === JSON.stringify(Object.entries(read.properties).filter(([, f]) => f.review > 0).map(([id, f]) => [id, f.review]).sort()), 'To review per property matches the Income page');
check(JSON.stringify(view.gaps.missing.map((g) => g.link.propertyId).sort()) === JSON.stringify(Object.entries(read.properties).filter(([, f]) => f.missing).map(([id]) => id).sort()), 'Not in file per property matches the Income page');

console.log('  no file uploaded for the month yet:');
const early = income.incomeReadOf({ month: MONTH, uploads: [], lines: [], links });
for (const id of [P(3), P(5)]) console.log(`    ${id}: ${show(income.incomeStanding(early, id))}`);
check(income.incomeStanding(early, P(3)).key === 'no-file', 'a titled property reads "No file yet"');
check(income.incomeStanding(early, P(5)).key === 'no-title', 'a property with no title still reads "No Airbnb title"');
check(income.incomeStanding(early, P(2)).key === 'no-file', 'with no file, nothing is "Not in file"');

// ═══ 2. Cleaning ═══
console.log('\n═══ 2. Cleaning: the most pressing job, 14 days back to 2 ahead (today 2026-10-15) ═══');
const TODAY = '2026-10-15';
const c = (name, { marked = false, removed = false, pending = false } = {}) => ({ name, marked, removed, pending });
const job = (propertyId, checkout, cleaners = [], extra = {}) => ({ propertyId, checkout, status: 'open', changedAfterMark: false, change: null, cleaners, ...extra });
const ANA = 'Test Ana';
const BEN = 'Test Ben';
const cases = [
  ['needs-past', [job(P(1), '2026-10-13'), job(P(1), '2026-10-16')], true],
  ['not-marked', [job(P(2), '2026-10-14', [c(ANA)]), job(P(2), '2026-10-16')], true],
  ['needs', [job(P(3), '2026-10-16'), job(P(3), '2026-10-10', [c(ANA, { marked: true })])], true],
  ['removed', [job(P(4), '2026-10-12', [c(ANA, { marked: true, removed: true })])], true],
  ['changed', [job(P(5), '2026-10-11', [c(ANA, { marked: true })], { status: 'booking-changed', changedAfterMark: true, change: 'Cancelled' })], true],
  ['amount', [job(P(6), '2026-10-12', [c(ANA, { marked: true, pending: true })])], true],
  ['assigned', [job(P(7), '2026-10-15', [c(ANA)]), job(P(7), '2026-10-17', [c(BEN)])], true],
  ['assigned', [job(P(8), '2026-10-16', [c(ANA, { marked: true }), c(BEN)])], true],
  ['done', [job(P(9), '2026-10-05', [c(ANA, { marked: true })]), job(P(9), '2026-10-12', [c(BEN, { marked: true })])], true],
  ['no-turnover', [job(P(10), '2026-09-30'), job(P(10), '2026-10-12', [], { status: 'booking-changed', change: 'Cancelled' })], true],
  ['no-calendar', [], false],
];
for (const [key, jobs, hasCalendar] of cases) {
  const s = cleaning.cleaningStanding(jobs, { today: TODAY, hasCalendar });
  console.log(`  ${jobs[0]?.propertyId ?? P(11)}: ${show(s)}`);
  check(s.key === key, `${key}`);
}
check(cleaning.cleaningStanding(cases[1][1], { today: TODAY, hasCalendar: true }).title.includes('+1 more needs something'), 'Not marked names the other job needing a cleaner');
check(cleaning.cleaningStanding([job(P(7), '2026-10-15', [c(ANA)])], { today: TODAY, hasCalendar: true }).key === 'assigned', 'on its checkout day an unmarked job is Assigned, not red');
check(cleaning.cleaningStanding([job(P(7), '2026-10-15', [c(ANA)])], { today: '2026-10-16', hasCalendar: true }).key === 'not-marked', 'the day after, it is Not marked');
check(cleaning.cleaningStanding([job(P(9), '2026-10-05', [c(ANA, { marked: true })]), job(P(9), '2026-10-12', [c(BEN, { marked: true })])], { today: TODAY, hasCalendar: true }).day === '2026-10-12', 'Done shows the latest job');
check(cleaning.cleaningStanding([job(P(1), '2026-10-12'), job(P(1), '2026-10-13')], { today: TODAY, hasCalendar: true }).day === '2026-10-12', 'a problem shows the longest waiting');

// ═══ 3. A stored job, made small ═══
console.log('\n═══ 3. A stored job as the column reads it ═══');
const assignment = (name, cleaningId, removedAt = null) => ({ nameAtAssignment: name, assignedAt: '2026-10-13T12:00:00.000Z', assignedBy: ADMIN, cleaningId, markedAt: cleaningId ? '2026-10-14T18:00:00.000Z' : null, removedAt, removedBy: removedAt ? ADMIN : null });
const stored = {
  id: `${P(1)}_2026-10-14`, schemaVersion: 1, propertyId: P(1), propertyNameAtCreation: 'Test Loft', checkout: '2026-10-14', reservation: { uid: 'test@airbnb.com', start: '2026-10-10' }, calendarKey: 'abcdef0123', nextCheckIn: null,
  status: 'open', change: null, cleanerIds: ['TESTCLEANERa', 'TESTCLEANERb', 'TESTCLEANERc'],
  assignments: { TESTCLEANERa: assignment(ANA, 'TESTCLEANING1'), TESTCLEANERb: assignment(BEN, 'TESTCLEANING2', '2026-10-14T20:00:00.000Z'), TESTCLEANERc: assignment(null, null) },
  createdAt: '2026-10-12T12:00:00.000Z', history: [],
};
const small = cleaning.homeJobOf(stored, new Map([['TESTCLEANING1', { status: 'logged', amountCents: null }], ['TESTCLEANING2', { status: 'removed', amountCents: 9_000 }]]));
console.log(`  ${JSON.stringify(small)}`);
check(small.cleaners[0].pending && small.cleaners[0].marked, 'a logged cleaning with no amount is pending');
check(small.cleaners[1].removed && small.cleaners[1].marked && !small.cleaners[1].pending, 'a mark the office removed stays a mark, removed, never pending');
check(!small.cleaners[2].marked && small.cleaners[2].name === null, 'a deleted cleaner who never marked reads with no name');
console.log(`  -> ${show(cleaning.cleaningStanding([small], { today: TODAY, hasCalendar: true }))}`);

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`);
if (failures) process.exitCode = 1;
