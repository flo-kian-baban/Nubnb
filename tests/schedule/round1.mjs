// The Schedule, round 1 (2026-10-19; Kian's rulings R1, R2, R3 and R5): the regular cleaner, the three-hour read on
// open, the changed booking's card, "Not marked" on the home, the Schedule's states, and the cleaner's list without a
// read of the cleanings. The server functions run on an in-memory Firestore (tests/tools/memory-firestore.cjs):
// nothing is read from or written to Firestore or Storage, and every connection is refused. Made-up data only:
// properties "TESTPROP…", cleaners "Test …". Reads are counted as Firestore bills them.
//   node --import ./tests/tools/ts-hook.mjs tests/schedule/round1.mjs
import { createRequire } from 'node:module';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.NUBNB_ROOT || fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
createRequire(`${ROOT}/package.json`)(`${ROOT}/tests/tools/memory-firestore.cjs`);
// A made-up service account: firebase-admin starts, and has nowhere to go.
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.FIREBASE_SERVICE_ACCOUNT_KEY = JSON.stringify({ type: 'service_account', project_id: 'memory-test', private_key_id: 'memory-test', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), client_email: 'memory-test@memory-test.iam.gserviceaccount.com', client_id: '0', token_uri: 'https://oauth2.invalid/token' });
process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = 'memory-test.appspot.com';
process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = 'memory-test';

const jm = await import(`${ROOT}/app/lib/schedule/model.ts`);
const sync = await import(`${ROOT}/app/lib/schedule/sync.ts`);
const reg = await import(`${ROOT}/app/lib/schedule/regular.ts`);
const { syncJobs, calendarKeyOf } = await import(`${ROOT}/app/lib/schedule/store.ts`);
const sj = await import(`${ROOT}/app/lib/firebase/server-cleaning-jobs.ts`);
const srv = await import(`${ROOT}/app/lib/firebase/server-regular-cleaners.ts`);
const cl = await import(`${ROOT}/app/lib/firebase/server-cleanings.ts`);
const rs = await import(`${ROOT}/app/lib/availability/run-state.ts`);
const { UpdatePropertySchema } = await import(`${ROOT}/app/lib/api/schemas.ts`);
const { changedWords, homeJobs } = await import(`${ROOT}/app/lib/cleaner-home.ts`);
const home = await import(`${ROOT}/app/lib/home/next-step.ts`);
const standing = await import(`${ROOT}/app/lib/schedule/standing.ts`);
const { getAdminDb } = await import(`${ROOT}/app/lib/firebase/admin.ts`);
const db = getAdminDb();
const seed = globalThis.__memSeed;
const doc = globalThis.__memDoc;

