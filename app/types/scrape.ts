/**
 * Shared contract between POST /api/scrape-airbnb and the admin form.
 *
 * The scraper reports provenance for every field it returns so the operator can
 * tell a real extracted value apart from a hard-coded fallback. Nothing here is
 * persisted — these keys exist only on the scrape response.
 */

/**
 * - `extracted` — a real value was read off the listing page.
 * - `defaulted` — extraction produced nothing and a hard-coded default was
 *   substituted. The value in the payload is NOT listing data.
 * - `failed`    — extraction produced nothing and there is no default: the
 *   payload carries an empty string / 0 / [] / false placeholder.
 * - `admin-entered` — the scraper deliberately does not read this field; the
 *   operator supplies it. This is not a failure and must not be reported as
 *   one. `price` is the only such field: Airbnb shows no nightly rate on an
 *   undated listing page, and listing URLs are normalised to carry no dates,
 *   so "failed" would be on every import forever.
 */
export type FieldStatus = 'extracted' | 'defaulted' | 'failed' | 'admin-entered';

export interface FieldReport {
  status: FieldStatus;
  /** Operator-facing explanation. Always present for `defaulted` and `failed`. */
  reason?: string;
  /** The literal fallback that was substituted, when `status === 'defaulted'`. */
  defaultUsed?: string | number | boolean;
}

/** Keyed by the scraper's own field name (`name`, `checkIn`, `petsAllowed`, …). */
export type ScrapeFieldStatus = Record<string, FieldReport>;

export interface ExtractionSummary {
  extracted: number;
  defaulted: number;
  failed: number;
  'admin-entered': number;
  total: number;
}

/**
 * Machine-readable failure codes. A scrape that cannot produce usable data
 * returns one of these with a non-2xx status — never `success: true`.
 */
export type ScrapeErrorCode =
  /** 410 — the Airbnb listing is gone (Airbnb serves a soft 404 with HTTP 200). */
  | 'LISTING_DELISTED'
  /** 502 — Airbnb served its own error/maintenance page instead of the listing. */
  | 'AIRBNB_ERROR_PAGE'
  /** 403 — a bot-detection wall or interstitial was served instead of the listing. */
  | 'SCRAPER_BLOCKED'
  /** 422 — the page loaded but carries no listing structure at all. */
  | 'PAGE_UNUSABLE'
  /** 503 — the headless browser could not be started or downloaded. */
  | 'BROWSER_UNAVAILABLE'
  /** 504 — navigation to the listing timed out. */
  | 'NAVIGATION_TIMEOUT'
  /** 500 — anything else. */
  | 'SCRAPE_FAILED';

export interface ScrapeFailureBody {
  success: false;
  error: string;
  code: ScrapeErrorCode;
  /** Short, operator-actionable next step. */
  hint?: string;
  /** Evidence read off the page, for the operator and for debugging. */
  evidence?: Record<string, string | number>;
}
