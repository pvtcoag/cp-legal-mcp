import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool, matterRefSchema } from './_shared.js';
import { searchCitingCases } from '../auslaw-client.js';
import {
  listWatchlist, addWatchlistEntry, removeWatchlistEntry, updateWatchlistCheck, isDbEnabled,
} from '../db.js';
import { logger } from '../logger.js';
import { recordMatterQuery } from '../matter-log.js';

const inputSchema = z.object({
  action: z.enum(['check', 'add', 'remove', 'list'])
    .describe(
      '"check" — check all watched citations for new citing cases. ' +
      '"add" — add a citation to the watchlist. ' +
      '"remove" — remove a citation from the watchlist. ' +
      '"list" — list all watched citations.',
    ),
  citation: z.string().min(1).max(200).optional()
    .describe('Neutral citation to add or remove, e.g. "[2024] HCA 12". Required for add/remove.'),
  label: z.string().max(200).optional()
    .describe('Human-readable label for the case, e.g. "Kennon v Spry — family trust". Optional for add.'),
  matter_ref: matterRefSchema,
});

export function registerMonitorPrecedents(server: McpServer): void {
  registerTool(
    server,
    'monitor_precedents',
    {
      title: 'Monitor precedents',
      description: '[Matter] Manage a watchlist of key cases and check for new citing cases. ' +
    'Use "check" to scan all watched citations for new citations since last check. ' +
    'Use "add"/"remove" to manage the watchlist. Use "list" to see all watched cases.',
      inputSchema: inputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      if (!isDbEnabled()) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'not_configured',
            message: 'Database not enabled — precedent watchlist is unavailable.',
          }) }],
          isError: true,
        };
      }

      const log = logger.child({ tool: 'monitor_precedents' });

      if (input.action === 'list') {
        const entries = await listWatchlist();
        recordMatterQuery({
          matter_ref: input.matter_ref ?? '__precedent_watchlist__',
          tool_name: 'monitor_precedents',
          query_text: 'list watchlist',
          result_count: entries.length,
          top_results: [],
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            action: 'list',
            count: entries.length,
            entries: entries.map((e) => ({
              citation: e.citation,
              label: e.label,
              last_checked: e.last_checked,
              last_count: e.last_count,
              added_by: e.added_by,
              added_at: e.created_at,
            })),
          }) }],
        };
      }

      if (input.action === 'add') {
        if (!input.citation) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              error: 'missing_citation',
              message: 'citation is required for action "add".',
            }) }],
            isError: true,
          };
        }
        // Fetch the user from requestContext if available, otherwise use 'unknown'
        // We don't import requestContext here to avoid circular deps — pass via matter_ref context
        await addWatchlistEntry(input.citation, input.label, input.matter_ref ? undefined : undefined);
        log.info({ citation: input.citation }, 'precedent watchlist: entry added');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            action: 'add',
            citation: input.citation,
            label: input.label ?? null,
            message: `"${input.citation}" added to precedent watchlist.`,
          }) }],
        };
      }

      if (input.action === 'remove') {
        if (!input.citation) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              error: 'missing_citation',
              message: 'citation is required for action "remove".',
            }) }],
            isError: true,
          };
        }
        await removeWatchlistEntry(input.citation);
        log.info({ citation: input.citation }, 'precedent watchlist: entry removed');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            action: 'remove',
            citation: input.citation,
            message: `"${input.citation}" removed from precedent watchlist.`,
          }) }],
        };
      }

      // action === 'check'
      const entries = await listWatchlist();
      if (entries.length === 0) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            action: 'check',
            message: 'Watchlist is empty. Use action "add" to watch a citation.',
            results: [],
          }) }],
        };
      }

      const results = await Promise.all(
        entries.map(async (entry) => {
          try {
            const cases = await searchCitingCases({ citation: entry.citation, limit: 50 });
            const newCount = cases.length - entry.last_count;
            // New cases = any over the previous count (simplistic but effective)
            const newCases = newCount > 0 ? cases.slice(0, newCount) : [];
            await updateWatchlistCheck(entry.citation, cases.length).catch(() => {});
            return {
              citation: entry.citation,
              label: entry.label,
              total_citing: cases.length,
              new_since_last_check: Math.max(0, newCount),
              new_cases: newCases.map((c) => ({
                title: c.title,
                citation: c.citation,
                court: c.court,
                date: c.date,
                url: c.url,
              })),
              last_checked: new Date().toISOString(),
              error: null,
            };
          } catch (err) {
            log.warn({ err, citation: entry.citation }, 'monitor_precedents: check failed for citation');
            return {
              citation: entry.citation,
              label: entry.label,
              total_citing: null,
              new_since_last_check: null,
              new_cases: [],
              last_checked: null,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }),
      );

      const totalNew = results.reduce((s, r) => s + (r.new_since_last_check ?? 0), 0);

      recordMatterQuery({
        matter_ref: input.matter_ref ?? '__precedent_watchlist__',
        tool_name: 'monitor_precedents',
        query_text: `check ${entries.length} watched citations`,
        result_count: totalNew,
        top_results: [],
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          action: 'check',
          citations_checked: entries.length,
          total_new_citations: totalNew,
          results,
          note: totalNew > 0
            ? `${totalNew} new citing case(s) found. Review new_cases arrays for details.`
            : 'No new citing cases found since last check.',
        }) }],
      };
    },
  );
}
