/**
 * What one month's package is made from (FINANCIAL-MANAGEMENT-PLAN.md §2.7,
 * dispatch 24): which properties have a folder, the statement each folder
 * holds — the current finished one, or the statement as it stands — the
 * entries they name, the entries sent in the month that no statement of it
 * charges, and the stored documents for `Records/`.
 *
 * `selectMonthPackage` runs where every entry and statement can be read (the
 * admin route today, the backup's function next): an unfinished month's
 * statement depends on every entry and statement of its property, and the
 * same `buildStatement` the editor's preview and the finish step run works it
 * out. What it returns is bounded by the month — its statements, the entries
 * they name, the entries sent in it — and is what the browser builds the
 * files from (package.ts).
 *
 * Kian's rulings of 2026-10-03 apply: no versions (only a month's current
 * statement is in it; a corrected one replaces the old), nothing deleted kept
 * (it is read from what Nubnb holds now), owners' folders apart from Nubnb's.
 *
 * Client-safe, and pure.
 */

import { readCostEntryFields, readLinesNow, type CostEntryView } from '@/app/lib/cleaners/model';
import { sentDay } from '@/app/lib/costs/report';
import {
  currentReports,
  inStatementScope,
  isExcludedFromReporting,
  lineFromIncomeRow,
  monthRange,
  type MonthlyReportView,
  type PropertyManagementView,
  type ReportDownloadView,
  type StatementDraftView,
} from '@/app/lib/reports/model';
import { buildStatement, monthStanding, statementOf, type AnyStatement, type Standing, type Statement } from '@/app/lib/reports/statement';

export const MONTH_PACKAGE_SCHEMA_VERSION = 1;

/** A stored document with its ID, as `Records/` holds it. */
export type StoredDocument = { id: string } & Record<string, unknown>;

/** A statement document's own place in the package, when the month has a current finished one. */
export interface PackageReport {
  id: string;
  finishedAt: string;
  reference: string;
  pdf: { bytes: number; sha256: string };
  /** Every download record of it, oldest first (the package's own included). */
  downloads: { at: string; via: string | null }[];
}

/** One property's month that has a folder. */
export interface PackageFolder {
  propertyId: string;
  propertyName: string;
  /** The month's standing in the cycle (`monthStanding`): the same words as the list's column. */
  standing: Standing;
  /** What the folder's statement is: finished, a draft as it stands, or the costs alone. */
  kind: 'finished' | 'draft' | 'none';
  report: PackageReport | null;
  draftUpdatedAt: string | null;
  /** The Payment Summary as finished, or as it stands. */
  statement: Statement;
  /** An approved entry that could not be added up: no statement can be worked out; said in the README. */
  unreadable: string[];
}

/** One property, for Nubnb's fee income: every property has a row, folder or not. */
export interface PackageProperty {
  id: string;
  name: string;
  standing: Standing;
  draft: boolean;
  hasFolder: boolean;
}

/** An entry sent in the month that the month's statements do not charge. */
export interface NotCharged {
  entryId: string;
  propertyId: string | null;
  propertyName: string;
  /** The current statement that prints it, of another month, if any. */
  printedIn: { reportId: string; month: string; reference: string } | null;
}

/** Everything the browser needs to build the month's files, apart from the bytes of the PDFs and receipts. */
export interface MonthPackageData {
  schemaVersion: number;
  month: string;
  /** yyyy-mm-dd, Toronto, when the package was made. */
  today: string;
  /** ISO, when the package was made. */
  madeAt: string;
  properties: PackageProperty[];
  folders: PackageFolder[];
  notCharged: NotCharged[];
  /** The entries the package names, as stored, by ID, the Storage path of each receipt left out. */
  entries: Record<string, StoredDocument>;
  /** Statements an adjustment names, so the workbook can say where an entry was printed. */
  printedStatements: Record<string, { month: string; reference: string }>;
  /** The month's stored documents, for `Records/`. */
  records: {
    monthlyReports: StoredDocument[];
    drafts: StoredDocument[];
    downloads: StoredDocument[];
    management: StoredDocument[];
  };
}

/** A receipt or statement PDF to fetch, by the key the package uses for it. */
export interface PackageObject {
  key: string;
  /** Storage path: read on the server only, never sent to a browser. */
  path: string;
}

/** The key of an entry's receipt in the package's maps. */
export const receiptKey = (entryId: string, index: number) => `receipt:${entryId}:${index}`;
/** The key of a statement's PDF in the package's maps. */
export const statementKey = (reportId: string) => `statement:${reportId}`;

