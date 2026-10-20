// Runs every check in tests/ and compares what it prints, byte for byte, with tests/expected/<name>.txt.
// Made-up data only; nothing is read from or written to Firestore or Storage.
//   node tests/run.mjs              run all; exit 1 if any output differs
//   node tests/run.mjs <name> …     run some
//   node tests/run.mjs --update     write what each prints as its expected output (only after reading the diff)
// NUBNB_ROOT runs the checks against another copy of the code, to compare two versions.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const hook = path.join(here, 'tools/ts-hook.mjs');

export const CHECKS = [
  { name: 'corrections-acceptance', script: 'money/corrections.mjs', args: ['acceptance'] },
  { name: 'corrections-chains', script: 'money/corrections.mjs', args: ['chains'] },
  { name: 'office-month', script: 'money/office-month.mjs', args: [] },
  { name: 'ledger', script: 'money/ledger.mjs', args: [] },
  { name: 'month-money', script: 'money/month-money.mjs', args: [] },
  { name: 'cleanings', script: 'money/cleanings.mjs', args: [] },
  { name: 'airbnb-file', script: 'money/airbnb-file.mjs', args: [] },
  { name: 'admin-accounts', script: 'admins/accounts.mjs', args: [] },
  { name: 'admin-recover-pin', script: 'admins/recover-pin.mjs', args: [] },
  { name: 'cleaning-jobs', script: 'schedule/jobs.mjs', args: [] },
  { name: 'calendar-refresh', script: 'availability/refresh-state.mjs', args: [] },
  { name: 'pay-balance', script: 'pay/balance.mjs', args: [] },
  { name: 'property-columns', script: 'home/columns.mjs', args: [] },
  { name: 'home-next-step', script: 'home/next-step.mjs', args: [] },
  { name: 'direct-payments', script: 'direct/payments.mjs', args: [] },
  { name: 'internal-names', script: 'names/internal-names.mjs', args: [] },
  { name: 'cleaner-home', script: 'cleaner/home.mjs', args: [] },
  { name: 'statements-round1', script: 'statements/round1.mjs', args: [] },
  { name: 'income-one-pass', script: 'money/income-one-pass.mjs', args: [] },
  { name: 'owner-files', script: 'money/owner-files.mjs', args: [] },
  { name: 'costs-month', script: 'money/costs-month.mjs', args: [] },
  { name: 'costs-queue', script: 'money/costs-queue.mjs', args: [] },
  { name: 'costs-look', script: 'money/costs-look.mjs', args: [] },
  { name: 'schedule-round1', script: 'schedule/round1.mjs', args: [] },
  { name: 'cleaning-prices', script: 'money/cleaning-prices.mjs', args: [] },
  { name: 'team-round1', script: 'pay/round1.mjs', args: [] },
  { name: 'availability-round1', script: 'availability/round1.mjs', args: [] },
];

const argv = process.argv.slice(2);
const update = argv.includes('--update');
const only = argv.filter((a) => !a.startsWith('--'));
const unknown = only.filter((n) => !CHECKS.some((c) => c.name === n));
if (unknown.length > 0) {
  console.error(`unknown check(s): ${unknown.join(', ')}`);
  process.exit(2);
}

let failed = 0;
for (const check of CHECKS.filter((c) => only.length === 0 || only.includes(c.name))) {
  const r = spawnSync(process.execPath, ['--import', hook, path.join(here, check.script), ...check.args], { encoding: 'utf8', env: process.env, maxBuffer: 64 * 1024 * 1024 });
  const expectedFile = path.join(here, 'expected', `${check.name}.txt`);
  if (r.status !== 0) {
    failed += 1;
    console.log(`FAIL ${check.name}: exit ${r.status}\n${r.stderr}`);
    continue;
  }
  if (update) {
    fs.writeFileSync(expectedFile, r.stdout);
    console.log(`wrote ${path.relative(process.cwd(), expectedFile)} (${Buffer.byteLength(r.stdout)} bytes)`);
    continue;
  }
  const expected = fs.existsSync(expectedFile) ? fs.readFileSync(expectedFile, 'utf8') : null;
  if (expected === r.stdout) {
    console.log(`ok   ${check.name} (${Buffer.byteLength(r.stdout)} bytes, identical)`);
    continue;
  }
  failed += 1;
  if (expected === null) {
    console.log(`FAIL ${check.name}: no expected output (${path.relative(process.cwd(), expectedFile)})`);
    continue;
  }
  const a = expected.split('\n');
  const b = r.stdout.split('\n');
  const shown = [];
  for (let i = 0; i < Math.max(a.length, b.length) && shown.length < 40; i += 1) {
    if (a[i] === b[i]) continue;
    if (a[i] !== undefined) shown.push(`  line ${i + 1} expected: ${a[i]}`);
    if (b[i] !== undefined) shown.push(`  line ${i + 1} printed:  ${b[i]}`);
  }
  console.log(`FAIL ${check.name}: differs from ${path.relative(process.cwd(), expectedFile)}\n${shown.join('\n')}`);
}
if (!update) console.log(failed === 0 ? 'all identical' : `${failed} check(s) differ`);
process.exit(failed === 0 ? 0 : 1);
