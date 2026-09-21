import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium-min';
import { findBestIcons } from '@/app/data/amenityIcons';
import { createRateLimiter } from '@/app/lib/api/rate-limit';
import { validateAirbnbUrl } from '@/app/lib/api/validate';
import { guardedFetch } from '@/app/lib/api/url-guard';
import { verifyAdminSession } from '@/app/lib/api/verify-admin';
import { apiSuccess, apiError, apiFailure, apiRateLimited } from '@/app/lib/api/safe-response';
import type { ScrapeFieldStatus, ExtractionSummary } from '@/app/types/scrape';

export const maxDuration = 120;

// 3 requests per 5 minutes per IP — scraping is expensive
const limiter = createRateLimiter({ windowMs: 5 * 60_000, maxRequests: 3 });

// GitHub-hosted Chromium binary for @sparticuz/chromium-min (downloaded at runtime)
const CHROMIUM_PACK_URL =
  'https://github.com/Sparticuz/chromium/releases/download/v143.0.4/chromium-v143.0.4-pack.x64.tar';

/**
 * Sections a valid listing always renders, and the fields that depend on each.
 *
 * Airbnb hydrates the listing page progressively. Measured on 2026-09-21 at 4x
 * CPU throttle: the first sections exist at ~1.1s, DESCRIPTION_DEFAULT at
 * ~3.8s, POLICIES_DEFAULT and LOCATION_DEFAULT only at ~5.5s. The old health
 * gate accepted any page with at least one section, so a capture taken at 1.1s
 * passed as healthy and every late section read as "not found".
 *
 * That is what the 2026-09-21 production scrape hit: description NOT FOUND and
 * check-in/check-out DEFAULTED (both DOM-only, both late), while highlights,
 * amenities, offers, images and reviews came through — all of which read the
 * embedded <script> JSON, which is in the initial HTML and needs no hydration.
 */
const REQUIRED_SECTIONS = [
  'TITLE_DEFAULT',
  'OVERVIEW_DEFAULT_V2',
  'DESCRIPTION_DEFAULT',
  'AMENITIES_DEFAULT',
  'POLICIES_DEFAULT',
  'LOCATION_DEFAULT',
] as const;

/** Which fields become unreadable when a given section never rendered. */
const SECTION_FIELDS: Record<string, string[]> = {
  OVERVIEW_DEFAULT_V2: ['propertyTypeTag', 'guests', 'bedrooms', 'beds', 'bathrooms'],
  DESCRIPTION_DEFAULT: ['description'],
  POLICIES_DEFAULT: ['checkIn', 'checkOut', 'rules', 'petsAllowed', 'smokingAllowed', 'partyAllowed'],
  LOCATION_DEFAULT: ['location'],
};

/**
 * How long to wait for the required sections after navigation settles.
 *
 * Sits inside the 120s route ceiling: 30s navigation + 20s here + 45s photo
 * tour + extraction still leaves headroom, and the wait resolves as soon as
 * the sections appear (~2-4s in practice) rather than sleeping the full
 * budget.
 */
const SECTION_WAIT_MS = 20_000;

/** Grace period for *any* section to appear, before concluding the page is broken. */
const FIRST_SECTION_WAIT_MS = 5_000;

/** The tags the admin form offers. A value outside this set cannot be selected. */
const KNOWN_PROPERTY_TYPE_TAGS = [
  'Entire home',
  'Entire condo',
  'Entire guest suite',
  'Private room',
  'Shared room',
];

/**
 * Normalise an Airbnb clock string to "H:MM AM"/"H:MM PM".
 *
 * Airbnb writes "4:00 p.m." with periods, and the hour is sometimes bare
 * ("4 p.m."). Returns null when there is no meridiem to read — a time without
 * AM/PM is ambiguous and must not be reported as extracted.
 */
