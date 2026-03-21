/**
 * In-memory sliding-window rate limiter.
 * Keyed by client IP. No external dependencies.
 *
 * Usage:
 *   const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 30 });
 *   // Inside handler:
 *   const limit = limiter.check(request);
 *   if (limit.limited) return apiRateLimited(limit.retryAfterMs);
 */

interface RateLimitConfig {
  /** Time window in milliseconds */
  windowMs: number;
  /** Maximum number of requests allowed per window */
  maxRequests: number;
}

interface RateLimitResult {
  limited: boolean;
  /** Milliseconds until the client can retry (0 if not limited) */
  retryAfterMs: number;
  /** Remaining requests in the current window */
  remaining: number;
}

interface RateLimiter {
  check: (request: Request) => RateLimitResult;
}

/**
 * Extract a stable client identifier from the request.
 * Uses standard proxy headers with fallback.
 */
function getClientIP(request: Request): string {
  // Standard forwarding headers (Vercel, Cloudflare, nginx)
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    // x-forwarded-for can be comma-separated; take the first (original client)
    return forwarded.split(',')[0].trim();
  }

  const realIp = request.headers.get('x-real-ip');
  if (realIp) return realIp.trim();

  // Vercel-specific
  const vercelIp = request.headers.get('x-vercel-forwarded-for');
  if (vercelIp) return vercelIp.split(',')[0].trim();

  return 'unknown';
}

/**
 * Create a rate limiter instance with the given config.
 * Each call creates an independent limiter with its own state.
 */
export function createRateLimiter(config: RateLimitConfig): RateLimiter {
  const { windowMs, maxRequests } = config;

  // Map<clientIP, timestamp[]>
  const hits = new Map<string, number[]>();

  // Periodic cleanup: remove stale entries every 60s to prevent memory leaks
  const cleanupInterval = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, timestamps] of hits) {
      const valid = timestamps.filter((t) => t > cutoff);
      if (valid.length === 0) {
        hits.delete(key);
      } else {
        hits.set(key, valid);
      }
    }
  }, 60_000);

  // Allow GC to clean up the interval if the limiter is dereferenced
  if (cleanupInterval.unref) {
    cleanupInterval.unref();
  }

  return {
    check(request: Request): RateLimitResult {
      const ip = getClientIP(request);
      const now = Date.now();
      const windowStart = now - windowMs;

      // Get existing timestamps, filter to current window
      const existing = (hits.get(ip) || []).filter((t) => t > windowStart);

      if (existing.length >= maxRequests) {
        // Calculate when the oldest hit in the window expires
        const oldestInWindow = existing[0];
        const retryAfterMs = oldestInWindow + windowMs - now;

        return {
          limited: true,
          retryAfterMs: Math.max(retryAfterMs, 1000),
          remaining: 0,
        };
      }

      // Record this hit
      existing.push(now);
      hits.set(ip, existing);

      return {
        limited: false,
        retryAfterMs: 0,
        remaining: maxRequests - existing.length,
      };
    },
  };
}
