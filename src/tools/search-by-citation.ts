import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool, matterRefSchema } from './_shared.js';
import { searchByCitation, AuslawError } from '../auslaw-client.js';
import { rerank } from '../isaacus-client.js';
import { logger } from '../logger.js';
import { recordMatterQuery } from '../matter-log.js';

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
  matter_ref: matterRefSchema,
});

export function registerSearchByCitation(server: McpServer): void {
  registerTool(
    server,
    'search_by_citation',
    {
      title: 'Search by citation',
      description: '[Case Research] Look up an Australian case by its neutral citation or case name. Returns matching cases with URLs and metadata. Use this when you have a specific citation or case name to resolve.',
      inputSchema: inputSchema.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      const log = logger.child({ tool: 'search_by_citation' });

      const isCitationQuery = /^\[\d{4}\]\s+[A-Z]+\s+\d+$/i.test(input.citation_or_name.trim());
      const fetchLimit = isCitationQuery ? (input.limit ?? 5) : Math.min((input.limit ?? 5) * 4, 20);

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
                  detail: err.message,
                }),
              },
            ],
            isError: true,
          };
        }
        throw err;
      }

      // Skip reranking for exact citation queries (e.g. "[2024] HCA 12") — results are already precise
      let ranked;
      let rerankTokens = 0;
      if (isCitationQuery || rawResults.length <= 1) {
        ranked = rawResults.slice(0, input.limit ?? 5).map((item) => ({ item, score: 1.0 }));
      } else {
        try {
          const rerankResult = await rerank(input.citation_or_name, rawResults, input.limit ?? 5);
          ranked = rerankResult.results;
          rerankTokens = rerankResult.tokensUsed;
        } catch (err) {
          log.warn({ err }, 'Isaacus reranking failed, using original order');
          ranked = rawResults.slice(0, input.limit ?? 5).map((item) => ({ item, score: 1.0 }));
        }
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

      recordMatterQuery({
        matter_ref: input.matter_ref,
        tool_name: 'search_by_citation',
        query_text: input.citation_or_name,
        result_count: results.length,
        top_results: results.slice(0, 3).map((r) => ({ title: r.title, citation: r.citation, url: r.url })),
        api_tokens_used: rerankTokens,
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            query: input.citation_or_name,
            result_count: results.length,
            results,
          }),
        }],
      };
    },
  );
}
