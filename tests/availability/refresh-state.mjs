// The calendar refresh's state (Kian's ruling of 2026-10-14, night): no scheduled job; the day's first admin page or
// cleaner app refreshes in the background, Refresh calendars on demand, and only one refresh runs at a time. The pure
// decisions only (app/lib/availability/run-state.ts); the live check covers the transactions.
// Made-up states; nothing is read from or written to Firestore.
//   node --import ./tests/tools/ts-hook.mjs tests/availability/refresh-state.mjs
import { fileURLToPath } from 'node:url';

const ROOT = process.env.NUBNB_ROOT || fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const rs = await import(`${ROOT}/app/lib/availability/run-state.ts`);

const at = (iso) => new Date(iso);
const show = (d) => (d.kind === 'claimed' ? `claimed ${d.run.source}/${d.run.trigger}, lease until ${d.run.leaseUntil}${d.next.lastFailed ? ` · lastFailed ${d.next.lastFailed.reason}` : ''}` : d.kind === 'running' ? `running (${d.run.id}, since ${d.run.startedAt})` : d.kind === 'done-today' ? `done today (finished ${d.finishedAt})` : `paused until ${d.until}`);
const decide = (label, state, source, trigger, now) => console.log(`  ${label}: ${show(rs.decideClaim(state, source, trigger, at(now), 'RUN-NEW'))}`);

// Toronto is UTC-4 in October: its 15 October starts at 2026-10-15T04:00Z.
const NOW = '2026-10-15T13:00:00.000Z'; // 09:00 Toronto, 15 October
const done = (day, startedAt, finishedAt) => ({ ...rs.NO_REFRESH_YET, lastDone: { id: 'RUN-DONE', source: 'daily', trigger: 'admin-page', day, startedAt, finishedAt } });
const lease = (startedAt, leaseUntil, source = 'daily') => ({ id: 'RUN-HELD', source, trigger: 'cleaner-app', startedAt, leaseUntil });

console.log('═══ 1. The day\'s first visit ═══');
decide('nothing stored yet, an admin page', rs.NO_REFRESH_YET, 'daily', 'admin-page', NOW);
decide('nothing stored yet, the cleaner app', rs.NO_REFRESH_YET, 'daily', 'cleaner-app', NOW);
decide('done yesterday (14 October)', done('2026-10-14', '2026-10-14T12:00:00.000Z', '2026-10-14T12:00:04.000Z'), 'daily', 'admin-page', NOW);
decide('done today', done('2026-10-15', '2026-10-15T12:00:00.000Z', '2026-10-15T12:00:04.000Z'), 'daily', 'cleaner-app', NOW);
decide('done "14 October" at 23:59 Toronto (03:59Z)', done('2026-10-14', '2026-10-15T01:00:00.000Z', '2026-10-15T01:00:04.000Z'), 'daily', 'admin-page', '2026-10-15T03:59:00.000Z');
decide('the same, at 00:00 Toronto (04:00Z)', done('2026-10-14', '2026-10-15T01:00:00.000Z', '2026-10-15T01:00:04.000Z'), 'daily', 'admin-page', '2026-10-15T04:00:00.000Z');

console.log('\n═══ 2. One at a time ═══');
const held = { ...rs.NO_REFRESH_YET, running: lease('2026-10-15T12:58:00.000Z', '2026-10-15T13:04:00.000Z') };
decide('a run holds the lease: the first visit', held, 'daily', 'admin-page', NOW);
decide('a run holds the lease: Refresh calendars', held, 'manual', 'refresh-button', NOW);
const first = rs.decideClaim(rs.NO_REFRESH_YET, 'daily', 'admin-page', at(NOW), 'RUN-A');
console.log(`  two triggers at once, as the transactions order them: the first ${first.kind}; the second, on the state it wrote, ${show(rs.decideClaim(first.next, 'daily', 'cleaner-app', at(NOW), 'RUN-B'))}`);
console.log(`  the lease: ${rs.LEASE_MS / 60_000} minutes, longer than the 300 s a route allows a run`);

