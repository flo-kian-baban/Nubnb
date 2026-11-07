// The daily wrong-try budget across all connections (Kian's rulings of 2026-11-06, the security round, item 2):
// fifteen wrong codes at the cleaner door, ten wrong PINs at the admin door, in a Toronto day from any connections; then
// every connection gets one wrong try before being locked for the rest of the day; right codes and PINs unaffected; one
// email at each threshold; the per-connection rules as they are; Lift. The rules (app/lib/admins/budget.ts) and the two
// doors' server functions on an in-memory Firestore (tests/tools/memory-firestore.cjs): nothing is read from or written
// to Firestore, and every outgoing connection is refused first, so the budget's email is recorded as not sent. Made-up
// accounts, with a code and a PIN drawn at random here and never printed; made-up addresses (TEST-NET).
//   node --import ./tests/tools/ts-hook.mjs tests/admins/budget.mjs
import { createRequire } from 'node:module';
import { generateKeyPairSync, randomBytes, randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.NUBNB_ROOT || fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
createRequire(`${ROOT}/package.json`)(`${ROOT}/tests/tools/memory-firestore.cjs`);
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.FIREBASE_SERVICE_ACCOUNT_KEY = JSON.stringify({ type: 'service_account', project_id: 'memory-test', private_key_id: 'memory-test', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), client_email: 'memory-test@memory-test.iam.gserviceaccount.com', client_id: '0', token_uri: 'https://oauth2.invalid/token' });
process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = 'memory-test.appspot.com';
process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = 'memory-test';
const PIN_KEY = randomBytes(32);
process.env.ADMIN_PIN_KEY = PIN_KEY.toString('base64url');
delete process.env.GMAIL_USER;
delete process.env.GMAIL_APP_PASSWORD;

const b = await import(`${ROOT}/app/lib/admins/budget.ts`);
const m = await import(`${ROOT}/app/lib/admins/model.ts`);
const { connectionKey } = await import(`${ROOT}/app/lib/admins/pin.ts`);
const { cleanerConnectionKey } = await import(`${ROOT}/app/lib/cleaners/lock.ts`);
const { isTooEasyCode, CLEANER_SCHEMA_VERSION, CLEANER_CODE_SCHEMA_VERSION } = await import(`${ROOT}/app/lib/cleaners/model.ts`);
const sc = await import(`${ROOT}/app/lib/firebase/server-cleaners.ts`);
const sa = await import(`${ROOT}/app/lib/firebase/server-admins.ts`);
const sb = await import(`${ROOT}/app/lib/firebase/server-signin-budget.ts`);
const seed = globalThis.__memSeed;
const doc = globalThis.__memDoc;

const out = (...a) => console.log(...a);
let failures = 0;
const check = (ok, label) => {
  if (!ok) failures += 1;
  out(`   ${ok ? 'ok  ' : 'FAIL'} ${label}`);
};
// Made-up values, never printed: a cleaner code, an admin PIN, the shared PIN, and wrong ones that are none of them.
const drawn = new Set();
const draw = () => {
  for (;;) {
    const v = String(randomInt(0, 10_000)).padStart(4, '0');
    if (!isTooEasyCode(v) && !drawn.has(v)) {
      drawn.add(v);
      return v;
    }
  }
};
const CODE = draw();
const PIN = draw();
const SHARED = draw();
process.env.ADMIN_PIN = SHARED;
const WRONG = Array.from({ length: 60 }, draw);
const T0 = Date.parse('2028-11-20T15:00:00.000Z'); // Monday 20 Nov 2028, 10:00 Toronto (EST)
const DAY = '2028-11-20';
const DAY_END = '2028-11-21T05:00:00.000Z';
const at = (n) => T0 + n * 1000;
const CLEANER_KEY = randomBytes(32);
const conn = (n) => cleanerConnectionKey(CLEANER_KEY, `203.0.113.${n}`);
const aconn = (n) => connectionKey(PIN_KEY, `198.51.100.${n}`);

