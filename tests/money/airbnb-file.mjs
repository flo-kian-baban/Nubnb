// Dispatch 37C: December's Airbnb file through Nubnb's own pure code — the reader, the lines read where they are stored,
// the statements that place them, the Income page's view, Finish's checks, renames and what the routes accept.
// Made-up data only: dispatch 36's made-up December file (tests/fixtures/airbnb-december-d36.csv) and variants of it,
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

// ═══ 1. The reader, on dispatch 36's made-up December file and its variants ═══
console.log("═══ 1. The reader · dispatch 36's made-up December file and its variants ═══");
const BASE = readFileSync(`${ROOT}/tests/fixtures/airbnb-december-d36.csv`, 'utf8');
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
console.log(`    its label: "${inc.proposedLabel({ ...totLine, month: '2026-12' })}" · the reservation's: "${inc.proposedLabel({ ...unknown.lines[0], month: '2026-12' })}"`);

// A renamed Guest column: refused, nothing kept with the guests' names. In capitals or not, it is recognised.
show('D · the Guest column renamed "Guest name"', BASE.replace('Nights,Guest,Listing', 'Nights,Guest name,Listing'));
const lower = show('D2 · the columns written in lower case', BASE.replace(HEADER, HEADER.toLowerCase()));
console.log(`    kept copy: holds the guest's name ${lower.blanked.includes('__TEST__ Guest')} · holds the payout's details ${lower.blanked.includes('made-up payout')}`);

// Rows out of order: the payouts checked day by day.
show('E · the rows in reverse order', file(RESERVATION, PAYOUT));
const jan2 = rowWith(RESERVATION, { Date: '12/20/2026', 'Confirmation Code': 'HMTEST37C9', Amount: '150.00', 'Gross earnings': '150.00' });
show('E2 · two payouts on two days, every row before its payout', file(jan2, RESERVATION, rowWith(PAYOUT, { Date: '12/20/2026', 'Paid out': '150.00' }), PAYOUT));
show('E3 · the same, one payout wrong by $1.00', file(jan2, RESERVATION, rowWith(PAYOUT, { Date: '12/20/2026', 'Paid out': '151.00' }), PAYOUT));

