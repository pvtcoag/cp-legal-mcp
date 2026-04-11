import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { searchLegislation, AuslawError } from '../auslaw-client.js';
import { rerank } from '../hf-client.js';
import { logger } from '../logger.js';

const inputSchema = z.object({
  query: z
    .string()
    .min(3)
    .max(500)
    .describe('Natural language query about legislation to find'),
  jurisdiction: z
    .enum(['cth', 'nsw', 'vic', 'qld', 'wa', 'sa', 'tas', 'act', 'nt', 'all'])
    .default('all')
    .describe(
      'Australian jurisdiction for legislation search. cth = Commonwealth/Federal',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5)
    .describe('Maximum number of results to return'),
});

export function registerResearchLegislation(server: McpServer): void {
  server.tool(
    'research_legislation',
    'Search Australian federal and state legislation. Returns semantically reranked acts and regulations from AustLII.',
    inputSchema.shape,
    async (input) => {
      const log = logger.child({ tool: 'research_legislation' });

      const fetchLimit = Math.min((input.limit ?? 5) * 2, 15);

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
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  error: 'upstream_unavailable',
                  message:
                    'The Australian legislation database is currently unavailable. Please retry in a moment.',
                }),
              },
            ],
            isError: true,
          };
        }
        throw err;
      }

      let ranked;
      try {
        ranked = await rerank(input.query, rawResults, input.limit ?? 5);
      } catch (err) {
        log.warn({ err }, 'HF reranking failed, using original order');
        ranked = rawResults.slice(0, input.limit ?? 5).map((item) => ({ item, score: 1.0 }));
      }

      const results = ranked.map(({ item, score }) => ({
        title: item.title,
        url: item.url,
        excerpt: item.excerpt,
        ...(item.jurisdiction ? { jurisdiction: item.jurisdiction } : {}),
        ...(item.date ? { date: item.date } : {}),
        relevance_score: Math.round(score * 1000) / 1000,
      }));

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                query: input.query,
                jurisdiction: input.jurisdiction,
                result_count: results.length,
                results,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
