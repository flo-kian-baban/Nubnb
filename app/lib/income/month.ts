/**
 * The Income page's month, worked out from its one read (dispatch 27): which
 * property each line is under, what waits for review, what was decided, each
 * property's income in its statement, and the gaps — shown without anyone
 * looking for them (Kian's ruling):
 *   - titles in the month's lines that are not linked to a property;
 *   - properties with a check-in in the month on their calendar and no line
 *     for the month, in their statement or proposed;
 *   - linked titles missing from the month's file.
 *
 * The Income page and the property page's Income tab read the same lines:
 * a statement's lines are its draft's, and nothing is copied between them.
 *
 * Pure and client-safe.
 */

import type { Line } from '@/app/lib/reports/model';
import { lineInDraft, normaliseTitle, type EarningsLineView, type EarningsUploadView, type IncomeChannel, type TitleLinkView } from './model';

/** What the month's read holds, as this module needs it. */
export interface MonthInputs {
  uploads: Pick<EarningsUploadView, 'platform' | 'titles'>[];
  lines: EarningsLineView[];
  links: TitleLinkView[];
  lastSeen: Record<string, string>;
  properties: { id: string; name: string }[];
  statements: { propertyId: string; finished: boolean; lines: Line[] }[];
  calendar: { checkIns: { propertyId: string; days: string[] }[] };
}

export interface TitleRow {
  platform: IncomeChannel;
  title: string;
  rows: number;
  amountCents: number;
  link: TitleLinkView | null;
}

export interface ReviewGroup {
  propertyId: string;
  name: string;
  /** The month's statement for the property is finished: nothing is accepted into it. */
  finished: boolean;
  lines: EarningsLineView[];
  amountCents: number;
}

export interface PropertyIncomeRow {
  propertyId: string;
  /** null for a property that no longer exists. */
  name: string | null;
  lines: number;
  /** Lines that came from a file, accepted. */
  fromFile: number;
  revenueCents: number;
  expensesCents: number;
  finished: boolean;
}

export interface MonthView {
  titles: TitleRow[];
  review: ReviewGroup[];
  rejected: EarningsLineView[];
  /** Accepted, and its statement line has since been removed from the draft. */
  removed: EarningsLineView[];
  /** Accepted and still in the statement. */
  accepted: EarningsLineView[];
  byProperty: PropertyIncomeRow[];
  gaps: {
    unlinked: TitleRow[];
    checkIns: { propertyId: string; name: string; days: string[] }[];
    missing: { link: TitleLinkView; name: string | null; lastSeen: string | null }[];
  };
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

/** The link a line's title has, if any. */
export function linkOf(links: TitleLinkView[], platform: IncomeChannel, title: string): TitleLinkView | null {
  const key = normaliseTitle(title);
  return links.find((link) => link.platform === platform && link.title === key) ?? null;
}

export function monthView(input: MonthInputs): MonthView {
  const names = new Map(input.properties.map((p) => [p.id, p.name]));
  const statements = new Map(input.statements.map((s) => [s.propertyId, s]));

  // ── Titles: every title in the month's lines, with its rows, total and link ──
  const titleMap = new Map<string, TitleRow>();
  for (const line of input.lines) {
    const key = `${line.platform}|${line.listingTitle}`;
    const row = titleMap.get(key) ?? { platform: line.platform, title: line.listingTitle, rows: 0, amountCents: 0, link: linkOf(input.links, line.platform, line.listingTitle) };
    row.rows += 1;
    row.amountCents += line.amountCents;
    titleMap.set(key, row);
  }
  const titles = [...titleMap.values()].sort((a, b) => a.title.localeCompare(b.title));

  // ── To review: proposed lines under a linked title, by property ──
  const groups = new Map<string, ReviewGroup>();
  for (const line of input.lines) {
    if (line.status !== 'proposed') continue;
    const link = linkOf(input.links, line.platform, line.listingTitle);
    if (!link) continue;
    const group = groups.get(link.propertyId) ?? { propertyId: link.propertyId, name: names.get(link.propertyId) ?? 'A deleted property', finished: statements.get(link.propertyId)?.finished ?? false, lines: [], amountCents: 0 };
    group.lines.push(line);
    group.amountCents += line.amountCents;
    groups.set(link.propertyId, group);
  }
  const review = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));

  const rejected = input.lines.filter((line) => line.status === 'rejected');
  const accepted: EarningsLineView[] = [];
  const removed: EarningsLineView[] = [];
  for (const line of input.lines) {
    if (line.decided?.status !== 'accepted') continue;
    const statement = statements.get(line.decided.propertyId);
    (statement && lineInDraft(statement.lines, line.decided.lineId) ? accepted : removed).push(line);
  }

  // ── By property: the month's statements with lines, as the property page's Income tab adds them up ──
  const fromFileIds = new Set(accepted.map((line) => (line.decided?.status === 'accepted' ? line.decided.lineId : '')));
  const byProperty = input.statements
    .filter((s) => s.lines.length > 0)
    .map((s) => ({
      propertyId: s.propertyId,
      name: names.get(s.propertyId) ?? null,
      lines: s.lines.length,
      fromFile: s.lines.filter((line) => fromFileIds.has(line.id)).length,
      revenueCents: sum(s.lines.filter((line) => line.amountCents > 0).map((line) => line.amountCents)),
      expensesCents: -sum(s.lines.filter((line) => line.amountCents < 0).map((line) => line.amountCents)),
      finished: s.finished,
    }))
    .sort((a, b) => (a.name ?? '￿').localeCompare(b.name ?? '￿'));

  // ── Gaps ──
  const unlinked = titles.filter((row) => row.link === null);
  const withLines = new Set<string>([...input.statements.filter((s) => s.lines.length > 0).map((s) => s.propertyId), ...review.map((g) => g.propertyId)]);
  const checkIns = input.calendar.checkIns
    .filter((c) => names.has(c.propertyId) && !withLines.has(c.propertyId))
    .map((c) => ({ propertyId: c.propertyId, name: names.get(c.propertyId)!, days: c.days }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const uploadedPlatforms = new Set(input.uploads.map((u) => u.platform));
  const inFiles = new Set(input.uploads.flatMap((u) => u.titles.map((t) => `${u.platform}|${t.title}`)));
  const missing = input.links
    .filter((link) => uploadedPlatforms.has(link.platform) && !inFiles.has(`${link.platform}|${link.title}`))
    .map((link) => ({ link, name: names.get(link.propertyId) ?? null, lastSeen: input.lastSeen[link.id] ?? null }));

  return { titles, review, rejected, removed, accepted, byProperty, gaps: { unlinked, checkIns, missing } };
}

/** The property a title most likely is: the one property whose name is the title, when exactly one is. Offered, never applied. */
export function suggestedProperty(properties: { id: string; name: string }[], title: string): string | null {
  const key = normaliseTitle(title).toLowerCase();
  const same = properties.filter((p) => normaliseTitle(p.name).toLowerCase() === key);
  return same.length === 1 ? same[0].id : null;
}