// A renamed title: the same long stay's next instalment under a new title.
const septemberRow = rowWith(RESERVATION, { Date: '11/30/2026', 'Confirmation Code': 'HMTEST37C2', 'Start date': '11/01/2026', 'End date': '01/30/2027', Nights: '90', Listing: '__TEST__ Lakeside Loft', Amount: '2000.00', 'Gross earnings': '2000.00' });
const octoberRow = rowWith(septemberRow, { Date: '12/30/2026', Listing: '__TEST__ Lakeside Loft Renamed' });
const novFile = show('F · November: a long stay under "__TEST__ Lakeside Loft"', file(rowWith(PAYOUT, { Date: '11/30/2026', 'Paid out': '2000.00' }), septemberRow));
const decFile = show('F · December: its next instalment under "__TEST__ Lakeside Loft Renamed"', file(rowWith(PAYOUT, { Date: '12/30/2026', 'Paid out': '2000.00' }), octoberRow));

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
const novRow = (code, start, end, payout, cents, type = 'Reservation') => ({ row: ++seq, payoutDate: payout, type, confirmationCode: code, listingTitle: '__TEST__ Lakeside Loft', stay: { start, end, nights: null }, amountCents: cents, currency: 'CAD', evidence: { grossCents: null, serviceFeeCents: null, cleaningFeeCents: null }, remittedTaxCents: null });
const novA = acceptAs(stored(novRow('HMTEST37C3', '2026-11-03', '2026-11-06', '2026-11-08', 50000), '2026-11'), P, '2026-12-02T15:00:00.000Z');
const novB = acceptAs(stored(novRow('HMTEST37C4', '2026-11-20', '2026-11-25', '2026-11-26', 90000), '2026-11'), P, '2026-12-02T15:00:00.000Z', { description: 'Revenue - Nov 20–25, 2026 (two guests)' });
const novC = acceptAs(stored(novRow('HMTEST37C3', '2026-11-03', '2026-11-06', '2026-11-28', -10000, 'Resolution Adjustment'), '2026-11'), P, '2026-12-02T15:00:00.000Z');
const record = { id: P, schemaVersion: 3, propertyId: P, reportFor: { name: 'Test Owner', address: '' }, owners: [], statementsFrom: '2026-11', statementsUntil: null, defaultFeeRateBasisPoints: null, defaultFee: null, setAt: '2026-12-01T00:00:00.000Z' };
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
const lines1 = inc.platformLinesOf([novA, novB, novC]);
const novDraft = draftOf('2026-11', [typed('Expense - Repairs', -5000)]);
const novBuilt = st.buildStatement({ propertyId: P, propertyName: 'Test Lakeside Loft', month: '2026-11', entries: [], reports: [], draft: novDraft, management: record, platformLines: lines1 });
console.log("  November's statement, three accepted lines and a typed line:");
console.log(rows(novBuilt.statement));
console.log(`    total ${$(novBuilt.statement.totalCents)} · claim.platform ${JSON.stringify(novBuilt.claim.platform.map((c) => ({ id: c.id.slice(0, 8), seen: c.seen })))}`);
const figures = money.figuresOf(novBuilt.statement, new Set());
console.log(`    figures (M1): revenue ${$(figures.revenueCents)} (Airbnb ${$(figures.airbnbCents)}) · expenses ${$(figures.expensesCents)}`);
const nov = freeze(lines1, [], novDraft, '2026-11', '2026-12-05T14:00:00.000Z');
console.log(`  finished: report lines carry their stored line: ${nov.report.lines.filter((l) => l.platformLineId).length} of ${nov.report.lines.length} · source ${JSON.stringify([...new Set(nov.report.lines.map((l) => l.source ?? 'typed'))])}`);
const novPdf = pdfStrings(statementPdf(nov.statement)).filter((t) => /Revenue|Resolution|Repairs/.test(t));
console.log(`  the PDF prints, in order: ${novPdf.map((t) => JSON.stringify(t)).join(' · ')}`);
console.log(`  locked (printed on a current statement): ${[...st.printedPlatformLines(model.currentReports([nov.report])).values()].map((p) => p.month).join(', ')} · for each of the three: ${[novA, novB, novC].every((l) => st.printedPlatformLines([nov.report]).has(l.id))}`);

// M11: a November line accepted after November was finished.
const late = acceptAs(stored(novRow('HMTEST37C5', '2026-11-27', '2026-11-29', '2026-11-30', 32100), '2026-11'), P, '2026-12-10T15:00:00.000Z');
const lines2 = inc.platformLinesOf([novA, novB, novC, late]);
const decRow = acceptAs(stored(novRow('HMTEST37C6', '2026-12-09', '2026-12-12', '2026-12-13', 40000), '2026-12'), P, '2026-12-14T15:00:00.000Z');
const lines3 = [...lines2, ...inc.platformLinesOf([decRow])];
const decBuilt = st.buildStatement({ propertyId: P, propertyName: 'Test Lakeside Loft', month: '2026-12', entries: [], reports: [nov.report], draft: draftOf('2026-12', [typed('Revenue - direct booking', 25000)]), management: record, platformLines: lines3 });
console.log("  December's statement, with a November line accepted after November was finished (M11):");
console.log(rows(decBuilt.statement));
console.log(`    November's statement as it stands, rebuilt: still ${nov.report.lines.length} lines (finished, never touched) · the late line on it: ${nov.report.lines.some((l) => l.platformLineId === late.id)}`);
const moneyMonths = st.moneyMonthsByProperty([], [], lines3);
console.log(`  owed months (accepted lines count where they are paid): ${JSON.stringify([...moneyMonths])}`);

