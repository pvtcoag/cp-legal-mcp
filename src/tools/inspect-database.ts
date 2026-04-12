import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  isDbEnabled,
  listMatters,
  getUserActivity,
  getRecentActivity,
  getMatterHistory,
} from '../db.js';
import { getUser } from '../request-context.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

// Admin users parsed once at module load
const adminUsers = new Set(
  config.ADMIN_USERS.split(',').map((u) => u.trim().toLowerCase()).filter(Boolean),
);

function isAdmin(): boolean {
  const user = getUser();
  return !!user && adminUsers.has(user.toLowerCase());
}

const inputSchema = z.object({
  command: z
    .enum(['list_matters', 'user_activity', 'recent_activity', 'matter_detail'])
    .describe(
      'list_matters — all matters with summary stats | ' +
      'user_activity — queries grouped by user and date | ' +
      'recent_activity — most recent queries across all matters | ' +
      'matter_detail — full query history for one matter',
    ),
  matter_ref: z
    .string()
    .max(100)
    .optional()
    .describe('Required for matter_detail command'),
  date_from: z
    .string()
    .optional()
    .describe('ISO date (YYYY-MM-DD) — filter start for user_activity'),
  date_to: z
    .string()
    .optional()
    .describe('ISO date (YYYY-MM-DD) — filter end for user_activity'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(100)
    .describe('Max rows to return'),
});

export function registerInspectDatabase(server: McpServer): void {
  server.tool(
    'inspect_database',
    '[Admin] Inspect matter research history across all users and matters. ' +
    'Restricted to admin users only. Not for end-user research — use get_matter_history for that.',
    inputSchema.shape,
    async (input) => {
      const log = logger.child({ tool: 'inspect_database', user: getUser() });

      if (!isAdmin()) {
        log.warn('Unauthorised inspect_database attempt');
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: 'forbidden', message: 'This tool is restricted to admin users.' }),
          }],
          isError: true,
        };
      }

      if (!isDbEnabled()) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: 'not_configured', message: 'Database not enabled on this deployment.' }),
          }],
          isError: true,
        };
      }

      log.info({ command: input.command }, 'Admin DB inspection');

      try {
        switch (input.command) {
          case 'list_matters': {
            const rows = await listMatters();
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({ command: 'list_matters', matter_count: rows.length, matters: rows }),
              }],
            };
          }

          case 'user_activity': {
            const rows = await getUserActivity({ date_from: input.date_from, date_to: input.date_to });
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  command: 'user_activity',
                  date_from: input.date_from ?? 'all time',
                  date_to: input.date_to ?? 'now',
                  row_count: rows.length,
                  activity: rows,
                }),
              }],
            };
          }

          case 'recent_activity': {
            const rows = await getRecentActivity(input.limit ?? 100);
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  command: 'recent_activity',
                  record_count: rows.length,
                  records: rows.map((r) => ({
                    id: r.id,
                    matter_ref: r.matter_ref,
                    user: r.user_id,
                    tool: r.tool_name,
                    query: r.query_text,
                    jurisdiction: r.jurisdiction,
                    results: r.result_count,
                    at: r.created_at,
                  })),
                }),
              }],
            };
          }

          case 'matter_detail': {
            if (!input.matter_ref) {
              return {
                content: [{
                  type: 'text' as const,
                  text: JSON.stringify({ error: 'missing_param', message: 'matter_ref is required for matter_detail' }),
                }],
                isError: true,
              };
            }
            const rows = await getMatterHistory(input.matter_ref, input.limit ?? 100);
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  command: 'matter_detail',
                  matter_ref: input.matter_ref,
                  record_count: rows.length,
                  records: rows,
                }),
              }],
            };
          }
        }
      } catch (err) {
        log.error({ err }, 'inspect_database query failed');
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: 'database_error', message: 'Query failed. Check Railway logs.' }),
          }],
          isError: true,
        };
      }
    },
  );
}
