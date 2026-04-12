import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fetchDocumentText, AuslawError } from '../auslaw-client.js';
import { logger } from '../logger.js';
import { recordMatterQuery } from '../matter-log.js';

const inputSchema = z.object({
  url: z
    .string()
    .url()
    .refine(
      (v) => v.startsWith('https://www.austlii.edu.au') || v.startsWith('https://classic.austlii.edu.au'),
      { message: 'Only AustLII URLs are supported (https://www.austlii.edu.au/...)' }
    )
    .describe(
      'AustLII URL of the legislation to retrieve, e.g. "https://www.austlii.edu.au/au/legis/cth/consol_act/cca2010265/". ' +
      'Obtain this from research_legislation first.',
    ),
  matter_ref: z
    .string()
    .max(100)
    .optional()
    .describe(
      'Matter reference to tag this retrieval in the research log. If a matter_ref was provided earlier in this conversation or in your project instructions, always include it here.',
    ),
});

export function registerGetLegislation(server: McpServer): void {
  server.tool(
    'get_legislation',
    'Retrieve the full text of an Australian Act or regulation by AustLII URL. Returns the complete consolidated text with metadata. Use research_legislation to find the URL first, then this tool to read the full content. For targeted questions about specific provisions, prefer ask_legislation instead.',
    inputSchema.shape,
    async (input) => {
      const log = logger.child({ tool: 'get_legislation', url: input.url });

      let doc;
      try {
        doc = await fetchDocumentText(input.url);
      } catch (err) {
        if (err instanceof AuslawError) {
          log.warn({ err }, 'fetch_document_text failed');
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              error: 'upstream_unavailable',
              message: 'Could not retrieve the legislation. The legal database may be temporarily unavailable.',
              detail: err.message,
            }) }],
            isError: true,
          };
        }
        throw err;
      }

      const title = doc.title ?? input.url;

      recordMatterQuery({
        matter_ref: input.matter_ref,
        tool_name: 'get_legislation',
        query_text: input.url,
        result_count: 1,
        top_results: [{ title, url: input.url }],
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          title,
          url: input.url,
          char_count: doc.text.length,
          text: doc.text,
        }) }],
      };
    },
  );
}
