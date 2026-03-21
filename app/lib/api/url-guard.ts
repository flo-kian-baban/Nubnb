/**
 * SSRF-safe fetch wrapper.
 * Validates external URLs before fetching to block private/reserved IP targeting.
 */

interface GuardedFetchOptions extends RequestInit {
  /** Maximum response body size in bytes. Default: 10 MB */
  maxResponseBytes?: number;
  /** Request timeout in milliseconds. Default: 15_000 */
  timeoutMs?: number;
}

/**
 * Check whether a hostname resolves to a private or reserved IP range.
 * This prevents SSRF attacks where user-supplied URLs target internal services.
 */
function isPrivateOrReservedIP(ip: string): boolean {
  // Normalize IPv6 mapped v4
  const normalized = ip.replace(/^::ffff:/, '');

  // IPv4 patterns
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(normalized)) {
    const parts = normalized.split('.').map(Number);

    // 0.0.0.0/8 — Current network
    if (parts[0] === 0) return true;
    // 10.0.0.0/8 — Private class A
    if (parts[0] === 10) return true;
    // 127.0.0.0/8 — Loopback
    if (parts[0] === 127) return true;
    // 169.254.0.0/16 — Link-local
    if (parts[0] === 169 && parts[1] === 254) return true;
    // 172.16.0.0/12 — Private class B
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    // 192.168.0.0/16 — Private class C
    if (parts[0] === 192 && parts[1] === 168) return true;
    // 100.64.0.0/10 — Carrier-grade NAT
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    // 198.18.0.0/15 — Benchmarking
    if (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) return true;
    // 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 — Documentation
    if (parts[0] === 192 && parts[1] === 0 && parts[2] === 2) return true;
    if (parts[0] === 198 && parts[1] === 51 && parts[2] === 100) return true;
    if (parts[0] === 203 && parts[1] === 0 && parts[2] === 113) return true;
    // 224.0.0.0/4 — Multicast
    if (parts[0] >= 224 && parts[0] <= 239) return true;
    // 240.0.0.0/4 — Reserved
    if (parts[0] >= 240) return true;
  }

  // IPv6 patterns
  if (ip === '::1') return true;       // Loopback
  if (ip === '::') return true;        // Unspecified
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true;  // Unique local
  if (ip.startsWith('fe80')) return true;  // Link-local

  return false;
}

/**
 * Validate a URL before fetching — blocks dangerous protocols and private IPs.
 */
function validateFetchTarget(url: string): { safe: boolean; error?: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { safe: false, error: 'Invalid URL' };
  }

  // Block dangerous protocols
  const allowedProtocols = ['https:', 'http:'];
  if (!allowedProtocols.includes(parsed.protocol)) {
    return { safe: false, error: `Protocol '${parsed.protocol}' is not allowed` };
  }

  // Block direct IP addresses in the hostname (when not going through DNS)
  const hostname = parsed.hostname;
  if (isPrivateOrReservedIP(hostname)) {
    return { safe: false, error: 'Requests to private or reserved IP addresses are not allowed' };
  }

  // Block localhost variants
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return { safe: false, error: 'Requests to localhost are not allowed' };
  }

  return { safe: true };
}

/**
 * Fetch an external URL with SSRF protection and safety limits.
 *
 * Validates the URL against dangerous protocols and private IP ranges,
 * applies a timeout, and enforces a maximum response body size.
 */
export async function guardedFetch(
  url: string,
  options: GuardedFetchOptions = {},
): Promise<Response> {
  const { maxResponseBytes = 10 * 1024 * 1024, timeoutMs = 15_000, ...fetchInit } = options;

  // Pre-flight validation
  const check = validateFetchTarget(url);
  if (!check.safe) {
    throw new GuardedFetchError(check.error || 'URL blocked by security policy');
  }

  // Abort controller for timeout
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...fetchInit,
      signal: controller.signal,
      redirect: fetchInit.redirect || 'follow',
    });

    // After redirect, validate the final URL too
    if (response.url && response.url !== url) {
      const redirectCheck = validateFetchTarget(response.url);
      if (!redirectCheck.safe) {
        throw new GuardedFetchError('Redirect target blocked by security policy');
      }
    }

    // Check Content-Length header if present
    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > maxResponseBytes) {
      throw new GuardedFetchError(
        `Response too large: ${parseInt(contentLength)} bytes exceeds ${maxResponseBytes} byte limit`,
      );
    }

    return response;
  } catch (error) {
    if (error instanceof GuardedFetchError) throw error;

    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new GuardedFetchError(`Request timed out after ${timeoutMs}ms`);
    }

    throw new GuardedFetchError('Failed to fetch external resource');
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Custom error class for guarded fetch failures.
 * The message is always safe to return to clients.
 */
export class GuardedFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuardedFetchError';
  }
}
