/**
 * Shared HTTP client for external public data APIs.
 * Used by entity intelligence, regulatory decisions, and ASX tools.
 */

const DEFAULT_TIMEOUT_MS = 15_000;
const USER_AGENT = 'cp-legal-mcp/1.0 (legal research; https://example.com)';

// Retry configuration — 2 retries on transient failures, 1 s then 2 s delay.
// Only retries on status codes that indicate server-side transient errors.
const RETRY_DELAYS_MS = [1_000, 2_000];
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export class ExternalApiError extends Error {
  constructor(
    public readonly service: string,
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'ExternalApiError';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function externalFetch(
  url: string,
  options?: RequestInit & { timeoutMs?: number },
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = options ?? {};

  const headers = {
    'User-Agent': USER_AGENT,
    Accept: 'application/json, text/html, */*',
    ...((rest.headers as Record<string, string>) ?? {}),
  };

  let lastErr: unknown;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    const signal = AbortSignal.timeout(timeoutMs);

    try {
      const response = await fetch(url, { ...rest, signal, headers });

      // On retryable status codes, wait and retry (except on final attempt)
      if (RETRYABLE_STATUS.has(response.status) && attempt < RETRY_DELAYS_MS.length) {
        // Respect Retry-After header if present (e.g. for 429)
        const retryAfter = response.headers.get('Retry-After');
        const waitMs = retryAfter
          ? Math.min(parseInt(retryAfter, 10) * 1_000, 10_000)
          : RETRY_DELAYS_MS[attempt]!;
        await delay(waitMs);
        continue;
      }

      return response;
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        lastErr = new ExternalApiError('external', `Request timed out after ${timeoutMs}ms: ${url}`);
        // Timeouts are retryable
        if (attempt < RETRY_DELAYS_MS.length) {
          await delay(RETRY_DELAYS_MS[attempt]!);
          continue;
        }
        throw lastErr;
      }
      // Non-timeout errors (DNS, connection refused) — retry on network errors
      lastErr = err;
      if (attempt < RETRY_DELAYS_MS.length) {
        await delay(RETRY_DELAYS_MS[attempt]!);
        continue;
      }
      throw err;
    }
  }

  // Should be unreachable, but TypeScript requires a return
  throw lastErr ?? new ExternalApiError('external', `All retry attempts failed: ${url}`);
}

/** Strip HTML tags and decode common entities. */
export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, ' ')
    .trim();
}