function normalizeClockTime(raw: string): string | null {
  const m = raw.match(/(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?/i);
  if (!m) return null;
  const hour = parseInt(m[1], 10);
  if (hour < 1 || hour > 12) return null;
  const minutes = m[2] ?? '00';
  return `${hour}:${minutes} ${m[3].toUpperCase()}M`;
}

export async function POST(request: Request) {
  // ── Admin auth — reject unauthenticated requests before any work ──
  const auth = verifyAdminSession(request);
  if (!auth.valid) return apiError(auth.error!, auth.status!);

  // ── Rate limit ───────────────────────────────────────────
  const limit = await limiter.check(request);
  if (limit.limited) return apiRateLimited(limit.retryAfterMs);

  let browser;
  try {
    // ── Parse body ─────────────────────────────────────────
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return apiError('Invalid JSON body', 400);
    }

    const { url } = body;

    // ── Validate URL ───────────────────────────────────────
    const urlCheck = validateAirbnbUrl(url);
    if (!urlCheck.valid) return apiError(urlCheck.error!, 400);

    // In production (Vercel), use @sparticuz/chromium-min's serverless binary.
    // In local dev, fall back to the system Chrome installation.
    const isLocal = process.env.NODE_ENV === 'development';

    browser = await puppeteer.launch({
      args: isLocal
        ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        : chromium.args,
      defaultViewport: { width: 1920, height: 1080 },
      executablePath: isLocal
        ? (process.env.CHROME_PATH ||
           '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
        : await chromium.executablePath(CHROMIUM_PACK_URL),
      headless: true,
    });

    const page = await browser.newPage();
    
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    const navResponse = await page.goto(urlCheck.value!, { waitUntil: 'networkidle2', timeout: 30000 });

    /**
     * Airbnb's soft-404 marker is only visible to a plain HTTP request: the
     * headless browser is served the client app shell, which renders
     * "Something went wrong" and rewrites document.title to Airbnb's generic
     * title. Verified 2026-09-20 against a delisted room — plain fetch returns
     * `<title>404 Page Not Found - Airbnb</title>` in a 2.9 KB body, while the
     * same URL under Puppeteer reports the generic title and zero sections.
     *
     * Only called on the failure path, so a healthy scrape pays nothing.
     */
    const fetchServerRenderedTitle = async (): Promise<string> => {
      try {
        const res = await guardedFetch(urlCheck.value!, {
          timeoutMs: 8_000,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NubnbPropertyImporter/1.0)' },
        });
        const html = await res.text();
        return (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '').trim();
      } catch {
        return '';
      }
    };

    // Dismiss cookie/translation banners
    try {
      await page.evaluate(() => {
        // Cookie banner
        const cookieBtn = document.querySelector('button[data-testid="accept-btn"]') as HTMLButtonElement;
        if (cookieBtn) cookieBtn.click();
        // Translation popups - remove them
        document.querySelectorAll('[data-testid="translation-announce-modal"]').forEach(el => el.remove());
      });
      // Wait for the banner to actually go, rather than sleeping a flat 1.5s.
      await page
        .waitForFunction(
          () => !document.querySelector('button[data-testid="accept-btn"]'),
          { timeout: 3_000, polling: 100 },
        )
        .catch(() => {});
    } catch { /* ignore */ }

    // ============================================================
    // SECTION WAIT
    // Give the page a bounded chance to finish hydrating before anything is
    // read off it. Resolves as soon as every required section exists, so a
    // healthy page pays only the time it actually needs.
    // ============================================================
    const captureStartedAt = Date.now();

    // First, a short grace for *any* section. A delisted or blocked page never
    // grows one, and must not sit through the full section budget before the
    // health gate can classify it.
    await page
      .waitForFunction(() => document.querySelectorAll('[data-section-id]').length > 0, {
        timeout: FIRST_SECTION_WAIT_MS,
        polling: 250,
      })
      .catch(() => {});

    const anySection = await page.evaluate(
      () => document.querySelectorAll('[data-section-id]').length > 0,
    );

    if (anySection) {
      await page
        .waitForFunction(
          (ids: readonly string[]) =>
            ids.every((id) => document.querySelector(`[data-section-id="${id}"]`) !== null),
          { timeout: SECTION_WAIT_MS, polling: 250 },
          REQUIRED_SECTIONS as unknown as string[],
        )
        .catch(() => {});
    }

    const sectionsPresent: string[] = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-section-id]'))
        .map((el) => el.getAttribute('data-section-id') || '')
        .filter(Boolean),
    );
    const captureElapsedMs = Date.now() - captureStartedAt;
    const missingSections = REQUIRED_SECTIONS.filter((id) => !sectionsPresent.includes(id));

    /**
     * One line per scrape, on the server. This is the evidence that settles
     * "partial capture" versus "Vercel is served a different page" — a
     * production run either shows the late sections missing at capture, or
     * shows them present and the extractors still empty.
     */
    console.log(
      `[scrape-airbnb] url=${urlCheck.value} waitedMs=${captureElapsedMs} ` +
        `sectionCount=${sectionsPresent.length} ` +
        `missingRequired=[${missingSections.join(',') || 'none'}] ` +
        `sections=[${sectionsPresent.join(',')}]`,
    );

    // ============================================================
    // PAGE HEALTH GATE
    // Airbnb answers HTTP 200 for delisted listings, for its own error page,
    // and for bot walls. Extraction against any of those produces an empty
    // payload that used to be reported as success. Refuse to continue, and
    // say which of the three happened — the operator's next action differs.
    // ============================================================
    const health = await page.evaluate(() => {
      const bodyText = (document.body?.innerText || '').slice(0, 4000);
      return {
        h1: document.querySelector('h1')?.textContent?.trim() || '',
        title: (document.title || '').trim(),
        sectionCount: document.querySelectorAll('[data-section-id]').length,
        bodyText,
        captchaMarkers: [
          '#px-captcha',
          '[data-testid="captcha"]',
          'iframe[src*="recaptcha"]',
          'iframe[src*="hcaptcha"]',
          'iframe[title*="captcha" i]',
          'form[action*="captcha" i]',
        ].filter((sel) => {
          try { return document.querySelector(sel) !== null; } catch { return false; }
        }),
        finalUrl: location.href,
      };
    });

    {
      const hay = `${health.title}\n${health.h1}\n${health.bodyText}`.toLowerCase();
      const evidence: Record<string, string | number> = {
        httpStatus: navResponse?.status() ?? 0,
        pageTitle: health.title || '(empty)',
        h1: health.h1 || '(none)',
        dataSectionIdCount: health.sectionCount,
        finalUrl: health.finalUrl,
      };

      const looksBroken =
        health.sectionCount === 0 ||
        /^something went wrong/i.test(health.h1) ||
        hay.includes('airbnb may be undergoing maintenance');

      // 1. Bot wall / interstitial — checked first: a block can also render an
      //    error-looking body, and "you are blocked" is the actionable fact.
      const BLOCK_PHRASES = [
        'confirm you are human',
        'confirm you’re human',
        "confirm you're human",
        'verify you are a human',
        'are you a robot',
        'access to this page has been denied',
        'access denied',
        'unusual traffic',
        'suspicious activity',
        'please verify you are',
        'security check',
        'perimeterx',
        'px-captcha',
      ];
      const blockPhrase = BLOCK_PHRASES.find((p) => hay.includes(p));
      if (blockPhrase || health.captchaMarkers.length > 0) {
        return apiFailure({
          message:
            'Airbnb blocked this request — it served a bot-detection page instead of the listing.',
          status: 403,
          code: 'SCRAPER_BLOCKED',
          hint: 'Wait a few minutes and retry. If it keeps happening the scraper IP is being challenged; no data was imported.',
          evidence: {
            ...evidence,
            marker: blockPhrase || health.captchaMarkers.join(', '),
          },
        });
      }

      // 2. Delisted — Airbnb's soft-404 marker. Serves HTTP 200 regardless, so
      //    confirm against the server-rendered HTML rather than the DOM.
      const serverTitle = looksBroken ? await fetchServerRenderedTitle() : '';
      if (serverTitle) evidence.serverRenderedTitle = serverTitle;

      if (
        /404\s*page not found/i.test(serverTitle) ||
        /404\s*page not found/i.test(health.title) ||
        hay.includes('404 page not found')
      ) {
        return apiFailure({
          message: 'This Airbnb listing no longer exists — Airbnb returned its "404 Page Not Found" page.',
          status: 410,
          code: 'LISTING_DELISTED',
          hint: 'The listing has been removed or unlisted by the host. Nothing was imported; use a current listing URL.',
          evidence,
        });
      }

      // 3. Airbnb's own error / maintenance page.
      if (
        /^something went wrong/i.test(health.h1) ||
        /^something went wrong/i.test(health.title) ||
        hay.includes('airbnb may be undergoing maintenance')
      ) {
        return apiFailure({
          message: 'Airbnb served an error page ("Something went wrong") instead of the listing.',
          status: 502,
          code: 'AIRBNB_ERROR_PAGE',
          hint: 'This is Airbnb-side. Retry in a few minutes. If it persists for one URL only, the listing is probably delisted.',
          evidence,
        });
      }

      // 4. Structurally empty: a real listing page always carries data-section-id
      //    nodes. Checked after the bounded section wait above, so a page that
      //    was merely slow is no longer mistaken for an empty one.
      if (health.sectionCount === 0) {
        return apiFailure({
          message: 'The page loaded but contains no Airbnb listing content (zero listing sections).',
          status: 422,
          code: 'PAGE_UNUSABLE',
          hint: 'Nothing was imported. Open the URL in a browser to check what Airbnb is actually serving.',
          evidence: { ...evidence, waitedMs: captureElapsedMs },
        });
      }

      // 5. Structurally incomplete: sections exist, but the ones this scrape
      //    depends on never arrived inside the budget. Not fatal — everything
      //    sourced from the embedded JSON is still good — but the fields that
      //    needed those sections are reported as a timeout, not as "not found".
      //    The operator's action differs: retry, rather than fill in by hand.
      if (missingSections.length > 0) {
        console.warn(
          `[scrape-airbnb] incomplete capture after ${captureElapsedMs}ms — ` +
            `missing ${missingSections.join(', ')}`,
        );
      }
    }

    // Non-fatal degradations that used to be console-only. Returned to the
    // operator so a half-scraped listing is visible as half-scraped.
    const warnings: string[] = [];

    // ============================================================
    // STRATEGY 1: Extract amenities from embedded JSON (most reliable)
    // Airbnb embeds structured amenity data in script tags
    // ============================================================
    const scriptData = await page.evaluate(() => {
      interface AmenityFromScript {
        title: string;
        available: boolean;
        icon?: string;
        category?: string;
      }

      const amenities: AmenityFromScript[] = [];
      const previewAmenities: string[] = [];

      // Helper: extract a JSON array from text starting at a given position using bracket counting
      const extractJsonArray = (text: string, startIdx: number): string | null => {
        if (text[startIdx] !== '[') return null;
        let depth = 0;
        for (let i = startIdx; i < text.length && i < startIdx + 50000; i++) {
          if (text[i] === '[') depth++;
          else if (text[i] === ']') depth--;
          if (depth === 0) return text.substring(startIdx, i + 1);
        }
        return null;
      };

      const scripts = document.querySelectorAll('script');
      for (const script of scripts) {
        const text = script.textContent || '';
        if (text.length < 500) continue;

        // Search for various known key patterns for amenity groups
        const groupKeys = ['"listingAmenities":', '"seeAllAmenitiesGroups":', '"amenityGroups":'];
        for (const key of groupKeys) {
          if (amenities.length > 0) break;
          const keyIdx = text.indexOf(key);
          if (keyIdx === -1) continue;
          
          // Find the opening bracket after the key
          const bracketIdx = text.indexOf('[', keyIdx + key.length);
          if (bracketIdx === -1 || bracketIdx > keyIdx + key.length + 5) continue;
          
          const jsonStr = extractJsonArray(text, bracketIdx);
          if (!jsonStr) continue;
          
          try {
            const groups = JSON.parse(jsonStr);
            for (const group of groups) {
              const category = group.title || group.name || group.groupTitle || 'General';
              const items = group.amenities || group.items || group.listItems || [];
              if (Array.isArray(items)) {
                for (const a of items) {
                  const title = a.title || a.name || '';
                  if (!title) continue;
                  amenities.push({
                    title,
                    available: a.available !== false,
                    icon: a.icon || '',
                    category,
                  });
                }
              }
            }
          } catch { /* partial parse */ }
        }

        // Fallback: flat "amenities" array (may contain objects or just IDs)
        if (amenities.length === 0) {
          const flatKeys = ['"previewAmenities":'];
          for (const key of flatKeys) {
            const keyIdx = text.indexOf(key);
            if (keyIdx === -1) continue;
            const bracketIdx = text.indexOf('[', keyIdx + key.length);
            if (bracketIdx === -1 || bracketIdx > keyIdx + key.length + 5) continue;
            const jsonStr = extractJsonArray(text, bracketIdx);
            if (!jsonStr) continue;
            try {
              const items = JSON.parse(jsonStr);
              for (const a of items) {
                if (typeof a === 'object' && a.title) {
                  amenities.push({
                    title: a.title,
                    available: a.available !== false,
                    icon: a.icon || '',
                    category: a.category || 'General',
                  });
                }
              }
            } catch { /* ignore */ }
          }
        }

        // Preview amenities (top items shown on card)
        if (previewAmenities.length === 0) {
          const previewIdx = text.indexOf('"previewAmenities":');
          if (previewIdx !== -1) {
            const bracketIdx = text.indexOf('[', previewIdx + 20);
            if (bracketIdx !== -1 && bracketIdx < previewIdx + 25) {
              const jsonStr = extractJsonArray(text, bracketIdx);
              if (jsonStr) {
                try {
                  const items = JSON.parse(jsonStr);
                  for (const a of items) {
                    if (typeof a === 'object' && a.title) previewAmenities.push(a.title);
                    else if (typeof a === 'string') previewAmenities.push(a);
                  }
                } catch { /* ignore */ }
              }
            }
          }
        }

        if (amenities.length > 0) break;
      }

      return { amenities, previewAmenities };
    });

    // ============================================================
    // STRATEGY 2: Open modal and extract amenities + SVG icons
    // We always try to open the modal for SVG icons, even if script data was found
    // ============================================================
    let modalOffers: { name: string; category: string; available: boolean; icon: string }[] = [];

    {
      // Click "Show all amenities" button
      try {
        const showAllBtn = await page.evaluateHandle(() => {
          const buttons = Array.from(document.querySelectorAll('button'));
          return buttons.find(b => (b.textContent || '').includes('Show all') && (b.textContent || '').includes('amenities'));
        });
        if (showAllBtn && showAllBtn.asElement()) {
          await (showAllBtn.asElement() as unknown as { click(): Promise<void> }).click();
          // Wait for the modal to open rather than sleeping 2.5s regardless.
          await page
            .waitForFunction(() => document.querySelector('[role="dialog"]') !== null, {
              timeout: 5_000,
              polling: 100,
            })
            .catch(() => {});
        }
      } catch { /* ignore */ }

      modalOffers = await page.evaluate(() => {
        const offers: { name: string; category: string; available: boolean; icon: string }[] = [];
        const modal = document.querySelector('[role="dialog"]');
        if (!modal) return offers;

        let currentCategory = 'General';

        // Walk through H2 headings and li items in order
        const elements = modal.querySelectorAll('h2, li');
        elements.forEach(el => {
          if (el.tagName === 'H2') {
            const text = el.textContent?.trim();
            if (text && text !== 'What this place offers') {
              currentCategory = text;
            }
          } else if (el.tagName === 'LI') {
            const text = el.textContent?.trim() || '';
            if (!text || text.length < 2 || text.length > 100) return;
            const lower = text.toLowerCase();
            if (lower.includes('show all') || lower.includes('translation')) return;
            const isUnavailable = lower.includes('unavailable');
            const cleanName = text.replace(/Unavailable/gi, '').trim();

            // Extract SVG icon from the li element
            let iconSvg = '';
            const svgEl = el.querySelector('svg');
            if (svgEl) {
              // Clone and clean the SVG for storage
              const clone = svgEl.cloneNode(true) as SVGElement;
              clone.removeAttribute('class');
              clone.setAttribute('width', '24');
              clone.setAttribute('height', '24');
              iconSvg = clone.outerHTML;
            }

            if (cleanName && !offers.find(o => o.name === cleanName)) {
              offers.push({ name: cleanName, category: currentCategory, available: !isUnavailable, icon: iconSvg });
            }
          }
        });

        return offers;
      });
    }

    // Build final offers array, merging SVG icons from modal with script data
    let finalOffers: { name: string; category: string; available: boolean; icon: string }[];


    /** Return a valid SVG string or '' — rejects SYSTEM_* identifiers and other non-SVG data */
    const sanitizeIcon = (raw: string): string => {
      if (!raw || !raw.trim().startsWith('<svg')) return '';
      return raw;
    };

    /** Use shared icon library to find a matching icon by amenity name */
    const getFallbackIcon = (name: string): string => {
      const matches = findBestIcons(name, 1);
      return matches.length > 0 ? matches[0].svg : '';
    };

    if (scriptData.amenities.length > 0) {
      const modalIconMap = new Map<string, string>();
      for (const mo of modalOffers) {
        if (mo.icon) modalIconMap.set(mo.name, mo.icon);
      }
      finalOffers = scriptData.amenities.map(a => ({
        name: a.title,
        category: a.category || 'General',
        available: a.available,
        icon: sanitizeIcon(modalIconMap.get(a.title) || '') || sanitizeIcon(a.icon || '') || getFallbackIcon(a.title),
      }));
    } else {
      finalOffers = modalOffers.map(o => ({
        ...o,
        icon: sanitizeIcon(o.icon) || getFallbackIcon(o.name),
      }));
    }

    // Top amenities for card badges
    const topAmenities = scriptData.previewAmenities.length > 0
      ? scriptData.previewAmenities.slice(0, 6)
      : finalOffers.filter(o => o.available).slice(0, 6).map(o => o.name);

    // ============================================================
    // Extract all other data from DOM
    // ============================================================
    const domData = await page.evaluate(() => {
      // Title
      const title = document.querySelector('h1')?.textContent?.trim() || '';

      // ── Property type tag ──
      // OVERVIEW_DEFAULT no longer exists; the section is OVERVIEW_DEFAULT_V2.
      // Its h2 reads "<type> in <City>, <Country>", e.g. "Entire condo in
      // Toronto, Canada" or "Room in Ottawa, Canada". Airbnb's own word for a
      // private room is just "Room"; the catalogue calls it "Private room".
      let propertyTypeTag = '';
      let overviewHeadingText = '';
      const overviewSection = document.querySelector('[data-section-id="OVERVIEW_DEFAULT_V2"]');
      const overviewHeading = overviewSection?.querySelector('h2');
      if (overviewHeading) {
        overviewHeadingText = overviewHeading.textContent?.trim() || '';
        const beforeIn = overviewHeadingText.split(/\s+in\s+/i)[0]?.trim() || '';
        propertyTypeTag = /^room\b/i.test(beforeIn) ? 'Private room' : beforeIn;
      }

      /** True when this listing is a room rather than a whole place. */
      const isRoomListing = /^(room|private room|shared room)\b/i.test(
        overviewHeadingText.split(/\s+in\s+/i)[0]?.trim() || '',
      );

      /**
       * A studio is stated in place of a bedroom count ("2 guests · Studio ·
       * 1 bed · 1 bath"). Zero bedrooms is then the listing's own answer, not
       * a failed read.
       */
      const isStudio = /\bstudio\b/i.test(
        (document.querySelector('[data-section-id="OVERVIEW_DEFAULT_V2"]') as HTMLElement | null)
          ?.innerText || '',
      );

      // Description — preserve line breaks and spacing
      let description = '';
      const descSection = document.querySelector('[data-section-id="DESCRIPTION_DEFAULT"] span span');
      if (descSection) {
        // Convert HTML to text while preserving line breaks
        // Clone so we don't modify the DOM
        const clone = descSection.cloneNode(true) as HTMLElement;
        // Replace <br> tags with newline markers
        clone.querySelectorAll('br').forEach(br => {
          br.replaceWith('\n');
        });
        // Replace block-level elements (div, p) with newline-separated text
        clone.querySelectorAll('div, p').forEach(block => {
          block.insertAdjacentText('beforebegin', '\n');
          block.insertAdjacentText('afterend', '\n');
        });
        // Get text and clean up excessive newlines
        description = (clone.textContent || '')
          .replace(/\r\n/g, '\n')
          .replace(/\n{3,}/g, '\n\n') // collapse 3+ newlines to 2
          .trim();
      }

      // Capacity
      const overviewItems: string[] = [];
      // Strategy 1: the V2 overview section (the old OVERVIEW_DEFAULT id is gone).
      document.querySelectorAll('ol li, [data-section-id="OVERVIEW_DEFAULT_V2"] li, [data-section-id="OVERVIEW_DEFAULT_V2"] span, [data-section-id="OVERVIEW_DEFAULT_V2"] div').forEach(el => {
        const text = el.textContent?.trim();
        if (text && text.length < 100) overviewItems.push(text);
      });

      let guests = 0, bedrooms = 0, beds = 0, bathrooms = 0;
      for (const item of overviewItems) {
        const lower = item.toLowerCase();
        const gMatch = lower.match(/(\d+)\s*guest/);
        const bedMatch = lower.match(/(\d+)\s*bedroom/);
        const bedsMatch = lower.match(/(\d+)\s*bed(?!room)/);
        const bathMatch = lower.match(/([\d.]+)\s*bath/);
        if (gMatch) guests = parseInt(gMatch[1]);
        if (bedMatch) bedrooms = parseInt(bedMatch[1]);
        if (bedsMatch) beds = parseInt(bedsMatch[1]);
        if (bathMatch) bathrooms = parseFloat(bathMatch[1]);
      }

      // Fallback: search body text for beds if not found above
      if (beds === 0) {
        const bodyText = document.body.textContent || '';
        const fallbackBeds = bodyText.match(/(\d+)\s+beds?\b/i);
        if (fallbackBeds) beds = parseInt(fallbackBeds[1]);
      }

      // Highlights — multi-strategy extraction
      const highlights: string[] = [];

      // Helper: extract a JSON array from text using bracket counting
      const extractArr = (text: string, startIdx: number): string | null => {
        if (text[startIdx] !== '[') return null;
        let depth = 0;
        for (let i = startIdx; i < text.length && i < startIdx + 50000; i++) {
          if (text[i] === '[') depth++;
          else if (text[i] === ']') depth--;
          if (depth === 0) return text.substring(startIdx, i + 1);
        }
        return null;
      };

      // Strategy 1: Look for "listingHighlights" key in script JSON data
      const scripts = document.querySelectorAll('script');
      for (const script of scripts) {
        if (highlights.length >= 3) break;
        const text = script.textContent || '';
        if (text.length < 500) continue;

        // Try multiple known key patterns
        const hlKeys = ['"listingHighlights":', '"highlights":', '"hostHighlights":'];
        for (const key of hlKeys) {
          if (highlights.length >= 3) break;
          let searchStart = 0;
          while (searchStart < text.length) {
            const keyIdx = text.indexOf(key, searchStart);
            if (keyIdx === -1) break;
            searchStart = keyIdx + key.length;

            // Check for array
            const bracketIdx = text.indexOf('[', keyIdx + key.length);
            if (bracketIdx !== -1 && bracketIdx <= keyIdx + key.length + 10) {
              const jsonStr = extractArr(text, bracketIdx);
              if (jsonStr) {
                try {
                  const items = JSON.parse(jsonStr);
                  for (const item of items) {
                    if (highlights.length >= 3) break;
                    // Items can be objects with title/headline or strings
                    const title = typeof item === 'string' ? item
                      : (item.title || item.headline || item.name || '');
                    if (title && title.length > 1 && title.length < 80) {
                      if (!highlights.includes(title)) highlights.push(title);
                    }
                    // Some structures nest the title inside a "message" object
                    if (!title && item.message) {
                      const msg = typeof item.message === 'string' ? item.message : item.message.title || '';
                      if (msg && msg.length > 1 && msg.length < 80 && !highlights.includes(msg)) {
                        highlights.push(msg);
                      }
                    }
                  }
                } catch { /* partial parse, continue */ }
              }
            }

            // Check for object (single highlight)
            if (highlights.length < 3) {
              const braceIdx = text.indexOf('{', keyIdx + key.length);
              if (braceIdx !== -1 && braceIdx <= keyIdx + key.length + 5) {
                // Try to extract just the title/headline from nearby text
                const snippet = text.substring(braceIdx, braceIdx + 500);
                const titleMatch = snippet.match(/"(?:title|headline)"\s*:\s*"([^"]{2,80})"/);
                if (titleMatch && !highlights.includes(titleMatch[1])) {
                  highlights.push(titleMatch[1]);
                }
              }
            }
          }
        }
      }

      // Strategy 2: Scan script tags for "headline" fields near highlight-related context
      if (highlights.length < 3) {
        for (const script of scripts) {
          if (highlights.length >= 3) break;
          const text = script.textContent || '';
          if (text.length < 500) continue;

          // Look for patterns like "Self check-in", "Extra spacious" near highlight contexts
          const contextPatterns = [/listingHighlight/i, /highlight/i];
          for (const pattern of contextPatterns) {
            const match = text.match(pattern);
            if (!match) continue;
            // Search a wide window around the match for headline/title values
            const start = Math.max(0, (match.index || 0) - 2000);
            const end = Math.min(text.length, (match.index || 0) + 5000);
            const window = text.substring(start, end);
            const headlineRegex = /"(?:title|headline)"\s*:\s*"([^"]{2,80})"/g;
            let hm;
            while ((hm = headlineRegex.exec(window)) !== null && highlights.length < 3) {
              const val = hm[1];
              // Filter out generic/unrelated values
              if (val && !val.includes('\\') && !highlights.includes(val)) {
                highlights.push(val);
              }
            }
            if (highlights.length >= 3) break;
          }
        }
      }

      // Strategy 3: DOM-based fallback — highlights are typically shown as rows 
      // with icon + title near the overview section
      if (highlights.length < 3) {
        const overviewSection = document.querySelector('[data-section-id="OVERVIEW_DEFAULT_V2"]');
        if (overviewSection) {
          // Look for highlight-like elements after the overview heading
          // They typically appear as div rows with an SVG icon and text
          const parent = overviewSection.parentElement || overviewSection;
          const allDivs = parent.querySelectorAll('div');
          for (const div of allDivs) {
            if (highlights.length >= 3) break;
            // Highlight rows typically have an SVG and a short title
            const svg = div.querySelector('svg');
            const hasNestedDiv = div.querySelector('div');
            if (!svg || hasNestedDiv) continue;
            const text = div.textContent?.trim() || '';
            if (text.length >= 3 && text.length <= 50 && !highlights.includes(text)) {
              // Avoid capacity strings like "2 guests" or "1 bedroom"
              if (!/^\d+\s*(guest|bed|bath)/i.test(text)) {
                highlights.push(text);
              }
            }
          }
        }
      }

      // ── Location ──
      // `getText('[data-section-id="LOCATION_DEFAULT"] span')` took the first
      // span, which is the disclaimer ("Exact location will be provided after
      // booking." / "This listing's location is verified."). The place name is
      // not in a span at all — it is a bare div, second line of the section:
      //   "Where you'll be\nToronto, Ontario, Canada\nExact location will be…"
      let location = '';
      {
        const locEl = document.querySelector('[data-section-id="LOCATION_DEFAULT"]') as HTMLElement | null;
        if (locEl) {
          const BOILERPLATE =
            /^(where you|exact location|this listing|learn more|show more|we.ll only share)/i;
          location =
            (locEl.innerText || '')
              .split('\n')
              .map(l => l.trim())
              .find(l => l.length > 2 && l.length < 120 && !BOILERPLATE.test(l)) || '';
        }
      }

      // Images
      const images: string[] = [];
      document.querySelectorAll('img').forEach(img => {
        const src = img.src || img.getAttribute('data-original-uri') || '';
        if (!src) return;
        // Skip non-photo sources: data URIs, SVGs, icons, base64
        if (src.startsWith('data:')) return;
        if (src.endsWith('.svg') || src.includes('.svg?')) return;
        if (!src.includes('muscache.com')) return;
        // Skip known icon/avatar class names
        const cls = img.className || '';
        if (cls.includes('i10eokyx')) return;
        // Skip small images by URL width param
        const urlWidthMatch = src.match(/im_w=(\d+)/);
        if (urlWidthMatch && parseInt(urlWidthMatch[1]) < 400) return;
        // Skip profile/host/avatar sections
        const parentSection = img.closest('[data-section-id="HOST_OVERVIEW_DEFAULT"], [data-section-id="HOST_PROFILE_DEFAULT"], [data-section-id="REVIEWS_DEFAULT"], [data-section-id="MEET_YOUR_HOST"]');
        if (parentSection) return;
        // Skip images inside profile-like containers
        const profileParent = img.closest('[aria-label*="host"], [aria-label*="Host"], [aria-label*="profile"], [aria-label*="avatar"]');
        if (profileParent) return;
        // Skip profile pics by URL path (Airbnb uses /im/pictures/user/ or /im/users/ for avatars)
        if (/\/(user|users|avatars|profiles)\//i.test(src)) return;
        // Skip small rendered images (icons, thumbnails, avatars)
        const renderedW = img.getBoundingClientRect().width;
        const renderedH = img.getBoundingClientRect().height;
        if (renderedW > 0 && renderedW < 150) return;
        if (renderedH > 0 && renderedH < 150) return;
        // Skip circular images (typically profile avatars)
        const style = window.getComputedStyle(img);
        if (style.borderRadius === '50%' || style.borderRadius === '9999px') return;
        const cleanSrc = src.split('?')[0] + '?im_w=1200';
        if (!images.includes(cleanSrc)) images.push(cleanSrc);
      });

      // ── House rules, check-in and check-out ──
      // POLICIES_DEFAULT renders divs now, not <li>: measured 0 <li> and 31-32
      // <div> on all four listings probed on 2026-09-21. Every rule-derived
      // field was therefore empty on every scrape, which is why "no pets" was
      // indistinguishable from "never extracted".
      //
      // Read innerText and slice the "House rules" block out of it. That is
      // stable against the li/div churn, and keeps the section's own headings
      // ("Cancellation policy", "Safety & property") out of the rules list.
      const rules: string[] = [];
      let checkInRaw = '', checkOutRaw = '';
      let guestsFromRules = 0;
      // Tri-state: an explicit "No pets" and an absent rule are different
      // facts. POLICIES_DEFAULT shows a truncated list (measured: one visible
      // rule, "N guests maximum", on all four listings probed), so absence
      // here means "not stated on the page", never "not allowed".
      let petsRule: boolean | null = null;
      let smokingRule: boolean | null = null;
      let partyRule: boolean | null = null;

      const policiesEl = document.querySelector('[data-section-id="POLICIES_DEFAULT"]') as HTMLElement | null;
      if (policiesEl) {
        const HEADINGS = /^(things to know|cancellation policy|house rules|safety & property|safety and property)$/i;
        const NOISE = /^(learn more|show more|add dates|add your trip dates)/i;

        const lines = (policiesEl.innerText || '')
          .split('\n')
          .map(l => l.trim())
          .filter(Boolean);

        let inHouseRules = false;
        for (const line of lines) {
          if (/^house rules$/i.test(line)) { inHouseRules = true; continue; }
          if (HEADINGS.test(line)) { inHouseRules = false; continue; }
          if (NOISE.test(line)) continue;

          const lower = line.toLowerCase();

          // Check-in / checkout live inside the House rules block. Two shapes:
          //   "Check-in after 4:00 p.m."
          //   "Check-in: 4:00 p.m.–11:00 p.m."   (a window, no "after")
          // Take the first time in either; the window's start is the check-in.
          if (!checkInRaw && /check-?in/i.test(lower)) { checkInRaw = line; continue; }
          if (!checkOutRaw && /check-?out|checkout/i.test(lower)) { checkOutRaw = line; continue; }

          if (!inHouseRules) continue;
          if (line.length <= 3) continue;

          rules.push(line);

          // "N guests maximum" is the listing's own occupancy cap, and is the
          // only place a room listing publishes a guest count at all.
          const guestCap = lower.match(/(\d+)\s+guests?\s+maximum/);
          if (guestCap) guestsFromRules = parseInt(guestCap[1], 10);

          if (/\bno pets\b/.test(lower)) petsRule = false;
          else if (lower.includes('pets allowed') || lower.includes('pet friendly')) petsRule = true;

          if (/\bno smoking\b/.test(lower)) smokingRule = false;
          else if (lower.includes('smoking allowed')) smokingRule = true;

          if (/\bno (parties|events)\b/.test(lower)) partyRule = false;
          else if (lower.includes('events allowed') || lower.includes('parties allowed')) partyRule = true;
        }
      }

      // Price is deliberately not extracted — the admin enters it. Airbnb
      // shows no nightly rate on an undated listing page, and listing URLs are
      // normalised to carry no dates, so any selector here would report a
      // failure on every single import.

      return {
        title, description, guests, bedrooms, beds, bathrooms,
        location, images, highlights, propertyTypeTag,
        checkInRaw, checkOutRaw, rules, petsRule, smokingRule, partyRule,
        isRoomListing, guestsFromRules, overviewHeadingText, isStudio,
      };
    });

    // ── Normalise the clock strings ──
    // Airbnb writes "4:00 p.m."; the catalogue wants "4:00 PM". A raw line
    // with no readable meridiem yields null, which is reported as a failure
    // rather than passed through as an ambiguous time.
    const checkIn = normalizeClockTime(domData.checkInRaw) ?? '';
    const checkOut = normalizeClockTime(domData.checkOutRaw) ?? '';

    // ── Guest count ──
    // The V2 overview omits it on room listings. "N guests maximum" in the
    // house rules is the listing's own cap and carries the same number where
    // both appear, so it is a valid second source rather than a guess.
    const guests = domData.guests > 0 ? domData.guests : domData.guestsFromRules;

    // ============================================================
    // HOUSE RULES — the full list, from behind the disclosure control
    //
    // POLICIES_DEFAULT renders only the first few rules inline. Measured
    // 2026-09-21 on three live listings, the visible block carries exactly
    // check-in, checkout and "N guests maximum"; every pet, smoking, party
    // and quiet-hours rule sits behind a control labelled "Learn more"
    // (not "Show more"), which opens a dialog headed "House rules".
    //
    // Without this step `rules` looked EXTRACTED off a one-item list, and
    // pets/smoking/parties were reported unknown on listings that state all
    // three outright.
    // ============================================================
    const fullRules: string[] = [];
    let rulesDialogOpened = false;

    try {
      const clicked = await page.evaluate(() => {
        const pol = document.querySelector('[data-section-id="POLICIES_DEFAULT"]');
        if (!pol) return false;
        // The first disclosure inside the section belongs to House rules; the
        // second belongs to Safety & property.
        const control = [...pol.querySelectorAll('button,a')].find((b) =>
          /learn more|show more|show all/i.test(b.textContent || ''),
        ) as HTMLElement | undefined;
        if (!control) return false;
        control.scrollIntoView({ block: 'center' });
        control.click();
        return true;
      });

      if (clicked) {
        await page
          .waitForFunction(
            () =>
              [...document.querySelectorAll('[role="dialog"]')].some((d) =>
                /house rules/i.test(d.textContent || ''),
              ),
            { timeout: 8_000, polling: 150 },
          )
          .catch(() => {});

        const lines: string[] = await page.evaluate(() => {
          const dialog = [...document.querySelectorAll('[role="dialog"]')].find((d) =>
            /house rules/i.test(d.textContent || ''),
          ) as HTMLElement | undefined;
          if (!dialog) return [];
          return (dialog.innerText || '')
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean);
        });

        if (lines.length > 0) {
          rulesDialogOpened = true;

          /**
           * The dialog is sectioned:
           *   House rules / <intro> / Checking in and out / During your stay
           *   / Before you leave / Additional rules
           *
           * Only the structured sections are read. "Additional rules" is
           * host free text — prose, sometimes several hundred words, itself
           * truncated behind another "Show more". Two reasons to stop there:
           * `terms.rules` is rendered as a list of short rules, and one
           * listing's prose says "pets are okay as long as they are trained
           * well" directly under a structured "No pets". Airbnb's structured
           * field is the authoritative one, so permissions are read from it
           * alone and never from the prose.
           *
           * The free text is therefore NOT captured; the operator adds it by
           * hand if it matters for a listing.
           */
          const STRUCTURED = /^(checking in and out|during your stay|before you leave)$/i;
          const PROSE_SECTION = /^additional rules$/i;
          const HEADING = /^house rules$/i;
          const INTRO = /^you.ll be staying in someone.s home/i;
          const NOISE = /^(show more|show all|learn more|close)$/i;
          // Second line of a two-line rule ("Quiet hours" / "11 p.m.-7 a.m.").
          const BARE_RANGE = /^\d{1,2}(:\d{2})?\s*[ap]\.?m\.?\s*[–—-]\s*\d{1,2}(:\d{2})?\s*[ap]\.?m\.?$/i;

          let inStructured = false;
          for (const line of lines) {
            if (HEADING.test(line) || INTRO.test(line)) continue;
            if (PROSE_SECTION.test(line)) { inStructured = false; continue; }
            if (STRUCTURED.test(line)) { inStructured = true; continue; }
            if (!inStructured) continue;
            if (NOISE.test(line)) continue;
            // Check-in/checkout have their own fields.
            if (/^check-?in|^checkout/i.test(line)) continue;

            if (BARE_RANGE.test(line) && fullRules.length > 0) {
              fullRules[fullRules.length - 1] = `${fullRules[fullRules.length - 1]} ${line}`;
              continue;
            }
            if (!fullRules.includes(line)) fullRules.push(line);
          }
        }
      }
    } catch (rulesErr) {
      console.error('House-rules dialog error (non-fatal):', rulesErr);
    } finally {
      // Always close it. A dialog left open is read back by the photo-tour
      // and review steps as though it were theirs — the bug that kept the
      // review modal from ever yielding anything.
      try {
        await page.evaluate(() => {
          const dialog = [...document.querySelectorAll('[role="dialog"]')].find((d) =>
            /house rules/i.test(d.textContent || ''),
          );
          const close = dialog?.querySelector(
            'button[aria-label="Close"], button[aria-label*="lose"]',
          ) as HTMLElement | null;
          if (close) close.click();
        });
        await page
          .waitForFunction(
            () =>
              ![...document.querySelectorAll('[role="dialog"]')].some((d) =>
                /house rules/i.test(d.textContent || ''),
              ),
            { timeout: 4_000, polling: 100 },
          )
          .catch(() => {});
      } catch { /* ignore */ }
    }

    // The dialog's list supersedes the visible one when it opened.
    const rules = rulesDialogOpened && fullRules.length > 0 ? fullRules : domData.rules;

    /** Explicit statements only — silence is never permission, either way. */
    const readPermission = (
      allow: RegExp,
      deny: RegExp,
    ): boolean | null => {
      for (const r of rules) {
        const lower = r.toLowerCase();
        if (deny.test(lower)) return false;
        if (allow.test(lower)) return true;
      }
      return null;
    };

    const petsRule = rulesDialogOpened
      ? readPermission(/pets allowed|pet friendly/, /\bno pets\b/)
      : domData.petsRule;
    const smokingRule = rulesDialogOpened
      ? readPermission(/smoking allowed/, /\bno smoking\b/)
      : domData.smokingRule;
    const partyRule = rulesDialogOpened
      ? readPermission(/(parties|events) allowed/, /\bno (parties|events)\b/)
      : domData.partyRule;

    // ============================================================
    // PHOTO TOUR: Scrape additional images from the photo tour modal.
    // This adds categorized images (Living room, Kitchen, etc.) that
    // aren't visible on the main listing page.
    // ============================================================
    let photoTourImages: string[] = [];
    try {
      // Build the photo tour URL by appending the modal parameter
      const photoUrl = urlCheck.value!.split('&modal=')[0].split('?modal=')[0];
      const separator = photoUrl.includes('?') ? '&' : '?';
      const photoTourUrl = `${photoUrl}${separator}modal=PHOTO_TOUR_SCROLLABLE`;

      await page.goto(photoTourUrl, { waitUntil: 'networkidle2', timeout: 45000 });

      // Wait for the gallery to exist rather than sleeping 4s and hoping.
      await page
        .waitForFunction(
          () =>
            document.querySelector('[data-testid^="photo-viewer"]') !== null ||
            document.querySelector('[role="dialog"] img') !== null,
          { timeout: 15_000, polling: 250 },
        )
        .catch(() => {});

      // Dismiss any popups on the photo tour page
      try {
        await page.evaluate(() => {
          const cookieBtn = document.querySelector('button[data-testid="accept-btn"]') as HTMLButtonElement;
          if (cookieBtn) cookieBtn.click();
          document.querySelectorAll('[data-testid="translation-announce-modal"]').forEach(el => el.remove());
        });
      } catch { /* ignore */ }

      /**
       * Scroll the photo tour until the image count stops growing.
       *
       * Was: three fixed passes, each re-scrolling from the top, with 1.5s and
       * 2.5s sleeps between them — 65% of the slowest audit run, and the same
       * cost whether the gallery held 9 images or 47. Passes 2 and 3 exist to
       * catch stragglers from lazy loading, which is a condition we can just
       * measure: keep scrolling while new images keep appearing, stop when a
       * full pass adds none.
       *
       * The convergence test is the image count itself, so yield cannot drop
       * below what the fixed passes produced without this loop noticing.
       */
      const countPhotoTourImages = () =>
        page.evaluate(() => {
          const urls = new Set<string>();
          const add = (u: string) => {
            if (u && u.includes('muscache.com') && !u.startsWith('data:')) {
              urls.add(u.split('?')[0]);
            }
          };
          document.querySelectorAll('img').forEach(img => add(img.src || ''));
          document.querySelectorAll('picture source').forEach(s => {
            const set = s.getAttribute('srcset') || '';
            const last = set.split(',').pop()?.trim().split(' ')[0] || '';
            add(last);
          });
          return urls.size;
        });

      const MAX_SCROLL_PASSES = 6;
      let previousCount = -1;
      for (let pass = 0; pass < MAX_SCROLL_PASSES; pass++) {
        await page.evaluate(async (passNum) => {
          // Find the actual scrollable div inside the photo tour dialog
          // It's a child div whose scrollHeight significantly exceeds its clientHeight
          const findScrollableEl = (): HTMLElement => {
            const dialogs = document.querySelectorAll('[role="dialog"]');
            for (const dialog of dialogs) {
              const divs = dialog.querySelectorAll('div');
              // Find the div with the biggest scroll overflow (that's the photo tour scroll container)
              let best: HTMLElement | null = null;
              let bestOverflow = 0;
              for (const div of divs) {
                const overflow = div.scrollHeight - div.clientHeight;
                if (overflow > bestOverflow) {
                  bestOverflow = overflow;
                  best = div;
                }
              }
              if (best && bestOverflow > 100) return best;
            }
            return document.documentElement;
          };

          const el = findScrollableEl();

          // On subsequent passes, scroll back to top first so lazy loaders
          // above the current position get another chance.
          if (passNum > 0) el.scrollTop = 0;

          /**
           * Wait for the images currently in flight to settle, rather than
           * sleeping a flat interval after every step. Resolves as soon as
           * every <img> in the container reports complete, so a fast gallery
           * costs a few milliseconds instead of half a second per step.
           */
          const settle = async (budgetMs: number) => {
            const deadline = Date.now() + budgetMs;
            while (Date.now() < deadline) {
              const pending = Array.from(el.querySelectorAll('img')).some(
                img => !(img as HTMLImageElement).complete,
              );
              if (!pending) return;
              await new Promise(r => setTimeout(r, 50));
            }
          };

          // Scroll in increments to trigger all lazy loaders
          const scrollStep = 400;
          const maxScrolls = 120;
          let prevScrollTop = -1;
          let stuckCount = 0;

          for (let i = 0; i < maxScrolls; i++) {
            el.scrollTop += scrollStep;
            await settle(500);

            // Check if we're actually moving
            if (el.scrollTop === prevScrollTop) {
              stuckCount++;
              if (stuckCount >= 3) break; // truly at the bottom
            } else {
              stuckCount = 0;
            }
            prevScrollTop = el.scrollTop;
          }

          // Final: ensure we're at absolute bottom, then let the last row load
          el.scrollTop = el.scrollHeight;
          await settle(1500);
        }, pass);

        // Stop as soon as a full pass stops finding new images. The first
        // pass always runs; a second only happens if the first was still
        // discovering, and so on.
        const count = await countPhotoTourImages();
        if (count === previousCount) break;
        previousCount = count;
      }

      // Extract ALL images from photo tour — from both <img> and <picture><source srcset>
      photoTourImages = await page.evaluate(() => {
        const images: string[] = [];
        const addUrl = (rawUrl: string) => {
          if (!rawUrl || !rawUrl.includes('muscache.com')) return;
          if (rawUrl.startsWith('data:')) return;
          if (rawUrl.endsWith('.svg') || rawUrl.includes('.svg?')) return;
          if (rawUrl.includes('.png')) return; // skip icons/logos
          if (/\/(user|users|avatars|profiles)\//i.test(rawUrl)) return;
          const cleanSrc = rawUrl.split('?')[0] + '?im_w=1200';
          if (!images.includes(cleanSrc)) images.push(cleanSrc);
        };

        // Strategy 1: Extract from <img> tags inside photo-viewer sections
        const photoSections = document.querySelectorAll('[data-testid^="photo-viewer"]');
        photoSections.forEach(section => {
          section.querySelectorAll('img').forEach(img => {
            const src = img.src || img.getAttribute('data-original-uri') || '';
            addUrl(src);
          });
          // Also extract from <picture><source srcset> inside photo sections
          section.querySelectorAll('picture source').forEach(source => {
            const srcset = source.getAttribute('srcset') || '';
            // srcset format: "url1 1x, url2 2x" — we want the highest quality
            const urls = srcset.split(',').map(s => s.trim().split(' ')[0]);
            // Pick the last/highest quality URL
            if (urls.length > 0) {
              addUrl(urls[urls.length - 1]);
            }
          });
        });

        // Strategy 2: If no photo-viewer sections found, scan all dialogs
        if (images.length === 0) {
          const dialogs = document.querySelectorAll('[role="dialog"]');
          dialogs.forEach(dialog => {
            dialog.querySelectorAll('img').forEach(img => {
              const src = img.src || img.getAttribute('data-original-uri') || '';
              if (!src.includes('muscache.com')) return;
              if (src.startsWith('data:') || src.endsWith('.svg') || src.includes('.png')) return;
              // Skip small images (avatars, icons)
              const w = img.getBoundingClientRect().width;
              const h = img.getBoundingClientRect().height;
              if (w > 0 && w < 150) return;
              if (h > 0 && h < 150) return;
              const style = window.getComputedStyle(img);
              if (style.borderRadius === '50%' || style.borderRadius === '9999px') return;
              addUrl(src);
            });
            // Also grab from srcset in dialogs
            dialog.querySelectorAll('picture source').forEach(source => {
              const srcset = source.getAttribute('srcset') || '';
              const urls = srcset.split(',').map(s => s.trim().split(' ')[0]);
              for (const u of urls) {
                if (u.includes('.jpeg') || u.includes('.jpg') || u.includes('.webp')) {
                  addUrl(u);
                }
              }
            });
          });
        }

        // Strategy 3: Fallback — scan ALL img tags on the page
        if (images.length === 0) {
          document.querySelectorAll('img').forEach(img => {
            const src = img.src || '';
            if (!src.includes('muscache.com')) return;
            if (src.startsWith('data:') || src.endsWith('.svg') || src.includes('.png')) return;
            if (/\/(user|users|avatars|profiles)\//i.test(src)) return;
            const w = img.getBoundingClientRect().width;
            if (w > 0 && w < 150) return;
            const style = window.getComputedStyle(img);
            if (style.borderRadius === '50%') return;
            addUrl(src);
          });
        }

        return images;
      });

    } catch (photoTourError) {
      console.error('Photo tour scraping error (non-fatal):', photoTourError);
      warnings.push('The photo-tour gallery could not be read, so most images are missing. Only the main-page photos were imported.');
      // Non-fatal — we still have the main page images
    }

    // Merge photo tour images with main page images (dedup, main page first)
    const allImages = [...domData.images];
    for (const img of photoTourImages) {
      if (!allImages.includes(img)) {
        allImages.push(img);
      }
    }

    // ============================================================
    // REVIEWS: Extract rating, review count, and individual reviews
    //
    // Navigate back to the listing first. The photo-tour step above leaves the
    // page on `?modal=PHOTO_TOUR_SCROLLABLE`, and everything below reads
    // `[role="dialog"]` — which, on that URL, is the photo tour. Measured
    // 2026-09-21: after the photo-tour navigation the page carries 2 dialogs
    // and the first is the gallery. That is why the "Show all N reviews"
    // modal "never fired" in any audit run: the trigger was clicked, but the
    // dialog then read back was the photo tour, which has no review headings.
    // ============================================================
    const reviewData: {
      averageRating: number;
      totalReviewCount: number;
      reviews: { reviewer: string; date: string; rating: number; text: string; avatar: string }[];
      /** Where the count came from — used to refuse a host-level number. */
      countSource: 'listing-json' | 'listing-section' | 'reviews-empty' | 'none';
    } = { averageRating: 0, totalReviewCount: 0, reviews: [], countSource: 'none' };

    try {
      if (page.url() !== urlCheck.value) {
        await page.goto(urlCheck.value!, { waitUntil: 'domcontentloaded', timeout: 30000 });
        // Wait for the section to be POPULATED, not merely present. Waiting
        // only for the element loses single-review listings: the section
        // renders with its "1 review" heading well before the review body
        // hydrates, and the DOM fallback then finds nothing to walk.
        await page
          .waitForFunction(
            () => {
              if (document.querySelector('[data-section-id="REVIEWS_EMPTY_DEFAULT"]')) return true;
              const el = document.querySelector('[data-section-id="REVIEWS_DEFAULT"]') as HTMLElement | null;
              if (!el) return false;
              // A populated section carries a reviewer heading beyond the
              // "N reviews" one, and enough text to be an actual review.
              const headings = Array.from(el.querySelectorAll('h2, h3')).filter(
                h => !/review/i.test(h.textContent || ''),
              );
              return headings.length > 0 && (el.innerText || '').length > 150;
            },
            { timeout: 15_000, polling: 250 },
          )
          .catch(() => {});
      }
      // Step 1: Extract rating, count, AND individual reviews from embedded JSON
      const scriptReviewData = await page.evaluate(() => {
        let rating = 0;
        let count = 0;
        let countSource: 'listing-json' | 'listing-section' | 'reviews-empty' | 'none' = 'none';

        // REVIEWS_EMPTY_DEFAULT is Airbnb's explicit "no reviews yet" section.
        // It is a positive statement of zero, not a missing value.
        const reviewsEmpty =
          document.querySelector('[data-section-id="REVIEWS_EMPTY_DEFAULT"]') !== null;
        const reviews: { reviewer: string; date: string; rating: number; text: string; avatar: string }[] = [];

        const scripts = document.querySelectorAll('script');
        for (const script of scripts) {
          const text = script.textContent || '';
          if (text.length < 500) continue;

          // ── Rating ──
          // "overallRating" is gone from the embedded JSON. Measured on four
          // live listings 2026-09-21, the value now appears as
          // guestSatisfactionOverall / starRating / ratingValue, all agreeing
          // (4.76, 5, 5, and 0 on the listing with no reviews).
          if (!rating) {
            const ratingMatch =
              text.match(/"guestSatisfactionOverall"\s*:\s*([\d.]+)/) ||
              text.match(/"ratingValue"\s*:\s*"?([\d.]+)"?/) ||
              text.match(/"starRating"\s*:\s*([\d.]+)/) ||
              text.match(/"overallRating"\s*:\s*([\d.]+)/);
            if (ratingMatch) rating = parseFloat(ratingMatch[1]);
          }

          // ── Review count ──
          // These keys are the listing's own count. The host's lifetime total
          // is NOT here — it is rendered in MEET_YOUR_HOST, and the old DOM
          // fallback used to pick it up (436 for a listing with zero reviews).
          if (!count) {
            const countMatch = text.match(/"reviewsCount"\s*:\s*(\d+)/)
              || text.match(/"visibleReviewCount"\s*:\s*"?(\d+)"?/)
              || text.match(/"reviewCount"\s*:\s*(\d+)/);
            if (countMatch) { count = parseInt(countMatch[1]); countSource = 'listing-json'; }
          }

          // Extract individual reviews from embedded JSON
          // Airbnb embeds reviews in various formats - search for review arrays
          if (reviews.length === 0) {
            // Look for "reviews" arrays containing objects with comment/reviewText
            const reviewPatterns = [
              /"reviews"\s*:\s*\[/,
              /"pdpReviews"\s*:\s*\[/,
              /"merlinReviews"\s*:\s*\[/,
            ];

            for (const pattern of reviewPatterns) {
              if (reviews.length > 0) break;
              const match = text.match(pattern);
              if (!match || match.index === undefined) continue;

              // Find the array start
              const arrStart = text.indexOf('[', match.index);
              if (arrStart === -1) continue;

              // Extract using bracket counting
              let depth = 0;
              let end = arrStart;
              for (let i = arrStart; i < text.length && i < arrStart + 100000; i++) {
                if (text[i] === '[') depth++;
                else if (text[i] === ']') depth--;
                if (depth === 0) { end = i; break; }
              }

              try {
                const arr = JSON.parse(text.substring(arrStart, end + 1));
                if (!Array.isArray(arr)) continue;
                for (const item of arr) {
                  if (!item || typeof item !== 'object') continue;
                  const reviewText = item.comments || item.comment || item.reviewText || item.text || item.body || '';
                  const reviewer = item.reviewer?.firstName || item.reviewer?.name || item.authorName || item.author?.firstName || item.reviewerName || '';
                  if (!reviewText || !reviewer) continue;

                  const reviewRating = item.rating || item.reviewRating || item.stars || 5;
                  const date = item.createdAt || item.reviewDate || item.date || item.localizedDate || '';
                  const avatar = item.reviewer?.pictureUrl || item.reviewer?.avatar || item.authorAvatar || item.author?.pictureUrl || '';

                  // Parse date to readable format
                  let displayDate = '';
                  if (date) {
                    try {
                      const d = new Date(date);
                      if (!isNaN(d.getTime())) {
                        displayDate = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
                      } else {
                        displayDate = date;
                      }
                    } catch { displayDate = date; }
                  }

                  reviews.push({
                    reviewer,
                    date: displayDate,
                    rating: typeof reviewRating === 'number' ? reviewRating : parseInt(reviewRating) || 5,
                    text: reviewText,
                    avatar: avatar || '',
                  });
                }
              } catch { /* parse error, continue */ }
            }
          }
        }

        // ── An explicitly empty listing overrides everything ──
        if (reviewsEmpty) {
          return { rating: 0, count: 0, countSource: 'reviews-empty' as const, reviews: [] };
        }

        // Fallback: DOM-based rating extraction
        if (!rating) {
          const ratingEl = document.querySelector('[data-testid="pdp-reviews-highlight-banner-host-rating"]');
          if (ratingEl) {
            const m = (ratingEl.textContent || '').match(/([\d.]+)/);
            if (m) rating = parseFloat(m[1]);
          }
        }

        // ── Count fallback, scoped to the listing's own review section ──
        // The previous version scanned every <a>, <button> and <span> on the
        // page, so on a listing with no reviews it matched "454 reviews" in
        // MEET_YOUR_HOST — the host's lifetime total across all their
        // listings. Searching only inside REVIEWS_DEFAULT makes that
        // impossible: the host card is a different section.
        if (!count) {
          const reviewSection = document.querySelector('[data-section-id="REVIEWS_DEFAULT"]');
          if (reviewSection) {
            const m = (reviewSection.textContent || '').match(/(\d[\d,]*)\s+reviews?/i);
            if (m) { count = parseInt(m[1].replace(/,/g, '')); countSource = 'listing-section'; }
          }
        }

        return { rating, count, countSource, reviews };
      });

      reviewData.averageRating = scriptReviewData.rating;
      reviewData.totalReviewCount = scriptReviewData.count;
      reviewData.reviews = scriptReviewData.reviews;
      reviewData.countSource = scriptReviewData.countSource;

      /**
       * Read review cards.
       *
       * Airbnb marks each one with `data-review-id`, which is the only
       * reliable handle: the previous approach walked h2/h3 inside the
       * reviews section, and the section also renders the per-category
       * rating breakdown as headings ("Rated 4.8 out of 5 stars for
       * accuracy"). Those were imported as reviewers on every listing that
       * had a modal to open.
       *
       * Card shape, measured 2026-09-21:
       *   John / Manassas Park, Virginia / Rating, 5 stars / · / August 2026
       *   / · / Stayed a few nights / <the review text>
       */
      const readReviewCards = () =>
        page.evaluate(() => {
          const MONTH =
            /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}$/i;
          const RELATIVE = /^(\d+\s+(day|week|month|year)s?\s+ago|yesterday|today|last\s+week)$/i;
          const STAYED = /^stayed\s/i;
          const TENURE = /years?\s+on\s+airbnb$/i;

          return [...document.querySelectorAll('[data-review-id]')].map((card) => {
            const lines = ((card as HTMLElement).innerText || '')
              .split('\n')
              .map((l) => l.trim())
              .filter((l) => l && l !== ',' && l !== '·');

            const reviewer = card.querySelector('h2,h3')?.textContent?.trim() || lines[0] || '';
            const date = lines.find((l) => MONTH.test(l) || RELATIVE.test(l)) || '';

            const ratingLine = lines.find((l) => /^rating,\s*\d/i.test(l)) || '';
            const rating = parseInt(ratingLine.match(/(\d+)/)?.[1] || '5', 10);

            // The body is the longest line that is not one of the metadata
            // lines above.
            let text = '';
            for (const l of lines) {
              if (l === reviewer || l === date) continue;
              if (/^rating,/i.test(l) || STAYED.test(l) || TENURE.test(l)) continue;
              if (l.length > text.length) text = l;
            }

            return { reviewer, date, rating, text, avatar: '' };
          });
        });

      /**
       * Fallback for listings whose reviews carry no `data-review-id`.
       *
       * A listing with a single review renders it inline with no card
       * attribute and no test id (measured on a 1-review listing), but with
       * the same line grammar:
       *   Huijun / 9 years on Airbnb / Rating, 5 stars / · / April 2026 /
       *   · / Stayed over a week / <text>
       *
       * Segmenting on the "Rating, N stars" line is what makes this safe:
       * the per-category rating rows read "Rated N out of 5 stars for X",
       * which does not match, so they cannot be mistaken for reviews.
       */
      const readInlineReviews = () =>
        page.evaluate(() => {
          const sec = document.querySelector('[data-section-id="REVIEWS_DEFAULT"]') as HTMLElement | null;
          if (!sec) return [];
          const lines = (sec.innerText || '')
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l && l !== ',' && l !== '·');

          const MONTH =
            /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}$/i;
          const RELATIVE = /^(\d+\s+(day|week|month|year)s?\s+ago|yesterday|today|last\s+week)$/i;
          const RATING_LINE = /^rating,\s*(\d+)\s*stars?$/i;
          const SKIP =
            /^(how reviews work|average rating will appear|\d+\s+reviews?$|overall rating|show more|stayed\s|\d+\s+years?\s+on airbnb$|rated\s)/i;

          const out: { reviewer: string; date: string; rating: number; text: string; avatar: string }[] = [];
          for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(RATING_LINE);
            if (!m) continue;
            const rating = parseInt(m[1], 10);

            let reviewer = '';
            for (let j = i - 1; j >= 0 && j >= i - 4; j--) {
              if (!SKIP.test(lines[j]) && lines[j].length <= 40) { reviewer = lines[j]; break; }
            }
            let date = '';
            let text = '';
            for (let j = i + 1; j < lines.length && j <= i + 8; j++) {
              if (!date && (MONTH.test(lines[j]) || RELATIVE.test(lines[j]))) { date = lines[j]; continue; }
              if (SKIP.test(lines[j])) continue;
              if (lines[j].length > text.length && lines[j].length > 20) text = lines[j];
            }
            if (reviewer && date && text) out.push({ reviewer, date, rating, text, avatar: '' });
          }
          return out;
        });

      // Step 2: read whatever cards the page itself carries.
      //
      // The section renders its cards when it comes into view, so scroll to
      // it first and wait for a card rather than reading an empty section.
      if (reviewData.reviews.length === 0) {
        await page.evaluate(() => {
          document
            .querySelector('[data-section-id="REVIEWS_DEFAULT"]')
            ?.scrollIntoView({ block: 'center' });
        });
        await page
          .waitForFunction(() => document.querySelectorAll('[data-review-id]').length > 0, {
            timeout: 8_000,
            polling: 200,
          })
          .catch(() => {});
        const pageCards = await readReviewCards();
        if (pageCards.length > 0) reviewData.reviews = pageCards;
        else reviewData.reviews = await readInlineReviews();
      }

      // Step 3: If fewer than 10 reviews, click "Show all reviews" modal and scrape more
      if (reviewData.reviews.length < 10) {
        try {
          const showAllBtn = await page.evaluateHandle(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            return buttons.find(b => /show all.*\d+.*review/i.test(b.textContent || ''));
          });

          if (showAllBtn && showAllBtn.asElement()) {
            await (showAllBtn.asElement() as unknown as { click(): Promise<void> }).click();
            // Wait for a dialog that actually contains reviews, instead of
            // sleeping 3s and reading whichever dialog happens to be first.
            // Wait for the modal's review CARDS, not just for a dialog to
            // exist. The dialog appears with its rating summary well before
            // the cards render, and reading it at that moment returns none.
            await page
              .waitForFunction(
                () =>
                  Array.from(document.querySelectorAll('[role="dialog"]')).some(
                    (d) => d.querySelectorAll('[data-review-id]').length > 0,
                  ),
                { timeout: 12_000, polling: 200 },
              )
              .catch(() => {});

            // Same card reader — the modal renders the same
            // `data-review-id` cards, just more of them.
            const modalReviews = await readReviewCards();

            if (modalReviews.length > 0) {
              // Merge: add modal reviews that aren't already in the list
              const existingNames = new Set(reviewData.reviews.map(r => r.reviewer));
              for (const mr of modalReviews) {
                if (!existingNames.has(mr.reviewer)) {
                  reviewData.reviews.push(mr);
                  existingNames.add(mr.reviewer);
                }
              }
            }

            try {
              const closeBtn = await page.evaluateHandle(() => {
                return document.querySelector('[role="dialog"] button[aria-label="Close"], [role="dialog"] button:first-child');
              });
              if (closeBtn && closeBtn.asElement()) {
                await (closeBtn.asElement() as unknown as { click(): Promise<void> }).click();
                await new Promise(r => setTimeout(r, 500));
              }
            } catch { /* ignore */ }
          }
        } catch (modalErr) {
          console.error('Review modal scraping error (non-fatal):', modalErr);
          warnings.push('The "Show all reviews" modal could not be opened, so only the reviews visible on the page were imported.');
        }
      }

      // ── Reject anything that is not a review ──
      //
      // The reviews section and its modal both render the per-category
      // rating breakdown as headings ("Rated 4.8 out of 5 stars for
      // accuracy"), and the heading-walk that finds reviewer names cannot
      // tell those from a person. Observed on two live listings: five
      // identical-length "reviews" whose reviewer was a rating row and whose
      // date was empty. A record that shape is not a review, and storing it
      // would also fail CreatePropertySchema on `date`.
      //
      // A real review has a person's name, a date, and body text. Anything
      // missing one of those is dropped rather than repaired.
      const RATING_ROW = /rated|out of 5|stars?\b|overall|average|categor/i;
      reviewData.reviews = reviewData.reviews.filter((r) => {
        if (!r.reviewer || RATING_ROW.test(r.reviewer)) return false;
        if (r.reviewer.length > 40) return false;
        if (!r.date || !r.date.trim()) return false;
        if (!r.text || r.text.trim().length < 10) return false;
        return true;
      });

      // The same body text under several headings is the walk latching onto a
      // shared container, not several people saying the same thing.
      const seenText = new Set<string>();
      reviewData.reviews = reviewData.reviews.filter((r) => {
        const key = r.text.trim().slice(0, 120);
        if (seenText.has(key)) return false;
        seenText.add(key);
        return true;
      });

      // Cap at 10 reviews
      reviewData.reviews = reviewData.reviews.slice(0, 10);

      // ── Drop empty avatars rather than sending "" ──
      // `avatar` is an optional URL. The scraper has never resolved one, so
      // it emitted "" on every review, and z.string().url() rejects "" —
      // which 422'd every create of a listing that had reviews. Absent is
      // what "not set" means; the schema does not need loosening. (The 142
      // reviews already stored as "" are accepted on update by
      // StoredReviewSchema.)
      reviewData.reviews = reviewData.reviews.map((r) => {
        if (r.avatar && r.avatar.trim()) return r;
        const { avatar: _avatar, ...withoutAvatar } = r;
        return withoutAvatar as typeof r;
      });

    } catch (reviewErr) {
      console.error('Review scraping error (non-fatal):', reviewErr);
      warnings.push('Review extraction failed outright — rating, review count and reviews are all unimported.');
    }

    // ============================================================
    // PER-FIELD PROVENANCE
    // Every field below is reported as extracted / defaulted / failed, computed
    // from the raw extractor output *before* any `|| fallback` is applied. A
    // hard-coded default is never presented as listing data.
    // ============================================================
    const fieldStatus: ScrapeFieldStatus = {};

    /** A field with no fallback: either it was read off the page, or it is empty. */
    const track = (field: string, extracted: boolean, failReason: string) => {
      fieldStatus[field] = extracted
        ? { status: 'extracted' }
        : { status: 'failed', reason: failReason };
    };

    /** A field whose empty extraction is papered over by a hard-coded constant. */
    const trackDefault = (
      field: string,
      extracted: boolean,
      defaultUsed: string | number | boolean,
      reason: string,
    ) => {
      fieldStatus[field] = extracted
        ? { status: 'extracted' }
        : { status: 'defaulted', defaultUsed, reason };
    };

    /** A field the scraper deliberately leaves to the operator. Not a failure. */
    const trackAdminEntered = (field: string, reason: string) => {
      fieldStatus[field] = { status: 'admin-entered', reason };
    };

    /**
     * Overwrite any field whose source section never rendered.
     *
     * "The section did not load in time" and "the page does not carry this
     * value" call for different actions — retry versus type it in — so they
     * must not share the `failed` reason. Applied last, so it wins over
     * whatever the extractor concluded from an absent section.
     */
    const applySectionTimeouts = () => {
      for (const sectionId of missingSections) {
        for (const field of SECTION_FIELDS[sectionId] ?? []) {
          fieldStatus[field] = {
            status: 'failed',
            reason: `section did not load in time — retry the import (${sectionId} had not rendered after ${captureElapsedMs}ms)`,
          };
        }
      }
    };

    track('name', !!domData.title, 'No <h1> title found on the page.');
    track('description', !!domData.description, 'The DESCRIPTION_DEFAULT section returned no text.');

    // ── Capacity, and what a room listing does not publish ──
    // Airbnb prints no guest, bedroom or bathroom count in the overview of a
    // room listing: its whole overview reads e.g. "Room in Ottawa, Canada
    // 1 king bed · · Shared bathroom". Verified absent from the server HTML
    // too, so this is the listing, not the selector. The bathroom is a word
    // ("Shared bathroom"), which a number cannot represent at all.
    const ROOM_NOT_PUBLISHED =
      'Airbnb does not publish this for private rooms — enter manually.';

    if (domData.isRoomListing && guests === 0) {
      track('guests', false, ROOM_NOT_PUBLISHED);
    } else {
      track('guests', guests > 0, 'No guest capacity found in the overview text or house rules.');
    }
    if (domData.isStudio && domData.bedrooms === 0) {
      // "Studio" is the listing's stated answer: zero bedrooms, read off the page.
      fieldStatus.bedrooms = { status: 'extracted' };
    } else {
      track(
        'bedrooms',
        domData.bedrooms > 0,
        domData.isRoomListing ? ROOM_NOT_PUBLISHED : 'No bedroom count found in the overview text.',
      );
    }
    track('beds', domData.beds > 0, 'No bed count found in the overview text.');
    track(
      'bathrooms',
      domData.bathrooms > 0,
      domData.isRoomListing ? ROOM_NOT_PUBLISHED : 'No bathroom count found in the overview text.',
    );

    track('location', !!domData.location, 'The LOCATION_DEFAULT section carried no place name — set the display location manually.');
    track('coverImage', allImages.length > 0, 'No listing photos were found, so there is no cover image.');
    track('images', allImages.length > 1, 'No additional photos beyond the cover image were found.');

    // ── Property type tag ──
    // Only a value the form can actually select counts as extracted. Anything
    // else (a type Airbnb words differently, or an empty heading) falls back
    // to the hard-coded default and is reported as defaulted, never as data.
    const tagIsKnown =
      !!domData.propertyTypeTag && KNOWN_PROPERTY_TYPE_TAGS.includes(domData.propertyTypeTag);
    trackDefault(
      'propertyTypeTag',
      tagIsKnown,
      'Entire home',
      domData.propertyTypeTag
        ? `Read "${domData.propertyTypeTag}" from the listing, which is not one of the tags this form offers (${KNOWN_PROPERTY_TYPE_TAGS.join(', ')}). "Entire home" is a hard-coded default — pick the right tag.`
        : 'Not extracted — "Entire home" is a hard-coded default, not listing data. Confirm it manually.',
    );

    track('highlights', domData.highlights.length > 0, 'No listing highlights were found.');
    track('amenities', topAmenities.length > 0, 'No top amenities — derived from offers, which are also empty.');
    track('offers', finalOffers.length > 0, 'Neither the embedded amenity JSON nor the amenities modal returned anything.');

    // ── Check-in / check-out ──
    // `checkIn`/`checkOut` are null unless a meridiem was read, so a time
    // without AM/PM can never reach the form as extracted data.
    trackDefault(
      'checkIn',
      !!checkIn,
      '4:00 PM',
      domData.checkInRaw
        ? `Read "${domData.checkInRaw}" but could not resolve an AM/PM time from it. "4:00 PM" is a hard-coded default — confirm it manually.`
        : 'Not extracted — "4:00 PM" is a hard-coded default, not listing data. Confirm it manually.',
    );
    trackDefault(
      'checkOut',
      !!checkOut,
      '11:00 AM',
      domData.checkOutRaw
        ? `Read "${domData.checkOutRaw}" but could not resolve an AM/PM time from it. "11:00 AM" is a hard-coded default — confirm it manually.`
        : 'Not extracted — "11:00 AM" is a hard-coded default, not listing data. Confirm it manually.',
    );

    // ── Rules ──
    // EXTRACTED only when the full list was read. A partial list is the
    // failure this dispatch exists to stop: the visible block is three lines
    // long and states none of the permissions, so reporting it as extracted
    // told the operator the rules had been captured when they had not.
    if (rulesDialogOpened && rules.length > 0) {
      fieldStatus.rules = { status: 'extracted' };
    } else if (rules.length > 0) {
      fieldStatus.rules = {
        status: 'failed',
        reason: `only the first ${rules.length} visible rule${rules.length === 1 ? '' : 's'} were read — the full list could not be opened. What was read is in the field; complete it from the listing.`,
      };
    } else {
      track('rules', false, 'The POLICIES_DEFAULT house-rules list returned no entries.');
    }

    // ── Permissions ──
    // Extracted only when the page actually said so, either way. Airbnb's
    // POLICIES_DEFAULT shows a truncated rule list behind a "Show more"
    // control — measured 2026-09-21, the only visible rule on all four
    // listings probed was "N guests maximum" — so a missing "No pets" line is
    // silence, not permission. Reporting `false` as extracted here would
    // recreate the original defect (the public UI stating "no pets" as fact
    // when nothing was ever read) with a green badge on top of it.
    const permissionUnknown = rulesDialogOpened
      ? 'The full house-rules list was read and does not state this either way. `false` here means unknown, not "not allowed".'
      : 'The full house-rules list could not be opened, and the visible rules do not state this. `false` here means unknown, not "not allowed".';
    track('petsAllowed', petsRule !== null, permissionUnknown);
    track('smokingAllowed', smokingRule !== null, permissionUnknown);
    track('partyAllowed', partyRule !== null, permissionUnknown);

    // ── Price ──
    // Not scraped at all. Listing URLs are normalised to carry no dates and
    // Airbnb prints no nightly rate on an undated page, so reporting this as
    // "failed" would flag a failure on every import forever.
    trackAdminEntered(
      'price',
      'The admin sets the price — the scraper never reads it from Airbnb.',
    );

    // ── Rating ──
    // A rating must be inside 0–5, and a listing with no reviews cannot have
    // one. Airbnb states the empty case explicitly with REVIEWS_EMPTY_DEFAULT,
    // which the extractor turns into count 0 / rating 0.
    const ratingInRange =
      reviewData.averageRating > 0 && reviewData.averageRating <= 5;
    const hasReviews = reviewData.totalReviewCount > 0;
    if (reviewData.averageRating !== 0 && !ratingInRange) {
      track('averageRating', false, `Discarded an out-of-range rating (${reviewData.averageRating}); a rating must be between 0 and 5.`);
      reviewData.averageRating = 0;
    } else if (ratingInRange && !hasReviews) {
      track('averageRating', false, 'A rating was found on a listing with no reviews, so it is not the listing\'s own — discarded.');
      reviewData.averageRating = 0;
    } else if (reviewData.countSource === 'reviews-empty') {
      track('averageRating', false, 'This listing has no reviews yet (Airbnb shows its "No reviews yet" section), so there is no rating.');
    } else {
      track('averageRating', ratingInRange, 'No overall rating was found on the page.');
    }

    // ── Review count ──
    // Only the listing's own count is acceptable. Anything read outside the
    // listing's review section — in practice the host's lifetime total in
    // MEET_YOUR_HOST — is refused rather than stored as this listing's.
    if (reviewData.countSource === 'reviews-empty') {
      // A positive zero: Airbnb says outright that there are no reviews.
      fieldStatus.totalReviewCount = { status: 'extracted' };
    } else if (reviewData.totalReviewCount > 0 && reviewData.countSource === 'none') {
      track('totalReviewCount', false, 'A review count was found but not inside the listing\'s review section, so it could be the host\'s lifetime total — discarded.');
      reviewData.totalReviewCount = 0;
    } else {
      track('totalReviewCount', reviewData.totalReviewCount > 0, 'No review count was found in the listing\'s review section.');
    }

    if (reviewData.countSource === 'reviews-empty') {
      // Airbnb states there are none; an empty list is the correct answer.
      fieldStatus.reviews = { status: 'extracted' };
    } else {
      track('reviews', reviewData.reviews.length > 0, 'No individual reviews were extracted.');
    }

    // Last: a field whose section never rendered is a timeout, not a miss.
    applySectionTimeouts();

    const extractionSummary: ExtractionSummary = {
      extracted: 0,
      defaulted: 0,
      failed: 0,
      'admin-entered': 0,
      total: 0,
    };
    for (const report of Object.values(fieldStatus)) {
      extractionSummary[report.status]++;
      extractionSummary.total++;
    }

    // Build final result
    const result = {
      name: domData.title || '',
      description: domData.description || '',
      guests: guests || 0,
      bedrooms: domData.bedrooms || 0,
      beds: domData.beds || 0,
      bathrooms: domData.bathrooms || 0,
      location: domData.location || '',
      coverImage: allImages[0] || '',
      images: allImages.slice(1) || [],
      // Only a tag the form can select is passed through as listing data.
      propertyTypeTag: tagIsKnown ? domData.propertyTypeTag : 'Entire home',
      highlights: domData.highlights || [],
      amenities: topAmenities,
      offers: finalOffers,
      checkIn: checkIn || '4:00 PM',
      checkOut: checkOut || '11:00 AM',
      rules,
      petsAllowed: petsRule ?? false,
      smokingAllowed: smokingRule ?? false,
      partyAllowed: partyRule ?? false,
      averageRating: reviewData.averageRating,
      totalReviewCount: reviewData.totalReviewCount,
      reviews: reviewData.reviews,

      // Provenance, not listing data — see app/types/scrape.ts.
      fieldStatus,
      extractionSummary,
      warnings,
    };

    return apiSuccess(result);

  } catch (error) {
    // The old blanket message blamed the URL even when the cause was entirely
    // ours (Chromium failing to download, navigation timing out). Name the
    // actual cause — "check your URL" sends the operator to the wrong place.
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const lower = detail.toLowerCase();

    if (
      lower.includes('chromium') ||
      lower.includes('executablepath') ||
      lower.includes('.tar') ||
      lower.includes('enoent') ||
      lower.includes('failed to launch') ||
      lower.includes('spawn')
    ) {
      return apiFailure({
        message: 'The headless browser could not be started — the scraper could not download or launch Chromium.',
        status: 503,
        code: 'BROWSER_UNAVAILABLE',
        hint: 'This is a server-side problem, not a problem with the URL. Nothing was imported; retry, and check the server logs if it persists.',
        internalError: error,
      });
    }

    if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('navigation')) {
      return apiFailure({
        message: 'Timed out loading the Airbnb listing — the page did not finish loading within 30s.',
        status: 504,
        code: 'NAVIGATION_TIMEOUT',
        hint: 'Nothing was imported. Retry; if it keeps timing out, open the URL in a browser to check that it loads.',
        internalError: error,
      });
    }

    return apiFailure({
      message: 'Failed to scrape the Airbnb listing.',
      status: 500,
      code: 'SCRAPE_FAILED',
      hint: 'Nothing was imported. Retry; if it keeps failing, check the server logs for the underlying error.',
      internalError: error,
    });
  } finally {
    // Guaranteed cleanup — even on uncaught errors or early returns
    if (browser) {
      try { await browser.close(); } catch { /* ignore close errors */ }
    }
  }
}