// ─── 1. The budget's arithmetic ───
out('1. The budget: fifteen at the cleaner door, ten at the admin door; spent, reached, lifted, a new day');
check(b.DAILY_BUDGET.cleaner === 15 && b.DAILY_BUDGET.admin === 10, `thresholds: cleaner ${b.DAILY_BUDGET.cleaner}, admin ${b.DAILY_BUDGET.admin}`);
let state = b.NO_BUDGET;
let reachedAt = null;
let spentBeforeCount = 0;
for (let i = 1; i <= 17; i += 1) {
  const r = b.afterWrongOnBudget(state, 'cleaner', at(i));
  if (r.reachedNow) reachedAt = i;
  if (r.spentBefore) spentBeforeCount += 1;
  state = r.next;
}
check(reachedAt === 15, `the 15th wrong code reaches the budget (reached at ${reachedAt})`);
check(spentBeforeCount === 2, `the 16th and 17th come to a spent budget (${spentBeforeCount})`);
check(state.wrong === 17 && state.base === 0 && state.spentAt === new Date(at(15)).toISOString() && state.dayKey === DAY, `stored: wrong ${state.wrong}, base ${state.base}, spent at the 15th, day ${state.dayKey}`);
check(b.budgetSpent(state, 'cleaner', at(17)), 'spent now');
const lifted = b.liftedBudget(state, at(18));
check(!b.budgetSpent(lifted, 'cleaner', at(18)) && lifted.base === 17 && lifted.wrong === 17 && lifted.spentAt === null, `lifted: not spent, base ${lifted.base}, the day's ${lifted.wrong} kept`);
let again = lifted;
let reachedAgain = null;
for (let i = 1; i <= 15; i += 1) {
  const r = b.afterWrongOnBudget(again, 'cleaner', at(100 + i));
  if (r.reachedNow) reachedAgain = r.next.wrong;
  again = r.next;
}
check(reachedAgain === 32, `fifteen more after the lift reach it again, at ${reachedAgain} wrong today (the email says "32 so far")`);
check(!b.budgetSpent(state, 'cleaner', Date.parse('2028-11-21T06:00:00.000Z')), 'the next Toronto day starts from nothing');
const admin10 = Array.from({ length: 10 }).reduce((s, _, i) => b.afterWrongOnBudget(s, 'admin', at(i)).next, b.NO_BUDGET);
check(b.budgetSpent(admin10, 'admin', at(10)) && !b.budgetSpent(Array.from({ length: 9 }).reduce((s, _, i) => b.afterWrongOnBudget(s, 'admin', at(i)).next, b.NO_BUDGET), 'admin', at(9)), 'the admin door: spent at ten, not at nine');
check(b.budgetDocId('cleaner', DAY) === `cleaner-${DAY}` && b.budgetDocId('admin', DAY) === `admin-${DAY}`, 'one document per door per day');

// ─── 2. Midnight Toronto ───
out('\n2. The day lock ends at Toronto midnight: EST, EDT, both clock-change nights, the last millisecond');
for (const [label, now, end] of [
  ['an EST day', '2026-12-15T12:00:00.000Z', '2026-12-16T05:00:00.000Z'],
  ['an EDT day', '2026-07-01T12:00:00.000Z', '2026-07-02T04:00:00.000Z'],
  ['the day before clocks go back (2026-10-31)', '2026-10-31T20:00:00.000Z', '2026-11-01T04:00:00.000Z'],
  ['the 25-hour day clocks go back (2026-11-01)', '2026-11-01T12:00:00.000Z', '2026-11-02T05:00:00.000Z'],
  ['the day before clocks go forward (2026-03-07)', '2026-03-07T20:00:00.000Z', '2026-03-08T05:00:00.000Z'],
  ['the 23-hour day clocks go forward (2026-03-08)', '2026-03-08T12:00:00.000Z', '2026-03-09T04:00:00.000Z'],
  ['one millisecond before midnight', '2026-12-16T04:59:59.999Z', '2026-12-16T05:00:00.000Z'],
  ['the test day', new Date(T0).toISOString(), DAY_END],
]) {
  const got = new Date(b.torontoDayEndMs(Date.parse(now))).toISOString();
  check(got === end && m.torontoDayOf(Date.parse(end) - 1) === m.torontoDayOf(Date.parse(now)) && m.torontoDayOf(Date.parse(end)) !== m.torontoDayOf(Date.parse(now)), `${label}: ${now} → ${got}`);
}