// An edit changes the line; Finish catches a line changed since the page built the statement.
const edited = { ...late, decided: { ...late.decided, amountCents: 30000, edited: true }, history: [...late.history, { at: '2026-12-15T15:00:00.000Z', actor: ADMIN_ACTOR, action: 'edited', before: { description: late.decided.description, amountCents: 32100 }, after: { description: late.decided.description, amountCents: 30000 } }] };
const editedRead = inc.readEarningsLine(edited.id, edited);
console.log(`  an edit after acceptance, read back: amount ${$(editedRead.decided.amountCents)} · history ${editedRead.history.map((h) => h.action + (h.before ? ` ${$(h.before.amountCents)}→${$(h.after.amountCents)}` : '')).join(', ')}`);
const decAgain = st.buildStatement({ propertyId: P, propertyName: 'Test Lakeside Loft', month: '2026-12', entries: [], reports: [nov.report], draft: draftOf('2026-12', decBuilt.statement.lines.filter((l) => !l.platformLineId)), management: record, platformLines: [...inc.platformLinesOf([novA, novB, novC, editedRead]), ...inc.platformLinesOf([decRow])] });
console.log(`    Finish's claim, built before the edit, still holds: ${st.sameClaim(decAgain.claim, decBuilt.claim)} (the server refuses: STATEMENT_CHANGED)`);

// A correction of November: its lines are read again, the late one too while December is open.
const correcting = st.buildStatement({ propertyId: P, propertyName: 'Test Lakeside Loft', month: '2026-11', entries: [], reports: [nov.report], draft: draftOf('2026-11', [typed('Expense - Repairs', -5000)], { supersedes: { reportId: nov.report.id, reason: 'test' } }), management: record, platformLines: lines2 });
console.log('  November corrected while December is open: its lines are its own again, the late one with them:');
console.log(rows(correcting.statement));

// A line before the property's first statement month goes on no statement.
const october = acceptAs(stored(novRow('HMTEST37C7', '2026-10-20', '2026-10-22', '2026-10-25', 11100), '2026-10'), P, '2026-12-02T15:00:00.000Z');
console.log(`  an October line (before November, its first statement month) is on November's statement: ${st.buildStatement({ propertyId: P, propertyName: '', month: '2026-11', entries: [], reports: [], draft: null, management: record, platformLines: inc.platformLinesOf([october]) }).statement.lines.length > 0}`);

// A line accepted before dispatch 37C, copied into its draft, is read there and never read again where it is stored.
const copy = { ...novA, id: sha('copy'), decided: { ...novA.decided, draftId: `${P}_2026-09`, lineId: 'COPIED-LINE' } };
console.log(`  a copy made before 37C: read where stored ${inc.isReadWhereStored(copy)} · copied ${inc.isCopied(copy.decided)} · placed by the statements ${inc.platformLinesOf([inc.readEarningsLine(copy.id, copy)]).length}`);

