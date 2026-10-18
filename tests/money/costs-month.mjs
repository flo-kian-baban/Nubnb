// The Costs page, round 1 (2026-10-18): the Month tab (app/lib/costs/month-view.ts) on the dispatch-37 fixture
// portfolio (tests/money/month-money.mjs's cases, built the same way), plus a cleaning with no amount and a receipt
// still pending for a month already finished. For every property and every month, each row must equal what that
// property's statement preview shows: the finished statement as stored while the month is finished, else
// buildStatement on the month's draft as it stands (the correction's while one is written). Made-up data only:
// properties "TESTPROP…", entries "TESTENTRY…", reports "TESTREPORT…". Nothing is read from or written to production.
//   node --import ./tests/tools/ts-hook.mjs tests/money/costs-month.mjs
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.NUBNB_ROOT || fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const model = await import(`${ROOT}/app/lib/reports/model.ts`);
const st = await import(`${ROOT}/app/lib/reports/statement.ts`);
const { statementPdf } = await import(`${ROOT}/app/lib/reports/statement-pdf.ts`);
const { entryViewOf } = await import(`${ROOT}/app/lib/backup/data.ts`);
const { formatCents: $, ADMIN_ACTOR } = await import(`${ROOT}/app/lib/cleaners/model.ts`);
const cl = await import(`${ROOT}/app/lib/cleanings/model.ts`);
const { costsMonth } = await import(`${ROOT}/app/lib/costs/month-view.ts`);

