import { createRateLimiter } from '@/app/lib/api/rate-limit';
import { validateGoogleMapsUrl } from '@/app/lib/api/validate';
import { guardedFetch, GuardedFetchError } from '@/app/lib/api/url-guard';
import { apiSuccess, apiError, apiRateLimited } from '@/app/lib/api/safe-response';

// 20 requests per minute per IP
const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 20 });

export async function POST(request: Request) {
  // ── Rate limit ───────────────────────────────────────────
  const limit = await limiter.check(request);
  if (limit.limited) return apiRateLimited(limit.retryAfterMs);

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
    const urlCheck = validateGoogleMapsUrl(url);
    if (!urlCheck.valid) return apiError(urlCheck.error!, 400);

    const validatedUrl = urlCheck.value!;

    // ============================================================
    // STEP 1: Extract coordinates from the Google Maps URL
    // Supports multiple URL formats:
    //   - https://maps.google.com/.../@43.8561,-79.3193,17z
    //   - https://www.google.com/maps/place/.../@43.8561,-79.3193,17z
    //   - https://goo.gl/maps/... (short links — we'll follow redirects)
    //   - https://maps.app.goo.gl/... (new short links)
    //   - ?ll=43.8561,-79.3193
    //   - ?q=43.8561,-79.3193
    // ============================================================
    let lat: number | null = null;
    let lng: number | null = null;
    let resolvedUrl = validatedUrl;

    // Follow redirects for short URLs (goo.gl, maps.app.goo.gl)
    if (validatedUrl.includes('goo.gl') || validatedUrl.includes('maps.app')) {
      try {
        const response = await guardedFetch(validatedUrl, {
          timeoutMs: 10_000,
          redirect: 'follow',
        });
        resolvedUrl = response.url;
      } catch (err) {
        if (err instanceof GuardedFetchError) {
          return apiError(err.message, 400);
        }
        // If redirect fails, try parsing the original URL
      }
    }

    // Pattern 1: @lat,lng in the URL path (most common)
    const atPattern = /@(-?\d+\.?\d*),(-?\d+\.?\d*)/;
    const atMatch = resolvedUrl.match(atPattern);
    if (atMatch) {
      lat = parseFloat(atMatch[1]);
      lng = parseFloat(atMatch[2]);
    }

    // Pattern 2: ll= query parameter
    if (!lat || !lng) {
      const llPattern = /[?&]ll=(-?\d+\.?\d*),(-?\d+\.?\d*)/;
      const llMatch = resolvedUrl.match(llPattern);
      if (llMatch) {
        lat = parseFloat(llMatch[1]);
        lng = parseFloat(llMatch[2]);
      }
    }

    // Pattern 3: q= query parameter with coordinates
    if (!lat || !lng) {
      const qPattern = /[?&]q=(-?\d+\.?\d*),(-?\d+\.?\d*)/;
      const qMatch = resolvedUrl.match(qPattern);
      if (qMatch) {
        lat = parseFloat(qMatch[1]);
        lng = parseFloat(qMatch[2]);
      }
    }

    // Pattern 4: /dir/ or /data= with coordinates embedded
    if (!lat || !lng) {
      const dataPattern = /!3d(-?\d+\.?\d*)!4d(-?\d+\.?\d*)/;
      const dataMatch = resolvedUrl.match(dataPattern);
      if (dataMatch) {
        lat = parseFloat(dataMatch[1]);
        lng = parseFloat(dataMatch[2]);
      }
    }

    if (!lat || !lng) {
      return apiError(
        'Could not extract coordinates from the provided Google Maps URL. Make sure it contains location data (e.g., has @lat,lng in the URL).',
        400,
      );
    }

    // Validate coordinates are within valid ranges
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return apiError('Invalid coordinates extracted from URL.', 400);
    }

    // ============================================================
    // STEP 2: Reverse geocode using OpenStreetMap Nominatim (free, no API key)
    // ============================================================
    let city = '';
    let state = '';
    let area = '';
    let country = '';
    let displayName = '';

    try {
      const nominatimUrl = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`;
      const geoResponse = await guardedFetch(nominatimUrl, {
        timeoutMs: 10_000,
        headers: {
          'User-Agent': 'Nubnb Property Manager/1.0',
          'Accept-Language': 'en',
        },
      });

      if (geoResponse.ok) {
        const geoData = await geoResponse.json();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const addr = (geoData as any).address || {};

        // City: try city, then town, then village, then municipality
        city = addr.city || addr.town || addr.village || addr.municipality || addr.hamlet || '';

        // State: province or state
        state = addr.state || addr.province || addr.region || '';
        // Use state code if available (e.g., "ON" instead of "Ontario")
        if (addr.state && addr['ISO3166-2-lvl4']) {
          const stateCode = addr['ISO3166-2-lvl4'].split('-').pop();
          if (stateCode && stateCode.length <= 3) {
            state = stateCode;
          }
        }

        // Area: suburb, neighbourhood, or county
        area = addr.suburb || addr.neighbourhood || addr.quarter || addr.county || '';
        // Clean up area — remove "Regional Municipality of" etc.
        area = area.replace(/^(Regional Municipality of |Municipality of |City of |Town of )/i, '');

        // Country
        country = addr.country || '';

        // Display name for the location field
        displayName = (geoData as { display_name?: string }).display_name || '';
      }
    } catch (geoError) {
      // Non-fatal — we still have coordinates
      console.error('Reverse geocoding error:', geoError);
    }

    // Build a clean location string
    const locationParts = [city, state].filter(Boolean);
    const location = locationParts.join(', ') || displayName || `${lat}, ${lng}`;

    return apiSuccess({
      coordinates: [lng, lat], // [lng, lat] format matching the Property interface
      addressDetails: {
        city,
        state,
        area,
        country,
      },
      location,
      lat,
      lng,
    });

  } catch (error) {
    return apiError('Failed to parse the Google Maps URL.', 500, error);
  }
}
