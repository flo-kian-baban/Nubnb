// The context of a four-digit run (scripts/lib/code-context.mjs; Kian's ruling of 2026-11-06, item 3): what the
// commit-tree scan blocks and what it only reports. Made-up values only, drawn at random
// here and printed as labels, so no output can show a real code; nothing is read from or written to anything.
//   node tests/security/code-context.mjs
import { randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.NUBNB_ROOT || fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const cc = await import(`${ROOT}/scripts/lib/code-context.mjs`);

const out = (...a) => console.log(...a);
// A made-up value that is not easy, not a year, and all hex digits (so it can stand in a colour and a UUID too).
let V;
do V = String(randomInt(1000, 9999));
while (cc.isEasyCode(V) || /^(19|20)\d{2}$/.test(V) || !/^[0-9]{4}$/.test(V));
const EASY = '7777';
const YEAR = '2026';
// Every four-digit run in a printed line is a label: the drawn value, the easy one, the year, or <n> for any other.
const show = (s) => s.split(V).join('<V>').split(EASY).join('<EASY>').replace(/(?<![0-9])\d{4}(?![0-9])/g, (m) => (m === YEAR ? m : '<n>'));

out('1. One standalone four-digit run, by where it stands (V is a made-up code; EASY an easy one; the year is a year)');
const cases = [
  // code-like
  [`const code = '${V}';`, V, {}, 'code-like', 'a line about codes or PINs'],
  [`  the PIN ${V} was set`, V, {}, 'code-like', 'a line about codes or PINs'],
  [`cleaner_codes/${V}`, V, {}, 'code-like', 'a line about codes or PINs'],
  [`['0000', '${EASY}', '1234']`, EASY, {}, 'code-like', 'an easy-code list'],
  [`color: #${V};`, V, { path: 'tests/expected/x.txt' }, 'code-like', 'a test'],
  [`color: #${V};`, V, { path: 'app/tests/x.css' }, 'code-like', 'a test'],
  [`color: #${V};`, V, { path: 'NOTES.md' }, 'code-like', 'a document'],
  [`color: #${V};`, V, { message: true }, 'code-like', 'the commit message'],
  [`  amount: ${V},`, V, {}, 'code-like', 'unclassified'],
  [`$${V}.00`, V, {}, 'code-like', 'unclassified'],
  [`width: ${V}px;`, V, {}, 'code-like', 'unclassified'],
  [`setTimeout(fn, ${V}ms)`, V, {}, 'code-like', 'unclassified'],
  [`[4811, ${V}, 4813]`, V, {}, 'code-like', 'unclassified'],
  [`in ${YEAR} we`, YEAR, {}, 'code-like', 'unclassified'],
  [`${V}`, V, {}, 'code-like', 'unclassified'],
  // incidental
  [`color: #${V};`, V, {}, 'incidental', 'a hex colour'],
  [`border: 1px solid #${V}ab;`, V, {}, 'incidental', 'a hex colour'],
  [`background: #a1${V};`, V, {}, 'incidental', 'a hex colour'],
  [`#${V}c0de`, V, {}, 'incidental', 'a hex colour'],
  [`const id = 'TESTPROP${V}a001';`, V, {}, 'incidental', 'inside an ID or hash'],
  [`abc${V}def`, V, {}, 'incidental', 'inside an ID or hash'],
  [`v${V}`, V, {}, 'incidental', 'inside an ID or hash'],
  [`run_${V}`, V, {}, 'incidental', 'inside an ID or hash'],
  [`e3b0c442-98fc-${V}-b9a2-27ae41e4649b`, V, {}, 'incidental', 'inside an ID or hash'],
  [`sha ${V}f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2`, V, {}, 'incidental', 'inside an ID or hash'],
  [`${YEAR}-11-06`, YEAR, {}, 'incidental', 'a date'],
  [`at ${YEAR}-11-06T14:30:00.000Z`, YEAR, {}, 'incidental', 'a date'],
  [`${YEAR}-11`, YEAR, {}, 'incidental', 'a date'],
  [`06/11/${YEAR}`, YEAR, {}, 'incidental', 'a date'],
  [`Nov 6, ${YEAR}`, YEAR, {}, 'incidental', 'a date'],
  [`6 November ${YEAR}`, YEAR, {}, 'incidental', 'a date'],
  [`${YEAR} Oct`, YEAR, {}, 'incidental', 'a date'],
  [`14:30:00+0${V.slice(1, 2)}30`, `0${V.slice(1, 2)}30`, {}, 'incidental', 'a time zone offset'],
  // the word rule outranks the structural ones
  [`/* the code screen */ color: #${V};`, V, {}, 'code-like', 'a line about codes or PINs'],
  [`PIN set ${YEAR}-11-06`, YEAR, {}, 'code-like', 'a line about codes or PINs'],
];
let wrong = 0;
for (const [line, value, where, kind, context] of cases) {
  const start = line.indexOf(value);
  const got = cc.classifyRun(line, start, start + 4, where);
  const ok = got.kind === kind && got.context === context;
  if (!ok) wrong += 1;
  out(`  ${ok ? 'ok  ' : 'FAIL'} ${show(line).padEnd(50)} ${where.path ? `in ${where.path} ` : where.message ? 'in a message ' : ''}→ ${got.kind}, ${got.context}`);
}
out(`  wrong verdicts: ${wrong}`);

out('\n2. findRuns: every run of the wanted values in a text, with its line and verdict (the value itself is never printed by the scripts)');
const text = [`/* colours */`, `.a { color: #${V}; }`, `const code = '${V}'; // the code`, `const other = '1234';`, `const id = 'ID${V}x';`, `// ${YEAR}-11-06`].join('\n');
const hits = cc.findRuns(text, [V, YEAR], { path: 'app/x.css' });
for (const h of hits) out(`  line ${h.line}: ${h.value === V ? 'V' : h.value === YEAR ? 'the year' : '?'} → ${h.kind}, ${h.context}`);
out(`  ${hits.length} hits; blocking ${hits.filter((h) => h.kind === 'code-like').length}; reported ${hits.filter((h) => h.kind === 'incidental').length}`);
const inTests = cc.findRuns(text, [V], { path: 'tests/x.mjs' });
out(`  the same text under tests/: ${inTests.length} hits, all code-like: ${inTests.every((h) => h.kind === 'code-like' && h.context === 'a test')}`);

out('\n3. The easy list');
const ALL = Array.from({ length: 10_000 }, (_, n) => String(n).padStart(4, '0'));
out(`  easy codes: ${ALL.filter(cc.isEasyCode).length} of 10,000; V easy: ${cc.isEasyCode(V)}`);
out(`  a text buffer: ${cc.isTextBuffer(Buffer.from('plain text'))}; a binary one: ${cc.isTextBuffer(Buffer.from([0x89, 0x50, 0x00, 0x47]))}`);
process.exit(wrong === 0 ? 0 : 1);