let seq = 0;
// ─── Made-up documents, as month-money.mjs makes them ───
const cleanerHistory = (createdAt) => [
  { at: createdAt, action: 'submitted', from: null, to: 'pending', actor: { role: 'cleaner', id: 'TESTCLEANER000000001', name: 'Test cleaner' }, reason: null },
  { at: createdAt, action: 'approved', from: 'pending', to: 'approved', actor: ADMIN_ACTOR, reason: null },
];
function receipt(propertyId, createdAt, cents, extra = {}) {
  return {
    schemaVersion: 2, createdAt, status: 'approved', statusChangedAt: createdAt, statusReason: null, cleanerId: 'TESTCLEANER000000001', cleanerNameAtEntry: 'Test cleaner', propertyId, propertyNameAtEntry: 'Test property',
    purchasedOn: createdAt.slice(0, 10), note: null, currency: 'CAD', kind: 'receipt', autoApproved: null, lines: [{ name: 'Supplies', quantity: 1, lineTotalCents: cents }], taxCents: null, receipts: [],
    history: cleanerHistory(createdAt), ...extra,
  };
}
function office(propertyId, createdAt, cents, month) {
  return {
    schemaVersion: 2, kind: 'office', cleanerId: null, cleanerNameAtEntry: null, propertyId, propertyNameAtEntry: 'Test property', createdAt, purchasedOn: null, note: null, currency: 'CAD',
    lines: [{ name: 'Plumber', quantity: 1, lineTotalCents: cents }], taxCents: null, receipts: [], status: 'approved', statusChangedAt: createdAt, statusReason: null,
    history: [{ at: createdAt, action: 'submitted', from: null, to: 'pending', actor: ADMIN_ACTOR, reason: null }, { at: createdAt, action: 'approved', from: 'pending', to: 'approved', actor: ADMIN_ACTOR, reason: 'Added by the office' }],
    autoApproved: null, month,
  };
}
const corrected = (doc, at, before, after) => ({ ...doc, history: [...doc.history, { at, action: 'line_corrected', from: null, to: null, actor: ADMIN_ACTOR, reason: 'wrong amount', line: { index: 0, before: { name: doc.lines[0].name, quantity: 1, lineTotalCents: before }, after: { name: doc.lines[0].name, quantity: 1, lineTotalCents: after } } }] });
const line = (description, cents, id = `L${++seq}`) => ({ id, description, from: null, to: null, quantity: 1, rateCents: cents, amountCents: cents });
const draftOf = (month, lines = [], extra = {}) => ({ reference: `${model.monthReferenceWord(month)}-TEST`, reportDate: model.monthRange(model.addMonths(month, 1)).from, lines, fee: null, carried: null, notes: null, supersedes: null, ...extra });
const storedDraft = (propertyId, month, draft, finishedAs = null) => ({ id: `${propertyId}_${month}`, schemaVersion: 3, propertyId, month, ...draft, revision: 1, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', finishedAs, finishedRevision: finishedAs ? 1 : null });
const record = (propertyId) => ({ id: propertyId, schemaVersion: 3, propertyId, reportFor: { name: 'Test Owner', address: '' }, owners: [], statementsFrom: '2026-09', statementsUntil: null, defaultFeeRateBasisPoints: null, defaultFee: null, setAt: '2026-10-01T00:00:00.000Z' });
function freeze(propertyId, entries, reports, draft, month, finishedAt) {
  const built = st.buildStatement({ propertyId, propertyName: 'Test property', month, entries, reports, draft, management: record(propertyId) });
  if (built.kind !== 'ok') throw new Error('unreadable ' + built.entryIds);
  const s = { ...built.statement, draft: false };
  const bytes = statementPdf(s);
  const id = `TESTREPORT${String(++seq).padStart(10, '0')}`;
  return {
    id, legacy: false, income: [], ownersAtFinish: [], schemaVersion: model.MONTHLY_REPORT_SCHEMA_VERSION, propertyId, propertyNameAtFinish: 'Test property', month,
    reference: s.reference, reportDate: s.reportDate, reportFor: s.reportFor, lines: s.lines, costs: s.costs, adjustments: s.adjustments, fee: s.fee, carried: s.carried,
    ...(s.carriedAdjustments.length > 0 ? { carriedAdjustments: s.carriedAdjustments } : {}),
    incomeCents: s.incomeCents, expensesCents: s.expensesCents, recordedCents: s.recordedCents, costsCents: s.costsCents, feeCents: s.feeCents, totalCents: s.totalCents, carriedCents: s.carriedCents,
    payableCents: s.payableCents, pendingLeftOut: s.pendingLeftOut, notes: s.notes, entryIds: s.costs.map((row) => row.entryId), finishedAt, actor: ADMIN_ACTOR, supersedes: draft.supersedes ?? null, draftRevision: 1,
    pdf: { path: `monthly-reports/${id}.pdf`, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
  };
}

// ─── The portfolio ───
const properties = [];
const entries = [];
const reports = [];
const drafts = [];
const management = [];
const property = (id, name) => {
  properties.push({ id, name: `Public title of ${name}`, internalName: name });
  management.push(record(id));
};

// T1: a $100.00 receipt sent 15 Sep; September finished 5 Oct; a $50.00 office cost logged 12 Oct for September.
const P1 = 'TESTPROPt1aaaaaaaaaa';
property(P1, '1 T1 Street');
const r1 = entryViewOf('TESTENTRYt1receipt01', receipt(P1, '2026-09-15T15:00:00.000Z', 10000));
const sep1 = freeze(P1, [r1], [], draftOf('2026-09', [line('Revenue', 200000)]), '2026-09', '2026-10-05T14:00:00.000Z');
entries.push(r1, entryViewOf('TESTENTRYt1office001', office(P1, '2026-10-12T15:00:00.000Z', 5000, '2026-09')));
reports.push(sep1);
drafts.push(storedDraft(P1, '2026-09', draftOf('2026-09', sep1.lines), sep1.id));

// T2: September finished at $2,000.00 revenue; a correction adds $100.00 of revenue (no cost).
const P2 = 'TESTPROPt2aaaaaaaaaa';
property(P2, '2 T2 Street');
const sep2 = freeze(P2, [], [], draftOf('2026-09', [line('Revenue', 200000, 'L-rev')]), '2026-09', '2026-10-05T14:00:00.000Z');
reports.push(sep2);
drafts.push(storedDraft(P2, '2026-09', draftOf('2026-09', [line('Revenue', 200000, 'L-rev'), line('Revenue - late', 10000, 'L-late')], { supersedes: { reportId: sep2.id, reason: 'A stay was left out.' } })));

// T5: an approved $56.50 receipt and a pending $20.00 one in October.
const P5 = 'TESTPROPt5aaaaaaaaaa';
property(P5, '5 T5 Street');
entries.push(entryViewOf('TESTENTRYt5approved1', receipt(P5, '2026-10-03T15:00:00.000Z', 5000, { taxCents: 650 })));
entries.push(entryViewOf('TESTENTRYt5pending01', receipt(P5, '2026-10-04T15:00:00.000Z', 2000, { status: 'pending', history: cleanerHistory('2026-10-04T15:00:00.000Z').slice(0, 1) })));

// T6: September finished, its receipt corrected after (October adjusts it), a September office cost charged on
// October, October finished, then September deleted and finished again (it charges only what is left).
const P6 = 'TESTPROPt6aaaaaaaaaa';
property(P6, '6 T6 Street');
const x6 = receipt(P6, '2026-09-15T15:00:00.000Z', 10000);
const sepA = freeze(P6, [entryViewOf('TESTENTRYt6receipt01', x6)], [], draftOf('2026-09', [line('Revenue', 200000)]), '2026-09', '2026-10-05T14:00:00.000Z');
const x6b = corrected(x6, '2026-10-20T14:00:00.000Z', 10000, 15000);
const e6 = [entryViewOf('TESTENTRYt6receipt01', x6b), entryViewOf('TESTENTRYt6office001', office(P6, '2026-10-22T15:00:00.000Z', 4000, '2026-09'))];
const oct6 = freeze(P6, e6, [sepA], draftOf('2026-10', [line('Revenue', 100000)], { carried: { label: 'Balance From August', amountCents: 35996, fromReportId: null } }), '2026-10', '2026-11-04T14:00:00.000Z');
const sepB = freeze(P6, e6, [oct6], { ...draftOf('2026-09', sepA.lines) }, '2026-09', '2026-11-10T14:00:00.000Z');
entries.push(...e6);
reports.push(oct6, sepB);

// T7: a carried balance and a settled one, no costs at all.
const P7 = 'TESTPROPt7aaaaaaaaaa';
property(P7, '7 T7 Street');
const sep7 = freeze(P7, [], [], draftOf('2026-09', [line('Revenue', 100000), line('Expense - Repairs', -135996)]), '2026-09', '2026-10-05T14:00:00.000Z');
const oct7 = freeze(P7, [], [sep7], draftOf('2026-10', [line('Revenue', 300000)], { carried: st.carriedSuggestion(sep7) }), '2026-10', '2026-11-04T14:00:00.000Z');
reports.push(sep7, oct7);

// The round's own: a cleaning with no amount in October beside one with; a receipt sent in September still pending
// after September was finished (once approved it goes on October's statement); and one removed after printing.
const P8 = 'TESTPROProundonemon8';
property(P8, '8 Round One Road');
const cleaning = (id, day, cents) => cl.cleaningEntryView({ ...cl.readCleaning(id, { schemaVersion: 2, propertyId: P8, propertyNameAtEntry: 'x', cleanerId: 'TESTCLEANER000000002', cleanerNameAtEntry: 'x', day, amountCents: cents, note: null, status: 'logged', suggested: { from: cents === null ? 'none' : 'default', cents }, createdAt: `${day}T20:00:00.000Z`, actor: ADMIN_ACTOR, history: [{ at: `${day}T20:00:00.000Z`, action: 'logged', actor: ADMIN_ACTOR, reason: null }], jobId: `${P8}_${day}` }), cleaner: { state: 'found', name: 'x', status: 'active' }, property: { state: 'found', name: 'x' } });
const printed8 = receipt(P8, '2026-09-10T15:00:00.000Z', 3000);
const sep8 = freeze(P8, [entryViewOf('TESTENTRYr1printed01', printed8)], [], draftOf('2026-09', [line('Revenue', 150000)]), '2026-09', '2026-10-05T14:00:00.000Z');
const removed8 = { ...printed8, status: 'removed', history: [...printed8.history, { at: '2026-10-18T14:00:00.000Z', action: 'removed', from: 'approved', to: 'removed', actor: ADMIN_ACTOR, reason: null }] };
entries.push(
  cleaning('TESTCLEANINGr1oct001', '2026-10-06', 9000),
  cleaning('TESTCLEANINGr1oct002', '2026-10-27', null),
  entryViewOf('TESTENTRYr1latepend1', receipt(P8, '2026-09-29T15:00:00.000Z', 21240, { status: 'pending', history: cleanerHistory('2026-09-29T15:00:00.000Z').slice(0, 1) })),
  entryViewOf('TESTENTRYr1printed01', removed8),
);
reports.push(sep8);

// A correction being written: September finished with a $40.00 receipt; a second September receipt approved on 8 Oct;
// the admin reopened September to correct it (the preview is the correction's build).
const P10 = 'TESTPROProundonecorr';
property(P10, '10 Correction Court');
const first10 = entryViewOf('TESTENTRYr1corr00001', receipt(P10, '2026-09-12T15:00:00.000Z', 4000));
const sep10 = freeze(P10, [first10], [], draftOf('2026-09', [line('Revenue', 120000, 'L-rev10')]), '2026-09', '2026-10-05T14:00:00.000Z');
const second10 = entryViewOf('TESTENTRYr1corr00002', receipt(P10, '2026-09-26T15:00:00.000Z', 2500, { history: [...cleanerHistory('2026-09-26T15:00:00.000Z').slice(0, 1), { at: '2026-10-08T14:00:00.000Z', action: 'approved', from: 'pending', to: 'approved', actor: ADMIN_ACTOR, reason: null }] }));
entries.push(first10, second10);
reports.push(sep10);
drafts.push(storedDraft(P10, '2026-09', draftOf('2026-09', [line('Revenue', 120000, 'L-rev10')], { supersedes: { reportId: sep10.id, reason: 'A receipt came late.' } })));

// A property with nothing: counted, not listed.
property('TESTPROPquietquiet01', '9 Quiet Lane');

// ─── The preview each row must equal ───
function preview(propertyId, month) {
  const mine = reports.filter((r) => r.propertyId === propertyId);
  const draft = drafts.find((d) => d.propertyId === propertyId && d.month === month) ?? null;
  const current = model.currentReports(mine).filter((r) => r.month === month).sort((a, b) => b.finishedAt.localeCompare(a.finishedAt))[0] ?? null;
  const frozen = draft ? (draft.finishedAs ? (mine.find((r) => r.id === draft.finishedAs) ?? current) : null) : current;
  if (frozen) return { standing: 'finished', costs: frozen.costs, adjustments: frozen.adjustments };
  const built = st.buildStatement({ propertyId, propertyName: 'x', month, entries: entries.filter((e) => e.property.id === propertyId), reports: mine, draft, management: record(propertyId) });
  if (built.kind !== 'ok') return { standing: 'unreadable', costs: [], adjustments: [] };
  return { standing: draft?.supersedes ? 'correcting' : 'open', costs: built.statement.costs, adjustments: built.statement.adjustments };
}
const part = (rows) => ({ count: rows.length, cents: rows.reduce((s, r) => s + (r.totalCents ?? r.deltaCents), 0) });
const words = (p) => `${p.count} · ${$(p.cents)}`;

let mismatches = 0;
for (const month of ['2026-09', '2026-10', '2026-11']) {
  const view = costsMonth({ month, properties, entries, reports, drafts: drafts.filter((d) => d.month === month), management });
  console.log(`\n═══ ${model.monthLabel(month)} · ${view.rows.length} rows, ${view.quiet} with nothing ═══`);
  for (const row of view.rows) {
    console.log(`  ${row.name} (${row.standing}): own ${words(row.own)} · late ${words(row.late)} · adjustments ${words(row.adjustments)} · charged ${$(row.chargedCents)} · waiting ${words(row.waiting)} · no amount ${row.noAmount}${row.unreadable.length ? ` · unreadable ${row.unreadable.join(',')}` : ''}`);
  }
  console.log(`  totals: own ${words(view.totals.own)} · late ${words(view.totals.late)} · adjustments ${words(view.totals.adjustments)} · charged ${$(view.totals.chargedCents)} · waiting ${words(view.totals.waiting)} · no amount ${view.totals.noAmount}`);
  for (const p of properties) {
    const row = view.rows.find((r) => r.propertyId === p.id) ?? null;
    const want = preview(p.id, month);
    const own = part(want.costs.filter((c) => c.group === 'month'));
    const late = part(want.costs.filter((c) => c.group === 'earlier'));
    const adj = part(want.adjustments);
    const got = row ?? { standing: want.standing, own: { count: 0, cents: 0 }, late: { count: 0, cents: 0 }, adjustments: { count: 0, cents: 0 }, chargedCents: 0 };
    const same = got.standing === want.standing && JSON.stringify([got.own, got.late, got.adjustments]) === JSON.stringify([own, late, adj]) && got.chargedCents === own.cents + late.cents + adj.cents;
    if (!same) {
      mismatches += 1;
      console.log(`  MISMATCH ${p.internalName}: row ${JSON.stringify([got.standing, got.own, got.late, got.adjustments])} · preview ${JSON.stringify([want.standing, own, late, adj])}`);
    }
  }
}
console.log(`\nevery row against its statement preview, ${properties.length} properties × 3 months: ${mismatches === 0 ? 'all equal' : `${mismatches} differ`}`);
