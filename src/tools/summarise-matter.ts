import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getMatterHistory, isDbEnabled } from '../db.js';
import { logger } from '../logger.js';
import { recordMatterQuery } from '../matter-log.js';

const CASE_TOOLS = new Set([
  'research_cases', 'find_citing_cases', 'find_related_cases',
  'summarise_judgment', 'enrich_judgment', 'ask_judgment',
  'get_judgment', 'compare_cases', 'search_by_citation',
]);

const LEGISLATION_TOOLS = new Set([
  'research_legislation', 'get_legislation', 'ask_legislation',
]);

const inputSchema = z.object({
  matter_ref: z
    .string()
    .min(1)
    .max(100)
    .describe('The matter reference to summarise (e.g. "Smith-2025")'),
  include_query_list: z
    .boolean()
    .default(false)
    .describe('Include the full list of individual research queries. Default false — returns summary stats only.'),
});

export function registerSummariseMatter(server: McpServer): void {
  server.tool(
    'summarise_matter',
    'Generate a research summary for a matter: total queries, tools used, cases and legislation researched, API token usage, and research timeline. Provides an at-a-glance overview of all research conducted under a matter reference. Requires matter tracking to be enabled (DATABASE_URL configured).',
    inputSchema.shape,
    async (input) => {
      const log = logger.child({ tool: 'summarise_matter' });

      if (!isDbEnabled()) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'not_configured',
            message: 'Matter tracking is not enabled on this deployment (DATABASE_URL not set).',
          }) }],
          isError: true,
        };
      }

      let rows;
      try {
        rows = await getMatterHistory(input.matter_ref, 500);
        log.debug({ matter_ref: input.matter_ref, rowCount: rows.length }, 'Matter history fetched for summary');
      } catch (err) {
        log.error({ err }, 'getMatterHistory failed in summarise_matter');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'database_error',
            message: 'Could not retrieve matter history. Please try again.',
          }) }],
          isError: true,
        };
      }

      if (rows.length === 0) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            matter_ref: input.matter_ref,
            summary: { total_queries: 0 },
            message: 'No research records found for this matter reference.',
          }) }],
        };
      }

      // Tools used breakdown
      const toolCounts: Record<string, number> = {};
      for (const row of rows) {
        toolCounts[row.tool_name] = (toolCounts[row.tool_name] ?? 0) + 1;
      }

      // Unique cases researched
      const casesSeen = new Map<string, { title: string; citation?: string; url: string }>();
      for (const row of rows) {
        if (!CASE_TOOLS.has(row.tool_name)) continue;
        const results = Array.isArray(row.top_results) ? row.top_results : [];
        for (const r of results) {
          if (r.url && !casesSeen.has(r.url)) {
            casesSeen.set(r.url, { title: r.title, citation: r.citation, url: r.url });
          }
        }
      }

      // Unique legislation found
      const legislationSeen = new Map<string, { title: string; url: string }>();
      for (const row of rows) {
        if (!LEGISLATION_TOOLS.has(row.tool_name)) continue;
        const results = Array.isArray(row.top_results) ? row.top_results : [];
        for (const r of results) {
          if (r.url && !legislationSeen.has(r.url)) {
            legislationSeen.set(r.url, { title: r.title, url: r.url });
          }
        }
      }

      // Token totals
      const totalTokens = rows.reduce((sum, r) => sum + (r.api_tokens_used ?? 0), 0);
      const errorCount = rows.filter((r) => r.is_error).length;

      // Date range
      const dates = rows.map((r) => r.created_at).filter(Boolean).sort();
      const dateRange =
        dates.length > 0
          ? { first: dates[0]!, last: dates[dates.length - 1]! }
          : null;

      const summary = {
        total_queries: rows.length,
        tools_used: toolCounts,
        cases_researched: Array.from(casesSeen.values()),
        legislation_found: Array.from(legislationSeen.values()),
        total_api_tokens: totalTokens,
        date_range: dateRange,
        errors: errorCount,
      };

      recordMatterQuery({
        matter_ref: input.matter_ref,
        tool_name: 'summarise_matter',
        query_text: input.matter_ref,
        result_count: casesSeen.size + legislationSeen.size,
        top_results: Array.from(casesSeen.values())
          .slice(0, 3)
          .map((c) => ({ title: c.title, citation: c.citation, url: c.url })),
      });

      const queryList = input.include_query_list
        ? rows.map((r) => ({
            id: r.id,
            tool: r.tool_name,
            query: r.query_text,
            ...(r.jurisdiction ? { jurisdiction: r.jurisdiction } : {}),
            result_count: r.result_count,
            searched_at: r.created_at,
            top_results: r.top_results,
            ...(r.is_error ? { error: r.error_message } : {}),
          }))
        : undefined;

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          matter_ref: input.matter_ref,
          summary,
          ...(queryList ? { queries: queryList } : {}),
        }) }],
      };
    },
  );
}
