import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool } from './_shared.js';
import { getMatterHistory, getMatterHistoryCount, isDbEnabled } from '../db.js';
import { logger } from '../logger.js';
import { recordMatterQuery } from '../matter-log.js';

const CASE_TOOLS = new Set([
  'research_cases', 'find_citing_cases', 'find_related_cases',
  'summarise_judgment', 'enrich_judgment', 'ask_judgment',
  'get_judgment', 'compare_cases', 'search_by_citation',
]);

const LEGISLATION_TOOLS = new Set([
  'research_legislation', 'get_legislation',
]);

const inputSchema = z.object({
  matter_ref: z
    .string()
    .min(1)
    .max(100)
    .describe('The matter reference to retrieve history for (e.g. "Smith-2025")'),
  view: z
    .enum(['list', 'summary'])
    .default('list')
    .describe(
      'list — return the full chronological log of individual research queries (default). ' +
      'summary — return aggregated stats: tools used, cases researched, legislation found, token usage, and date range.',
    ),
  format: z
    .enum(['json', 'markdown'])
    .default('json')
    .describe('Response format: "json" for structured data, "markdown" for human-readable prose'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(50)
    .describe('Maximum number of records to return (list mode) or process (summary mode)'),
  include_queries: z
    .boolean()
    .default(false)
    .describe(
      'In summary mode, also include the full query list alongside the summary stats. Ignored in list mode.',
    ),
});

// ── Output schema ─────────────────────────────────────────────────────────────
const outputSchemaShape = {
  error: z.string().optional(),
  message: z.string().optional(),

  matter_ref: z.string().optional(),
  record_count: z.number().optional(),
  records: z.array(z.record(z.any())).optional(),
  summary: z.object({
    total_queries: z.number(),
    tools_used: z.record(z.number()),
    cases_researched: z.array(z.record(z.any())),
    legislation_found: z.array(z.record(z.any())),
    total_api_tokens: z.number(),
    date_range: z.object({ first: z.any(), last: z.any() }).nullable(),
    errors: z.number(),
  }).optional(),
  queries: z.array(z.record(z.any())).optional(),
  pagination: z.object({
    returned: z.number(),
    limit: z.number(),
    total_count: z.number().optional(),
    has_more: z.boolean().optional(),
  }).optional(),
};

export function registerGetMatterHistory(server: McpServer): void {
  registerTool(
    server,
    'get_matter_history',
    {
      title: 'Get matter history',
      description: '[Matter] Retrieve research history for a matter reference. ' +
    'Two views: list (default) — chronological log of every research query with tool, query text, and top results; ' +
    'summary — aggregated overview of total queries, tools used, unique cases and legislation researched, API token usage, and date range. ' +
    'Requires matter tracking to be enabled (DATABASE_URL configured).',
      inputSchema: inputSchema.shape,
      outputSchema: outputSchemaShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const log = logger.child({ tool: 'get_matter_history' });

      if (!isDbEnabled()) {
        const obj = {
          error: 'not_configured',
          message: 'Matter tracking is not enabled on this deployment (DATABASE_URL not set).',
        };
        return {
          structuredContent: obj,
          content: [{ type: 'text' as const, text: JSON.stringify(obj) }],
          isError: true,
        };
      }

      let rows;
      let totalCount: number | undefined;
      try {
        const effectiveLimit = input.limit ?? 50;
        [rows, totalCount] = await Promise.all([
          getMatterHistory(input.matter_ref, effectiveLimit),
          getMatterHistoryCount(input.matter_ref),
        ]);
        log.debug({ matter_ref: input.matter_ref, rowCount: rows.length, totalCount }, 'Matter history retrieved');
      } catch (err) {
        log.error({ err }, 'getMatterHistory failed');
        const obj = {
          error: 'database_error',
          message: 'Could not retrieve matter history. Please try again.',
        };
        return {
          structuredContent: obj,
          content: [{ type: 'text' as const, text: JSON.stringify(obj) }],
          isError: true,
        };
      }

      if (rows.length === 0) {
        const obj = {
          matter_ref: input.matter_ref,
          record_count: 0,
          message: 'No research records found for this matter reference.',
        };
        return {
          structuredContent: obj,
          content: [{ type: 'text' as const, text: JSON.stringify(obj) }],
        };
      }

      // ── Summary view ───────────────────────────────────────────────────────
      if (input.view === 'summary') {
        const toolCounts: Record<string, number> = {};
        for (const row of rows) {
          toolCounts[row.tool_name] = (toolCounts[row.tool_name] ?? 0) + 1;
        }

        const casesSeen = new Map<string, { title: string; citation?: string; url: string }>();
        for (const row of rows) {
          if (!CASE_TOOLS.has(row.tool_name)) continue;
          for (const r of (Array.isArray(row.top_results) ? row.top_results : [])) {
            if (r.url && !casesSeen.has(r.url)) {
              casesSeen.set(r.url, { title: r.title, citation: r.citation, url: r.url });
            }
          }
        }

        const legislationSeen = new Map<string, { title: string; url: string }>();
        for (const row of rows) {
          if (!LEGISLATION_TOOLS.has(row.tool_name)) continue;
          for (const r of (Array.isArray(row.top_results) ? row.top_results : [])) {
            if (r.url && !legislationSeen.has(r.url)) {
              legislationSeen.set(r.url, { title: r.title, url: r.url });
            }
          }
        }

        const totalTokens = rows.reduce((sum, r) => sum + (r.api_tokens_used ?? 0), 0);
        const errorCount = rows.filter((r) => r.is_error).length;
        const dates = rows.map((r) => r.created_at).filter(Boolean).sort();

        recordMatterQuery({
          matter_ref: input.matter_ref,
          tool_name: 'get_matter_history',
          query_text: `summary:${input.matter_ref}`,
          result_count: casesSeen.size + legislationSeen.size,
          top_results: Array.from(casesSeen.values())
            .slice(0, 3)
            .map((c) => ({ title: c.title, citation: c.citation, url: c.url })),
        });

        const queryList = input.include_queries
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

        const obj = {
          matter_ref: input.matter_ref,
          summary: {
            total_queries: rows.length,
            tools_used: toolCounts,
            cases_researched: Array.from(casesSeen.values()),
            legislation_found: Array.from(legislationSeen.values()),
            total_api_tokens: totalTokens,
            date_range: dates.length > 0 ? { first: dates[0]!, last: dates[dates.length - 1]! } : null,
            errors: errorCount,
          },
          ...(queryList ? { queries: queryList } : {}),
          pagination: {
            returned: rows.length,
            limit: input.limit ?? 50,
            ...(totalCount !== undefined ? { total_count: totalCount, has_more: totalCount > rows.length } : {}),
          },
        };
        if (input.format === 'markdown') {
          const lines: string[] = [];
          lines.push(`# Matter History — ${input.matter_ref}`);
          lines.push('');
          lines.push('## Summary');
          lines.push('');
          lines.push(`- Total queries: ${obj.summary.total_queries}`);
          lines.push(`- Total API tokens: ${obj.summary.total_api_tokens}`);
          lines.push(`- Errors: ${obj.summary.errors}`);
          if (obj.summary.date_range) {
            lines.push(`- Date range: ${obj.summary.date_range.first} to ${obj.summary.date_range.last}`);
          }
          lines.push('');
          lines.push('## Tools Used');
          lines.push('');
          lines.push('| Tool | Calls |');
          lines.push('| --- | --- |');
          for (const [tool, count] of Object.entries(obj.summary.tools_used)) {
            lines.push(`| ${tool} | ${count} |`);
          }
          lines.push('');
          if (obj.summary.cases_researched.length > 0) {
            lines.push('## Cases Researched');
            lines.push('');
            lines.push('| Title | Citation | URL |');
            lines.push('| --- | --- | --- |');
            for (const c of obj.summary.cases_researched) {
              lines.push(`| ${c.title} | ${c.citation ?? ''} | ${c.url} |`);
            }
            lines.push('');
          }
          if (obj.summary.legislation_found.length > 0) {
            lines.push('## Legislation Found');
            lines.push('');
            lines.push('| Title | URL |');
            lines.push('| --- | --- |');
            for (const l of obj.summary.legislation_found) {
              lines.push(`| ${l.title} | ${l.url} |`);
            }
            lines.push('');
          }
          return {
            structuredContent: obj,
            content: [{ type: 'text' as const, text: lines.join('\n').trimEnd() }],
          };
        }
        return {
          structuredContent: obj,
          content: [{ type: 'text' as const, text: JSON.stringify(obj) }],
        };
      }

      // ── List view (default) ────────────────────────────────────────────────
      const records = rows.map((r) => ({
        id: r.id,
        tool: r.tool_name,
        query: r.query_text,
        ...(r.jurisdiction ? { jurisdiction: r.jurisdiction } : {}),
        result_count: r.result_count,
        searched_by: r.user_id ?? 'unknown',
        searched_at: r.created_at,
        top_results: r.top_results,
      }));

      const obj = {
        matter_ref: input.matter_ref,
        record_count: records.length,
        records,
        pagination: {
          returned: records.length,
          limit: input.limit ?? 50,
          ...(totalCount !== undefined ? { total_count: totalCount, has_more: totalCount > records.length } : {}),
        },
      };
      if (input.format === 'markdown') {
        const lines: string[] = [];
        lines.push(`# Matter History — ${input.matter_ref}`);
        lines.push('');
        lines.push(`${obj.record_count} record${obj.record_count === 1 ? '' : 's'}`);
        lines.push('');
        lines.push('## Queries');
        lines.push('');
        for (const r of obj.records) {
          const jur = r.jurisdiction ? ` [${r.jurisdiction}]` : '';
          lines.push(`- **${r.tool}**${jur} — ${r.query} (${r.result_count} result${r.result_count === 1 ? '' : 's'}, ${r.searched_at})`);
        }
        return {
          structuredContent: obj,
          content: [{ type: 'text' as const, text: lines.join('\n').trimEnd() }],
        };
      }
      return {
        structuredContent: obj,
        content: [{ type: 'text' as const, text: JSON.stringify(obj) }],
      };
    },
  );
}
