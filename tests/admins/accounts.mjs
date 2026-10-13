// Dispatch 38: admin accounts through Nubnb's own code — names, the PIN rules, the lock, session tokens, PIN hashes,
// and which routes go through the admin door. Made-up keys and PINs only; nothing is read from or written to
// Firestore. The shared PIN is drawn at random here and never printed, so no output can show a real one.
//   node --import ./tests/tools/ts-hook.mjs tests/admins/accounts.mjs
import { createHmac, randomBytes, randomInt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.NUBNB_ROOT || fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const m = await import(`${ROOT}/app/lib/admins/model.ts`);
const pin = await import(`${ROOT}/app/lib/admins/pin.ts`);
const session = await import(`${ROOT}/app/lib/admins/session.ts`);
const { createCleanerToken } = await import(`${ROOT}/app/lib/cleaners/session.ts`);

const out = (...a) => console.log(...a);
const T0 = Date.parse('2026-10-13T20:00:00.000Z');

// ─── 1. Names ───
out('1. Names: cleaned, keyed, refused');
for (const name of ['Kian', '  kian  ', 'KIAN', 'Ana  Maria', 'Ana Maria', '', '   ', 'a/b', '.', '__x__', '__TEST__ Ada', 'x'.repeat(61), 'Zoë']) {
  out(`  ${JSON.stringify(name).padEnd(66)} clean ${JSON.stringify(m.cleanAdminName(name))} key ${JSON.stringify(m.nameKeyOf(name))} problem ${JSON.stringify(m.adminNameProblem(name))}`);
}
out(`  the first main admin: ${m.FIRST_MAIN_ADMIN_NAME}, key ${m.nameKeyOf(m.FIRST_MAIN_ADMIN_NAME)}`);

// ─── 2. PINs ───
out('\n2. PINs: six digits, never too easy; sign-in takes four (the shared PIN) or six');
const easy = ['000000', '111111', '999999', '012345', '123456', '456789', '987654', '543210'];
out(`  too easy: ${[...Array(10).keys()].map(String).flatMap((d) => [d.repeat(6)]).filter(m.isTooEasyPin).length} of one digit; runs ${['012345', '123456', '234567', '345678', '456789', '987654', '876543', '765432', '654321', '543210'].filter(m.isTooEasyPin).length} of 10`);
for (const p of [...easy, '583920', '12345', '1234567', '12a456', '']) out(`  ${JSON.stringify(p).padEnd(10)} new PIN problem ${JSON.stringify(m.newPinProblem(p))} · sign-in shape ${m.SIGN_IN_PIN_PATTERN.test(p)}`);
out(`  sign-in shape of four digits: ${m.SIGN_IN_PIN_PATTERN.test('0429')}; of five: ${m.SIGN_IN_PIN_PATTERN.test('04291')}`);

// ─── 3. The lock ───
out('\n3. The lock: five wrong tries in a row, fifteen minutes from the fifth');
let state = { failedTries: 0, lockedUntil: null };
for (let i = 1; i <= 5; i++) {
  const at = T0 + i * 1000;
  const holding = m.lockHolding(state, at);
  const o = m.afterTry(state, false, at);
  state = o.next;
  out(`  wrong try ${i} at +${i}s: lock before ${holding} → ${o.kind}${o.kind === 'wrong' ? `, ${o.triesLeft} left` : ''}${o.kind === 'locked-now' ? ` until ${o.lockedUntil}` : ''} · stored ${JSON.stringify(state)}`);
}
const fifth = T0 + 5000;
for (const [label, at] of [['sixth try, 1 s later', fifth + 1000], ['14 min 59 s after the fifth', fifth + 899_000], ['15 min after the fifth', fifth + 900_000], ['15 min 1 s after', fifth + 901_000]]) {
  out(`  ${label.padEnd(28)} lock holding: ${m.lockHolding(state, at)}`);
}
const afterLock = m.afterTry(state, false, fifth + 901_000);
out(`  a wrong try once it ended: ${afterLock.kind}, ${afterLock.triesLeft} left · stored ${JSON.stringify(afterLock.next)}`);
const right = m.afterTry({ failedTries: 3, lockedUntil: null }, true, T0);
out(`  a right try after three wrong: ${right.kind} · stored ${JSON.stringify(right.next)}`);
out(`  an unreadable lockedUntil holds nothing: ${m.lockHolding({ failedTries: 0, lockedUntil: 'soon' }, T0)}`);

// ─── 4. Session tokens ───
out('\n4. Session tokens: signed with ADMIN_SESSION_SECRET, never the PIN');
const key = Buffer.alloc(32, 7);
const other = Buffer.alloc(32, 8);
const ID = 'TESTADMINaaaaaaaaaa1';
const token = session.createAdminToken(key, ID, 3, T0);
out(`  token shape: ${token.replace(/\.[A-Za-z0-9_-]{43}$/, '.<mac 43>')}`);
out(`  parsed now:            ${JSON.stringify(session.parseAdminToken(token, key, T0 + 1000))}`);
out(`  another key:           ${session.parseAdminToken(token, other, T0 + 1000)}`);
out(`  MAC changed:           ${session.parseAdminToken(token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'), key, T0 + 1000)}`);
out(`  epoch changed:         ${session.parseAdminToken(token.replace('.3.', '.4.'), key, T0 + 1000)}`);
out(`  24 h exactly:          ${JSON.stringify(session.parseAdminToken(token, key, T0 + 86_400_000))}`);
out(`  24 h and 1 ms:         ${session.parseAdminToken(token, key, T0 + 86_400_001)}`);
out(`  issued 61 s ahead:     ${session.parseAdminToken(token, key, T0 - 61_000)}`);
// The token the admin door made before dispatch 38: `<ms>.<hex HMAC-SHA256(ADMIN_PIN, ms)>`, keyed with the PIN.
const sharedPin = String(randomInt(0, 10_000)).padStart(4, '0');
const oldToken = `${T0}.${createHmac('sha256', sharedPin).update(String(T0)).digest('hex')}`;
out(`  a PIN-signed token of before: shape ${oldToken.replace(/^\d{13}\.[0-9a-f]{64}$/, '<13 digits>.<64 hex>')} → ${session.parseAdminToken(oldToken, key, T0 + 1000)}`);
out(`  a cleaner token:       ${session.parseAdminToken(createCleanerToken(key, ID, 3, T0), key, T0 + 1000)}`);
let threw = null;
try {
  session.createAdminToken(key, 'not-an-id', 1, T0);
} catch (err) {
  threw = err.message;
}
out(`  an ID that is not one: ${threw}`);

// ─── 5. PIN hashes ───
out('\n5. PIN hashes: keyed with ADMIN_PIN_KEY, salted, scrypt; the shared PIN only compared');
const pinKey = randomBytes(32);
const stored = await pin.hashPin(pinKey, '583920');
out(`  stored: scheme ${stored.scheme}, N ${stored.N}, r ${stored.r}, p ${stored.p}, salt ${Buffer.from(stored.salt, 'base64url').length} bytes, hash ${Buffer.from(stored.hash, 'base64url').length} bytes, fields ${Object.keys(stored).sort().join(',')}`);
out(`  holds the PIN as typed: ${JSON.stringify(stored).includes('583920')}`);
out(`  right PIN: ${await pin.pinMatches(pinKey, stored, '583920')} · wrong: ${await pin.pinMatches(pinKey, stored, '583921')} · another key: ${await pin.pinMatches(randomBytes(32), stored, '583920')}`);
const again = await pin.hashPin(pinKey, '583920');
out(`  the same PIN twice: same salt ${again.salt === stored.salt}, same hash ${again.hash === stored.hash}`);
out(`  parameters raised past the ceiling are refused: ${await pin.pinMatches(pinKey, { ...stored, N: 2 ** 21 }, '583920')}; not a power of two: ${await pin.pinMatches(pinKey, { ...stored, N: 40000 }, '583920')}; not a hash at all: ${await pin.pinMatches(pinKey, { state: 'shared' }, '583920')}`);
process.env.ADMIN_PIN = sharedPin;
const nextPin = String((Number(sharedPin) + 1) % 10_000).padStart(4, '0');
out(`  shared PIN: itself ${await pin.sharedPinMatches(sharedPin)}, another four digits ${await pin.sharedPinMatches(nextPin)}, six digits ${await pin.sharedPinMatches(`${sharedPin}00`)}`);
delete process.env.ADMIN_PIN;
out(`  shared PIN unset: ${await pin.sharedPinMatches(sharedPin)}`);
process.env.ADMIN_PIN = 'abcd';
out(`  shared PIN not digits: ${await pin.sharedPinMatches('abcd')}`);
delete process.env.ADMIN_PIN;

// ─── 6. The admin door, route by route ───
out('\n6. Every admin route goes through the door; every admin write has words in the activity log');
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

// ─── 7. Who may act on whom ───
out('\n7. A main admin cannot be removed, demoted or given a new PIN by anyone but themselves (Kian, 2026-10-13)');
for (const action of ['remove', 'demote', 'promote', 'new-pin', 'unlock']) {
  const cells = [];
  for (const [label, target] of [['another admin', { self: false, targetIsMain: false }], ['another main admin', { self: false, targetIsMain: true }], ['themselves', { self: true, targetIsMain: true }]]) {
    for (const others of [0, 1]) cells.push(`${label}, ${others} other main admin${others === 1 ? '' : 's'}: ${m.accountVerdict(action, target, others)}`);
  }
  out(`  ${action.padEnd(8)} ${cells.join(' · ')}`);
}
