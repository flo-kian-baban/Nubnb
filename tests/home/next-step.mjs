// The admin home's property list (Kian's rulings of 2026-10-17, admin home): each row's Next step, the chips it is
// under, the Needs attention and Next checkout orders, and the Statements due and Turnovers tiles, decided by
// app/lib/home/next-step.ts on made-up records shaped as the page holds them; and the calendar copy's facts the
// list reads (calendarFactsOf). Made-up data only: properties "TESTPROP…", cleaners "Test …". Nothing is read from or
// written to production.
//   node --import ./tests/tools/ts-hook.mjs tests/home/next-step.mjs
import { fileURLToPath } from 'node:url';

const ROOT = process.env.NUBNB_ROOT || fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const home = await import(`${ROOT}/app/lib/home/next-step.ts`);
const status = await import(`${ROOT}/app/lib/firebase/server-property-status.ts`);

let failures = 0;
const check = (ok, label) => {
  if (!ok) failures += 1;
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${label}`);
};
const P = (n) => `TESTPROP${String(n).padStart(4, '0')}`;
const TODAY = '2026-10-17';
const DUE = '2026-09';

// The statements' standing, as reportingStatus answers it.
const finished = { tone: 'done', standing: 'finished', month: DUE, pastDue: [], previous: { month: DUE, standing: 'finished' } };
const due = { tone: 'warning', standing: 'due', month: DUE, pastDue: [], previous: { month: DUE, standing: 'due' } };
const pastDue = { tone: 'problem', standing: 'pastDue', month: '2026-08', pastDue: ['2026-08'], previous: { month: DUE, standing: 'due' } };
const excluded = { tone: 'none', standing: 'excluded', month: DUE, pastDue: [], previous: { month: DUE, standing: 'excluded' } };
const c = (name) => ({ name, marked: false, removed: false, pending: false });
const job = (propertyId, checkout, cleaners = [], extra = {}) => ({ propertyId, checkout, status: 'open', changedAfterMark: false, change: null, cleaners, ...extra });
const overdue = { state: 'overdue', month: '2026-10', dueDate: '2026-10-05', expectedCents: 300_000, receivedCents: 0, wording: 'Monthly stay', overdueMonths: 1 };

const facts = (n, over = {}) => ({ propertyId: P(n), today: TODAY, status: finished, hasReportFor: true, incomeMonth: DUE, review: 0, direct: null, jobs: [], hasCalendarLink: true, calendarRead: true, ...over });
const show = (v) => `${v.step.key} · "${v.step.label}" · ${v.step.href ?? '-'} · when ${v.step.when ?? '-'} · owed ${v.owed.join(',') || '-'} (${v.blocked} blocked, ${v.ready} ready) · under ${Object.entries(v.under).filter(([, on]) => on).map(([k]) => k).join(',') || '-'} · ${v.step.title}`;

// ═══ 1. One step per row, most pressing first ═══
console.log('═══ 1. The Next step, one per row (today 2026-10-17, month due September 2026) ═══');
const rows = [
  ['assign', facts(1, { jobs: [job(P(1), '2026-10-18'), job(P(1), '2026-10-19')], status: pastDue, hasReportFor: false, review: 2, direct: overdue, calendarRead: false })],
  ['assign', facts(2, { jobs: [job(P(2), '2026-10-05')] })],
  ['report-for', facts(3, { status: pastDue, hasReportFor: false, review: 3 })],
  ['review', facts(4, { status: due, review: 1, direct: overdue })],
  ['direct', facts(5, { status: due, direct: overdue })],
  ['finish', facts(6, { status: pastDue, calendarRead: false })],
  ['finish', facts(7, { status: due })],
  ['calendar', facts(8, { hasCalendarLink: false, calendarRead: false })],
  ['calendar', facts(9, { calendarRead: false })],
  ['none', facts(10)],
  ['none', facts(11, { status: excluded, hasReportFor: false })],
  ['none', facts(12, { jobs: [job(P(12), '2026-10-18', [c('Test Ana')]), job(P(12), '2026-10-18', [], { status: 'booking-changed', change: 'Cancelled' }), job(P(12), '2026-09-30'), job(P(12), '2026-10-20')] })],
];
const views = new Map();
for (const [key, f] of rows) {
  const v = home.rowView(f);
  views.set(f.propertyId, v);
  console.log(`  ${f.propertyId}: ${show(v)}`);
  check(v.step.key === key, key);
}
check(views.get(P(1)).step.label === 'Assign a cleaner for Oct 18' && views.get(P(1)).step.title.includes('1 other job too'), 'a turnover outranks everything, the earliest named, the others counted');
check(views.get(P(2)).step.href.endsWith('&from=2026-10-05'), 'a checkout older than a week opens the Schedule from its day');
check(views.get(P(3)).step.href === `/admin/property?id=${P(3)}&month=2026-08&tab=details`, 'Add Report For name opens the oldest month owed at its Details');
check(views.get(P(3)).blocked === 2 && views.get(P(3)).ready === 0, 'with no Report For name, every statement owed is blocked: the month past due and the month due');
check(views.get(P(4)).step.label === 'Review 1 Airbnb line' && views.get(P(4)).step.href === `/admin/income?month=2026-09&property=${P(4)}`, 'one line reads "1 Airbnb line", and opens the Income page at the month, at the property (Kian\'s rulings of 2026-10-17)');
check(views.get(P(6)).step.label === 'Finish August' && views.get(P(6)).step.href.endsWith('&month=2026-08&tab=finish'), 'Finish names the oldest month owed and opens its Finish tab');
check(views.get(P(6)).ready === 2, 'past due and due both count as ready');
check(views.get(P(8)).step.title.startsWith('No calendar link') && views.get(P(9)).step.title.startsWith('The last refresh'), 'Calendar not read says which: no link, or not read');
check(views.get(P(11)).blocked === 0 && !views.get(P(11)).under.attention, 'a property excluded from reporting owes nothing, even with no Report For name');
check(!views.get(P(12)).under.cleaner, 'assigned, booking-changed, out of the window: no cleaner needed');
check(home.rowView(facts(13, { status: { ...due, previous: { month: '2025-12', standing: 'due' } }, today: '2026-01-05' })).step.label === 'Finish December 2025', 'a month in another year carries its year');

// ═══ 2. The chips ═══
console.log('\n═══ 2. The chips: the rows under each ═══');
for (const { key, label } of home.CHIPS) {
  const under = [...views].filter(([, v]) => v.under[key]).map(([id]) => id.slice(-2));
  console.log(`  ${label.padEnd(24)} ${String(under.length).padStart(2)}  ${under.join(' ')}`);
}
check([...views.values()].every((v) => v.under.attention === (v.step.key !== 'none')), 'Needs attention is every row whose Next step is not Up to date');
check(views.get(P(1)).under.blocked && views.get(P(1)).under.review && views.get(P(1)).under.direct && views.get(P(1)).under.calendar, 'a row is under every chip it qualifies for, whatever its one step');

// ═══ 3. The orders ═══
console.log('\n═══ 3. Needs attention, then Next checkout ═══');
const ranked = [...views].map(([id, v]) => ({ id, step: v.step, worst: id === P(12) ? 2 : 0, name: `Test ${id.slice(-2)}` }));
const order = [...ranked].sort(home.byAttention).map((r) => r.id.slice(-2));
console.log(`  Needs attention: ${order.join(' ')}`);
check(order.join(' ') === '02 01 03 04 05 06 07 08 09 12 10 11', 'by step; then the earliest day or month (Oct 5 before Oct 18, August before September); then the worst cell (12 has a red cell); then the name');
const checkouts = [
  { nextCheckout: '2026-10-20', name: 'Test B' },
  { nextCheckout: null, name: 'Test A' },
  { nextCheckout: '2026-10-18', name: 'Test C' },
  { nextCheckout: '2026-10-18', name: 'Test A2' },
];
const byCheckout = [...checkouts].sort(home.byNextCheckout).map((r) => `${r.name}@${r.nextCheckout ?? '-'}`);
console.log(`  Next checkout: ${byCheckout.join(' ')}`);
check(byCheckout.join(' ') === 'Test A2@2026-10-18 Test C@2026-10-18 Test B@2026-10-20 Test A@-', 'the soonest first, ties by name, none last');

// ═══ 4. The tiles ═══
console.log('\n═══ 4. Statements due and Turnovers ═══');
const figures = home.statementFigures(rows.map(([, f]) => ({ status: f.status, hasReportFor: f.hasReportFor })));
console.log(`  Statements due ${figures.due}: ${figures.blocked} blocked · ${figures.ready} ready · ${figures.finished} finished`);
check(figures.blocked === [...views.values()].reduce((s, v) => s + v.blocked, 0) && figures.ready === [...views.values()].reduce((s, v) => s + v.ready, 0), 'the tile counts what the rows count');
check(figures.due === figures.blocked + figures.ready && figures.finished === 5, 'due is blocked and ready; finished is the month due\'s');
const jobs = [job(P(1), '2026-10-17'), job(P(1), '2026-10-18', [c('Test Ana')]), job(P(2), '2026-10-18'), job(P(3), '2026-10-19'), job(P(4), '2026-10-16'), job(P(5), '2026-10-17', [], { status: 'booking-changed', change: 'Cancelled' })];
const t = home.turnoverFigures(jobs, TODAY);
console.log(`  Turnovers ${t.from} to ${t.to}: ${t.count}, ${t.needCleaner} need a cleaner`);
check(t.count === 3 && t.needCleaner === 2, 'open jobs today and tomorrow only; the day after, yesterday and a changed booking left out');

// ═══ 5. The calendar copy's facts ═══
console.log('\n═══ 5. What the list reads of the calendar copy ═══');
const ev = (kind, start, end) => ({ uid: `${start}@test`, kind, start, end });
const snapshot = {
  version: 1, refreshedAt: '2026-10-17T12:00:00.000Z', today: TODAY, horizonEnd: '2027-10-17', run: { source: 'daily', startedAt: '', finishedAt: '', durationMs: 0, fetched: 2, failed: [], pagesChecked: 0 },
  properties: {
    [P(1)]: { name: 'Test 1', icalUrl: 'x', status: 'ok', fetchedAt: null, bytes: 0, eventCount: 3, events: [ev('reserved', '2026-10-10', '2026-10-16'), ev('blocked', '2026-10-17', '2026-10-18'), ev('reserved', '2026-10-20', '2026-10-24'), ev('reserved', '2026-10-17', '2026-10-19')] },
    [P(2)]: { name: 'Test 2', icalUrl: 'x', status: 'failed', fetchedAt: null, bytes: 0, eventCount: 1, events: [ev('reserved', '2026-10-12', '2026-10-17')] },
    [P(3)]: { name: 'Test 3', icalUrl: '', status: 'no-feed', fetchedAt: null, bytes: 0, eventCount: 0, events: [] },
  },
};
const read = status.calendarFactsOf(snapshot, TODAY);
for (const [id, f] of Object.entries(read.properties)) console.log(`  ${id}: ${f.status} · next checkout ${f.nextCheckout ?? '-'}`);
check(read.properties[P(1)].nextCheckout === '2026-10-19', 'the soonest reservation ending today or later; a block is not a checkout');
check(read.properties[P(2)].status === 'failed' && read.properties[P(2)].nextCheckout === '2026-10-17', 'a calendar not read keeps its last good read; a checkout today counts');
check(home.CHIPS.length === 7 && status.calendarFactsOf(null, TODAY).refreshedAt === null, 'no copy: nothing known');

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`);
if (failures) process.exitCode = 1;
