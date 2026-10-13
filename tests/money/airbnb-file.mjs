// Dispatch 37C: October's Airbnb file through Nubnb's own pure code — the reader, the lines read where they are stored,
// the statements that place them, the Income page's view, Finish's checks, renames and what the routes accept.
// Made-up data only: dispatch 36's made-up October file (tests/fixtures/airbnb-october-d36.csv) and variants of it,
// a made-up property "TESTPROPairbnbfile01", made-up booking codes HMTEST…. Nothing is read from or written to
// production.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.NUBNB_ROOT || fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const model = await import(`${ROOT}/app/lib/reports/model.ts`);
const st = await import(`${ROOT}/app/lib/reports/statement.ts`);
const { statementPdf } = await import(`${ROOT}/app/lib/reports/statement-pdf.ts`);
const { finishChecks, uncoveredStays, checkoutsInMonth } = await import(`${ROOT}/app/lib/reports/checks.ts`);
const { emptyMonth } = await import(`${ROOT}/app/lib/reports/empty.ts`);
const money = await import(`${ROOT}/app/lib/money/month.ts`);
const { formatCents: $, ADMIN_ACTOR } = await import(`${ROOT}/app/lib/cleaners/model.ts`);
const inc = await import(`${ROOT}/app/lib/income/model.ts`);
const { readerFor } = await import(`${ROOT}/app/lib/income/platforms.ts`);
const mv = await import(`${ROOT}/app/lib/income/month.ts`);
const sc = await import(`${ROOT}/app/lib/income/schemas.ts`);
const { UpdatePropertySchema } = await import(`${ROOT}/app/lib/api/schemas.ts`);

const P = 'TESTPROPairbnbfile01';
const Q = 'TESTPROPairbnbfile02';
const sha = (text) => createHash('sha256').update(text).digest('hex');
const read = (text) => readerFor('airbnb').read(text);
const pdfStrings = (bytes) =>
  [...Buffer.from(bytes).toString('latin1').matchAll(/\((.*?)\) Tj/g)].map((m) =>
    m[1]
      .replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)))
      .replace(/\\(.)/g, '$1')
      // WinAnsiEncoding's en dash and middle dot, as the PDF writes them.
      .replace(/\x96/g, '–')
      .replace(/\xb7/g, '·'),
  );
let seq = 0;

// ═══ 1. The reader, on dispatch 36's made-up October file and its variants ═══
console.log("═══ 1. The reader · dispatch 36's made-up October file and its variants ═══");
const BASE = readFileSync(`${ROOT}/tests/fixtures/airbnb-october-d36.csv`, 'utf8');
const [HEADER, PAYOUT, RESERVATION] = BASE.split('\n').filter((line) => line !== '');
const cells = (line) => line.split(',');
const header = cells(HEADER);
const col = (name) => header.indexOf(name);
/** The reservation row with fields changed, by column name. */
const rowWith = (base, changes) => {
  const c = cells(base);
  for (const [name, value] of Object.entries(changes)) c[col(name)] = value;
  return c.join(',');
};
const file = (...rows) => [HEADER, ...rows].join('\n') + '\n';
const show = (label, text) => {
  const r = read(text);
  if (!r.ok) {
    console.log(`  ${label}: refused · ${r.problems.join(' | ')}`);
    return r;
  }
  const lines = r.lines.map((l) => `row ${l.row} ${l.type} ${l.confirmationCode} "${l.listingTitle}" ${$(l.amountCents)} stay ${l.stay.start}..${l.stay.end} · known ${inc.isKnownType('airbnb', l.type)}`);
  console.log(`  ${label}: ${r.rows} rows · ${lines.length} line(s) · paid out ${$(r.paidOutCents)} · rows ${$(r.amountCents)} · balanced ${r.balanced} (checked by ${r.checkedBy})${r.notRead.length ? ` · not read: ${r.notRead.map((n) => `row ${n.row} ${n.why}`).join('; ')}` : ''}`);
  for (const l of lines) console.log(`    ${l}`);
  return r;
};

