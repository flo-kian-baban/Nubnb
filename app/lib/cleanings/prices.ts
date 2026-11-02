/**
 * Cleaning prices per property (Kian's ruling of 2026-10-19, in CLAUDE.md under *Cleaning prices*): "Cleaning prices
 * are presets per property, not per cleaner: a short-term price for an ordinary turnover and a long-term price after a
 * stay of 28 nights or more. They are the base for each house; the admin can change any cleaning's amount, because it
 * may vary by unit, day or booking."
 *
 * ── Three tiers (Kian's ruling A of 2026-11-01, the cleaning flow) ──
 * "Three tiers per property, chosen by the booking's nights: short 1–6, mid 7–27, long 28+. Each property holds a base
 * price per tier in the existing server-only price record. Mid starts equal to that property's short price. Admins
 * change base prices on the property, as now. A base change never alters existing cleanings. Two cleaners on a job
 * still give no amount." A record written before the mid tier (schema version 1) reads its mid price as its short one.
 *
 * ── The per-job amount (ruling B) ──
 * "An admin can set an amount on any job, before assignment or at any time before the cleaning's money is approved. It
 * beats the base price." A job's `amountCents` (schedule/model.ts) is what a mark on it takes, with one cleaner on it;
 * the cleaning records `amountFrom` "job". A job an admin added by hand (ruling C) carries a chosen tier instead of a
 * stay: that tier picks its base price.
 *
 * ── The record ──
 * `property_cleaning_prices/{propertyId}`, one per property that has prices: the short-, mid- and long-term presets in
 * integer cents, each a number or null, and a history of changes (who, when, before, after). Server-only: reached
 * through the Admin SDK by the admin routes (firestore.rules' catch-all denies every browser), never on the
 * world-readable property document (the property save refuses it, as it refuses the name cleaners see), never sent to
 * the cleaner app, owners' files or public pages. Set on the Report For sheet, on the property's edit page, and by the
 * sheet's CSV import.
 *
 * ── The amount rule (replacing 37B's "last paid for the property, else the cleaner's default rate") ──
 * - A cleaner's Mark cleaned on a job with exactly one cleaner: the long-term preset when the stay behind the job is 28
 *   nights or more, else the short-term preset; with no matching preset, no amount (the cleaning waits for an admin).
 * - A job with two or more cleaners: every cleaner's cleaning arrives with no amount; the admin types the split.
 * - A cleaning logged by hand prefills from the same rule: the stay's length when its property has a job that day,
 *   else the short-term preset. The admin can change it.
 * - Each cleaning records where its amount came from (short-term preset, long-term preset, typed).
 * - The cleaner's default rate is no longer used anywhere. Changing a preset never changes an existing cleaning.
 *
 * Pure and dependency-free: nothing here imports Next, Firebase or anything under `@/`. The server
 * (app/lib/firebase/server-cleaning-prices.ts, server-cleaning-jobs.ts, server-cleanings.ts), the pages and the tests
 * run these functions.
 */

export const PROPERTY_CLEANING_PRICES_COLLECTION = 'property_cleaning_prices';
/** Version 2 (2026-11-01): the mid-term preset. A version 1 record reads its mid price as its short one. */
export const CLEANING_PRICES_SCHEMA_VERSION = 2;

/** A stay of this many nights or more is a long-term stay (Kian's ruling: 28 nights or more). */
export const LONG_STAY_NIGHTS = 28;
/** A stay of this many nights or more, below LONG_STAY_NIGHTS, is a mid-term stay (Kian's ruling A of 2026-11-01: 7–27). */
export const MID_STAY_NIGHTS = 7;

/** A preset: $0.01 to $9,999.99, as a cleaning's amount. */
export const PRICE_MAX_CENTS = 999_999;

/** Names a cleaning price could be sent under on a property body: none is ever a property field. */
export const CLEANING_PRICE_FIELDS = ['cleaningPrices', 'cleaningPrice', 'shortTermCents', 'midTermCents', 'longTermCents', 'shortTermPrice', 'midTermPrice', 'longTermPrice', 'cleaningPriceShort', 'cleaningPriceMid', 'cleaningPriceLong'] as const;

