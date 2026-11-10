// "Not tracked by Nubnb" (Kian's ruling of 2026-11-10): one switch per unit. The calendar sync makes no job for a unit
// that is not tracked; turning tracking off removes its open, unmarked jobs with the deleted-job marker the sync
// honours, and leaves counted cleanings alone; turning it on resumes from that day (future checkouts only); such a unit
// is listed nowhere as a cleaning warning, is out of the cleaners' apps, is refused by Add a job and Finish, and raises
// no income gap. The server functions run on an in-memory Firestore (tests/tools/memory-firestore.cjs): nothing is
// read from or written to Firestore or Storage, and every connection is refused. Made-up data only: properties
// "TESTPROP…", cleaners "Test …", amounts made up (written with separators, never a real rate).
//   node --import ./tests/tools/ts-hook.mjs tests/schedule/tracking.mjs
import { createRequire } from 'node:module';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.NUBNB_ROOT || fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
createRequire(`${ROOT}/package.json`)(`${ROOT}/tests/tools/memory-firestore.cjs`);
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.FIREBASE_SERVICE_ACCOUNT_KEY = JSON.stringify({ type: 'service_account', project_id: 'memory-test', private_key_id: 'memory-test', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), client_email: 'memory-test@memory-test.iam.gserviceaccount.com', client_id: '0', token_uri: 'https://oauth2.invalid/token' });
process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = 'memory-test.appspot.com';
process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = 'memory-test';

const tr = await import(`${ROOT}/app/lib/schedule/tracking.ts`);
const jm = await import(`${ROOT}/app/lib/schedule/model.ts`);
const sync = await import(`${ROOT}/app/lib/schedule/sync.ts`);
const store = await import(`${ROOT}/app/lib/schedule/store.ts`);
const home = await import(`${ROOT}/app/lib/home/next-step.ts`);
const month = await import(`${ROOT}/app/lib/income/month.ts`);
const st = await import(`${ROOT}/app/lib/reports/statement.ts`);
const rm = await import(`${ROOT}/app/lib/reports/model.ts`);
const { addDays } = await import(`${ROOT}/app/lib/availability/days.ts`);
const sp = await import(`${ROOT}/app/lib/firebase/server-cleaning-prices.ts`);
const sj = await import(`${ROOT}/app/lib/firebase/server-cleaning-jobs.ts`);
const stk = await import(`${ROOT}/app/lib/firebase/server-tracking.ts`);
const sm = await import(`${ROOT}/app/lib/firebase/server-management.ts`);
const ps = await import(`${ROOT}/app/lib/firebase/server-property-status.ts`);
const cs = await import(`${ROOT}/app/lib/firebase/server-cleaner-start.ts`);
const sr = await import(`${ROOT}/app/lib/firebase/server-reports.ts`);
const { getAdminDb } = await import(`${ROOT}/app/lib/firebase/admin.ts`);
const seed = globalThis.__memSeed;
const doc = globalThis.__memDoc;

