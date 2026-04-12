import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { externalFetch, ExternalApiError } from '../external-client.js';
import { logger } from '../logger.js';
import { recordMatterQuery } from '../matter-log.js';

const ASIC_ENFORCEMENT_URL =
  'https://asic.gov.au/regulatory-resources/find-a-document/search-for-enforcement-outcomes/';
const ASIC_UNDERTAKINGS_URL =
  'https://asic.gov.au/regulatory-resources/find-a-document/search-for-enforceable-undertakings/';
const ASIC_BANNING_URL =
  'https://asic.gov.au/regulatory-resources/find-a-document/search-for-banning-orders/';

const inputSchema = z.object({
  query: z
    .string()
    .min(2)
    .max(200)
    .describe('Name, company, or keyword to search ASIC enforcement outcomes for'),
  decision_type: z
    .enum(['enforcement', 'enforceable_undertaking', 'banning_order', 'all'])
    .default('all')
    .describe('Type of ASIC regulatory decision to search for'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(10)
    .describe('Maximum number of results to return'),
  matter_ref: z
    .string()
    .max(100)
    .optional()
    .describe('Matter reference to tag this search in the research log.'),
});

interface AsicDecision {
  title: string;
  date: string | null;
  summary: string | null;
  url: string;
  decision_type: string;
}

function parseAsicDecisions(html: string, baseUrl: string, decisionType: string, limit: number): AsicDecision[] {
  const results: AsicDecision[] = [];

  // ASIC result pages list items as articles or list items with titles and summaries
  // Try multiple patterns to extract results

  // Pattern 1: article/result items
  const articlePattern = /<(?:article|li)[^>]*class="[^"]*(?:result|search-result|listing)[^"]*"[^>]*>([\s\S]*?)<\/(?:article|li)>/gi;
  let match: RegExpExecArray | null;
  while ((match = articlePattern.exec(html)) !== null && results.length < limit) {
    const item = match[1]!;
    const titleMatch = item.match(/<(?:h[2-4]|a)[^>]*>([\s\S]*?)<\/(?:h[2-4]|a)>/i);
    const linkMatch = item.match(/href="([^"]+)"/i);
    const dateMatch = item.match(/(\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})/i);
    const summaryMatch = item.match(/<p[^>]*>([\s\S]*?)<\/p>/i);

    if (titleMatch) {
      const title = titleMatch[1]!
        .replace(/<[^>]+>/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();

      if (!title || title.length < 5) continue;

      const href = linkMatch?.[1] ?? null;
      const url = href
        ? href.startsWith('http') ? href : `https://asic.gov.au${href}`
        : baseUrl;

      const summary = summaryMatch
        ? summaryMatch[1]!
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s{2,}/g, ' ')
            .trim()
            .slice(0, 300)
        : null;

      results.push({
        title,
        date: dateMatch?.[1] ?? null,
        summary,
        url,
        decision_type: decisionType,
      });
    }
  }

  // Pattern 2: table rows (for banning orders / undertakings registers)
  if (results.length === 0) {
    const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch: RegExpExecArray | null;
    while ((rowMatch = rowPattern.exec(html)) !== null && results.length < limit) {
      const cells = rowMatch[1]!
        .match(/<td[^>]*>([\s\S]*?)<\/td>/gi)
        ?.map((cell) => {
          const linkMatch = cell.match(/href="([^"]+)"/i);
          const text = cell
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/\s{2,}/g, ' ')
            .trim();
          return { text, href: linkMatch?.[1] ?? null };
        })
        .filter((c) => c.text.length > 0) ?? [];

      if (cells.length >= 2) {
        const name = cells[0]?.text ?? '';
        if (!name || /^(name|respondent|person)/i.test(name)) continue;

        const href = cells.find((c) => c.href)?.href ?? null;
        const url = href
          ? href.startsWith('http') ? href : `https://asic.gov.au${href}`
          : baseUrl;
        const date = cells.find((c) => /\d{4}/.test(c.text) && /\d{1,2}/.test(c.text))?.text ?? null;

        results.push({
          title: name,
          date,
          summary: cells.slice(1, 3).map((c) => c.text).filter(Boolean).join(' — ').slice(0, 300) || null,
          url,
          decision_type: decisionType,
        });
      }
    }
  }

  return results;
}

export function registerSearchAsicDecisions(server: McpServer): void {
  server.tool(
    'search_asic_decisions',
    'Search ASIC enforcement outcomes, enforceable undertakings, and banning orders by name or keyword. Returns summaries of ASIC regulatory actions. Use for regulatory risk assessment, counterparty due diligence, and regulatory conflicts research.',
    inputSchema.shape,
    async (input) => {
      const log = logger.child({ tool: 'search_asic_decisions' });
      const queryParam = `?query=${encodeURIComponent(input.query)}`;

      const targets: Array<{ url: string; type: string }> = [];
      if (input.decision_type === 'all' || input.decision_type === 'enforcement') {
        targets.push({ url: ASIC_ENFORCEMENT_URL + queryParam, type: 'enforcement' });
      }
      if (input.decision_type === 'all' || input.decision_type === 'enforceable_undertaking') {
        targets.push({ url: ASIC_UNDERTAKINGS_URL + queryParam, type: 'enforceable_undertaking' });
      }
      if (input.decision_type === 'all' || input.decision_type === 'banning_order') {
        targets.push({ url: ASIC_BANNING_URL + queryParam, type: 'banning_order' });
      }

      const allResults: AsicDecision[] = [];
      const errors: string[] = [];

      await Promise.allSettled(
        targets.map(async ({ url, type }) => {
          try {
            const res = await externalFetch(url, {
              headers: { Accept: 'text/html,application/xhtml+xml', Referer: 'https://asic.gov.au/' },
            });
            if (!res.ok) throw new ExternalApiError('ASIC', `Status ${res.status}`, res.status);
            const html = await res.text();
            const parsed = parseAsicDecisions(html, url, type, input.limit);
            allResults.push(...parsed);
          } catch (err) {
            log.warn({ err, url }, 'ASIC decisions fetch failed');
            errors.push(type);
          }
        }),
      );

      // Filter by query (case-insensitive substring match on title + summary)
      const q = input.query.toLowerCase();
      const filtered = allResults
        .filter((r) =>
          r.title.toLowerCase().includes(q) ||
          (r.summary ?? '').toLowerCase().includes(q),
        )
        .slice(0, input.limit);

      recordMatterQuery({
        matter_ref: input.matter_ref,
        tool_name: 'search_asic_decisions',
        query_text: input.query,
        result_count: filtered.length,
        top_results: filtered.slice(0, 3).map((r) => ({ title: r.title, url: r.url })),
      });

      if (errors.length === targets.length) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'search_unavailable',
            message: 'ASIC enforcement decisions search is currently unavailable.',
            manual_urls: {
              enforcement: ASIC_ENFORCEMENT_URL,
              undertakings: ASIC_UNDERTAKINGS_URL,
              banning_orders: ASIC_BANNING_URL,
            },
          }) }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          query: input.query,
          decision_type: input.decision_type,
          result_count: filtered.length,
          results: filtered,
          ...(errors.length > 0 ? { partial_failure: `Could not fetch: ${errors.join(', ')}` } : {}),
          manual_urls: {
            enforcement: ASIC_ENFORCEMENT_URL,
            undertakings: ASIC_UNDERTAKINGS_URL,
            banning_orders: ASIC_BANNING_URL,
          },
        }) }],
      };
    },
  );
}