const base = show('the file as dispatch 36 made it', BASE);
console.log(`    kept copy: blanked ${JSON.stringify(base.blankedColumns)} · holds the guest's name ${base.blanked.includes('__TEST__ Guest')} · holds the payout's details ${base.blanked.includes('made-up payout')} · sha ${sha(base.blanked).slice(0, 16)}`);
const keyOf = (line, occurrence) => inc.lineKeyText('airbnb', line, occurrence);
console.log(`    its line's key: ${keyOf(base.lines[0])}`);

// Identical rows: two payments (Kian's ruling of 2026-10-13).
const twice = show('A · two identical reservation rows under one payout of $642.00', file(rowWith(PAYOUT, { 'Paid out': '642.00' }), RESERVATION, RESERVATION));
console.log(`    keys, in the file's order: ${keyOf(twice.lines[0], 1)}  and  ${keyOf(twice.lines[1], 2)} (different: ${sha(keyOf(twice.lines[0], 1)) !== sha(keyOf(twice.lines[1], 2))})`);
console.log(`    the same file again makes the same two keys, so it adds nothing; the first key is the one dispatch 36's file made: ${keyOf(twice.lines[0], 1) === keyOf(base.lines[0])}`);

// A changed amount: a later file with the same booking at another amount.
const changedAmount = show('B · the same booking in a later file at $300.00', file(rowWith(PAYOUT, { 'Paid out': '300.00' }), rowWith(RESERVATION, { Amount: '300.00', 'Gross earnings': '300.00' })));
console.log(`    its key differs from the first file's: ${keyOf(changedAmount.lines[0]) !== keyOf(base.lines[0])} · same code, day and type: ${changedAmount.lines[0].confirmationCode === base.lines[0].confirmationCode && changedAmount.lines[0].payoutDate === base.lines[0].payoutDate}`);

// An unknown row type: kept as a line with its listing, code and stay; it needs a decision.
const tot = rowWith(RESERVATION, { Type: 'Pass Through Tot', Amount: '12.50', 'Gross earnings': '', 'Service fee': '', 'Cleaning fee': '' });
const unknown = show('C · a "Pass Through Tot" row beside the reservation', file(rowWith(PAYOUT, { 'Paid out': '333.50' }), RESERVATION, tot));
const totLine = unknown.lines.find((l) => l.type === 'Pass Through Tot');
console.log(`    its label: "${inc.proposedLabel({ ...totLine, month: '2026-10' })}" · the reservation's: "${inc.proposedLabel({ ...unknown.lines[0], month: '2026-10' })}"`);

// A renamed Guest column: refused, nothing kept with the guests' names. In capitals or not, it is recognised.
show('D · the Guest column renamed "Guest name"', BASE.replace('Nights,Guest,Listing', 'Nights,Guest name,Listing'));
const lower = show('D2 · the columns written in lower case', BASE.replace(HEADER, HEADER.toLowerCase()));
console.log(`    kept copy: holds the guest's name ${lower.blanked.includes('__TEST__ Guest')} · holds the payout's details ${lower.blanked.includes('made-up payout')}`);

// Rows out of order: the payouts checked day by day.
show('E · the rows in reverse order', file(RESERVATION, PAYOUT));
const nov2 = rowWith(RESERVATION, { Date: '10/20/2026', 'Confirmation Code': 'HMTEST37C9', Amount: '150.00', 'Gross earnings': '150.00' });
show('E2 · two payouts on two days, every row before its payout', file(nov2, RESERVATION, rowWith(PAYOUT, { Date: '10/20/2026', 'Paid out': '150.00' }), PAYOUT));
show('E3 · the same, one payout wrong by $1.00', file(nov2, RESERVATION, rowWith(PAYOUT, { Date: '10/20/2026', 'Paid out': '151.00' }), PAYOUT));

// A renamed title: the same long stay's next instalment under a new title.
const septemberRow = rowWith(RESERVATION, { Date: '09/30/2026', 'Confirmation Code': 'HMTEST37C2', 'Start date': '09/01/2026', 'End date': '11/30/2026', Nights: '90', Listing: '__TEST__ Lakeside Loft', Amount: '2000.00', 'Gross earnings': '2000.00' });
const octoberRow = rowWith(septemberRow, { Date: '10/30/2026', Listing: '__TEST__ Lakeside Loft Renamed' });
const sepFile = show('F · September: a long stay under "__TEST__ Lakeside Loft"', file(rowWith(PAYOUT, { Date: '09/30/2026', 'Paid out': '2000.00' }), septemberRow));
const octFile = show('F · October: its next instalment under "__TEST__ Lakeside Loft Renamed"', file(rowWith(PAYOUT, { Date: '10/30/2026', 'Paid out': '2000.00' }), octoberRow));