let failures = 0;
const check = (ok, label) => {
  if (!ok) failures += 1;
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${label}`);
};
const $ = (cents) => (cents === null || cents === undefined ? 'none' : `$${(cents / 100).toFixed(2)}`);

const ADMIN = { role: 'admin', id: 'TESTADMINtrackingaa1', name: 'Test admin' };
const T = 'TESTPROPtrackingaa01'; // tracked at the start, switched off, then on again
const U = 'TESTPROPtrackingaa02'; // not tracked from the start
const ANA = { id: 'TESTCLEANERtrackinga', name: 'Test Ana' };
const PRICES = { shortTermCents: 6_700, midTermCents: 7_700, longTermCents: 10_700 };
const TODAY = '2028-11-20';
const D = (n) => addDays(TODAY, n);
const RUN = `${TODAY}T15:00:00.000Z`;
const at = (day) => new Date(`${day}T18:00:00.000Z`);
const LINK = (id) => `https://www.airbnb.ca/calendar/ical/${id}.ics?s=made-up`;
const { calendarKeyOf } = store;
const property = (id, name) => seed('properties', id, { name, icalUrl: LINK(id), details: { checkOut: '11:00', checkIn: '16:00' }, addressDetails: { city: 'Toronto' } });
property(T, 'Test Tracked');
property(U, 'Test Untracked');
seed('cleaners', ANA.id, { schemaVersion: 2, name: ANA.name, role: 'cleaner', status: 'active', sessionEpoch: 1, history: [] });
seed('property_management', U, { schemaVersion: rm.PROPERTY_MANAGEMENT_SCHEMA_VERSION, propertyId: U, reportFor: null, owners: [], statementsFrom: '2026-11', statementsUntil: null, defaultFeeRateBasisPoints: null, defaultFee: null, excludedFromReporting: true, setAt: RUN });
await sp.setCleaningPrices(ADMIN, T, PRICES);
await sp.setCleaningPrices(ADMIN, U, PRICES);

const reserved = (uid, start, end) => ({ uid, kind: 'reserved', start, end });
const feed = (id, name, events) => ({ name, icalUrl: LINK(id), status: 'ok', fetchedAt: RUN, bytes: 1, eventCount: events.length, events });
const copy = (properties) => ({ version: 1, refreshedAt: RUN, today: TODAY, horizonEnd: D(365), run: { source: 'manual', startedAt: RUN, finishedAt: RUN, durationMs: 0, fetched: Object.keys(properties).length, failed: [], pagesChecked: 0 }, properties });
const stays = { [T]: feed(T, 'Test Tracked', [reserved('s0', D(-2), TODAY), reserved('s1', D(-1), D(1)), reserved('s2', D(1), D(2))]), [U]: feed(U, 'Test Untracked', [reserved('u0', D(-2), TODAY), reserved('u1', TODAY, D(1))]) };
const keysOf = (c) => new Map(Object.entries(c.properties).map(([id, e]) => [id, calendarKeyOf(e.icalUrl)]));
/** A calendar job in the written shape, `cleaners` on it, with a status. */
const seedJob = (pid, uid, start, checkout, cleaners, status = 'open') => {
  const id = jm.jobIdOf(pid, checkout);
  const made = `${start}T12:00:00.000Z`;
  seed('cleaning_jobs', id, { schemaVersion: jm.JOB_SCHEMA_VERSION, propertyId: pid, propertyNameAtCreation: 'Test', checkout, reservation: { uid, start }, calendarKey: calendarKeyOf(LINK(pid)), origin: 'calendar', tier: null, amountCents: null, label: null, nextCheckIn: null, status, change: status === 'booking-changed' ? { kind: 'gone', at: made, movedTo: null } : null, cleanerIds: cleaners.map((m) => m.id), assignments: Object.fromEntries(cleaners.map((m) => [m.id, jm.newAssignment(m.name, made, ADMIN)])), createdAt: made, history: [jm.jobEvent(made, 'created', jm.CALENDAR_ACTOR, { after: { start, end: checkout } }), ...cleaners.map((m) => jm.jobEvent(made, 'assigned', ADMIN, { cleanerId: m.id, cleanerName: m.name }))] });
  return id;
};
const stable = (v) => JSON.stringify(v, Object.keys(v).sort());
/** A job ID for the recording: the property as a letter, an added job's random suffix masked. */
const idOf = (id) => id.replace(T, 'T').replace(U, 'U').replace(/_[a-z0-9]{6}$/, '_<suffix>');
const jobLine = (job) => `${idOf(job.id)} ${job.status}${job.origin === 'admin' ? ' (added)' : ''} · ${job.cleanerIds.length === 0 ? 'nobody' : job.cleanerIds.map((cid) => `${job.assignments[cid].nameAtAssignment}${job.assignments[cid].cleaningId ? ' ✓' : ''}`).join('+')}`;

// ═══ 1. The words ═══
console.log('═══ 1. The words, the same everywhere ═══');
console.log(`  standing label: "${st.STANDING_LABELS.excluded}" · banner: "${tr.NOT_TRACKED_BANNER}" · Add a job: "${tr.ADD_JOB_NOT_TRACKED}" · Finish: "${tr.FINISH_NOT_TRACKED}"`);
check(st.STANDING_LABELS.excluded === 'Not tracked by Nubnb' && tr.NOT_TRACKED === 'Not tracked by Nubnb', 'the mark reads "Not tracked by Nubnb" wherever a standing is shown');
console.log(`  in a menu line (the property page's month list): "${st.standingInWords('excluded')}" · "${st.standingInWords('open')}" · "${st.standingInWords('notExpected')}"`);
check(st.standingInWords('excluded') === 'not tracked by Nubnb' && st.standingInWords('open') === 'open, not yet due', 'inside a line only the first letter is lowered: "Nubnb" keeps its capital');
check(tr.isTracked(null) && tr.isTracked({ excludedFromReporting: undefined }) && !tr.isTracked({ excludedFromReporting: true }), 'tracked: no record, or one without the mark; the stored field is unchanged (no backfill)');
check([...tr.untrackedIds([{ propertyId: T }, { propertyId: U, excludedFromReporting: true }])].join() === U, 'untrackedIds reads the records');

// ═══ 2. The sync makes no job for a unit that is not tracked ═══
console.log('\n═══ 2. The calendar sync makes no job for a unit that is not tracked (ruling 2) ═══');
const planned = sync.planCreates({ snapshot: copy(stays), existing: new Set(), keys: keysOf(copy(stays)), nowIso: RUN, untracked: new Set([U]) });
const plannedAll = sync.planCreates({ snapshot: copy(stays), existing: new Set(), keys: keysOf(copy(stays)), nowIso: RUN });
console.log(`  planned with U not tracked: ${planned.map((p) => p.id.replace(T, 'T').replace(U, 'U')).join(', ')} · without the set: ${plannedAll.length} jobs`);
check(planned.length === 3 && planned.every((p) => p.job.propertyId === T) && plannedAll.length === 5, 'U gets no job for its stays; T gets its three (today and two ahead)');
const past = seedJob(T, 'sp', D(-5), D(-3), [ANA]); // Ana on it, never marked: "Not marked"
const changed = seedJob(T, 'sc', D(1), D(3), [], 'booking-changed'); // history, shown nowhere
const run1 = await store.syncJobs(getAdminDb(), copy(stays));
console.log(`  run 1 on the memory store: created ${run1.created}, changed ${run1.changed}, failed ${run1.failed} · U's jobs: ${[jm.jobIdOf(U, TODAY), jm.jobIdOf(U, D(1))].filter((id) => doc('cleaning_jobs', id)).length}`);
check(run1.created === 3 && run1.failed === null && !doc('cleaning_jobs', jm.jobIdOf(U, TODAY)) && !doc('cleaning_jobs', jm.jobIdOf(U, D(1))), 'the real sync reads the marks (one query) and makes T\'s jobs only');
const todayJob = jm.jobIdOf(T, TODAY);
const assigned = await sj.setAssignees(ADMIN, todayJob, [ANA.id], 1, undefined, at(TODAY));
const recorded = await sj.recordCleaned(ADMIN, todayJob, [ANA.id], assigned.job.history.length, at(TODAY));
const cleaningId = recorded.kind === 'recorded' ? recorded.cleanings[0].cleaningId : null;
const cleaningBefore = cleaningId ? stable(doc('cleanings', cleaningId)) : null;
const added = await sj.addJob(ADMIN, { propertyId: T, checkout: D(1), cleanerId: null, tier: 'short', amountCents: null, label: 'Deep clean' }, at(TODAY));
console.log(`  today's job: Ana on it (${assigned.kind}), recorded cleaned by the office (${recorded.kind}, ${$(doc('cleanings', cleaningId)?.amountCents)}) · a job added by hand for ${D(1)}: ${added.kind}`);
const before = [past, todayJob, jm.jobIdOf(T, D(1)), jm.jobIdOf(T, D(2)), added.job?.id, changed].map((id) => ({ id, ...doc('cleaning_jobs', id) }));
for (const job of before) console.log(`    ${jobLine(job)}`);
check(recorded.kind === 'recorded' && cleaningId !== null && added.kind === 'added', 'T holds a past unmarked job, a counted cleaning, two open jobs ahead, an added job and a booking-changed job');

// ═══ 3. Turning tracking off: the plan, then the switch ═══
console.log('\n═══ 3. Turning tracking off removes the open, unmarked jobs with the marker; counted cleanings stay (ruling 2) ═══');
const plan = tr.planTrackingOff(before, ADMIN, RUN);
console.log(`  plan: remove ${plan.remove.map((j) => idOf(j.id)).join(', ')} · markers ${plan.markers.map((m) => `${idOf(m.id)} (${m.reason})`).join(', ')} · kept ${plan.kept.map((j) => idOf(j.id)).join(', ')}`);
check(plan.remove.length === 4 && plan.remove.every((j) => j.status === 'open' && !tr.hasMark(j)), 'open and unmarked goes: the past job, the two ahead, the added one');
const fieldsOf = (marker) => Object.fromEntries(Object.entries(marker).filter(([k]) => k !== 'id'));
check(plan.markers.length === 3 && plan.markers.every((m) => m.reason === tr.TRACKING_OFF_REASON && jm.readDeletedJob(m.id, fieldsOf(m)) !== null), 'each calendar job leaves the sync\'s own marker, reason tracking-off, read back strictly; the added job leaves none');
check(plan.kept.length === 2 && plan.kept.some((j) => j.id === todayJob) && plan.kept.some((j) => j.id === changed), 'the marked job and the booking-changed job stay');
const off = await stk.setTracking(ADMIN, T, false, at(TODAY));
console.log(`  setTracking off: ${off.kind}, changed ${off.changed} · jobs removed ${off.change?.jobsRemoved}, markers written ${off.change?.markersWritten}, cleared ${off.change?.markersCleared} · record flag ${doc('property_management', T)?.excludedFromReporting}`);
check(off.kind === 'set' && off.changed && off.change.jobsRemoved === 4 && off.change.markersWritten === 3 && doc('property_management', T)?.excludedFromReporting === true, 'the switch writes the mark and does the plan in one transaction');
check(!doc('cleaning_jobs', past) && !doc('cleaning_jobs', jm.jobIdOf(T, D(1))) && !doc('cleaning_jobs', jm.jobIdOf(T, D(2))) && !doc('cleaning_jobs', added.job.id), 'the four jobs are gone');
check(doc('deleted_cleaning_jobs', past)?.reason === 'tracking-off' && doc('deleted_cleaning_jobs', jm.jobIdOf(T, D(1)))?.reason === 'tracking-off' && !doc('deleted_cleaning_jobs', added.job.id), 'their markers are there; none for the added job');
check(stable(doc('cleanings', cleaningId)) === cleaningBefore && doc('cleaning_jobs', todayJob)?.assignments[ANA.id].cleaningId === cleaningId && doc('cleaning_jobs', changed)?.status === 'booking-changed', 'the counted cleaning and its job are untouched, byte for byte; the booking-changed job stays');
const again = await stk.setTracking(ADMIN, T, false, at(TODAY));
check(again.kind === 'set' && !again.changed && again.change === null, 'the same value again changes nothing');
const wrongId = await stk.setTracking(ADMIN, 'TESTPROPnosuchaaaaaa', false, at(TODAY));
check(wrongId.kind === 'no-such-property', 'a property that does not exist is refused');

// ═══ 4. Listed nowhere as a warning ═══
console.log('\n═══ 4. No cleaning warning or count anywhere; not in the apps (ruling 2) ═══');
const schedule = await sj.readSchedule(D(-7), D(3));
const tJobs = schedule.jobs.filter((j) => j.propertyId === T);
console.log(`  the Schedule lists for T: ${tJobs.map((j) => `${j.checkout} ${j.assignees.map((a) => `${a.name}${a.cleaningId ? ' ✓' : ''}`).join('+') || 'nobody'}`).join(' | ') || 'nothing'} · untracked: ${schedule.untracked.map((id) => id.replace(T, 'T').replace(U, 'U')).join(', ')}`);
check(tJobs.length === 1 && tJobs[0].id === todayJob && schedule.untracked.join() === [T, U].sort().join(), 'the Schedule shows only the marked job of a unit that is not tracked (a counted cleaning\'s record), and names the units');
const status = await ps.readPropertyStatus(at(TODAY));
console.log(`  the home's read: jobs ${status.cleaning.jobs.length}, extras ${status.cleaning.extras.length}, untracked ${status.untracked.map((id) => id.replace(T, 'T').replace(U, 'U')).join(', ')} · Turnovers tile: ${JSON.stringify(home.turnoverFigures(status.cleaning.jobs, TODAY))}`);
check(status.cleaning.jobs.every((j) => j.propertyId !== T && j.propertyId !== U) && status.untracked.join() === [T, U].sort().join() && home.turnoverFigures(status.cleaning.jobs, TODAY).count === 0, 'no job of a unit that is not tracked reaches the home: no chip, Next step or tile counts it');
const start = await cs.readCleanerStart(ANA.id, 'cleaner');
console.log(`  Ana's app: units ${start.properties.map((p) => p.name).join(', ') || 'none'} · recent ${start.recentPropertyIds.length} · jobs ${start.jobs.map((j) => `${j.checkout}${j.markedAt ? ' ✓' : ''}`).join(', ') || 'none'}`);
check(start.properties.length === 0 && start.jobs.length === 1 && start.jobs[0].id === todayJob, 'neither unit is in her unit list; of T\'s jobs she sees only the one she marked');
const reread = await sj.cleanerJobsRead(ANA.id, TODAY);
check(reread.length === 1 && reread[0].id === todayJob, 'the app\'s re-read after a refresh says the same');
const run2 = await store.syncJobs(getAdminDb(), copy(stays));
console.log(`  run 2 (T not tracked, U not tracked): created ${run2.created}, changed ${run2.changed}`);
check(run2.created === 0 && run2.changed === 0, 'the next calendar read makes no job for either unit and changes none of theirs');
const refused = await sj.addJob(ADMIN, { propertyId: T, checkout: D(1), cleanerId: null, tier: 'short', amountCents: null, label: null }, at(TODAY));
console.log(`  Add a job on T: ${refused.kind} — ${sj.ADD_JOB_REFUSALS['not-tracked'].status} ${sj.ADD_JOB_REFUSALS['not-tracked'].code} "${sj.ADD_JOB_REFUSALS['not-tracked'].message}"`);
check(refused.kind === 'not-tracked' && sj.ADD_JOB_REFUSALS['not-tracked'].message === 'This unit isn’t tracked. Turn tracking on first.', 'Add a job refuses it in Kian\'s words');
const finish = await sr.finishStatement(ADMIN, { propertyId: T, month: '2028-11', draftRevision: 1, entries: [], earlier: [], adjustments: [] });
console.log(`  Finish on T: ${finish.kind} — ${sr.FINISH_REFUSALS['not-tracked'].status} ${sr.FINISH_REFUSALS['not-tracked'].code} "${sr.FINISH_REFUSALS['not-tracked'].message}"`);
check(finish.kind === 'not-tracked', 'Finish refuses it: it owes no statement');

// ═══ 5. Turning tracking on resumes from that day ═══
console.log('\n═══ 5. Turning tracking on resumes from that day: future jobs return, past ones do not (ruling 4) ═══');
const on = await stk.setTracking(ADMIN, T, true, at(TODAY));
console.log(`  setTracking on: ${on.kind}, changed ${on.changed} · markers cleared ${on.change?.markersCleared} · record flag ${doc('property_management', T)?.excludedFromReporting ?? 'absent'} · markers left: ${[past, jm.jobIdOf(T, D(1)), jm.jobIdOf(T, D(2))].filter((id) => doc('deleted_cleaning_jobs', id)).map((id) => id.replace(T, 'T')).join(', ') || 'none'}`);
check(on.kind === 'set' && on.changed && on.change.markersCleared === 2 && doc('property_management', T)?.excludedFromReporting === undefined, 'the markers for today and later are cleared; the mark is gone from the record');
check(doc('deleted_cleaning_jobs', past)?.reason === 'tracking-off', 'the past job\'s marker stays: nothing is backfilled');
const run3 = await store.syncJobs(getAdminDb(), copy(stays));
const after = [past, todayJob, jm.jobIdOf(T, D(1)), jm.jobIdOf(T, D(2)), added.job.id, changed].map((id) => ({ id, ...(doc('cleaning_jobs', id) ?? { missing: true }) }));
console.log(`  run 3: created ${run3.created}, changed ${run3.changed}`);
for (const job of after) console.log(`    ${job.missing ? `${idOf(job.id)} — not there` : jobLine(job)}`);
check(run3.created === 2 && doc('cleaning_jobs', jm.jobIdOf(T, D(1))) && doc('cleaning_jobs', jm.jobIdOf(T, D(2))) && !doc('cleaning_jobs', past) && !doc('cleaning_jobs', added.job.id), 'the next read makes the two future jobs again; the past one and the added one do not come back');
check(doc('cleaning_jobs', todayJob)?.assignments[ANA.id].cleaningId === cleaningId && stable(doc('cleanings', cleaningId)) === cleaningBefore, 'the counted cleaning is still as it was');

// ═══ 6. The form's Save flips the same mark, with the same work ═══
console.log('\n═══ 6. The edit page\'s switch (the form\'s Save) does the same, through the management record ═══');
const saveOff = await sm.setManagement(T, { excludedFromReporting: true }, ADMIN, at(TODAY));
console.log(`  save with the switch off: ${saveOff.kind} · tracking ${JSON.stringify(saveOff.tracking)}`);
check(saveOff.kind === 'set' && saveOff.tracking?.tracked === false && saveOff.tracking.jobsRemoved === 2 && saveOff.tracking.markersWritten === 2 && !doc('cleaning_jobs', jm.jobIdOf(T, D(1))), 'the save removes the two open jobs and leaves their markers');
const saveSame = await sm.setManagement(T, { excludedFromReporting: true }, ADMIN, at(TODAY));
check(saveSame.kind === 'set' && saveSame.tracking === null, 'a save that does not flip the mark does nothing to the jobs');
const cleared = await sm.setManagement(T, null, ADMIN, at(TODAY));
console.log(`  the record cleared: ${cleared.kind} · tracking ${JSON.stringify(cleared.tracking)} · record ${doc('property_management', T) ? 'there' : 'gone'}`);
check(cleared.kind === 'cleared' && cleared.tracking?.tracked === true && cleared.tracking.markersCleared === 2 && !doc('property_management', T), 'clearing the record of a unit that was not tracked turns its tracking on');
const uOn = await sm.setManagement(U, { excludedFromReporting: false }, ADMIN, at(TODAY));
const run4 = await store.syncJobs(getAdminDb(), copy(stays));
console.log(`  U saved as tracked: ${uOn.kind}, tracking ${JSON.stringify(uOn.tracking)} · run 4 created ${run4.created} (${[jm.jobIdOf(U, TODAY), jm.jobIdOf(U, D(1))].filter((id) => doc('cleaning_jobs', id)).length} of them U's)`);
check(uOn.kind === 'set' && uOn.tracking?.tracked === true && run4.created === 4 && doc('cleaning_jobs', jm.jobIdOf(U, TODAY)) && doc('cleaning_jobs', jm.jobIdOf(U, D(1))), 'once tracked, U gets its jobs from the next read, and T its two again');

// ═══ 7. An admin's own delete marker is never cleared by the switch ═══
console.log('\n═══ 7. A marker an admin\'s own delete wrote is never cleared by the switch ═══');
const d2 = jm.jobIdOf(T, D(2));
const deleted = await sj.deleteJob(ADMIN, d2, doc('cleaning_jobs', d2).history.length, at(TODAY));
const offAgain = await stk.setTracking(ADMIN, T, false, at(TODAY));
const onAgain = await stk.setTracking(ADMIN, T, true, at(TODAY));
console.log(`  deleted ${D(2)}'s job by hand: ${deleted.kind}, marker ${deleted.marker} (reason ${doc('deleted_cleaning_jobs', d2)?.reason ?? 'none'}) · off: removed ${offAgain.change?.jobsRemoved}, markers ${offAgain.change?.markersWritten} · on: cleared ${onAgain.change?.markersCleared} · the admin's marker ${doc('deleted_cleaning_jobs', d2) ? 'stays' : 'GONE'}`);
check(deleted.kind === 'deleted' && doc('deleted_cleaning_jobs', d2) && doc('deleted_cleaning_jobs', d2).reason === undefined && offAgain.change.jobsRemoved === 1 && onAgain.change.markersCleared === 1, 'the switch clears only the markers it wrote (reason tracking-off): the admin\'s delete stands');
check(tr.planTrackingOn([{ id: 'a', checkout: TODAY, reason: 'tracking-off' }, { id: 'b', checkout: D(-1), reason: 'tracking-off' }, { id: 'c', checkout: D(5) }], TODAY).clear.join() === 'a', 'planTrackingOn: today and later, tracking-off only');

// ═══ 8. The Income page raises no gap for a unit that is not tracked ═══
console.log('\n═══ 8. No income gap for a unit that is not tracked (ruling 2) ═══');
// Four made-up properties: T and U are titled (a link each), V and W untitled; U and W are not tracked.
const V = 'TESTPROPtrackingaa03';
const W = 'TESTPROPtrackingaa04';
const inputs = {
  uploads: [{ platform: 'airbnb', titles: [] }],
  lines: [],
  links: [{ id: 'l0', platform: 'airbnb', title: 'Tracked Title', propertyId: T, linkedAt: '2026-10-01T00:00:00.000Z', active: true }, { id: 'l1', platform: 'airbnb', title: 'Untracked Title', propertyId: U, linkedAt: '2026-10-01T00:00:00.000Z', active: true }],
  lastSeen: {},
  properties: [{ id: T, name: 'Tracked Title', internalName: '1 Test St' }, { id: U, name: 'Untracked Title', internalName: '2 Test St' }, { id: V, name: 'Tracked Untitled', internalName: '3 Test St' }, { id: W, name: 'Untracked Untitled', internalName: '4 Test St' }],
  statements: [],
  calendar: { checkIns: [{ propertyId: T, days: ['2028-11-05'] }, { propertyId: U, days: ['2028-11-06'] }, { propertyId: V, days: ['2028-11-07'] }, { propertyId: W, days: ['2028-11-08'] }], stays: [{ propertyId: T, count: 1 }, { propertyId: U, count: 1 }, { propertyId: V, count: 1 }, { propertyId: W, count: 1 }] },
  month: '2028-11',
  today: '2028-11-30',
};
const withSet = month.monthView({ ...inputs, untracked: [U, W] });
const without = month.monthView(inputs);
const names = (rows) => rows.map((g) => g.name).join(', ') || 'none';
console.log(`  gaps with U and W not tracked: check-ins ${names(withSet.gaps.checkIns)} · untitled ${names(withSet.gaps.untitled)} · missing titles ${withSet.gaps.missing.map((m) => m.name).join(', ') || 'none'}`);
console.log(`  without the set: check-ins ${names(without.gaps.checkIns)} · untitled ${names(without.gaps.untitled)} · missing titles ${without.gaps.missing.map((m) => m.name).join(', ') || 'none'}`);
check(withSet.gaps.checkIns.map((g) => g.propertyId).join() === T && withSet.gaps.untitled.map((g) => g.propertyId).join() === V && withSet.gaps.missing.map((m) => m.link.propertyId).join() === T, 'a unit not tracked raises no check-in gap, no untitled gap and no missing title; the tracked ones still do');
check(without.gaps.checkIns.length === 2 && without.gaps.untitled.length === 2 && without.gaps.missing.length === 2, 'without the set, every gap is raised as before');

console.log(`\n${failures === 0 ? 'all ok' : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
