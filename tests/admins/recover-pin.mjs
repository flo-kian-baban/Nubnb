// The recovery script's --set-pin (scripts/admin-pin-rules.mjs; Kian's approval of 2026-10-14): its checks against
// the app's own for every four-digit PIN, and its one transaction against an in-memory stand-in for Firestore. Made-up
// IDs, and PINs and codes drawn at random here and printed only as labels, so no output can show a real one; nothing
// is read from or written to Firestore.
//   node --import ./tests/tools/ts-hook.mjs tests/admins/recover-pin.mjs
import { randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.NUBNB_ROOT || fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const rules = await import(`${ROOT}/scripts/admin-pin-rules.mjs`);
const m = await import(`${ROOT}/app/lib/admins/model.ts`);
const pinLib = await import(`${ROOT}/app/lib/admins/pin.ts`);
const { isTooEasyCode } = await import(`${ROOT}/app/lib/cleaners/model.ts`);

const out = (...a) => console.log(...a);
const ALL = Array.from({ length: 10_000 }, (_, n) => String(n).padStart(4, '0'));

const MAIN1 = 'MAIN0000000000000001';
const MAIN2 = 'MAIN0000000000000002';
const MAIN3 = 'MAIN0000000000000003';
const MAIN4 = 'MAIN0000000000000004';
const ADA = 'ADA0000000000000000A';
const GONE = 'GONE0000000000000000';
const AT = '2026-10-14T05:00:00.000Z';
const CREATED_AT = '2026-10-13T22:20:00.000Z';
const LOOKUP = 'ab'.repeat(32);
// Four digits in a row anywhere in the printed text besides the drawn values: never drawn, so a label replaces only a draw.
const FIXED = [MAIN1, MAIN2, MAIN3, MAIN4, ADA, GONE, 'CLEANER0000000000001', 'CLEANER0000000000002', AT, CREATED_AT, '16384', '999999999'];
const NOT_DRAWN = new Set(FIXED.flatMap((text) => [...text.matchAll(/(?=([0-9]{4}))/g)].map((match) => match[1])));

// Distinct PINs and codes, none too easy, drawn at random and known here by their labels only.
const drawn = new Map();
const draw = (label) => {
  for (;;) {
    const pin = String(randomInt(0, 10_000)).padStart(4, '0');
    if (!isTooEasyCode(pin) && !NOT_DRAWN.has(pin) && ![...drawn.values()].includes(pin)) {
      drawn.set(label, pin);
      return pin;
    }
  }
};
const SHARED = draw('shared PIN');
const NEW = draw('new PIN');
const NEW2 = draw('second new PIN');
const ADA_PIN = draw("Ada's PIN");
const OLD4 = draw('old four-digit PIN');
const CODE_NOW = draw('current cleaner code');
const CODE_GONE = draw('retired cleaner code');
const SIX = `6${draw('six-digit middle')}6`;
drawn.set('old six-digit PIN', SIX);
/** Every drawn value in `value` replaced by its label, longest first: no digits of a PIN or code are printed. */
const shown = (value) => {
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const [label, pin] of [...drawn.entries()].sort((a, b) => b[1].length - a[1].length)) text = text.split(pin).join(`<${label}>`);
  return text.split(LOOKUP).join('<lookup key>');
};