// ═══ 2. Lines read where they are stored, and the statements that place them ═══
console.log('\n═══ 2. Accepted lines, read where they are stored (M10), placed by M11, printed newest stay first ═══');
const stored = (row, month, extra = {}) => {
  const line = {
    id: sha(`${keyOf(row)}|${++seq}`),
    schemaVersion: 1,
    platform: 'airbnb',
    uploadId: 'TESTUPLOAD',
    fileRow: row.row,
    payoutDate: row.payoutDate,
    month,
    type: row.type,
    confirmationCode: row.confirmationCode,
    listingTitle: row.listingTitle,
    stay: row.stay,
    amountCents: row.amountCents,
    currency: 'CAD',
    evidence: row.evidence,
    remittedTaxCents: row.remittedTaxCents,
    status: 'proposed',
    decided: null,
    history: [],
    ...extra,
  };
  const again = inc.readEarningsLine(line.id, line);
  if (!again) throw new Error('not in shape');
  return again;
};
const acceptAs = (line, propertyId, at, words = {}) => {
  const description = words.description ?? inc.proposedLabel(line);
  const amountCents = words.amountCents ?? line.amountCents;
  const decided = { status: 'accepted', at, actor: ADMIN_ACTOR, propertyId, description, amountCents, edited: description !== inc.proposedLabel(line) || amountCents !== line.amountCents };
  const next = { ...line, status: 'accepted', decided, history: [...line.history, { at, actor: ADMIN_ACTOR, action: 'accepted', propertyId }] };
  return inc.readEarningsLine(next.id, next);
};
const sepRow = (code, start, end, payout, cents, type = 'Reservation') => ({ row: ++seq, payoutDate: payout, type, confirmationCode: code, listingTitle: '__TEST__ Lakeside Loft', stay: { start, end, nights: null }, amountCents: cents, currency: 'CAD', evidence: { grossCents: null, serviceFeeCents: null, cleaningFeeCents: null }, remittedTaxCents: null });
const sepA = acceptAs(stored(sepRow('HMTEST37C3', '2026-09-03', '2026-09-06', '2026-09-08', 50000), '2026-09'), P, '2026-10-02T15:00:00.000Z');
const sepB = acceptAs(stored(sepRow('HMTEST37C4', '2026-09-20', '2026-09-25', '2026-09-26', 90000), '2026-09'), P, '2026-10-02T15:00:00.000Z', { description: 'Revenue - Sep 20–25, 2026 (two guests)' });
const sepC = acceptAs(stored(sepRow('HMTEST37C3', '2026-09-03', '2026-09-06', '2026-09-28', -10000, 'Resolution Adjustment'), '2026-09'), P, '2026-10-02T15:00:00.000Z');
const record = { id: P, schemaVersion: 3, propertyId: P, reportFor: { name: 'Test Owner', address: '' }, owners: [], statementsFrom: '2026-09', statementsUntil: null, defaultFeeRateBasisPoints: null, defaultFee: null, setAt: '2026-10-01T00:00:00.000Z' };
const draftOf = (month, lines = [], extra = {}) => ({ reference: `${model.monthReferenceWord(month)}-37C`, reportDate: model.monthRange(model.addMonths(month, 1)).from, lines, fee: null, carried: null, notes: null, supersedes: null, ...extra });
const typed = (description, cents) => ({ id: `typed-${++seq}`, description, from: null, to: null, quantity: 1, rateCents: cents, amountCents: cents });
const rows = (statement) => st.printedLines(statement).map((l) => `      ${l.description} · ${l.quantity} · ${l.rateCents === null ? '' : $(l.rateCents)} · ${$(l.amountCents)}`).join('\n');
function freeze(platformLines, reports, draft, month, finishedAt) {
  const built = st.buildStatement({ propertyId: P, propertyName: 'Test Lakeside Loft', month, entries: [], reports, draft, management: record, platformLines });
  if (built.kind !== 'ok') throw new Error('unreadable');
  const s = { ...built.statement, draft: false };
  const id = `TESTREPORT${String(++seq).padStart(10, '0')}`;
  const report = {
    id, legacy: false, income: [], ownersAtFinish: [], schemaVersion: model.MONTHLY_REPORT_SCHEMA_VERSION, propertyId: P, propertyNameAtFinish: 'Test Lakeside Loft', month,
    reference: s.reference, reportDate: s.reportDate, reportFor: s.reportFor, lines: s.lines, costs: s.costs, adjustments: s.adjustments, fee: s.fee, carried: s.carried,
    incomeCents: s.incomeCents, expensesCents: s.expensesCents, recordedCents: s.recordedCents, costsCents: s.costsCents, feeCents: s.feeCents, totalCents: s.totalCents, carriedCents: s.carriedCents,
    payableCents: s.payableCents, pendingLeftOut: s.pendingLeftOut, notes: s.notes, entryIds: [], finishedAt, actor: ADMIN_ACTOR, supersedes: draft.supersedes ?? null, draftRevision: 1,
    pdf: { path: `monthly-reports/${id}.pdf`, bytes: 0, sha256: '' },
  };
  const again = model.readMonthlyReport(id, report);
  if (!again) throw new Error('report not in shape');
  return { report: again, statement: s, claim: built.claim };
}
const lines1 = inc.platformLinesOf([sepA, sepB, sepC]);
const sepDraft = draftOf('2026-09', [typed('Expense - Repairs', -5000)]);
const sepBuilt = st.buildStatement({ propertyId: P, propertyName: 'Test Lakeside Loft', month: '2026-09', entries: [], reports: [], draft: sepDraft, management: record, platformLines: lines1 });
console.log("  September's statement, three accepted lines and a typed line:");
console.log(rows(sepBuilt.statement));
console.log(`    total ${$(sepBuilt.statement.totalCents)} · claim.platform ${JSON.stringify(sepBuilt.claim.platform.map((c) => ({ id: c.id.slice(0, 8), seen: c.seen })))}`);
const figures = money.figuresOf(sepBuilt.statement, new Set());
console.log(`    figures (M1): revenue ${$(figures.revenueCents)} (Airbnb ${$(figures.airbnbCents)}) · expenses ${$(figures.expensesCents)}`);
const sep = freeze(lines1, [], sepDraft, '2026-09', '2026-10-05T14:00:00.000Z');
console.log(`  finished: report lines carry their stored line: ${sep.report.lines.filter((l) => l.platformLineId).length} of ${sep.report.lines.length} · source ${JSON.stringify([...new Set(sep.report.lines.map((l) => l.source ?? 'typed'))])}`);
const sepPdf = pdfStrings(statementPdf(sep.statement)).filter((t) => /Revenue|Resolution|Repairs/.test(t));
console.log(`  the PDF prints, in order: ${sepPdf.map((t) => JSON.stringify(t)).join(' · ')}`);
console.log(`  locked (printed on a current statement): ${[...st.printedPlatformLines(model.currentReports([sep.report])).values()].map((p) => p.month).join(', ')} · for each of the three: ${[sepA, sepB, sepC].every((l) => st.printedPlatformLines([sep.report]).has(l.id))}`);

