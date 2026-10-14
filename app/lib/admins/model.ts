/**
 * Admin accounts (dispatch 38): the shapes, the rules both sides read, and
 * the words. Client-safe: nothing here touches the server.
 *
 * Kian's rulings of 2026-10-13 (CLAUDE.md, "Admin accounts" and "Admin
 * sign-in"):
 *   - one main admin, Kian, adds and removes admins and sets their level;
 *     two levels to start, main admin and admin;
 *   - every admin action records which admin did it, from now on; records
 *     made before keep "admin";
 *   - admin PINs are 6 digits; sessions are signed with their own secret;
 *   - a main admin cannot be removed, demoted or given a new PIN by anyone but
 *     themselves; PIN boxes mask their digits;
 *   - (evening) admins sign in with their PIN only, and the PIN identifies the
 *     admin; every PIN is unique; names stay unique, and an admin can change
 *     their own; five wrong PINs from one connection lock sign-in from that
 *     connection for 15 minutes, a lock the main admin can lift; the shared
 *     PIN (ADMIN_PIN) stays only as the recovery script's PIN;
 *   - (night) the main admin sets each admin's PIN when adding them and can
 *     change any ordinary admin's; Nubnb no longer generates PINs; an admin
 *     can still change their own; main admins see every admin's PIN, their
 *     own included, on the Admins page; PINs are stored readably; admin PINs
 *     stay six digits; the Add an admin dialog opens on Admin.
 *
 * ── The PIN's states ──
 *   readable   the PIN as chosen, stored readably: `{ state, value }`; its
 *              `admin_pins/{PIN}` document finds the admin at sign-in
 *   shared     a main admin put back on the shared PIN, ADMIN_PIN, by the
 *              recovery script (or the first main admin of an empty database):
 *              signing in with it leads straight to setting their own PIN
 *   set        the evening's generated PINs, kept as a lookup key only
 *   own,       dispatch 38's first version, chosen PINs kept as salted hashes
 *   temporary
 *              None of the last three signs in any more: a session holding one
 *              is asked to set its PIN, checked against that one document;
 *              nothing writes them any more
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
/** The name index: `admin_names/{nameKey}` → `{ adminId }`. Keeps names unique. */
export const ADMIN_NAMES_COLLECTION = 'admin_names';
/** The PIN index: `admin_pins/{lookup}` → `{ adminId }`. Finds an admin by PIN, and keeps PINs unique. */
export const ADMIN_PINS_COLLECTION = 'admin_pins';
/** One document per connection that typed a wrong PIN: `admin_signin_locks/{keyed hash}` → the count and the lock. */
export const ADMIN_SIGNIN_LOCKS_COLLECTION = 'admin_signin_locks';
/** One document per admin write that succeeded: who, when, which route. Server-only. */
export const ADMIN_ACTIONS_COLLECTION = 'admin_actions';

