// Kian's rulings of 2026-11-01 on income (Phase 4), through Nubnb's own pure code:
//   1. A row of a platform's file that becomes no line (no confirmation code, a currency other than CAD, no listing, no
//      amount, no type) counts as a gap: at the top of the Income page for its month, with its amount and why, and in
//      Finish's warnings for that month's statements — the empty-month finish included — until an admin places it with
//      a typed line or marks it "not Nubnb's money" with a reason.
//   2. When a later file repeats a rejected line's row, the upload names it ("1 row was rejected before and stays
//      rejected") instead of "already in".
//   3. A row placed with a typed line is a gap again when that line is deleted from the draft: the draft save sets the
//      decision back to null and logs 'reopened', in its own transaction (section 8, the app's own server code on the
//      in-memory Firestore of tests/tools/memory-firestore.cjs).
// Made-up data only: titles "__TEST__ …", booking codes HMTEST…, properties TESTPROP…. Nothing is read from or written
// to production.
//   node --import ./tests/tools/ts-hook.mjs tests/income/unread.mjs
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.NUBNB_ROOT || fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
createRequire(`${ROOT}/package.json`)(`${ROOT}/tests/tools/memory-firestore.cjs`);
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2_048 });
process.env.FIREBASE_SERVICE_ACCOUNT_KEY = JSON.stringify({ type: 'service_account', project_id: 'memory-test', private_key_id: 'memory-test', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), client_email: 'memory-test@memory-test.iam.gserviceaccount.com', client_id: '1', token_uri: 'https://oauth2.googleapis.com/token' });
process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET = 'memory-test.appspot.com';
process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = 'memory-test';
const { readerFor } = await import(`${ROOT}/app/lib/income/platforms.ts`);
const inc = await import(`${ROOT}/app/lib/income/model.ts`);
const mv = await import(`${ROOT}/app/lib/income/month.ts`);
const st = await import(`${ROOT}/app/lib/reports/statement.ts`);
const { finishChecks } = await import(`${ROOT}/app/lib/reports/checks.ts`);
const { emptyMonth } = await import(`${ROOT}/app/lib/reports/empty.ts`);
const sc = await import(`${ROOT}/app/lib/income/schemas.ts`);

