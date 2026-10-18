// Kian's rulings of 2026-10-17 on the Income page audit, through Nubnb's own pure code: K1 (a month's routine lines in
// one confirmation; the lines held back for a decision of their own, each with why), K2 (a property with Airbnb stays
// is linked to a title or marked "not paid through Nubnb's files"; the rest listed apart; Finish warns on them), the
// check-ins that are gaps only once the month has a file and only up to today, the statement's standing from the one
// function, the hand-off counts, the missing-and-new pair, and what the two new routes accept, with the exact bodies
// the page sends. Made-up data only: properties "TESTPROP…", booking codes HMTEST…. Nothing is read from or written to
// production.
//   node --import ./tests/tools/ts-hook.mjs tests/money/income-one-pass.mjs
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.NUBNB_ROOT || fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const st = await import(`${ROOT}/app/lib/reports/statement.ts`);
const { finishChecks } = await import(`${ROOT}/app/lib/reports/checks.ts`);
const { formatCents: $, ADMIN_ACTOR } = await import(`${ROOT}/app/lib/cleaners/model.ts`);
const inc = await import(`${ROOT}/app/lib/income/model.ts`);
const mv = await import(`${ROOT}/app/lib/income/month.ts`);
const sc = await import(`${ROOT}/app/lib/income/schemas.ts`);

