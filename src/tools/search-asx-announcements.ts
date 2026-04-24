import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool, matterRefSchema } from './_shared.js';
import { externalFetch, ExternalApiError } from '../external-client.js';
import { logger } from '../logger.js';
import { recordMatterQuery } from '../matter-log.js';

// ASX retired the legacy /asx/1/company/{code}/announcements JSON endpoint.
// Their markets site (www.asx.com.au/markets/company/*) now reads from the
// Markit Digital "asx-research" API — the same endpoint the public ASX SPA
// hits. No auth required; responses are `{ data: { items: [...] } }`.
const ASX_API_BASE = 'https://asx.api.markitdigital.com/asx-research/1.0/companies';
const ASX_FILE_BASE = 'https://asx.api.markitdigital.com/asx-research/1.0/file';

const inputSchema = z.object({
  asx_code: z
    .string()
    .min(2)
    .max(6)
    .describe('ASX ticker code for the company (e.g. "CBA", "BHP", "RIO")'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(20)
    .describe('Maximum number of announcements to return'),
  market_sensitive_only: z
    .boolean()
    .default(false)
    .describe('If true, return only market-sensitive announcements'),
  filter_text: z
    .string()
    .max(200)
    .optional()
    .describe('Filter announcements by headline text (case-insensitive substring match)'),
  matter_ref: matterRefSchema,
});

interface AsxAnnouncement {
  id: string;
  date: string;
  headline: string;
  market_sensitive: boolean;
  pages: number | null;
  url: string;
}

export function registerSearchAsxAnnouncements(server: McpServer): void {
  registerTool(
    server,
    'search_asx_announcements',
    {
      title: 'Search ASX announcements',
      description: '[Market Intelligence] Search ASX company announcements for a given ASX ticker code. Returns recent announcements with headlines, dates, and PDF URLs. Use for listed entity research, material information tracking, and corporate disclosure analysis. No API key required.',
      inputSchema: inputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      const log = logger.child({ tool: 'search_asx_announcements' });
      const code = input.asx_code.toUpperCase();
      const url = `${ASX_API_BASE}/${encodeURIComponent(code)}/announcements?limit=${input.limit}`;

      let data: unknown;
      try {
        const res = await externalFetch(url, {
          headers: {
            Accept: 'application/json',
            Referer: 'https://www.asx.com.au/',
          },
        });
        // Markit returns HTTP 400 with {error: "Symbol not found"} for unknown tickers.
        // Everything else in the 4xx range is either a bad query or upstream oddness.
        if (res.status === 400 || res.status === 404) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              error: 'entity_not_found',
              message: `ASX code "${code}" not found. Check the ticker code and try again.`,
            }) }],
            isError: true,
          };
        }
        if (!res.ok) {
          throw new ExternalApiError('ASX', `ASX API returned status ${res.status}`, res.status);
        }
        data = await res.json();
      } catch (err) {
        log.warn({ err }, 'ASX API fetch failed');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'upstream_unavailable',
            message: 'The ASX announcements API is currently unavailable. Try again shortly.',
            detail: err instanceof Error ? err.message : String(err),
          }) }],
          isError: true,
        };
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = data as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawAnnouncements: any[] = Array.isArray(raw?.data?.items) ? raw.data.items : [];
      // Markit's endpoint doesn't surface a total-count; treat the returned
      // batch size as the best-effort total so callers know whether to page.
      const totalAvailable: number = rawAnnouncements.length;

      let announcements: AsxAnnouncement[] = rawAnnouncements.map((a) => {
        const documentKey = String(a.documentKey ?? '');
        return {
          id: documentKey,
          date: typeof a.date === 'string' ? a.date.slice(0, 10) : '',
          headline: String(a.headline ?? a.announcementType ?? ''),
          market_sensitive: Boolean(a.isPriceSensitive),
          // Markit's response exposes fileSize (e.g. "165KB") rather than a
          // page count; leave pages null.
          pages: null,
          url: documentKey
            ? (typeof a.url === 'string' && a.url.length > 0 ? a.url : `${ASX_FILE_BASE}/${documentKey}`)
            : '',
        };
      });

      // Apply filter_text if provided
      if (input.filter_text) {
        const filterLower = input.filter_text.toLowerCase();
        announcements = announcements.filter((a) =>
          a.headline.toLowerCase().includes(filterLower),
        );
      }

      // Apply market_sensitive_only filter
      if (input.market_sensitive_only) {
        announcements = announcements.filter((a) => a.market_sensitive);
      }

      recordMatterQuery({
        matter_ref: input.matter_ref,
        tool_name: 'search_asx_announcements',
        query_text: `${code}${input.filter_text ? ` "${input.filter_text}"` : ''}`,
        result_count: announcements.length,
        top_results: announcements
          .slice(0, 3)
          .map((a) => ({ title: `[${a.date}] ${a.headline}`, url: a.url })),
      });

      // The ASX announcements endpoint accepts only `count` (and
      // market_sensitive). No documented offset / page parameter, so we
      // cannot page past the first `count` rows. Total_count is surfaced for
      // context; no `cursor` input is accepted.
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          asx_code: code,
          result_count: announcements.length,
          total_available: totalAvailable,
          ...(input.filter_text ? { filter_applied: input.filter_text } : {}),
          announcements,
          pagination: {
            returned: announcements.length,
            limit: input.limit ?? 20,
            total_count: totalAvailable,
            has_more: totalAvailable > announcements.length,
          },
        }) }],
      };
    },
  );
}
