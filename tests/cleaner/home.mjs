// The cleaner app's home and History (Kian's rulings of 2026-10-16): which jobs the home screen shows (today's and
// tomorrow's, and any past job still to mark), the property a new receipt starts on (the job marked cleaned that day,
// else the soonest job today, else none), and History's order (jobs done and entries sent, newest first). Made-up data
// only: jobs "TESTJOB…", properties "TESTPROP…" named "Test …". Nothing is read from or written to production.
//   node --import ./tests/tools/ts-hook.mjs tests/cleaner/home.mjs
import { fileURLToPath } from 'node:url';

const ROOT = process.env.NUBNB_ROOT || fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const home = await import(`${ROOT}/app/lib/cleaner-home.ts`);

let failures = 0;
const check = (ok, label) => {
  if (!ok) failures += 1;
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${label}`);
};

const TODAY = '2026-10-16';

/** A job as the start call sends it, with what a test names. */
const job = (id, checkout, extra = {}) => ({
  id,
  propertyId: `TESTPROP${id.slice(-2)}`,
  propertyName: `Test ${id.slice(-2)} St`,
  city: 'Toronto',
  checkout,
  checkOutTime: '11:00 AM',
  checkInTime: '4:00 PM',
  nextCheckIn: null,
  status: 'open',
  markedAt: null,
  canUndo: false,
  markRefusal: checkout > TODAY ? 'too-early' : null,
  ...extra,
});
const marked = (at, extra = {}) => ({ markedAt: at, canUndo: true, markRefusal: 'already-marked', ...extra });
const ids = (jobs) => jobs.map((j) => j.id).join(', ') || '(none)';

// ═══ 1. Times and days ═══
console.log('═══ 1. minutesOf and torontoDayOf ═══');
for (const [time, want] of [
  ['11:00 AM', 660],
  ['10:00 AM', 600],
  ['12:00 PM', 720],
  ['12:30 AM', 30],
  ['4 PM', 960],
  ['4:00 p.m.', 960],
  ['16:30', 990],
  ['11', null],
  ['13:00 PM', null],
  ['', null],
  [null, null],
]) {
  const got = home.minutesOf(time);
  console.log(`    ${JSON.stringify(time)} → ${got}`);
  check(got === want, `${JSON.stringify(time)} is ${want}`);
}
for (const [iso, want] of [
  ['2026-10-17T03:59:59.000Z', '2026-10-16'],
  ['2026-10-17T04:00:00.000Z', '2026-10-17'],
  ['2026-10-16T12:00:00.000Z', '2026-10-16'],
  ['not a date', null],
  [null, null],
]) {
  const got = home.torontoDayOf(iso);
  console.log(`    ${JSON.stringify(iso)} → ${JSON.stringify(got)}`);
  check(got === want, `${JSON.stringify(iso)} is Toronto's ${want}`);
}

// ═══ 2. The home screen's jobs ═══
console.log("\n═══ 2. homeJobs: today's and tomorrow's, and before them any past job still to mark or marked today ═══");
const jobs = [
  job('TESTJOB01', '2026-10-14'), // past, still to mark: on home
  job('TESTJOB02', '2026-10-14', marked('2026-10-14T16:00:00.000Z')), // past, marked that day: History only
  job('TESTJOB12', '2026-10-15', marked('2026-10-16T13:00:00.000Z')), // past, marked today: on home for the day
  job('TESTJOB03', '2026-10-15', { status: 'booking-changed', markRefusal: 'booking-changed' }), // past, booking changed: not markable, not on home
  job('TESTJOB11', '2026-10-15', { status: 'booking-changed' }), // the same, were its refusal ever missing: still not on home
  job('TESTJOB04', '2026-10-15', marked('2026-10-15T16:00:00.000Z', { canUndo: false, markRefusal: 'removed' })), // past, removed: History only
  job('TESTJOB05', TODAY), // today 11:00 AM
  job('TESTJOB06', TODAY, { checkOutTime: '10:00 AM' }), // today 10:00 AM: before 05
  job('TESTJOB07', TODAY, marked('2026-10-16T17:00:00.000Z')), // today, cleaned: on home
  job('TESTJOB08', TODAY, { status: 'booking-changed', markRefusal: 'booking-changed' }), // today, changed: on home, says so
  job('TESTJOB09', '2026-10-17'), // tomorrow: on home, opens tomorrow
  job('TESTJOB10', '2026-10-18'), // the day after: not yet
];
const shown = home.homeJobs(jobs, TODAY);
console.log(`    shown: ${ids(shown)}`);
check(ids(shown) === 'TESTJOB01, TESTJOB12, TESTJOB06, TESTJOB05, TESTJOB07, TESTJOB08, TESTJOB09', 'the past jobs still to mark or marked today first, then today by checkout time, then tomorrow');
check(!shown.some((j) => j.checkout === '2026-10-18'), 'nothing after tomorrow');
check(!shown.some((j) => j.checkout < TODAY && j.markedAt !== null && home.torontoDayOf(j.markedAt) !== TODAY), 'no job marked on an earlier day');
check(home.homeJobs([], TODAY).length === 0, 'no jobs: none shown');