let failures = 0;
const check = (ok, label) => {
  if (!ok) failures += 1;
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${label}`);
};
const sha = (text) => createHash('sha256').update(text).digest('hex');
const P = (n) => `TESTPROP${String(n).padStart(4, '0')}`;
const AT = '2026-12-02T15:00:00.000Z';
const ADMIN = { role: 'admin', id: 'TESTADMIN', name: 'Test Admin' };

// ═══ 1. The reader: what identifies a row that becomes no line ═══
console.log('═══ 1. A file with rows that become no line: each kept with what identifies it ═══');
const header = 'Date,Arriving by date,Type,Confirmation Code,Booking date,Start date,End date,Nights,Guest,Listing,Details,Reference code,Currency,Amount,Paid out,Service fee,Fast Pay fee,Cleaning fee,Gross earnings,Airbnb remitted tax,Earnings year';
const row = (date, type, code, start, end, nights, listing, currency, amount) => `${date},,${type},${code},11/01/2026,${start},${end},${nights},__TEST__ Guest,${listing},,,${currency},${amount},,0.00,,0.00,${amount},0.00,2026`;
const file = [
  header,
  '11/26/2026,11/26/2026,Payout,,,,,,,,__TEST__ made-up payout,,CAD,,268.88,,,,,,2026',
  row('11/26/2026', 'Adjustment', '', '11/02/2026', '11/05/2026', '3', '__TEST__ Pine Loft', 'CAD', '-19.99'),
  row('11/26/2026', 'Reservation', 'HMTESTU1', '11/24/2026', '11/26/2026', '2', '__TEST__ Pine Loft', 'USD', '88.88'),
  row('11/26/2026', 'Reservation', 'HMTESTU2', '11/20/2026', '11/22/2026', '2', '', 'CAD', '100.00'),
  row('11/26/2026', 'Adjustment', '', '11/02/2026', '11/05/2026', '3', '__TEST__ Pine Loft', 'CAD', '-19.99'),
  row('11/26/2026', 'Reservation', 'HMTESTOK', '11/22/2026', '11/24/2026', '2', '__TEST__ Pine Loft', 'CAD', '119.98'),
].join('\n') + '\n';
const read = readerFor('airbnb').read(file);
console.log(`  read: ${read.ok ? `${read.rows} rows · ${read.lines.length} line · ${read.notRead.length} not read · balanced ${read.balanced}` : read.problems.join(' | ')}`);
for (const n of read.notRead) console.log(`    row ${n.row}: ${n.type} · ${n.amountCents} cents ${n.currency} · code "${n.confirmationCode}" · listing "${n.listingTitle}" · stay ${n.stay.start}→${n.stay.end} (${n.stay.nights}) · ${n.why}`);
check(read.ok && read.notRead.length === 4 && read.lines.length === 1 && read.balanced, 'four rows not read, one line, and the file still adds up');
check(read.notRead[0].why === 'no confirmation code' && read.notRead[1].why === 'the currency is USD, not CAD' && read.notRead[2].why === 'no listing', 'each says why');
check(read.notRead[1].confirmationCode === 'HMTESTU1' && read.notRead[1].listingTitle === '__TEST__ Pine Loft' && read.notRead[1].currency === 'USD' && read.notRead[1].stay.start === '2026-11-24', 'each keeps its code, listing, currency and stay');

// ═══ 2. The key: the same row in a later file is the same row; two identical rows in one file are two ═══
console.log('\n═══ 2. Each row under its key ═══');
const key = (r, n = 1) => sha(inc.unreadKeyText('airbnb', r, n));
const [noCode, usd, noListing, noCodeAgain] = read.notRead;
console.log(`  key text: ${inc.unreadKeyText('airbnb', usd)}`);
check(key(noCode) === key(noCodeAgain) && key(noCode) !== key(noCodeAgain, 2), 'two identical rows: the same text, told apart by "|2" as two identical lines are');
check(key(usd) !== key({ ...usd, currency: 'CAD' }) && key(noListing) !== key({ ...noListing, listingTitle: '__TEST__ Pine Loft' }), 'a different currency or listing is a different row');
check(key(noCode) !== key({ ...noCode, stay: { ...noCode.stay, start: '2026-11-03' } }), 'two rows with no code and different stays are never one');
const reread = readerFor('airbnb').read(file);
check(reread.ok && reread.notRead.every((n, i) => key(n) === key(read.notRead[i])), 'the same file read again makes the same keys: nothing is added twice');

// ═══ 3. The month: undecided rows are a gap; decided ones are listed apart ═══
console.log('\n═══ 3. The Income page\'s month: the gap ═══');
const stored = (n, i, decision) => ({ id: key(n, i === 3 ? 2 : 1), schemaVersion: 1, platform: 'airbnb', uploadId: 'TESTUPLOAD0001', fileRow: n.row, payoutDate: n.payoutDate, month: '2026-11', type: n.type, confirmationCode: n.confirmationCode, listingTitle: n.listingTitle, currency: n.currency, stay: n.stay, amountCents: n.amountCents, why: n.why, decision, history: decision ? [{ at: AT, actor: ADMIN, action: decision.kind }] : [], createdAt: AT });
const placed = { kind: 'placed', propertyId: P(1), month: '2026-11', lineId: 'test-line-1', description: 'Revenue - Nov 24–26, 2026 (USD row)', amountCents: 12045, at: AT, actor: ADMIN };
const notOurs = { kind: 'not-ours', reason: 'A test reason: another host\'s money', at: AT, actor: ADMIN };
const unread = [stored(usd, 1, placed), stored(noCode, 0, null), stored(noListing, 2, notOurs), stored(noCodeAgain, 3, null)];
for (const u of unread) check(inc.readEarningsUnread(u.id, u) !== null, `stored row ${u.fileRow} reads back in shape`);
check(inc.readEarningsUnread('x', { ...unread[2], decision: { ...notOurs, reason: '  ' } }) === null, 'a "not Nubnb\'s money" with no reason is not in shape');
check(inc.readEarningsUnread('x', { ...unread[0], decision: { ...placed, lineId: 7 } }) === null, 'a placement with no line ID is not in shape');
const view = mv.monthView({ uploads: [], lines: [], links: [], lastSeen: {}, properties: [], statements: [], calendar: { checkIns: [] }, month: '2026-11', unread });
console.log(`  gaps.unread: ${view.gaps.unread.map((u) => `row ${u.fileRow} ${inc.unreadAmountWords(u)} (${u.why})`).join(' | ')}`);
console.log(`  decided: ${view.unreadDecided.map((u) => `row ${u.fileRow} ${u.decision.kind}`).join(' | ')}`);
check(view.gaps.unread.length === 2 && view.gaps.unread.every((u) => u.decision === null), 'the undecided rows are the gap, each with its amount and why');
check(view.unreadDecided.length === 2, 'a placed row and a row not Nubnb\'s money leave the gap and are listed as decided');
check(inc.unreadAmountWords(unread[0]) === '$88.88 USD' && inc.unreadAmountWords(unread[1]) === '-$19.99', 'an amount is said in its own currency, CAD plain');
check(mv.monthView({ uploads: [], lines: [], links: [], lastSeen: {}, properties: [], statements: [], calendar: { checkIns: [] }, month: '2026-11' }).gaps.unread.length === 0, 'none read: no gap');

// ═══ 4. Finish: every statement of the month warns while one waits ═══
console.log('\n═══ 4. Finish\'s warnings for the month\'s statements ═══');
const record = (id) => ({ id, schemaVersion: 3, propertyId: id, reportFor: { name: 'Test Owner', address: '1 Test St' }, owners: [], statementsFrom: '2026-11', statementsUntil: null, defaultFeeRateBasisPoints: null, defaultFee: null, setAt: AT });
const built = st.buildStatement({ propertyId: P(2), propertyName: '2 Test St', month: '2026-11', entries: [], reports: [], draft: { reference: 'Nov-TEST', reportDate: '2026-12-02', lines: [], fee: null, carried: null, notes: null, supersedes: null }, management: record(P(2)), platformLines: [] });
const warned = (rows) => finishChecks({ statement: built.statement, reports: [], entries: [], income: { waiting: 0, unlinked: [], checkouts: 0, unread: rows }, today: '2026-12-02' }).warnings.filter((w) => w.key === 'file-unread');
const two = warned(view.gaps.unread);
console.log(`  two waiting: ${JSON.stringify(two.map((w) => w.text))}`);
const four = warned([...view.gaps.unread, ...view.gaps.unread]);
console.log(`  four waiting: ${JSON.stringify(four.map((w) => w.text))}`);
const one = warned(view.gaps.unread.slice(0, 1));
console.log(`  one waiting: ${JSON.stringify(one.map((w) => w.text))}`);
check(two.length === 1 && two[0].text.includes('-$19.99 (no confirmation code)') && two[0].tab === 'income', 'the warning names each row with its amount and why, on the Income tab');
check(four.length === 1 && four[0].text.includes(' and 1 more.'), 'more than three: three named, the rest counted');
check(warned([]).length === 0 && finishChecks({ statement: built.statement, reports: [], entries: [], income: { waiting: 0, unlinked: [], checkouts: 0 }, today: '2026-12-02' }).warnings.every((w) => w.key !== 'file-unread'), 'none waiting, or not read: no such warning');

console.log('\n═══ 5. The empty month: no statement of the month is finished empty while a row waits ═══');
const emptyInputs = (rows) => ({
  month: '2026-11',
  today: '2026-12-03',
  properties: [{ id: P(3), name: '3 Test St', internalName: '3 Test St', createdMonth: '2026-11' }],
  management: [record(P(3))],
  reports: [],
  drafts: [],
  entries: [],
  income: { waiting: new Map(), checkInsWithout: new Set(), unsettled: [], unread: rows },
  platformLines: [],
});
const withRow = emptyMonth(emptyInputs(view.gaps.unread));
const without = emptyMonth(emptyInputs([]));
console.log(`  with a row waiting: eligible ${withRow.eligible.length} · left out ${JSON.stringify(withRow.leftOut.map((l) => l.why))}`);
console.log(`  with none: eligible ${without.eligible.length} · left out ${without.leftOut.length}`);
check(withRow.eligible.length === 0 && withRow.leftOut.length === 1 && withRow.leftOut[0].why.includes("Airbnb file"), 'while a row waits, the empty month is left out, with Finish\'s words');
check(without.eligible.length === 1, 'once decided, it can be finished empty again');

// ═══ 6. The decision's request ═══
console.log('\n═══ 6. What the decision route accepts ═══');
for (const [label, body] of [
  ['place', { action: 'place', seen: 0, propertyId: P(1), lineId: 'test-line-1' }],
  ['not ours, with a reason', { action: 'not-ours', seen: 0, reason: '  Another   host\'s money ' }],
  ['not ours, a blank reason', { action: 'not-ours', seen: 0, reason: '   ' }],
  ['place, no line', { action: 'place', seen: 0, propertyId: P(1) }],
  ['a field beyond', { action: 'not-ours', seen: 0, reason: 'x', amount: '1.00' }],
]) {
  const parsed = sc.UnreadDecisionSchema.safeParse(body);
  console.log(`  ${label}: ${parsed.success ? `accepted ${JSON.stringify(parsed.data)}` : 'refused'}`);
}

// ═══ 7. The upload names a repeated rejected row ═══
console.log('\n═══ 7. An upload\'s counts in words ═══');
for (const [label, u] of [
  ['a file repeating one rejected row', { added: 0, duplicates: 1, rejectedBefore: 1 }],
  ['new lines, rows already in, two rejected before', { added: 12, duplicates: 6, rejectedBefore: 2 }],
  ['nothing rejected before', { added: 12, duplicates: 6, rejectedBefore: 0 }],
  ['an upload written before the count', { added: 3, duplicates: 1 }],
]) console.log(`  ${label}: "${inc.uploadCountWords(u)}"`);
check(inc.uploadCountWords({ added: 0, duplicates: 1, rejectedBefore: 1 }) === '0 new lines, 0 already in, 1 row was rejected before and stays rejected', 'the repeated rejected row is named, and not counted as already in');
const upload = { schemaVersion: 1, platform: 'airbnb', month: '2026-11', file: { name: '__TEST__.csv', kind: 'csv', bytes: 1, sha256: 'a', storagePath: 'p', storedBytes: 1, storedSha256: 'b', blanked: ['Guest', 'Details'] }, read: { by: 'csv', rows: 1, payoutRows: 1, lineRows: 1, amountCents: 1, paidOutCents: 1, balanced: true, unbalanced: [] }, titles: [], added: 0, duplicates: 1, outsideMonth: [], notRead: [], uploadedAt: AT, actor: ADMIN };
check(inc.readEarningsUpload('u', { ...upload, rejectedBefore: 1 })?.rejectedBefore === 1 && inc.readEarningsUpload('u', upload)?.rejectedBefore === undefined, 'an upload reads with its count, and one written before reads without it');
check(inc.readEarningsUpload('u', { ...upload, rejectedBefore: 2 }) === null, 'more rejected than already in is not in shape');

// ═══ 8. A placed row's typed line deleted from the draft: the gap comes back ═══
console.log('\n═══ 8. Deleting a placed row\'s typed line from the draft brings its gap back ═══');
const sr = await import(`${ROOT}/app/lib/firebase/server-reports.ts`);
const su = await import(`${ROOT}/app/lib/firebase/server-unread.ts`);
globalThis.__memSeed('properties', P(1), { name: '__TEST__ Pine Loft' });
globalThis.__memSeed('properties', P(2), { name: '__TEST__ Cedar Flat' });
// Three rows waiting: the USD row and the no-listing row go on P1's statement, the no-code row on P2's.
const [rowX, rowY, rowZ] = [stored(usd, 1, null), stored(noListing, 2, null), stored(noCode, 0, null)];
for (const { id, ...fields } of [rowX, rowY, rowZ]) globalThis.__memSeed('earnings_unread', id, fields);
const lineInput = (id, description, rate) => ({ id, description, from: '2026-11-24', to: '2026-11-26', quantity: 1, rate });
const LINE_A = lineInput('test-line-a', 'Revenue - Nov 24–26, 2026 (USD row)', '120.45');
const LINE_B = lineInput('test-line-b', 'Revenue - Nov 20–22, 2026 (no listing)', '100.00');
const LINE_C = lineInput('test-line-c', 'Expense - Supplies', '-19.99');
const draftInput = (propertyId, revision, lines) => sr.DraftInputSchema.parse({ propertyId, month: '2026-11', revision, reference: 'Nov-TEST', reportDate: '2026-12-02', lines, fee: null, carried: null, notes: null, supersedes: null });
const rowState = (row) => {
  const doc = globalThis.__memDoc('earnings_unread', row.id);
  return `${doc.decision === null ? 'undecided' : `${doc.decision.kind} with ${doc.decision.lineId}`} · history ${doc.history.map((e) => e.action).join(', ') || 'none'}`;
};
const unreadReads = () => globalThis.__memReads.filter((r) => r.what === 'earnings_unread').length;
/** Save the draft and say what it did to the rows, and how many times earnings_unread was read for it. */
const save = async (label, propertyId, revision, lines) => {
  const before = unreadReads();
  const saved = await sr.saveDraft(ADMIN, draftInput(propertyId, revision, lines));
  console.log(`  ${label}: ${saved.kind}${saved.kind === 'saved' ? ` at revision ${saved.draft.revision}, ${saved.draft.lines.length} ${saved.draft.lines.length === 1 ? 'line' : 'lines'}` : ''} · earnings_unread read ${unreadReads() - before} time(s)`);
  console.log(`    X ${rowState(rowX)} | Y ${rowState(rowY)} | Z ${rowState(rowZ)}`);
  return { saved, reads: unreadReads() - before };
};
const first = await save('P1 draft with A, B, C', P(1), 0, [LINE_A, LINE_B, LINE_C]);
const other = await save('P2 draft with A (the same line ID on another property)', P(2), 0, [LINE_A]);
check(first.saved.kind === 'saved' && other.saved.kind === 'saved' && first.reads === 0 && other.reads === 0, 'a first save removes nothing and reads no unread row');
const placedX = await su.placeUnread(ADMIN, rowX.id, { seen: 0, propertyId: P(1), lineId: 'test-line-a' }, new Date(AT));
const placedY = await su.placeUnread(ADMIN, rowY.id, { seen: 0, propertyId: P(1), lineId: 'test-line-b' }, new Date(AT));
const placedZ = await su.placeUnread(ADMIN, rowZ.id, { seen: 0, propertyId: P(2), lineId: 'test-line-a' }, new Date(AT));
console.log(`  placed: X ${placedX.kind} | Y ${placedY.kind} | Z ${placedZ.kind}`);
console.log(`    X ${rowState(rowX)} | Y ${rowState(rowY)} | Z ${rowState(rowZ)}`);
check([placedX, placedY, placedZ].every((p) => p.kind === 'decided'), 'three rows placed: X with A and Y with B on P1, Z with A on P2');
const kept = await save('P1 saved keeping A, B, C', P(1), 1, [LINE_A, LINE_B, LINE_C]);
check(kept.saved.kind === 'saved' && kept.reads === 0 && rowState(rowX) === 'placed with test-line-a · history placed' && rowState(rowY) === 'placed with test-line-b · history placed', 'a save keeping the lines reads no unread row and changes none');
const unrelated = await save('P1 saved without C (no row placed with it)', P(1), 2, [LINE_A, LINE_B]);
check(unrelated.saved.kind === 'saved' && unrelated.reads === 1 && rowState(rowX) === 'placed with test-line-a · history placed' && rowState(rowY) === 'placed with test-line-b · history placed', 'removing a typed line no row was placed with reads the placed rows once and changes none');
const removedA = await save('P1 saved without A', P(1), 3, [LINE_B]);
const afterA = globalThis.__memDoc('earnings_unread', rowX.id);
check(removedA.saved.kind === 'saved' && afterA.decision === null && afterA.history.length === 2 && afterA.history[1].action === 'reopened' && afterA.history[1].actor.id === ADMIN.id, 'removing A sets X back to undecided, with a "reopened" event by the admin after its "placed"');
check(rowState(rowY) === 'placed with test-line-b · history placed' && rowState(rowZ) === 'placed with test-line-a · history placed', 'Y (another line) and Z (the same line ID on another property) are untouched');
const removedB = await save('P1 saved without B as well', P(1), 4, []);
check(removedB.saved.kind === 'saved' && rowState(rowY) === 'undecided · history placed, reopened' && rowState(rowX) === 'undecided · history placed, reopened', 'removing B reopens Y; X, already reopened, gets no second event');
const back = [rowX, rowY, rowZ].map((row) => inc.readEarningsUnread(row.id, globalThis.__memDoc('earnings_unread', row.id)));
check(back.every((row) => row !== null) && back[0].history[1].action === 'reopened', 'a reopened row reads back in shape, its history holding the "reopened" event');
check(inc.readEarningsUnread('x', { ...rowX, history: [{ at: AT, actor: ADMIN, action: 'undone' }] }) === null, 'an action the row cannot have is still not in shape');
const again = mv.monthView({ uploads: [], lines: [], links: [], lastSeen: {}, properties: [], statements: [], calendar: { checkIns: [] }, month: '2026-11', unread: back });
console.log(`  gaps.unread: ${again.gaps.unread.map((u) => `row ${u.fileRow} ${inc.unreadAmountWords(u)} (${u.why})`).join(' | ')} · decided: ${again.unreadDecided.map((u) => `row ${u.fileRow} ${u.decision.kind}`).join(' | ')}`);
check(again.gaps.unread.length === 2 && again.unreadDecided.length === 1 && again.unreadDecided[0].id === rowZ.id, 'the Income page reads X and Y as gaps again and Z as decided, with no change of its own');
check(warned(again.gaps.unread).length === 1 && warned(again.gaps.unread)[0].text.startsWith('2 rows of November\'s Airbnb file are not placed'), 'Finish warns about the two again');
const placedAgain = await su.placeUnread(ADMIN, rowY.id, { seen: 2, propertyId: P(1), lineId: 'test-line-b' }, new Date(AT));
console.log(`  placing Y again with B, now deleted: ${placedAgain.kind}${placedAgain.kind === 'no-such-line' ? ` (${placedAgain.month})` : ''}`);
check(placedAgain.kind === 'no-such-line', 'a reopened row can be decided again, with the history the page now sees; its deleted line is no longer there to place it with');

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`}`);
if (failures) process.exitCode = 1;
