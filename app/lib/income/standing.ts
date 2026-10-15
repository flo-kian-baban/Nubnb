/**
 * The property list's Income column (Kian's rulings of 2026-10-15, part A of PROPERTY-LIST-COLUMNS-PLAN.md): where
 * each property's income for the month due stands, in one badge. Pure and client-safe.
 *
 * The month is the last closed one, the month the Statement column names: a platform's file for a month exists only
 * after it ends. What is waiting for review and what is missing from the month's file are the Income page's own
 * (`monthView`), so the column and the Income page cannot disagree.
 *
 * Direct payments (part B) add their own states to this column when they are built.
 */

import { formatCents } from '@/app/lib/cleaners/model';
import { monthLabel } from '@/app/lib/reports/model';
import { monthView } from './month';
import { isActiveTitle, type EarningsLineView, type EarningsUploadView, type TitleLinkView } from './model';

/** One property's income for the month, as the column needs it. */
export interface IncomeFacts {
  /** It has an active title on a platform (dispatch 37C). */
  activeTitle: boolean;
  /** Lines under its active or previous titles still waiting for review: the Income page's To review. */
  review: number;
  /** Of those, the lines of a row type Nubnb does not recognise: each needs a decision of its own. */
  undecided: number;
  /** Its active title is not in the month's file, for a month after the title became active: the Income page's gap. */
  missing: boolean;
  /** Lines of the month accepted for it, and what they add up to. */
  accepted: number;
  acceptedCents: number;
}

/** The month's income for every property that has any of it, and whether the month's file is in. */
export interface IncomeRead {
  month: string;
  /** Airbnb's file for the month has been uploaded. */
  uploaded: boolean;
  /** By property ID. A property not here has none of it: no title, nothing waiting, nothing accepted. */
  properties: Record<string, IncomeFacts>;
}

const NO_FACTS: IncomeFacts = { activeTitle: false, review: 0, undecided: 0, missing: false, accepted: 0, acceptedCents: 0 };

/** The facts, from the month's uploads, the month's lines and every title link: what the server reads. */
export function incomeReadOf(input: { month: string; uploads: Pick<EarningsUploadView, 'platform' | 'month' | 'titles'>[]; lines: EarningsLineView[]; links: TitleLinkView[] }): IncomeRead {
  const uploads = input.uploads.filter((upload) => upload.month === input.month);
  const lines = input.lines.filter((line) => line.month === input.month);
  // The Income page's own view of the month: statements, names and the calendar are not needed for its review groups
  // and its missing titles, which read only the lines, the links and the files.
  const view = monthView({ uploads, lines, links: input.links, lastSeen: {}, properties: [], statements: [], calendar: { checkIns: [] }, month: input.month });
  const properties: Record<string, IncomeFacts> = {};
  const facts = (id: string) => (properties[id] ??= { ...NO_FACTS });
  for (const link of input.links) if (isActiveTitle(link) && link.propertyId) facts(link.propertyId).activeTitle = true;
  for (const group of view.review) {
    facts(group.propertyId).review += group.lines.length;
    facts(group.propertyId).undecided += group.undecided;
  }
  for (const gap of view.gaps.missing) if (gap.link.propertyId) facts(gap.link.propertyId).missing = true;
  for (const line of lines) {
    if (line.status !== 'accepted' || line.decided?.status !== 'accepted') continue;
    facts(line.decided.propertyId).accepted += 1;
    facts(line.decided.propertyId).acceptedCents += line.decided.amountCents;
  }
  return { month: input.month, uploaded: uploads.some((upload) => upload.platform === 'airbnb'), properties };
}

export type IncomeTone = 'done' | 'warning' | 'none';

/** Where a link from the cell goes: the Income page at the month, the property's page at the month, its Airbnb title. */
export type IncomeTarget = 'income' | 'property' | 'title';

export interface IncomeStanding {
  key: 'review' | 'missing' | 'received' | 'no-title' | 'no-file' | 'no-income';
  label: string;
  tone: IncomeTone;
  /** The month the badge is about; null when it is about no month (no title). */
  month: string | null;
  target: IncomeTarget;
  /** The tooltip: the detail, in a sentence. */
  title: string;
}

const lines = (n: number) => `${n} ${n === 1 ? 'line' : 'lines'}`;

/** One property's badge, worst first: waiting for review, missing from the file, received, then the quiet words. */
export function incomeStanding(read: IncomeRead, propertyId: string): IncomeStanding {
  const f = read.properties[propertyId] ?? NO_FACTS;
  const month = read.month;
  const when = monthLabel(month);
  if (f.review > 0) {
    const decide = f.undecided > 0 ? ` (${f.undecided} ${f.undecided === 1 ? 'needs' : 'need'} a decision on its type)` : '';
    return { key: 'review', label: `To review · ${f.review}`, tone: 'warning', month, target: 'income', title: `${when}: ${lines(f.review)} from Airbnb's file ${f.review === 1 ? 'waits' : 'wait'} for review${decide}` };
  }
  if (f.missing) return { key: 'missing', label: 'Not in file', tone: 'warning', month, target: 'income', title: `${when}: its Airbnb title is not in the month's file` };
  if (f.accepted > 0) return { key: 'received', label: 'Received', tone: 'done', month, target: 'property', title: `${when}: ${lines(f.accepted)} accepted, ${formatCents(f.acceptedCents)}` };
  if (!f.activeTitle) return { key: 'no-title', label: 'No Airbnb title', tone: 'none', month: null, target: 'title', title: 'No Airbnb title is set: set it on its edit page' };
  if (!read.uploaded) return { key: 'no-file', label: 'No file yet', tone: 'none', month, target: 'income', title: `${when}: Airbnb's file has not been uploaded` };
  return { key: 'no-income', label: 'No income', tone: 'none', month, target: 'property', title: `${when}: nothing accepted for it` };
}
