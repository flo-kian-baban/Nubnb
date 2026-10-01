/**
 * Noticing a cleaner whose receipts cluster under the auto-approval line
 * (dispatch 24). A receipt under $200.00 is approved automatically, so the
 * record would let a cleaner send $190 receipt after $190 receipt and never
 * be looked at, unless something surfaced it. Three things do, all read
 * from the entries the costs page already holds and nothing else:
 *
 *   1. each cleaner's distribution over the last 90 Toronto days, in words,
 *      with the band just under the threshold ($150.00–$199.99) always
 *      named, whatever it holds;
 *   2. same-day splits: two or more receipts from one cleaner for one
 *      property on one Toronto day, each under the threshold, adding up to
 *      the threshold or more;
 *   3. a "Worth a look" rule that names a cleaner when, in 90 days, three or
 *      more of their receipts fall in the band and the band holds 40 % or
 *      more of their receipts, or when they have two or more same-day split
 *      sets. Under five receipts the distribution says "too few to judge"
 *      and the rule fires on splits only.
 *
 * Receipt entries only: a handyman's work never auto-approves. Rejected and
 * removed entries are included, because the pattern is in the sending, not
 * in what an admin later did. The amount is the entry as sent (lines plus
 * tax), which is what the rule saw. Nothing here blocks or writes anything:
 * it is a reading of the record, and the admin decides. The constants are
 * mine (the plan's §2.2), not rulings, and are not one-way doors.
 *
 * Client-safe, and pure: entries and a day in, words out.
 */

import { LIMITS, formatCents, type CostEntryView } from '@/app/lib/cleaners/model';
import { cleanerLabel, propertyLabel, sentDay, shortDay } from './report';

export const PATTERN = {
  /** The window, in Toronto calendar days, today included. */
  DAYS: 90,
  /** The band just under the threshold: from here up to, not including, the threshold. */
  BAND_FROM_CENTS: 15_000,
  THRESHOLD_CENTS: LIMITS.AUTO_APPROVE_UNDER_CENTS,
  /** The rule: at least this many receipts in the band ... */
  BAND_MIN_COUNT: 3,
  /** ... and the band holding at least this share of the cleaner's receipts (0.4 = 40 %). */
  BAND_MIN_SHARE: 0.4,
  /** Under this many receipts in the window the distribution is too few to judge. */
  MIN_RECEIPTS: 5,
  /** Or: at least this many same-day split sets. */
  SPLIT_MIN_SETS: 2,
} as const;

/** The five bands of the distribution, by their lower bound in cents; the last is open. */
export const BANDS: { key: BandKey; from: number; to: number | null; label: string }[] = [
  { key: 'under50', from: 0, to: 5_000, label: 'under $50' },
  { key: 'b50', from: 5_000, to: 10_000, label: '$50–100' },
  { key: 'b100', from: 10_000, to: 15_000, label: '$100–150' },
  { key: 'b150', from: PATTERN.BAND_FROM_CENTS, to: PATTERN.THRESHOLD_CENTS, label: '$150–200' },
  { key: 'over200', from: PATTERN.THRESHOLD_CENTS, to: null, label: '$200 and over' },
];
export type BandKey = 'under50' | 'b50' | 'b100' | 'b150' | 'over200';

/** One same-day split set: receipts that, together, reach the threshold each alone stayed under. */
export interface SplitSet {
  day: string;
  propertyId: string | null;
  propertyLabel: string;
  /** The receipts, oldest first, each with its total as sent. */
  entries: { id: string; sentTotalCents: number }[];
  sumCents: number;
}

export interface CleanerPattern {
  cleanerId: string;
  name: string;
  /** Receipt entries in the window, whatever their status. */
  receipts: number;
  /** Of those, how many could not be added up (in no band). */
  unreadable: number;
  bands: Record<BandKey, number>;
  /** How many of the receipts were approved automatically. */
  autoApproved: number;
  splits: SplitSet[];
  /** Fewer than PATTERN.MIN_RECEIPTS receipts: the distribution is too few to judge. */
  tooFew: boolean;
  /** The band's share of the readable receipts, 0–1; null when there are none. */
  bandShare: number | null;
  /** Whether the rule fires, and on what. */
  worthALook: boolean;
  reasons: string[];
}

/** The day PATTERN.DAYS days before `today`, today included: yyyy-mm-dd, plain calendar arithmetic. */
export function windowStart(today: string, days: number = PATTERN.DAYS): string {
  const [y, m, d] = today.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - (days - 1))).toISOString().slice(0, 10);
}

/** The band an amount falls in. */
export function bandOf(cents: number): BandKey {
  for (const band of BANDS) {
    if (cents >= band.from && (band.to === null || cents < band.to)) return band.key;
  }
  return 'under50'; // a negative total, which the routes refuse: shown with the smallest
}

const sentTotal = (entry: CostEntryView): number | null =>
  entry.linesNow.kind === 'ok' ? entry.linesNow.sentTotalCents : null;

/**
 * The receipt entries sent in the last PATTERN.DAYS days ending `today`,
 * by cleaner, each read as above. Cleaners come out most receipts first,
 * then by name. Entries with no cleaner ID are left out.
 */
