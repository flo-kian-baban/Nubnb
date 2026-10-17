// The cleaning schedule, phase 1 (Kian's rulings of 2026-10-14): the job sync on made-up calendar copies, the job's
// strict reading and its rules, cleanings schema version 2 (a job's cleaning, its amount waiting for an admin), the
// statement's one cleaning line for several cleaners, Finish's pending warning, and the cleaner door's lock key.
// Made-up data only: properties "TESTPROP…", cleaners "TESTCLEANER…". Nothing is read from or written to production.
//   node --import ./tests/tools/ts-hook.mjs tests/schedule/jobs.mjs
import { fileURLToPath } from 'node:url';

const ROOT = process.env.NUBNB_ROOT || fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const sync = await import(`${ROOT}/app/lib/schedule/sync.ts`);
const jm = await import(`${ROOT}/app/lib/schedule/model.ts`);
const { calendarKeyOf } = await import(`${ROOT}/app/lib/schedule/store.ts`);
const snap = await import(`${ROOT}/app/lib/availability/snapshot.ts`);
const cl = await import(`${ROOT}/app/lib/cleanings/model.ts`);
const model = await import(`${ROOT}/app/lib/reports/model.ts`);
const st = await import(`${ROOT}/app/lib/reports/statement.ts`);
const { statementPdf } = await import(`${ROOT}/app/lib/reports/statement-pdf.ts`);
const { finishChecks } = await import(`${ROOT}/app/lib/reports/checks.ts`);
const { formatCents: $, ADMIN_ACTOR } = await import(`${ROOT}/app/lib/cleaners/model.ts`);
const { cleanerConnectionKey } = await import(`${ROOT}/app/lib/cleaners/lock.ts`);
const { connectionKey } = await import(`${ROOT}/app/lib/admins/pin.ts`);

const TODAY = '2026-10-15';
const RUN = '2026-10-15T14:00:00.000Z';
const LINK = (p) => `https://www.airbnb.ca/calendar/ical/${p}.ics?s=made-up`;
const P1 = 'TESTPROPscheduleaaa1';
const P2 = 'TESTPROPscheduleaaa2';
const P3 = 'TESTPROPscheduleaaa3';
const P4 = 'TESTPROPscheduleaaa4';
const reserved = (uid, start, end) => ({ uid, kind: 'reserved', start, end });
const blocked = (uid, start, end) => ({ uid, kind: 'blocked', start, end });
const feed = (name, events, extra = {}) => ({ name, icalUrl: LINK(name), status: 'ok', fetchedAt: RUN, bytes: 1, eventCount: events.length, events, ...extra });
const copy = (properties) => ({ version: 1, refreshedAt: RUN, today: TODAY, horizonEnd: '2027-10-15', run: { source: 'manual', startedAt: RUN, finishedAt: RUN, durationMs: 0, fetched: 0, failed: [], pagesChecked: 0 }, properties });
const keysOf = (c) => new Map(Object.entries(c.properties).map(([id, e]) => [id, calendarKeyOf(e.icalUrl)]));
const show = (job) => `${job.id} · ${job.status}${job.change ? ` (${job.change.kind}${job.change.movedTo ? ` → ${job.change.movedTo.start}–${job.change.movedTo.end}` : ''})` : ''} · stay ${job.reservation.start}→${job.checkout} · next check-in ${job.nextCheckIn ?? 'none'}${jm.isSameDay(job) ? ' (same day)' : ''}`;

// ═══ 1. The copy keeps a stay through its checkout day ═══
console.log('═══ 1. The calendar copy keeps a stay through its checkout day ═══');
const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20261012', 'DTEND;VALUE=DATE:20261014', 'SUMMARY:Reserved', 'UID:a@airbnb.com', 'END:VEVENT', 'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20261013', 'DTEND;VALUE=DATE:20261015', 'SUMMARY:Reserved', 'UID:b@airbnb.com', 'DESCRIPTION:Reservation URL: x\\nPhone Number (Last 4 Digits): 0000', 'END:VEVENT', 'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20261015', 'DTEND;VALUE=DATE:20261016', 'SUMMARY:Airbnb (Not available)', 'UID:c@airbnb.com', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
const kept = snap.eventsFromFeed(ics, TODAY);
console.log(`  events kept: ${kept.map((e) => `${e.kind} ${e.start}→${e.end}`).join(' | ')} (the one that ended yesterday is dropped)`);
console.log(`  tonight's state is unchanged by the stay ending today: ${snap.nightStates(feed('x', kept), TODAY, '2026-10-17').join(', ')}`);

