import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { searchCitingCases, AuslawError } from '../auslaw-client.js';
import { logger } from '../logger.js';
import { recordMatterQuery, validateMatterRef } from '../matter-log.js';

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
    .describe('Optional matter reference to tag this search for later retrieval.'),
});

export function registerFindCitingCases(server: McpServer): void {
  server.tool(
    'find_citing_cases',
    'Find Australian cases that have cited a given judgment. Uses jade.io\'s citator service. Useful for tracing how a case has been applied, distinguished, or overruled.',
    inputSchema.shape,
    async (input) => {
      const log = logger.child({ tool: 'find_citing_cases', citation: input.citation });

      let results;
      try {
        results = await searchCitingCases({
          citation: input.citation,
          limit: input.limit ?? 10,
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
                }),
              },
            ],
            isError: true,
          };
        }
        throw err;
      }

      // Results already sorted by relevance from jade.io's citator — no reranking needed
      const cases = results.map((item) => ({
        title: item.title,
        citation: item.citation,
        url: item.url,
        ...(item.excerpt ? { excerpt: item.excerpt } : {}),
        ...(item.court ? { court: item.court } : {}),
        ...(item.date ? { date: item.date } : {}),
      }));

      if (input.matter_ref && validateMatterRef(input.matter_ref)) {
        recordMatterQuery({
          matter_ref: input.matter_ref,
          tool_name: 'find_citing_cases',
          query_text: input.citation,
          result_count: cases.length,
          top_results: cases.slice(0, 3).map((c) => ({ title: c.title, citation: c.citation, url: c.url })),
        });
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ cited_case: input.citation, citing_case_count: cases.length, cases }, null, 2),
        }],
      };
    },
  );
}
