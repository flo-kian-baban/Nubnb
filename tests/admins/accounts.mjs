// Dispatch 38: admin accounts through Nubnb's own code — names, generated PINs and their lookup keys, the connection
// and its lock, session tokens, the first version's PIN hashes, and which routes go through the admin door. Kian's
// rulings of 2026-10-13 (evening): sign-in by PIN alone, every PIN unique and generated, five wrong PINs from one
// connection lock it for fifteen minutes. Made-up keys, PINs and addresses only (TEST-NET and documentation ranges);
// nothing is read from or written to Firestore. The shared PIN is drawn at random here and never printed, so no
// output can show a real one.
//   node --import ./tests/tools/ts-hook.mjs tests/admins/accounts.mjs
import { createHmac, randomBytes, randomInt, scrypt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.NUBNB_ROOT || fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const m = await import(`${ROOT}/app/lib/admins/model.ts`);
const pin = await import(`${ROOT}/app/lib/admins/pin.ts`);
const { connectionOf } = await import(`${ROOT}/app/lib/admins/connection.ts`);
const session = await import(`${ROOT}/app/lib/admins/session.ts`);
const { createCleanerToken } = await import(`${ROOT}/app/lib/cleaners/session.ts`);

const out = (...a) => console.log(...a);
const T0 = Date.parse('2026-10-13T20:00:00.000Z');
const HEX64 = /^[0-9a-f]{64}$/;

// ─── 1. Names ───
out('1. Names: cleaned, keyed, refused');
for (const name of ['Kian', '  kian  ', 'KIAN', 'Ana  Maria', 'Ana Maria', '', '   ', 'a/b', '.', '__x__', '__TEST__ Ada', 'x'.repeat(61), 'Zoë']) {
  out(`  ${JSON.stringify(name).padEnd(66)} clean ${JSON.stringify(m.cleanAdminName(name))} key ${JSON.stringify(m.nameKeyOf(name))} problem ${JSON.stringify(m.adminNameProblem(name))}`);
}
out(`  the first main admin: ${m.FIRST_MAIN_ADMIN_NAME}, key ${m.nameKeyOf(m.FIRST_MAIN_ADMIN_NAME)}`);

// ─── 2. Generated PINs ───
out('\n2. PINs: generated, six digits, never too easy, never the shared PIN; sign-in takes four (the shared PIN) or six');
out(`  too easy: ${[...Array(10).keys()].map((d) => String(d).repeat(6)).filter(m.isTooEasyPin).length} of one digit; runs ${['012345', '123456', '234567', '345678', '456789', '987654', '876543', '765432', '654321', '543210'].filter(m.isTooEasyPin).length} of 10; 583920 ${m.isTooEasyPin('583920')}`);
for (const p of ['583920', '0429', '04291', '12345', '1234567', '12a456', '']) out(`  ${JSON.stringify(p).padEnd(10)} PIN shape ${m.PIN_PATTERN.test(p)} · sign-in shape ${m.SIGN_IN_PIN_PATTERN.test(p)}`);
let sharedSix;
do sharedSix = String(randomInt(100_000, 1_000_000));
while (m.isTooEasyPin(sharedSix));
process.env.ADMIN_PIN = sharedSix;
const fed = (numbers) => {
  const seen = [];
  const drawn = pin.drawPin(() => {
    const n = numbers.shift();
    seen.push(n === Number(sharedSix) ? '<the shared PIN>' : String(n).padStart(6, '0'));
    return n;
  });
  return `${seen.join(' → ')} gives ${drawn}`;
};
out(`  fed 123456, the shared PIN, 0, 7: ${fed([123456, Number(sharedSix), 0, 7])}`);
out(`  fed 999999, 42:                    ${fed([999999, 42])}`);
const drawnMany = Array.from({ length: 100_000 }, () => pin.drawPin());
out(
  `  100,000 drawn: all six digits ${drawnMany.every((p) => m.PIN_PATTERN.test(p))} · any too easy ${drawnMany.some(m.isTooEasyPin)} · any the shared PIN ${drawnMany.includes(sharedSix)} · every first digit seen ${new Set(drawnMany.map((p) => p[0])).size === 10} · every last digit seen ${new Set(drawnMany.map((p) => p[5])).size === 10}`,
);
delete process.env.ADMIN_PIN;

// ─── 3. Lookup keys ───
out('\n3. Lookup keys: the PIN finds its admin with one hash and one read; the PIN itself is stored nowhere');
const pinKey = randomBytes(32);
const k1 = await pin.pinLookup(pinKey, '583920');
const k2 = await pin.pinLookup(pinKey, '583920');
const k3 = await pin.pinLookup(pinKey, '583921');
const k4 = await pin.pinLookup(randomBytes(32), '583920');
out(`  shape: 64 hex ${HEX64.test(k1)} · holds the PIN as typed ${k1.includes('583920')}`);
out(`  the same PIN twice: same key ${k1 === k2} · the next PIN: same key ${k1 === k3} · another ADMIN_PIN_KEY: same key ${k1 === k4}`);
out(`  scheme ${pin.PIN_LOOKUP_SCHEME}; a lookup key is never a connection's key for the same text: ${k1 !== pin.connectionKey(pinKey, '583920')}`);

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
out('\n5. The lock: five wrong PINs in a row from one connection, fifteen minutes from the fifth');
let state = { failedTries: 0, lockedUntil: null };
for (let i = 1; i <= 5; i++) {
  const at = T0 + i * 1000;
  const holding = m.lockHolding(state, at);
  const o = m.afterTry(state, false, at);
  state = o.next;
  out(`  wrong PIN ${i} at +${i}s: lock before ${holding} → ${o.kind}${o.kind === 'wrong' ? `, ${o.triesLeft} left` : ''}${o.kind === 'locked-now' ? ` until ${o.lockedUntil}` : ''} · stored ${JSON.stringify(state)}`);
}
const fifth = T0 + 5000;
for (const [label, at] of [['sixth try, 1 s later', fifth + 1000], ['14 min 59 s after the fifth', fifth + 899_000], ['15 min after the fifth', fifth + 900_000], ['15 min 1 s after', fifth + 901_000]]) {
  out(`  ${label.padEnd(28)} lock holding: ${m.lockHolding(state, at)}`);
}
const afterLock = m.afterTry(state, false, fifth + 901_000);
out(`  a wrong PIN once it ended: ${afterLock.kind}, ${afterLock.triesLeft} left · stored ${JSON.stringify(afterLock.next)}`);
const right = m.afterTry({ failedTries: 3, lockedUntil: null }, true, T0);
out(`  a right PIN after three wrong: ${right.kind} · stored ${JSON.stringify(right.next)}`);
out(`  an unreadable lockedUntil holds nothing: ${m.lockHolding({ failedTries: 0, lockedUntil: 'soon' }, T0)}`);

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

// ─── 7. The first version's hashes, and the shared PIN ───
out("\n7. A PIN of dispatch 38's first version is checked against its own document only; the shared PIN only compared");
// What the first version stored for a chosen PIN: scrypt(HMAC-SHA256(ADMIN_PIN_KEY, label + PIN)), its own random salt.
const firstVersionHash = (key, p) =>
  new Promise((resolve, reject) => {
    const salt = randomBytes(16);
    const keyed = createHmac('sha256', key).update(`nubnb:admin-pin:v1:${p}`, 'utf8').digest();
    scrypt(keyed, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, hash) =>
      err ? reject(err) : resolve({ state: 'own', scheme: 'scrypt-hmac-v1', N: 32768, r: 8, p: 1, salt: salt.toString('base64url'), hash: hash.toString('base64url') }),
    );
  });