/** 3: PINs set by the main admin or the admin, stored readably (2026-10-13, night). 2: generated, found by lookup (evening). 1: dispatch 38's first version. */
export const ADMIN_SCHEMA_VERSION = 3;
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
 * The main admin made by the shared PIN when no admin exists at all ("One
 * main admin, Kian"). Signing in that way, he sets his own PIN at once.
 */
export const FIRST_MAIN_ADMIN_NAME = 'Kian';

// ─── PINs ──────────────────────────────────────────────────────

/** Every PIN Nubnb generates: six digits. */
export const PIN_LENGTH = 6;
export const PIN_PATTERN = /^[0-9]{6}$/;

/** What sign-in takes: six digits, or four for the shared PIN, which is four digits today. */
export const SIGN_IN_PIN_PATTERN = /^(?:[0-9]{4}|[0-9]{6})$/;

export const PIN_STATES = ['readable', 'shared', 'set', 'own', 'temporary'] as const;
export type PinState = (typeof PIN_STATES)[number];

export function isPinState(value: unknown): value is PinState {
  return typeof value === 'string' && (PIN_STATES as readonly string[]).includes(value);
}

/** Whether a PIN is stored readably. Anything else is set again before its admin goes on (the gate's Set your PIN). */
export const isReadablePin = (state: string | null | undefined): boolean => state === 'readable';

/** Every run of six consecutive digits in `digits`: 012345 … 456789 for ascending. */
function runsIn(digits: string): string[] {
  return Array.from({ length: digits.length - PIN_LENGTH + 1 }, (_, start) => digits.slice(start, start + PIN_LENGTH));
}

/**
 * The PINs never accepted: the ten of one digit (000000 … 999999) and the ten
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

/** Why a PIN cannot be set, by its shape alone, or null. Whether another admin holds it is the server's to say. */
export function pinProblem(pin: string): string | null {
  if (!PIN_PATTERN.test(pin)) return 'Six digits.';
  if (isTooEasyPin(pin)) return 'Too easy to guess: choose another.';
  return null;
}

// ─── The connection lock ───────────────────────────────────────

/** Wrong PINs in a row from one connection before sign-in from it locks. */
export const MAX_WRONG_TRIES = 5;
export const LOCK_MINUTES = 15;
export const LOCK_MS = LOCK_MINUTES * 60_000;

/** What a connection's lock document holds. */
export interface LockState {
  /** Wrong PINs since the last right one or the last lock. */
  failedTries: number;
  /** ISO-8601 UTC: when the lock ends; null, or a past time, when none holds. */
  lockedUntil: string | null;
}

/** The end of the lock holding at `nowMs`, or null when none holds. */
export function lockHolding(state: LockState, nowMs: number): string | null {
  if (state.lockedUntil === null) return null;
  const until = Date.parse(state.lockedUntil);
  return Number.isFinite(until) && until > nowMs ? state.lockedUntil : null;
}

export type TryOutcome =
  | { kind: 'right'; next: LockState }
  /** Wrong, and `triesLeft` more wrong PINs are allowed before the lock. */
  | { kind: 'wrong'; next: LockState; triesLeft: number }
  /** Wrong, and this was the fifth: locked until `lockedUntil`. */
  | { kind: 'locked-now'; next: LockState; lockedUntil: string };

/**
 * What a try does to a connection's lock, when no lock holds at `nowMs` (a
 * try during a lock is refused before this, unchecked and uncounted). A right
 * PIN clears the count. A wrong one adds to it, and the fifth in a row locks
 * sign-in from that connection for fifteen minutes from that try and starts
 * the count again from nothing.
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

/**
 * The connection a request comes from, as the lock counts it: an IPv4
 * address whole, an IPv6 address cut to its /64 (one device can rotate
 * through a whole /64), an IPv4-mapped IPv6 address as IPv4. Null for
 * anything that is not an address. Never stored: only its keyed hash is
 * (pin.ts, connectionKey).
 */
export function normalizeAddress(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  let a = raw.trim().toLowerCase();
  if (a.startsWith('[')) {
    const end = a.indexOf(']');
    if (end === -1) return null;
    a = a.slice(1, end);
  }
  a = a.replace(/%.*$/, '');
  if (!a.includes(':')) return ipv4(a);
  // IPv6, perhaps ending in an IPv4 address (::ffff:203.0.113.7): that tail becomes its two groups.
  const lastColon = a.lastIndexOf(':');
  if (a.slice(lastColon + 1).includes('.')) {
    const tail = ipv4(a.slice(lastColon + 1));
    if (!tail) return null;
    const [w, x, y, z] = tail.split('.').map(Number);
    a = `${a.slice(0, lastColon + 1)}${((w << 8) | x).toString(16)}:${((y << 8) | z).toString(16)}`;
  }
  const groups = ipv6Groups(a);
  if (!groups) return null;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
  }
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(':')}::/64`;
}

function ipv4(s: string): string | null {
  const parts = s.split('.');
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255) ? parts.map(Number).join('.') : null;
}

/** The eight groups of an IPv6 address, `::` expanded, or null. */
function ipv6Groups(a: string): number[] | null {
  const halves = a.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if ((halves.length === 1 && head.length !== 8) || (halves.length === 2 && fill < 1)) return null;
  const parts = [...head, ...Array<string>(fill).fill('0'), ...tail];
  if (parts.length !== 8 || !parts.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return parts.map((g) => parseInt(g, 16));
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
export type AccountAction = 'remove' | 'demote' | 'promote' | 'set-pin';

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
 * PIN they change from their menu, as everyone does. Promoting stays open.
 * Only main admins reach this (the routes refuse everyone else).
 *
 * `targetIsMain`: the account acted on is a main admin's. `self`: it is the
 * acting main admin's own. `otherMainAdmins`: main admins besides the actor.
 */
export function accountVerdict(action: AccountAction, target: { self: boolean; targetIsMain: boolean }, otherMainAdmins: number): AccountVerdict {
  if (action === 'promote') return 'ok';
  if (action === 'set-pin') return target.self ? 'yourself' : target.targetIsMain ? 'main-admin' : 'ok';
  // remove, demote
  if (target.self) return otherMainAdmins > 0 ? 'ok' : 'last-main-admin';
  return target.targetIsMain ? 'main-admin' : 'ok';
}

// ─── Views ─────────────────────────────────────────────────────

/** The signed-in admin, as GET /api/admin-auth answers. Never the PIN or the epoch: only main admins see PINs, on the Admins page. */
export interface SignedInAdminView {
  id: string;
  name: string;
  level: AdminLevel;
  pin: PinState;
}

/**
 * An event in an admin document's `history`. `pin_set`: a main admin set the
 * PIN; `pin_changed`: the admin changed their own. `pin_reset` (the first
 * version's and the recovery script's), `pin_generated` (the evening's) and
 * `unlocked` (the first version's) are kept for their records.
 */
export type AdminHistoryAction = 'created' | 'level_set' | 'pin_set' | 'pin_changed' | 'pin_reset' | 'pin_generated' | 'name_changed' | 'unlocked';

export interface AdminHistoryEvent {
  at: string;
  action: AdminHistoryAction;
  actor: Actor;
  /** On `level_set` the level before and after; on `name_changed` the name before and after. */
  from?: string;
  to?: string;
}

export const ADMIN_HISTORY_WORDS: Record<AdminHistoryAction, string> = {
  created: 'Added',
  level_set: 'Level set',
  pin_set: 'PIN set',
  pin_changed: 'Changed their PIN',
  pin_reset: 'Given a new PIN',
  pin_generated: 'Got a new PIN',
  name_changed: 'Changed their name',
  unlocked: 'Unlocked',
};

/**
 * A row of the Admins page, which only main admins reach. Strings as stored;
 * the PIN itself when it is stored readably (Kian's ruling: main admins see
 * every admin's PIN), never a hash, a lookup key or the session epoch.
 */
export interface AdminSummary {
  id: string;
  name: string | null;
  level: string | null;
  /** The PIN's state. */
  pin: string | null;
  /** The PIN, when its state is `readable`. */
  pinValue: string | null;
  lastSignedInAt: string | null;
  createdAt: string | null;
  createdBy: ActorView | null;
  history: { at: string | null; action: string | null; actor: ActorView | null; from: string | null; to: string | null }[];
}

/** A connection whose sign-in is locked now, as the Admins page lists it: never the address, which is not kept. */
export interface SignInLockView {
  /** The keyed hash the lock is kept under. */
  id: string;
  lockedUntil: string;
  lastFailedAt: string | null;
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
  ['POST', new RegExp(`^/api/admin/admins/${ID}/pin$`), 'Set an admin’s PIN'],
  ['DELETE', new RegExp(`^/api/admin/admins/locks/${ID}$`), 'Lifted a sign-in lock'],
  ['POST', new RegExp(`^/api/admin-auth/pin$`), 'Changed their own PIN'],
  ['PUT', new RegExp(`^/api/admin-auth/name$`), 'Changed their own name'],
  // Dispatch 38's first version, for the lines it wrote:
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