// M11: a September line accepted after September was finished.
const late = acceptAs(stored(sepRow('HMTEST37C5', '2026-09-27', '2026-09-29', '2026-09-30', 32100), '2026-09'), P, '2026-10-10T15:00:00.000Z');
const lines2 = inc.platformLinesOf([sepA, sepB, sepC, late]);
const octRow = acceptAs(stored(sepRow('HMTEST37C6', '2026-10-09', '2026-10-12', '2026-10-13', 40000), '2026-10'), P, '2026-10-14T15:00:00.000Z');
const lines3 = [...lines2, ...inc.platformLinesOf([octRow])];
const octBuilt = st.buildStatement({ propertyId: P, propertyName: 'Test Lakeside Loft', month: '2026-10', entries: [], reports: [sep.report], draft: draftOf('2026-10', [typed('Revenue - direct booking', 25000)]), management: record, platformLines: lines3 });
console.log("  October's statement, with a September line accepted after September was finished (M11):");
console.log(rows(octBuilt.statement));
console.log(`    September's statement as it stands, rebuilt: still ${sep.report.lines.length} lines (finished, never touched) · the late line on it: ${sep.report.lines.some((l) => l.platformLineId === late.id)}`);
const moneyMonths = st.moneyMonthsByProperty([], [], lines3);
console.log(`  owed months (accepted lines count where they are paid): ${JSON.stringify([...moneyMonths])}`);

