import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { searchCases, AuslawError } from '../auslaw-client.js';
import { rerank } from '../isaacus-client.js';
import { logger } from '../logger.js';
import { recordMatterQuery } from '../matter-log.js';

const inputSchema = z.object({
  query: z
    .string()
    .min(3, 'Query must be at least 3 characters')
    .max(500)
    .describe('Natural language query describing the legal issue or case to research'),
  jurisdiction: z
    .enum([
      'hca',        // High Court of Australia
      'fcafc',      // Federal Court Full Court
      'fca',        // Federal Court
      'fedcfamc1f', // Federal Circuit and Family Court (Division 1)
      'fedcfamc2f', // Federal Circuit and Family Court (Division 2)
      'nswca',      // NSW Court of Appeal
      'nswsc',      // NSW Supreme Court
      'nswdc',      // NSW District Court
      'nswcca',     // NSW Court of Criminal Appeal
      'ncat',       // NSW Civil and Administrative Tribunal
      'vsca',       // Victorian Court of Appeal
      'vsc',        // Victorian Supreme Court
      'vcat',       // Victorian Civil and Administrative Tribunal
      'qca',        // Queensland Court of Appeal
      'qsc',        // Queensland Supreme Court
      'qdc',        // Queensland District Court
      'qcat',       // Queensland Civil and Administrative Tribunal
      'wasca',      // WA Court of Appeal
      'wasc',       // WA Supreme Court
      'sat',        // State Administrative Tribunal (WA)
      'sascfc',     // SA Supreme Court Full Court
      'sasc',       // SA Supreme Court
      'sacat',      // SA Civil and Administrative Tribunal
      'tasfc',      // Tasmania Full Court
      'tassc',      // Tasmania Supreme Court
      'ntca',       // NT Court of Appeal
      'ntsc',       // NT Supreme Court
      'actca',      // ACT Court of Appeal
      'actsc',      // ACT Supreme Court
      'acat',       // ACT Civil and Administrative Tribunal
      'all',
    ])
    .default('all')
    .describe('Australian court or tribunal jurisdiction to search within. Tribunal codes supported: ncat (NSW), vcat (VIC), qcat (QLD), sat (WA), sacat (SA), acat (ACT).'),
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
  from_year: z
    .number()
    .int()
    .min(1900)
    .max(2100)
    .optional()
    .describe('Filter results to cases decided on or after this year, e.g. 2015'),
  to_year: z
    .number()
    .int()
    .min(1900)
    .max(2100)
    .optional()
    .describe('Filter results to cases decided on or before this year, e.g. 2023'),
  use_iql: z
    .boolean()
    .default(false)
    .describe(
      'Treat the query as an IQL boolean expression for precise matching. ' +
      'Supports AND, OR, NOT operators and quoted phrases. ' +
      'Example: \'"duty of care" AND negligence NOT "contributory negligence"\'. ' +
      'Only affects result ranking — AustLII search still receives the raw query.',
    ),
  matter_ref: z
    .string()
    .max(100)
    .optional()
    .describe(
      'Matter reference to tag this search in the research log (e.g. "ABC-2024-001" or "Smith Dispute"). If a matter_ref was provided earlier in this conversation or in your project instructions, always include it here.',
    ),
});

export function registerResearchCases(server: McpServer): void {
  server.tool(
    'research_cases',
    'Search Australian case law using natural language. Returns semantically reranked results from AustLII with formatted citations ready for legal writing.',
    inputSchema.shape,
    async (input) => {
      const log = logger.child({ tool: 'research_cases' });

      // Neutral citations (e.g. "[2024] HCA 12") already resolve exactly via
      // AustLII — reranking adds no value and wastes Isaacus tokens. Use
      // search_by_citation for this case; if it arrives here anyway, skip rerank.
      const isCitationQuery = /^\[\d{4}\]\s+[A-Z]+\s+\d+$/i.test(input.query.trim());

      // Fetch 3× candidates for the reranker. 3× gives the reranker a meaningful
      // pool without inflating Isaacus input tokens the way 4× did.
      // Citation queries only need exact-match depth — no over-fetch required.
      const fetchLimit = isCitationQuery
        ? (input.limit ?? 5)
        : Math.min((input.limit ?? 5) * 3, 20);

      let rawResults;
      try {
        rawResults = await searchCases({
          query: input.query,
          jurisdiction: input.jurisdiction === 'all' ? undefined : input.jurisdiction,
          limit: fetchLimit,
          fromYear: input.from_year,
          toYear: input.to_year,
        });
        log.debug({ query: input.query, resultCount: rawResults.length, isCitationQuery }, 'AusLaw results received');
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
      let rerankTokens = 0;
      if (isCitationQuery || rawResults.length <= 1) {
        // Citation lookups and single-result responses don't benefit from reranking.
        ranked = rawResults.slice(0, input.limit ?? 5).map((item) => ({ item, score: 1.0 }));
        log.debug({ reason: isCitationQuery ? 'citation_query' : 'single_result' }, 'Skipping rerank');
      } else {
        try {
          const rerankResult = await rerank(input.query, rawResults, input.limit ?? 5, { isIql: input.use_iql });
          ranked = rerankResult.results;
          rerankTokens = rerankResult.tokensUsed;
        } catch (err) {
          log.warn({ err }, 'Isaacus reranking failed, using original order');
          ranked = rawResults.slice(0, input.limit ?? 5).map((item) => ({ item, score: 1.0 }));
        }
      }

      const results = ranked.map(({ item, score }) => ({
        title: item.title,
        ...(input.include_citations && item.citation ? { citation: item.citation } : {}),
        url: item.url,
        ...(item.excerpt ? { excerpt: item.excerpt.length > 200 ? item.excerpt.slice(0, 200) + '…' : item.excerpt } : {}),
        ...(item.court ? { court: item.court } : {}),
        ...(item.date ? { date: item.date } : {}),
        ...(item.jurisdiction ? { jurisdiction: item.jurisdiction } : {}),
        relevance_score: Math.round(score * 1000) / 1000,
      }));

      recordMatterQuery({
        matter_ref: input.matter_ref,
        tool_name: 'research_cases',
        query_text: input.query,
        jurisdiction: input.jurisdiction,
        result_count: results.length,
        top_results: results.slice(0, 3).map((r) => ({ title: r.title, citation: r.citation, url: r.url })),
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
          }),
        }],
      };
    },
  );
}
