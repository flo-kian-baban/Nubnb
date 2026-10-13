/**
 * Admin accounts (dispatch 38): the shapes, the rules both sides read, and
 * the words. Client-safe: nothing here touches the server.
 *
 * Kian's rulings of 2026-10-13 (CLAUDE.md, "Admin accounts"):
 *   - one main admin, Kian, adds and removes admins and sets their level;
 *     two levels to start, main admin and admin;
 *   - each admin signs in with their own PIN, and every admin action records
 *     which admin did it, from now on; records made before keep "admin";
 *   - admin PINs are 6 digits, and five wrong tries lock that PIN for 15
 *     minutes (rate limiting, for admin sign-in only);
 *   - today's shared PIN becomes the main admin's until Kian changes it;
 *   - sessions are signed with their own secret, no longer the PIN.
 *
 * ── Who signs in ──
 * Sign-in is a name and a PIN. The lock is on one admin's PIN, so the server
 * must know whose PIN was tried; a PIN alone could not say. Names are matched
 * without regard to case or spacing (`nameKeyOf`), and are unique by that key.
 *
 * ── The PIN's three states ──
 *   own        the admin chose it: six digits, stored as a keyed hash
 *   temporary  the main admin set it, adding the admin or giving a new PIN;
 *              it opens only the step where the admin chooses their own
 *   shared     the main admin's PIN is today's shared PIN, ADMIN_PIN in the
 *              environment, until they change it; nothing about it is stored
 *
 * ── Who did it ──
 * An admin's action records `{ role: 'admin', id, name }` (adminActor). A
 * record made before dispatch 38 holds `{ role: 'admin', id: null, name:
 * null }` (ADMIN_ACTOR in cleaners/model.ts) and keeps it; pages show it as
 * "an admin".
 */

import type { Actor, ActorView } from '@/app/lib/cleaners/model';

// ─── Collections ───────────────────────────────────────────────

/** One document per admin, auto ID. Server-only (firestore.rules' catch-all deny). */
export const ADMINS_COLLECTION = 'admins';
/** The name index: `admin_names/{nameKey}` → `{ adminId }`. Keeps names unique and finds an admin at sign-in. */
export const ADMIN_NAMES_COLLECTION = 'admin_names';
/** One document per admin write that succeeded: who, when, which route. Server-only. */
export const ADMIN_ACTIONS_COLLECTION = 'admin_actions';

export const ADMIN_SCHEMA_VERSION = 1;
export const ADMIN_ACTION_SCHEMA_VERSION = 1;

// ─── Levels ────────────────────────────────────────────────────

export const ADMIN_LEVELS = ['main', 'admin'] as const;
export type AdminLevel = (typeof ADMIN_LEVELS)[number];

export const ADMIN_LEVEL_LABELS: Record<AdminLevel, string> = {
  main: 'Main admin',
  admin: 'Admin',
};

export function isAdminLevel(value: unknown): value is AdminLevel {
  return typeof value === 'string' && (ADMIN_LEVELS as readonly string[]).includes(value);
}

/**
 * The main admin made on the first sign-in attempt after deploy, when no admin
 * exists yet ("One main admin, Kian"), on the shared PIN.
 */
export const FIRST_MAIN_ADMIN_NAME = 'Kian';

// ─── PINs ──────────────────────────────────────────────────────

/** Every PIN set from dispatch 38 on: six digits. */
export const PIN_LENGTH = 6;
export const PIN_PATTERN = /^[0-9]{6}$/;

/**
 * What the sign-in takes: six digits, or four for the shared PIN of today,
 * which stays the main admin's until it is changed.
 */
export const SIGN_IN_PIN_PATTERN = /^(?:[0-9]{4}|[0-9]{6})$/;

export const PIN_STATES = ['own', 'temporary', 'shared'] as const;
export type PinState = (typeof PIN_STATES)[number];

export function isPinState(value: unknown): value is PinState {
  return typeof value === 'string' && (PIN_STATES as readonly string[]).includes(value);
}

/** Every run of six consecutive digits in `digits`: 012345 … 456789 for ascending. */
function runsIn(digits: string): string[] {
  return Array.from({ length: digits.length - PIN_LENGTH + 1 }, (_, start) => digits.slice(start, start + PIN_LENGTH));
}

/**
 * The PINs never set: the ten of one digit (000000 … 999999) and the ten
 * straight runs (012345 … 456789, 987654 … 543210) — the first anyone would
 * try, as with cleaner codes.
 */
