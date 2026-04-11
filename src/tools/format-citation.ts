import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { formatCitation, AuslawError } from '../auslaw-client.js';
import { logger } from '../logger.js';

const inputSchema = z.object({
  title: z
    .string()
    .min(1)
    .describe("Case name, e.g. 'Mabo v Queensland (No 2)'"),
  neutral_citation: z
    .string()
    .optional()
    .describe("Neutral citation, e.g. '[1992] HCA 23'"),
  reported_citation: z
    .string()
    .optional()
    .describe("Reported citation, e.g. '(1992) 175 CLR 1'"),
  pinpoint: z
    .string()
    .optional()
    .describe("Pinpoint reference, e.g. '[20]' or 'p 42'"),
  style: z
    .enum(['neutral', 'reported', 'combined'])
    .default('combined')
    .describe("Citation style: neutral (neutral only), reported (reported only), combined (both)"),
});

export function registerFormatCitation(server: McpServer): void {
  server.tool(
    'format_citation',
    'Format an Australian case citation according to AGLC4 (Australian Guide to Legal Citation, 4th edition). Combines case name, neutral citation, reported citation, and optional pinpoint into the correct format.',
    inputSchema.shape,
    async (input) => {
      const log = logger.child({ tool: 'format_citation', title: input.title });

      try {
        const result = await formatCitation({
          title: input.title,
          neutralCitation: input.neutral_citation,
          reportedCitation: input.reported_citation,
          pinpoint: input.pinpoint,
          style: input.style,
        });
        log.debug('AusLaw format_citation succeeded');

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  title: input.title,
                  formatted: result.formatted,
                  style: result.style ?? input.style,
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
                  detail: err.message,
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
