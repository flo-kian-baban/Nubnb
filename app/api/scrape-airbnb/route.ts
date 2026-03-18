import { NextResponse } from 'next/server';
import puppeteer from 'puppeteer';

export const maxDuration = 60;

export async function POST(request: Request) {
  let browser;
  try {
    const { url } = await request.json();

    if (!url || !url.includes('airbnb')) {
      return NextResponse.json({ error: 'Please provide a valid Airbnb URL' }, { status: 400 });
    }

    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const page = await browser.newPage();
    
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

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
    // STRATEGY 2: Fallback — Open modal and extract from H2 + li
    // ============================================================
    let modalOffers: { name: string; category: string; available: boolean }[] = [];

    if (scriptData.amenities.length === 0) {
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
        const offers: { name: string; category: string; available: boolean }[] = [];
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
            if (cleanName && !offers.find(o => o.name === cleanName)) {
              offers.push({ name: cleanName, category: currentCategory, available: !isUnavailable });
            }
          }
        });

        return offers;
      });
    }

    // Build final offers array
    const finalOffers = scriptData.amenities.length > 0
      ? scriptData.amenities.map(a => ({
          name: a.title,
          category: a.category || 'General',
          available: a.available,
        }))
      : modalOffers;

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

      // Description
      let description = '';
      const descSection = document.querySelector('[data-section-id="DESCRIPTION_DEFAULT"] span span');
      if (descSection) description = descSection.textContent?.trim() || '';

      // Capacity
      const overviewItems: string[] = [];
      document.querySelectorAll('ol li, [data-section-id="OVERVIEW_DEFAULT"] li').forEach(li => {
        const text = li.textContent?.trim();
        if (text) overviewItems.push(text);
      });

      let guests = 0, bedrooms = 0, bathrooms = 0;
      for (const item of overviewItems) {
        const lower = item.toLowerCase();
        const gMatch = lower.match(/(\d+)\s*guest/);
        const bedMatch = lower.match(/(\d+)\s*bedroom/);
        const bathMatch = lower.match(/([\d.]+)\s*bath/);
        if (gMatch) guests = parseInt(gMatch[1]);
        if (bedMatch) bedrooms = parseInt(bedMatch[1]);
        if (bathMatch) bathrooms = parseFloat(bathMatch[1]);
      }

      // Highlights — look in script data first, then DOM
      const highlights: string[] = [];
      // Try to extract from Airbnb's script data
      const scripts = document.querySelectorAll('script');
      for (const script of scripts) {
        const text = script.textContent || '';
        // Look for "listingHighlights" or "highlights" in the data
        const hlMatch = text.match(/"highlights?"\s*:\s*\[([\s\S]*?)\]/);
        if (hlMatch) {
          try {
            const items = JSON.parse('[' + hlMatch[1] + ']');
            for (const item of items) {
              if (typeof item === 'object' && item.title && highlights.length < 3) {
                highlights.push(item.title);
              } else if (typeof item === 'string' && highlights.length < 3) {
                highlights.push(item);
              }
            }
          } catch { /* ignore */ }
          if (highlights.length > 0) break;
        }
      }

      // Location
      const location = getText('[data-section-id="LOCATION_DEFAULT"] span') || '';

      // Images
      const images: string[] = [];
      document.querySelectorAll('img').forEach(img => {
        const src = img.src || img.getAttribute('data-original-uri') || '';
        if (!src || !src.includes('muscache.com')) return;
        const cls = img.className || '';
        if (cls.includes('i10eokyx')) return;
        const urlWidthMatch = src.match(/im_w=(\d+)/);
        if (urlWidthMatch && parseInt(urlWidthMatch[1]) < 400) return;
        const parentSection = img.closest('[data-section-id="HOST_OVERVIEW_DEFAULT"], [data-section-id="HOST_PROFILE_DEFAULT"]');
        if (parentSection) return;
        const renderedW = img.getBoundingClientRect().width;
        const renderedH = img.getBoundingClientRect().height;
        if (renderedW > 0 && renderedW < 150) return;
        if (renderedH > 0 && renderedH < 150) return;
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
        title, description, guests, bedrooms, bathrooms,
        location, images, highlights, propertyTypeTag,
        checkIn, checkOut, rules, petsAllowed, smokingAllowed, partyAllowed, price,
      };
    });

    // Build final result
    const result = {
      name: domData.title || '',
      description: domData.description || '',
      guests: domData.guests || 0,
      bedrooms: domData.bedrooms || 0,
      bathrooms: domData.bathrooms || 0,
      location: domData.location || '',
      coverImage: domData.images[0] || '',
      images: domData.images.slice(1) || [],
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
    };

    await browser.close();
    return NextResponse.json(result);

  } catch (error) {
    console.error('Scraping error:', error);
    if (browser) await browser.close();
    return NextResponse.json(
      { error: 'Failed to scrape the Airbnb listing. Make sure the URL is valid and the page is accessible.' },
      { status: 500 }
    );
  }
}