// ─── 1. The PIN alone ───
out('1. The PIN alone: the script refuses exactly what the app refuses');
const differ = ALL.filter((pin) => (rules.pinShapeProblem(pin, '') === null) !== (m.pinProblem(pin) === null));
out(`  all 10,000 four-digit PINs: the app's verdict (pinProblem) for ${ALL.length - differ.length}, another for ${differ.length}`);
const tooEasy = ALL.filter(isTooEasyCode);
out(`  too easy: the app's list has ${tooEasy.length}, the script's ${rules.TOO_EASY.size}, the same PINs: ${tooEasy.length === rules.TOO_EASY.size && tooEasy.every((pin) => rules.TOO_EASY.has(pin))}`);
out(`  the script's four-digit pattern is the app's: ${String(rules.PIN_PATTERN) === String(m.PIN_PATTERN)}`);
for (const [label, value] of [['three digits', '123'], ['five digits', '12345'], ["six digits (the night's)", '583920'], ['letters', 'abcd'], ['a space', ' 123'], ['empty', ''], ['a number, not text', 5830], ['too easy (a run)', '4567'], ['too easy (a repeat)', '8888']]) {
  out(`  ${label.padEnd(26)} script: ${JSON.stringify(rules.pinShapeProblem(value, SHARED))} · app: ${JSON.stringify(typeof value === 'string' ? m.pinProblem(value) : 'not text')}`);
}
process.env.ADMIN_PIN = SHARED;
out(`  the shared PIN: script ${JSON.stringify(rules.pinShapeProblem(SHARED, SHARED))} · the app's sharedPinMatches: ${pinLib.sharedPinMatches(SHARED)}`);
out(`  another PIN, the shared one set: script ${JSON.stringify(rules.pinShapeProblem(NEW, SHARED))} · the app's sharedPinMatches: ${pinLib.sharedPinMatches(NEW)}`);
const pairs = [[NEW, NEW], [NEW, NEW2], [NEW, NEW.slice(0, 3)], ['', ''], [SIX, SIX], [SIX, NEW]];
out(`  samePin gives the app's answer for ${pairs.filter(([a, b]) => rules.samePin(a, b) === pinLib.samePin(a, b)).length} of ${pairs.length} pairs`);
const STATES = [{ state: 'own' }, { state: 'readable', value: OLD4 }, { state: 'readable', value: SIX }, { state: 'set', lookup: LOOKUP }, { state: 'shared' }, { state: 'set', lookup: 'xyz' }, null];
out(`  stored PINs as the app shows them: ${JSON.stringify(STATES.map((pin) => rules.viewStateOf(pin)))}`);
out(shown(`  and their index entries: ${JSON.stringify(STATES.map((pin) => rules.indexIdOf(pin)))}`));

// ─── 2. The transaction ───
// An in-memory stand-in for Firestore: a read after a write throws (Firestore refuses it), writes are buffered, and a
// commit is all or nothing — refused whole when a create meets an existing document or an update a missing one.
function standIn(docs) {
  const store = new Map(Object.entries(docs).map(([path, data]) => [path, structuredClone(data)]));
  const db = {
    collection: (name) => ({
      doc: (id) => {
        if (typeof id !== 'string' || id === '' || id.includes('/')) throw new Error('not a document ID');
        return { path: `${name}/${id}` };
      },
    }),
  };
  const snapshot = (path) => {
    const data = store.get(path);
    return { exists: data !== undefined, data: () => structuredClone(data), get: (field) => field.split('.').reduce((o, k) => (o == null ? undefined : o[k]), data) };
  };
  function commit(ops) {
    for (const [op, path] of ops) {
      if (op === 'create' && store.has(path)) throw new Error(`ALREADY_EXISTS ${path}`);
      if (op === 'update' && !store.has(path)) throw new Error(`NOT_FOUND ${path}`);
    }
    // A set writes the whole document, there or not.
    for (const [op, path, data] of ops) {
      if (op === 'delete') store.delete(path);
      else store.set(path, op === 'update' ? { ...store.get(path), ...structuredClone(data) } : structuredClone(data));
    }
  }
  /** A transaction whose reads come from `readFrom` (this store unless given) and whose writes are recorded. */
  function transaction(readFrom = snapshot) {
    const ops = [];
    let reads = 0;
    const tx = {
      get: async (ref) => {
        if (ops.length > 0) throw new Error('a read after a write');
        reads += 1;
        return readFrom(ref.path);
      },
      create: (ref, data) => ops.push(['create', ref.path, data]),
      set: (ref, data) => ops.push(['set', ref.path, data]),
      update: (ref, data) => ops.push(['update', ref.path, data]),
      delete: (ref) => ops.push(['delete', ref.path]),
    };
    return { tx, ops, reads: () => reads };
  }
  return { db, store, snapshot, commit, transaction };
}

