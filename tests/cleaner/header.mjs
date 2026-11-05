// The cleaner and handyman apps' top bar (Kian's instruction of 2026-11-05): the first name that opens the name menu
// ("Kian ▾", Sign out). Made-up names only. Nothing is read from or written to production.
//   node --import ./tests/tools/ts-hook.mjs tests/cleaner/header.mjs
import { fileURLToPath } from 'node:url';

const ROOT = process.env.NUBNB_ROOT || fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const home = await import(`${ROOT}/app/lib/cleaner-home.ts`);

let failures = 0;
const check = (ok, label) => {
  if (!ok) failures += 1;
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${label}`);
};

console.log('═══ firstNameOf: the first word of the name the office gave, as typed; none for an empty name ═══');
for (const [name, want] of [
  ['Ana Test', 'Ana'],
  ['  Ben   Example  ', 'Ben'],
  ['Ana\tTest', 'Ana'],
  ['Jean-Luc Test', 'Jean-Luc'],
  ['Zoë Test', 'Zoë'],
  ['Bartholomew', 'Bartholomew'],
  ['__TEST__ Ana abcdef', '__TEST__'],
  ['', null],
  ['   ', null],
  [null, null],
  [undefined, null],
]) {
  const got = home.firstNameOf(name);
  console.log(`    ${JSON.stringify(name) ?? 'undefined'} → ${got === null ? '(none: the bar says "Account")' : got}`);
  check(got === want, `${JSON.stringify(name) ?? 'undefined'}: ${want === null ? 'none' : want}`);
}

console.log(`\n${failures === 0 ? 'every check passed' : `${failures} check(s) FAILED`}`);
if (failures > 0) process.exitCode = 1;