// An edit changes the line; Finish catches a line changed since the page built the statement.
const edited = { ...late, decided: { ...late.decided, amountCents: 30000, edited: true }, history: [...late.history, { at: '2026-10-15T15:00:00.000Z', actor: ADMIN_ACTOR, action: 'edited', before: { description: late.decided.description, amountCents: 32100 }, after: { description: late.decided.description, amountCents: 30000 } }] };
const editedRead = inc.readEarningsLine(edited.id, edited);
console.log(`  an edit after acceptance, read back: amount ${$(editedRead.decided.amountCents)} · history ${editedRead.history.map((h) => h.action + (h.before ? ` ${$(h.before.amountCents)}→${$(h.after.amountCents)}` : '')).join(', ')}`);
const octAgain = st.buildStatement({ propertyId: P, propertyName: 'Test Lakeside Loft', month: '2026-10', entries: [], reports: [sep.report], draft: draftOf('2026-10', octBuilt.statement.lines.filter((l) => !l.platformLineId)), management: record, platformLines: [...inc.platformLinesOf([sepA, sepB, sepC, editedRead]), ...inc.platformLinesOf([octRow])] });
console.log(`    Finish's claim, built before the edit, still holds: ${st.sameClaim(octAgain.claim, octBuilt.claim)} (the server refuses: STATEMENT_CHANGED)`);

// A correction of September: its lines are read again, the late one too while October is open.
const correcting = st.buildStatement({ propertyId: P, propertyName: 'Test Lakeside Loft', month: '2026-09', entries: [], reports: [sep.report], draft: draftOf('2026-09', [typed('Expense - Repairs', -5000)], { supersedes: { reportId: sep.report.id, reason: 'test' } }), management: record, platformLines: lines2 });
console.log('  September corrected while October is open: its lines are its own again, the late one with them:');
console.log(rows(correcting.statement));

// A line before the property's first statement month goes on no statement.
const august = acceptAs(stored(sepRow('HMTEST37C7', '2026-08-20', '2026-08-22', '2026-08-25', 11100), '2026-08'), P, '2026-10-02T15:00:00.000Z');
console.log(`  an August line (before September, its first statement month) is on September's statement: ${st.buildStatement({ propertyId: P, propertyName: '', month: '2026-09', entries: [], reports: [], draft: null, management: record, platformLines: inc.platformLinesOf([august]) }).statement.lines.length > 0}`);

// A line accepted before dispatch 37C, copied into its draft, is read there and never read again where it is stored.
const copy = { ...sepA, id: sha('copy'), decided: { ...sepA.decided, draftId: `${P}_2026-09`, lineId: 'COPIED-LINE' } };
console.log(`  a copy made before 37C: read where stored ${inc.isReadWhereStored(copy)} · copied ${inc.isCopied(copy.decided)} · placed by the statements ${inc.platformLinesOf([inc.readEarningsLine(copy.id, copy)]).length}`);