export function watchList(entries: CostEntryView[], today: string): CleanerPattern[] {
  const from = windowStart(today);
  const byCleaner = new Map<string, CostEntryView[]>();
  for (const entry of entries) {
    if (entry.kind === 'work' || entry.cleaner.id === null) continue;
    const day = sentDay(entry.createdAt);
    if (day === null || day < from || day > today) continue;
    const list = byCleaner.get(entry.cleaner.id) ?? [];
    list.push(entry);
    byCleaner.set(entry.cleaner.id, list);
  }

  const patterns: CleanerPattern[] = [];
  for (const [cleanerId, list] of byCleaner) {
    const bands: Record<BandKey, number> = { under50: 0, b50: 0, b100: 0, b150: 0, over200: 0 };
    let unreadable = 0;
    let autoApproved = 0;
    for (const entry of list) {
      if (entry.autoApproved !== null) autoApproved += 1;
      const total = sentTotal(entry);
      if (total === null) unreadable += 1;
      else bands[bandOf(total)] += 1;
    }
    const readable = list.length - unreadable;
    const bandShare = readable === 0 ? null : bands.b150 / readable;
    const splits = sameDaySplits(list);
    const tooFew = list.length < PATTERN.MIN_RECEIPTS;

    const reasons: string[] = [];
    if (!tooFew && bands.b150 >= PATTERN.BAND_MIN_COUNT && bandShare !== null && bandShare >= PATTERN.BAND_MIN_SHARE) {
      reasons.push(
        `${bands.b150} of ${readable} receipts in the $150–200 band (${Math.round(bandShare * 100)} %)`,
      );
    }
    if (splits.length >= PATTERN.SPLIT_MIN_SETS) {
      reasons.push(`${splits.length} same-day splits that add up to $200 or more`);
    }

    patterns.push({
      cleanerId,
      name: cleanerLabel(list[0]),
      receipts: list.length,
      unreadable,
      bands,
      autoApproved,
      splits,
      tooFew,
      bandShare,
      worthALook: reasons.length > 0,
      reasons,
    });
  }
  return patterns.sort((a, b) => b.receipts - a.receipts || a.name.localeCompare(b.name, 'en-CA'));
}

/**
 * Same-day splits among one cleaner's receipts: for each property and
 * Toronto day, the receipts each under the threshold; a set when there are
 * two or more and they add up to the threshold or more. Oldest day first.
 */
export function sameDaySplits(list: CostEntryView[]): SplitSet[] {
  const groups = new Map<string, { day: string; propertyId: string | null; label: string; entries: { id: string; sentTotalCents: number; at: string }[] }>();
  for (const entry of list) {
    const day = sentDay(entry.createdAt);
    const total = sentTotal(entry);
    if (day === null || total === null || total >= PATTERN.THRESHOLD_CENTS) continue;
    const key = `${day}|${entry.property.id ?? ''}`;
    const group = groups.get(key) ?? { day, propertyId: entry.property.id, label: propertyLabel(entry), entries: [] };
    group.entries.push({ id: entry.id, sentTotalCents: total, at: entry.createdAt ?? '' });
    groups.set(key, group);
  }
  const sets: SplitSet[] = [];
  for (const group of groups.values()) {
    if (group.entries.length < 2) continue;
    const sumCents = group.entries.reduce((sum, e) => sum + e.sentTotalCents, 0);
    if (sumCents < PATTERN.THRESHOLD_CENTS) continue;
    const entries = [...group.entries].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)).map(({ id, sentTotalCents }) => ({ id, sentTotalCents }));
    sets.push({ day: group.day, propertyId: group.propertyId, propertyLabel: group.label, entries, sumCents });
  }
  return sets.sort((a, b) => a.day.localeCompare(b.day) || a.propertyLabel.localeCompare(b.propertyLabel, 'en-CA'));
}

/**
 * The distribution in words: "Last 90 days: 14 receipts · under $50: 2 ·
 * $50–100: 3 · $100–150: 1 · $150–200: 7 · $200 and over: 1 · approved
 * automatically: 13 of 14". The $150–200 band is always named. "Too few to
 * judge" is said when there are fewer than five.
 */
export function distributionText(pattern: CleanerPattern): string {
  const parts = [
    `Last ${PATTERN.DAYS} days: ${pattern.receipts === 1 ? '1 receipt' : `${pattern.receipts} receipts`}${pattern.tooFew ? ' (too few to judge)' : ''}`,
    ...BANDS.filter((band) => band.key === 'b150' || pattern.bands[band.key] > 0).map((band) => `${band.label}: ${pattern.bands[band.key]}`),
    ...(pattern.unreadable > 0 ? [`cannot be added up: ${pattern.unreadable}`] : []),
    `approved automatically: ${pattern.autoApproved} of ${pattern.receipts}`,
  ];
  return parts.join(' · ');
}

/** One split set in words: "30 Sep 2026, Loft Plateau: $184.20 + $96.10 = $280.30 in two receipts". */
export function splitText(split: SplitSet): string {
  const count = split.entries.length === 2 ? 'two' : split.entries.length === 3 ? 'three' : String(split.entries.length);
  return `${shortDay(split.day)}, ${split.propertyLabel}: ${split.entries.map((e) => formatCents(e.sentTotalCents)).join(' + ')} = ${formatCents(split.sumCents)} in ${count} receipts`;
}

/** The "Worth a look" sentence for one cleaner: the name, the figures, in one line. */
export function worthALookText(pattern: CleanerPattern): string {
  return `${pattern.name}: ${pattern.reasons.join('; ')}.`;
}