const TOO_EASY_PINS: ReadonlySet<string> = new Set([
  ...'0123456789'.split('').map((digit) => digit.repeat(PIN_LENGTH)),
  ...runsIn('0123456789'),
  ...runsIn('9876543210'),
]);

export function isTooEasyPin(pin: string): boolean {
  return TOO_EASY_PINS.has(pin);
}

/** Why a new PIN cannot be set, in the words a form shows; null when it can. */
export function newPinProblem(pin: string): string | null {
  if (!PIN_PATTERN.test(pin)) return 'A PIN is six digits.';
  if (isTooEasyPin(pin)) return 'That PIN is too easy to guess: one digit six times, or a straight run like 123456.';
  return null;
}

// ─── The lock ──────────────────────────────────────────────────

/** Wrong tries in a row before the PIN locks. */
export const MAX_WRONG_TRIES = 5;
export const LOCK_MINUTES = 15;
export const LOCK_MS = LOCK_MINUTES * 60_000;

/** What an admin document holds about wrong tries. */
export interface LockState {
  /** Wrong tries since the last right one or the last lock. */
  failedTries: number;
  /** ISO-8601 UTC: when the lock ends; null, or a past time, when none holds. */
  lockedUntil: string | null;
}

/** The end of the lock holding at `nowMs`, or null when the PIN is not locked. */
export function lockHolding(state: LockState, nowMs: number): string | null {
  if (state.lockedUntil === null) return null;
  const until = Date.parse(state.lockedUntil);
  return Number.isFinite(until) && until > nowMs ? state.lockedUntil : null;
}

export type TryOutcome =
  | { kind: 'right'; next: LockState }
  /** Wrong, and `triesLeft` more wrong tries are allowed before the lock. */
  | { kind: 'wrong'; next: LockState; triesLeft: number }
  /** Wrong, and this was the fifth: locked until `lockedUntil`. */
  | { kind: 'locked-now'; next: LockState; lockedUntil: string };

/**
 * What a try does to the lock, when no lock holds at `nowMs` (a try during a
 * lock is refused before this, unchecked and uncounted). A right PIN clears
 * the count. A wrong one adds to it, and the fifth in a row locks the PIN for
 * fifteen minutes from that try and starts the count again from nothing.
 */
export function afterTry(state: LockState, right: boolean, nowMs: number): TryOutcome {
  if (right) return { kind: 'right', next: { failedTries: 0, lockedUntil: null } };
  const tries = Math.max(0, Math.floor(state.failedTries)) + 1;
  if (tries >= MAX_WRONG_TRIES) {
    const lockedUntil = new Date(nowMs + LOCK_MS).toISOString();
    return { kind: 'locked-now', next: { failedTries: 0, lockedUntil }, lockedUntil };
  }
  return { kind: 'wrong', next: { failedTries: tries, lockedUntil: null }, triesLeft: MAX_WRONG_TRIES - tries };
}

// ─── Names ─────────────────────────────────────────────────────

export const ADMIN_NAME_MAX = 60;