const created = { at: CREATED_AT, action: 'created', actor: { role: 'system', id: null, name: 'first sign-in' } };
const world = () => ({
  // Shaped as Kian's document: a PIN chosen under the first version, and that version's lock fields.
  [`admins/${MAIN1}`]: { name: 'Main', level: 'main', pin: { state: 'own', scheme: 'scrypt', salt: 'c2FsdA', hash: 'aGFzaA', N: 16384, r: 8, p: 1 }, sessionEpoch: 2, history: [created], failedTries: 0, lockedUntil: null, schemaVersion: 2 },
  [`admins/${MAIN2}`]: { name: 'Main Two', level: 'main', pin: { state: 'readable', value: OLD4 }, sessionEpoch: 5, history: [created] },
  [`admins/${MAIN3}`]: { name: 'Main Three', level: 'main', pin: { state: 'readable', value: SIX }, sessionEpoch: 1, history: [] },
  [`admins/${MAIN4}`]: { name: 'Main Four', level: 'main', pin: { state: 'set', lookup: LOOKUP }, sessionEpoch: 999_999_999, history: [] },
  [`admins/${ADA}`]: { name: 'Ada', level: 'admin', pin: { state: 'readable', value: ADA_PIN }, sessionEpoch: 1, history: [] },
  [`admin_pins/${OLD4}`]: { adminId: MAIN2, createdAt: AT },
  [`admin_pins/${SIX}`]: { adminId: MAIN3, createdAt: AT },
  [`admin_pins/${LOOKUP}`]: { adminId: MAIN4, createdAt: AT },
  [`admin_pins/${ADA_PIN}`]: { adminId: ADA, createdAt: AT },
  [`cleaner_codes/${CODE_NOW}`]: { cleanerId: 'CLEANER0000000000001', issuedAt: AT, retiredAt: null },
  [`cleaner_codes/${CODE_GONE}`]: { cleanerId: 'CLEANER0000000000002', issuedAt: AT, retiredAt: AT },
});
const writesIn = (ops) => (ops.length === 0 ? 'none' : ops.map(([op, path, data]) => `${op} ${path}${op === 'update' ? ` {${Object.keys(data).join(', ')}}` : op === 'create' || op === 'set' ? ` ${JSON.stringify(data)}` : ''}`).join(' · '));
async function attempt(label, adminId, pin, { write = true, w = standIn(world()) } = {}) {
  const before = JSON.stringify([...w.store.entries()]);
  const t = w.transaction();
  const result = await rules.setOwnPin(w.db, t.tx, { adminId, pin, sharedPin: SHARED, at: AT, write });
  w.commit(t.ops);
  const unchanged = JSON.stringify([...w.store.entries()]) === before;
  out(shown(`  ${label.padEnd(44)} → ${JSON.stringify(result)} · ${t.reads()} reads · writes: ${writesIn(t.ops)}${t.ops.length === 0 ? ` · everything unchanged: ${unchanged}` : ''}`));
  return w;
}

out('\n2. Refused, with nothing written');
await attempt('not four digits', MAIN1, '12345');
await attempt('too easy', MAIN1, '2345');
await attempt('the shared PIN', MAIN1, SHARED);
await attempt("an ordinary admin's PIN", MAIN1, ADA_PIN);
await attempt("another main admin's PIN", MAIN1, OLD4);
await attempt('a current cleaner code', MAIN1, CODE_NOW);
await attempt('a retired cleaner code', MAIN1, CODE_GONE);
await attempt('their PIN already', MAIN2, OLD4);
await attempt('not a main admin', ADA, NEW);
await attempt('no such admin', GONE, NEW);

out('\n3. The dry run: every check, nothing written');
await attempt('a PIN chosen before, a free PIN', MAIN1, NEW, { write: false });

