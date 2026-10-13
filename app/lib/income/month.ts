/**
 * The Income page's month, worked out from its one read (dispatch 27): which
 * property each line is under, what waits for review, what was decided, each
 * property's income in its statement, and the gaps — shown without anyone
 * looking for them (Kian's ruling):
 *   - titles in the month's lines that are not linked to a property;
 *   - properties with a check-in in the month on their calendar and no line
 *     for the month, in their statement or proposed;
 *   - linked titles missing from the month's file.
 * A title set aside as "not a Nubnb property" (dispatch 36, Kian's ruling of
 * 2026-10-12) stays in the titles, marked; it is in none of the gaps, and
 * proposes nothing for review.
 *
 * The Income page and the property page's Income tab read the same lines.
 * Since dispatch 37C (Kian's ruling M10) an accepted line is read where it is
 * stored: a statement's lines are the accepted lines it places (M11) and the
 * lines typed on its draft. A line accepted before 37C was copied into the
 * draft and is read there, as it is.
 *
 * A linked title missing from the month's file is listed only when it is its
 * property's active title, and only for months after it became so (Kian's
 * ruling of 2026-10-13): a renamed listing's earlier months are not flagged.
 *
 * Dispatch 37C also shows, without anyone looking for them: a line whose row
 * type Nubnb does not recognise, as needing a decision (Kian's ruling of
 * 2026-10-13); a line that may already be on the statement (I2: the same
 * booking at another amount, or a typed line of the same amount and dates);
 * a property that owes no statement for the month (I5); and a title that
 * may be a linked title renamed (M14), offered and never applied.
 * Their figures are the month's money's (dispatch 37A): `incomeFigures`, the
 * function the property page's figures come from, places each line by its
 * source, so an Airbnb claw-back takes revenue off and is never an expense
 * (Kian's ruling M1). While a correction is written, a property's figures are
 * the statement as sent, the correction's beside them (T2).
 *
 * Pure and client-safe.
 */

import { monthLabel, monthOfDay, monthRange, type Line } from '@/app/lib/reports/model';
import { sentDay } from '@/app/lib/costs/report';
import { airbnbLineIdsOf, incomeFigures } from '@/app/lib/money/month';
import { formatCents } from '@/app/lib/cleaners/model';
import { isActiveTitle, isCopied, isKnownType, isReadWhereStored, lineInDraft, normaliseTitle, type EarningsLineView, type EarningsUploadView, type IncomeChannel, type TitleLinkView } from './model';

/** What the month's read holds, as this module needs it. */
export interface MonthInputs {
  uploads: Pick<EarningsUploadView, 'platform' | 'titles'>[];
  lines: EarningsLineView[];
  links: TitleLinkView[];
  lastSeen: Record<string, string>;
  properties: { id: string; name: string }[];
  statements: { propertyId: string; finished: boolean; lines: Line[]; sent?: Line[] | null }[];
  calendar: { checkIns: { propertyId: string; days: string[] }[] };
  /** Properties that owe no statement for the month, and why (I5): excluded from reporting, or outside their record's months. */
  noStatement?: { propertyId: string; why: string }[];
  /** The month, for the check-ins on its last day: paid in the next month's file (I8). */
  month?: string;
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
  /** The month's statement for the property is finished: a line accepted now goes on the next open one (M11). */
  finished: boolean;
  lines: EarningsLineView[];
  amountCents: number;
  /** Lines of a row type Nubnb does not recognise: each needs a decision of its own, never accepted with the rest. */
  undecided: number;
  /** Why the property owes no statement for the month, when it does not (I5); null when it does. */
  noStatement: string | null;
}

export interface PropertyIncomeRow {
  propertyId: string;
  /** null for a property that no longer exists. */
  name: string | null;
  lines: number;
  /** Lines that came from a file, accepted. */
  fromFile: number;
  /** The month's money's revenue: Airbnb's lines, claw-backs taken off, and typed lines above zero (M1). */
  revenueCents: number;
  /** What Airbnb paid, in that revenue. */
  airbnbCents: number;
  /** Typed lines below zero, as an amount. */
  expensesCents: number;
  /** Lines under its titles still waiting for review, added up: apart, in no statement until accepted. */
  waitingCents: number;
  finished: boolean;
  /** While a correction is written: its revenue and expenses; the row's are the statement as sent. */
  correction: { revenueCents: number; expensesCents: number } | null;
}