// ═══ 3. The Income page's view ═══
console.log("\n═══ 3. The Income page · October, as the page reads it ═══");
const oct = (code, start, end, payout, cents, title, type = 'Reservation') => ({ row: ++seq, payoutDate: payout, type, confirmationCode: code, listingTitle: title, stay: { start, end, nights: null }, amountCents: cents, currency: 'CAD', evidence: { grossCents: null, serviceFeeCents: null, cleaningFeeCents: null }, remittedTaxCents: null });
const T = '__TEST__ Lakeside Loft';
const acceptedHere = acceptAs(stored(oct('HMTEST37D1', '2026-10-02', '2026-10-05', '2026-10-06', 60000, T), '2026-10'), P, '2026-10-07T15:00:00.000Z');
const changedRow = stored(oct('HMTEST37D1', '2026-10-02', '2026-10-05', '2026-10-06', 55000, T), '2026-10');
const unknownRow = stored(oct('HMTEST37D2', '2026-10-10', '2026-10-12', '2026-10-13', 1250, T, 'Pass Through Tot'), '2026-10');
const twinRow = stored(oct('HMTEST37D3', '2026-10-15', '2026-10-18', '2026-10-19', 45000, T), '2026-10');
const excludedRow = stored(oct('HMTEST37D4', '2026-10-15', '2026-10-18', '2026-10-19', 33300, '__TEST__ Excluded Flat'), '2026-10');
const copyKept = { ...stored(oct('HMTEST37D5', '2026-10-20', '2026-10-22', '2026-10-23', 22200, T), '2026-10'), status: 'accepted', decided: { status: 'accepted', at: '2026-10-01T00:00:00.000Z', actor: ADMIN_ACTOR, propertyId: P, draftId: `${P}_2026-10`, lineId: 'COPY-IN-DRAFT', description: 'Revenue - Oct 20–22, 2026', amountCents: 22200, edited: false } };
const copyGone = { ...stored(oct('HMTEST37D6', '2026-10-24', '2026-10-26', '2026-10-27', 11100, T), '2026-10'), status: 'accepted', decided: { status: 'accepted', at: '2026-10-01T00:00:00.000Z', actor: ADMIN_ACTOR, propertyId: P, draftId: `${P}_2026-10`, lineId: 'COPY-REMOVED', description: 'Revenue - Oct 24–26, 2026', amountCents: 11100, edited: false } };
const linkOf = (title, propertyId, extra = {}) => ({ id: `TESTLINK${++seq}`, schemaVersion: 1, platform: 'airbnb', title, propertyId, linkedAt: '2026-10-01T12:00:00.000Z', actor: ADMIN_ACTOR, history: [], ...extra });
const links = [linkOf(T, P, { active: true }), linkOf('__TEST__ Lakeside Old', P, { active: false }), linkOf('__TEST__ Excluded Flat', Q)];
const statementLines = [...st.platformLinesOn({ propertyId: P, month: '2026-10', firstMonth: '2026-09', platformLines: inc.platformLinesOf([acceptedHere]), current: [] }).map((r) => r.line), { id: 'COPY-IN-DRAFT', description: 'Revenue - Oct 20–22, 2026', from: null, to: null, quantity: 1, rateCents: 22200, amountCents: 22200 }, { ...typed('Revenue - Oct 15–18 (typed)', 45000), from: '2026-10-15', to: '2026-10-18' }];
const view = mv.monthView({
  month: '2026-10',
  uploads: [{ platform: 'airbnb', titles: [{ title: T, rows: 6, amountCents: 0 }, { title: '__TEST__ Excluded Flat', rows: 1, amountCents: 33300 }] }],
  lines: [acceptedHere, changedRow, unknownRow, twinRow, excludedRow, copyKept, copyGone],
  links,
  lastSeen: {},
  properties: [{ id: P, name: 'Test Lakeside Loft' }, { id: Q, name: 'Test Excluded Flat' }],
  statements: [{ propertyId: P, finished: false, lines: statementLines }],
  calendar: { checkIns: [{ propertyId: Q, days: ['2026-10-31'] }, { propertyId: P, days: ['2026-10-02'] }] },
  noStatement: [{ propertyId: Q, why: 'It is excluded from reporting: no statement is asked for.' }],
});
console.log(`  accepted: ${view.accepted.map((l) => l.confirmationCode).join(', ')} · removed (a copy taken out of its draft): ${view.removed.map((l) => l.confirmationCode).join(', ')}`);
for (const group of view.review) console.log(`  to review, ${group.name}: ${group.lines.map((l) => `${l.confirmationCode} ${l.type}${mv.needsDecision(l) ? ' (needs a decision)' : ''}`).join(' · ')} · undecided ${group.undecided} · no statement: ${group.noStatement ?? '—'}`);
for (const [id, said] of view.warnings) console.log(`  warning on ${[changedRow, twinRow].find((l) => l.id === id)?.confirmationCode}: ${said.join(' | ')}`);
console.log(`  By property: ${view.byProperty.map((r) => `${r.name} · ${r.lines} lines, ${r.fromFile} from a file · revenue ${$(r.revenueCents)}`).join(' | ')}`);
console.log(`  check-ins with no income: ${JSON.stringify(view.gaps.checkIns)} (a check-in on the 31st is paid in November's file)`);
console.log(`  linked, not in this month's file: ${JSON.stringify(view.gaps.missing.map((m) => m.link.title))} (a previous title is expected to be missing)`);
// A title is "not in this month's file" only for months after it became the active title (Kian's ruling of 2026-10-13).
const missingIn = (month, linkedAt) => mv.monthView({ month, uploads: [{ platform: 'airbnb', titles: [{ title: '__TEST__ Another Title', rows: 1, amountCents: 100 }] }], lines: [], links: [linkOf('__TEST__ Lakeside Loft Renamed', P, { active: true, linkedAt })], lastSeen: {}, properties: [{ id: P, name: 'Test Lakeside Loft' }], statements: [], calendar: { checkIns: [] } }).gaps.missing.map((m) => m.link.title);
console.log(`  a title made active on 13 October, missing from each month's file: September ${JSON.stringify(missingIn('2026-09', '2026-10-13T18:31:42.000Z'))} · October ${JSON.stringify(missingIn('2026-10', '2026-10-13T18:31:42.000Z'))} · November ${JSON.stringify(missingIn('2026-11', '2026-10-13T18:31:42.000Z'))}`);
console.log(`  made active at 23:30 on 31 October, Toronto (3:30 on 1 November, UTC): October ${JSON.stringify(missingIn('2026-10', '2026-11-01T03:30:00.000Z'))} · November ${JSON.stringify(missingIn('2026-11', '2026-11-01T03:30:00.000Z'))}`);

