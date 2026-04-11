import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { formatCitation, AuslawError } from '../auslaw-client.js';
import { logger } from '../logger.js';

const inputSchema = z.object({
  citation: z
    .string()
    .min(3)
    .describe(
      'Raw citation string to format per AGLC4, e.g. "[2024] HCA 12" or "Smith v Jones [2023] NSWCA 45"',
    ),
});

export function registerFormatCitation(server: McpServer): void {
  server.tool(
    'format_citation',
    'Format an Australian case citation according to AGLC4 (Australian Guide to Legal Citation, 4th edition). Use this to ensure citations in legal writing are correctly formatted.',
    inputSchema.shape,
    async (input) => {
      const log = logger.child({ tool: 'format_citation', citation: input.citation });

      try {
        const result = await formatCitation(input.citation);
        log.debug('AusLaw format_citation succeeded');

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  input: input.citation,
                  formatted: result.formatted,
                  ...(result.style ? { style: result.style } : {}),
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        if (err instanceof AuslawError) {
          log.warn({ err }, 'AusLaw format_citation failed');
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  error: 'upstream_unavailable',
                  message: 'Could not format citation. The legal database may be temporarily unavailable.',
                }),
              },
            ],
            isError: true,
          };
        }
        throw err;
      }
    },
  );
}