// ═══ 2. Jobs made: reservations only, today to two days ahead, calendars read this run ═══
console.log('\n═══ 2. Jobs made from a run ═══');
const run1 = copy({
  [P1]: feed('Test Loft', [reserved('r1', '2026-10-13', TODAY), reserved('r2', TODAY, '2026-10-16'), reserved('r3', '2026-10-16', '2026-10-17'), reserved('r4', '2026-10-17', '2026-10-20'), blocked('b1', '2026-10-20', '2026-10-21')]),
  [P2]: feed('Test Cottage', [blocked('b2', '2026-10-14', '2026-10-17'), reserved('r5', '2026-10-18', '2026-10-20')]),
  [P3]: feed('Test Condo', [reserved('r6', '2026-10-10', '2026-10-16')], { status: 'failed', fetchedAt: '2026-10-14T14:00:00.000Z', failedSince: '2026-10-15T13:00:00.000Z', failures: 1, error: 'HTTP 503' }),
  [P4]: { name: 'Test Basement', icalUrl: '', status: 'no-feed', fetchedAt: null, bytes: 0, eventCount: 0, events: [] },
});
const made = sync.planCreates({ snapshot: run1, existing: new Set(), keys: keysOf(run1), nowIso: RUN });
for (const { id, job } of made) console.log(`  ${show({ id, ...job })}`);
console.log(`  not made: Test Cottage's block (a block never makes one) and its stay checking out ${'2026-10-20'} (three days ahead); Test Condo (its calendar failed this run); Test Basement (no calendar link)`);
console.log(`  the history's first event: ${JSON.stringify(made[0].job.history[0])}`);
console.log(`  a second run with them stored makes none: ${sync.planCreates({ snapshot: run1, existing: new Set(made.map((m) => m.id)), keys: keysOf(run1), nowIso: RUN }).length}`);

// Every made job reads back strictly.
const stored = new Map(made.map(({ id, job }) => [id, { id, ...job }]));
console.log(`  read back: ${[...stored.values()].every((j) => jm.readJob(j.id, j) !== null)}`);