// ─── 3. The connection once the budget is spent ───
out('\n3. One wrong try at a spent door locks the connection until tomorrow; the day\'s twentieth still caps it');
const fresh = b.afterWrongHardened(m.NO_LOCK, T0);
check(fresh.kind === 'budget-locked' && fresh.lockedUntil === DAY_END && fresh.next.lockedUntil === DAY_END && fresh.next.failedTries === 0 && fresh.next.dayTries === 1 && fresh.next.dayKey === DAY && !fresh.next.capped, `a first try: ${fresh.kind} until ${fresh.lockedUntil}; stored failedTries ${fresh.next.failedTries}, dayTries ${fresh.next.dayTries}`);
const fourth = b.afterWrongHardened({ failedTries: 4, lockedUntil: null, dayKey: DAY, dayTries: 7, capped: false }, T0);
check(fourth.kind === 'budget-locked' && fourth.next.dayTries === 8, `a fifth in a row: the day lock, not the fifteen minutes (dayTries ${fourth.next.dayTries})`);
const twentieth = b.afterWrongHardened({ failedTries: 0, lockedUntil: null, dayKey: DAY, dayTries: 19, capped: false }, T0);
check(twentieth.kind === 'capped-now' && twentieth.next.capped, `the day's twentieth: ${twentieth.kind} (until lifted outranks the day lock)`);
check(m.lockHolding(fresh.next, Date.parse(DAY_END) - 1) !== null && m.lockHolding(fresh.next, Date.parse(DAY_END)) === null, 'the day lock holds to the last millisecond and not at midnight');

// ─── 4. The email ───
out('\n4. The one email: the count and the door, never a code or PIN');
for (const door of b.DOORS) {
  const mail = b.budgetEmail(door, b.DAILY_BUDGET[door], DAY);
  const digits = `${mail.subject}\n${mail.text}`.replace(DAY, '').match(/\d+/g) ?? [];
  check(mail.subject === `[NuBnb] Many wrong ${door === 'cleaner' ? 'codes at the cleaner door' : 'PINs at the admin door'} today: ${b.DAILY_BUDGET[door]} so far`, `${door}: "${mail.subject}"`);
  check(digits.every((d) => d === String(b.DAILY_BUDGET[door])) && !/\d{4}/.test(`${mail.subject}\n${mail.text}`.replace(DAY, '')), `${door}: the only digits are the count (${[...new Set(digits)].join(', ')}); no four-digit run besides the day`);
  check(mail.text.includes(door === 'cleaner' ? '/admin/cleaners' : '/admin/admins'), `${door}: points to the page with Lift`);
}
out(`   the cleaner door's text:\n${b.budgetEmail('cleaner', 15, DAY).text.split('\n').map((l) => `     | ${l}`).join('\n')}`);

