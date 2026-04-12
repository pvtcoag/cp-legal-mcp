import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { searchCitingCases, AuslawError } from '../auslaw-client.js';
import { rerank } from '../isaacus-client.js';
import { logger } from '../logger.js';
import { recordMatterQuery } from '../matter-log.js';

const inputSchema = z.object({
  citation: z
    .string()
    .min(5)
    .describe('Neutral citation of the case to find citations for, e.g. "[2024] HCA 12"'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(10)
    .describe('Maximum number of citing cases to return'),
  matter_ref: z
    .string()
    .max(100)
    .optional()
    .describe('Matter reference to tag this search in the research log. If a matter_ref was provided earlier in this conversation or in your project instructions, always include it here.'),
});

export function registerFindCitingCases(server: McpServer): void {
  server.tool(
    'find_citing_cases',
    '[Case Research] Find Australian cases that have cited a given judgment. Uses LawCite (AustLII\'s citator service) to trace how a case has been applied, distinguished, or overruled.',
    inputSchema.shape,
    async (input) => {
      const log = logger.child({ tool: 'find_citing_cases', citation: input.citation });

      const fetchLimit = Math.min((input.limit ?? 10) * 3, 30);
      let results;
      try {
        results = await searchCitingCases({
          citation: input.citation,
          limit: fetchLimit,
        });
        log.debug({ resultCount: results.length }, 'AusLaw citing cases received');
      } catch (err) {
        if (err instanceof AuslawError) {
          log.warn({ err }, 'AusLaw search_citing_cases failed');
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  error: 'upstream_unavailable',
                  message:
                    'Could not retrieve citing cases. The citator service may be temporarily unavailable.',
                  detail: err.message,
                }),
              },
            ],
            isError: true,
          };
        }
        throw err;
      }

      // Rerank by the citation itself as query — surfaces most substantively relevant citing cases
      // rather than relying solely on LawCite's default ordering.
      let ranked;
      let rerankTokens = 0;
      try {
        const rerankResult = await rerank(input.citation, results, input.limit ?? 10);
        ranked = rerankResult.results;
        rerankTokens = rerankResult.tokensUsed;
      } catch (err) {
        log.warn({ err }, 'Isaacus reranking failed, using LawCite order');
        ranked = results.slice(0, input.limit ?? 10).map((item) => ({ item, score: 1.0 }));
      }

      const cases = ranked.map(({ item, score }) => ({
        title: item.title,
        citation: item.citation,
        url: item.url,
        ...(item.excerpt ? { excerpt: item.excerpt } : {}),
        ...(item.court ? { court: item.court } : {}),
        ...(item.date ? { date: item.date } : {}),
        relevance_score: Math.round(score * 1000) / 1000,
      }));

      recordMatterQuery({
        matter_ref: input.matter_ref,
        tool_name: 'find_citing_cases',
        query_text: input.citation,
        result_count: cases.length,
        top_results: cases.slice(0, 3).map((c) => ({ title: c.title, citation: c.citation, url: c.url })),
        api_tokens_used: rerankTokens,
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            cited_case: input.citation,
            citing_case_count: cases.length,
            cases,
          }),
        }],
      };
    },
  );
}