let failures = 0;
const check = (ok, label) => {
  if (!ok) failures += 1;
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${label}`);
};
const P = (n) => `TESTPROP${String(n).padStart(4, '0')}`;
const sha = (text) => createHash('sha256').update(text).digest('hex');
let seq = 0;
const AT = '2026-10-02T15:00:00.000Z';

/** A stored line, read back strictly as the page reads it. */
const stored = ({ title, code, start, end, payout, cents, type = 'Reservation', month = '2026-09' }) => {
  const line = {
    id: sha(`income-one-pass|${++seq}`),
    schemaVersion: 1,
    platform: 'airbnb',
    uploadId: 'TESTUPLOAD',
    fileRow: seq + 1,
    payoutDate: payout,
    month,
    type,
    confirmationCode: code,
    listingTitle: title,
    stay: { start, end, nights: null },
    amountCents: cents,
    currency: 'CAD',
    evidence: { grossCents: null, serviceFeeCents: null, cleaningFeeCents: null },
    remittedTaxCents: null,
    status: 'proposed',
    decided: null,
    history: [],
  };
  const again = inc.readEarningsLine(line.id, line);
  if (!again) throw new Error('not in shape');
  return again;
};
const acceptAs = (line, propertyId) => {
  const decided = { status: 'accepted', at: AT, actor: ADMIN_ACTOR, propertyId, description: inc.proposedLabel(line), amountCents: line.amountCents, edited: false };
  return inc.readEarningsLine(line.id, { ...line, status: 'accepted', decided, history: [{ at: AT, actor: ADMIN_ACTOR, action: 'accepted', propertyId }] });
};
const linkOf = (title, propertyId, extra = {}) => ({ id: `TESTLINK${++seq}`, schemaVersion: 1, platform: 'airbnb', title, propertyId, linkedAt: '2026-08-01T12:00:00.000Z', actor: ADMIN_ACTOR, history: [], ...extra });
const row = (title, code, start, end, payout, cents, type) => stored({ title, code, start, end, payout, cents, type });

// ═══ 1. A line's own reasons (K1) ═══
console.log("═══ 1. A line's own reasons to be held (K1): a negative amount, a stay begun more than a month before, an unknown type ═══");
const holds = (line) => mv.lineHolds(line).map((r) => r.key).join(',') || '—';
const cases = [
  ['a reservation in September', row('__TEST__ Alpha', 'HMTEST01', '2026-09-03', '2026-09-06', '2026-09-04', 50000)],
  ['a claw-back', row('__TEST__ Alpha', 'HMTEST02', '2026-09-03', '2026-09-06', '2026-09-10', -12000, 'Adjustment')],
  ['a stay begun 1 August (a month before September, not more)', row('__TEST__ Alpha', 'HMTEST03', '2026-08-01', '2026-09-30', '2026-09-02', 40000)],
  ['a stay begun 31 July (more than a month before)', row('__TEST__ Alpha', 'HMTEST04', '2026-07-31', '2026-09-30', '2026-09-02', 40000)],
  ['an unknown row type', row('__TEST__ Alpha', 'HMTEST05', '2026-09-03', '2026-09-06', '2026-09-11', 3000, 'Host Fee Refund')],
  ['a negative old stay of an unknown type', row('__TEST__ Alpha', 'HMTEST06', '2026-06-01', '2026-09-21', '2026-09-07', -41100, 'Mystery Fee')],
];
for (const [label, line] of cases) console.log(`  ${label.padEnd(60)} ${holds(line)}`);
check(holds(cases[0][1]) === '—', 'a September reservation is routine');
check(holds(cases[2][1]) === '—' && holds(cases[3][1]) === 'old-stay', 'the boundary: begun on the first of the month before is routine; the day before it is held');
check(holds(cases[5][1]) === 'negative,old-stay,unknown-type', 'every reason is named, in order');
console.log(`  words: ${mv.lineHolds(cases[5][1]).map((r) => r.text).join(' | ')}`);

// ═══ 2. The month: held, routine, the one confirmation ═══
console.log('\n═══ 2. The month (September): what is held and why, what one confirmation accepts ═══');
const T = { A: '__TEST__ Alpha Loft', B: '__TEST__ Bravo Suite', C: '__TEST__ Charlie House', D: '__TEST__ Delta Studio', E: '__TEST__ Echo Flat', F: '__TEST__ Foxtrot Room', G: '__TEST__ Golf Cabin', H: '__TEST__ Hotel Finished' };
const lines = [
  row(T.A, 'HMTESTA1', '2026-09-01', '2026-09-04', '2026-09-02', 30000),
  row(T.A, 'HMTESTA2', '2026-09-10', '2026-09-12', '2026-09-11', 20000),
  row(T.B, 'HMTESTB1', '2026-09-05', '2026-09-08', '2026-09-06', 45000),
  row(T.B, 'HMTESTB2', '2026-09-05', '2026-09-08', '2026-09-20', -5000, 'Resolution Adjustment'),
  row(T.C, 'HMTESTC1', '2026-09-02', '2026-09-03', '2026-09-03', 10000),
  row(T.C, 'HMTESTC2', '2026-09-02', '2026-09-03', '2026-09-15', -30000, 'Adjustment'),
  row(T.D, 'HMTESTD1', '2026-09-12', '2026-09-14', '2026-09-13', 25000),
  row(T.D, 'HMTESTD2', '2026-09-12', '2026-09-14', '2026-09-16', 4000, 'Host Fee Refund'),
  row(T.E, 'HMTESTE1', '2026-09-03', '2026-09-05', '2026-09-04', 33300),
  row(T.F, 'HMTESTF1', '2026-06-01', '2026-10-30', '2026-09-05', 90000),
  row(T.F, 'HMTESTF2', '2026-09-18', '2026-09-20', '2026-09-19', 21000),
  row(T.G, 'HMTESTG1', '2026-09-22', '2026-09-24', '2026-09-23', 15000),
  row(T.H, 'HMTESTH1', '2026-09-25', '2026-09-27', '2026-09-26', 18000),
];
const links = [linkOf(T.A, P(1)), linkOf(T.B, P(2)), linkOf(T.C, P(3)), linkOf(T.D, P(4)), linkOf(T.E, P(5)), linkOf(T.F, P(6)), linkOf(T.G, P(7)), linkOf(T.H, P(8))];
const typedTwin = { id: 'typed-1', description: 'Revenue - Sep 22–24 (typed)', from: '2026-09-22', to: '2026-09-24', quantity: 1, rateCents: 15000, amountCents: 15000 };
const properties = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => ({ id: P(n), name: `Test Public ${n}`, internalName: `${n} Test St` }));
const standing = (s, reportFor) => ({ standing: s, reportFor });
const input = {
  month: '2026-09',
  today: '2026-10-18',
  uploads: [{ platform: 'airbnb', titles: Object.values(T).map((title) => ({ title, rows: 1, amountCents: 0 })) }],
  lines,
  links,
  lastSeen: {},
  properties,
  statements: [
    { propertyId: P(7), finished: false, lines: [typedTwin], sent: null },
    { propertyId: P(8), finished: true, lines: [], sent: null },
  ],
  calendar: {
    checkIns: [
      { propertyId: P(9), days: ['2026-09-05', '2026-09-30'] },
      { propertyId: P(10), days: ['2026-09-12'] },
      { propertyId: P(11), days: ['2026-09-14'] },
      { propertyId: P(1), days: ['2026-09-01'] },
    ],
    stays: [
      { propertyId: P(9), count: 2 },
      { propertyId: P(10), count: 1 },
      { propertyId: P(11), count: 1 },
      { propertyId: P(1), count: 2 },
    ],
  },
  noStatement: [{ propertyId: P(5), why: 'It is excluded from reporting: no statement is asked for.' }],
  notThroughFiles: [P(11)],
  standings: { [P(1)]: standing('due', true), [P(2)]: standing('due', false), [P(3)]: standing('due', false), [P(4)]: standing('due', true), [P(5)]: standing('excluded', false), [P(6)]: standing('pastDue', true), [P(7)]: standing('due', true), [P(8)]: standing('finished', true) },
};
// P(10) has a title of its own that is not in this month's file: titled, so a check-in gap, not untitled.
input.links.push(linkOf('__TEST__ India Old', P(10), { active: false }));
const view = mv.monthView(input);
console.log('  held:');
for (const h of view.held) console.log(`    ${h.name.padEnd(12)} ${inc.proposedLabel(h.line).padEnd(46)} ${$(h.line.amountCents).padStart(10)}  ${h.reasons.map((r) => r.key).join(', ')}`);
console.log(`  one confirmation: ${view.onePass.lines} lines for ${view.onePass.properties} properties · ${$(view.onePass.amountCents)}`);
for (const g of view.onePass.groups) console.log(`    ${g.propertyId}: ${g.ids.length} line(s)`);
console.log('  groups:');
for (const g of view.review) console.log(`    ${g.name.padEnd(12)} titles ${JSON.stringify(g.titles)} · routine ${g.routine.length}/${g.lines.length} · revenue as it would stand ${g.revenueCents === null ? '— (finished)' : $(g.revenueCents)} · holds ${g.holds.map((r) => r.key).join(',') || '—'} · ${g.standing ? mv.standingWords(g.standing) : '—'}`);
const heldKeys = (code) => view.held.find((h) => h.line.confirmationCode === code)?.reasons.map((r) => r.key).join(',') ?? 'not held';
check(heldKeys('HMTESTA1') === 'not held' && heldKeys('HMTESTA2') === 'not held', 'routine lines are not held');
check(heldKeys('HMTESTB2') === 'negative' && heldKeys('HMTESTB1') === 'not held', 'a negative line is held alone; its property\'s other lines stay routine');
check(heldKeys('HMTESTC1') === 'below-zero' && heldKeys('HMTESTC2') === 'negative,below-zero', 'a property whose month would go below zero is held whole');
check(heldKeys('HMTESTD2') === 'unknown-type' && heldKeys('HMTESTD1') === 'not held', 'an unknown row type is held alone');
check(heldKeys('HMTESTE1') === 'no-statement', 'a property that owes no statement is held whole');
check(heldKeys('HMTESTF1') === 'old-stay' && heldKeys('HMTESTF2') === 'not held', 'a stay begun in June is held; its property\'s September stay is routine');
check(heldKeys('HMTESTG1') === 'duplicate', 'a typed line of the same amount and dates on the statement holds the line as a possible duplicate');
check(view.onePass.lines === 6 && view.onePass.properties === 5, 'the one confirmation: the 6 routine lines of 5 properties');
check(view.onePass.amountCents === 30000 + 20000 + 45000 + 25000 + 21000 + 18000, 'its total is the routine lines\' total');
check(view.review.find((g) => g.propertyId === P(8)).revenueCents === null, 'a finished month shows no revenue as it would stand: a line accepted now goes on the next');
check(view.review.find((g) => g.propertyId === P(3)).revenueCents === -20000, 'revenue as it would stand counts a claw-back as less revenue (M1)');

// ═══ 3. Gaps: untitled (K2), check-ins only with a file and up to today, marked properties left out ═══
console.log('\n═══ 3. Gaps (K2; check-ins only once the month has a file, and only up to today) ═══');
console.log(`  untitled: ${JSON.stringify(view.gaps.untitled)}`);
console.log(`  check-ins: ${JSON.stringify(view.gaps.checkIns)}`);
console.log(`  marked: ${JSON.stringify(view.marked)}`);
check(view.gaps.untitled.length === 1 && view.gaps.untitled[0].propertyId === P(9), 'a property with stays and no title of any kind is untitled; one with a previous title is not; a marked one is not');
check(view.gaps.checkIns.length === 1 && view.gaps.checkIns[0].propertyId === P(10), 'check-ins: the untitled property is listed apart, the marked one not at all, one with lines not at all');
const noFile = mv.monthView({ ...input, uploads: [] });
check(noFile.gaps.checkIns.length === 0 && noFile.gaps.untitled.length === 1, 'before the month has a file, no check-in is a gap; the untitled property is still listed');
const october = mv.monthView({ ...input, month: '2026-10', today: '2026-10-18', lines: [], statements: [], standings: {}, calendar: { checkIns: [{ propertyId: P(10), days: ['2026-10-02', '2026-10-18', '2026-10-19', '2026-10-30'] }], stays: [] } });
console.log(`  October on the 18th: ${JSON.stringify(october.gaps.checkIns)}`);
check(october.gaps.checkIns[0].days.join(',') === '2026-10-02,2026-10-18', 'a check-in after today is no gap yet');

// ═══ 4. The hand-off: the month's statements, by the one function's standing ═══
console.log("\n═══ 4. The hand-off: properties with the month's money, ready, blocked, finished ═══");
const accepted = lines.filter((l) => l.status === 'proposed' && [T.A, T.B].includes(l.listingTitle) && l.amountCents > 0).map((l) => acceptAs(l, l.listingTitle === T.A ? P(1) : P(2)));
const settled = mv.monthView({
  ...input,
  lines: accepted,
  statements: [
    { propertyId: P(1), finished: false, lines: st.platformLinesOn({ propertyId: P(1), month: '2026-09', firstMonth: '2026-09', platformLines: inc.platformLinesOf(accepted.filter((l) => l.decided.propertyId === P(1))), current: [] }).map((r) => r.line), sent: null },
    { propertyId: P(2), finished: false, lines: st.platformLinesOn({ propertyId: P(2), month: '2026-09', firstMonth: '2026-09', platformLines: inc.platformLinesOf(accepted.filter((l) => l.decided.propertyId === P(2))), current: [] }).map((r) => r.line), sent: null },
    { propertyId: P(8), finished: true, lines: [typedTwin], sent: null },
  ],
});
console.log(`  ${JSON.stringify(settled.statements)}`);
for (const r of settled.byProperty) console.log(`    ${r.name.padEnd(12)} ${$(r.revenueCents).padStart(9)} · ${r.standing ? mv.standingWords(r.standing) : '—'}`);
check(settled.statements.properties === 3 && settled.statements.ready === 1 && settled.statements.blocked === 1 && settled.statements.finished === 1, 'one ready (Report For name), one blocked (none), one finished');
check(mv.standingWords(standing('due', false)) === 'Due · blocked' && mv.standingWords(standing('pastDue', true)) === 'Past due' && mv.standingWords(standing('open', false)) === 'Open, not yet due', 'the standing\'s words are STANDING_LABELS\', blocked only when owed now with no Report For name');
const derived = st.monthStanding({ month: '2026-09', today: '2026-10-18', owed: true, finished: false });
check(derived === 'due', 'the server\'s standing is monthStanding\'s: September, owed and unfinished, on 18 October, is due');

// ═══ 5. One active title missing and one new: the pair, offered ═══
console.log('\n═══ 5. One missing, one new: offered as a pair, never applied ═══');
const pairInput = {
  month: '2026-08',
  uploads: [{ platform: 'airbnb', titles: [{ title: '__TEST__ Hotel New', rows: 1, amountCents: 20000 }] }],
  lines: [stored({ title: '__TEST__ Hotel New', code: 'HMTESTH9', start: '2026-08-02', end: '2026-08-04', payout: '2026-08-03', cents: 20000, month: '2026-08' })],
  links: [linkOf('__TEST__ Hotel Old', P(8), { active: true, linkedAt: '2026-07-15T12:00:00.000Z' })],
  lastSeen: {},
  properties,
  statements: [],
  calendar: { checkIns: [] },
};
const paired = mv.monthView(pairInput).pair;
console.log(`  ${JSON.stringify(paired)}`);
check(paired !== null && paired.propertyId === P(8) && paired.fromTitle === '__TEST__ Hotel Old' && paired.title === '__TEST__ Hotel New', 'exactly one missing and one new: offered');
const twoNew = mv.monthView({ ...pairInput, lines: [...pairInput.lines, stored({ title: '__TEST__ Hotel Other', code: 'HMTESTH8', start: '2026-08-05', end: '2026-08-06', payout: '2026-08-06', cents: 1_000, month: '2026-08' })] }).pair;
const noneMissing = mv.monthView({ ...pairInput, links: [linkOf('__TEST__ Hotel Old', P(8), { active: true, linkedAt: '2026-08-15T12:00:00.000Z' })] }).pair;
check(twoNew === null, 'two new titles: nothing offered');
check(noneMissing === null, 'a title made active in the month is not missing from it: nothing offered');
const seen = mv.monthView({ ...pairInput, seenBefore: ['airbnb|__TEST__ Hotel New'] }).pair;
check(seen === null, 'a title already in an earlier month\'s file is not new: nothing offered');

// ═══ 6. Finish: K2's warning, said instead of I15; a marked property warned of neither ═══
console.log("\n═══ 6. Finish (K2): no title and no mark warns; a mark silences the stays' warning ═══");
const record = { id: P(9), schemaVersion: 3, propertyId: P(9), reportFor: { name: 'Test Owner', address: '1 Test St' }, owners: [], statementsFrom: '2026-09', statementsUntil: null, defaultFeeRateBasisPoints: null, defaultFee: null, setAt: AT };
const built = st.buildStatement({ propertyId: P(9), propertyName: '9 Test St', month: '2026-09', entries: [], reports: [], draft: { reference: 'Sept-TEST', reportDate: '2026-10-18', lines: [], fee: null, carried: null, notes: null, supersedes: null }, management: record, platformLines: [] });
if (built.kind !== 'ok') throw new Error('statement');
const uncovered = [{ start: '2026-09-05', end: '2026-09-08' }, { start: '2026-09-20', end: '2026-09-22' }];
const warned = (income) => finishChecks({ statement: built.statement, reports: [], entries: [], income: { waiting: 0, unlinked: [], checkouts: 0, uncovered, ...income }, today: '2026-10-18' }).warnings.filter((w) => w.key === 'airbnb-untitled' || w.key === 'calendar-stays');
const untitledWarn = warned({ titled: false, notThroughFiles: false });
console.log(`  no title, no mark: ${untitledWarn.map((w) => `${w.key}: ${w.text}`).join(' | ')}`);
console.log(`  marked:            ${warned({ titled: false, notThroughFiles: true }).map((w) => w.key).join(',') || 'nothing'}`);
console.log(`  titled:            ${warned({ titled: true, notThroughFiles: false }).map((w) => w.key).join(',')}`);
console.log(`  not known (as before K2): ${warned({}).map((w) => w.key).join(',')}`);
check(untitledWarn.length === 1 && untitledWarn[0].key === 'airbnb-untitled', 'no title and no mark: K2\'s warning, once, instead of I15');
check(warned({ titled: false, notThroughFiles: true }).length === 0, 'a marked property: neither');
check(warned({ titled: true }).map((w) => w.key).join() === 'calendar-stays' && warned({}).map((w) => w.key).join() === 'calendar-stays', 'a titled property, or one not known: I15, as before');

// ═══ 7. The routes accept the bodies the page sends ═══
console.log('\n═══ 7. What the two new routes accept, with the bodies the page builds ═══');
const body = { month: '2026-09', groups: view.onePass.groups, expected: { lines: view.onePass.lines, properties: view.onePass.properties, amountCents: view.onePass.amountCents } };
const parsed = sc.AcceptMonthInputSchema.safeParse(JSON.parse(JSON.stringify(body)));
check(parsed.success, 'accept-month: the body acceptMonthLines builds from the view');
const twice = sc.AcceptMonthInputSchema.safeParse({ ...body, groups: [...body.groups, { propertyId: body.groups[0].propertyId, ids: [sha('other')] }] });
check(!twice.success && twice.error.issues.some((i) => i.message === 'A property is listed twice'), 'accept-month: a property twice is refused');
const lineTwice = sc.AcceptMonthInputSchema.safeParse({ ...body, groups: [{ propertyId: P(1), ids: [body.groups[0].ids[0]] }, { propertyId: P(2), ids: [body.groups[0].ids[0]] }] });
check(!lineTwice.success && lineTwice.error.issues.some((i) => i.message === 'A line is listed twice'), 'accept-month: a line twice is refused');
check(!sc.AcceptMonthInputSchema.safeParse({ ...body, extra: 1 }).success, 'accept-month: an unknown field is refused');
check(sc.IncomeSourceInputSchema.safeParse({ notThroughFiles: true, expected: false }).success && !sc.IncomeSourceInputSchema.safeParse({ notThroughFiles: 'yes', expected: false }).success, 'income-source: { notThroughFiles, expected }, booleans only');

// ═══ 8. The mark's record, read strictly ═══
console.log('\n═══ 8. The mark (property_income_sources/{propertyId}), read strictly ═══');
const source = { schemaVersion: 1, propertyId: P(9), notThroughFiles: true, setAt: AT, actor: ADMIN_ACTOR, history: [{ at: AT, actor: ADMIN_ACTOR, notThroughFiles: true }] };
check(inc.readIncomeSource(P(9), source)?.notThroughFiles === true, 'a mark in the written shape reads');
check(inc.readIncomeSource(P(1), source) === null, 'a mark under another property\'s ID is not read');
check(inc.readIncomeSource(P(9), { ...source, notThroughFiles: 'yes' }) === null, 'a mark not in shape is not read');

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`);
if (failures > 0) process.exitCode = 1;