// ─── 5. The pages' words ───
out("\n5. The pages' words and the view's shape");
const view = { door: 'cleaner', dayKey: DAY, wrong: 17, threshold: 15, spent: true, spentAt: new Date(at(15)).toISOString(), email: { at: new Date(at(16)).toISOString(), status: 'sent' }, lifts: 0 };
check(b.isBudgetView(view) && b.isBudgetView({ ...view, email: null }) && !b.isBudgetView({ ...view, spent: 'yes' }) && !b.isBudgetView({ ...view, email: { status: 'maybe' } }) && !b.isBudgetView(null), 'isBudgetView accepts the shape and refuses others');
check(b.budgetSpentWords(view) === 'Daily budget spent: 17 wrong codes at the cleaner door today (budget 15).', `"${b.budgetSpentWords(view)}"`);
check(b.budgetSpentWords({ ...view, door: 'admin', wrong: 11, threshold: 10 }) === 'Daily budget spent: 11 wrong PINs at the admin door today (budget 10).', `"${b.budgetSpentWords({ ...view, door: 'admin', wrong: 11, threshold: 10 })}"`);
out(`   "${b.budgetEffectWords('cleaner')}" · "${b.budgetEffectWords('admin')}"`);
out(`   "${b.budgetLockWords('cleaner')}" · "${b.budgetLockWords('admin')}"`);

