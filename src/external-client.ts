/**
 * Shared HTTP client for external public data APIs.
 * Used by entity intelligence, regulatory decisions, and ASX tools.
 */

const DEFAULT_TIMEOUT_MS = 15_000;
const USER_AGENT = 'cp-legal-mcp/1.0 (legal research; https://example.com)';

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

export async function externalFetch(
  url: string,
  options?: RequestInit & { timeoutMs?: number },
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = options ?? {};
  const signal = AbortSignal.timeout(timeoutMs);

  try {
    const response = await fetch(url, {
      ...rest,
      signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json, text/html, */*',
        ...((rest.headers as Record<string, string>) ?? {}),
      },
    });
    return response;
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new ExternalApiError('external', `Request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw err;
  }
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