// ═══ 3. Watched: what a later run changes ═══
console.log('\n═══ 3. What a later run changes on a stored job ═══');
const j15 = stored.get(`${P1}_${TODAY}`);
const j16 = stored.get(`${P1}_2026-10-16`);
const j17 = stored.get(`${P1}_2026-10-17`);
const later = (events, extra = {}) => copy({ [P1]: feed('Test Loft', events, extra), [P2]: run1.properties[P2] });
const cases = [
  ['nothing changed', j16, later(run1.properties[P1].events)],
  ['the 16th cancelled', j16, later([reserved('r1', '2026-10-13', TODAY), reserved('r3', '2026-10-16', '2026-10-17'), reserved('r4', '2026-10-17', '2026-10-20')])],
  ['the 17th extended to the 19th (same UID)', j17, later([reserved('r2', TODAY, '2026-10-16'), reserved('r3', '2026-10-16', '2026-10-19')])],
  ['the 16th rebooked: same days, a new UID', j16, later([reserved('r2new', TODAY, '2026-10-16'), reserved('r3', '2026-10-16', '2026-10-17'), reserved('r4', '2026-10-17', '2026-10-20')])],
  ['the 17th: check-in moved, checkout the same', j17, later([reserved('r2', TODAY, '2026-10-16'), reserved('r3', '2026-10-15', '2026-10-17'), reserved('r4', '2026-10-17', '2026-10-20')])],
  ['the 17th: the next guest cancelled', j17, later([reserved('r2', TODAY, '2026-10-16'), reserved('r3', '2026-10-16', '2026-10-17')])],
  ['the calendar link changed and the stay is gone', j16, later([reserved('z1', '2026-10-01', '2026-11-01')], { icalUrl: LINK('another-calendar') })],
  ['the calendar link changed, a stay still ends that day', j16, later([reserved('z2', '2026-10-14', '2026-10-16')], { icalUrl: LINK('another-calendar') })],
  ['the copy says the calendar link was removed (from the copy alone)', j16, copy({ [P1]: { ...run1.properties[P1], icalUrl: '', status: 'no-feed', fetchedAt: null, events: [] } })],
  ['the calendar link removed: the property itself has none', j16, copy({ [P1]: { ...run1.properties[P1], icalUrl: '', status: 'no-feed', fetchedAt: null, events: [] } }), 'no-calendar'],
  ['the property not in the copy (from the copy alone)', j16, copy({ [P2]: run1.properties[P2] })],
  ['the property not in the copy, and still there with its calendar', j16, copy({ [P2]: run1.properties[P2] }), 'has-calendar'],
  ['the property deleted: its own document is gone', j16, copy({ [P2]: run1.properties[P2] }), 'deleted'],
  ['the calendar failed this run', j16, later([], { status: 'failed', fetchedAt: '2026-10-14T14:00:00.000Z' })],
  ['checkout day itself: the stay still there', j15, later(run1.properties[P1].events)],
  ['checkout day itself: extended that morning', j15, later([reserved('r1', '2026-10-13', '2026-10-18'), reserved('r2', '2026-10-18', '2026-10-19')])],
];
for (const [label, job, c, known] of cases) {
  const patch = sync.planJob(job, c, keysOf(c).get(job.propertyId) ?? null, RUN, known);
  console.log(`  ${label}: ${patch === null ? 'no change' : `${JSON.stringify(patch.fields)} · ${patch.events.map((e) => `${e.action}${e.change ? `/${e.change}` : ''}${e.reason ? ` (${e.reason})` : ''}`).join(', ')}`}`);
}
// Settled after the checkout day.
const dayAfter = { ...later([]), today: '2026-10-16' };
console.log(`  the day after the 15th's checkout, the stay gone from the feed: ${sync.planJob(j15, dayAfter, keysOf(dayAfter).get(P1), RUN) === null ? 'no change (settled)' : 'CHANGED'}`);
// A changed job reopens when its day ends a stay again.
const changedJob = { ...j16, status: 'booking-changed', change: { kind: 'gone', at: RUN, movedTo: null } };
const reopen = sync.planJob(changedJob, run1, keysOf(run1).get(P1), RUN);
console.log(`  a changed job whose day ends a stay again: ${JSON.stringify(reopen.fields)} · ${reopen.events.map((e) => e.action).join(', ')}`);

// ═══ 3b. A partial or cut-off copy changes no job of a property it did not read (Kian's ruling of 2026-10-17) ═══
console.log('\n═══ 3b. A partial or cut-off copy changes no job of a property it did not read ═══');
{
  // Stored jobs on four properties: open, booking changed, with and without a next guest, from today on.
  const job = (pid, checkout, extra = {}) => ({ ...j16, id: `${pid}_${checkout}`, propertyId: pid, checkout, ...extra });
  const others = [
    job(P1, TODAY), job(P1, '2026-10-16'), job(P1, '2026-10-17', { status: 'booking-changed', change: { kind: 'gone', at: RUN, movedTo: null } }),
    job(P3, TODAY), job(P3, '2026-10-16', { nextCheckIn: '2026-10-16' }),
    job(P4, '2026-10-17'),
  ];
  const earlier = '2026-10-15T09:00:00.000Z';
  const p2Read = feed('Test Suite', [reserved('s1', '2026-10-12', '2026-10-16')]);
  const runs = [
    ['a partial copy holding one property (P2) alone', copy({ [P2]: p2Read })],
    ['a refresh cut off partway: P1 not fetched (failed), P3 still holding the last run\'s events, P4 marked no-feed in the copy', copy({
      [P2]: p2Read,
      [P1]: { ...feed('Test Loft', []), status: 'failed', fetchedAt: earlier, error: 'Not fetched' },
      [P3]: feed('Test Annex', [], { fetchedAt: earlier }),
      [P4]: { ...feed('Test Studio', []), icalUrl: '', status: 'no-feed', fetchedAt: null },
    })],
  ];
  for (const [label, c] of runs) {
    for (const known of ['unknown', 'has-calendar']) {
      const changed = others.filter((j) => sync.planJob(j, c, keysOf(c).get(j.propertyId) ?? null, RUN, known) !== null);
      console.log(`  ${label}, the properties ${known === 'unknown' ? 'not looked up' : 'still there with a calendar'}: ${others.length} jobs of properties it did not read, ${changed.length} changed${changed.length ? ` (${changed.map((j) => j.id).join(', ')})` : ''}`);
    }
  }
  // The one property it did read is judged as usual: P2's stay now ends on the 16th, so its job of the 15th changed.
  const p2Job = job(P2, TODAY, { reservation: { uid: 's1', start: '2026-10-12' }, calendarKey: calendarKeyOf(LINK('Test Suite')) });
  const p2Patch = sync.planJob(p2Job, runs[0][1], keysOf(runs[0][1]).get(P2), RUN);
  console.log(`  the property it did read (P2), its stay moved to end the 16th: ${p2Patch ? `${p2Patch.fields.status} (${p2Patch.fields.change.kind}${p2Patch.fields.change.movedTo ? ` → ${p2Patch.fields.change.movedTo.start}–${p2Patch.fields.change.movedTo.end}` : ''})` : 'no change'}`);
}

