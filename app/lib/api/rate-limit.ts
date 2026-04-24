/**
 * Distributed rate limiter backed by Upstash Redis.
 *
 * Works correctly across Vercel serverless cold starts — no in-memory
 * state that resets between invocations.
 *
 * Falls back to a permissive pass-through if Upstash env vars are
 * not configured (local dev / CI), logging a warning on first use.
 *
 * Usage:
 *   const limiter = createRateLimiter({ maxRequests: 3, windowMs: 5 * 60_000 });
 *   // Inside handler:
 *   const limit = await limiter.check(request);
 *   if (limit.limited) return apiRateLimited(limit.retryAfterMs);
 */

import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

interface RateLimitConfig {
  /** Maximum number of requests allowed per window */
  maxRequests: number;
  /** Time window in milliseconds */
  windowMs: number;
  /** Optional prefix to namespace rate limit keys */
  prefix?: string;
}

interface RateLimitResult {
  limited: boolean;
  /** Milliseconds until the client can retry (0 if not limited) */
  retryAfterMs: number;
  /** Remaining requests in the current window */
  remaining: number;
}

interface RateLimiter {
  check: (request: Request) => Promise<RateLimitResult>;
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

let warnedMissingConfig = false;

/**
 * Create a rate limiter instance backed by Upstash Redis.
 * Each call creates an independent limiter with its own prefix/config.
 */
export function createRateLimiter(config: RateLimitConfig): RateLimiter {
  const { maxRequests, windowMs, prefix = 'rl' } = config;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  // If Upstash is not configured, return a permissive pass-through
  if (!url || !token) {
    if (!warnedMissingConfig) {
      console.warn(
        '[rate-limit] UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not configured. ' +
        'Rate limiting is disabled. Set these env vars for production.',
      );
      warnedMissingConfig = true;
    }

    return {
      async check(): Promise<RateLimitResult> {
        return { limited: false, retryAfterMs: 0, remaining: maxRequests };
      },
    };
  }

  const redis = new Redis({ url, token });
  const windowSeconds = Math.ceil(windowMs / 1000);

  const ratelimit = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(maxRequests, `${windowSeconds} s`),
    prefix: `@nubnb/${prefix}`,
    analytics: false,
  });

  return {
    async check(request: Request): Promise<RateLimitResult> {
      const ip = getClientIP(request);

      const { success, remaining, reset } = await ratelimit.limit(ip);

      if (success) {
        return { limited: false, retryAfterMs: 0, remaining };
      }

      const retryAfterMs = Math.max(reset - Date.now(), 1000);
      return { limited: true, retryAfterMs, remaining: 0 };
    },
  };
}
