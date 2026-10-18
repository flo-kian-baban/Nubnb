// The Costs page, round 1 (2026-10-18): what an owner receives names the property by its address and never names a
// cleaner or team member (Kian's rulings of 2026-10-13, "The cleaner is never named on anything an owner receives",
// and 2026-10-15 evening, "What owners receive switches to the address too: new statements, the costs ledger's PDF
// and Excel, and the backup folders"). A property whose newest entry is a cleaning, with a receipt, a handyman's work,
// a September finished and an office cost for September logged after it (so October's whole-month ledger carries
// Kian's ruling K1 section): its ledger PDF and Excel, and every file of the month ZIP's owner folder, are searched for
// each team member's name and the public title. Made-up data only; nothing is read from or written to production.
//   node --import ./tests/tools/ts-hook.mjs tests/money/owner-files.mjs
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.NUBNB_ROOT || fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const model = await import(`${ROOT}/app/lib/reports/model.ts`);
const st = await import(`${ROOT}/app/lib/reports/statement.ts`);
const { statementPdf } = await import(`${ROOT}/app/lib/reports/statement-pdf.ts`);
const { entryViewOf, selectMonthPackage, statementKey } = await import(`${ROOT}/app/lib/backup/data.ts`);
const { buildMonthPackage } = await import(`${ROOT}/app/lib/backup/package.ts`);
const { ADMIN_ACTOR } = await import(`${ROOT}/app/lib/cleaners/model.ts`);
const { buildReport } = await import(`${ROOT}/app/lib/costs/report.ts`);
const { pdfFor } = await import(`${ROOT}/app/lib/costs/pdf.ts`);
const { workbookFor } = await import(`${ROOT}/app/lib/costs/xlsx.ts`);
const cl = await import(`${ROOT}/app/lib/cleanings/model.ts`);
const money = await import(`${ROOT}/app/lib/money/month.ts`);

const P = 'TESTPROPownerfiles01';
const ADDRESS = '12 Owner Test St';
const PUBLIC = 'Sunny Harbour Loft Testtitle';
const RECEIPTER = { id: 'TESTCLEANERquinn0001', name: 'Quinn Receiptmaker', role: 'cleaner' };
const HANDY = { id: 'TESTHANDYMANharlan01', name: 'Harlan Fixwell', role: 'handyman' };
const CLEANER = { id: 'TESTCLEANERzelda0001', name: 'Zelda Testcleaner', role: 'cleaner' };
const NAMES = [RECEIPTER.name, HANDY.name, CLEANER.name, 'Quinn', 'Harlan', 'Zelda'];
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const text = (bytes) => Buffer.from(bytes).toString('latin1');
const utf8 = (bytes) => Buffer.from(bytes).toString('utf8');