/** An entry as the reports read it, from its stored document alone: the cleaner's and property's names as recorded. */
export function entryViewOf(id: string, stored: Record<string, unknown>): CostEntryView {
  const entry = readCostEntryFields(id, stored);
  return {
    id: entry.id,
    createdAt: entry.createdAt,
    status: entry.status,
    statusChangedAt: entry.statusChangedAt,
    statusReason: entry.statusReason,
    history: entry.history,
    cleaner: { id: entry.cleanerId, nameAtEntry: entry.cleanerNameAtEntry, state: 'found', name: null, status: null },
    property: { id: entry.propertyId, nameAtEntry: entry.propertyNameAtEntry, state: 'found', name: null },
    purchasedOn: entry.purchasedOn,
    note: entry.note,
    currency: entry.currency,
    lines: entry.lines,
    linesNow: readLinesNow(entry.lines, entry.history, { shape: entry.taxShape, cents: entry.taxCents }),
    receipts: entry.receipts,
    taxShape: entry.taxShape,
    kind: entry.kind,
    autoApproved: entry.autoApproved,
  };
}

/** A finished statement of any version in the Payment Summary's shape: a legacy one's income rows read as lines. */
export function asStatement(any: AnyStatement): Statement {
  if (!any.legacy) return any;
  return {
    legacy: false,
    propertyName: any.propertyName,
    month: any.month,
    reference: '',
    reportDate: '',
    reportFor: null,
    draft: false,
    lines: any.income.map(lineFromIncomeRow),
    costs: any.costs,
    adjustments: any.adjustments,
    fee: any.fee ? { label: any.fee.label, rateBasisPoints: null, baseCents: 0, computedCents: null, amountCents: any.fee.amountCents, overwritten: true } : null,
    carried: null,
    incomeCents: any.incomeCents,
    expensesCents: 0,
    recordedCents: any.costsCents,
    costsCents: any.costsCents,
    feeCents: any.feeCents,
    totalCents: any.payableCents,
    carriedCents: 0,
    payableCents: any.payableCents,
    pendingLeftOut: any.pendingLeftOut,
    notes: any.notes,
    supersedes: null,
  };
}

/** A stored document without the Storage path of its receipts: paths never leave the server. */
export function withoutPaths(id: string, stored: Record<string, unknown>): StoredDocument {
  const receipts = Array.isArray(stored.receipts)
    ? stored.receipts.map((receipt) => {
        if (!receipt || typeof receipt !== 'object') return receipt;
        const { path: _path, ...rest } = receipt as Record<string, unknown>;
        void _path;
        return rest;
      })
    : stored.receipts;
  return { id, ...stored, ...(Array.isArray(stored.receipts) ? { receipts } : {}) };
}

export interface SelectInputs {
  month: string;
  today: string;
  madeAt: string;
  /** Every property: its ID and name. */
  properties: { id: string; name: string | null }[];
  /** Every cost entry, as stored. */
  entries: { id: string; stored: Record<string, unknown> }[];
  /** Every finished statement, read, with its stored document. */
  reports: { view: MonthlyReportView; stored: Record<string, unknown> }[];
  /** The month's drafts, read, with their stored documents. */
  drafts: { view: StatementDraftView; stored: Record<string, unknown> }[];
  /** The month's download records, read, with their stored documents. */
  downloads: { view: ReportDownloadView; stored: Record<string, unknown> }[];
  /** Every management record, read, with its stored document. */
  management: { view: PropertyManagementView; stored: Record<string, unknown> }[];
}

export interface Selection {
  data: MonthPackageData;
  /** The objects to sign links for: every receipt and statement PDF the package holds. */
  objects: PackageObject[];
  /** The current finished statements the package holds: one download record each. */
  reportIds: string[];
}

/**
 * Which properties have a folder, what each holds, and what Nubnb's folder
 * lists. A property has a folder when its month has a current finished
 * statement, a draft, or a cost a statement charges or would charge.
 */
