import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { externalFetch, ExternalApiError } from '../external-client.js';
import { logger } from '../logger.js';
import { recordMatterQuery } from '../matter-log.js';

const ASX_API_BASE = 'https://www.asx.com.au/asx/1/company';

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
  matter_ref: z
    .string()
    .max(100)
    .optional()
    .describe('Matter reference to tag this search in the research log.'),
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
  server.tool(
    'search_asx_announcements',
    '[Market Intelligence] Search ASX company announcements for a given ASX ticker code. Returns recent announcements with headlines, dates, and PDF URLs. Use for listed entity research, material information tracking, and corporate disclosure analysis. No API key required.',
    inputSchema.shape,
    async (input) => {
      const log = logger.child({ tool: 'search_asx_announcements' });
      const code = input.asx_code.toUpperCase();
      const url = `${ASX_API_BASE}/${encodeURIComponent(code)}/announcements?count=${input.limit}&market_sensitive=${input.market_sensitive_only}`;

      let data: unknown;
      try {
        const res = await externalFetch(url, {
          headers: {
            Accept: 'application/json',
            Referer: 'https://www.asx.com.au/',
          },
        });
        if (res.status === 404) {
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
        if (err instanceof ExternalApiError) {
          log.warn({ err }, 'ASX API fetch failed');
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              error: 'upstream_unavailable',
              message: 'The ASX announcements API is currently unavailable. Try again shortly.',
              detail: err.message,
            }) }],
            isError: true,
          };
        }
        throw err;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = data as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawAnnouncements: any[] = Array.isArray(raw?.data) ? raw.data : [];
      const totalAvailable: number = raw?.paging?.total_count ?? rawAnnouncements.length;

      let announcements: AsxAnnouncement[] = rawAnnouncements.map((a) => ({
        id: String(a.id ?? ''),
        date: a.document_release_date
          ? a.document_release_date.slice(0, 10)
          : (a.document_date ?? '').slice(0, 10),
        headline: String(a.header ?? a.headline ?? ''),
        market_sensitive: Boolean(a.market_sensitive),
        pages: typeof a.number_of_pages === 'number' ? a.number_of_pages : null,
        url: String(
          a.url ??
          (a.id ? `https://www.asx.com.au/asx/statistics/displayAnnouncement.do?display=pdf&idsId=${a.id}` : ''),
        ),
      }));

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

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          asx_code: code,
          result_count: announcements.length,
          total_available: totalAvailable,
          ...(input.filter_text ? { filter_applied: input.filter_text } : {}),
          announcements,
        }) }],
      };
    },
  );
}