// ─── Made-up records, as stored: each names its team member and the public title, as real ones do ───
const actor = (m) => ({ role: m.role, id: m.id, name: m.name });
function receipt(id, by, createdAt, cents, extra = {}) {
  return {
    id, stored: {
      schemaVersion: 2, kind: by.role === 'handyman' ? 'work' : 'receipt', cleanerId: by.id, cleanerNameAtEntry: by.name, propertyId: P, propertyNameAtEntry: PUBLIC, createdAt, purchasedOn: null,
      note: `sent by ${by.name}`, currency: 'CAD', lines: [{ name: by.role === 'handyman' ? 'Fixed the closet door' : 'Supplies', quantity: 1, lineTotalCents: cents }], taxCents: by.role === 'handyman' ? null : Math.round(cents * 0.13),
      receipts: [], status: 'approved', statusChangedAt: createdAt, statusReason: null, autoApproved: null,
      history: [{ at: createdAt, action: 'submitted', from: null, to: 'pending', actor: actor(by), reason: null }, { at: createdAt, action: 'approved', from: 'pending', to: 'approved', actor: ADMIN_ACTOR, reason: null }],
      ...extra,
    },
  };
}
const office = (id, createdAt, cents, month) => ({
  id, stored: {
    schemaVersion: 2, kind: 'office', cleanerId: null, cleanerNameAtEntry: null, propertyId: P, propertyNameAtEntry: PUBLIC, createdAt, purchasedOn: null, note: null, currency: 'CAD',
    lines: [{ name: 'Plumber, kitchen tap', quantity: 1, lineTotalCents: cents }], taxCents: null, receipts: [], status: 'approved', statusChangedAt: createdAt, statusReason: null,
    history: [{ at: createdAt, action: 'submitted', from: null, to: 'pending', actor: ADMIN_ACTOR, reason: null }, { at: createdAt, action: 'approved', from: 'pending', to: 'approved', actor: ADMIN_ACTOR, reason: 'Added by the office' }],
    autoApproved: null, month,
  },
});
const cleaning = (id, day, cents) => {
  const at = `${day}T20:00:00.000Z`;
  return { id, schemaVersion: 2, propertyId: P, propertyNameAtEntry: PUBLIC, cleanerId: CLEANER.id, cleanerNameAtEntry: CLEANER.name, day, amountCents: cents, note: `cleaned by ${CLEANER.name}`, status: 'logged', suggested: { from: 'default', cents }, createdAt: at, actor: actor(CLEANER), history: [{ at, action: 'logged', actor: actor(CLEANER), reason: null }], jobId: `${P}_${day}` };
};
// As the admin pages read them: an entry's lookups found the public title and, for a cleaning, the address too.
const asEntry = ({ id, stored }) => entryViewOf(id, stored);
const asCleaning = (c) => cl.cleaningEntryView({ ...cl.readCleaning(c.id, c), cleaner: { state: 'found', name: CLEANER.name, status: 'active' }, property: { state: 'found', name: PUBLIC, internalName: ADDRESS } });

const record = { id: P, schemaVersion: 3, propertyId: P, reportFor: { name: 'Test Owner', address: '' }, owners: [], statementsFrom: '2026-09', statementsUntil: null, defaultFeeRateBasisPoints: null, defaultFee: null, setAt: '2026-09-01T00:00:00.000Z' };
const draftOf = (month, lines = []) => ({ reference: `${model.monthReferenceWord(month)}-TEST`, reportDate: model.monthRange(model.addMonths(month, 1)).from, lines, fee: null, carried: null, notes: null, supersedes: null });
let seq = 0;
function freeze(entries, reports, draft, month, finishedAt) {
  const built = st.buildStatement({ propertyId: P, propertyName: ADDRESS, month, entries, reports, draft, management: record });
  if (built.kind !== 'ok') throw new Error('unreadable ' + built.entryIds);
  const s = { ...built.statement, draft: false };
  const bytes = statementPdf(s);
  const id = `TESTREPORTowner${String(++seq).padStart(5, '0')}`;
  return {
    bytes,
    report: {
      id, legacy: false, income: [], ownersAtFinish: [], schemaVersion: model.MONTHLY_REPORT_SCHEMA_VERSION, propertyId: P, propertyNameAtFinish: ADDRESS, month,
      reference: s.reference, reportDate: s.reportDate, reportFor: s.reportFor, lines: s.lines, costs: s.costs, adjustments: s.adjustments, fee: s.fee, carried: s.carried,
      incomeCents: s.incomeCents, expensesCents: s.expensesCents, recordedCents: s.recordedCents, costsCents: s.costsCents, feeCents: s.feeCents, totalCents: s.totalCents, carriedCents: s.carriedCents,
      payableCents: s.payableCents, pendingLeftOut: s.pendingLeftOut, notes: s.notes, entryIds: s.costs.map((row) => row.entryId), finishedAt, actor: ADMIN_ACTOR, supersedes: null, draftRevision: 1,
      pdf: { path: `monthly-reports/${id}.pdf`, bytes: bytes.length, sha256: sha(bytes) },
    },
  };
}
const revenue = (month) => [{ id: `L-rev-${month}`, description: `Revenue - ${month}`, from: null, to: null, quantity: 1, rateCents: 250000, amountCents: 250000 }];