/** The three presets, in cents; null where none is set. */
export interface CleaningPrices {
  shortTermCents: number | null;
  midTermCents: number | null;
  longTermCents: number | null;
}

export const NO_PRICES: CleaningPrices = { shortTermCents: null, midTermCents: null, longTermCents: null };

/** The tiers, in order (Kian's ruling A of 2026-11-01). */
export type PresetKind = 'short' | 'mid' | 'long';
export const PRESET_KINDS: readonly PresetKind[] = ['short', 'mid', 'long'];
/** Each tier's word: "short-term", "mid-term", "long-term". */
export const TIER_WORDS: Record<PresetKind, string> = { short: 'short-term', mid: 'mid-term', long: 'long-term' };
/** Each tier's nights, in words: "1–6 nights", "7–27 nights", "28+ nights". */
export const TIER_NIGHTS: Record<PresetKind, string> = { short: `1–${MID_STAY_NIGHTS - 1} nights`, mid: `${MID_STAY_NIGHTS}–${LONG_STAY_NIGHTS - 1} nights`, long: `${LONG_STAY_NIGHTS}+ nights` };

/** Who changed the prices: the admins' actor shape, written out so this file needs no app import. */
export interface PriceActor {
  role: 'admin' | 'cleaner' | 'handyman' | 'system';
  id: string | null;
  name: string | null;
}

/** One change of a property's prices, append-only. */
export interface PriceChange {
  /** ISO-8601 UTC. */
  at: string;
  actor: PriceActor;
  before: CleaningPrices;
  after: CleaningPrices;
}

/** `property_cleaning_prices/{propertyId}`, as written. */
export interface CleaningPricesRecord extends CleaningPrices {
  schemaVersion: number;
  propertyId: string;
  /** When the record was last set, and by whom. */
  setAt: string;
  setBy: PriceActor;
  history: PriceChange[];
}

// ─── Reading strictly ──────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';
const isTextOrNull = (value: unknown): value is string | null => value === null || typeof value === 'string';
const isActor = (value: unknown): value is PriceActor => isRecord(value) && ['admin', 'cleaner', 'handyman', 'system'].includes(value.role as string) && isTextOrNull(value.id) && isTextOrNull(value.name);
/** A preset as stored: null, or a whole number of cents above zero and at most PRICE_MAX_CENTS. */
export const isPriceCents = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= PRICE_MAX_CENTS;
const isPriceOrNull = (value: unknown): value is number | null => value === null || isPriceCents(value);
/** The presets as stored; a record or event from before the mid tier (no `midTermCents` key) reads its mid price as its short one (Kian's ruling A: mid starts equal to short). */
const readPrices = (value: unknown): CleaningPrices | null => {
  if (!isRecord(value) || !isPriceOrNull(value.shortTermCents) || !isPriceOrNull(value.longTermCents)) return null;
  const mid = value.midTermCents === undefined ? value.shortTermCents : value.midTermCents;
  if (!isPriceOrNull(mid)) return null;
  return { shortTermCents: value.shortTermCents, midTermCents: mid, longTermCents: value.longTermCents };
};

/** A stored record, read strictly: null when any field is not in the written shape, or it names another property. */
export function readCleaningPrices(id: string, fields: Record<string, unknown>): CleaningPricesRecord | null {
  const { schemaVersion, propertyId, setAt, setBy, history } = fields;
  const prices = readPrices(fields);
  if (typeof schemaVersion !== 'number' || !isText(propertyId) || propertyId !== id || !prices || !isText(setAt) || !isActor(setBy) || !Array.isArray(history)) return null;
  const changes: PriceChange[] = [];
  for (const event of history) {
    if (!isRecord(event) || !isText(event.at) || !isActor(event.actor)) return null;
    const before = readPrices(event.before);
    const after = readPrices(event.after);
    if (!before || !after) return null;
    changes.push({ at: event.at, actor: event.actor, before, after });
  }
  return { schemaVersion, propertyId, ...prices, setAt, setBy, history: changes };
}