// ─── 6. The cleaner door ───
out('\n6. The cleaner door on an in-memory Firestore: 15 wrong codes from 5 connections, then one try, then a lock; a right code still signs in; one email; Lift');
process.env.CLEANER_SESSION_SECRET = CLEANER_KEY.toString('base64url');
const ANA = 'TESTCLEANERbudgetana';
seed('cleaners', ANA, { schemaVersion: CLEANER_SCHEMA_VERSION, name: 'Test Ana', role: 'cleaner', status: 'active', code: CODE, sessionEpoch: 1, history: [], createdAt: new Date(T0).toISOString() });
seed('cleaner_codes', CODE, { schemaVersion: CLEANER_CODE_SCHEMA_VERSION, cleanerId: ANA, issuedAt: new Date(T0).toISOString(), retiredAt: null });
const kinds = [];
let reached = [];
let n = 0;
for (let c = 1; c <= 5; c += 1) {
  for (let k = 0; k < 3; k += 1) {
    n += 1;
    const r = await sc.signInCleaner(WRONG[n], conn(c), at(n));
    kinds.push(r.kind);
    if (r.budgetReached) reached.push({ n, ...r.budgetReached });
  }
}
check(kinds.every((k) => k === 'not-recognised'), `15 wrong codes from 5 connections, 3 each: all ${[...new Set(kinds)].join('/')} (no connection reached five in a row)`);
check(reached.length === 1 && reached[0].n === 15 && reached[0].wrong === 15 && reached[0].door === 'cleaner' && reached[0].dayKey === DAY, `the 15th alone carries budgetReached: ${JSON.stringify(reached.map((r) => ({ n: r.n, wrong: r.wrong })))}`);
let budgetDoc = doc('signin_budgets', `cleaner-${DAY}`);
check(budgetDoc.wrong === 15 && budgetDoc.base === 0 && budgetDoc.spentAt === new Date(at(15)).toISOString() && budgetDoc.door === 'cleaner', `signin_budgets/cleaner-${DAY}: wrong ${budgetDoc.wrong}, base ${budgetDoc.base}, spentAt the 15th`);
const sixteenth = await sc.signInCleaner(WRONG[16], conn(6), at(16));
check(sixteenth.kind === 'locked' && sixteenth.now && sixteenth.budget && sixteenth.lockedUntil === DAY_END && !sixteenth.budgetReached, `the 16th, a new connection: ${sixteenth.kind} now, budget ${sixteenth.budget}, until ${sixteenth.lockedUntil}`);
let lock6 = doc('cleaner_signin_locks', conn(6));
check(lock6.lockedUntil === DAY_END && lock6.budgetLocked === DAY && lock6.failedTries === 0 && lock6.dayTries === 1, `its lock document: lockedUntil midnight, budgetLocked ${lock6.budgetLocked}, dayTries ${lock6.dayTries}`);
const seventeenth = await sc.signInCleaner(WRONG[17], conn(6), at(17));
check(seventeenth.kind === 'locked' && !seventeenth.now && seventeenth.budget && seventeenth.lockedUntil === DAY_END, `the 17th from the same connection: ${seventeenth.kind}, not now, budget ${seventeenth.budget} (refused before any check)`);
const rightCode = await sc.signInCleaner(CODE, conn(6), at(18));
check(rightCode.kind === 'locked', `the right code from the locked connection: ${rightCode.kind} (the connection's lock, as always)`);
const readsBefore = globalThis.__memReads.length;
const rightElsewhere = await sc.signInCleaner(CODE, conn(7), at(19));
const readsOf = globalThis.__memReads.slice(readsBefore).map((r) => r.what);
check(rightElsewhere.kind === 'found' && rightElsewhere.cleaner.id === ANA, `the right code from another connection: ${rightElsewhere.kind} (right codes are unaffected)`);
check(!readsOf.includes('signin_budgets'), `a right code reads no budget document (reads: ${readsOf.join(', ')})`);
const wrongElsewhere = await sc.signInCleaner(WRONG[18], conn(7), at(20));
check(wrongElsewhere.kind === 'locked' && wrongElsewhere.budget, `then one wrong code from that connection: ${wrongElsewhere.kind}, budget ${wrongElsewhere.budget}`);
budgetDoc = doc('signin_budgets', `cleaner-${DAY}`);
check(budgetDoc.wrong === 17 && budgetDoc.spentAt === new Date(at(15)).toISOString(), `the budget counts the wrong codes at the spent door too: wrong ${budgetDoc.wrong}, spentAt unchanged`);
// The email, after the response: no transport is configured here, so its outcome is recorded as not sent.
await sb.notifyBudgetSpent(reached[0]);
budgetDoc = doc('signin_budgets', `cleaner-${DAY}`);
check(budgetDoc.email?.status === 'failed' && budgetDoc.email.wrong === 15 && /not configured/.test(budgetDoc.email.detail), `the email's outcome recorded on the budget: ${budgetDoc.email?.status} ("${budgetDoc.email?.detail}")`);
let viewNow = await sb.readBudgetView('cleaner', at(21));
check(viewNow.spent && viewNow.wrong === 17 && viewNow.threshold === 15 && viewNow.email?.status === 'failed' && viewNow.lifts === 0 && viewNow.dayKey === DAY, `the Team page's view: spent ${viewNow.spent}, wrong ${viewNow.wrong}, email ${viewNow.email?.status}, lifts ${viewNow.lifts}`);
const locksNow = await sc.listCleanerSignInLocks(at(21));
check(locksNow.length === 2 && locksNow.every((l) => l.budget && !l.capped && l.lockedUntil === DAY_END), `the locks listed: ${locksNow.length}, both budget locks until midnight`);
const ADMIN = { role: 'admin', id: 'TESTADMINbudgetaaaa1', name: 'Test admin' };
const lift = await sb.liftBudget('cleaner', ADMIN, at(22));
check(lift.kind === 'lifted' && lift.unlocked === 2 && lift.dayKey === DAY, `Lift: ${lift.kind}, ${lift.unlocked} connections unlocked`);
lock6 = doc('cleaner_signin_locks', conn(6));
check(lock6.lockedUntil === null && lock6.budgetLocked === undefined && lock6.dayTries === 1, `the locked connection after Lift: lockedUntil ${lock6.lockedUntil}, budgetLocked gone, dayTries ${lock6.dayTries} kept`);
budgetDoc = doc('signin_budgets', `cleaner-${DAY}`);
check(budgetDoc.base === 17 && budgetDoc.spentAt === null && budgetDoc.lifts.length === 1 && budgetDoc.lifts[0].actor.id === ADMIN.id && budgetDoc.lifts[0].atWrong === 17, `the budget after Lift: base ${budgetDoc.base}, spentAt ${budgetDoc.spentAt}, one lift by the admin at ${budgetDoc.lifts[0].atWrong}`);
viewNow = await sb.readBudgetView('cleaner', at(23));
check(!viewNow.spent && viewNow.lifts === 1 && viewNow.wrong === 17, `the view after Lift: spent ${viewNow.spent}, lifts ${viewNow.lifts}, wrong ${viewNow.wrong}`);
const liftAgain = await sb.liftBudget('cleaner', ADMIN, at(24));
check(liftAgain.kind === 'not-spent', `a second Lift: ${liftAgain.kind}`);
const afterLift = await sc.signInCleaner(WRONG[19], conn(6), at(25));
check(afterLift.kind === 'not-recognised' && afterLift.triesLeft === 4, `a wrong code from the unlocked connection: ${afterLift.kind}, ${afterLift.triesLeft} left (an ordinary try again)`);
check((await sc.listCleanerSignInLocks(at(26))).length === 0, 'no lock listed after Lift');
// Fifteen more spend it again, and the email says "32 so far".
reached = [];
n = 20;
for (let c = 8; c <= 12; c += 1) {
  for (let k = 0; k < 3; k += 1) {
    n += 1;
    const r = await sc.signInCleaner(WRONG[n], conn(c), at(100 + n));
    if (r.budgetReached) reached.push(r.budgetReached);
  }
}
check(reached.length === 1 && reached[0].wrong === 32, `fifteen more after the lift: reached once, "${reached[0]?.wrong} so far" (17 before the lift, 1 after it, then the fourteenth of these fifteen; the fifteenth meets a spent door)`);
// A connection's fifth in a row at a spent door becomes the day lock; a right code's row count is cleared as before.
const rowed = await sc.signInCleaner(WRONG[40], conn(8), at(200));
check(rowed.kind === 'locked' && rowed.budget && doc('cleaner_signin_locks', conn(8)).dayTries === 4, `a fourth wrong code from connection 8 at the spent door: ${rowed.kind} (budget ${rowed.budget}), dayTries ${doc('cleaner_signin_locks', conn(8)).dayTries}`);
// The day's twentieth at a spent door: capped until lifted, which outranks the day lock.
seed('cleaner_signin_locks', conn(13), { failedTries: 0, lockedUntil: null, dayKey: DAY, dayTries: 19, capped: false, lastFailedAt: new Date(at(1)).toISOString() });
const capped = await sc.signInCleaner(WRONG[41], conn(13), at(201));
check(capped.kind === 'locked' && capped.lockedUntil === null && !capped.budget && doc('cleaner_signin_locks', conn(13)).capped === true, `the day's twentieth from connection 13: ${capped.kind} until lifted (budget ${capped.budget})`);
check(/^[0-9a-f]{64}$/.test(conn(1)) && !JSON.stringify(doc('signin_budgets', `cleaner-${DAY}`)).includes(CODE), 'no code stands in the budget document');