out('\n4. Set');
const w = await attempt('a PIN chosen before (own)', MAIN1, NEW);
const doc = w.store.get(`admins/${MAIN1}`);
out(shown(`    the document: pin ${JSON.stringify(doc.pin)} · pinSetAt ${doc.pinSetAt} · epoch ${doc.sessionEpoch} · history ${JSON.stringify(doc.history.map((e) => [e.action, e.actor.role, e.actor.id, e.actor.name, e.from ?? null]))}`));
out(`    kept as they were: name ${doc.name}, level ${doc.level}, failedTries ${doc.failedTries}, lockedUntil ${doc.lockedUntil}, schemaVersion ${doc.schemaVersion}`);
out(shown(`    the index: ${JSON.stringify(w.store.get(`admin_pins/${NEW}`))} · entries naming them: ${[...w.store.entries()].filter(([path, data]) => path.startsWith('admin_pins/') && data.adminId === MAIN1).length}`));
await attempt('the same again', MAIN1, NEW, { w });
await attempt('another main admin, to the PIN just set', MAIN2, NEW, { w });
const four = await attempt('a readable four-digit PIN', MAIN2, NEW2);
out(shown(`    old entry there: ${four.store.has(`admin_pins/${OLD4}`)} · the new one names: ${four.store.get(`admin_pins/${NEW2}`)?.adminId}`));
const six = await attempt("the night's six digits", MAIN3, NEW2);
out(shown(`    old entry there: ${six.store.has(`admin_pins/${SIX}`)} · the history says from: ${six.store.get(`admins/${MAIN3}`).history.at(-1).from}`));
const evening = await attempt("the evening's lookup key, epoch at its cap", MAIN4, NEW2);
out(`    old entry there: ${evening.store.has(`admin_pins/${LOOKUP}`)} · epoch ${evening.store.get(`admins/${MAIN4}`).sessionEpoch}`);

out('\n4b. A PIN no admin holds any more may be set again (Kian\u2019s ruling of 2026-10-17): an entry left behind is written over');
const left = (adminId) => {
  const w2 = standIn(world());
  w2.store.set(`admin_pins/${NEW}`, { adminId, createdAt: CREATED_AT });
  return w2;
};
const gone = await attempt('an entry naming an admin who is gone', MAIN1, NEW, { w: left(GONE) });
out(shown(`    the entry now names: ${gone.store.get(`admin_pins/${NEW}`)?.adminId} · written at ${gone.store.get(`admin_pins/${NEW}`)?.createdAt}`));
const moved = await attempt('an entry naming Ada, who is on another PIN', MAIN2, NEW, { w: left(ADA) });
out(shown(`    the entry now names: ${moved.store.get(`admin_pins/${NEW}`)?.adminId} · Ada's PIN and entry kept: ${moved.store.get(`admins/${ADA}`).pin.value === ADA_PIN && moved.store.get(`admin_pins/${ADA_PIN}`)?.adminId === ADA}`));
await attempt('an entry naming themselves, on another PIN', MAIN1, NEW, { w: left(MAIN1) });
const back = standIn(world());
const away = back.transaction();
out(shown(`  Main Two moves off their PIN: ${JSON.stringify(await rules.setOwnPin(back.db, away.tx, { adminId: MAIN2, pin: NEW, sharedPin: SHARED, at: AT, write: true }))}`));
back.commit(away.ops);
await attempt('Main Two, back to the PIN they held before', MAIN2, OLD4, { w: back });
await attempt('then Main, to the PIN Main Two held before', MAIN1, NEW, { w: back });

out('\n5. Two at once: the second, which read before the first committed, is refused whole at its commit');
const live = standIn(world());
const before = standIn(world());
const first = live.transaction();
out(shown(`  the first (Main): ${JSON.stringify(await rules.setOwnPin(live.db, first.tx, { adminId: MAIN1, pin: NEW, sharedPin: SHARED, at: AT, write: true }))}`));
const second = live.transaction(before.snapshot);
const secondResult = await rules.setOwnPin(live.db, second.tx, { adminId: MAIN2, pin: NEW, sharedPin: SHARED, at: AT, write: true });
live.commit(first.ops);
const mainTwoBefore = JSON.stringify(live.store.get(`admins/${MAIN2}`));
let verdict = 'accepted';
try {
  live.commit(second.ops);
} catch (err) {
  verdict = err.message.split(' ')[0];
}
out(shown(`  the second (Main Two), from what it read: ${JSON.stringify(secondResult)} · its commit: ${verdict} · Main Two's document unchanged: ${JSON.stringify(live.store.get(`admins/${MAIN2}`)) === mainTwoBefore} · the entry names: ${live.store.get(`admin_pins/${NEW}`)?.adminId}`));