/** A name as stored: NFC, spaces collapsed, trimmed. */
export function cleanAdminName(name: string): string {
  return name.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** The key a name is matched and kept unique by: the clean name, lower case. Never empty for a valid name. */
export function nameKeyOf(name: string): string {
  return cleanAdminName(name).toLowerCase();
}

/** Why a name cannot be an admin's, or null. */
export function adminNameProblem(name: string): string | null {
  const clean = cleanAdminName(name);
  if (clean === '') return 'Name the admin.';
  if (clean.length > ADMIN_NAME_MAX) return `At most ${ADMIN_NAME_MAX} characters.`;
  if (/\p{Cc}/u.test(clean)) return 'No control characters.';
  // The key is a document ID: it cannot hold a slash, nor be "." or "..", nor start and end with two underscores.
  if (clean.includes('/') || clean === '.' || clean === '..') return 'No slashes.';
  if (/^__.*__$/.test(clean)) return 'Not a name that can be kept: it starts and ends with two underscores.';
  return null;
}

// ─── Who did it ────────────────────────────────────────────────

/** What an admin's action records from dispatch 38 on: who, by ID and by the name they had then. */
export function adminActor(admin: { id: string; name: string }): Actor {
  return { role: 'admin', id: admin.id, name: admin.name };
}

/** An actor in words, for an admin page: the admin's name, or "an admin" for a record made before dispatch 38. */
export function adminActorWords(actor: ActorView | Actor | null | undefined): string {
  if (!actor || actor.role !== 'admin') return 'an admin';
  return typeof actor.name === 'string' && actor.name.trim() !== '' ? actor.name : 'an admin';
}

// ─── Who may act on whom ───────────────────────────────────────

/** What a main admin does to an admin account on the Admins page. */
export type AccountAction = 'remove' | 'demote' | 'promote' | 'new-pin' | 'unlock';

/**
 * Whether it may be done:
 *   ok               yes
 *   main-admin       no: the account is another main admin's
 *   last-main-admin  no: the main admin would leave no main admin behind
 *   yourself         no: one's own PIN is changed from one's name in the header
 */
export type AccountVerdict = 'ok' | 'main-admin' | 'last-main-admin' | 'yourself';

/**
 * Kian's ruling of 2026-10-13: a main admin cannot be removed, demoted or
 * given a new PIN by anyone but themselves. So a main admin removes and
 * demotes admins, and themselves — while another main admin remains, so the
 * Admins page always has someone — but never another main admin. Their own
 * PIN they change with Change PIN, as everyone does. Promoting and unlocking
 * stay open. Only main admins reach this (the routes refuse everyone else).
 *
 * `targetIsMain`: the account acted on is a main admin's. `self`: it is the
 * acting main admin's own. `otherMainAdmins`: main admins besides the actor.
 */
export function accountVerdict(action: AccountAction, target: { self: boolean; targetIsMain: boolean }, otherMainAdmins: number): AccountVerdict {
  if (action === 'promote' || action === 'unlock') return 'ok';
  if (action === 'new-pin') return target.self ? 'yourself' : target.targetIsMain ? 'main-admin' : 'ok';
  // remove, demote
  if (target.self) return otherMainAdmins > 0 ? 'ok' : 'last-main-admin';
  return target.targetIsMain ? 'main-admin' : 'ok';
}

// ─── Views ─────────────────────────────────────────────────────

/** The signed-in admin, as GET /api/admin-auth answers. Never the PIN or the epoch. */
export interface SignedInAdminView {
  id: string;
  name: string;
  level: AdminLevel;
  pin: PinState;
}

/** An event in an admin document's `history`. */
export type AdminHistoryAction = 'created' | 'level_set' | 'pin_reset' | 'pin_changed' | 'unlocked';

export interface AdminHistoryEvent {
  at: string;
  action: AdminHistoryAction;
  actor: Actor;
  /** On `level_set`: the level before and after. */
  from?: string;
  to?: string;
}

export const ADMIN_HISTORY_WORDS: Record<AdminHistoryAction, string> = {
  created: 'Added',
  level_set: 'Level set',
  pin_reset: 'Given a new PIN',
  pin_changed: 'Changed their PIN',
  unlocked: 'Unlocked',
};

/** A row of the Admins page. Strings as stored; never the PIN's hash, salt or the session epoch. */
export interface AdminSummary {
  id: string;
  name: string | null;
  level: string | null;
  pin: string | null;
  /** When a lock holds now: its end. */
  lockedUntil: string | null;
  failedTries: number;
  lastSignedInAt: string | null;
  createdAt: string | null;
  createdBy: ActorView | null;
  history: { at: string | null; action: string | null; actor: ActorView | null; from: string | null; to: string | null }[];
}

/** One line of the activity log, as the Admins page reads it. */
export interface AdminActionView {
  id: string;
  at: string | null;
  admin: { id: string | null; name: string | null; level: string | null };
  method: string | null;
  path: string | null;
  status: number | null;
}

// ─── The activity log in words ─────────────────────────────────

const ID = '[A-Za-z0-9_-]+';

/** Every admin write, by method and path, in the words the Admins page shows. Unknown routes fall back to the method and path. */
const ACTION_WORDS: [method: string, path: RegExp, words: string][] = [
  ['POST', new RegExp(`^/api/admin/admins$`), 'Added an admin'],
  ['PATCH', new RegExp(`^/api/admin/admins/${ID}$`), 'Set an admin’s level'],
  ['DELETE', new RegExp(`^/api/admin/admins/${ID}$`), 'Removed an admin'],
  ['POST', new RegExp(`^/api/admin/admins/${ID}/pin$`), 'Gave an admin a new PIN'],
  ['POST', new RegExp(`^/api/admin/admins/${ID}/unlock$`), 'Unlocked an admin’s PIN'],
  ['PUT', new RegExp(`^/api/admin-auth/pin$`), 'Changed their own PIN'],
  ['POST', new RegExp(`^/api/admin/availability/refresh$`), 'Refreshed availability'],
  ['POST', new RegExp(`^/api/admin/cleaners$`), 'Added a team member'],
  ['PATCH', new RegExp(`^/api/admin/cleaners/${ID}$`), 'Changed a team member’s status'],
  ['DELETE', new RegExp(`^/api/admin/cleaners/${ID}$`), 'Deleted a team member'],
  ['POST', new RegExp(`^/api/admin/cleaners/${ID}/code$`), 'Changed a team member’s code'],
  ['PUT', new RegExp(`^/api/admin/cleaners/${ID}/rate$`), 'Set a cleaner’s default rate'],
  ['POST', new RegExp(`^/api/admin/cleanings$`), 'Logged a cleaning'],
  ['PATCH', new RegExp(`^/api/admin/cleanings/${ID}$`), 'Changed or removed a cleaning'],
  ['DELETE', new RegExp(`^/api/admin/cleanings/${ID}$`), 'Deleted a cleaning'],
  ['POST', new RegExp(`^/api/admin/cost-entries$`), 'Logged an office cost'],
  ['DELETE', new RegExp(`^/api/admin/cost-entries/${ID}$`), 'Deleted a cost entry'],
  ['POST', new RegExp(`^/api/admin/cost-entries/${ID}/lines$`), 'Corrected a cost entry’s lines'],
  ['POST', new RegExp(`^/api/admin/cost-entries/${ID}/seen$`), 'Marked a cost entry seen'],
  ['POST', new RegExp(`^/api/admin/cost-entries/${ID}/status$`), 'Approved, rejected or removed a cost entry'],
  ['POST', new RegExp(`^/api/admin/cost-entries/${ID}/tax$`), 'Corrected a cost entry’s tax'],
  ['POST', new RegExp(`^/api/admin/cost-reports$`), 'Exported a costs PDF'],
  ['PATCH', new RegExp(`^/api/admin/income/lines/${ID}$`), 'Edited an income line'],
  ['POST', new RegExp(`^/api/admin/income/lines/accept$`), 'Accepted income lines'],
  ['POST', new RegExp(`^/api/admin/income/lines/reject$`), 'Rejected income lines'],
  ['PUT', new RegExp(`^/api/admin/income/links$`), 'Linked an Airbnb title'],
  ['POST', new RegExp(`^/api/admin/income/uploads$`), 'Uploaded an Airbnb file'],
  ['GET', new RegExp(`^/api/admin/month-package$`), 'Downloaded a month’s files'],
  ['GET', new RegExp(`^/api/admin/monthly-reports/${ID}/pdf$`), 'Downloaded a statement'],
  ['DELETE', new RegExp(`^/api/admin/monthly-reports/${ID}$`), 'Deleted a statement'],
  ['PUT', new RegExp(`^/api/admin/monthly-reports/draft$`), 'Saved a statement draft'],
  ['POST', new RegExp(`^/api/admin/monthly-reports/empty$`), 'Finished empty months'],
  ['POST', new RegExp(`^/api/admin/monthly-reports$`), 'Finished or corrected a statement'],
  ['PUT', new RegExp(`^/api/admin/properties/${ID}/airbnb-title$`), 'Set a property’s Airbnb title'],
  ['PUT', new RegExp(`^/api/admin/properties/${ID}/cleaner-name$`), 'Set a property’s name for cleaners'],
  ['PUT', new RegExp(`^/api/admin/properties/${ID}/management$`), 'Changed a property’s reporting'],
  ['PUT', new RegExp(`^/api/admin/properties/${ID}/report-for$`), 'Set a property’s Report For'],
  ['PUT', new RegExp(`^/api/admin/properties/${ID}/visibility$`), 'Listed or unlisted a property'],
  ['PATCH', new RegExp(`^/api/leads/${ID}$`), 'Updated a lead'],
  ['POST', new RegExp(`^/api/mirror-property-images$`), 'Copied a property’s images'],
  ['POST', new RegExp(`^/api/properties$`), 'Added a property'],
  ['PUT', new RegExp(`^/api/properties/${ID}$`), 'Saved a property'],
  ['DELETE', new RegExp(`^/api/properties/${ID}$`), 'Deleted a property'],
  ['POST', new RegExp(`^/api/scrape-airbnb$`), 'Read an Airbnb listing'],
  ['POST', new RegExp(`^/api/upload-image$`), 'Uploaded an image'],
];

/** An activity line's action in words, or null when the route has none (then the page shows the method and path). */
export function describeAdminAction(method: string | null, path: string | null): string | null {
  if (!method || !path) return null;
  const found = ACTION_WORDS.find(([m, pattern]) => m === method && pattern.test(path));
  return found ? found[2] : null;
}