export function selectMonthPackage(input: SelectInputs): Selection {
  const { month, today } = input;
  const range = monthRange(month);
  const views = new Map(input.entries.map(({ id, stored }) => [id, entryViewOf(id, stored)]));
  const storedEntries = new Map(input.entries.map(({ id, stored }) => [id, stored]));
  const allReports = input.reports.map((r) => r.view);
  const current = currentReports(allReports);
  const management = new Map(input.management.map((m) => [m.view.propertyId, m.view]));
  const inMonth = (entry: CostEntryView) => {
    const day = sentDay(entry.createdAt);
    return day !== null && day >= range.from && day <= range.to;
  };

  const folders: PackageFolder[] = [];
  const properties: PackageProperty[] = [];
  const charged = new Set<string>();
  const named = new Set<string>();
  const objects: PackageObject[] = [];
  const reportIds: string[] = [];

  const sorted = [...input.properties].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', 'en-CA') || a.id.localeCompare(b.id));
  for (const property of sorted) {
    const name = property.name?.trim() || 'Unnamed property';
    const record = management.get(property.id) ?? null;
    const reportsOfProperty = allReports.filter((report) => report.propertyId === property.id);
    const live = current.find((report) => report.propertyId === property.id && report.month === month) ?? null;
    const draft = input.drafts.find((d) => d.view.propertyId === property.id && d.view.month === month && d.view.finishedAs === null)?.view ?? null;
    const standing = monthStanding({ month, today, owed: inStatementScope(record, month), finished: live !== null, excluded: isExcludedFromReporting(record) });

    let statement: Statement | null = null;
    let unreadable: string[] = [];
    if (live) {
      statement = asStatement(statementOf(live, reportsOfProperty));
    } else {
      const entries = [...views.values()].filter((entry) => entry.property.id === property.id);
      const built = buildStatement({ propertyId: property.id, propertyName: name, month, entries, reports: reportsOfProperty, draft, management: record });
      if (built.kind === 'ok') statement = built.statement;
      else unreadable = built.entryIds;
    }

    const hasCosts = statement !== null && (statement.costs.length > 0 || statement.adjustments.length > 0);
    const hasFolder = live !== null || draft !== null || hasCosts || unreadable.length > 0;
    properties.push({ id: property.id, name, standing, draft: draft !== null, hasFolder });
    if (!hasFolder) continue;

    const folderStatement: Statement =
      statement ??
      asStatement({ legacy: true, propertyName: name, month, owners: [], ref: null, finishedAt: null, income: [], incomeCents: 0, costs: [], adjustments: [], costsCents: 0, fee: null, feeCents: 0, payableCents: 0, pendingLeftOut: 0, notes: null, supersedes: null });
    for (const row of folderStatement.costs) {
      charged.add(row.entryId);
      named.add(row.entryId);
    }
    for (const row of folderStatement.adjustments) named.add(row.entryId);
    for (const id of unreadable) named.add(id);

    let report: PackageReport | null = null;
    if (live) {
      reportIds.push(live.id);
      objects.push({ key: statementKey(live.id), path: live.pdf.path });
      report = {
        id: live.id,
        finishedAt: live.finishedAt,
        reference: live.reference,
        pdf: { bytes: live.pdf.bytes, sha256: live.pdf.sha256 },
        downloads: input.downloads
          .filter((d) => d.view.reportId === live.id)
          .map((d) => ({ at: d.view.at, via: d.view.via ?? null }))
          .sort((a, b) => a.at.localeCompare(b.at)),
      };
    }
    folders.push({ propertyId: property.id, propertyName: name, standing, kind: live ? 'finished' : draft ? 'draft' : 'none', report, draftUpdatedAt: live ? null : (draft?.updatedAt ?? null), statement: folderStatement, unreadable });
  }

  // Entries sent in the month that the month's statements do not charge: Nubnb's folder.
  const printedBy = new Map<string, { reportId: string; month: string; reference: string }>();
  for (const report of current) for (const entryId of report.entryIds) printedBy.set(entryId, { reportId: report.id, month: report.month, reference: report.reference });
  const names = new Map(input.properties.map((p) => [p.id, p.name?.trim() || 'Unnamed property']));
  const notCharged: NotCharged[] = [];
  for (const entry of [...views.values()].filter(inMonth).sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id))) {
    if (charged.has(entry.id)) continue;
    named.add(entry.id);
    const printed = printedBy.get(entry.id) ?? null;
    notCharged.push({
      entryId: entry.id,
      propertyId: entry.property.id,
      propertyName: (entry.property.id ? names.get(entry.property.id) : undefined) ?? entry.property.nameAtEntry ?? 'Unknown property',
      printedIn: printed && printed.month !== month ? printed : null,
    });
  }

  // The receipts the package holds: every named entry's.
  const entries: Record<string, StoredDocument> = {};
  for (const id of [...named].sort()) {
    const stored = storedEntries.get(id);
    if (!stored) continue;
    entries[id] = withoutPaths(id, stored);
    const receipts = Array.isArray(stored.receipts) ? stored.receipts : [];
    receipts.forEach((receipt, index) => {
      const path = receipt && typeof receipt === 'object' ? (receipt as { path?: unknown }).path : undefined;
      if (typeof path === 'string') objects.push({ key: receiptKey(id, index), path });
    });
  }

  // Statements an adjustment names, for the "printed in" column.
  const printedStatements: Record<string, { month: string; reference: string }> = {};
  for (const folder of folders) {
    for (const row of folder.statement.adjustments) {
      const printed = allReports.find((report) => report.id === row.statementId);
      if (printed) printedStatements[printed.id] = { month: printed.month, reference: printed.reference };
    }
  }

  const reportsInPackage = new Set(reportIds);
  return {
    data: {
      schemaVersion: MONTH_PACKAGE_SCHEMA_VERSION,
      month,
      today,
      madeAt: input.madeAt,
      properties,
      folders,
      notCharged,
      entries,
      printedStatements,
      records: {
        monthlyReports: input.reports.filter((r) => reportsInPackage.has(r.view.id)).map((r) => ({ id: r.view.id, ...r.stored })),
        drafts: input.drafts.map((d) => ({ id: d.view.id, ...d.stored })),
        downloads: input.downloads.filter((d) => reportsInPackage.has(d.view.reportId)).map((d) => ({ id: d.view.id, ...d.stored })),
        management: input.management.map((m) => ({ id: m.view.id, ...m.stored })),
      },
    },
    objects,
    reportIds,
  };
}