// ═══ 4. A job's rules ═══
console.log('\n═══ 4. A job\'s rules: who can mark it, when, and what it reads as ═══');
const A = 'TESTCLEANERana000001';
const B = 'TESTCLEANERben000001';
const assigned = (job, ids, marks = {}) => ({ ...job, cleanerIds: ids, assignments: Object.fromEntries(ids.map((id) => [id, { nameAtAssignment: id === A ? 'Ana' : 'Ben', assignedAt: RUN, assignedBy: ADMIN_ACTOR, cleaningId: marks[id] ?? null, markedAt: marks[id] ? RUN : null, removedAt: null, removedBy: null }])) });
const two = assigned(j16, [A, B], { [A]: 'TESTCLEANINGjob00001' });
for (const [who, today] of [[A, '2026-10-16'], [B, '2026-10-15'], [B, '2026-10-16'], ['TESTCLEANERzed000001', '2026-10-16']]) console.log(`  ${who === A ? 'Ana (marked)' : who === B ? 'Ben' : 'someone not on it'} on ${today}: ${jm.markRefusal(two, who, today) ?? 'can mark'}`);
const twoChanged = { ...two, status: 'booking-changed', change: { kind: 'gone', at: '2026-10-16T20:00:00.000Z', movedTo: null } };
console.log(`  Ben after the booking changed: ${jm.markRefusal(twoChanged, B, '2026-10-16')} · changed after it was marked: ${jm.changedAfterMark(twoChanged)} · words: ${jm.changeWords(twoChanged.change)}`);
console.log(`  done: none ${jm.isDone(j16)}, one of two ${jm.isDone(two)}, both ${jm.isDone(assigned(j16, [A, B], { [A]: 'x', [B]: 'y' }))} · moved words: ${jm.changeWords({ kind: 'moved', at: RUN, movedTo: { start: '2026-10-16', end: '2026-10-27' } })}`);
// Removed by the office (Kian's ruling of the night): the mark stays, the cleaner cannot mark again, an admin can reopen it.
const OFFICE = '2026-10-16T21:00:00.000Z';
const removedMark = { ...two, assignments: { ...two.assignments, [A]: { ...two.assignments[A], removedAt: OFFICE, removedBy: ADMIN_ACTOR } } };
console.log(`  Ana's cleaning removed by the office: mark refused ${jm.markRefusal(removedMark, A, '2026-10-16')} · still a mark ${jm.markedCount(removedMark)} of 2 · reopen ${jm.reopenRefusal(removedMark, A) ?? 'can reopen'} · reads back ${jm.readJob(removedMark.id, removedMark) !== null}`);
console.log(`  reopen refused: for Ben (not removed) ${jm.reopenRefusal(removedMark, B)} · for someone not on it ${jm.reopenRefusal(removedMark, 'TESTCLEANERzed000001')} · after the booking changed ${jm.reopenRefusal({ ...removedMark, status: 'booking-changed', change: { kind: 'gone', at: OFFICE, movedTo: null } }, A)}`);
const reopened = { ...removedMark, assignments: { ...removedMark.assignments, [A]: { ...removedMark.assignments[A], cleaningId: null, markedAt: null, removedAt: null, removedBy: null } }, history: [...removedMark.history, jm.jobEvent(OFFICE, 'mark-reopened', ADMIN_ACTOR, { cleanerId: A, cleanerName: 'Ana', cleaningId: 'TESTCLEANINGjob00001' })] };
console.log(`  reopened: Ana ${jm.markRefusal(reopened, A, '2026-10-16') ?? 'can mark'} · its event reads back ${jm.readJob(reopened.id, reopened)?.history.at(-1).action}`);
const bad = [
  ['an ID not its property and checkout', { ...two, id: `${P1}_2026-10-18` }],
  ['booking changed with no change', { ...two, status: 'booking-changed', change: null }],
  ['an assignment for nobody in cleanerIds', { ...two, cleanerIds: [A] }],
  ['marked with no time', { ...two, assignments: { ...two.assignments, [A]: { ...two.assignments[A], markedAt: null } } }],
  ['removed with no one who removed it', { ...two, assignments: { ...two.assignments, [A]: { ...two.assignments[A], removedAt: OFFICE } } }],
  ['removed with no mark', { ...two, assignments: { ...two.assignments, [B]: { ...two.assignments[B], removedAt: OFFICE, removedBy: ADMIN_ACTOR } } }],
  ['an assignment without the removal fields', { ...two, assignments: { ...two.assignments, [B]: { nameAtAssignment: 'Ben', assignedAt: RUN, assignedBy: ADMIN_ACTOR, cleaningId: null, markedAt: null } } }],
  ['a history event missing a field', { ...two, history: [{ at: RUN, action: 'created', actor: ADMIN_ACTOR }] }],
];
for (const [label, fields] of bad) console.log(`  refused as not in shape — ${label}: ${jm.readJob(fields.id, fields) === null}`);
console.log(`  read as written: ${jm.readJob(two.id, two) !== null}`);