// ─── 7. The admin door ───
out('\n7. The admin door: the same at ten; a right PIN still signs in; Change PIN\'s wrong current PIN stays off the budget');
const MAIN = 'TESTADMINbudgetmain1';
seed('admins', MAIN, { schemaVersion: 4, name: 'Test Main', nameKey: 'test main', level: 'main', pin: { state: 'readable', value: PIN }, pinSetAt: new Date(T0).toISOString(), sessionEpoch: 1, lastSignedInAt: null, createdAt: new Date(T0).toISOString(), createdBy: ADMIN, history: [] });
seed('admin_pins', PIN, { adminId: MAIN, createdAt: new Date(T0).toISOString() });
const akinds = [];
let areached = [];
n = 0;
for (let c = 1; c <= 5; c += 1) {
  for (let k = 0; k < 2; k += 1) {
    n += 1;
    const r = await sa.signIn(WRONG[n], aconn(c), at(300 + n));
    akinds.push(r.kind);
    if (r.budgetReached) areached.push({ n, ...r.budgetReached });
  }
}
check(akinds.every((k) => k === 'wrong'), `10 wrong PINs from 5 connections, 2 each: all ${[...new Set(akinds)].join('/')}`);
check(areached.length === 1 && areached[0].n === 10 && areached[0].wrong === 10 && areached[0].door === 'admin', `the 10th alone carries budgetReached: ${JSON.stringify(areached.map((r) => ({ n: r.n, wrong: r.wrong })))}`);
const eleventh = await sa.signIn(WRONG[11], aconn(6), at(311));
check(eleventh.kind === 'locked' && eleventh.now && eleventh.budget && eleventh.lockedUntil === DAY_END, `the 11th, a new connection: ${eleventh.kind} now, budget ${eleventh.budget}, until ${eleventh.lockedUntil}`);
check(doc('admin_signin_locks', aconn(6)).budgetLocked === DAY, `its lock document carries budgetLocked ${doc('admin_signin_locks', aconn(6)).budgetLocked}`);
const twelfth = await sa.signIn(WRONG[12], aconn(6), at(312));
check(twelfth.kind === 'locked' && !twelfth.now && twelfth.budget, `the 12th from it: ${twelfth.kind}, budget ${twelfth.budget}`);
const rightPin = await sa.signIn(PIN, aconn(7), at(313));
check(rightPin.kind === 'signed-in' && rightPin.admin.id === MAIN, `the right PIN from another connection: ${rightPin.kind} (right PINs are unaffected)`);
const sharedTry = await sa.signIn(SHARED, aconn(8), at(314));
check(sharedTry.kind === 'locked' && sharedTry.budget, `the shared PIN with no admin on it, at the spent door: a wrong PIN like any other → ${sharedTry.kind}, budget ${sharedTry.budget}`);
let adminBudget = doc('signin_budgets', `admin-${DAY}`);
check(adminBudget.wrong === 12 && adminBudget.door === 'admin', `signin_budgets/admin-${DAY}: wrong ${adminBudget.wrong}`);
const changed = await sa.changeOwnPin({ id: MAIN, name: 'Test Main', level: 'main', pin: 'readable', sessionEpoch: 1 }, WRONG[50], WRONG[51], aconn(9), at(315));
adminBudget = doc('signin_budgets', `admin-${DAY}`);
check(changed.kind === 'wrong' && adminBudget.wrong === 12 && doc('admin_signin_locks', aconn(9)).failedTries === 1, `Change PIN with a wrong current PIN: ${changed.kind}; the connection counts it (failedTries ${doc('admin_signin_locks', aconn(9)).failedTries}), the budget does not (wrong ${adminBudget.wrong})`);
const adminView = await sb.readBudgetView('admin', at(316));
check(adminView.spent && adminView.threshold === 10 && adminView.wrong === 12, `the Admins page's view: spent ${adminView.spent}, threshold ${adminView.threshold}, wrong ${adminView.wrong}`);
const adminLocks = await sa.listSignInLocks(at(316));
check(adminLocks.length === 2 && adminLocks.every((l) => l.budget), `the admin door's locks listed: ${adminLocks.length}, both budget locks`);
const adminLift = await sb.liftBudget('admin', ADMIN, at(317));
check(adminLift.kind === 'lifted' && adminLift.unlocked === 2, `Lift at the admin door: ${adminLift.kind}, ${adminLift.unlocked} unlocked`);
const afterAdminLift = await sa.signIn(WRONG[13], aconn(6), at(318));
check(afterAdminLift.kind === 'wrong' && afterAdminLift.triesLeft === 4, `a wrong PIN from the unlocked connection: ${afterAdminLift.kind}, ${afterAdminLift.triesLeft} left`);
check(!JSON.stringify([doc('signin_budgets', `admin-${DAY}`), doc('signin_budgets', `cleaner-${DAY}`)]).includes(PIN), 'no PIN stands in a budget document');

out(`\n${failures === 0 ? 'all checks pass' : `${failures} check(s) FAIL`}`);
process.exit(failures === 0 ? 0 : 1);