// ═══ 3. The Income page's view ═══
console.log("\n═══ 3. The Income page · December, as the page reads it ═══");
const dec = (code, start, end, payout, cents, title, type = 'Reservation') => ({ row: ++seq, payoutDate: payout, type, confirmationCode: code, listingTitle: title, stay: { start, end, nights: null }, amountCents: cents, currency: 'CAD', evidence: { grossCents: null, serviceFeeCents: null, cleaningFeeCents: null }, remittedTaxCents: null });
const T = '__TEST__ Lakeside Loft';
const acceptedHere = acceptAs(stored(dec('HMTEST37D1', '2026-12-02', '2026-12-05', '2026-12-06', 60000, T), '2026-12'), P, '2026-12-07T15:00:00.000Z');
const changedRow = stored(dec('HMTEST37D1', '2026-12-02', '2026-12-05', '2026-12-06', 55000, T), '2026-12');
const unknownRow = stored(dec('HMTEST37D2', '2026-12-10', '2026-12-12', '2026-12-13', 1250, T, 'Pass Through Tot'), '2026-12');
const twinRow = stored(dec('HMTEST37D3', '2026-12-15', '2026-12-18', '2026-12-19', 45000, T), '2026-12');
const excludedRow = stored(dec('HMTEST37D4', '2026-12-15', '2026-12-18', '2026-12-19', 33300, '__TEST__ Excluded Flat'), '2026-12');
const copyKept = { ...stored(dec('HMTEST37D5', '2026-12-20', '2026-12-22', '2026-12-23', 22200, T), '2026-12'), status: 'accepted', decided: { status: 'accepted', at: '2026-12-01T00:00:00.000Z', actor: ADMIN_ACTOR, propertyId: P, draftId: `${P}_2026-10`, lineId: 'COPY-IN-DRAFT', description: 'Revenue - Dec 20–22, 2026', amountCents: 22200, edited: false } };
const copyGone = { ...stored(dec('HMTEST37D6', '2026-12-24', '2026-12-26', '2026-12-27', 11100, T), '2026-12'), status: 'accepted', decided: { status: 'accepted', at: '2026-12-01T00:00:00.000Z', actor: ADMIN_ACTOR, propertyId: P, draftId: `${P}_2026-10`, lineId: 'COPY-REMOVED', description: 'Revenue - Dec 24–26, 2026', amountCents: 11100, edited: false } };
const linkOf = (title, propertyId, extra = {}) => ({ id: `TESTLINK${++seq}`, schemaVersion: 1, platform: 'airbnb', title, propertyId, linkedAt: '2026-12-01T12:00:00.000Z', actor: ADMIN_ACTOR, history: [], ...extra });
const links = [linkOf(T, P, { active: true }), linkOf('__TEST__ Lakeside Old', P, { active: false }), linkOf('__TEST__ Excluded Flat', Q)];
const statementLines = [...st.platformLinesOn({ propertyId: P, month: '2026-12', firstMonth: '2026-11', platformLines: inc.platformLinesOf([acceptedHere]), current: [] }).map((r) => r.line), { id: 'COPY-IN-DRAFT', description: 'Revenue - Dec 20–22, 2026', from: null, to: null, quantity: 1, rateCents: 22200, amountCents: 22200 }, { ...typed('Revenue - Dec 15–18 (typed)', 45000), from: '2026-12-15', to: '2026-12-18' }];
const view = mv.monthView({
  month: '2026-12',
  uploads: [{ platform: 'airbnb', titles: [{ title: T, rows: 6, amountCents: 0 }, { title: '__TEST__ Excluded Flat', rows: 1, amountCents: 33300 }] }],
  lines: [acceptedHere, changedRow, unknownRow, twinRow, excludedRow, copyKept, copyGone],
  links,
  lastSeen: {},
  properties: [{ id: P, name: 'Test Lakeside Loft' }, { id: Q, name: 'Test Excluded Flat' }],
  statements: [{ propertyId: P, finished: false, lines: statementLines }],
  calendar: { checkIns: [{ propertyId: Q, days: ['2026-12-31'] }, { propertyId: P, days: ['2026-12-02'] }] },
  noStatement: [{ propertyId: Q, why: 'It is excluded from reporting: no statement is asked for.' }],
});
console.log(`  accepted: ${view.accepted.map((l) => l.confirmationCode).join(', ')} · removed (a copy taken out of its draft): ${view.removed.map((l) => l.confirmationCode).join(', ')}`);
for (const group of view.review) console.log(`  to review, ${group.name}: ${group.lines.map((l) => `${l.confirmationCode} ${l.type}${mv.needsDecision(l) ? ' (needs a decision)' : ''}`).join(' · ')} · undecided ${group.undecided} · no statement: ${group.noStatement ?? '—'}`);
for (const [id, said] of view.warnings) console.log(`  warning on ${[changedRow, twinRow].find((l) => l.id === id)?.confirmationCode}: ${said.join(' | ')}`);
console.log(`  By property: ${view.byProperty.map((r) => `${r.name} · ${r.lines} lines, ${r.fromFile} from a file · revenue ${$(r.revenueCents)}`).join(' | ')}`);
console.log(`  check-ins with no income: ${JSON.stringify(view.gaps.checkIns)} (a check-in on the 31st is paid in January's file)`);
console.log(`  linked, not in this month's file: ${JSON.stringify(view.gaps.missing.map((m) => m.link.title))} (a previous title is expected to be missing)`);
// A title is "not in this month's file" only for months after it became the active title (Kian's ruling of 2026-10-13).
const missingIn = (month, linkedAt) => mv.monthView({ month, uploads: [{ platform: 'airbnb', titles: [{ title: '__TEST__ Another Title', rows: 1, amountCents: 100 }] }], lines: [], links: [linkOf('__TEST__ Lakeside Loft Renamed', P, { active: true, linkedAt })], lastSeen: {}, properties: [{ id: P, name: 'Test Lakeside Loft' }], statements: [], calendar: { checkIns: [] } }).gaps.missing.map((m) => m.link.title);
console.log(`  a title made active on 13 December, missing from each month's file: November ${JSON.stringify(missingIn('2026-11', '2026-12-13T18:31:42.000Z'))} · December ${JSON.stringify(missingIn('2026-12', '2026-12-13T18:31:42.000Z'))} · January ${JSON.stringify(missingIn('2027-01', '2026-12-13T18:31:42.000Z'))}`);
console.log(`  made active at 23:30 on 31 December, Toronto (3:30 on 1 January, UTC): December ${JSON.stringify(missingIn('2026-12', '2027-01-01T03:30:00.000Z'))} · January ${JSON.stringify(missingIn('2027-01', '2027-01-01T03:30:00.000Z'))}`);