// ═══ 3. The property a receipt starts on ═══
console.log('\n═══ 3. receiptProperty: the job marked cleaned that day, else the soonest job today, else none ═══');
const cases = [
  ['two marked today: the latest mark', [job('TESTJOB21', TODAY, marked('2026-10-16T14:00:00.000Z')), job('TESTJOB22', TODAY, marked('2026-10-16T18:30:00.000Z')), job('TESTJOB23', TODAY, { checkOutTime: '9:00 AM' })], 'TESTPROP22'],
  ['marked late in the evening, Toronto (03:30Z the next day UTC), counts as today', [job('TESTJOB24', TODAY, marked('2026-10-17T03:30:00.000Z')), job('TESTJOB25', TODAY)], 'TESTPROP24'],
  ['a past job marked today counts', [job('TESTJOB26', '2026-10-15', marked('2026-10-16T13:00:00.000Z')), job('TESTJOB27', TODAY)], 'TESTPROP26'],
  ['marked yesterday does not count: the soonest today', [job('TESTJOB28', '2026-10-15', marked('2026-10-15T20:00:00.000Z')), job('TESTJOB29', TODAY), job('TESTJOB30', TODAY, { checkOutTime: '10:00 AM' })], 'TESTPROP30'],
  ['a mark the office removed does not count', [job('TESTJOB31', TODAY, marked('2026-10-16T15:00:00.000Z', { canUndo: false, markRefusal: 'removed' })), job('TESTJOB32', TODAY)], 'TESTPROP32'],
  ['a changed booking today is not the soonest', [job('TESTJOB33', TODAY, { checkOutTime: '8:00 AM', status: 'booking-changed', markRefusal: 'booking-changed' }), job('TESTJOB34', TODAY)], 'TESTPROP34'],
  ['a job with no checkout time comes after one with a time', [job('TESTJOB35', TODAY, { checkOutTime: null }), job('TESTJOB36', TODAY, { checkOutTime: '11:30 AM' })], 'TESTPROP36'],
  ["only tomorrow's job: none", [job('TESTJOB37', '2026-10-17')], null],
  ['only a past job still to mark: none', [job('TESTJOB38', '2026-10-14')], null],
  ['no jobs: none', [], null],
];
for (const [label, list, want] of cases) {
  const got = home.receiptProperty(list, TODAY);
  console.log(`    ${label} → ${got ? `${got.id} "${got.name}"` : 'none'}`);
  check((got?.id ?? null) === want, label);
}

// ═══ 4. History ═══
console.log('\n═══ 4. historyItems: jobs done and entries sent, newest first ═══');
const entry = (id, createdAt, extra = {}) => ({
  id,
  createdAt,
  propertyId: 'TESTPROP99',
  propertyNameAtEntry: 'Test 99 St',
  lineCount: 2,
  totalCents: 4567,
  sentTotalCents: 4567,
  taxCents: 525,
  taxShape: 'field',
  corrected: false,
  status: 'approved',
  statusReason: null,
  kind: 'receipt',
  description: null,
  ...extra,
});
const items = home.historyItems(
  [
    job('TESTJOB41', '2026-10-14', marked('2026-10-14T16:00:00.000Z')),
    job('TESTJOB42', TODAY, marked('2026-10-16T17:00:00.000Z')),
    job('TESTJOB43', TODAY), // not marked: not in History
    job('TESTJOB44', '2026-10-15', marked('2026-10-16T13:00:00.000Z')), // marked the day after: on its checkout day, above what was sent earlier that day
  ],
  [
    entry('TESTENTRY1', '2026-10-16T18:00:00.000Z'),
    entry('TESTENTRY2', '2026-10-15T15:00:00.000Z', { status: 'rejected', statusReason: 'Not for this unit' }),
    entry('TESTENTRY3', '2026-10-17T03:00:00.000Z'), // 23:00 Toronto, 16 Oct
    entry('TESTENTRY4', null),
  ],
);
const line = (item) => `${item.kind === 'job' ? item.job.id : item.entry.id}@${item.day}`;
console.log(`    ${items.map(line).join(', ')}`);
check(
  items.map(line).join(', ') === 'TESTENTRY3@2026-10-16, TESTENTRY1@2026-10-16, TESTJOB42@2026-10-16, TESTJOB44@2026-10-15, TESTENTRY2@2026-10-15, TESTJOB41@2026-10-14, TESTENTRY4@null',
  'by day, newest first; within a day the latest first; an undated entry last',
);
check(!items.some((item) => item.kind === 'job' && item.job.markedAt === null), 'a job not marked is not in History');
check(items.filter((item) => item.kind === 'entry').length === 4, 'every entry is listed');

// ═══ 5. The badges on a job's card (2026-10-17) ═══
console.log("\n═══ 5. jobBadges: Today, Tomorrow, Same-day turnover, Cleaned ═══");
for (const [label, j, want] of [
  ['today, next guest the same day, not marked', job('TESTJOB51', TODAY, { nextCheckIn: TODAY }), 'Today, Same-day turnover'],
  ['today, next guest tomorrow, cleaned', job('TESTJOB52', TODAY, { nextCheckIn: '2026-10-17', ...marked('2026-10-16T15:00:00.000Z') }), 'Today, Cleaned'],
  ['tomorrow, no next guest', job('TESTJOB53', '2026-10-17'), 'Tomorrow'],
  ['tomorrow, next guest the same day', job('TESTJOB54', '2026-10-17', { nextCheckIn: '2026-10-17' }), 'Tomorrow, Same-day turnover'],
  ['a past day, cleaned, next guest the same day', job('TESTJOB55', '2026-10-14', { nextCheckIn: '2026-10-14', ...marked('2026-10-16T13:00:00.000Z') }), 'Same-day turnover, Cleaned'],
  ['today, its mark removed by the office', job('TESTJOB56', TODAY, marked('2026-10-16T13:00:00.000Z', { canUndo: false, markRefusal: 'removed' })), 'Today'],
  ['a past day, still to mark', job('TESTJOB57', '2026-10-14'), ''],
]) {
  const got = home.jobBadges(j, TODAY).join(', ');
  console.log(`    ${label} → ${got || '(none)'}`);
  check(got === want, label);
}

console.log(`\n${failures === 0 ? 'every check passed' : `${failures} check(s) FAILED`}`);
if (failures > 0) process.exitCode = 1;
