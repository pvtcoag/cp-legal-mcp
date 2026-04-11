import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { searchByCitation, AuslawError } from '../auslaw-client.js';
import { rerank } from '../hf-client.js';
import { logger } from '../logger.js';

const inputSchema = z.object({
  citation_or_name: z
    .string()
    .min(3)
    .describe(
      'Neutral citation (e.g. "[2024] HCA 12") or full/partial case name (e.g. "Donoghue v Stevenson")',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5)
    .describe('Maximum number of results to return'),
});

export function registerSearchByCitation(server: McpServer): void {
  server.tool(
    'search_by_citation',
    'Look up an Australian case by its neutral citation or case name. Returns matching cases with URLs and metadata. Use this when you have a specific citation or case name to resolve.',
    inputSchema.shape,
    async (input) => {
      const log = logger.child({ tool: 'search_by_citation' });

      const fetchLimit = Math.min((input.limit ?? 5) * 2, 15);

      let rawResults;
      try {
        rawResults = await searchByCitation({
          citation_or_name: input.citation_or_name,
          limit: fetchLimit,
        });
        log.debug({ input: input.citation_or_name, resultCount: rawResults.length }, 'AusLaw results received');
      } catch (err) {
        if (err instanceof AuslawError) {
          log.warn({ err }, 'AusLaw search_by_citation failed');
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  error: 'upstream_unavailable',
                  message: 'Could not search by citation. The legal database may be temporarily unavailable.',
                }),
              },
            ],
            isError: true,
          };
        }
        throw err;
      }

      // Rerank when searching by name (multiple candidates); less useful for exact citation lookup
      let ranked;
      try {
        ranked = await rerank(input.citation_or_name, rawResults, input.limit ?? 5);
      } catch (err) {
        log.warn({ err }, 'HF reranking failed, using original order');
        ranked = rawResults.slice(0, input.limit ?? 5).map((item) => ({ item, score: 1.0 }));
      }

      const results = ranked.map(({ item, score }) => ({
        title: item.title,
        citation: item.citation,
        url: item.url,
        ...(item.excerpt ? { excerpt: item.excerpt } : {}),
        ...(item.court ? { court: item.court } : {}),
        ...(item.date ? { date: item.date } : {}),
        ...(item.jurisdiction ? { jurisdiction: item.jurisdiction } : {}),
        relevance_score: Math.round(score * 1000) / 1000,
      }));

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                query: input.citation_or_name,
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
