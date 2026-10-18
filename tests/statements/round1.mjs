// Build round 1 of the property page audit (2026-10-17): Kian's rulings K3–K6 and the Report For sheet, the property
// page's "Next property" list and its month due, through Nubnb's own pure code. Made-up data only: properties
// "TESTPROP…", owners "Test …". Nothing is read from or written to production.
//   node --import ./tests/tools/ts-hook.mjs tests/statements/round1.mjs
import { fileURLToPath } from 'node:url';

const ROOT = process.env.NUBNB_ROOT || fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const model = await import(`${ROOT}/app/lib/reports/model.ts`);
const st = await import(`${ROOT}/app/lib/reports/statement.ts`);
const { finishChecks } = await import(`${ROOT}/app/lib/reports/checks.ts`);
const { emptyMonth } = await import(`${ROOT}/app/lib/reports/empty.ts`);
const mgmt = await import(`${ROOT}/app/lib/firebase/server-management.ts`);
const sheet = await import(`${ROOT}/app/lib/reports/report-for-sheet.ts`);
const queue = await import(`${ROOT}/app/lib/home/property-queue.ts`);
const { owedMonths } = await import(`${ROOT}/app/lib/home/next-step.ts`);
const form = await import(`${ROOT}/app/admin/property/statement-form.ts`);
const editor = await import(`${ROOT}/app/admin/property/editor/model.ts`);

