// Duplicate codes and PINs in stored data (scripts/lib/duplicates.mjs; Kian's ruling of 2026-11-06, item 1): found by
// role and name only. Made-up accounts and values, printed as labels only; nothing is read from or written to anything.
//   node tests/security/duplicates.mjs
import { randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.NUBNB_ROOT || fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const d = await import(`${ROOT}/scripts/lib/duplicates.mjs`);
const out = (...a) => console.log(...a);
const drawn = [];
const draw = () => {
  for (;;) {
    const v = String(randomInt(0, 10_000)).padStart(4, '0');
    if (!drawn.includes(v)) {
      drawn.push(v);
      return v;
    }
  }
};
const A = draw();
const B = draw();
const C = draw();
const SHARED = draw();
const cleaners = [
  { id: 'c1', name: 'Test Ana', role: 'cleaner', status: 'active', code: A },
  { id: 'c2', name: 'Test Ben', role: 'handyman', status: 'active', code: B },
  { id: 'c3', name: 'Test Cleo', role: 'cleaner', status: 'inactive', code: null },
  { id: 'c4', name: 'Test Dan', status: 'active', code: 'abcd' },
];
const admins = [
  { id: 'a1', name: 'Test Main', level: 'main', pin: { state: 'readable', value: C } },
  { id: 'a2', name: 'Test Shared', level: 'main', pin: { state: 'shared' } },
  { id: 'a3', name: 'Test Six', level: 'admin', pin: { state: 'readable', value: `${C}00` } },
];
const say = (found) => {
  out(`  clean ${found.clean} · counts ${JSON.stringify(found.counts)}`);
  for (const line of d.duplicateLines(found)) out(`  ${line}`);
};

out('1. Unique: every code and PIN its own');
say(d.findDuplicates(cleaners, admins, SHARED));

out('\n2. A code held by two accounts (one of them inactive): found by role and name');
say(d.findDuplicates([...cleaners, { id: 'c5', name: 'Test Eve', role: 'cleaner', status: 'inactive', code: A }], admins, SHARED));

out('\n3. A PIN held by two admins');
say(d.findDuplicates(cleaners, [...admins, { id: 'a4', name: 'Test Twin', level: 'admin', pin: { state: 'readable', value: C } }], SHARED));

out('\n4. A code that is an admin PIN');
say(d.findDuplicates(cleaners, [...admins, { id: 'a5', name: 'Test Clash', level: 'admin', pin: { state: 'readable', value: B } }], SHARED));

out('\n5. The shared PIN held as a code, and as a PIN');
say(d.findDuplicates([...cleaners, { id: 'c6', name: 'Test Fay', role: 'cleaner', status: 'active', code: SHARED }], [...admins, { id: 'a6', name: 'Test Gus', level: 'admin', pin: { state: 'readable', value: SHARED } }], SHARED));

out('\n6. No shared PIN given: only the four kinds among accounts');
say(d.findDuplicates(cleaners, admins, null));
const everything = JSON.stringify([d.findDuplicates(cleaners, admins, SHARED), d.duplicateLines(d.findDuplicates([...cleaners, { id: 'c5', name: 'Test Eve', role: 'cleaner', status: 'inactive', code: A }], admins, SHARED))]);
out(`\n7. No value in any finding: ${drawn.every((v) => !everything.includes(v))}`);