// ═══ 5. A job's cleaning (cleanings schema version 2) ═══
console.log('\n═══ 5. A job\'s cleaning ═══');
const NAME = 'Ana Testcleaner';
let seq = 0;
const actorAna = { role: 'cleaner', id: A, name: NAME };
function cleaning(cleanerId, day, cents, extra = {}) {
  const id = `TESTCLEANINGjob${String(++seq).padStart(5, '0')}`;
  const at = `${day}T20:00:00.000Z`;
  const actor = cleanerId === A ? actorAna : { role: 'cleaner', id: cleanerId, name: 'Ben Testcleaner' };
  return { id, schemaVersion: 2, propertyId: P1, propertyNameAtEntry: 'Test Loft', cleanerId, cleanerNameAtEntry: actor.name, day, amountCents: cents, note: null, status: 'logged', suggested: cents === null ? { from: 'none', cents: null } : { from: 'default', cents }, createdAt: at, actor, history: [{ at, action: 'logged', actor, reason: null }], jobId: `${P1}_${day}`, ...extra };
}
const view = (c) => {
  const read = cl.readCleaning(c.id, c);
  if (!read) throw new Error(`not in shape: ${c.id}`);
  return { ...read, cleaner: { state: 'found', name: read.cleanerNameAtEntry, status: 'active' }, property: { state: 'found', name: 'Test Loft' } };
};
const ana = cleaning(A, '2026-10-16', 6000);
const ben = cleaning(B, '2026-10-16', 5500);
const waiting = cleaning(B, '2026-10-20', null);
console.log(`  read: Ana's ${$(ana.amountCents)} jobId ${view(ana).jobId} · the waiting one, amount ${view(waiting).amountCents} · a version 1 cleaning reads jobId ${cl.readCleaning('v1', { ...ana, schemaVersion: 1, jobId: undefined }).jobId}`);
console.log(`  refused: no amount without a job ${cl.readCleaning('x', { ...waiting, jobId: null }) === null} · a zero amount ${cl.readCleaning('x', { ...ana, amountCents: 0 }) === null}`);
const pending = cl.cleaningEntryView(view(waiting));
console.log(`  the waiting one as the statements read it: status ${pending.status}, lines ${JSON.stringify(pending.lines)}, linesNow ${JSON.stringify(pending.linesNow)}`);
const typed = { ...waiting, amountCents: 5000, history: [...waiting.history, { at: '2026-10-21T15:00:00.000Z', action: 'changed', actor: ADMIN_ACTOR, reason: null, before: { amountCents: null }, after: { amountCents: 5000 } }] };
const typedView = cl.cleaningEntryView(view(typed));
console.log(`  its amount typed: status ${typedView.status}, total ${$(typedView.linesNow.totalCents)}, sent ${$(typedView.linesNow.sentTotalCents)}, corrected ${typedView.linesNow.corrected}`);
const retyped = { ...typed, amountCents: 5200, history: [...typed.history, { at: '2026-10-22T15:00:00.000Z', action: 'changed', actor: ADMIN_ACTOR, reason: null, before: { amountCents: 5000 }, after: { amountCents: 5200 } }] };
console.log(`  changed again after: total ${$(cl.cleaningEntryView(view(retyped)).linesNow.totalCents)}, first amount ${$(cl.cleaningEntryView(view(retyped)).linesNow.sentTotalCents)}, corrected ${cl.cleaningEntryView(view(retyped)).linesNow.corrected}`);
const suggest = cl.suggestedAmount([view(waiting), view(ben)].map((c) => ({ ...c })), B, P1, null);
console.log(`  37B's amount for Ben's next mark: from ${suggest.from}, ${suggest.cents === null ? 'none' : $(suggest.cents)} (the waiting one, with no amount, is not "last paid")`);
console.log(`  with neither a last amount nor a default rate: ${JSON.stringify(cl.suggestedAmount([], A, P2, null))}`);