let failures = 0;
const check = (ok, label) => {
  if (!ok) failures += 1;
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${label}`);
};
const P = (n) => `TESTPROP${String(n).padStart(4, '0')}`;
const AT = '2026-10-17T15:00:00.000Z';
const record = (over = {}) => ({ id: P(1), schemaVersion: 3, propertyId: P(1), reportFor: null, owners: [], statementsFrom: '2026-09', statementsUntil: null, defaultFeeRateBasisPoints: null, defaultFee: null, setAt: AT, ...over });
let seq = 0;
const line = (description, cents) => ({ id: `L${++seq}`, description, from: null, to: null, quantity: 1, rateCents: cents, amountCents: cents });
const draftOf = (month, lines = [], extra = {}) => ({ reference: `${model.monthReferenceWord(month)}-TEST`, reportDate: '2026-10-17', lines, fee: null, carried: null, notes: null, supersedes: null, ...extra });
const previous = (month, reference) => ({ id: `TESTREPORT${++seq}`, month, reference, fee: null });

// ═══ 1. K5: the reference stem ═══
console.log('═══ 1. K5: a new statement\'s reference is suggested as <Mon>-<stem> ═══');
for (const month of ['2026-09', '2026-06', '2026-07', '2026-08', '2027-01']) console.log(`   ${month} + "321-John" → ${model.referenceFromStem('321-John', month)}`);
console.log(`   "  321   John " folded → ${model.referenceFromStem('  321   John ', '2026-09')}`);
check(model.referenceFromStem('', '2026-09') === null && model.referenceFromStem(null, '2026-09') === null && model.referenceFromStem('x', 'nope') === null, 'no stem, or no month: no suggestion');
check(st.suggestedReference(previous('2026-08', 'Aug-19-Tannery'), '321-John', '2026-09') === 'Sept-321-John', 'the stem comes before the previous reference');
check(st.suggestedReference(previous('2026-08', 'Aug-19-Tannery'), null, '2026-09') === 'Sept-19-Tannery', 'no stem: the previous reference, its month word swapped (as before)');
check(st.suggestedReference(null, null, '2026-09') === null, 'neither: nothing suggested');
console.log('   stems as typed:');
for (const stem of ['321-John', '', 'Sept-321-John', 'sep-321-john', 'September-321', 'Mar-12', 'Marc-12', 'May-1', 'Maya-1', 'x'.repeat(55), 'x'.repeat(56), 'a\u0007b']) console.log(`     ${JSON.stringify(stem.length > 20 ? `${stem.slice(0, 6)}…(${stem.length})` : stem).padEnd(20)} → ${model.stemProblem(stem) ?? 'fine'}`);
check(model.STATEMENT_LIMITS.REFERENCE_STEM_MAX + 'Sept-'.length <= model.STATEMENT_LIMITS.REFERENCE_MAX, 'the longest stem with the longest month word fits a reference');

// ═══ 2. A new month, as the property page starts it (K5, K6) ═══
console.log('\n═══ 2. A new month on the property page: the stem and the default rate (K6) ═══');
const fresh = form.suggestedTyped(null, record({ referenceStem: '321-John', defaultFeeRateBasisPoints: 2000 }), '2026-09', '2026-10-17');
console.log(`   reference "${fresh.reference}" · fee ${fresh.fee ? `rate "${fresh.fee.rate}", base "${fresh.fee.base}" (typed, never filled)` : 'none'}`);
check(fresh.reference === 'Sept-321-John' && fresh.fee?.rate === '20' && fresh.fee?.base === '', 'stem and rate start the month; the base stays empty');
const bare = form.suggestedTyped(previous('2026-08', 'Aug-19-Tannery'), record(), '2026-09', '2026-10-17');
check(bare.reference === 'Sept-19-Tannery' && bare.fee === null, 'no stem and no rate: the previous reference, no fee (as before)');

// ═══ 3. K3: Finish warns when the revenue share is below zero ═══
console.log('\n═══ 3. K3: the revenue share below zero ═══');
const built = (lines) => st.buildStatement({ propertyId: P(1), propertyName: 'Test Foxdale', month: '2026-09', entries: [], reports: [], draft: draftOf('2026-09', lines), management: record({ reportFor: { name: 'Test Owner', address: '' } }) }).statement;
const checksOf = (s) => finishChecks({ statement: s, reports: [], entries: [], income: { waiting: 0, unlinked: [], checkouts: 0 }, today: '2026-10-17' });
for (const [label, lines] of [
  ['a claw-back alone', [line('Resolution Adjustment - Jul 22–Sep 21, 2026 (paid Sep 7)', -467645)]],
  ['revenue and a larger expense', [line('Revenue - Sep 2–4, 2026', 42486), line('Expense - Repairs', -50000)]],
  ['revenue only', [line('Revenue - Sep 2–4, 2026', 42486)]],
  ['nothing', []],
]) {
  const s = built(lines);
  const c = checksOf(s);
  console.log(`   ${label.padEnd(30)} share ${String(s.payableCents).padStart(8)} · warnings ${c.warnings.map((w) => w.key).join(', ')}`);
}
const negative = checksOf(built([line('Resolution Adjustment', -467645)]));
console.log(`   its words: "${negative.warnings[0].text}" (tab ${negative.warnings[0].tab})`);
check(negative.warnings[0].key === 'negative-share', 'said first among the warnings');
check(!checksOf(built([])).warnings.some((w) => w.key === 'negative-share'), 'a share of zero is not below zero');
check(negative.refusals.length === 0, 'a warning only, never a refusal (only Report For is refused)');

// ═══ 4. The management route: whole from the edit page, in part from the sheet ═══
console.log('\n═══ 4. The management route ═══');
const stored = record({ reportFor: { name: 'Test Owner', address: '1 Test St' }, owners: [{ name: 'Test Owner', email: 'owner@example.test' }], statementsFrom: '2026-10', statementsUntil: '2027-03', defaultFeeRateBasisPoints: 1500, defaultFee: { label: 'Old fee', amountCents: 15000 }, excludedFromReporting: true, referenceStem: 'OLD-1' });
const parse = (body) => mgmt.ManagementInputSchema.safeParse(body);
const partial = parse({ reportFor: { name: '  Test   New Owner ', address: '9 Test Ave\n\nToronto ' }, referenceStem: ' 321 - John ', defaultFeeRate: '20' });
check(partial.success, 'the sheet\'s body (three keys) is taken');
const merged = mgmt.storedManagement(P(1), partial.data, stored, AT);
console.log(`   merged: ${JSON.stringify(merged)}`);
check(merged.owners.length === 1 && merged.statementsFrom === '2026-10' && merged.statementsUntil === '2027-03' && merged.excludedFromReporting === true && merged.defaultFee?.amountCents === 15000, 'owners, months, excluded and the old fee keep what is stored');
check(merged.reportFor.name === 'Test New Owner' && merged.referenceStem === '321 - John' && merged.defaultFeeRateBasisPoints === 2000, 'the three fields as sent, folded');
const none = mgmt.storedManagement(P(2), parse({ reportFor: null, referenceStem: null, defaultFeeRate: null }).data, null, AT);
console.log(`   made from nothing: ${JSON.stringify(none)}`);
check(none.statementsFrom === model.STATEMENTS_FROM_DEFAULT && none.owners.length === 0 && none.statementsUntil === null && !('referenceStem' in none) && !('excludedFromReporting' in none), 'a record made here starts where setReportFor\'s does, its shape unchanged');
const cleared = mgmt.storedManagement(P(1), parse({ referenceStem: null }).data, stored, AT);
check(!('referenceStem' in cleared) && cleared.reportFor.name === 'Test Owner', 'null clears the stem, leaving the rest');
const kept = mgmt.storedManagement(P(1), parse({ defaultFeeRate: '12.5' }).data, stored, AT);
check(kept.referenceStem === 'OLD-1' && kept.defaultFeeRateBasisPoints === 1250, 'a stem left out keeps what is stored');
const whole = parse({ reportFor: null, owners: [], statementsFrom: '2026-09', statementsUntil: null, defaultFeeRate: null, referenceStem: null, excludedFromReporting: false });
check(whole.success, 'the edit page\'s whole body is still taken');
for (const [label, body] of [
  ['a stem with its month', { referenceStem: 'Sept-321-John' }],
  ['an empty stem string', { referenceStem: '   ' }],
  ['a rate of 101', { defaultFeeRate: '101' }],
  ['an unknown key', { stem: 'x' }],
  ['until before from', { statementsFrom: '2026-10', statementsUntil: '2026-09' }],
]) {
  const r = parse(body);
  console.log(`   refused: ${label.padEnd(24)} → ${r.success ? 'TAKEN' : r.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; ')}`);
  if (r.success) failures += 1;
}
const read = model.readPropertyManagement(P(1), { ...merged });
check(read?.referenceStem === '321 - John', 'the stored stem reads back');
check(model.readPropertyManagement(P(1), { ...record(), referenceStem: 7 }) === null, 'a stem that is not text: the record is not in shape');
check(model.readPropertyManagement(P(1), { ...record() })?.referenceStem === undefined, 'a record without one: no stem');

// ═══ 5. The edit page's Statements panel (K5) ═══
console.log('\n═══ 5. The edit page\'s Statements panel ═══');
const draft = editor.managementFromRecord(record({ referenceStem: '321-John' }));
console.log(`   loaded stem "${draft.referenceStem}" · payload ${JSON.stringify(editor.managementPayload(draft))}`);
check(JSON.stringify(editor.managementPayload({ ...editor.emptyManagement(), referenceStem: '321-John' })).includes('"referenceStem":"321-John"'), 'a stem alone keeps the record (it is not cleared as default)');
console.log(`   a stem with its month: ${JSON.stringify(editor.managementPayload({ ...editor.emptyManagement(), referenceStem: 'Aug-321' }))}`);

// ═══ 6. The empty months finished together take the stem too ═══
console.log('\n═══ 6. Empty months together: the reference from the stem ═══');
const empty = emptyMonth({
  month: '2026-09',
  today: '2026-10-17',
  properties: [{ id: P(1), name: 'Test Stem', createdMonth: '2026-09' }, { id: P(2), name: 'Test Plain', createdMonth: '2026-09' }],
  management: [record({ reportFor: { name: 'Test Owner', address: '' }, referenceStem: '321-John' }), record({ id: P(2), propertyId: P(2), reportFor: { name: 'Test Owner Two', address: '' } })],
  reports: [],
  drafts: [],
  entries: [],
  income: { waiting: new Map(), checkInsWithout: new Set(), unsettled: [] },
});
for (const c of empty.eligible) console.log(`   ${c.name}: reference ${c.reference ?? 'none'}`);
check(empty.eligible.find((c) => c.propertyId === P(1))?.reference === 'Sept-321-John' && empty.eligible.find((c) => c.propertyId === P(2))?.reference === null, 'stem gives Sept-321-John; no stem and no statement, none');

// ═══ 7. The Report For sheet's rows ═══
console.log('\n═══ 7. The Report For sheet ═══');
const row = sheet.sheetFieldsOf(record({ reportFor: { name: 'Test Owner', address: '1 Test St\nToronto' }, referenceStem: '321-John', defaultFeeRateBasisPoints: 1250 }));
console.log(`   a row from its record: ${JSON.stringify(row)} · from none: ${JSON.stringify(sheet.sheetFieldsOf(null))}`);
for (const [label, fields] of [
  ['as loaded', row],
  ['an address with no name', { name: '', address: '1 Test St', stem: '', rate: '' }],
  ['a stem with its month', { ...row, stem: 'Sept-321' }],
  ['a rate of 20.555', { ...row, rate: '20.555' }],
  ['seven address lines', { ...row, address: 'a\nb\nc\nd\ne\nf\ng' }],
  ['everything empty', { name: '', address: '', stem: '', rate: '' }],
]) console.log(`   ${label.padEnd(24)} → ${sheet.sheetProblem(fields) ?? 'saves'}${sheet.sheetProblem(fields) ? '' : ` ${JSON.stringify(sheet.sheetPayload(fields))}`}`);
check(sheet.sameSheetRow(row, { name: ' Test  Owner', address: '1 Test St  \nToronto\n', stem: '321-John ', rate: ' 12.5' }), 'spacing that stores the same is no change: nothing is sent');
check(!sheet.sameSheetRow(row, { ...row, rate: '12' }), 'a new rate is a change');

// ═══ 8. Next property: the home's list, walked from the property page ═══
console.log('\n═══ 8. Next property ═══');
const href = (n, tail = '') => `/admin/property?id=${P(n)}${tail}`;
console.log(`   a Next step on the property page keeps its month and tab: ${queue.entryHref(P(1), href(1, '&month=2026-09&tab=details'))}`);
console.log(`   a Next step elsewhere (Schedule) opens the property alone: ${queue.entryHref(P(1), `/admin/schedule?property=${P(1)}`)}`);
console.log(`   another property's address is not taken: ${queue.entryHref(P(1), href(2, '&month=2026-09'))}`);
check(queue.entryHref('TESTPROPab', '/admin/property?id=TESTPROPabc&month=2026-09') === '/admin/property?id=TESTPROPab', 'an ID that is the start of another\'s is not taken for it');
console.log(`   its words: "${queue.queueLabel({ chip: 'Statements blocked', search: ' __TEST__ ', city: null, sort: 'Needs attention' })}"`);
const list = { label: 'Statements blocked · Needs attention', listHref: '/admin?show=blocked', entries: [1, 2, 3].map((n) => ({ id: P(n), name: `Test ${n}`, href: href(n, '&month=2026-09&tab=details') })) };
for (const n of [1, 2, 3, 4]) {
  const at = queue.neighbours(list, P(n));
  console.log(`   ${P(n)}: ${at ? `${at.place} of ${at.total} · previous ${at.previous?.name ?? '-'} · next ${at.next?.name ?? '-'}` : 'not on the list: no bar'}`);
}
check(queue.neighbours(null, P(1)) === null, 'no list kept: no bar');
check(JSON.stringify(queue.parseQueue(JSON.stringify(list))) === JSON.stringify(list), 'the list reads back as written');
for (const [label, raw] of [['not JSON', '{'], ['a list leaving the admin', JSON.stringify({ ...list, listHref: 'https://example.test' })], ['an entry off the property page', JSON.stringify({ ...list, entries: [{ id: 'x', name: 'x', href: '/admin/costs' }] })]]) check(queue.parseQueue(raw) === null, `refused: ${label}`);

// ═══ 9. The month due: the oldest owed and unfinished ═══
console.log('\n═══ 9. The month due on opening ═══');
const statusOf = (pastDue, previousStanding) => ({ tone: pastDue.length ? 'problem' : 'warning', standing: pastDue.length ? 'pastDue' : previousStanding, month: pastDue[0] ?? '2026-09', pastDue, previous: { month: '2026-09', standing: previousStanding } });
for (const [label, status] of [
  ['September due', statusOf([], 'due')],
  ['August past due, September due', statusOf(['2026-08'], 'due')],
  ['July past due, September finished', statusOf(['2026-07'], 'finished')],
  ['nothing owed', statusOf([], 'finished')],
]) console.log(`   ${label.padEnd(36)} → opens on ${owedMonths(status)[0] ?? '2026-10 (the current month)'}`);

console.log(`\n${failures === 0 ? 'all checks pass' : `${failures} check(s) FAILED`}`);
if (failures > 0) process.exit(1);