// Renames (M14).
const novLine = stored({ ...novFile.lines[0] }, '2026-11');
const decLine = stored({ ...decFile.lines[0] }, '2026-12');
const renameLinks = [linkOf('__TEST__ Lakeside Loft', P, { active: true })];
const suggestions = mv.renameSuggestions({ lines: [decLine], earlier: [novLine], links: renameLinks, properties: [{ id: P, name: 'Test Lakeside Loft' }, { id: Q, name: 'Test Excluded Flat' }], calendar: [{ propertyId: P, stays: [{ start: '2026-11-01', end: '2027-01-30' }] }] });
console.log(`  renames: ${JSON.stringify(suggestions.map((s) => ({ title: s.title, property: s.propertyId, from: s.fromTitle, evidence: s.evidence.map((e) => `${e.kind}: ${e.text}`) })))}`);
const disagree = mv.renameSuggestions({ lines: [decLine], earlier: [novLine], links: renameLinks, properties: [{ id: P, name: 'x' }, { id: Q, name: '__TEST__ Lakeside Loft Renamed' }], calendar: [] });
console.log(`  when the evidence disagrees (the code says one property, the name another): ${disagree.length} suggested`);

// ═══ 4. Finish's checks ═══
console.log("\n═══ 4. Finish · the calendar's stays and the checkouts ═══");
const stays = [{ start: '2026-12-02', end: '2026-12-05' }, { start: '2026-12-09', end: '2026-12-12' }, { start: '2026-12-31', end: '2027-01-03' }, { start: '2026-11-28', end: '2026-12-02' }];
const uncovered = uncoveredStays(stays, [acceptedHere, changedRow, unknownRow, twinRow], '2026-12');
console.log(`  stays on its calendar in December no line covers: ${JSON.stringify(uncovered)} (Dec 2–5 is covered; a stay beginning on the 31st is January's; one beginning in November is not December's)`);
const checks = finishChecks({ statement: decBuilt.statement, reports: [nov.report], entries: [], income: { waiting: 0, unlinked: [], checkouts: 0, uncovered }, today: '2027-01-03' });
console.log(`  the warning: ${checks.warnings.filter((w) => w.key === 'calendar-stays').map((w) => w.text).join('')}`);
console.log(`  checkouts in December (stays of a stay type, not rejected, distinct codes): ${checkoutsInMonth([acceptedHere, changedRow, unknownRow, twinRow], '2026-12')}`);

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
console.log(`  accept, as proposed: ${parse(sc.AcceptInputSchema, { propertyId: P, month: '2026-12', lines: [{ id: L }] })}`);
console.log(`  accept, edited: ${parse(sc.AcceptInputSchema, { propertyId: P, month: '2026-12', lines: [{ id: L, description: '  Revenue -  Dec 2–5 ', amount: '-397.40' }] })}`);
console.log(`  accept, $0.00: ${parse(sc.AcceptInputSchema, { propertyId: P, month: '2026-12', lines: [{ id: L, amount: '0.00' }] })}`);
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
console.log('\n═══ 8. Empty months · December with accepted lines, nothing typed ═══');
const empty = emptyMonth({ month: '2026-12', today: '2027-01-03', properties: [{ id: P, name: 'Test Lakeside Loft', createdMonth: '2027-01' }], management: [record], reports: [nov.report], drafts: [], entries: [], income: { waiting: new Map(), checkInsWithout: new Set(), unsettled: [] }, platformLines: lines3 });
console.log(`  eligible ${empty.eligible.length} · left out: ${empty.leftOut.map((r) => r.why).join(' | ')}`);