// ═══ 6. Two cleaners on one job: one line on the owner's statement ═══
console.log('\n═══ 6. Two cleaners on one job, and one waiting for its amount: the owner\'s statement ═══');
const record = { id: P1, schemaVersion: 3, propertyId: P1, reportFor: { name: 'Test Owner', address: '' }, owners: [], statementsFrom: '2026-09', statementsUntil: null, defaultFeeRateBasisPoints: null, defaultFee: null, setAt: '2026-10-01T00:00:00.000Z' };
const draft = { reference: `${model.monthReferenceWord('2026-10')}-TEST`, reportDate: model.monthRange('2026-11').from, lines: [{ id: 'L-rev', description: 'Revenue', from: null, to: null, quantity: 1, rateCents: 50000, amountCents: 50000 }], fee: null, carried: null, notes: null, supersedes: null };
const entries = [ana, ben, waiting].map((c) => cl.cleaningEntryView(view(c)));
const built = st.buildStatement({ propertyId: P1, propertyName: 'Test Loft', month: '2026-10', entries, reports: [], draft, management: record });
const printed = st.printedLines(built.statement).map((l) => `${l.description} · ${l.quantity} · ${l.rateCents === null ? '(rate empty)' : $(l.rateCents)} · ${$(l.amountCents)}`);
console.log(`  printed: ${printed.join(' | ')}`);
console.log(`  costs charged: ${built.statement.costs.map((c) => `${c.entryId} ${$(c.totalCents)}`).join(', ')} · left out, pending: ${built.statement.pendingLeftOut}`);
const pdf = Buffer.from(statementPdf({ ...built.statement, draft: false })).toString('latin1');
console.log(`  the PDF holds "Expense - Cleaning": ${pdf.includes('Expense - Cleaning')} · names a cleaner: ${pdf.includes('Ana') || pdf.includes('Ben')}`);
const checks = finishChecks({ statement: built.statement, reports: [], entries, income: null, today: '2026-11-03' });
console.log(`  Finish warns: ${checks.warnings.filter((w) => w.key === 'pending').map((w) => w.text).join(' | ')}`);

// ═══ 7. The cleaner door's lock key ═══
console.log('\n═══ 7. The cleaner door keeps its own key for a connection ═══');
const key = Buffer.alloc(32, 7);
const cleanerSide = cleanerConnectionKey(key, '203.0.113.7');
console.log(`  64 hex: ${/^[0-9a-f]{64}$/.test(cleanerSide)} · differs from the admin door's hash of the same address under the same key: ${cleanerSide !== connectionKey(key, '203.0.113.7')} · stable: ${cleanerSide === cleanerConnectionKey(key, '203.0.113.7')}`);
console.log(`  calendar keys: ${calendarKeyOf(LINK('Test Loft'))} for one link, ${calendarKeyOf(LINK('another-calendar'))} for another, '${calendarKeyOf('')}' for none`);
