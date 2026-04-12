import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { searchLegislation, AuslawError } from '../auslaw-client.js';
import { rerank } from '../isaacus-client.js';
import { logger } from '../logger.js';
import { recordMatterQuery } from '../matter-log.js';

const inputSchema = z.object({
  query: z
    .string()
    .min(3)
    .max(500)
    .describe('Natural language query about legislation to find'),
  jurisdiction: z
    .enum(['cth', 'nsw', 'vic', 'qld', 'wa', 'sa', 'tas', 'act', 'nt', 'all'])
    .default('all')
    .describe('Australian jurisdiction for legislation search. cth = Commonwealth/Federal'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5)
    .describe('Maximum number of results to return'),
  use_iql: z
    .boolean()
    .default(false)
    .describe(
      'Treat the query as an IQL boolean expression for precise matching. ' +
      'Supports AND, OR, NOT operators and quoted phrases. ' +
      'Example: \'"fair dealing" AND copyright NOT "moral rights"\'. ' +
      'Only affects result ranking — AustLII search still receives the raw query.',
    ),
  matter_ref: z
    .string()
    .max(100)
    .optional()
    .describe('Matter reference to tag this search in the research log. If a matter_ref was provided earlier in this conversation or in your project instructions, always include it here.'),
  from_year: z
    .number()
    .int()
    .min(1900)
    .max(2100)
    .optional()
    .describe('Filter results to legislation enacted or amended on or after this year, e.g. 2015'),
  to_year: z
    .number()
    .int()
    .min(1900)
    .max(2100)
    .optional()
    .describe('Filter results to legislation enacted or amended on or before this year, e.g. 2023'),
});

export function registerResearchLegislation(server: McpServer): void {
  server.tool(
    'research_legislation',
    '[Legislation] Search Australian federal and state legislation. Returns semantically reranked acts and regulations from AustLII.',
    inputSchema.shape,
    async (input) => {
      const log = logger.child({ tool: 'research_legislation' });

      // Fetch 3× candidates for the reranker. 3× gives the reranker a meaningful
      // pool without inflating Isaacus input tokens the way 4× did.
      const fetchLimit = Math.min((input.limit ?? 5) * 3, 20);

      let rawResults;
      try {
        rawResults = await searchLegislation({
          query: input.query,
          jurisdiction: input.jurisdiction === 'all' ? undefined : input.jurisdiction,
          limit: fetchLimit,
        });
        log.debug({ query: input.query, resultCount: rawResults.length }, 'AusLaw results received');
      } catch (err) {
        if (err instanceof AuslawError) {
          log.warn({ err }, 'AusLaw search_legislation failed');
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'upstream_unavailable', message: 'The Australian legislation database is currently unavailable. Please retry in a moment.', detail: err.message }) }],
            isError: true,
          };
        }
        throw err;
      }

      // Client-side year filter — AustLII legislation search doesn't natively support year ranges
      let filteredResults = rawResults;
      if (input.from_year !== undefined || input.to_year !== undefined) {
        filteredResults = rawResults.filter((item) => {
          if (!item.date) return true;
          const year = new Date(item.date).getFullYear();
          if (isNaN(year)) return true;
          if (input.from_year !== undefined && year < input.from_year) return false;
          if (input.to_year !== undefined && year > input.to_year) return false;
          return true;
        });
        log.debug({ before: rawResults.length, after: filteredResults.length }, 'Year filter applied');
      }

      let ranked;
      let rerankTokens = 0;
      try {
        const rerankResult = await rerank(input.query, filteredResults, input.limit ?? 5, { isIql: input.use_iql });
        ranked = rerankResult.results;
        rerankTokens = rerankResult.tokensUsed;
      } catch (err) {
        log.warn({ err }, 'Isaacus reranking failed, using original order');
        ranked = filteredResults.slice(0, input.limit ?? 5).map((item) => ({ item, score: 1.0 }));
      }

      const results = ranked.map(({ item, score }) => ({
        title: item.title,
        url: item.url,
        ...(item.excerpt ? { excerpt: item.excerpt.length > 200 ? item.excerpt.slice(0, 200) + '…' : item.excerpt } : {}),
        ...(item.jurisdiction ? { jurisdiction: item.jurisdiction } : {}),
        ...(item.date ? { date: item.date } : {}),
        relevance_score: Math.round(score * 1000) / 1000,
      }));

      recordMatterQuery({
        matter_ref: input.matter_ref,
        tool_name: 'research_legislation',
        query_text: input.query,
        jurisdiction: input.jurisdiction,
        result_count: results.length,
        top_results: results.slice(0, 3).map((r) => ({ title: r.title, url: r.url })),
        api_tokens_used: rerankTokens,
        accuracy_score: ranked[0]?.score,
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            query: input.query,
            jurisdiction: input.jurisdiction,
            ...(input.from_year !== undefined ? { from_year: input.from_year } : {}),
            ...(input.to_year !== undefined ? { to_year: input.to_year } : {}),
            result_count: results.length,
            results,
          }),
        }],
      };
    },
  );
}