let failures = 0;
const check = (ok, label) => {
  if (!ok) failures += 1;
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${label}`);
};
const readsOf = (fn) => async (...args) => {
  const before = globalThis.__memReads.length;
  const result = await fn(...args);
  const part = globalThis.__memReads.slice(before);
  const by = {};
  for (const r of part) by[r.what] = (by[r.what] ?? 0) + r.billed;
  return { result, reads: part.reduce((n, r) => n + r.billed, 0), by };
};
const byText = (by) => Object.entries(by).sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `${k} ${n}`).join(', ');

const TODAY = '2026-10-19';
const RUN = '2026-10-19T11:00:00.000Z'; // 07:00 Toronto
const ADMIN = { role: 'admin', id: 'TESTADMINround1aaaa1', name: 'Test admin' };
const P = (n) => `TESTPROPround1aaaa${n}`;
const ANA = { id: 'TESTCLEANERround1ana', name: 'Test Ana' };
const BEN = { id: 'TESTCLEANERround1ben', name: 'Test Ben' };
const GONE = { id: 'TESTCLEANERround1gon', name: 'Test Gone' };
const HANDY = { id: 'TESTHANDYMANround1hn', name: 'Test Handy' };
const LINK = (p) => `https://www.airbnb.ca/calendar/ical/${p}.ics?s=made-up`;
const reserved = (uid, start, end) => ({ uid, kind: 'reserved', start, end });
const feed = (name, events, at = RUN) => ({ name, icalUrl: LINK(name), status: 'ok', fetchedAt: at, bytes: 1, eventCount: events.length, events });
const copy = (properties, today = TODAY, at = RUN) => ({ version: 1, refreshedAt: at, today, horizonEnd: '2027-10-19', run: { source: 'daily', startedAt: at, finishedAt: at, durationMs: 0, fetched: 0, failed: [], pagesChecked: 0 }, properties });
const cleanerDoc = (m, role, status) => ({ schemaVersion: 2, name: m.name, role, status, sessionEpoch: 1, defaultRateCents: 9000, history: [] });
const record = (propertyId, cleanerId, name) => ({ schemaVersion: reg.REGULAR_CLEANER_SCHEMA_VERSION, propertyId, cleanerId, cleanerNameAtSet: name, setAt: '2026-10-18T12:00:00.000Z', setBy: ADMIN });

// ═══ 1. The regular-cleaner rule, on a job about to be made ═══
console.log('═══ 1. The regular cleaner, on a job the sync is about to make (Kian\'s ruling R5) ═══');
const planned = sync.planCreates({ snapshot: copy({ [P(1)]: feed('One', [reserved('r1', '2026-10-17', TODAY)]) }), existing: new Set(), keys: new Map([[P(1), calendarKeyOf(LINK('One'))]]), nowIso: RUN })[0];
const cases = [
  ['an active cleaner', { id: ANA.id, name: ANA.name, role: 'cleaner', status: 'active' }],
  ['a deactivated cleaner', { id: BEN.id, name: BEN.name, role: 'cleaner', status: 'deactivated' }],
  ['a handyman', { id: HANDY.id, name: HANDY.name, role: 'handyman', status: 'active' }],
  ['an account that no longer exists', null],
  ['no regular cleaner', undefined],
];
for (const [label, candidate] of cases) {
  const made = reg.withRegularCleaner(planned.job, candidate, RUN);
  const a = made.assignments[made.cleanerIds[0]];
  console.log(`  ${label}: on it ${made.cleanerIds.length ? made.cleanerIds.join(',') : 'nobody'}${a ? ` · assigned by ${a.assignedBy.role}/${a.assignedBy.name} at ${a.assignedAt}` : ''} · history ${made.history.map((e) => `${e.action}${e.actor.role === 'system' ? `(${e.actor.name})` : ''}`).join(' → ')} · reads back ${jm.readJob(planned.id, made) !== null}`);
}
check(reg.withRegularCleaner(planned.job, cases[0][1], RUN).cleanerIds[0] === ANA.id, 'an active cleaner is put on the job, by "regular cleaner"');
check(cases.slice(1).every(([, c]) => reg.withRegularCleaner(planned.job, c, RUN).cleanerIds.length === 0), 'a deactivated cleaner, a handyman, a deleted account or none: nobody on it');
check(reg.withRegularCleaner({ ...planned.job, cleanerIds: ['X'], assignments: { X: planned.job.assignments.X ?? { nameAtAssignment: 'x', assignedAt: RUN, assignedBy: ADMIN, cleaningId: null, markedAt: null, removedAt: null, removedBy: null } } }, cases[0][1], RUN).cleanerIds.join() === 'X', 'a job that already has someone on it is not changed');

// ═══ 2. The sync with regular cleaners, on an in-memory Firestore ═══
console.log('\n═══ 2. The job sync gives each new job to its regular cleaner ═══');
seed('cleaners', ANA.id, cleanerDoc(ANA, 'cleaner', 'active'));
seed('cleaners', BEN.id, cleanerDoc(BEN, 'cleaner', 'deactivated'));
seed('cleaners', HANDY.id, cleanerDoc(HANDY, 'handyman', 'active'));
const names = ['One', 'Two', 'Three', 'Four', 'Five', 'Six'];
for (let n = 1; n <= 6; n += 1) seed('properties', P(n), { name: `Test ${names[n - 1]}`, icalUrl: LINK(names[n - 1]) });
seed(reg.PROPERTY_REGULAR_CLEANERS_COLLECTION, P(1), record(P(1), ANA.id, ANA.name));
seed(reg.PROPERTY_REGULAR_CLEANERS_COLLECTION, P(2), record(P(2), BEN.id, BEN.name));
seed(reg.PROPERTY_REGULAR_CLEANERS_COLLECTION, P(3), record(P(3), GONE.id, GONE.name));
seed(reg.PROPERTY_REGULAR_CLEANERS_COLLECTION, P(5), record(P(5), HANDY.id, HANDY.name));
seed(reg.PROPERTY_REGULAR_CLEANERS_COLLECTION, P(6), { schemaVersion: 1, propertyId: P(6), cleanerId: '' });
// A job made before P1 had a regular cleaner, with nobody on it: no backfill.
const older = sync.planCreates({ snapshot: copy({ [P(1)]: feed('One', [reserved('r0', '2026-10-15', '2026-10-18')], '2026-10-18T11:00:00.000Z') }, '2026-10-18', '2026-10-18T11:00:00.000Z'), existing: new Set(), keys: new Map([[P(1), calendarKeyOf(LINK('One'))]]), nowIso: '2026-10-18T11:00:00.000Z' })[0];
seed('cleaning_jobs', older.id, older.job);
const run = copy(Object.fromEntries(names.map((name, i) => [P(i + 1), feed(name, [reserved(`r${i + 1}`, '2026-10-17', '2026-10-20')])])));
const synced = await readsOf(syncJobs)(db, run);
console.log(`  outcome: ${JSON.stringify(synced.result)} · reads ${synced.reads} (${byText(synced.by)})`);
for (let n = 1; n <= 6; n += 1) {
  const job = doc('cleaning_jobs', `${P(n)}_2026-10-20`);
  console.log(`  ${P(n)} (${['Ana, active', 'Ben, deactivated', 'an account deleted', 'none', 'a handyman', 'a record not in shape'][n - 1]}): on it ${job.cleanerIds.length ? job.cleanerIds.join(',') : 'nobody'} · last event ${job.history.at(-1).action} by ${job.history.at(-1).actor.name}`);
}
check(doc('cleaning_jobs', `${P(1)}_2026-10-20`).cleanerIds.join() === ANA.id && doc('cleaning_jobs', `${P(1)}_2026-10-20`).history.map((e) => e.action).join() === 'created,assigned', 'P1: Ana is on it, made then assigned');
check([2, 3, 4, 5, 6].every((n) => doc('cleaning_jobs', `${P(n)}_2026-10-20`).cleanerIds.length === 0), 'the others: nobody on them ("Needs a cleaner")');
check(doc('cleaning_jobs', older.id).cleanerIds.length === 0 && doc('cleaning_jobs', older.id).history.length === 1, 'a job made before the regular cleaner was set is not changed (no backfill)');
const again = await readsOf(syncJobs)(db, run);
console.log(`  the same run again: ${JSON.stringify(again.result)} · reads ${again.reads} (${byText(again.by)}): nothing to make, so no regular cleaner is read`);
check(again.result.created === 0 && !('property_regular_cleaners' in again.by), 'no job to make: the records are not read');

// ═══ 3. Setting it: only an active cleaner; never on the property document ═══
console.log('\n═══ 3. Setting a regular cleaner ═══');
seed('properties', P(7), { name: 'Test Seven' });
const set = async (label, cleanerId) => {
  const r = await readsOf(srv.setRegularCleaner)(ADMIN, P(7), cleanerId);
  console.log(`  ${label}: ${JSON.stringify(r.result)} · reads ${r.reads}`);
  return r.result;
};
await set('Ben, deactivated', BEN.id);
await set('a handyman', HANDY.id);
await set('an account that does not exist', GONE.id);
const made = await set('Ana, active', ANA.id);
await set('Ana again', ANA.id);
const view = await srv.getRegularCleaner(P(7), true);
// The record's history (schema version 2, Kian's ruling K4 of 2026-10-19) carries the run's time: printed without it.
const eventsOf = (history) => history.map((e) => `${e.action} ${e.from?.name ?? 'nobody'} → ${e.to?.name ?? 'nobody'}${e.reason ? ` (${e.reason})` : ''} by ${e.actor.name}`).join('; ');
console.log(`  read back: ${JSON.stringify({ ...view.regular, setAt: '…', history: undefined })} · history: ${eventsOf(view.regular.history)} · choices ${view.choices.map((c) => c.name).join(', ')}`);
console.log(`  Ana is the regular cleaner for: ${(await srv.regularAt(ANA.id)).join(', ')}`);
check(made.kind === 'set' && view.regular.assigns === true && view.choices.every((c) => c.id !== BEN.id && c.id !== HANDY.id), 'only an active cleaner is set; the choices are the active cleaners');
const cleared = await set('cleared', null);
const kept = doc(reg.PROPERTY_REGULAR_CLEANERS_COLLECTION, P(7));
const keptRead = kept ? reg.readRegularCleaner(P(7), kept) : null;
console.log(`  after clearing: record kept ${kept !== null} · names ${keptRead?.cleanerId ?? 'nobody'} · schema ${keptRead?.schemaVersion} · history: ${keptRead ? eventsOf(keptRead.history) : '-'} · read back as ${JSON.stringify((await srv.getRegularCleaner(P(7))).regular)}`);
check(cleared.kind === 'cleared' && keptRead !== null && keptRead.cleanerId === null && keptRead.history.map((e) => e.action).join(',') === 'set,cleared', 'clearing it keeps the record naming nobody, with its history (schema version 2; Kian\'s ruling K4 of 2026-10-19), and it reads back as none');
check((await set('cleared again', null)).kind === 'unchanged', 'clearing a record that names nobody writes nothing');
check((await srv.setRegularCleaner(ADMIN, 'TESTPROPnosuchone001', ANA.id)).kind === 'no-such-property', 'a property that does not exist: refused');
for (const field of reg.REGULAR_CLEANER_FIELDS) {
  const parsed = UpdatePropertySchema.safeParse({ name: 'x', [field]: ANA.id });
  console.log(`  a property save carrying ${field}: ${parsed.success ? 'accepted' : `refused: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`}`);
}
check(reg.REGULAR_CLEANER_FIELDS.every((field) => !UpdatePropertySchema.safeParse({ [field]: 'x' }).success), 'the property save refuses it under any of its names, as it refuses the name cleaners see');
check(UpdatePropertySchema.safeParse({ cleanerName: 'x' }).success === false, '(the name cleaners see is refused there too, as before)');
const asked = reg.regularCleanerQuestion('Test Ana', 'Test Seven');
console.log(`  asked first: "${asked.title}" / "${asked.lines.join(' ')}" / [${asked.confirm}]`);
console.log(`  asked first, a cleaner with no name: "${reg.regularCleanerQuestion(null, 'Test Seven').title}" / "${reg.regularCleanerQuestion(null, 'Test Seven').lines.join(' ')}"`);
check(asked.title === 'Make Test Ana the regular cleaner for Test Seven?' && asked.lines.join(' ') === 'New jobs there go to Test Ana.', 'setting it asks first, in Kian\'s words, the same on the Schedule\'s picker and the edit page');

// ═══ 4. Reads on open: the three-hour trigger (Kian's ruling R1) ═══
console.log('\n═══ 4. A refresh on open: the copy more than three hours old ═══');
const NOW = '2026-10-19T17:00:00.000Z'; // 13:00 Toronto
const done = (day, finishedAt) => ({ ...rs.NO_REFRESH_YET, lastDone: { id: 'RUN-DONE', source: 'daily', trigger: 'admin-page', day, startedAt: finishedAt, finishedAt } });
const show = (d) => (d.kind === 'claimed' ? `claimed ${d.run.source}/${d.run.trigger}` : d.kind === 'running' ? 'running' : d.kind === 'done-today' ? `fresh (finished ${d.finishedAt})` : `paused until ${d.until}`);
const open = (label, state, trigger = 'admin-page', threshold = rs.STALE_AFTER_MS) => {
  const d = rs.decideClaim(state, 'daily', trigger, new Date(NOW), 'RUN-NEW', threshold);
  console.log(`  ${label}: ${show(d)}`);
  return d.kind;
};
console.log(`  the threshold: ${rs.STALE_AFTER_MS / 3_600_000} hours`);
const r1 = open('read today 2 h 59 min ago (10:01 Toronto), the Schedule opens', done(TODAY, '2026-10-19T14:01:00.000Z'));
const r2 = open('read today exactly 3 h ago', done(TODAY, '2026-10-19T14:00:00.000Z'));
const r3 = open('read today 3 h 1 min ago, the Schedule opens', done(TODAY, '2026-10-19T13:59:00.000Z'));
const r4 = open('the same, a cleaner\'s app opens', done(TODAY, '2026-10-19T13:59:00.000Z'), 'cleaner-app');
const r5 = open('read yesterday at 23:30 Toronto (1 h 30 min before midnight), now 00:30', done('2026-10-18', '2026-10-19T03:30:00.000Z'));
const r6 = open('a run holds the lease', { ...rs.NO_REFRESH_YET, running: { id: 'RUN-HELD', source: 'daily', trigger: 'cleaner-app', startedAt: '2026-10-19T16:59:00.000Z', leaseUntil: '2026-10-19T17:05:00.000Z' }, lastDone: done(TODAY, '2026-10-19T10:00:00.000Z').lastDone });
const r7 = open('read 5 h ago, but a try failed 10 min ago', { ...done(TODAY, '2026-10-19T12:00:00.000Z'), lastFailed: { id: 'RUN-FAIL', source: 'daily', trigger: 'admin-page', startedAt: '2026-10-19T16:50:00.000Z', at: '2026-10-19T16:51:00.000Z', reason: 'HTTP 503' } });
const r8 = open('read 5 h ago, the first-visit rule alone (any other admin page)', done(TODAY, '2026-10-19T12:00:00.000Z'), 'admin-page', null);
const r9 = open('nothing ever read', rs.NO_REFRESH_YET);
check(r1 === 'done-today' && r2 === 'done-today' && r3 === 'claimed' && r4 === 'claimed', 'more than three hours old: the Schedule or a cleaner\'s app starts the run; three hours or less: nothing');
check(r5 === 'claimed', 'a copy from yesterday starts it however recent (the first visit of the day)');
check(r6 === 'running' && r7 === 'paused', 'one run at a time, the same lease; the same pause after a failed try');
check(r8 === 'done-today' && r9 === 'claimed', 'every other admin page keeps the first-visit rule (one run a Toronto day)');
const stored = rs.decideClaim(done(TODAY, '2026-10-19T12:00:00.000Z'), 'daily', 'admin-page', new Date(NOW), 'RUN-NEW', rs.STALE_AFTER_MS);
check(stored.kind === 'claimed' && rs.readRefreshState(stored.next) !== null && stored.next.running.source === 'daily', 'the state it writes reads back strictly, its source "daily": readers already deployed keep reading it');

// ═══ 5. A changed booking on the cleaner's card (Kian's ruling R2) ═══
console.log('\n═══ 5. A changed booking on the cleaner\'s card ═══');
for (const [label, change] of [['cancelled', { kind: 'gone', movedTo: null }], ['moved to Sat, Oct 24', { kind: 'moved', movedTo: { start: '2026-10-19', end: '2026-10-24' } }], ['its calendar link changed', { kind: 'calendar-changed', movedTo: null }], ['the property deleted', { kind: 'property-deleted', movedTo: null }]]) {
  const w = changedWords({ change });
  console.log(`  ${label}: "${w.words}"${w.plain ? '' : ' (beside "Booking changed")'}`);
}
check(changedWords({ change: { kind: 'gone', movedTo: null } }).words === 'Cancelled: don’t go', 'cancelled: "Cancelled: don\'t go"');
check(changedWords({ change: { kind: 'moved', movedTo: { start: '2026-10-19', end: '2026-10-24' } } }).words === 'Moved to Sat, Oct 24', 'moved: "Moved to <day>"');

// ═══ 6. "Not marked" on the home (Kian's ruling R3) ═══
console.log('\n═══ 6. Not marked: a Next step, its own chip ═══');
const c = (name, marked = false, removed = false) => ({ name, marked, removed, pending: false });
const hj = (checkout, cleaners, extra = {}) => ({ propertyId: P(9), checkout, status: 'open', changedAfterMark: false, change: null, cleaners, ...extra });
const finished = { tone: 'done', standing: 'finished', month: '2026-09', pastDue: [], previous: { month: '2026-09', standing: 'finished' } };
const row = (jobs) => home.rowView({ propertyId: P(9), today: TODAY, status: finished, hasReportFor: true, incomeMonth: '2026-09', review: 0, direct: null, jobs, hasCalendarLink: true, calendarRead: true });
const said = (label, jobs) => {
  const v = row(jobs);
  console.log(`  ${label}: ${v.step.key} · "${v.step.label}" · ${v.step.href ?? '-'} · under ${Object.entries(v.under).filter(([, on]) => on).map(([k]) => k).join(',') || '-'} · ${v.step.title}`);
  return v;
};
const a = said('passed, Ana on it, not marked', [hj('2026-10-16', [c('Test Ana')])]);
const b = said('passed, Ana marked it, Ben did not', [hj('2026-10-17', [c('Test Ana', true), c('Test Ben')])]);
const d = said('passed, Ana\'s mark removed by the office', [hj('2026-10-17', [c('Test Ana', true, true)])]);
const e = said('checkout today, not marked yet', [hj(TODAY, [c('Test Ana')])]);
const f = said('passed, its booking changed', [hj('2026-10-17', [c('Test Ana')], { status: 'booking-changed', change: 'Cancelled' })]);
const g = said('passed 15 days ago', [hj('2026-10-04', [c('Test Ana')])]);
const h = said('a job with nobody on it tomorrow, and one not marked', [hj('2026-10-16', [c('Test Ana')]), hj('2026-10-20', [])]);
check(a.step.key === 'not-marked' && a.step.label === 'Check Oct 16 was cleaned' && a.step.href === `/admin/schedule?property=${P(9)}&from=2026-10-16` && a.under['not-marked'] && a.under.attention, 'not marked: "Check <day> was cleaned", to the Schedule at that day, under its chip and Needs attention');
check(b.step.key === 'not-marked' && b.step.title.includes('Test Ben') && !b.step.title.includes('Test Ana'), 'one of two not marked: named');
check(d.step.key === 'none' && e.step.key === 'none' && f.step.key === 'none' && g.step.key === 'none', 'a removed mark, today, a changed booking, older than the column looks: not "Not marked"');
check(h.step.key === 'assign' && h.under['not-marked'], 'a job with nobody on it comes first; the row is still under Not marked');
check(home.STEP_ORDER.indexOf('not-marked') === home.STEP_ORDER.indexOf('assign') + 1 && home.CHIPS.map((x) => x.label).join(' | ') === 'Needs attention | Statements blocked | Statements ready | Airbnb lines to review | Needs a cleaner | Not marked | Calendar not read | Direct overdue', 'its place: after Assign; its chip beside Needs a cleaner');

// ═══ 7. The Schedule's states ═══
console.log('\n═══ 7. A job\'s state on the Schedule ═══');
const av = (name, { cleaningId = null, removedAt = null } = {}) => ({ cleanerId: `TEST${name}`, name, nameAtAssignment: name, assignedAt: RUN, assignedBy: ADMIN, cleaningId, markedAt: cleaningId ? RUN : null, removedAt, removedBy: removedAt ? ADMIN : null, status: 'active', state: 'found', cleaning: null });
const sj2 = (checkout, assignees, extra = {}) => ({ status: 'open', change: null, checkout, cleanerIds: assignees.map((x) => x.cleanerId), assignees, ...extra });
const states = [
  ['nobody, two days ahead', sj2('2026-10-21', [])],
  ['nobody, tomorrow', sj2('2026-10-20', [])],
  ['nobody, today', sj2(TODAY, [])],
  ['nobody, yesterday', sj2('2026-10-18', [])],
  ['Ana on it, today, not marked yet', sj2(TODAY, [av('Ana')])],
  ['Ana on it, yesterday, not marked', sj2('2026-10-18', [av('Ana')])],
  ['Ana marked, Ben not, yesterday', sj2('2026-10-18', [av('Ana', { cleaningId: 'C1' }), av('Ben')])],
  ['Ana\'s mark removed by the office, yesterday', sj2('2026-10-18', [av('Ana', { cleaningId: 'C1', removedAt: RUN })])],
  ['both marked', sj2('2026-10-18', [av('Ana', { cleaningId: 'C1' }), av('Ben', { cleaningId: 'C2' })])],
  ['cancelled', sj2(TODAY, [av('Ana')], { status: 'booking-changed', change: { kind: 'gone', at: RUN, movedTo: null } })],
];
for (const [label, job] of states) {
  const s = jm.jobState(job, TODAY);
  console.log(`  ${label}: "${s.label}" (${s.tone})`);
}
const tones = states.map(([, job]) => jm.jobState(job, TODAY).tone);
check(tones[0] === 'needs' && tones[1] === 'needs' && tones[2] === 'needsNow' && tones[3] === 'needsNow', 'nobody on it: amber ahead, red on its checkout day and after');
check(tones[4] === 'assigned' && tones[5] === 'notMarked' && tones[6] === 'notMarked' && tones[7] === 'removed' && tones[8] === 'done', 'not marked once the checkout passed; a removed mark is the office\'s, not "Not marked"');
// The home's Cleaning cell takes the same rule (needsCleanerNow): nobody on it, red from its checkout day on.
const agree = [];
for (const day of ['2026-10-21', '2026-10-20', TODAY, '2026-10-18', '2026-10-05']) {
  const schedule = jm.jobState(sj2(day, []), TODAY).tone;
  const cell = standing.cleaningStanding([hj(day, [])], { today: TODAY, hasCalendar: true });
  console.log(`  nobody on it, checkout ${day}: Schedule ${schedule === 'needsNow' ? 'red' : 'amber'} (${schedule}) · home ${cell.tone === 'problem' ? 'red' : 'amber'} (${cell.key}) · ${cell.title}`);
  agree.push((schedule === 'needsNow') === (cell.tone === 'problem') && (schedule === 'needs') === (cell.tone === 'warning'));
}
check(agree.every(Boolean) && agree.length === 5, 'the home\'s Cleaning cell says what the Schedule says: amber ahead, red on its checkout day and after');

// ═══ 8. A cleaner's list, without reading the cleanings ═══
console.log('\n═══ 8. A cleaner\'s list reads no cleaning ═══');
const P8 = P(8);
seed('properties', P8, { name: 'Test Eight', icalUrl: LINK('Eight'), details: { checkOut: '11:00', checkIn: '16:00' }, addressDetails: { city: 'Toronto' } });
const mk = (checkout, uid) => sync.planCreates({ snapshot: copy({ [P8]: feed('Eight', [reserved(uid, '2026-10-05', checkout)], `${checkout}T11:00:00.000Z`) }, checkout, `${checkout}T11:00:00.000Z`), existing: new Set(), keys: new Map([[P8, calendarKeyOf(LINK('Eight'))]]), nowIso: `${checkout}T11:00:00.000Z` })[0];
const days = ['2026-10-10', '2026-10-12', '2026-10-14', '2026-10-16', '2026-10-18'];
for (const [i, day] of days.entries()) {
  const j = mk(day, `u${i}`);
  seed('cleaning_jobs', j.id, j.job);
  const r = await sj.setAssignees(ADMIN, j.id, [ANA.id], 1);
  if (r.kind !== 'saved') console.log(`  assign ${day}: ${r.kind}`);
}
for (const day of days.slice(0, 4)) {
  const r = await sj.markCleaned({ id: ANA.id, name: ANA.name }, `${P8}_${day}`, new Date(`${day}T18:00:00.000Z`));
  if (r.kind !== 'marked') console.log(`  mark ${day}: ${r.kind}`);
}
// The office removes the cleaning of the 12th; a finished statement prints the cleaning of the 10th.
const c12 = doc('cleaning_jobs', `${P8}_2026-10-12`).assignments[ANA.id].cleaningId;
const removed = await cl.removeCleaning(ADMIN, c12, doc('cleanings', c12).history.length, null);
const c10 = doc('cleaning_jobs', `${P8}_2026-10-10`).assignments[ANA.id].cleaningId;
seed('monthly_reports', 'TESTREPORTround1aaa1', { propertyId: P8, month: '2026-10', entryIds: [c10], costs: [], adjustments: [] });
const props = new Map([[P8, { name: 'Test Eight', city: 'Toronto', checkOut: '11:00', checkIn: '16:00' }]]);
const listed = await readsOf(sj.cleanerJobs)(ANA.id, props, TODAY, '2026-10-14');
console.log(`  removeCleaning on the 12th: ${removed.kind}`);
for (const j of listed.result) console.log(`  ${j.checkout}: marked ${j.markedAt !== null} · canUndo ${j.canUndo} · refusal ${j.markRefusal ?? '-'}`);
console.log(`  reads: ${listed.reads} (${byText(listed.by)})`);
const byDay = new Map(listed.result.map((j) => [j.checkout, j]));
check(byDay.get('2026-10-10').canUndo === false && byDay.get('2026-10-12').canUndo === false && byDay.get('2026-10-12').markRefusal === 'removed' && byDay.get('2026-10-14').canUndo === false && byDay.get('2026-10-16').canUndo === true && byDay.get('2026-10-18').markedAt === null, 'Undo: not on a printed cleaning, a removed one, or one on or before the last payment (Oct 14); on the 16th, yes; the 18th unmarked');
check(!('cleanings' in listed.by), 'no cleaning is read: a mark not removed by the office is a logged cleaning, from the job');
const reread = await readsOf(sj.cleanerJobsRead)(ANA.id, TODAY);
console.log(`  read again on its own (after a refresh): ${reread.result.length} jobs · reads ${reread.reads} (${byText(reread.by)})`);
check(reread.by.properties === 2 && reread.by.property_cleaner_names === 2 && !('cleanings' in reread.by), 'read again on its own: only the two properties its jobs name, never every property, and no cleaning');
check(homeJobs(listed.result, TODAY).map((j) => j.checkout).join() === '2026-10-18,2026-10-20', 'its home: the job still to mark (the 18th), and tomorrow\'s (Ana is the regular cleaner on P1, section 2)');

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