// September: a receipt by Quinn; finished on 5 Oct. October: Harlan's work, an office cost for September logged
// 22 Oct (after September was finished: it goes on October's statement), and Zelda's cleaning of 28 Oct, the newest.
const sepReceipt = receipt('TESTENTRYownersep001', RECEIPTER, '2026-09-14T15:00:00.000Z', 4200);
const octWork = receipt('TESTENTRYownerwork01', HANDY, '2026-10-12T15:00:00.000Z', 12000);
const lateOffice = office('TESTENTRYownerlate01', '2026-10-22T15:00:00.000Z', 15000, '2026-09');
const octCleaning = cleaning('TESTCLEANINGowner001', '2026-10-28', 9000);
const sep = freeze([asEntry(sepReceipt)], [], draftOf('2026-09', revenue('2026-09')), '2026-09', '2026-10-05T14:00:00.000Z');
const entries = [asEntry(sepReceipt), asEntry(octWork), asEntry(lateOffice), asCleaning(octCleaning)];
const oct = freeze(entries, [sep.report], draftOf('2026-10', revenue('2026-10')), '2026-10', '2026-11-04T14:00:00.000Z');
const reports = [sep.report, oct.report];
const charges = money.costCharges({ propertyId: P, entries, reports, management: record });
const newest = [...entries].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))[0];
console.log(`the property's newest entry: ${newest.kind} of ${newest.purchasedOn ?? newest.createdAt} · its label as the lists read it: ${newest.property.internalName ?? newest.property.name ?? newest.property.nameAtEntry}`);

/** Every name an owner must never see, and whether the address is there. */
function scan(label, bytes) {
  const all = `${text(bytes)}\n${utf8(bytes)}`;
  const found = [...NAMES, PUBLIC].filter((name) => all.includes(name));
  console.log(`  ${label}: names a team member or the public title: ${found.length === 0 ? 'none' : found.join(', ')} · the address: ${all.includes(ADDRESS)}`);
  return found.length;
}
let leaks = 0;

// ═══ 1. The ledger: October as a whole month (Kian's ruling K1: its section from earlier months), and a part of it ═══
console.log('\n═══ 1. The ledger PDF and Excel ═══');
for (const [from, to] of [['2026-10-01', '2026-10-31'], ['2026-10-01', '2026-10-20']]) {
  const built = buildReport(entries, P, from, to, new Date('2026-11-04T16:00:00Z'), ADDRESS, charges);
  const report = built.report;
  console.log(` ${from} to ${to}: prints "${report.propertyName}" · ${report.entries.length} entries · from earlier months: ${report.fromEarlier ? report.fromEarlier.rows.map((r) => `${r.kind} ${r.what} (${r.belongsTo}) ${r.cents}`).join('; ') : 'no section'}`);
  leaks += scan('PDF', pdfFor(report));
  leaks += scan('Excel', workbookFor(report));
}
// Without the caller's address, a report still never takes the public title from a cleaning's entry.
console.log(`  no name given, newest entry a cleaning: prints "${buildReport(entries, P, '2026-10-01', '2026-10-31', new Date('2026-11-04T16:00:00Z'), null, charges).report.propertyName}"`);

// ═══ 2. The month ZIP's owner folder, September and October ═══
console.log('\n═══ 2. The month ZIP\'s owner folder ═══');
for (const month of ['2026-09', '2026-10']) {
  const selection = selectMonthPackage({
    month, today: '2026-11-05', madeAt: '2026-11-05T16:00:00.000Z',
    // The route passes each property's cleaner-facing name, else its public title (month-package/route.ts).
    properties: [{ id: P, name: ADDRESS, createdMonth: '2026-09' }],
    entries: [sepReceipt, octWork, lateOffice], cleanings: [{ id: octCleaning.id, stored: octCleaning }],
    reports: reports.map((view) => ({ view, stored: view })), drafts: [], downloads: [], management: [{ view: record, stored: record }],
  });
  const objects = new Map([[statementKey(sep.report.id), sep.bytes], [statementKey(oct.report.id), oct.bytes]]);
  const pkg = await buildMonthPackage(selection.data, objects, async (bytes) => sha(bytes), 'download');
  const owners = pkg.files.filter((f) => f.path.startsWith('Properties/'));
  console.log(` ${month}: ${owners.length} files in the owner's folder`);
  for (const file of owners) leaks += scan(file.path.split('/').slice(1).join('/'), file.data);
}
console.log(`\n${leaks === 0 ? 'no owner file names a team member or the public title' : `${leaks} owner files name a team member or the public title`}`);