export interface MonthView {
  titles: TitleRow[];
  review: ReviewGroup[];
  rejected: EarningsLineView[];
  /** Accepted before dispatch 37C, copied into a draft, and its statement line has since been removed from it. */
  removed: EarningsLineView[];
  /** Accepted: read where it is stored, or (before 37C) a copy still in its draft. */
  accepted: EarningsLineView[];
  /** What a proposed line may duplicate (I2), by line ID: one sentence each. */
  warnings: Map<string, string[]>;
  byProperty: PropertyIncomeRow[];
  gaps: {
    unlinked: TitleRow[];
    checkIns: { propertyId: string; name: string; days: string[] }[];
    missing: { link: TitleLinkView; name: string | null; lastSeen: string | null }[];
  };
}

/**
 * The Toronto month a link became its property's active title: the month it was last linked. A title is "not in this
 * month's file" only for months after it (Kian's ruling of 2026-10-13). null when the time is not a date.
 */
export function activeMonthOf(link: Pick<TitleLinkView, 'linkedAt'>): string | null {
  const day = sentDay(link.linkedAt);
  return day === null ? null : monthOfDay(day);
}

/** Whether a line's row type is one Nubnb recognises; any other needs a decision (Kian's ruling of 2026-10-13). */
export function needsDecision(line: Pick<EarningsLineView, 'platform' | 'type'>): boolean {
  return !isKnownType(line.platform, line.type);
}

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
    if (!link || link.propertyId === null) continue;
    const group = groups.get(link.propertyId) ?? {
      propertyId: link.propertyId,
      name: names.get(link.propertyId) ?? 'A deleted property',
      finished: statements.get(link.propertyId)?.finished ?? false,
      lines: [],
      amountCents: 0,
      undecided: 0,
      noStatement: input.noStatement?.find((row) => row.propertyId === link.propertyId)?.why ?? null,
    };
    group.lines.push(line);
    group.amountCents += line.amountCents;
    if (needsDecision(line)) group.undecided += 1;
    groups.set(link.propertyId, group);
  }
  const review = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));

  const rejected = input.lines.filter((line) => line.status === 'rejected');
  const accepted: EarningsLineView[] = [];
  const removed: EarningsLineView[] = [];
  for (const line of input.lines) {
    if (line.decided?.status !== 'accepted') continue;
    // Read where it is stored (dispatch 37C): accepted until an admin sends it back; nothing removes it from a draft.
    if (isReadWhereStored(line)) {
      accepted.push(line);
      continue;
    }
    const statement = statements.get(line.decided.propertyId);
    (statement && isCopied(line.decided) && lineInDraft(statement.lines, line.decided.lineId) ? accepted : removed).push(line);
  }

  // ── What a proposed line may duplicate (I2) ──
  const warnings = new Map<string, string[]>();
  for (const line of input.lines) {
    if (line.status !== 'proposed') continue;
    const said: string[] = [];
    // The same booking, the same day and type, accepted at another amount: a later file's changed row.
    for (const other of input.lines) {
      if (other.id === line.id || other.status !== 'accepted' || other.decided?.status !== 'accepted') continue;
      if (other.platform !== line.platform || other.confirmationCode !== line.confirmationCode || other.type !== line.type || other.payoutDate !== line.payoutDate) continue;
      said.push(`The same booking, paid the same day, was accepted at ${formatCents(other.decided.amountCents)}: this may replace that line rather than add to it.`);
    }
    // A typed line of the same amount and the same dates on the property's statement: the payment typed by hand.
    const link = linkOf(input.links, line.platform, line.listingTitle);
    const statement = link?.propertyId ? statements.get(link.propertyId) : undefined;
    const typedTwin = statement?.lines.find((typed) => typed.platformLineId === undefined && typed.amountCents === line.amountCents && (typed.from === null || typed.from === line.stay.start) && (typed.to === null || typed.to === line.stay.end));
    if (typedTwin) said.push(`A typed line on the statement, “${typedTwin.description}”, is the same amount: it may be this payment typed by hand.`);
    if (said.length > 0) warnings.set(line.id, said);
  }

  // ── By property: the month's statements with lines, figured by the month's money (dispatch 37A) ──
  const fromFileIds = new Set(accepted.map((line) => (isCopied(line.decided) ? line.decided.lineId : '')));
  const airbnbLineIds = airbnbLineIdsOf(input.lines);
  const byProperty = input.statements
    .filter((s) => s.lines.length > 0 || (s.sent?.length ?? 0) > 0)
    .map((s) => {
      // The statement the owner holds: as sent while a correction is written, else the draft's (T2).
      const held = incomeFigures(s.sent ?? s.lines, airbnbLineIds);
      const correction = s.sent ? incomeFigures(s.lines, airbnbLineIds) : null;
      return {
        propertyId: s.propertyId,
        name: names.get(s.propertyId) ?? null,
        lines: s.lines.length,
        fromFile: s.lines.filter((line) => line.platformLineId !== undefined || fromFileIds.has(line.id)).length,
        revenueCents: held.revenueCents,
        airbnbCents: held.airbnbCents,
        expensesCents: held.expensesCents,
        waitingCents: groups.get(s.propertyId)?.amountCents ?? 0,
        finished: s.finished || s.sent !== null && s.sent !== undefined,
        correction: correction ? { revenueCents: correction.revenueCents, expensesCents: correction.expensesCents } : null,
      };
    })
    .sort((a, b) => (a.name ?? '￿').localeCompare(b.name ?? '￿'));

  // ── Gaps ──
  const unlinked = titles.filter((row) => row.link === null);
  const withLines = new Set<string>([...input.statements.filter((s) => s.lines.length > 0).map((s) => s.propertyId), ...review.map((g) => g.propertyId)]);
  // A check-in on the month's last day is paid in the next month's file (I8): it is not this month's gap.
  const lastDay = input.month ? monthRange(input.month).to : null;
  const checkIns = input.calendar.checkIns
    .map((c) => ({ ...c, days: c.days.filter((day) => day !== lastDay) }))
    .filter((c) => c.days.length > 0 && names.has(c.propertyId) && !withLines.has(c.propertyId))
    .map((c) => ({ propertyId: c.propertyId, name: names.get(c.propertyId)!, days: c.days }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const uploadedPlatforms = new Set(input.uploads.map((u) => u.platform));
  const inFiles = new Set(input.uploads.flatMap((u) => u.titles.map((t) => `${u.platform}|${t.title}`)));
  // A property's active title only (dispatch 37C): its previous titles are expected to be missing. And only for months
  // after it became the active title (Kian's ruling of 2026-10-13): a month before, or the month it was set, was paid
  // under the title it had then.
  const missing = input.links
    .filter((link): link is TitleLinkView & { propertyId: string } => isActiveTitle(link) && uploadedPlatforms.has(link.platform) && !inFiles.has(`${link.platform}|${link.title}`))
    .filter((link) => {
      const activeFrom = activeMonthOf(link);
      return input.month === undefined || activeFrom === null || input.month > activeFrom;
    })
    .map((link) => ({ link, name: names.get(link.propertyId) ?? null, lastSeen: input.lastSeen[link.id] ?? null }));

  return { titles, review, rejected, removed, accepted, warnings, byProperty, gaps: { unlinked, checkIns, missing } };
}

// ─── A renamed title (dispatch 37C, Kian's ruling M14) ──────────

/** One piece of evidence that an unlinked title is a property's title renamed. */
export interface RenameEvidence {
  kind: 'code' | 'calendar' | 'name';
  text: string;
}

/** "'<title>' may be <property>, renamed from '<fromTitle>'": offered, never applied. */
export interface RenameSuggestion {
  platform: IncomeChannel;
  title: string;
  propertyId: string;
  /** The property's active title, the one the new title may replace; null when it has none. */
  fromTitle: string | null;
  evidence: RenameEvidence[];
}

export interface RenameInputs {
  /** The month's lines. */
  lines: Pick<EarningsLineView, 'platform' | 'listingTitle' | 'confirmationCode' | 'stay'>[];
  /** Lines of other months or titles that share a confirmation code with the month's unlinked lines. */
  earlier: Pick<EarningsLineView, 'platform' | 'listingTitle' | 'confirmationCode' | 'month'>[];
  links: TitleLinkView[];
  properties: { id: string; name: string }[];
  /** Each property's reserved stays on the stored calendar copies. */
  calendar: { propertyId: string; stays: { start: string; end: string }[] }[];
}

/**
 * The titles in the month's lines with no link that may be a linked title renamed (M14), from three kinds of
 * evidence: a confirmation code under the new title that was under one of a property's titles in an earlier file
 * (a long stay paid monthly repeats its code); stays under the new title that match bookings on the property's
 * calendar; the new title being the property's name. Offered only when the evidence agrees: every kind of evidence
 * found names the same one property. Nothing here links anything.
 */
export function renameSuggestions(input: RenameInputs): RenameSuggestion[] {
  const names = new Map(input.properties.map((p) => [p.id, p.name]));
  const linked = new Set(input.links.map((link) => `${link.platform}|${link.title}`));
  const unlinked = new Map<string, { platform: IncomeChannel; title: string }>();
  for (const line of input.lines) if (!linked.has(`${line.platform}|${line.listingTitle}`)) unlinked.set(`${line.platform}|${line.listingTitle}`, { platform: line.platform, title: line.listingTitle });

  const suggestions: RenameSuggestion[] = [];
  for (const { platform, title } of unlinked.values()) {
    const mine = input.lines.filter((line) => line.platform === platform && line.listingTitle === title);
    const byKind: Record<RenameEvidence['kind'], Map<string, string[]>> = { code: new Map(), calendar: new Map(), name: new Map() };
    const note = (kind: RenameEvidence['kind'], propertyId: string, text: string) => byKind[kind].set(propertyId, [...(byKind[kind].get(propertyId) ?? []), text]);

    // A code under a property's title in an earlier file.
    for (const code of new Set(mine.map((line) => line.confirmationCode))) {
      for (const other of input.earlier) {
        if (other.platform !== platform || other.confirmationCode !== code || other.listingTitle === title) continue;
        const link = linkOf(input.links, platform, other.listingTitle);
        if (!link?.propertyId) continue;
        note('code', link.propertyId, `Booking ${code} was under “${other.listingTitle}” in ${monthLabel(other.month)}'s file.`);
      }
    }
    // Stays that match bookings on a property's calendar.
    for (const cal of input.calendar) {
      const matched = mine.filter((line) => line.stay.start !== null && line.stay.end !== null && cal.stays.some((stay) => stay.start === line.stay.start && stay.end === line.stay.end)).length;
      if (matched > 0) note('calendar', cal.propertyId, `${matched === 1 ? '1 stay matches' : `${matched} stays match`} a booking on its calendar.`);
    }
    // The title is a property's name.
    const key = normaliseTitle(title).toLowerCase();
    for (const p of input.properties) if (normaliseTitle(p.name).toLowerCase() === key) note('name', p.id, 'The title is its name.');

    const kinds = (['code', 'name', 'calendar'] as const).filter((kind) => byKind[kind].size > 0);
    if (kinds.length === 0) continue;
    const named = new Set(kinds.flatMap((kind) => [...byKind[kind].keys()]));
    if (named.size !== 1) continue;
    const [propertyId] = named;
    if (!names.has(propertyId)) continue;
    const active = input.links.find((link) => link.platform === platform && link.propertyId === propertyId && isActiveTitle(link)) ?? null;
    const evidence = kinds.flatMap((kind) => [...new Set(byKind[kind].get(propertyId) ?? [])].map((text) => ({ kind, text })));
    suggestions.push({ platform, title, propertyId, fromTitle: active?.title ?? null, evidence });
  }
  return suggestions.sort((a, b) => a.title.localeCompare(b.title));
}

/** The property a title most likely is: the one property whose name is the title, when exactly one is. Offered, never applied. */
export function suggestedProperty(properties: { id: string; name: string }[], title: string): string | null {
  const key = normaliseTitle(title).toLowerCase();
  const same = properties.filter((p) => normaliseTitle(p.name).toLowerCase() === key);
  return same.length === 1 ? same[0].id : null;
}
