import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { searchCases, AuslawError } from '../auslaw-client.js';
import { rerank } from '../hf-client.js';
import { logger } from '../logger.js';
import { recordMatterQuery, validateMatterRef } from '../matter-log.js';

const inputSchema = z.object({
  query: z
    .string()
    .min(3, 'Query must be at least 3 characters')
    .max(500)
    .describe('Natural language query describing the legal issue or case to research'),
  jurisdiction: z
    .enum([
      'hca',   // High Court of Australia
      'fcafc', // Federal Court Full Court
      'fca',   // Federal Court
      'nswca', // NSW Court of Appeal
      'nswsc', // NSW Supreme Court
      'vsca',  // Victorian Court of Appeal
      'vsc',   // Victorian Supreme Court
      'qca',   // Queensland Court of Appeal
      'qsc',   // Queensland Supreme Court
      'wasc',  // WA Supreme Court
      'sasc',  // SA Supreme Court
      'tassc', // Tasmania Supreme Court
      'ntsc',  // NT Supreme Court
      'actsc', // ACT Supreme Court
      'all',
    ])
    .default('all')
    .describe('Australian court jurisdiction to search within'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5)
    .describe('Maximum number of results to return after reranking'),
  include_citations: z
    .boolean()
    .default(true)
    .describe('Whether to include formatted citations in the response'),
  matter_ref: z
    .string()
    .max(100)
    .optional()
    .describe(
      'Optional matter reference to tag this search for later retrieval (e.g. "ABC-2024-001" or "Smith Dispute"). Use get_matter_history to review all searches for a matter.',
    ),
});

export function registerResearchCases(server: McpServer): void {
  server.tool(
    'research_cases',
    'Search Australian case law using natural language. Returns semantically reranked results from AustLII with formatted citations ready for legal writing.',
    inputSchema.shape,
    async (input) => {
      const log = logger.child({ tool: 'research_cases' });

      const fetchLimit = Math.min((input.limit ?? 5) * 2, 15);

      let rawResults;
      try {
        rawResults = await searchCases({
          query: input.query,
          jurisdiction: input.jurisdiction === 'all' ? undefined : input.jurisdiction,
          limit: fetchLimit,
        });
        log.debug({ query: input.query, resultCount: rawResults.length }, 'AusLaw results received');
      } catch (err) {
        if (err instanceof AuslawError) {
          log.warn({ err }, 'AusLaw search_cases failed');
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'upstream_unavailable', message: 'The Australian legal database is currently unavailable. Please retry in a moment.', detail: err.message }) }],
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
        ...(input.include_citations && item.citation ? { citation: item.citation } : {}),
        url: item.url,
        excerpt: item.excerpt,
        ...(item.court ? { court: item.court } : {}),
        ...(item.date ? { date: item.date } : {}),
        ...(item.jurisdiction ? { jurisdiction: item.jurisdiction } : {}),
        relevance_score: Math.round(score * 1000) / 1000,
      }));

      if (input.matter_ref && validateMatterRef(input.matter_ref)) {
        recordMatterQuery({
          matter_ref: input.matter_ref,
          tool_name: 'research_cases',
          query_text: input.query,
          jurisdiction: input.jurisdiction,
          result_count: results.length,
          top_results: results.slice(0, 3).map((r) => ({ title: r.title, citation: r.citation, url: r.url })),
        });
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ query: input.query, jurisdiction: input.jurisdiction, result_count: results.length, results }, null, 2),
        }],
      };
    },
  );
}