console.log('\n═══ 3. A run that did not finish ═══');
const stopped = { ...rs.NO_REFRESH_YET, running: lease('2026-10-15T12:50:00.000Z', '2026-10-15T12:56:00.000Z') };
decide('its lease ran out 4 min ago (started 12:50Z): the first visit', stopped, 'daily', 'admin-page', NOW);
decide('the same at 13:06Z, 16 min after it started', stopped, 'daily', 'admin-page', '2026-10-15T13:06:00.000Z');
decide('the same: Refresh calendars waits for no pause', stopped, 'manual', 'refresh-button', NOW);
const failed = { ...rs.NO_REFRESH_YET, lastFailed: { id: 'RUN-F', source: 'daily', trigger: 'admin-page', startedAt: '2026-10-15T12:50:00.000Z', at: '2026-10-15T12:50:03.000Z', reason: 'the refresh failed: grpc code 14' } };
decide('it threw at 12:50Z: the first visit at 13:00Z', failed, 'daily', 'cleaner-app', NOW);
decide('the first visit at 13:05:01Z', failed, 'daily', 'cleaner-app', '2026-10-15T13:05:01.000Z');
decide('Refresh calendars', failed, 'manual', 'refresh-button', NOW);
decide('done today, then Refresh calendars', done('2026-10-15', '2026-10-15T12:00:00.000Z', '2026-10-15T12:00:04.000Z'), 'manual', 'refresh-button', NOW);

console.log('\n═══ 4. How a run ends ═══');
const mine = first.run;
const ended = (label, state, end) => {
  const next = rs.afterRun(state, mine, end, at('2026-10-15T13:00:05.000Z'));
  console.log(`  ${label}: running ${next.running ? next.running.id : 'none'} · lastDone ${next.lastDone ? `${next.lastDone.id} ${next.lastDone.day} ${next.lastDone.source}/${next.lastDone.trigger}` : 'none'} · lastFailed ${next.lastFailed ? `${next.lastFailed.id}: ${next.lastFailed.reason}` : 'none'} · reads back ${rs.readRefreshState(next) !== null}`);
};
ended('wrote the copy and synced the jobs', first.next, { ok: true, day: '2026-10-15' });
ended('the job sync stopped', first.next, { ok: false, reason: 'the job sync stopped: grpc code 10' });
ended('ended after its lease ran out and another run took it', { ...first.next, running: lease('2026-10-15T13:07:00.000Z', '2026-10-15T13:13:00.000Z') }, { ok: true, day: '2026-10-15' });
ended('ended after a later run was already done', { ...first.next, lastDone: { id: 'RUN-LATER', source: 'manual', trigger: 'refresh-button', day: '2026-10-15', startedAt: '2026-10-15T13:00:01.000Z', finishedAt: '2026-10-15T13:00:04.000Z' } }, { ok: true, day: '2026-10-15' });

console.log('\n═══ 5. Read strictly ═══');
const good = first.next;
const bad = [
  ['no schemaVersion', { ...good, schemaVersion: undefined }],
  ['a lease with no end', { ...good, running: { ...good.running, leaseUntil: undefined } }],
  ['a source not known', { ...good, running: { ...good.running, source: 'schedule' } }],
  ['a day not yyyy-mm-dd', { ...good, lastDone: { id: 'X', source: 'daily', trigger: 'admin-page', day: '15/10/2026', startedAt: NOW, finishedAt: NOW } }],
  ['a failure with no reason', { ...good, lastFailed: { id: 'X', source: 'daily', trigger: 'admin-page', startedAt: NOW, at: NOW, reason: '' } }],
];
console.log(`  as written: ${rs.readRefreshState(good) !== null} · nothing stored reads as: ${JSON.stringify(rs.NO_REFRESH_YET)}`);
for (const [label, fields] of bad) console.log(`  refused — ${label}: ${rs.readRefreshState(fields) === null}`);
