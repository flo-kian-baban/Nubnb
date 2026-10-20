// Dispatch 38: admin accounts through Nubnb's own code — names, the PIN rules, the connection and its lock, session
// tokens, the shared PIN, and which routes go through the admin door. Kian's rulings of 2026-10-13: sign-in by PIN
// alone, every PIN unique, five wrong PINs from one connection lock it for fifteen minutes (evening); the main admin
// sets PINs, stored readably (night); four digits, the cleaner codes' too-easy list, twenty tries in a Toronto day
// lock a connection until lifted (late night). Made-up keys, PINs and addresses only
// (TEST-NET and documentation ranges); nothing is read from or written to Firestore. The shared PIN is drawn at random
// here and never printed, so no output can show a real one.
//   node --import ./tests/tools/ts-hook.mjs tests/admins/accounts.mjs
import { createHmac, randomBytes, randomInt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.NUBNB_ROOT || fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const m = await import(`${ROOT}/app/lib/admins/model.ts`);
const pin = await import(`${ROOT}/app/lib/admins/pin.ts`);
const { connectionOf } = await import(`${ROOT}/app/lib/admins/connection.ts`);
const session = await import(`${ROOT}/app/lib/admins/session.ts`);
const { createCleanerToken } = await import(`${ROOT}/app/lib/cleaners/session.ts`);
const { isTooEasyCode } = await import(`${ROOT}/app/lib/cleaners/model.ts`);
const codes = await import(`${ROOT}/app/lib/cleaners/codes.ts`);

const out = (...a) => console.log(...a);
const T0 = Date.parse('2026-10-13T20:00:00.000Z');
const HEX64 = /^[0-9a-f]{64}$/;

// ─── 1. Names ───
out('1. Names: cleaned, keyed, refused');
for (const name of ['Kian', '  kian  ', 'KIAN', 'Ana  Maria', 'Ana Maria', '', '   ', 'a/b', '.', '__x__', '__TEST__ Ada', 'x'.repeat(61), 'Zoë']) {
  out(`  ${JSON.stringify(name).padEnd(66)} clean ${JSON.stringify(m.cleanAdminName(name))} key ${JSON.stringify(m.nameKeyOf(name))} problem ${JSON.stringify(m.adminNameProblem(name))}`);
}
out(`  the first main admin: ${m.FIRST_MAIN_ADMIN_NAME}, key ${m.nameKeyOf(m.FIRST_MAIN_ADMIN_NAME)}`);

// ─── 2. PINs ───
out('\n2. PINs: set by the main admin or the admin, four digits, never on the easy list; sign-in takes four');
const ALL4 = [...Array(10000).keys()].map((n) => String(n).padStart(4, '0'));
const easy = ALL4.filter(m.isTooEasyPin);
// Shapes, never digits (security rule, 2026-10-19: no code value in the tree): four of one digit, an ascending run, a descending run.
const shape = (c) => (/^(\d)\1{3}$/.test(c) ? 'four of one digit' : '0123456789'.includes(c) ? 'an ascending run' : '9876543210'.includes(c) ? 'a descending run' : 'not easy');
const kinds = easy.reduce((acc, c) => ((acc[shape(c)] = (acc[shape(c)] ?? 0) + 1), acc), {});
out(`  too easy: ${easy.length} (${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(', ')}) · the same list as the easy codes: ${easy.every(isTooEasyCode) && ALL4.filter(isTooEasyCode).length === easy.length}`);
const SAME = String(8).repeat(4);
const UP = [2, 3, 4, 5].join('');
const DOWN = [9, 8, 7, 6].join('');
const SEVENS = String(7).repeat(4);
// Kian's ruling of 2026-10-17: cleaner and handyman codes may be easy codes; only the shared PIN is refused by its digits.
const SHARED_CODE = [5, 8, 3, 9].join('');
const refusedCodes = ALL4.filter((c) => codes.reservedReason(c, SHARED_CODE) !== null);
out(`  cleaner codes refused by their digits alone: ${refusedCodes.length} of 10,000, the shared PIN only: ${refusedCodes.length === 1 && refusedCodes[0] === SHARED_CODE} · ${[UP, SAME, DOWN, SEVENS].map((c) => `${shape(c)} ${JSON.stringify(codes.reservedReason(c, SHARED_CODE))}`).join(', ')}`);
const drawable = ALL4.filter((c) => codes.isDrawable(c, SHARED_CODE));
out(`  a drawn or suggested code skips the easy ones and the shared PIN: ${drawable.length} drawable, ${10000 - drawable.length} skipped`);
// The security rule of 2026-10-19: a code that appeared in Nubnb's public code is never given out — refused when typed,
// never drawn. The list lives in the environment as keyed hashes (codes.ts); here a made-up key and three made-up codes.
const denyKey = Buffer.alloc(32, 7);
const DENIED = ['4812', '0675', '9301'];
const denyValue = codes.denylistValue(DENIED, denyKey);
const denyRead = codes.readCodeDenylist(denyValue, denyKey);
const denylist = denyRead.kind === 'ok' ? denyRead.denylist : null;
out(`  the denylist as an environment value: ${denyValue.split(',').length} hashes of ${denyValue.length} characters, each 64 hex; read back: ${denyRead.kind}; a code's digits in it: ${/\d{4}/.test(denyValue)}`);
out(`  typed, on the list: ${DENIED.map((c) => JSON.stringify(codes.reservedReason(c, SHARED_CODE, denylist))).join(' ')} · typed, not on it: ${JSON.stringify(codes.reservedReason('5120', SHARED_CODE, denylist))} · the shared PIN still: ${JSON.stringify(codes.reservedReason(SHARED_CODE, SHARED_CODE, denylist))}`);
const drawableDenied = ALL4.filter((c) => codes.isDrawable(c, SHARED_CODE, denylist));
out(`  with the list, drawable: ${drawableDenied.length} (${drawable.length - drawableDenied.length} fewer); any listed code drawable: ${DENIED.some((c) => drawableDenied.includes(c))}; the same list under another key denies nothing: ${DENIED.filter((c) => codes.isPublicCode(c, { hashes: denylist.hashes, key: Buffer.alloc(32, 9) })).length}`);
out(`  the refusal's line: ${codes.PUBLIC_CODE_REFUSAL_LINE}`);
out(`  no list set: ${codes.readCodeDenylist(undefined, denyKey).kind}, ${codes.readCodeDenylist('', denyKey).kind}; a list set with no key: ${codes.readCodeDenylist(denyValue, null).kind} (issuance then fails closed); a value that is not hashes: ${codes.readCodeDenylist('1234,abcd', denyKey).kind}`);
// The same list refuses an admin PIN (app/lib/admins/pin-denylist.ts), read from the environment as the server reads it;
// the environment is restored after.
const pinDeny = await import(`${ROOT}/app/lib/admins/pin-denylist.ts`);
const keptEnv = { list: process.env.CLEANER_CODE_DENYLIST, key: process.env.CLEANER_SESSION_SECRET };
process.env.CLEANER_CODE_DENYLIST = denyValue;
process.env.CLEANER_SESSION_SECRET = denyKey.toString('base64url');
const verdict = (r) => (r === null ? 'allowed' : `${r.status} ${r.code}`);
out(`  an admin PIN on the list: ${DENIED.map((c) => verdict(pinDeny.pinDenied(c))).join(', ')}; not on it: ${verdict(pinDeny.pinDenied('5120'))}; refused with the cleaner code's sentence: ${pinDeny.PIN_IS_PUBLIC.message === codes.PUBLIC_CODE_REFUSAL_LINE}`);
delete process.env.CLEANER_SESSION_SECRET;
const unkeyed = verdict(pinDeny.pinDenied(DENIED[0]));
delete process.env.CLEANER_CODE_DENYLIST;
out(`  the list set and the key missing: ${unkeyed} (fails closed); no list set: ${verdict(pinDeny.pinDenied(DENIED[0]))}`);
if (keptEnv.list !== undefined) process.env.CLEANER_CODE_DENYLIST = keptEnv.list;
if (keptEnv.key !== undefined) process.env.CLEANER_SESSION_SECRET = keptEnv.key;
const pinRoutes = ['app/api/admin/admins/route.ts', 'app/api/admin/admins/[id]/pin/route.ts', 'app/api/admin-auth/pin/route.ts'];
out(`  the routes that take a PIN ask the list before any read: ${pinRoutes.filter((f) => /const denied = pinDenied\(/.test(fs.readFileSync(path.join(ROOT, f), 'utf8'))).length} of ${pinRoutes.length}`);
// Kian's ruling of 2026-10-19: a PIN already held stays as it is even when it is on the list. Sign-in never asks the list:
// a listed PIN still signs its holder in; only choosing or setting a PIN is refused.
const signInSources = ['app/api/admin-auth/route.ts', 'app/lib/firebase/server-admins.ts'].map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'));
out(`  sign-in never asks the list (a listed PIN still signs its holder in): the sign-in route and signIn() name neither the list nor pinDenied: ${signInSources.every((src) => !/pin-denylist|cleaners\/denylist|isPublicCode|pinDenied|CLEANER_CODE_DENYLIST/.test(src))}; sign-in compares the PIN only: ${/samePin|sharedPinMatches/.test(signInSources[1])}`);
const OTHER = [0, 4, 2, 9].join('');
for (const p of [SHARED_CODE, OTHER, SAME, UP, DOWN, SHARED_CODE + '20', SHARED_CODE.slice(0, 3), SHARED_CODE + '2', '12a4', ` ${SHARED_CODE}`, '']) {
  const label = p === SHARED_CODE ? 'the shared PIN' : p === OTHER ? 'another PIN' : shape(p.trim()) !== 'not easy' && p.trim().length === 4 ? shape(p) : p === SHARED_CODE + '20' ? 'six digits' : p === SHARED_CODE.slice(0, 3) ? 'three digits' : p === SHARED_CODE + '2' ? 'five digits' : p === '12a4' ? 'a letter inside' : p === ` ${SHARED_CODE}` ? 'a leading space' : 'empty';
  out(`  ${label.padEnd(17)} problem ${JSON.stringify(m.pinProblem(p))} · PIN shape ${m.PIN_PATTERN.test(p)} · sign-in shape ${m.SIGN_IN_PIN_PATTERN.test(p)}`);
}
out(`  readable: ${m.isReadablePin('readable')}; the shared PIN ${m.isReadablePin('shared')}; kept before: ${['own', 'temporary', 'set'].map((st) => `${st} ${m.isKeptBefore(st)}`).join(', ')}; readable kept before ${m.isKeptBefore('readable')}; shared kept before ${m.isKeptBefore('shared')}`);

// ─── 3. Comparing PINs ───
out('\n3. PINs are compared in constant time, length included');
for (const [a, b] of [['5839', '5839'], ['5839', '5830'], ['5839', '583'], ['5839', '58390'], ['', '']]) out(`  ${JSON.stringify(a)} and ${JSON.stringify(b)}: ${pin.samePin(a, b)}`);

// ─── 4. The connection ───
out('\n4. The connection: the address normalized, an IPv6 address cut to its /64, kept only as a keyed hash');
for (const a of [
  '203.0.113.7',
  ' 203.0.113.7 ',
  '203.000.113.007',
  '::ffff:203.0.113.7',
  '::FFFF:CB00:7107',
  '2001:db8:1:2::abcd',
  '2001:DB8:1:2:ffff:ffff:ffff:ffff',
  '[2001:db8:1:2::abcd]',
  'fe80::1%en0',
  '::1',
  '2001:db8:1:3::1',
  '203.0.113.256',
  '1.2.3',
  '2001:db8::1::2',
  'not-an-ip',
  '',
  null,
]) {
  out(`  ${JSON.stringify(a).padEnd(36)} → ${JSON.stringify(m.normalizeAddress(a))}`);
}
const pinKey = randomBytes(32);
const key = (a) => pin.connectionKey(pinKey, m.normalizeAddress(a) ?? 'unknown');
out(`  keys: 64 hex ${HEX64.test(key('203.0.113.7'))} · holds the address ${key('203.0.113.7').includes('203.0.113')}`);
out(`  203.0.113.7 and ::ffff:203.0.113.7: same key ${key('203.0.113.7') === key('::ffff:203.0.113.7')}`);
out(`  two addresses in one /64: same key ${key('2001:db8:1:2::abcd') === key('2001:db8:1:2:ffff::1')} · in the next /64: same key ${key('2001:db8:1:2::abcd') === key('2001:db8:1:3::abcd')}`);
out(`  203.0.113.7 and 203.0.113.8: same key ${key('203.0.113.7') === key('203.0.113.8')} · another ADMIN_PIN_KEY: same key ${key('203.0.113.7') === pin.connectionKey(randomBytes(32), '203.0.113.7')}`);
const request = (headers) => new Request('https://www.nubnb.ca/api/admin-auth', { method: 'POST', headers });
for (const [label, headers, expected] of [
  ['x-real-ip', { 'x-real-ip': '198.51.100.4', 'x-forwarded-for': '203.0.113.9' }, '198.51.100.4'],
  ['x-forwarded-for, first entry', { 'x-forwarded-for': '198.51.100.4, 10.0.0.1' }, '198.51.100.4'],
  ['x-real-ip not an address', { 'x-real-ip': 'nonsense', 'x-forwarded-for': '198.51.100.4' }, '198.51.100.4'],
  ['neither', {}, 'unknown'],
]) {
  out(`  from ${label.padEnd(30)} the key of ${expected}: ${connectionOf(request(headers), pinKey) === pin.connectionKey(pinKey, expected)}`);
}

// ─── 5. The lock ───
out('\n5. The lock: five tries in a row lock a connection for fifteen minutes; twenty in a Toronto day, until a main admin lifts it');
let state = m.NO_LOCK;
for (let i = 1; i <= 5; i++) {
  const at = T0 + i * 1000;
  const holding = m.lockHolding(state, at);
  const o = m.afterTry(state, false, at);
  state = o.next;
  out(`  try ${i} at +${i}s: lock before ${JSON.stringify(holding)} → ${o.kind}${o.kind === 'wrong' ? `, ${o.triesLeft} left${o.untilLifted ? ' (then until lifted)' : ''}` : ''}${o.kind === 'locked-now' ? ` until ${o.lockedUntil}` : ''} · stored ${JSON.stringify(state)}`);
}
const fifth = T0 + 5000;
for (const [label, at] of [['sixth try, 1 s later', fifth + 1000], ['14 min 59 s after the fifth', fifth + 899_000], ['15 min after the fifth', fifth + 900_000]]) {
  out(`  ${label.padEnd(28)} lock holding: ${JSON.stringify(m.lockHolding(state, at))}`);
}
const right = m.afterTry({ ...state, lockedUntil: null, failedTries: 3 }, true, fifth + 901_000);
out(`  a right PIN after the lock and three more tries: ${right.kind} · stored ${JSON.stringify(right.next)} (the day's tries kept)`);
// Twenty in one Toronto day: tries spread out so no fifteen-minute lock holds between them.
let day = m.NO_LOCK;
let last;
for (let i = 1; i <= 20; i++) {
  const at = T0 + i * 20 * 60_000;
  if (i % 4 === 0) day = m.afterTry(day, true, at).next;
  last = m.afterTry(day, false, at + 1000);
  day = last.next;
}
out(`  twenty tries in a day, right PINs among them: the twentieth → ${last.kind} · stored ${JSON.stringify(day)}`);
out(`  holding a week later: ${JSON.stringify(m.lockHolding(day, T0 + 7 * 86_400_000))}`);
// The warning before a lock names the lock that follows.
const today = m.torontoDayOf(T0);
for (const [label, failedTries, dayTries] of [["a fourth in a row, the day's fourth", 3, 3], ["a fourth in a row, the day's nineteenth", 3, 18], ["a first in a row, the day's eighteenth", 0, 17], ["a first in a row, the day's nineteenth", 0, 18]]) {
  const o = m.afterTry({ failedTries, lockedUntil: null, dayKey: today, dayTries, capped: false }, false, T0);
  out(`  ${label.padEnd(40)} → ${o.kind}, ${o.triesLeft} left${o.triesLeft === 1 ? `: "${m.lastTryWords('wrong PIN', o.untilLifted)}"` : `, then ${o.untilLifted ? 'until lifted' : 'fifteen minutes'}`}`);
}
out(`  Toronto days: ${['2026-10-14T03:59:59.000Z', '2026-10-14T04:00:00.000Z', '2026-12-15T04:59:59.000Z', '2026-12-15T05:00:00.000Z'].map((iso) => `${iso} → ${m.torontoDayOf(Date.parse(iso))}`).join(' · ')}`);
const yesterday = { failedTries: 2, lockedUntil: null, dayKey: '2026-10-12', dayTries: 19, capped: false };
const next = m.afterTry(yesterday, false, T0);
out(`  nineteen yesterday, one more today: ${next.kind} · stored ${JSON.stringify(next.next)}`);
out(`  an unreadable lockedUntil holds nothing: ${JSON.stringify(m.lockHolding({ ...m.NO_LOCK, lockedUntil: 'soon' }, T0))}`);

// ─── 6. Session tokens ───
out('\n6. Session tokens: signed with ADMIN_SESSION_SECRET, never the PIN');
const sessionKey = Buffer.alloc(32, 7);
const other = Buffer.alloc(32, 8);
const ID = 'TESTADMINaaaaaaaaaa1';
const token = session.createAdminToken(sessionKey, ID, 3, T0);
out(`  token shape: ${token.replace(/\.[A-Za-z0-9_-]{43}$/, '.<mac 43>')}`);
out(`  parsed now:            ${JSON.stringify(session.parseAdminToken(token, sessionKey, T0 + 1000))}`);
out(`  another key:           ${session.parseAdminToken(token, other, T0 + 1000)}`);
out(`  MAC changed:           ${session.parseAdminToken(token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'), sessionKey, T0 + 1000)}`);
out(`  epoch changed:         ${session.parseAdminToken(token.replace('.3.', '.4.'), sessionKey, T0 + 1000)}`);
out(`  24 h exactly:          ${JSON.stringify(session.parseAdminToken(token, sessionKey, T0 + 86_400_000))}`);
out(`  24 h and 1 ms:         ${session.parseAdminToken(token, sessionKey, T0 + 86_400_001)}`);
out(`  issued 61 s ahead:     ${session.parseAdminToken(token, sessionKey, T0 - 61_000)}`);
// The token the admin door made before dispatch 38: `<ms>.<hex HMAC-SHA256(ADMIN_PIN, ms)>`, keyed with the PIN.
const sharedPin = String(randomInt(0, 10_000)).padStart(4, '0');
const oldToken = `${T0}.${createHmac('sha256', sharedPin).update(String(T0)).digest('hex')}`;
out(`  a PIN-signed token of before: shape ${oldToken.replace(/^\d{13}\.[0-9a-f]{64}$/, '<13 digits>.<64 hex>')} → ${session.parseAdminToken(oldToken, sessionKey, T0 + 1000)}`);
out(`  a cleaner token:       ${session.parseAdminToken(createCleanerToken(sessionKey, ID, 3, T0), sessionKey, T0 + 1000)}`);
let threw = null;
try {
  session.createAdminToken(sessionKey, 'not-an-id', 1, T0);
} catch (err) {
  threw = err.message;
}
out(`  an ID that is not one: ${threw}`);

// ─── 7. The shared PIN ───
out('\n7. The shared PIN: four digits, only compared');
process.env.ADMIN_PIN = sharedPin;
const nextPin = String((Number(sharedPin) + 1) % 10_000).padStart(4, '0');
out(`  itself ${pin.sharedPinMatches(sharedPin)}, another four digits ${pin.sharedPinMatches(nextPin)}, six digits ${pin.sharedPinMatches(`${sharedPin}00`)} · its length ${pin.sharedPinLength()}`);
process.env.ADMIN_PIN = `${sharedPin}00`;
out(`  ADMIN_PIN of six digits: not a shared PIN at all (${pin.sharedPinMatches(`${sharedPin}00`)}, length ${pin.sharedPinLength()}): sign-in takes four`);
delete process.env.ADMIN_PIN;
out(`  unset: ${pin.sharedPinMatches(sharedPin)}`);
process.env.ADMIN_PIN = 'abcd';
out(`  not digits: ${pin.sharedPinMatches('abcd')}`);
delete process.env.ADMIN_PIN;

// ─── 8. The admin door, route by route ───
out('\n8. Every admin route goes through the door; every admin write has words in the activity log');
const apiRoot = path.join(ROOT, 'app/api');
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name === 'route.ts') files.push(p);
  }
})(apiRoot);
const sample = (route) => route.replace(/\[id\]/g, 'TESTID0000000000000a');
let wrapped = 0;
let problems = 0;
for (const file of files) {
  const rel = path.relative(ROOT, file);
  const src = fs.readFileSync(file, 'utf8');
  const route = '/' + path.relative(path.join(ROOT, 'app'), path.dirname(file)).split(path.sep).join('/');
  const handlers = [...src.matchAll(/export (?:async function|const) (GET|POST|PUT|PATCH|DELETE)\b/g)].map((x) => x[1]);
  const viaDoor = [...src.matchAll(/export const (GET|POST|PUT|PATCH|DELETE) = adminRoute\(/g)].map((x) => x[1]);
  const usesSession = src.includes('verifyAdminSession');
  if (viaDoor.length === 0 && !usesSession) continue;
  for (const method of handlers) {
    const door = viaDoor.includes(method);
    const recorded = door && (method !== 'GET' || /export const GET = adminRoute\([\s\S]*?\}, \{ record: true \}\);/.test(src));
    const words = recorded ? m.describeAdminAction(method, sample(route)) : null;
    if (door) wrapped++;
    const note = door
      ? recorded
        ? `recorded as "${words ?? 'NO WORDS'}"`
        : 'read, not recorded'
      : /admin-auth/.test(rel)
        ? 'the sign-in door itself'
        : 'public; reads the session itself';
    if ((recorded && words === null) || (!door && !/admin-auth|api\/properties\/\[id\]/.test(rel))) problems++;
    out(`  ${method.padEnd(6)} ${route.padEnd(52)} ${note}`);
  }
}
out(`  ${wrapped} handlers through adminRoute; problems: ${problems}`);
const old = files.filter((f) => /verifyAdminPin|createSessionToken|verifySessionToken|auth\.valid/.test(fs.readFileSync(f, 'utf8')));
out(`  routes still on the PIN-signed session: ${old.length}`);
const unlockRoute = files.some((f) => /\/unlock\/route\.ts$/.test(f));
out(`  a route that unlocks an admin's PIN (the first version's per-admin lock): ${unlockRoute}`);

// ─── 9. Who may act on whom ───
out('\n9. A main admin cannot be removed, demoted or given a new PIN by anyone but themselves (Kian, 2026-10-13)');
for (const action of ['remove', 'demote', 'promote', 'set-pin']) {
  const cells = [];
  for (const [label, target] of [['another admin', { self: false, targetIsMain: false }], ['another main admin', { self: false, targetIsMain: true }], ['themselves', { self: true, targetIsMain: true }]]) {
    for (const others of [0, 1]) cells.push(`${label}, ${others} other main admin${others === 1 ? '' : 's'}: ${m.accountVerdict(action, target, others)}`);
  }
  out(`  ${action.padEnd(8)} ${cells.join(' · ')}`);
}