const stored = await firstVersionHash(pinKey, '583920');
out(`  right PIN: ${await pin.pinMatches(pinKey, stored, '583920')} · wrong: ${await pin.pinMatches(pinKey, stored, '583921')} · another key: ${await pin.pinMatches(randomBytes(32), stored, '583920')}`);
out(`  parameters past the ceiling are refused: ${await pin.pinMatches(pinKey, { ...stored, N: 2 ** 21 }, '583920')}; not a power of two: ${await pin.pinMatches(pinKey, { ...stored, N: 40000 }, '583920')}; a lookup, not a hash: ${await pin.pinMatches(pinKey, { state: 'set', scheme: 'lookup-v1', lookup: k1 }, '583920')}`);
process.env.ADMIN_PIN = sharedPin;
const nextPin = String((Number(sharedPin) + 1) % 10_000).padStart(4, '0');
out(`  shared PIN: itself ${pin.sharedPinMatches(sharedPin)}, another four digits ${pin.sharedPinMatches(nextPin)}, six digits ${pin.sharedPinMatches(`${sharedPin}00`)}`);
delete process.env.ADMIN_PIN;
out(`  shared PIN unset: ${pin.sharedPinMatches(sharedPin)}`);
process.env.ADMIN_PIN = 'abcd';
out(`  shared PIN not digits: ${pin.sharedPinMatches('abcd')}`);
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
for (const action of ['remove', 'demote', 'promote', 'new-pin']) {
  const cells = [];
  for (const [label, target] of [['another admin', { self: false, targetIsMain: false }], ['another main admin', { self: false, targetIsMain: true }], ['themselves', { self: true, targetIsMain: true }]]) {
    for (const others of [0, 1]) cells.push(`${label}, ${others} other main admin${others === 1 ? '' : 's'}: ${m.accountVerdict(action, target, others)}`);
  }
  out(`  ${action.padEnd(8)} ${cells.join(' · ')}`);
}
