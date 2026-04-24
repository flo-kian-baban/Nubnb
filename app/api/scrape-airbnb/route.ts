import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium-min';
import { findBestIcons } from '@/app/data/amenityIcons';
import { createRateLimiter } from '@/app/lib/api/rate-limit';
import { validateAirbnbUrl } from '@/app/lib/api/validate';
import { verifyAdminSession } from '@/app/lib/api/verify-admin';
import { apiSuccess, apiError, apiRateLimited } from '@/app/lib/api/safe-response';

export const maxDuration = 120;

// 3 requests per 5 minutes per IP — scraping is expensive
const limiter = createRateLimiter({ windowMs: 5 * 60_000, maxRequests: 3 });

// GitHub-hosted Chromium binary for @sparticuz/chromium-min (downloaded at runtime)
const CHROMIUM_PACK_URL =
  'https://github.com/Sparticuz/chromium/releases/download/v143.0.4/chromium-v143.0.4-pack.x64.tar';

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

    await page.goto(urlCheck.value!, { waitUntil: 'networkidle2', timeout: 30000 });

    // Dismiss cookie/translation banners
    try {
      await page.evaluate(() => {
        // Cookie banner
        const cookieBtn = document.querySelector('button[data-testid="accept-btn"]') as HTMLButtonElement;
        if (cookieBtn) cookieBtn.click();
        // Translation popups - remove them
        document.querySelectorAll('[data-testid="translation-announce-modal"]').forEach(el => el.remove());
      });
      await new Promise(r => setTimeout(r, 1500));
    } catch { /* ignore */ }

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
          await new Promise(r => setTimeout(r, 2500));
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
      const getText = (sel: string) => document.querySelector(sel)?.textContent?.trim() || '';

      // Title
      const title = document.querySelector('h1')?.textContent?.trim() || '';

      // Property type tag
      let propertyTypeTag = '';
      const overviewHeading = document.querySelector('[data-section-id="OVERVIEW_DEFAULT"] h2');
      if (overviewHeading) {
        const text = overviewHeading.textContent?.trim() || '';
        const match = text.match(/^(Entire\s+\w+|Private\s+\w+|Shared\s+\w+|Room\s+\w+)/i);
        propertyTypeTag = match ? match[1].trim() : (text.split(' in ')[0]?.trim() || '');
      }

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
      // Strategy 1: Standard overview selectors (li elements)
      document.querySelectorAll('ol li, [data-section-id="OVERVIEW_DEFAULT"] li, [data-section-id="OVERVIEW_DEFAULT"] span, [data-section-id="OVERVIEW_DEFAULT"] div').forEach(el => {
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
        const overviewSection = document.querySelector('[data-section-id="OVERVIEW_DEFAULT"]');
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

      // Location
      const location = getText('[data-section-id="LOCATION_DEFAULT"] span') || '';

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

      // Check-in/Check-out
      let checkIn = '', checkOut = '';
      document.querySelectorAll('[data-section-id="POLICIES_DEFAULT"] li, [data-section-id="POLICIES_DEFAULT"] div').forEach(el => {
        const text = (el.textContent || '').trim().toLowerCase();
        if (text.includes('check-in') && text.includes('after')) {
          const match = text.match(/after\s+([\d:]+\s*(am|pm)?)/i);
          if (match) checkIn = match[1].trim();
        }
        if (text.includes('checkout') && text.includes('before')) {
          const match = text.match(/before\s+([\d:]+\s*(am|pm)?)/i);
          if (match) checkOut = match[1].trim();
        }
      });

      // House Rules
      const rules: string[] = [];
      let petsAllowed = false, smokingAllowed = false, partyAllowed = false;
      document.querySelectorAll('[data-section-id="POLICIES_DEFAULT"] li').forEach(el => {
        const text = (el.textContent || '').trim();
        if (text && text.length > 3 && !text.toLowerCase().includes('show more')) {
          rules.push(text);
          const lower = text.toLowerCase();
          if (lower.includes('pets allowed') || lower.includes('pet friendly')) petsAllowed = true;
          if (lower.includes('smoking allowed')) smokingAllowed = true;
          if (lower.includes('events allowed') || lower.includes('parties allowed')) partyAllowed = true;
        }
      });

      // Price
      let price = 0;
      const priceEl = document.querySelector('[data-testid="book-it-default"] span, ._1y74zjx span');
      if (priceEl) {
        const priceMatch = (priceEl.textContent || '').replace(/[, ]/g, '').match(/\$(\d+)/);
        if (priceMatch) price = parseInt(priceMatch[1]);
      }
      if (!price) {
        document.querySelectorAll('span').forEach(span => {
          const text = span.textContent || '';
          if (text.match(/^\$[\d,]+$/) && !price) {
            price = parseInt(text.replace(/[$,]/g, ''));
          }
        });
      }

      return {
        title, description, guests, bedrooms, beds, bathrooms,
        location, images, highlights, propertyTypeTag,
        checkIn, checkOut, rules, petsAllowed, smokingAllowed, partyAllowed, price,
      };
    });

    // ============================================================
    // PHOTO TOUR: Scrape additional images from the photo tour modal
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
      await new Promise(r => setTimeout(r, 4000));

      // Dismiss any popups on the photo tour page
      try {
        await page.evaluate(() => {
          const cookieBtn = document.querySelector('button[data-testid="accept-btn"]') as HTMLButtonElement;
          if (cookieBtn) cookieBtn.click();
          document.querySelectorAll('[data-testid="translation-announce-modal"]').forEach(el => el.remove());
        });
        await new Promise(r => setTimeout(r, 1000));
      } catch { /* ignore */ }

      // Scroll the photo tour modal thoroughly — 3 passes
      // The photo tour dialog has a scrollable child div that we need to target specifically
      for (let pass = 0; pass < 3; pass++) {
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

          // On subsequent passes, scroll back to top first
          if (passNum > 0) {
            el.scrollTop = 0;
            await new Promise(r => setTimeout(r, 1500));
          }

          // Scroll in smaller increments to trigger all lazy loaders
          const scrollStep = 400;
          const maxScrolls = 120;
          let prevScrollTop = -1;
          let stuckCount = 0;

          for (let i = 0; i < maxScrolls; i++) {
            el.scrollTop += scrollStep;
            await new Promise(r => setTimeout(r, 500));

            // Check if we're actually moving
            if (el.scrollTop === prevScrollTop) {
              stuckCount++;
              if (stuckCount >= 5) break; // truly at the bottom
            } else {
              stuckCount = 0;
            }
            prevScrollTop = el.scrollTop;
          }

          // Final: ensure we're at absolute bottom
          el.scrollTop = el.scrollHeight;
          await new Promise(r => setTimeout(r, 1500));
        }, pass);

        // Wait between passes for images to finish loading
        await new Promise(r => setTimeout(r, 2500));
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
    // ============================================================
    let reviewData: {
      averageRating: number;
      totalReviewCount: number;
      reviews: { reviewer: string; date: string; rating: number; text: string; avatar: string }[];
    } = { averageRating: 0, totalReviewCount: 0, reviews: [] };

    try {
      // Step 1: Extract rating, count, AND individual reviews from embedded JSON
      const scriptReviewData = await page.evaluate(() => {
        let rating = 0;
        let count = 0;
        const reviews: { reviewer: string; date: string; rating: number; text: string; avatar: string }[] = [];

        const scripts = document.querySelectorAll('script');
        for (const script of scripts) {
          const text = script.textContent || '';
          if (text.length < 500) continue;

          // Extract rating
          if (!rating) {
            const ratingMatch = text.match(/"overallRating"\s*:\s*([\d.]+)/);
            if (ratingMatch) rating = parseFloat(ratingMatch[1]);
          }

          // Extract count
          if (!count) {
            const countMatch = text.match(/"reviewsCount"\s*:\s*(\d+)/)
              || text.match(/"visibleReviewCount"\s*:\s*(\d+)/)
              || text.match(/"reviewCount"\s*:\s*(\d+)/);
            if (countMatch) count = parseInt(countMatch[1]);
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

        // Fallback: DOM-based rating extraction
        if (!rating) {
          const ratingEl = document.querySelector('[data-testid="pdp-reviews-highlight-banner-host-rating"]');
          if (ratingEl) {
            const m = (ratingEl.textContent || '').match(/([\d.]+)/);
            if (m) rating = parseFloat(m[1]);
          }
        }
        if (!count) {
          const reviewLinks = document.querySelectorAll('a, button, span');
          for (const el of reviewLinks) {
            const m = (el.textContent || '').match(/(\d+)\s+reviews?/i);
            if (m) { count = parseInt(m[1]); break; }
          }
        }

        return { rating, count, reviews };
      });

      reviewData.averageRating = scriptReviewData.rating;
      reviewData.totalReviewCount = scriptReviewData.count;
      reviewData.reviews = scriptReviewData.reviews;

      // Step 2: If no reviews from JSON, try scraping visible reviews from the page
      if (reviewData.reviews.length === 0) {
        const extractedReviews = await page.evaluate(() => {
          const reviews: { reviewer: string; date: string; rating: number; text: string; avatar: string }[] = [];
          
          const reviewSection = document.querySelector('[data-section-id="REVIEWS_DEFAULT"]')
            || document.querySelector('[data-section-id="GUEST_REVIEWS"]');
          if (!reviewSection) return reviews;

          const headings = reviewSection.querySelectorAll('h2, h3');
          
          for (const heading of headings) {
            const name = heading.textContent?.trim() || '';
            if (!name || name.length > 40 || name.length < 2) continue;
            if (/review|rating|guest|overall|clear|star|average/i.test(name)) continue;

            // Walk UP parent levels to find container with actual review text
            let block: Element | null = null;
            let cursor: Element | null = heading;
            for (let level = 0; level < 8 && cursor; level++) {
              cursor = cursor.parentElement;
              if (!cursor || cursor === reviewSection) break;
              const textLen = (cursor.textContent || '').length;
              if (textLen > name.length + 100 && textLen < 3000) {
                block = cursor;
                break;
              }
            }
            if (!block) continue;

            // Extract date - match multiple formats
            let date = '';
            const allEls = block.querySelectorAll('span, div');
            for (const el of allEls) {
              const t = (el.textContent?.trim() || '');
              // "March 2025", "January 2024" etc.
              if (/^(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}$/i.test(t)) {
                date = t; break;
              }
              // "2 weeks ago", "3 months ago", "1 year ago"
              if (/^\d+\s+(week|month|year|day)s?\s+ago$/i.test(t)) {
                date = t; break;
              }
              // "Mar 2025"
              if (/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{4}$/i.test(t)) {
                date = t; break;
              }
            }

            // Extract review text - find the longest text not matching metadata patterns
            let text = '';
            for (const el of allEls) {
              const t = (el.textContent?.trim() || '');
              if (t === name || t === date) continue;
              if (t.length < 20) continue;
              // Skip metadata like "3 years on Airbnb", "Montreal, Canada", section titles
              if (/^\d+\s+(year|month|week|day)s?\s+on\s+airbnb/i.test(t)) continue;
              if (/^[A-Z][a-z]+,\s+[A-Z][a-z]+$/i.test(t) && t.length < 40) continue;
              if (t.startsWith(name)) continue;
              if (t.length > text.length) {
                text = t;
              }
            }
            if (!text || text.length < 20) continue;

            // Extract rating
            let reviewRating = 5;
            const ratingEl = block.querySelector('[aria-label*="star"], [role="img"][aria-label]');
            if (ratingEl) {
              const m = (ratingEl.getAttribute('aria-label') || '').match(/(\d+)/);
              if (m) reviewRating = parseInt(m[1]);
            }

            // Extract avatar
            let avatar = '';
            const img = block.querySelector('img') as HTMLImageElement;
            if (img && img.src && !img.src.startsWith('data:')) avatar = img.src;

            if (!reviews.find(r => r.reviewer === name)) {
              reviews.push({ reviewer: name, date, rating: reviewRating, text, avatar });
            }
          }
          return reviews;
        });

        if (extractedReviews.length > 0) {
          reviewData.reviews = extractedReviews;
        }
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
            await new Promise(r => setTimeout(r, 3000));

            const modalReviews = await page.evaluate(() => {
              const reviews: { reviewer: string; date: string; rating: number; text: string; avatar: string }[] = [];
              const modal = document.querySelector('[role="dialog"]');
              if (!modal) return reviews;

              const headings = modal.querySelectorAll('h2, h3');
              for (const heading of headings) {
                const name = heading.textContent?.trim() || '';
                if (!name || name.length > 40 || name.length < 2) continue;
                if (/review|rating|guest|overall|search|filter|clear|categor|average/i.test(name)) continue;

                let block: Element | null = null;
                let cursor: Element | null = heading;
                for (let level = 0; level < 8 && cursor; level++) {
                  cursor = cursor.parentElement;
                  if (!cursor || cursor === modal) break;
                  const textLen = (cursor.textContent || '').length;
                  if (textLen > name.length + 100 && textLen < 5000) {
                    block = cursor;
                    break;
                  }
                }
                if (!block) continue;

                let date = '';
                let text = '';
                let reviewRating = 5;
                let avatar = '';

                const spans = block.querySelectorAll('span, div, p');
                for (const el of spans) {
                  const t = (el.textContent?.trim() || '');
                  if (!date && /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}$/i.test(t)) {
                    date = t;
                  }
                  if (t === name || t === date) continue;
                  if (t.length < 20) continue;
                  if (/^\d+\s+(year|month|week|day)s?\s+on\s+airbnb/i.test(t)) continue;
                  if (/^[A-Z][a-z]+,\s+[A-Z][a-z]+$/i.test(t) && t.length < 40) continue;
                  if (t.startsWith(name)) continue;
                  if (t.length > text.length) text = t;
                }
                if (!text) continue;

                const ratingEl = block.querySelector('[aria-label*="star"]');
                if (ratingEl) {
                  const m = (ratingEl.getAttribute('aria-label') || '').match(/(\d+)/);
                  if (m) reviewRating = parseInt(m[1]);
                }

                const img = block.querySelector('img') as HTMLImageElement;
                if (img && img.src && !img.src.startsWith('data:')) avatar = img.src;

                if (!reviews.find(r => r.reviewer === name)) {
                  reviews.push({ reviewer: name, date, rating: reviewRating, text, avatar });
                }
              }
              return reviews;
            });

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
        }
      }

      // Cap at 10 reviews
      reviewData.reviews = reviewData.reviews.slice(0, 10);

    } catch (reviewErr) {
      console.error('Review scraping error (non-fatal):', reviewErr);
    }

    // Build final result
    const result = {
      name: domData.title || '',
      description: domData.description || '',
      guests: domData.guests || 0,
      bedrooms: domData.bedrooms || 0,
      beds: domData.beds || 0,
      bathrooms: domData.bathrooms || 0,
      location: domData.location || '',
      coverImage: allImages[0] || '',
      images: allImages.slice(1) || [],
      propertyTypeTag: domData.propertyTypeTag || 'Entire home',
      highlights: domData.highlights || [],
      amenities: topAmenities,
      offers: finalOffers,
      checkIn: domData.checkIn || '4:00 PM',
      checkOut: domData.checkOut || '11:00 AM',
      rules: domData.rules || [],
      petsAllowed: domData.petsAllowed,
      smokingAllowed: domData.smokingAllowed,
      partyAllowed: domData.partyAllowed,
      price: domData.price || 0,
      averageRating: reviewData.averageRating,
      totalReviewCount: reviewData.totalReviewCount,
      reviews: reviewData.reviews,
    };

    return apiSuccess(result);

  } catch (error) {
    return apiError(
      'Failed to scrape the Airbnb listing. Make sure the URL is valid and the page is accessible.',
      500,
      error,
    );
  } finally {
    // Guaranteed cleanup — even on uncaught errors or early returns
    if (browser) {
      try { await browser.close(); } catch { /* ignore close errors */ }
    }
  }
}
