/**
 * The Costs page's Month tab (the Costs page, round 1): for one month, one row per property, from the month's money
 * (dispatch 37A, app/lib/money/month.ts: the one calculation every page showing a property-month's figures reads):
 *
 *   own          the costs of the month that the month's statement charges
 *   late         costs from earlier months it charges (a month already finished when they were logged or approved)
 *   adjustments  changes to costs an earlier statement printed, charged on it (below zero: given back)
 *   charged      the three together: what the statement charges for costs
 *   waiting      entries still pending that go on this statement once approved
 *   noAmount     cleanings with no amount that go on this statement once their amount is typed
 *
 * each as the property's statement preview shows it: the finished statement while the month is finished (also while
 * a correction is written, the correction's build), else the draft as it stands. A month already finished has nothing
 * waiting: what is approved or typed now goes on the next open statement. Properties with nothing for the month are
 * counted, not listed.
 *
 * Client-safe, and pure: the month's records in, rows out.
 */

import type { CostEntryView, PropertyNameView } from '@/app/lib/cleaners/model';
import { entryMonth } from './report';
import { monthMoney, type MoneyDraft } from '@/app/lib/money/month';
import { currentReports, type MonthlyReportView, type PropertyManagementView } from '@/app/lib/reports/model';
import { statementMonthFor } from '@/app/lib/reports/statement';
import { internalLabel } from '@/app/lib/property-names';

export interface CostsMonthInput {
  month: string;
  /** Every property, with its names. */
  properties: Pick<PropertyNameView, 'id' | 'name' | 'internalName'>[];
  /** Every cost entry and every cleaning (as an entry of kind `cleaning`), any property. */
  entries: CostEntryView[];
  /** Every finished statement. */
  reports: MonthlyReportView[];
  /** The month's drafts. */
  drafts: (MoneyDraft & { propertyId: string; month: string })[];
  /** Every management record. */
  management: PropertyManagementView[];
}

export interface Part {
  count: number;
  cents: number;
}

export interface CostsMonthRow {
  propertyId: string;
  /** The name the admin shows: its cleaner-facing name, usually the address, else its public title. */
  name: string;
  /** Its public title, under the name. */
  publicName: string | null;
  /** finished: the month's statement is finished; correcting: a correction of it is being written; open: not finished. */
  standing: 'finished' | 'correcting' | 'open';
  own: Part;
  late: Part;
  adjustments: Part;
  chargedCents: number;
  waiting: Part;
  noAmount: number;
  /** Approved entries whose lines cannot be read: the statement cannot be built while they stand. */
  unreadable: string[];
}

export interface CostsMonth {
  month: string;
  rows: CostsMonthRow[];
  totals: { own: Part; late: Part; adjustments: Part; chargedCents: number; waiting: Part; noAmount: number };
  /** Properties with nothing for the month. */
  quiet: number;
}

const none = (): Part => ({ count: 0, cents: 0 });
const add = (part: Part, cents: number): Part => ({ count: part.count + 1, cents: part.cents + cents });
const sum = (a: Part, b: Part): Part => ({ count: a.count + b.count, cents: a.cents + b.cents });

/** One property's row, as its statement preview gives it. */
export function costsMonthRow(input: Omit<CostsMonthInput, 'properties' | 'drafts' | 'management'> & { property: Pick<PropertyNameView, 'id' | 'name' | 'internalName'>; draft: MoneyDraft | null; management: PropertyManagementView | null }): CostsMonthRow {
  const { month, property, draft, management } = input;
  const propertyId = property.id;
  const entries = input.entries.filter((entry) => entry.property.id === propertyId);
  const reports = input.reports.filter((report) => report.propertyId === propertyId);
  const name = internalLabel(property) ?? 'Unnamed property';
  const money = monthMoney({ propertyId, propertyName: name, month, entries, reports, draft, management });
  const standing: CostsMonthRow['standing'] = money.correcting ? 'correcting' : money.report !== null && money.build === null ? 'finished' : 'open';
  let own = none();
  let late = none();
  let adjustments = none();
  const statement = money.statement;
  if (statement !== null) {
    for (const row of statement.costs) {
      if (row.group === 'earlier') late = add(late, row.totalCents);
      else own = add(own, row.totalCents);
    }
    for (const row of statement.adjustments) adjustments = add(adjustments, row.deltaCents);
  }
  // What goes on this statement once decided or typed: nothing while it is finished; else what its month's rule sends here.
  let waiting = none();
  let noAmount = 0;
  if (standing !== 'finished') {
    const finished = new Set(currentReports(reports).map((report) => report.month).filter((m) => standing !== 'correcting' || m !== month));
    for (const entry of entries) {
      if (entry.status !== 'pending') continue;
      const own = entryMonth(entry);
      if (own === null || statementMonthFor(own, finished) !== month) continue;
      if (entry.kind === 'cleaning') noAmount += 1;
      else waiting = add(waiting, entry.linesNow.kind === 'ok' ? entry.linesNow.totalCents : 0);
    }
  }
  const unreadable = statement === null && money.build?.kind === 'unreadable' ? money.build.entryIds : [];
  return { propertyId, name, publicName: property.name, standing, own, late, adjustments, chargedCents: own.cents + late.cents + adjustments.cents, waiting, noAmount, unreadable };
}

/** Every property's row for the month: those with anything, A to Z by name; the others counted. */
export function costsMonth(input: CostsMonthInput): CostsMonth {
  const rows: CostsMonthRow[] = [];
  let quiet = 0;
  for (const property of input.properties) {
    const draft = input.drafts.find((d) => d.propertyId === property.id && d.month === input.month) ?? null;
    const management = input.management.find((m) => m.propertyId === property.id) ?? null;
    const row = costsMonthRow({ month: input.month, property, entries: input.entries, reports: input.reports, draft, management });
    const busy = row.own.count + row.late.count + row.adjustments.count + row.waiting.count + row.noAmount + row.unreadable.length > 0;
    if (busy) rows.push(row);
    else quiet += 1;
  }
  rows.sort((a, b) => a.name.localeCompare(b.name, 'en-CA') || a.propertyId.localeCompare(b.propertyId));
  const totals = rows.reduce(
    (t, row) => ({ own: sum(t.own, row.own), late: sum(t.late, row.late), adjustments: sum(t.adjustments, row.adjustments), chargedCents: t.chargedCents + row.chargedCents, waiting: sum(t.waiting, row.waiting), noAmount: t.noAmount + row.noAmount }),
    { own: none(), late: none(), adjustments: none(), chargedCents: 0, waiting: none(), noAmount: 0 },
  );
  return { month: input.month, rows, totals, quiet };
}
