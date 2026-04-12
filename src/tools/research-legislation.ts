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
});

export function registerResearchLegislation(server: McpServer): void {
  server.tool(
    'research_legislation',
    'Search Australian federal and state legislation. Returns semantically reranked acts and regulations from AustLII.',
    inputSchema.shape,
    async (input) => {
      const log = logger.child({ tool: 'research_legislation' });

      // Fetch more candidates than needed — Kanon 2 Reranker scores all of them
      // accurately so a larger pool yields better final results.
      const fetchLimit = Math.min((input.limit ?? 5) * 4, 20);

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

      let ranked;
      let rerankTokens = 0;
      try {
        const rerankResult = await rerank(input.query, rawResults, input.limit ?? 5, { isIql: input.use_iql });
        ranked = rerankResult.results;
        rerankTokens = rerankResult.tokensUsed;
      } catch (err) {
        log.warn({ err }, 'Isaacus reranking failed, using original order');
        ranked = rawResults.slice(0, input.limit ?? 5).map((item) => ({ item, score: 1.0 }));
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
            result_count: results.length,
            results,
            _suggested_next: results.length > 0
              ? 'Use ask_legislation with the URL to extract answers to specific questions (definitions, offence elements, penalty amounts, scope). Use get_legislation only if you need the full consolidated text verbatim.'
              : 'No results found — try different search terms or broaden the jurisdiction.',
          }),
        }],
      };
    },
  );
}
