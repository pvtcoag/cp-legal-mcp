import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getMatterHistory, isDbEnabled } from '../db.js';
import { logger } from '../logger.js';

const inputSchema = z.object({
  matter_ref: z
    .string()
    .min(1)
    .max(100)
    .describe('The matter reference to retrieve history for (e.g. "ABC-2024-001")'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(50)
    .describe('Maximum number of search records to return, most recent first'),
});

export function registerGetMatterHistory(server: McpServer): void {
  server.tool(
    'get_matter_history',
    'Retrieve the history of all legal research searches tagged to a matter reference. Shows who searched what, when, and what the top results were. Requires matter_ref to have been provided when calling research tools.',
    inputSchema.shape,
    async (input) => {
      const log = logger.child({ tool: 'get_matter_history' });

      if (!isDbEnabled()) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: 'not_configured',
              message: 'Matter tracking is not enabled on this deployment (DATABASE_URL not set).',
            }),
          }],
          isError: true,
        };
      }

      let rows;
      try {
        rows = await getMatterHistory(input.matter_ref, input.limit ?? 50);
        log.debug({ matter_ref: input.matter_ref, rowCount: rows.length }, 'Matter history retrieved');
      } catch (err) {
        log.error({ err }, 'getMatterHistory failed');
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: 'database_error',
              message: 'Could not retrieve matter history. Please try again.',
            }),
          }],
          isError: true,
        };
      }

      if (rows.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              matter_ref: input.matter_ref,
              record_count: 0,
              message: 'No research records found for this matter reference.',
            }),
          }],
        };
      }

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

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            matter_ref: input.matter_ref,
            record_count: records.length,
            records,
          }, null, 2),
        }],
      };
    },
  );
}