/** Two prices that are the same. */
export function samePrices(a: CleaningPrices, b: CleaningPrices): boolean {
  return a.shortTermCents === b.shortTermCents && a.midTermCents === b.midTermCents && a.longTermCents === b.longTermCents;
}

// ─── The amount rule ───────────────────────────────────────────

/** The nights of a stay from its first night to its checkout day (yyyy-mm-dd both); 0 when either is not a day or the checkout is not after the start. */
export function stayNights(start: string, checkout: string): number {
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  if (!DAY.test(start) || !DAY.test(checkout)) return 0;
  const nights = Math.round((Date.parse(`${checkout}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
  return Number.isFinite(nights) && nights > 0 ? nights : 0;
}

/** Which tier a stay of `nights` nights takes (Kian's ruling A of 2026-11-01): long-term from 28, mid-term from 7, short-term below. */
export function presetKind(nights: number): PresetKind {
  return nights >= LONG_STAY_NIGHTS ? 'long' : nights >= MID_STAY_NIGHTS ? 'mid' : 'short';
}

/** The preset a tier takes: null when the property has none for it. */
export function presetCents(prices: CleaningPrices | null, tier: PresetKind): number | null {
  if (prices === null) return null;
  return tier === 'long' ? prices.longTermCents : tier === 'mid' ? prices.midTermCents : prices.shortTermCents;
}

/** The preset a stay takes, and its amount: null when the property has no such preset. */
export function presetAmount(prices: CleaningPrices | null, nights: number): { from: PresetKind; cents: number | null } {
  const from = presetKind(nights);
  return { from, cents: presetCents(prices, from) };
}

/**
 * What the rule needs of a job: who is on it, the stay behind it (null on a job an admin added by hand, ruling C),
 * the tier an admin chose for it (null on a job the calendar made), and the amount set on it (ruling B; null for none).
 */
export interface JobForAmount {
  cleanerIds: readonly string[];
  reservation: { start: string } | null;
  checkout: string;
  tier?: PresetKind | null;
  amountCents?: number | null;
}

/** The nights of the stay behind a job: 0 on a job added by hand. */
export function jobNights(job: Pick<JobForAmount, 'reservation' | 'checkout'>): number {
  return job.reservation ? stayNights(job.reservation.start, job.checkout) : 0;
}

/** A job's tier: the one an admin chose for it, else the tier its stay's nights take. */
export function jobTier(job: Pick<JobForAmount, 'reservation' | 'checkout' | 'tier'>): PresetKind {
  return job.tier ?? presetKind(jobNights(job));
}

/** Where a cleaning's amount came from: a preset, the amount set on its job (ruling B), or typed by an admin. */
export type AmountSource = PresetKind | 'typed' | 'job';

/** The words of each source (Kian's ruling: "short-term preset", "long-term preset", "typed"; ruling B: "set on the job"). */
export const AMOUNT_SOURCE_WORDS: Record<AmountSource, string> = { short: 'short-term preset', mid: 'mid-term preset', long: 'long-term preset', typed: 'typed', job: 'set on the job' };

/** What a Mark cleaned's amount started from: a preset, the job's own amount, or a split between several cleaners (no amount; the admin types each share). */
export type MarkSuggestedFrom = PresetKind | 'split' | 'job';

/**
 * The amount a cleaner's Mark cleaned gives the cleaning (Kian's ruling of 2026-10-19, with rulings A and B of
 * 2026-11-01). Exactly one cleaner on the job: the amount set on the job when it has one, else the preset its tier
 * takes — long-term from 28 nights, mid-term from 7, short-term below, or the tier an admin chose for a job added by
 * hand — and no amount when the property has no such preset. Two or more cleaners: no amount, whatever is set; the
 * admin types the split. Never typed by the cleaner, and never shown to them. An admin's Record as cleaned (ruling E)
 * takes exactly this.
 */
export function markAmount(prices: CleaningPrices | null, job: JobForAmount): { from: MarkSuggestedFrom; cents: number | null; amountFrom: AmountSource | null; nights: number; tier: PresetKind } {
  const nights = jobNights(job);
  const tier = jobTier(job);
  if (job.cleanerIds.length >= 2) return { from: 'split', cents: null, amountFrom: null, nights, tier };
  if (typeof job.amountCents === 'number') return { from: 'job', cents: job.amountCents, amountFrom: 'job', nights, tier };
  const cents = presetCents(prices, tier);
  return { from: tier, cents, amountFrom: cents === null ? null : tier, nights, tier };
}

/**
 * What a cleaning logged by hand starts from (Kian's ruling): the amount set on the property's job that day when it
 * has one (ruling B), else the preset that job's tier takes, else the short-term preset. The admin can change it.
 */
export function handLogSuggestion(prices: CleaningPrices | null, job: Pick<JobForAmount, 'reservation' | 'checkout' | 'tier' | 'amountCents'> | null): { from: PresetKind | 'job'; cents: number | null; nights: number; tier: PresetKind } {
  const nights = job ? jobNights(job) : 0;
  const tier = job ? jobTier(job) : 'short';
  if (job && typeof job.amountCents === 'number') return { from: 'job', cents: job.amountCents, nights, tier };
  return { from: tier, cents: presetCents(prices, tier), nights, tier };
}

/** Where a hand-logged amount came from: what it started from when the admin left it (a preset, or the job's amount), else typed. */
export function amountSourceOf(suggestion: { from: PresetKind | 'job'; cents: number | null }, amountCents: number): AmountSource {
  return suggestion.cents === amountCents ? suggestion.from : 'typed';
}

/**
 * The words for where a cleaning's amount came from. Cleanings written before this rule (no `amountFrom`) say what
 * 37B's rule started them from: last paid, the cleaner's default rate, or typed when the amount differs from it.
 */
export function amountSourceWords(cleaning: { amountCents: number | null; amountFrom?: AmountSource | null; suggested: { from: string; cents: number | null } }): string {
  if (cleaning.amountCents === null) return cleaning.suggested.from === 'split' ? 'no amount yet: several cleaners on the job' : 'no amount yet';
  if (cleaning.amountFrom) return AMOUNT_SOURCE_WORDS[cleaning.amountFrom];
  if (cleaning.suggested.cents === cleaning.amountCents) {
    if (cleaning.suggested.from === 'last') return 'last paid for the property (before presets)';
    if (cleaning.suggested.from === 'default') return 'the cleaner’s default rate (before presets)';
  }
  return 'typed';
}

/** What the hints need of a cleaning's job: its stay's nights, how many cleaners were on it, its tier, and the amount set on it. */
export interface JobFacts {
  nights: number;
  cleaners: number;
  /** The job's tier (jobTier). Absent on facts read before the tiers: the nights decide. */
  tier?: PresetKind;
  /** The amount set on the job (ruling B); null or absent for none. */
  amountCents?: number | null;
}

const tierOfFacts = (job: JobFacts): PresetKind => job.tier ?? presetKind(job.nights);

/** The hint under an amount field while a cleaning waits for one: the amount its job or its presets could start from. */
export function waitingHint(prices: CleaningPrices | null, job: JobFacts | null): string {
  const words = (cents: number | null) => (cents === null ? 'none' : `$${(cents / 100).toFixed(2)}`);
  if (!job) return prices && (prices.shortTermCents !== null || prices.midTermCents !== null || prices.longTermCents !== null) ? `Presets: short ${words(prices.shortTermCents)}, mid ${words(prices.midTermCents)}, long ${words(prices.longTermCents)}` : 'No preset for this property';
  const tier = tierOfFacts(job);
  const base = typeof job.amountCents === 'number' ? `set on the job ${words(job.amountCents)}` : `${TIER_WORDS[tier]} preset ${words(presetCents(prices, tier))}`;
  const stay = `${job.nights === 0 ? `${TIER_WORDS[tier]} job` : job.nights === 1 ? '1 night' : `${job.nights} nights`}: ${base}`;
  return job.cleaners >= 2 ? `${job.cleaners} cleaners on this job · ${stay} in all` : stay;
}

// ─── Typed prices ──────────────────────────────────────────────

/** A preset as an input field holds it, "75.00"; '' for none. */
export function priceField(cents: number | null): string {
  return cents === null ? '' : (cents / 100).toFixed(2);
}

/** A typed price: '' (or "none") is no preset; "75", "$75", "75.5", "75.50", "1,234.00" are cents; anything else is not a price. */
export function readPriceText(text: string): { kind: 'none' } | { kind: 'cents'; cents: number } | { kind: 'bad' } {
  const clean = text.replace(/\s+/g, '').replace(/^\$/, '').replace(/,/g, '');
  if (clean === '' || /^none$/i.test(clean) || clean === '-' || clean === '—') return { kind: 'none' };
  const match = /^(\d{1,4})(?:\.(\d{1,2}))?$/.exec(clean);
  if (!match) return { kind: 'bad' };
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '0').padEnd(2, '0'));
  return isPriceCents(cents) ? { kind: 'cents', cents } : { kind: 'bad' };
}

/** "75.00" as the routes take it, or null for none; undefined when the text is not a price. */
export function priceTextForRoute(text: string): string | null | undefined {
  const read = readPriceText(text);
  return read.kind === 'none' ? null : read.kind === 'cents' ? priceField(read.cents) : undefined;
}

// ─── The CSV import ────────────────────────────────────────────

/** One row of the import file, as typed. `mid` is null when the file has no mid column: the mid price is then the short one (ruling A). */
export interface CsvPriceRow {
  /** Its line in the file, 1-based, the header being line 1. */
  line: number;
  address: string;
  short: string;
  mid: string | null;
  long: string;
  /** The default fee rate, "20" or "12.5" (Kian's ruling of 2026-11-01: the sheet's import carries one per property); null when the file has no rate column. */
  rate: string | null;
}

/** The file's columns, by the names they may carry (case and spaces set aside). */
const COLUMN_NAMES: Record<'address' | 'short' | 'mid' | 'long' | 'rate', string[]> = {
  address: ['address', 'property', 'suite', 'suite/property', 'suiteproperty', 'name', 'unit'],
  short: ['short', 'shortterm', 'shorttermprice', 'shorttermprice$'],
  mid: ['mid', 'midterm', 'midtermprice', 'mid(7-27nights)', 'mid7-27'],
  long: ['long', 'longterm', 'longtermprice', 'long(28+nights)', 'longtermprice(28+days)', 'long28+'],
  rate: ['rate', 'feerate', 'fee', 'defaultfeerate', 'defaultrate', 'managementfee', 'fee%', 'rate%', 'nubnbfee'],
};

/** A rate as the management route takes it: "20" or "12.5", at most two decimals, 0–100. */
const RATE = /^(100(\.0{1,2})?|[0-9]{1,2}(\.[0-9]{1,2})?)$/;

/** A rate cell (Kian's ruling of 2026-11-01): nothing, a rate in basis points, or bad. "20%" reads as 20. */
export function readRateText(text: string): { kind: 'none' } | { kind: 'rate'; basisPoints: number } | { kind: 'bad' } {
  const clean = text.trim().replace(/%$/, '').trim();
  if (clean === '') return { kind: 'none' };
  if (!RATE.test(clean)) return { kind: 'bad' };
  const [whole, decimals = ''] = clean.split('.');
  return { kind: 'rate', basisPoints: Number(whole) * 100 + Number(decimals.padEnd(2, '0')) };
}

/** The fields of one CSV line (RFC 4180 quoting: a quoted field may hold commas, newlines are not expected within a row here). */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(field);
      field = '';
    } else field += ch;
  }
  out.push(field);
  return out.map((f) => f.trim());
}

/**
 * The import file read: a header naming address, short and long (in any order; mid and rate optional, other columns
 * ignored), then one row per property. Blank lines are skipped. Not a file in that shape: one line saying why.
 */
export function parsePricesCsv(text: string): { kind: 'ok'; rows: CsvPriceRow[] } | { kind: 'bad'; problem: string } {
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  const headerAt = lines.findIndex((l) => l.trim() !== '');
  if (headerAt === -1) return { kind: 'bad', problem: 'The file is empty.' };
  const header = splitCsvLine(lines[headerAt]).map((h) => h.toLowerCase().replace(/[\s_-]+/g, ''));
  const at = (key: keyof typeof COLUMN_NAMES) => header.findIndex((h) => COLUMN_NAMES[key].includes(h));
  const columns = { address: at('address'), short: at('short'), mid: at('mid'), long: at('long'), rate: at('rate') };
  const missing = (['address', 'short', 'long'] as const).filter((k) => columns[k] === -1);
  if (missing.length > 0) return { kind: 'bad', problem: `The first line must name the columns address, short and long (mid is optional); missing: ${missing.join(', ')}.` };
  const rows: CsvPriceRow[] = [];
  for (let i = headerAt + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '') continue;
    const fields = splitCsvLine(lines[i]);
    const address = (fields[columns.address] ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
    if (address === '') continue;
    rows.push({ line: i + 1, address, short: fields[columns.short] ?? '', mid: columns.mid === -1 ? null : (fields[columns.mid] ?? ''), long: fields[columns.long] ?? '', rate: columns.rate === -1 ? null : (fields[columns.rate] ?? '') });
  }
  if (rows.length === 0) return { kind: 'bad', problem: 'The file has a header and no rows.' };
  return { kind: 'ok', rows };
}

/** An address as rows are matched by (Kian's ruling: exact, case and spaces ignored). */
export function addressKey(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/\s+/g, '');
}

/** A property the import may match: its ID and the name the admin lists it by (its cleaner-facing name, usually the address). */
export interface MatchableProperty {
  id: string;
  name: string;
}

/** One matched row, ready to save: the property, what it holds now and what the file gives it. */
export interface MatchedPriceRow {
  row: CsvPriceRow;
  propertyId: string;
  name: string;
  before: CleaningPrices;
  after: CleaningPrices;
  /** False when the file gives what is stored already: shown, not written. */
  changes: boolean;
  /**
   * The default fee rate (Kian's ruling of 2026-11-01), in basis points, when the file has a rate column and the cell
   * holds one: what the record holds now and what the file gives; `changes` false when they are the same. null when
   * the file has no rate column or the cell is empty (the stored rate is left as it is).
   */
  rate: { before: number | null; after: number; changes: boolean } | null;
}

/** A row that cannot be saved, and why. */
export interface UnmatchedPriceRow {
  row: CsvPriceRow;
  why: 'no property with this address' | 'two or more properties share this address' | 'another row names the same property' | 'a price is not readable' | 'the rate is not a percent';
}

/**
 * The file's rows matched to properties by exact address, case and spaces ignored (Kian's ruling), with what each
 * property holds now. A row with no property, an address two properties share, a property named twice, or a price
 * that is not readable is listed and never saved.
 */
export function matchPriceRows(rows: readonly CsvPriceRow[], properties: readonly MatchableProperty[], current: ReadonlyMap<string, CleaningPrices>, rates: ReadonlyMap<string, number | null> = new Map()): { matched: MatchedPriceRow[]; unmatched: UnmatchedPriceRow[] } {
  const byKey = new Map<string, MatchableProperty[]>();
  for (const property of properties) {
    const key = addressKey(property.name);
    if (key === '') continue;
    byKey.set(key, [...(byKey.get(key) ?? []), property]);
  }
  const matched: MatchedPriceRow[] = [];
  const unmatched: UnmatchedPriceRow[] = [];
  const taken = new Set<string>();
  for (const row of rows) {
    const found = byKey.get(addressKey(row.address)) ?? [];
    if (found.length === 0) {
      unmatched.push({ row, why: 'no property with this address' });
      continue;
    }
    if (found.length > 1) {
      unmatched.push({ row, why: 'two or more properties share this address' });
      continue;
    }
    const [property] = found;
    if (taken.has(property.id)) {
      unmatched.push({ row, why: 'another row names the same property' });
      continue;
    }
    const short = readPriceText(row.short);
    // No mid column, or an empty mid cell: the mid price starts equal to the short one (Kian's ruling A of 2026-11-01).
    const midText = readPriceText(row.mid ?? '');
    const mid = midText.kind === 'none' ? short : midText;
    const long = readPriceText(row.long);
    if (short.kind === 'bad' || mid.kind === 'bad' || long.kind === 'bad') {
      unmatched.push({ row, why: 'a price is not readable' });
      continue;
    }
    // The default fee rate (Kian's ruling of 2026-11-01): an empty cell, or no column, leaves the stored rate as it is.
    const rateText = row.rate === null ? { kind: 'none' as const } : readRateText(row.rate);
    if (rateText.kind === 'bad') {
      unmatched.push({ row, why: 'the rate is not a percent' });
      continue;
    }
    taken.add(property.id);
    const before = current.get(property.id) ?? NO_PRICES;
    const after: CleaningPrices = { shortTermCents: short.kind === 'cents' ? short.cents : null, midTermCents: mid.kind === 'cents' ? mid.cents : null, longTermCents: long.kind === 'cents' ? long.cents : null };
    const rateBefore = rates.get(property.id) ?? null;
    const rate = rateText.kind === 'rate' ? { before: rateBefore, after: rateText.basisPoints, changes: rateBefore !== rateText.basisPoints } : null;
    matched.push({ row, propertyId: property.id, name: property.name, before, after, changes: !samePrices(before, after), rate });
  }
  return { matched, unmatched };
}

// ─── A second cleaner after a mark (Kian's instruction of 2026-10-19, the second round) ───

/** What the Schedule knows of a cleaner on a job, as far as this rule needs. */
export interface AssigneeFacts {
  cleanerId: string;
  name: string | null;
  nameAtAssignment: string | null;
  /** The cleaning their mark made, as it stands; null when not marked, or removed by the office. */
  cleaning: { status: string | null; amountCents: number | null; amountFrom?: AmountSource | null } | null;
}

/** A question in the shape Nubnb's dialog asks (AskDialog's Question), written out so this file needs no app import. */
export interface PriceQuestion {
  title: string;
  lines: string[];
  confirm: string;
}

/**
 * Adding a cleaner to a job where another cleaner's mark already made a cleaning with an amount asks first (Kian's
 * instruction of 2026-10-19): "<name>'s cleaning already carries $X (<short-term|long-term> preset). With two cleaners,
 * the amounts need splitting: edit them on the Cleanings tab." Confirming assigns as before; no amount changes by
 * itself. Null when nothing is added, when the job would still have one cleaner, or when no cleaning on it carries an
 * amount (a waiting one, or one removed by the office, carries none).
 */
export function secondCleanerQuestion(job: { cleanerIds: readonly string[]; assignees: readonly AssigneeFacts[] }, nextCleanerIds: readonly string[]): PriceQuestion | null {
  const added = nextCleanerIds.filter((id) => !job.cleanerIds.includes(id));
  if (added.length === 0 || nextCleanerIds.length < 2) return null;
  const carrying = job.assignees.filter((a) => nextCleanerIds.includes(a.cleanerId) && a.cleaning !== null && a.cleaning.status === 'logged' && a.cleaning.amountCents !== null);
  if (carrying.length === 0) return null;
  const words = (a: AssigneeFacts) => {
    const from = a.cleaning?.amountFrom;
    return from ? AMOUNT_SOURCE_WORDS[from] : 'amount as recorded';
  };
  const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const line = (a: AssigneeFacts) => `${a.name ?? a.nameAtAssignment ?? 'A cleaner'}’s cleaning already carries ${money(a.cleaning!.amountCents!)} (${words(a)}).`;
  const count = nextCleanerIds.length === 2 ? 'two' : nextCleanerIds.length === 3 ? 'three' : `${nextCleanerIds.length}`;
  return {
    title: line(carrying[0]),
    lines: [...carrying.slice(1).map(line), `With ${count} cleaners, the amounts need splitting: edit them on the Cleanings tab.`],
    confirm: 'Assign anyway',
  };
}

// ─── The admin-typed recommendation (Kian's ruling of 2026-10-19, the second round) ───
// "For unsure rows, we just keep it open as input by admin, and we keep that input item as a recommendation for next
// time (based on if it's short term or long term)."

/** A cleaning as the recommendation reads it. */
export interface CleaningFacts {
  id: string;
  propertyId: string;
  day: string;
  createdAt: string;
  status: string;
  amountCents: number | null;
  amountFrom?: AmountSource | null;
  suggested: { from: string; cents: number | null };
  jobId: string | null;
}

/** The tier a cleaning belongs to: its job's when its job is known, else by what its form started from; null when neither says. */
export function cleaningTier(cleaning: Pick<CleaningFacts, 'jobId' | 'suggested'>, jobs: Readonly<Record<string, JobFacts>>): PresetKind | null {
  const job = cleaning.jobId !== null ? jobs[cleaning.jobId] : undefined;
  if (job) return tierOfFacts(job);
  return (PRESET_KINDS as readonly string[]).includes(cleaning.suggested.from) ? (cleaning.suggested.from as PresetKind) : null;
}

/**
 * The most recent amount an admin typed for a cleaning at this property in this tier (Kian's ruling): counting only
 * cleanings not removed, whose amount is "typed", and that were logged by hand or come from a job with exactly one
 * cleaner — never a share from a two-cleaner job, and never a job's cleaning whose job is not known here. Null when
 * none.
 */
export function recommendedAmount(cleanings: readonly CleaningFacts[], jobs: Readonly<Record<string, JobFacts>>, propertyId: string, tier: PresetKind): { cents: number; day: string; cleaningId: string } | null {
  const typed = cleanings
    .filter((c) => c.propertyId === propertyId && c.status === 'logged' && c.amountFrom === 'typed' && c.amountCents !== null)
    .filter((c) => (c.jobId === null ? true : jobs[c.jobId] !== undefined && jobs[c.jobId].cleaners === 1))
    .filter((c) => cleaningTier(c, jobs) === tier)
    .sort((a, b) => b.day.localeCompare(a.day) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  const latest = typed[0];
  return latest ? { cents: latest.amountCents as number, day: latest.day, cleaningId: latest.id } : null;
}

/** The words over a prefilled recommendation: "Last typed for short-term: $73.00". */
export function recommendationWords(tier: PresetKind, cents: number): string {
  return `Last typed for ${TIER_WORDS[tier]}: $${(cents / 100).toFixed(2)}`;
}

/**
 * What a field for a missing amount opens with (Kian's ruling): the property's preset for the tier, when it has one
 * (shown as the hint, as before: a preset replaces the recommendation completely); else the admin-typed recommendation,
 * prefilled and labelled, confirmed by Enter or Save; else nothing. A share of a job with several cleaners is never
 * prefilled: its hint says the preset for them all. The tier is the job's stay, else short-term.
 */
export function missingAmountStart(prices: CleaningPrices | null, cleanings: readonly CleaningFacts[], jobs: Readonly<Record<string, JobFacts>>, cleaning: CleaningFacts): { kind: 'preset'; tier: PresetKind; cents: number } | { kind: 'job'; tier: PresetKind; cents: number } | { kind: 'split'; tier: PresetKind; cleaners: number } | { kind: 'recommendation'; tier: PresetKind; cents: number; day: string } | { kind: 'none'; tier: PresetKind } {
  const job = cleaning.jobId !== null ? jobs[cleaning.jobId] : undefined;
  const tier: PresetKind = job ? tierOfFacts(job) : 'short';
  if (job && job.cleaners >= 2) return { kind: 'split', tier, cleaners: job.cleaners };
  // The amount set on the job beats the base price (ruling B).
  if (job && typeof job.amountCents === 'number') return { kind: 'job', tier, cents: job.amountCents };
  const preset = presetCents(prices, tier);
  if (preset !== null) return { kind: 'preset', tier, cents: preset };
  const recommended = recommendedAmount(cleanings, jobs, cleaning.propertyId, tier);
  return recommended ? { kind: 'recommendation', tier, cents: recommended.cents, day: recommended.day } : { kind: 'none', tier };
}