// Renames (M14).
const sepLine = stored({ ...sepFile.lines[0] }, '2026-09');
const octLine = stored({ ...octFile.lines[0] }, '2026-10');
const renameLinks = [linkOf('__TEST__ Lakeside Loft', P, { active: true })];
const suggestions = mv.renameSuggestions({ lines: [octLine], earlier: [sepLine], links: renameLinks, properties: [{ id: P, name: 'Test Lakeside Loft' }, { id: Q, name: 'Test Excluded Flat' }], calendar: [{ propertyId: P, stays: [{ start: '2026-09-01', end: '2026-11-30' }] }] });
console.log(`  renames: ${JSON.stringify(suggestions.map((s) => ({ title: s.title, property: s.propertyId, from: s.fromTitle, evidence: s.evidence.map((e) => `${e.kind}: ${e.text}`) })))}`);
const disagree = mv.renameSuggestions({ lines: [octLine], earlier: [sepLine], links: renameLinks, properties: [{ id: P, name: 'x' }, { id: Q, name: '__TEST__ Lakeside Loft Renamed' }], calendar: [] });
console.log(`  when the evidence disagrees (the code says one property, the name another): ${disagree.length} suggested`);

// ═══ 4. Finish's checks ═══
console.log("\n═══ 4. Finish · the calendar's stays and the checkouts ═══");
const stays = [{ start: '2026-10-02', end: '2026-10-05' }, { start: '2026-10-09', end: '2026-10-12' }, { start: '2026-10-31', end: '2026-11-03' }, { start: '2026-09-28', end: '2026-10-02' }];
const uncovered = uncoveredStays(stays, [acceptedHere, changedRow, unknownRow, twinRow], '2026-10');
console.log(`  stays on its calendar in October no line covers: ${JSON.stringify(uncovered)} (Oct 2–5 is covered; a stay beginning on the 31st is November's; one beginning in September is not October's)`);
const checks = finishChecks({ statement: octBuilt.statement, reports: [sep.report], entries: [], income: { waiting: 0, unlinked: [], checkouts: 0, uncovered }, today: '2026-11-03' });
console.log(`  the warning: ${checks.warnings.filter((w) => w.key === 'calendar-stays').map((w) => w.text).join('')}`);
console.log(`  checkouts in October (stays of a stay type, not rejected, distinct codes): ${checkoutsInMonth([acceptedHere, changedRow, unknownRow, twinRow], '2026-10')}`);

