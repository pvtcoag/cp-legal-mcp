import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  fetchDocumentText,
  resolveJudgmentUrl,
  AuslawError,
} from '../auslaw-client.js';
import { logger } from '../logger.js';
import { recordMatterQuery } from '../matter-log.js';

const inputSchema = z.object({
  citation_or_url: z
    .string()
    .min(5)
    .describe(
      'Neutral citation (e.g. "[2024] HCA 12") or a full AustLII URL of the judgment to retrieve',
    ),
  matter_ref: z
    .string()
    .max(100)
    .optional()
    .describe('Matter reference to tag this retrieval in the research log. If a matter_ref was provided earlier in this conversation or in your project instructions, always include it here.'),
});

export function registerGetJudgment(server: McpServer): void {
  server.tool(
    'get_judgment',
    'Retrieve the full text of an Australian court judgment by neutral citation or AustLII URL. Validates citations and returns structured text with metadata.',
    inputSchema.shape,
    async (input) => {
      const log = logger.child({ tool: 'get_judgment', input: input.citation_or_url });

      let resolved;
      try {
        resolved = await resolveJudgmentUrl(input.citation_or_url);
      } catch (err) {
        if (err instanceof AuslawError) {
          log.warn({ err }, 'resolveJudgmentUrl failed');
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              error: 'invalid_input',
              message: err.message,
              received: input.citation_or_url,
            }) }],
            isError: true,
          };
        }
        throw err;
      }

      log.debug({ url: resolved.url }, 'fetching document');

      let doc;
      try {
        doc = await fetchDocumentText(resolved.url);
      } catch (err) {
        if (err instanceof AuslawError) {
          log.warn({ err }, 'fetch_document_text failed');
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              error: 'upstream_unavailable',
              message: 'Could not retrieve the judgment. The legal database may be temporarily unavailable.',
              detail: err.message,
            }) }],
            isError: true,
          };
        }
        throw err;
      }

      const citation = doc.citation ?? resolved.citation;

      recordMatterQuery({
        matter_ref: input.matter_ref,
        tool_name: 'get_judgment',
        query_text: input.citation_or_url,
        result_count: 1,
        top_results: [{ title: doc.title ?? input.citation_or_url, citation, url: resolved.url }],
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          title: doc.title,
          citation,
          url: resolved.url,
          canonical_url: resolved.canonicalUrl ?? resolved.url,
          char_count: doc.text.length,
          text: doc.text,
        }) }],
      };
    },
  );
}