// ═══ 5. Titles ═══
console.log('\n═══ 5. Titles · one active per property, previous ones kept ═══');
const legacy = inc.readTitleLink('L1', { schemaVersion: 1, platform: 'airbnb', title: 'Old link', propertyId: P, linkedAt: 'x', actor: ADMIN_ACTOR, history: [] });
const prev = inc.readTitleLink('L2', { schemaVersion: 1, platform: 'airbnb', title: 'Previous', propertyId: P, linkedAt: 'x', actor: ADMIN_ACTOR, history: [{ propertyId: P, linkedAt: 'w', actor: ADMIN_ACTOR, active: true }], active: false });
const aside = inc.readTitleLink('L3', { schemaVersion: 1, platform: 'airbnb', title: 'Aside', propertyId: null, notNubnb: true, linkedAt: 'x', actor: ADMIN_ACTOR, history: [] });
const asideActive = inc.readTitleLink('L4', { schemaVersion: 1, platform: 'airbnb', title: 'Aside', propertyId: null, notNubnb: true, active: true, linkedAt: 'x', actor: ADMIN_ACTOR, history: [] });
console.log(`  a link written before 37C is active: ${inc.isActiveTitle(legacy)} · a previous title: ${inc.isActiveTitle(prev)} (its history keeps "active": ${prev.history[0].active}) · a title set aside: ${inc.isActiveTitle(aside)} · a set-aside link marked active reads: ${asideActive === null ? 'not in shape' : 'in shape'}`);

// ═══ 6. What the routes accept: the bodies the pages send ═══
console.log("\n═══ 6. The routes' schemas, given what the pages send ═══");
const parse = (schema, body) => {
  const r = schema.safeParse(body);
  return r.success ? `ok ${JSON.stringify(r.data)}` : `refused: ${r.error.issues.map((i) => `${i.path.join('.') || '(body)'} ${i.message}`).join('; ')}`;
};
const L = sha('a line');
console.log(`  accept, as proposed: ${parse(sc.AcceptInputSchema, { propertyId: P, month: '2026-10', lines: [{ id: L }] })}`);
console.log(`  accept, edited: ${parse(sc.AcceptInputSchema, { propertyId: P, month: '2026-10', lines: [{ id: L, description: '  Revenue -  Oct 2–5 ', amount: '-397.40' }] })}`);
console.log(`  accept, $0.00: ${parse(sc.AcceptInputSchema, { propertyId: P, month: '2026-10', lines: [{ id: L, amount: '0.00' }] })}`);
console.log(`  edit an accepted line: ${parse(sc.LineInputSchema, { action: 'edit', seen: 1, amount: '300.00' })}`);
console.log(`  edit with nothing to change: ${parse(sc.LineInputSchema, { action: 'edit', seen: 1 })}`);
console.log(`  send back: ${parse(sc.LineInputSchema, { action: 'propose-again' })} · reject: ${parse(sc.LineInputSchema, { action: 'reject' })}`);
console.log(`  reject all: ${parse(sc.RejectInputSchema, { ids: [L, sha('another')] })} · twice the same: ${parse(sc.RejectInputSchema, { ids: [L, L] })}`);
console.log(`  Link (the Income page): ${parse(sc.LinkInputSchema, { channel: 'airbnb', title: '  __TEST__  Lakeside Loft ', propertyId: P, expected: null })}`);
console.log(`  the edit page's title: ${parse(sc.TitleInputSchema, { title: '__TEST__ Lakeside Loft Renamed', expected: null })} · empty: ${parse(sc.TitleInputSchema, { title: '   ', expected: null })}`);

// ═══ 7. The property save never writes the title ═══
console.log('\n═══ 7. The property save ═══');
for (const field of ['airbnbTitle', 'listingTitle', 'cleanerName']) {
  const r = UpdatePropertySchema.safeParse({ name: 'Test', [field]: 'x' });
  console.log(`  a body carrying "${field}": ${r.success ? 'passed through' : `refused · ${r.error.issues.map((i) => i.message).join('; ')}`}`);
}

// ═══ 8. Empty months ═══
console.log('\n═══ 8. Empty months · October with accepted lines, nothing typed ═══');
const empty = emptyMonth({ month: '2026-10', today: '2026-11-03', properties: [{ id: P, name: 'Test Lakeside Loft', createdMonth: '2026-11' }], management: [record], reports: [sep.report], drafts: [], entries: [], income: { waiting: new Map(), checkInsWithout: new Set(), unsettled: [] }, platformLines: lines3 });
console.log(`  eligible ${empty.eligible.length} · left out: ${empty.leftOut.map((r) => r.why).join(' | ')}`);
